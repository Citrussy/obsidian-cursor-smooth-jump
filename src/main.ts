import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { createCaretEffectExtension, type CaretSettings } from "./caret";

interface SmoothCaretSettings extends CaretSettings {
  easing: string;
}

const EASINGS: Record<string, string> = {
  smooth: "cubic-bezier(.22,.61,.36,1)",
  standard: "cubic-bezier(.2,0,0,1)",
  gentle: "cubic-bezier(.16,1,.3,1)",
  overshoot: "cubic-bezier(.34,1.56,.64,1)",
  linear: "linear",
};

const EASING_LABELS: Record<string, string> = {
  smooth: "平滑（推荐）",
  standard: "标准",
  gentle: "轻快",
  overshoot: "回弹",
  linear: "匀速",
};

const DEFAULT_SETTINGS: SmoothCaretSettings = {
  enabled: true,
  duration: 90,
  easing: "smooth",
  caretStyle: "compact",
};

/** Settings kept by older builds; dropped on load so the file stays clean. */
const LEGACY_KEYS = ["fixFlatCaret", "mode", "ripple", "rippleSize", "minDistance", "rippleColor"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Own-property check: "constructor" or "__proto__" must not pass as easing names. */
function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export default class SmoothCaretPlugin extends Plugin {
  settings: SmoothCaretSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.applyLook();
    this.addSettingTab(new SmoothCaretSettingTab(this.app, this));
    this.registerEditorExtension(
      createCaretEffectExtension(() => ({
        ...this.settings,
        ease: EASINGS[this.settings.easing] ?? EASINGS.smooth,
      })),
    );

    this.addCommand({
      id: "toggle-caret-animation",
      name: "切换光标平滑动画",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        this.applyLook();
        await this.saveSettings();
        new Notice(this.settings.enabled ? "光标平滑动画：重新开启" : "光标平滑动画：暂时关闭");
      },
    });

    this.addCommand({
      id: "open-caret-settings",
      name: "打开光标动效设置",
      callback: () => {
        const setting = (this.app as App & { setting?: { open(): void; openTabById(id: string): void } })
          .setting;
        if (!setting) {
          new Notice("请在 设置 → 第三方插件 → Cursor Smooth Jump 中调整选项");
          return;
        }
        setting.open();
        setting.openTabById(this.manifest.id);
      },
    });
  }

  onunload() {
    this.clearLook();
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<SmoothCaretSettings> | null;
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    merged.duration = clamp(Number(merged.duration) || 0, 0, 400);
    if (!hasOwn(EASINGS, String(merged.easing))) merged.easing = DEFAULT_SETTINGS.easing;
    if (merged.caretStyle !== "line") merged.caretStyle = "compact";
    for (const key of LEGACY_KEYS) delete merged[key];
    this.settings = merged as unknown as SmoothCaretSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Push settings into the CSS variables / body classes the stylesheet uses. */
  applyLook() {
    const body = document.body;
    const { enabled, duration, easing } = this.settings;
    body.classList.toggle("cj-on", enabled);
    body.style.setProperty("--cj-duration", `${clamp(Number(duration) || 0, 0, 400)}ms`);
    body.style.setProperty("--cj-ease", EASINGS[easing] ?? EASINGS.smooth);
    window.dispatchEvent(new Event("cursor-jump:refresh"));
  }

  clearLook() {
    const body = document.body;
    body.classList.remove("cj-on");
    body.style.removeProperty("--cj-duration");
    body.style.removeProperty("--cj-ease");
  }
}

class SmoothCaretSettingTab extends PluginSettingTab {
  private plugin: SmoothCaretPlugin;

  constructor(app: App, plugin: SmoothCaretPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private async changed(apply: (settings: SmoothCaretSettings) => void) {
    apply(this.plugin.settings);
    this.plugin.applyLook();
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("cj-settings");

    containerEl.createEl("p", {
      text: "让编辑器的光标像 VSCode 那样滑过去，而不是瞬间跳过去。打字、退格、插件清行、点击、方向键、命令跳转都会滑；鼠标拖选时光标跟着鼠标走，不拖影。",
      cls: "cj-settings-desc",
    });

    new Setting(containerEl).setName("光标滑动").setHeading();

    new Setting(containerEl)
      .setName("启用动效")
      .setDesc("总开关。关闭后光标立刻出现在新位置。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange((value) =>
          this.changed((settings) => {
            settings.enabled = value;
          }),
        ),
      );

    new Setting(containerEl)
      .setName("滑动时长")
      .setDesc(
        "单位毫秒，是「跨屏跳转」的基准时长；短距离（打字、退格）会自动压缩到六成左右。80–120 之间比较自然；0 等于关闭滑动。",
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 300, 10)
          .setValue(this.plugin.settings.duration)
          .setDynamicTooltip()
          .onChange((value) =>
            this.changed((settings) => {
              settings.duration = value;
            }),
          ),
      );

    new Setting(containerEl)
      .setName("缓动曲线")
      .setDesc("决定光标是匀速、渐慢还是带一点回弹。")
      .addDropdown((dropdown) => {
        Object.keys(EASINGS).forEach((key) => {
          dropdown.addOption(key, EASING_LABELS[key]);
        });
        dropdown.setValue(this.plugin.settings.easing).onChange((value) =>
          this.changed((settings) => {
            settings.easing = hasOwn(EASINGS, value) ? value : "smooth";
          }),
        );
      });

    new Setting(containerEl)
      .setName("光标高度")
      .setDesc("紧凑：1.15em，贴合文字；整行：与 Obsidian 原生光标一样高。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("compact", "紧凑（推荐）")
          .addOption("line", "整行")
          .setValue(this.plugin.settings.caretStyle)
          .onChange((value) =>
            this.changed((settings) => {
              settings.caretStyle = value === "line" ? "line" : "compact";
            }),
          ),
      );

    new Setting(containerEl)
      .setName("恢复默认设置")
      .setDesc("把上面的选项全部重置为本插件推荐值。")
      .addButton((button) =>
        button.setButtonText("恢复默认").onClick(async () => {
          this.plugin.settings = { ...DEFAULT_SETTINGS };
          this.plugin.applyLook();
          await this.plugin.saveSettings();
          this.display();
          new Notice("Cursor Smooth Jump 已恢复默认设置");
        }),
      );
  }
}
