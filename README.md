# Cursor Smooth Jump

An animated caret for the Obsidian editor. When the cursor moves, it glides to its new position instead of teleporting there, the way the caret behaves in VS Code.

**[中文说明](#中文说明)**

Obsidian draws the text caret with the browser's native `caret-color`, and a native caret cannot be animated. Cursor Smooth Jump hides it while the editor is focused and draws its own caret on top of the text layer, which means the caret can be moved with a CSS transition. Every selection change becomes a short, smooth animation: typing, backspace, arrow keys, clicking, jumping to a heading from the outline, running a command — all of it.

The plugin does not change how the editor behaves. It only changes how the caret arrives.

## What you get

- **A caret that follows your eye.** Moving from one line to another is a short slide, not a blink. Short moves are quick, long moves take a little longer, and the difference is computed from the actual pixel distance.
- **Typing still feels instant.** Single-character moves compress the animation down to a fraction of the setting, so the caret never lags behind your typing.
- **It does not fight the IME.** While a composition is open, the native caret comes back and the drawn one hides. Chinese and Japanese input behave exactly as before.
- **Dragging does not smear.** If you click and drag to select, the caret tracks the pointer instead of animating behind it.
- **One caret while selecting.** Obsidian paints its own caret at the head of a non-empty selection. That one is switched off while the plugin's caret is on, so a drag shows a single caret instead of a thick one with a thin one next to it.
- **Every caret moves.** Multiple cursors each get their own animated caret, with the primary one drawn with the normal selection color.
- **It stays portable.** No dependencies beyond Obsidian's own API and `@codemirror/view`, no network, no changes to your notes. Turn it off in one toggle, or run the toggle command from the command palette.
- **It respects accessibility.** If the system asks for reduced motion, animations are turned off and the caret is simply placed at its new position.

## How it works

### The native caret has to go

A browser caret is painted by the compositor, not by the DOM. There is no node to transform, so nothing to animate. The plugin sets `caret-color: transparent` on the focused editor's text lines and marks the editor with a `cj-caret-on` class. CodeMirror rewrites the class attribute of `.cm-editor` on focus changes, theme swaps and re-renders, which silently drops that marker; a `MutationObserver` puts it back.

### A caret of our own

Inside `.cm-scroller` the plugin appends a zero-size layer `.cj-caret-layer`, and inside it one 2px `div` per selection range. Those divs are positioned with `translate3d` and animated with `transition: transform, height`. Because the layer is a child of the scrolling element, the caret scrolls with the text for free.

### Obsidian's own caret at a selection edge

Obsidian turns on CodeMirror's `drawSelection` extension, and that extension's cursor layer paints a 1.2px `.cm-cursor` at the head of every non-empty selection. Hiding the native caret does not touch this one: it is a DOM node, not a browser caret, so `caret-color: transparent` has no effect on it. Left alone, a drag shows the plugin's 2px caret and Obsidian's 1.2px caret side by side. The plugin hides it while its own caret is painted:

```css
body.cj-on .cm-editor.cj-caret-on .cm-cursor,
.cm-editor.cj-on.cj-caret-on .cm-cursor { display: none !important; }
```

The rule is keyed to the drawn caret, not to the pointer, so keyboard selections are covered too, and turning the effect off or opening an IME composition brings Obsidian's caret straight back.

### Measure, then write

CodeMirror exposes `view.coordsAtPos()`, which returns the on-screen rectangle of a document position. The plugin reads it inside `view.requestMeasure()`'s read phase, converts the rectangle into coordinates relative to the caret layer, and applies the transform in the write phase. Keeping the read and write phases separate is what prevents layout thrashing: all geometry is read first, all styles are written after.

If the position is off-screen, `coordsAtPos` returns `null`. The caret is hidden, the editor keeps the native caret hidden too (so you never see two carets), and the plugin retries every 80 ms, up to six times, in case the layout was simply one frame late.

### Timing

The transition duration is not fixed. Given distance `d`, the plugin uses

```
duration = min(240, round(setting * clamp(0.55 + d / 260, 0.55, 1.9)))
```

So a one-character move uses roughly 55% of your configured duration while a cross-screen jump uses up to 190% of it, capped at 240 ms. The setting itself is clamped to 0–400 ms; 0 means no animation at all.

The caret blink is paused while it travels: the blink keyframes are removed before the animation starts and restored after the move plus a 420 ms settle window. Without that, the caret would blink *during* the slide and read as flicker.

### Staying out of the way

- **IME:** `compositionstart`/`compositionend` on the content DOM switch the native caret back on and stop measuring.
- **Drag:** a `pointerdown` starts tracking; more than 4px of movement marks it as a drag, and a drag forces zero-duration transitions.
- **Focus:** window focus, editor focus and a 300 ms safety timer all re-schedule a measurement for code paths that never emit a CodeMirror update.
- **Reduced motion:** `prefers-reduced-motion: reduce` disables animation and blinking in both script and stylesheet.

### Built for Chinese and IME input

Chinese is where most caret animations fall apart: an IME holds the composing text outside the document, then commits a whole candidate in one keystroke. This plugin treats that as the normal case.

- **Composition is detected, not guessed.** `compositionstart` hides the drawn caret and hands the editor back to the native one; `compositionend` restores it. While a candidate window is open you never see two carets fighting over the same character, and and committing a pinyin candidate never throws the caret out of a half-written character position.
- **A fixed 2 px bar, not a glyph-width bar.** Full-width Chinese punctuation and half-width Latin get the same caret, so the bar does not stretch or crawl when a line mixes the two.
- **Bursts collapse.** A candidate commit arrives as several editor updates in a row; the measurement runs once per animation frame, so a whole word lands as one glide instead of a stutter.
- **Blink stays off while travelling.** A jump across a screenful of Chinese does not flicker on the way.
- **Distance-aware timing.** Each character step is short (about half the configured duration), so typing Chinese at speed never queues animations behind the keystrokes.

## Settings

| Setting | Default | Range | Notes |
| --- | --- | --- | --- |
| Enable animation | on | on/off | Toggles the whole effect. Also available as the command "Toggle caret animation". |
| Duration | 90 ms | 0–300 ms (clamped to 400) | Baseline for a cross-screen jump. Movement within a line is compressed automatically. |
| Easing | Smooth | Smooth, Standard, Gentle, Overshoot, Linear | Applied through the `--cj-ease` CSS variable. |
| Caret height | Compact | Compact, Full line | Compact is 1.15× the font size, nudged down 0.12× to sit on the text; Full line matches Obsidian's native caret. |

Settings are written into CSS custom properties on `body` (`--cj-duration`, `--cj-ease`, `--cj-caret-color`), so themes can override the caret colour with `--caret-color` as usual.

## Commands

| Command | What it does |
| --- | --- |
| Toggle caret animation | Switches the effect on or off without opening settings. |
| Open caret animation settings | Jumps straight to this plugin's settings tab. |

## Install

**From the community list:** Settings → Community plugins → Browse → search for "Cursor Smooth Jump". If it is not listed yet, install it manually:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Citrussy/obsidian-cursor-smooth-jump/releases/latest).
2. Create `<vault>/.obsidian/plugins/cursor-smooth-jump/`.
3. Put the three files there and enable the plugin under Settings → Community plugins.

