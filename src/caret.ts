import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

/**
 * Write inline styles on an element.
 *
 * `setCssStyles` is an element method in Obsidian's API, not a module export.
 * Importing it from "obsidian" yielded `undefined`, so every call threw and each
 * caret element stayed at 0x0 without a transform or a height: invisible, while
 * the stylesheet had already hidden the native caret.
 */
function setStyles(el: HTMLElement, styles: Record<string, string>): void {
  const helper = (el as unknown as { setCssStyles?: (styles: Record<string, string>) => void })
    .setCssStyles;
  if (typeof helper === "function") {
    helper.call(el, styles);
    return;
  }
  for (const [property, value] of Object.entries(styles)) {
    el.style.setProperty(
      property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      value,
    );
  }
}

/**
 * The caret glide.
 *
 * Obsidian (through CodeMirror 6) lets the browser paint the text caret, and a
 * native caret cannot be animated: it is drawn by the compositor, not by a DOM
 * node we can move. So this module hides the native caret with CSS and draws a
 * replacement inside an absolutely positioned layer that follows the selection.
 *
 * The position comes from `view.coordsAtPos()`, which is only reliable inside a
 * measure cycle, so every update goes through `requestMeasure`: read the
 * geometry in the read phase, write the transform in the write phase. Moving the
 * layer with `transform` instead of `left/top` keeps the browser on the
 * compositor and out of layout.
 */

const CARET_WIDTH = 2;
const REFRESH_EVENT = "cursor-jump:refresh";
const BLINK_ANIMATION = "cj-caret-blink";
const SETTLE_MS = 420;
const STILL_EPSILON = 0.5;
const RETRY_MS = 80;
const MAX_RETRIES = 6;
const DRAG_SLOP = 4;

export interface CaretSettings {
  enabled: boolean;
  duration: number;
  caretStyle: "compact" | "line";
  /** Resolved CSS timing function; pushed down to each editor root. */
  ease?: string;
}

interface Target {
  x: number;
  y: number;
  height: number;
  primary: boolean;
}

interface AppliedCaret {
  el: HTMLDivElement;
  x: number;
  y: number;
  height: number;
  duration: number;
  hidden: boolean;
  primary: boolean;
  animation: "blink" | "none";
}

type Scan =
  | { kind: "clear" }
  | { kind: "stale" }
  | { kind: "place"; targets: Target[]; animate: boolean; duration: number };

let reducedMotionQuery: MediaQueryList | null | undefined;

function prefersReducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
  }
  return reducedMotionQuery ? reducedMotionQuery.matches : false;
}

function clampDuration(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(400, Math.round(number));
}

/** Snap to device pixels so the 2px caret never lands on a half pixel. */
function snap(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

function lineElementAt(view: EditorView, pos: number): HTMLElement | null {
  try {
    const dom = view.domAtPos(pos, 1);
    let node: Node | null = dom.node;
    if (node.nodeType === 3) node = node.parentNode;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains("cm-line")) return node;
      node = node.parentNode;
    }
  } catch {
    // Positions inside an unrendered block have no line element; fall back to
    // the full line height.
  }
  return null;
}