Requirements: Obsidian 1.4.0 or newer, desktop only (the plugin reads `document.hidden` and uses the CodeMirror 6 view API; mobile is untested and not claimed).

## Compatibility notes

- **Vim mode:** the plugin stands down when the editor has the `cm-vimMode` class, so Vim's block cursor is untouched.
- **Other caret plugins:** anything else that hides or draws the caret will conflict; run one at a time.
- **Custom CSS:** if a theme sets `caret-color` with `!important` on `.cm-line`, the native caret may reappear. The plugin's rules use `!important` as well, so specificity decides; a theme that targets `.cm-editor` more narrowly may win.
- **Performance:** one layer and a handful of 2px divs per editor. Measuring only happens on selection, document, focus, geometry, height or viewport changes.

## Development

`main.js` is a CommonJS bundle built by esbuild from the TypeScript sources in `src/` (`src/main.ts` for the plugin and settings, `src/caret.ts` for the caret layer). The bundle is committed so the plugin can be installed by dropping files into a vault; run `npm install && npm run build` after changing the sources. Releases are built from these sources. The caret logic is self-contained in `createCaretEffectExtension(getSettings)`, and all timing constants are named at the top of the caret module (`CARET_WIDTH`, `SETTLE_MS`, `STILL_EPSILON`, `RETRY_MS`, `MAX_RETRIES`, `DRAG_SLOP`).