export function createCaretEffectExtension(getSettings: () => CaretSettings) {
  return ViewPlugin.fromClass(
    class CaretEffectView {
      private view: EditorView;
      private caretLayer: HTMLDivElement;
      private carets: HTMLDivElement[] = [];
      private applied: (AppliedCaret | null)[] = [];
      private caretOn = false;
      /** Set once a caret element has actually received a position and a size. */
      private painted = false;
      private animateNext = false;
      private composing = false;
      private destroyed = false;
      /** A pointer drag is in progress: the caret should track, not glide. */
      private dragging = false;
      private pointerDown = false;
      private trackingPointer = false;
      private pointerStartX = 0;
      private pointerStartY = 0;
      /** The last scan could not resolve coordinates (off-screen position). */
      private missed = false;
      private blinkTimer = 0;
      private retryTimer = 0;
      private retryCount = 0;
      private ensureTimer = 0;
      private classWatcher: MutationObserver | null = null;
      private measureKey = {};
      private measureRequest: {
        key: object;
        read: () => Scan;
        write: (scan: Scan) => void;
      };

      private onCompositionStart = () => {
        this.composing = true;
        this.view.dom.classList.add("cj-composing");
        this.schedule(false);
      };

      private onCompositionEnd = () => {
        this.composing = false;
        this.view.dom.classList.remove("cj-composing");
        this.schedule(false);
      };

      private onRefresh = () => this.schedule(false);

      /**
       * CodeMirror rewrites the whole class attribute of `.cm-editor`
       * whenever its attributes are refreshed (focus change, theme swap,
       * editable toggle), which drops our `cj-caret-on` marker without
       * telling us. Left alone, the native caret comes back while the drawn
       * caret keeps going, so both are visible at once.
       */
      private onEditorClassMutation = () => {
        if (this.destroyed || !this.caretOn) return;
        this.markEditor(true);
      };

      /**
       * Mark the editor root as well as the window body. Popout windows have
       * their own document, so the body class set by the plugin never reaches
       * them; without this they kept the native caret *and* the drawn one.
       */
      private markEditor(on: boolean) {
        this.view.dom.classList.toggle("cj-caret-on", on);
        this.view.dom.classList.toggle("cj-on", on);
      }

      /** Duration/easing live on the editor root, so popouts animate too. */
      private applyScopedLook() {
        const style = this.view.dom.style;
        const duration = `${clampDuration(getSettings().duration)}ms`;
        if (style.getPropertyValue("--cj-duration") !== duration) {
          style.setProperty("--cj-duration", duration);
        }
        const ease = getSettings().ease || "ease-out";
        if (style.getPropertyValue("--cj-ease") !== ease) {
          style.setProperty("--cj-ease", ease);
        }
      }

      private onFocusIn = () => {
        this.retryCount = 0;
        this.schedule(false);
        if (this.retryTimer) window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = 0;
          this.schedule(false);
        }, 120);
      };

      private onWindowFocus = () => this.schedule(false);

      private onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        this.pointerDown = true;
        this.dragging = false;
        this.pointerStartX = event.clientX;
        this.pointerStartY = event.clientY;
        this.trackPointer(true);
      };

      private onPointerMove = (event: PointerEvent) => {
        if (!this.pointerDown || this.dragging) return;
        if (
          Math.abs(event.clientX - this.pointerStartX) > DRAG_SLOP ||
          Math.abs(event.clientY - this.pointerStartY) > DRAG_SLOP
        ) {
          this.dragging = true;
        }
      };

      private onPointerUp = () => {
        this.pointerDown = false;
        this.dragging = false;
        this.trackPointer(false);
      };

      /** Low-frequency safety net for code paths that never emit an update. */
      private onEnsure = () => {
        if (this.destroyed || this.composing || this.appHidden()) return;
        if (!getSettings().enabled || !this.view.hasFocus) return;
        if (this.painted && this.carets.length > 0 && !this.missed) {
          if (
            !this.view.dom.classList.contains("cj-caret-on") ||
            !this.view.dom.classList.contains("cj-on")
          ) {
            this.markEditor(true);
          }
          return;
        }
        this.schedule(false);
      };

      constructor(view: EditorView) {
        this.view = view;
        this.caretLayer = document.createElement("div");
        this.caretLayer.className = "cj-caret-layer";
        this.caretLayer.setAttribute("aria-hidden", "true");
        view.scrollDOM.appendChild(this.caretLayer);
        view.dom.addEventListener("focusin", this.onFocusIn, true);
        window.addEventListener("focus", this.onWindowFocus);
        window.addEventListener(REFRESH_EVENT, this.onRefresh);
        view.contentDOM.addEventListener("compositionstart", this.onCompositionStart, true);
        view.contentDOM.addEventListener("compositionend", this.onCompositionEnd, true);
        view.contentDOM.addEventListener("pointerdown", this.onPointerDown, true);
        this.classWatcher = new MutationObserver(this.onEditorClassMutation);
        this.classWatcher.observe(view.dom, { attributes: true, attributeFilter: ["class"] });
        this.ensureTimer = window.setInterval(this.onEnsure, 300);
        this.measureRequest = {
          key: this.measureKey,
          read: () => this.measureRead(),
          write: (scan) => this.measureWrite(scan),
        };
        this.schedule(false);
      }

      update(update: ViewUpdate) {
        if (this.destroyed) return;
        const movedSelection = update.selectionSet || update.docChanged;
        if (
          !movedSelection &&
          !update.focusChanged &&
          !update.geometryChanged &&
          !update.heightChanged &&
          !update.viewportChanged
        ) {
          return;
        }
        this.schedule(movedSelection);
      }

      destroy() {
        this.destroyed = true;
        this.view.dom.removeEventListener("focusin", this.onFocusIn, true);
        window.removeEventListener("focus", this.onWindowFocus);
        window.removeEventListener(REFRESH_EVENT, this.onRefresh);
        this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart, true);
        this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd, true);
        this.view.contentDOM.removeEventListener("pointerdown", this.onPointerDown, true);
        this.trackPointer(false);
        if (this.blinkTimer) window.clearTimeout(this.blinkTimer);
        if (this.retryTimer) window.clearTimeout(this.retryTimer);
        if (this.ensureTimer) window.clearInterval(this.ensureTimer);
        if (this.classWatcher) {
          this.classWatcher.disconnect();
          this.classWatcher = null;
        }
        this.blinkTimer = 0;
        this.retryTimer = 0;
        this.ensureTimer = 0;
        this.clearCaret();
        this.caretLayer.remove();
        this.view.dom.classList.remove("cj-composing");
      }

      private appHidden(): boolean {
        return typeof document.hidden === "boolean" && document.hidden;
      }

      private trackPointer(on: boolean) {
        if (on === this.trackingPointer) return;
        this.trackingPointer = on;
        const listeners: [string, EventListener, boolean][] = [
          ["pointermove", this.onPointerMove as EventListener, true],
          ["pointerup", this.onPointerUp as EventListener, true],
          ["pointercancel", this.onPointerUp as EventListener, true],
          // `blur` does not bubble, so capture would make it fire for every
          // element in the window; the plain listener only sees the window
          // itself losing focus, which is what we want.
          ["blur", this.onPointerUp as EventListener, false],
        ];
        for (const [type, listener, capture] of listeners) {
          if (on) window.addEventListener(type, listener, capture);
          else window.removeEventListener(type, listener, capture);
        }
      }

      private schedule(animate: boolean) {
        if (this.destroyed) return;
        if (animate) this.animateNext = true;
        this.view.requestMeasure(this.measureRequest as never);
      }

      private clearCaret() {
        for (const caret of this.carets) caret.remove();
        this.carets = [];
        this.applied = [];
        this.missed = false;
        this.animateNext = false;
        if (this.blinkTimer) {
          window.clearTimeout(this.blinkTimer);
          this.blinkTimer = 0;
        }
        this.caretOn = false;
        this.painted = false;
        this.markEditor(false);
      }

      /**
       * Off-screen caret: hide the drawn one and hand the native caret back.
       * Keeping the native caret hidden here is what turned a failed paint into
       * a completely invisible cursor.
       */
      private hideCarets() {
        for (let i = 0; i < this.carets.length; i++) {
          const caret = this.carets[i];
          setStyles(caret, { transitionDuration: "0ms", visibility: "hidden" });
          const record = this.applied[i];
          if (record) {
            record.duration = 0;
            record.hidden = true;
          }
        }
        this.caretOn = false;
        this.painted = false;
        this.markEditor(false);
      }

      /** Turns the current selection into scroll-content pixel coordinates. */
      private measureRead(): Scan {
        if (this.destroyed) return { kind: "clear" };
        const settings = getSettings();
        const view = this.view;
        if (
          !settings.enabled ||
          !view.hasFocus ||
          this.composing ||
          view.dom.classList.contains("cm-vimMode")
        ) {
          this.animateNext = false;
          return { kind: "clear" };
        }
        const animate = this.animateNext;
        this.animateNext = false;
        const selection = view.state.selection;
        const base = this.caretLayer.getBoundingClientRect();
        const rtl = view.textDirection === 1;
        const compact = settings.caretStyle === "compact";
        const targets: Target[] = [];
        for (const range of selection.ranges) {
          const coords = view.coordsAtPos(range.head, range.assoc === -1 ? -1 : 1);
          if (!coords) return { kind: "stale" };
          const x = (rtl ? coords.right : coords.left) - base.left;
          const lineTop = coords.top - base.top;
          const lineHeight = Math.max(1, coords.bottom - coords.top);
          let height = lineHeight;
          let top = lineTop;
          if (compact) {
            const line = lineElementAt(view, range.head);
            const fontSize = line ? Number.parseFloat(getComputedStyle(line).fontSize) : 0;
            if (Number.isFinite(fontSize) && fontSize > 0) {
              height = Math.min(lineHeight, fontSize * 1.15);
              const shift = Math.min(fontSize * 0.12, Math.max(0, lineHeight - height));
              top = lineTop + shift;
            }
          }
          targets.push({ x, y: top, height, primary: range === selection.main });
        }
        if (targets.length === 0) return { kind: "stale" };
        return { kind: "place", targets, animate, duration: clampDuration(settings.duration) };
      }

      private measureWrite(scan: Scan) {
        if (this.destroyed || !scan) return;
        if (scan.kind === "clear") {
          this.clearCaret();
          return;
        }
        if (scan.kind === "stale") {
          this.hideCarets();
          this.missed = true;
          this.queueRetry();
          return;
        }
        const animate =
          scan.animate && !this.dragging && scan.duration > 0 && !prefersReducedMotion();
        const dpr = window.devicePixelRatio || 1;
        const { targets } = scan;
        let travelled = 0;
        let moved = false;
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          let caret = this.carets[i];
          let record = this.applied[i] ?? null;
          if (!caret || !record || record.el !== caret) {
            if (!caret) {
              caret = document.createElement("div");
              this.carets[i] = caret;
              this.caretLayer.appendChild(caret);
            }
            record = {
              el: caret,
              x: NaN,
              y: NaN,
              height: NaN,
              duration: -1,
              hidden: false,
              primary: !target.primary,
              animation: "blink",
            };
            this.applied[i] = record;
          }
          const x = snap(target.x - CARET_WIDTH / 2, dpr);
          const y = snap(target.y, dpr);
          const height = Math.max(1, snap(target.height, dpr));
          const hasPrevious = !Number.isNaN(record.x);
          const dx = x - record.x;
          const dy = y - record.y;
          const distance = hasPrevious ? Math.sqrt(dx * dx + dy * dy) : 0;
          const movedHere = !hasPrevious || distance >= STILL_EPSILON;
          // Long jumps take longer, short ones stay snappy; capped so a
          // cross-screen jump never drags.
          let duration = 0;
          if (movedHere && animate && hasPrevious) {
            const factor = Math.min(1.9, Math.max(0.55, 0.55 + distance / 260));
            duration = Math.min(240, Math.round(scan.duration * factor));
          }
          if (record.primary !== target.primary) {
            record.primary = target.primary;
            caret.className = `cj-caret ${target.primary ? "cj-caret-primary" : "cj-caret-secondary"}`;
          }
          if (record.hidden) {
            record.hidden = false;
            setStyles(caret, { visibility: "" });
          }
          if (record.duration !== duration) {
            record.duration = duration;
            setStyles(caret, { transitionDuration: duration > 0 ? `${duration}ms` : "0ms" });
          }
          if (record.x !== x || record.y !== y) {
            record.x = x;
            record.y = y;
            setStyles(caret, { transform: `translate3d(${x}px, ${y}px, 0)` });
          }
          if (record.height !== height) {
            record.height = height;
            setStyles(caret, { height: `${height}px` });
          }
          if (movedHere) {
            if (record.animation !== "none") {
              record.animation = "none";
              setStyles(caret, { animationName: "none" });
            }
            moved = true;
            travelled = Math.max(travelled, duration);
          }
        }
        for (let i = targets.length; i < this.carets.length; i++) this.carets[i].remove();
        this.carets.length = targets.length;
        this.applied.length = targets.length;
        this.caretOn = true;
        this.painted = true;
        this.markEditor(true);
        this.applyScopedLook();
        this.missed = false;
        this.retryCount = 0;
        if (moved) this.scheduleBlink(travelled);
      }

      /** Keep the drawn caret blinking, but only once the glide has landed. */
      private scheduleBlink(travel: number) {
        if (this.blinkTimer) window.clearTimeout(this.blinkTimer);
        this.blinkTimer = window.setTimeout(() => {
          this.blinkTimer = 0;
          for (let i = 0; i < this.carets.length; i++) {
            const record = this.applied[i];
            if (record && record.animation !== "blink") {
              record.animation = "blink";
              setStyles(this.carets[i], { animationName: BLINK_ANIMATION });
            }
          }
        }, Math.max(0, travel) + SETTLE_MS);
      }

      /** Layout is sometimes one frame late; retry a few times, then stop. */
      private queueRetry() {
        if (this.retryCount >= MAX_RETRIES || this.retryTimer) return;
        this.retryCount++;
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = 0;
          this.schedule(false);
        }, RETRY_MS);
      }
    },
  );
}