To test changes, copy `main.js`, `manifest.json` and `styles.css` into a test vault's plugin folder and reload Obsidian.

## 中文说明

给 Obsidian 编辑器加一个会滑动的光标。光标改变位置时不再瞬间闪现，而是像 VS Code 那样滑过去。

### 为什么做这个

Obsidian 的光标是浏览器的原生插入符，由合成器直接绘制，DOM 里没有节点可以改动，所以它没法做动画。Cursor Smooth Jump 在编辑器获得焦点时把原生光标藏起来，在文字层上画一个自己的光标，于是就能用 CSS transition 移动它。打字、退格、方向键、点击、从大纲跳标题、执行命令，每一次选区变化都会变成一小段平滑动画。

插件不改变编辑器的任何行为，只改变光标「到达」的方式。

### 能带来什么

- **视线跟着光标走**：换行是滑过去而不是闪过去。近距离移动快，远距离移动稍慢，时长按实际像素距离计算。
- **打字不拖沓**：单字移动会把动画压到设定值的一小部分，光标不会落在输入后面。
- **不和输入法抢**：输入法组字期间恢复原生光标、隐藏自绘光标，中文和日文输入与平时一样。
- **拖选不糊**：按住鼠标拖选时，光标跟着指针走，不做动画。
- **选中时只剩一个光标**：Obsidian 在非空选区的头位也会画一条自己的光标；插件光标在时把它关掉，拖选看到的就是一条 2px 竖线，不会粗的那条旁边再挂一条细的。
- **多光标一起动**：每个选区各有一个光标，主光标用正常颜色，其余暗淡。
- **不绑架你的仓库**：除 Obsidian API 和 `@codemirror/view` 外没有依赖，不联网，不碰笔记。一个开关就能关掉，命令面板里也有切换命令。
- **尊重无障碍设置**：系统开启「减少动态效果」时不做动画，直接把光标放到新位置。

### 实现原理

**原生光标必须让位。** 浏览器光标不属于 DOM，没有节点可以变换。插件给聚焦编辑器的文本行设 `caret-color: transparent`，并给编辑器加 `cj-caret-on` 类。CodeMirror 在焦点变化、切换主题、重绘时会整个重写 `.cm-editor` 的 class，这个标记会被悄悄抹掉，所以插件用 `MutationObserver` 盯着，掉了就补回去。

**自己画一个。** 在 `.cm-scroller` 里插入零尺寸的 `.cj-caret-layer`，每个选区放一个 2px 的 `div`，用 `translate3d` 定位，用 `transition: transform, height` 做过渡。因为这一层是滚动元素的子节点，滚动时自动跟着文字走。

**Obsidian 自带的那条选区光标要让开。** Obsidian 启用了 CodeMirror 的 `drawSelection`，它的光标层会在每个非空选区的头位画一条 1.2px 的 `.cm-cursor`。藏原生插入符管不到它——它是 DOM 节点，`caret-color: transparent` 对它无效。不管的话，拖选时插件那条 2px 和 Obsidian 那条 1.2px 会并排出现。插件在自绘光标存在时把它隐藏：

```css
body.cj-on .cm-editor.cj-caret-on .cm-cursor,
.cm-editor.cj-on.cj-caret-on .cm-cursor { display: none !important; }
```

规则挂在自绘光标的状态上，不看鼠标，所以键盘选中的情形同样生效；关掉效果或进入输入法组字，Obsidian 自己的光标立刻回来。

**先量后写。** CodeMirror 的 `view.coordsAtPos()` 给出文档位置在屏幕上的矩形。插件在 `view.requestMeasure()` 的读阶段取这个矩形，换算成相对光标层的坐标，再在写阶段应用 transform。读写阶段分开，避免布局抖动：几何一次读完，样式一次写完。

位置滚出可视区时 `coordsAtPos` 返回 `null`。此时自绘光标隐藏，原生光标保持隐藏（不会出现两个光标），并每 80 ms 重试一次，最多六次，等布局跟上。

**时长不是固定的。** 设像素距离为 `d`：

```
duration = min(240, round(setting * clamp(0.55 + d / 260, 0.55, 1.9)))
```

单字移动大约用设定时长的 55%，跨屏跳转最多用 190%，上限 240 ms。设置项本身限制在 0–400 ms，0 表示完全关闭动画。

光标滑行时暂停闪烁：移动前移除闪烁动画，移动时长加 420 ms 的稳定期之后再恢复。否则光标会在滑动中途闪烁，看上去像画面抖动。

**不干扰原有交互。** 输入法开始组字时恢复原生光标并停止测量；鼠标按下后位移超过 4px 判定为拖选，拖选期间过渡时长归零；窗口获得焦点、编辑器获得焦点以及 300 ms 的兜底定时器都会补一次测量，覆盖那些不触发 CodeMirror 更新的代码路径；系统要求减少动态效果时，脚本和样式表同时关闭动画与闪烁。

### 对中文和输入法的处理

中文是这类光标动画最容易翻车的地方：拼音还在输入法里，文档里没有字；一旦回车确认，整个词一次性落进正文。这个插件把这种情况当正常路径处理。

- **认得出组字状态，不靠猜。** 输入法开始组字时隐藏自绘光标、交还原生光标，组字结束后再接管。候选窗开着的时候不会出现两个光标抢同一个字，确认拼音也不会把光标从半个字的位置甩出去。
- **固定 2 px 竖线，不跟着字宽走。** 全角标点和半角英文得到一样的光标，一行里中英混排时竖线不会被拉宽或抖动。
- **一串更新合成一次。** 输入法确认候选会连着触发几次编辑器更新，测量按帧合并，整个词落下来是一段滑动，不是几次抽搐。
- **滑动途中不闪烁。** 跨屏跳一大段中文时光标不会在路上一闪一闪。
- **按距离调速。** 单字移动只取设定时长的一半左右，中文快速输入时动画不会排在按键后面越积越多。

### 设置项

| 设置 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| 启用动效 | 开 | 开/关 | 总开关。命令面板里也有「切换光标平滑动画」。 |
| 滑动时长 | 90 ms | 0–300 ms（内部上限 400） | 跨屏跳转的基准时长，行内移动会自动压缩。 |
| 缓动曲线 | 平滑 | 平滑、标准、轻快、回弹、匀速 | 通过 `--cj-ease` 生效。 |
| 光标高度 | 紧凑 | 紧凑、整行 | 紧凑为 1.15 倍字号并下移 0.12 倍；整行与 Obsidian 原生光标一致。 |

设置写入 `body` 上的 CSS 变量（`--cj-duration`、`--cj-ease`、`--cj-caret-color`），主题仍可用 `--caret-color` 改光标颜色。

### 安装

社区插件市场搜索「Cursor Smooth Jump」。如果还没上架，手动安装：从 [最新 release](https://github.com/Citrussy/obsidian-cursor-smooth-jump/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`，放进 `<库>/.obsidian/plugins/cursor-jump/`，然后在「设置 → 第三方插件」里启用。

需要 Obsidian 1.4.0 及以上，仅桌面端。Vim 模式下插件自动停用，不改动 Vim 的块状光标。与其他修改光标的插件冲突，只能同时开一个。

### 开发

`main.js` 由 esbuild 从 `src/` 下的 TypeScript 源码（`src/main.ts` 管插件与设置，`src/caret.ts` 管光标层）打包成 CommonJS。仓库里直接提交打包产物，方便拷进库即用；改源码后跑 `npm install && npm run build`。发布版本都从这份源码构建。光标逻辑集中在 `createCaretEffectExtension(getSettings)`，所有时间常量都在光标模块顶部具名声明。改动后把三个文件拷进测试库、重载 Obsidian 即可验证。

## License

MIT. See [LICENSE](LICENSE).
