# WavePlug Studio — 项目状态交接（2026-11-02）

给接手、继续开发新功能的对话。文档入口是 [`docs/README.md`](README.md)。图层面板的细节见 [`LAYER_PANEL_HANDOFF.md`](LAYER_PANEL_HANDOFF.md)，构建、安装和 UXP 行为见 [`DEVELOPMENT.md`](DEVELOPMENT.md)。

> **2026-11-02 暂停点**：用户要求先暂停修改、整理文档。图层面板有一批改动只改了源码，没打包、没测（见 `LAYER_PANEL_HANDOFF.md` 第 0 节、第 3.3 节）；「悬停定位」有会卡死 PS 的 bug，而且默认开着（第 5 节）。接手前先读这两节。

## 1. 一句话

Photoshop UXP 插件，连接本地 ComfyUI，把 AI 结果像 PS「创成式填充」那样以图层组 + 变体的形式写回文档。另有不需要 ComfyUI 的「工具」页，以及独立的「WavePlug 图层」面板。

## 2. 版本与 git

- 代码在用户 Windows 机 mainpc 的 `F:\waveplug\studio`，这台 Mac 上挂载为 `/Volumes/wavebobo/waveplug/studio`。
- 分支 `local-test`。最后一个正式版是 **1.1.0**（标签 `v1.1.0`，`main` 也在那里）。
- 1.1.0 之后**已提交、未发布**：`5e21588`，包括融图、抠图模式、文档瘦身、批量放大、上传压缩。
- 图层面板 2026-11-03 已提交（「feat: WavePlug 图层 panel」，未发布）。`reports/` 下的日志没有提交。
  - `workflows/` 下有两个未跟踪的工作流 JSON，不是本项目的改动，不要动。
- **只在用户要求时提交**，不要切分支。提交说明末尾按会话给的署名格式写。
- 当前状态：`npx tsc --noEmit -p .` 没有报错；`npm test` 89 个全过（2026-11-03 核对过）。`dist/` 11-03 重新打包，和源码一致（含 `LAYER_PANEL_HANDOFF.md` 第 3.4–3.6 节，3.5、3.6 未在 PS 里测）。悬停定位已改成默认关闭。
- `docs/history/` 是历史资料：V1.4 设计交接，以及 0.1.x 实机测试交接 `LOCAL_TEST_HANDOFF.md`。只作参考，内容已过时。

## 3. 开发流程

1. 改代码，然后 `npm run build`，生成 `dist/plugin`、`dist/dev`、`dist/preview`。
2. 用户在 PS 的开发版面板（WavePlug Studio Dev / WavePlug 图层 Dev）里点 ⟳，重新加载 `F:\…\dist\plugin`。
3. 读 `reports/uxp_runtime.log`：开发版的日志会镜像到这里，Mac 上可以直接读。**PS 里出问题，先看日志、拿到证据再改。**
4. 浏览器预览（`dist/preview`，用模拟的 PS 和 ComfyUI）适合看布局和交互。预览服务器读不到网络盘，要先把 `dist/preview` 复制到本地再起 `python3 -m http.server`。**浏览器能用，不代表 UXP 里能用。**
5. 只要改了 `plugin/manifest.json`（面板、权限）或 `dev/` 目录：
   - 调高 `scripts/build.mjs` 里的 `DEV_LOADER_VERSION`（现在是 1.4.0）；
   - 运行 `python3 scripts/package_ccx.py dev`；
   - 让用户关掉 PS，以管理员身份运行 `scripts\install_dev.cmd`。
   - 版本号不升，UPIA 会报 -418；工作目录不在 C 盘，会报 -198（脚本已处理）。
6. 发正式版：改 manifest 和 `main.uxp.ts` 的版本号、写 `CHANGELOG.md`，运行 `python3 scripts/package_ccx.py`，再运行 `install_ccx.cmd`。用户机器上目前还装着旧正式版 0.2.3。

## 4. 架构

```
src/core/     纯逻辑，不依赖 PS，node --test 直接测（tests/*.test.ts）
  comfy/      ComfyUI 客户端（HTTP + WebSocket）
  image/      png 编解码、deflate、区域、合成
  workflow/   工作流识别（recognize）、UI→API 转换、注入（inject）、profile、参考图、局部遮罩
  layers/     智能对象计划（smart）、像素岛、文字拆行、文档瘦身（slim）、图层树（tree）、缩略图（thumbs）
src/ps/       PS 端实现
  host.ts     接口：PsHost（生成用）、LayerTools（工具页）、LayerTree（图层面板）
  uxpHost.ts  play/modal/step（step = 一步历史记录）；modal 结束时触发 onModalDone
  uxpTools.ts 工具页命令
  uxpLayers.ts 图层面板的读取和全部命令
  net.ts      UXP 网络、诊断
src/app/      generate.ts（各模式的生成流程）、services.ts（依赖注入、设置存储）、log.ts
src/ui/       app.ts（主面板：生成 | 工具）、tools.ts、layerTree.ts / layersPanel.ts（图层面板）、
              expandEditor.ts（扩图画布）、popupMenu / tooltip / slider（自绘控件）、dom.ts（h()、icon()、setShown）
src/preview/  浏览器预览：MockHost / MockTools / MockLayerTree / MockComfy
dev/          开发版加载器（注册两个面板，eval 最新构建）
```

约定：
- 能放进 core 的逻辑都放进 core，并写测试。
- 修改 PS 文档的操作一律放在 `step("WavePlug …", docId, fn)` 里，保证一次操作就是一步历史记录。
- 只读操作或会弹对话框的操作用 `modal()`；会弹 PS 对话框的要加 `{ interactive: true }`。

## 5. 功能清单

**主面板 · 生成**（每个模式各自记住自己的工作流，生成前会从 ComfyUI 重新同步）
- 局部重绘、融图、抠图、扩图（面板内拖动画布）、文生图、放大（整个画面 / 当前图层）。
- 结果写成图层组「AI填充 · …」「AI融图 · …」「AI抠图 · …」「AI扩图 · …」「AI生成 · …」「AI放大 · …」，组内每个变体一个图层。
- 参考图、提示词收藏夹、变体缩略图与对比、高级参数、一键启动 ComfyUI。

**主面板 · 工具**（不需要 ComfyUI）
- 智能对象：断开链接、查找同源、转换 / 分别转换、转为可编辑、解包、重置变换、替换内容、导出内容。
- 边缘与像素岛：裁剪边缘、拆分像素岛。
- 文字：按行拆分文字。
- 文档瘦身：扫描、清理、释放 PS 内存。

**WavePlug 图层面板**（独立停靠面板，详见 `LAYER_PANEL_HANDOFF.md`）
- 增强版图层树：
  - 状态列：智能对象独立 / 共用、链接、内容类型、智能滤镜、fx、锁定。
  - 效果标签、智能滤镜子行（可以拖动）。
  - 蒙版、剪贴蒙版、链接图层的显示。
  - 共用内容着色。
- 操作：拖动排序；右键菜单；底部工具栏；双击（缩略图 → 图层样式，名字 → 重命名，智能对象图标 → 打开内容）。
- 顶部：搜索和类型筛选、混合模式、不透明度和填充、锁定。
- 性能：只画放得下的行，自绘滚动条，不用原生滚动区域；缩略图按图层内容读（细长图层补边到 4:1），按图层缓存。
- 11-02 新增（多数还没在 PS 里确认）：缩略图大小「无 / 小 / 中 / 大」、组和子行用矮行高、PS 风格图标、画板圆角彩框、Ctrl+单击载入选区；只改了源码的有图层颜色、拖过眼睛列批量显示 / 隐藏、矢量蒙版、蒙版链接、Alt 看蒙版、双击智能滤镜。确认程度见 `LAYER_PANEL_HANDOFF.md` 第 3 节。

## 6. 尚未在 PS 里确认的

- 图层面板：按确认程度分的完整清单见 `LAYER_PANEL_HANDOFF.md` 第 3 节（3.2 已打包未确认，3.3 只改了源码）和第 7 节（智能滤镜拖动、单个效果开关、`linkedLayerIDs`）。
- 融图、抠图（含「抠完后从原图移除」）在 PS 里做过的实测有限。
- ComfyUI 现在带 `--enable-cors-header` 启动（不是插件加的）。去掉这个参数后插件能否连接，还没验证。
- 16 位文档没测过。

## 6.5 未解决（搁置）

- 图层面板里添加矢量蒙版仍然不行，用户要求先搁置。证据和推测见 `LAYER_PANEL_HANDOFF.md` 第 6.5 节。

## 7. 待办与可选方向（用户提过或之前建议过，**做之前先和用户确认**）

- **进行中（11-03）**：图层样式 / 智能滤镜的拖动排序与复制。已按原版规则实现并打包，等用户在 PS 里测，见 `LAYER_PANEL_HANDOFF.md` 第 6.6 节。

- 矢量化（在用户的升级计划里，还没开始）。
- 「应用变体」：把选中的变体合并 / 落地为普通图层，并清理图层组。
- 提示词历史（收藏夹之外的最近使用记录）。
- 图层面板：
  - 决定第 3.3 节那批改动的去留（打包实测还是回退）；
  - 悬停定位按用户选定的方案重做（`LAYER_PANEL_HANDOFF.md` 第 5 节，推荐「画布小地图」）；
  - 和 PS 原版相比还缺的功能，见第 8 节（快捷键、筛选、右键菜单、面板菜单等）。
- 发版：等用户确认后，把 `5e21588` 和图层面板一起发成 1.2.0（要写 CHANGELOG）。

## 8. 用户偏好与协作方式

- 回复用中文，说清楚做了什么、没验证什么。
- 界面要「无感」：不跳动、不闪。文字高对比、别太小（PS 用中灰主题）。
- 说明一律做成鼠标悬停提示（`src/ui/tooltip.ts`），不要做「?」弹窗。
- 额度紧张：不要盲目试错。PS 里的问题先加日志或诊断、拿到证据再改，每轮改动尽量小。
- 用户会一边测一边提新需求。新消息里的要求要合进当前这轮，并在回复里逐条说明。

## 9. UXP / Photoshop 踩过的坑（摘要，详见两份 HANDOFF 和 DEVELOPMENT.md）

- `<button>`、`<label>` 会被渲染成原生控件，所以 `h()` 把它们换成了 div。原生输入框会画在所有内容之上，`input[type=range]` 和数字输入框很高。
- `title` 不显示（用自绘的悬停提示）；`getBoundingClientRect` 和鼠标坐标对不上；CSS 属性选择器不可靠。
- **UXP 不画 box-shadow**（浏览器预览里能看到，PS 里看不到）。
- 原生滚动区域、细长图片都可能让 UXP 停止绘制整个面板。缩略图按图层自身边界读，长宽比限制在 4:1 以内，一定缩到 48 px 的小框里（见 `thumbArea` / `frameThumb`）。
- PS 不会把插件自己 batchPlay 的操作通知给插件（靠 `onModalDone` 补上）。
- `applyLocking` 按图层 id 指定会被静默忽略，必须先选中图层；智能滤镜、效果的显示 / 隐藏也要用当前选中图层的引用。
- `select menuItemClass blendingOptions` 不可用；图层样式对话框改用 `set layerEffects` 并显示对话框。
- `getPixels` 会临时报「不能使用移动工具」「无法更新智能对象文件」，这是 PS 正忙，重试即可。
- 改文件时**不要**写 `open(p,'w').write(open(p).read())`，它会先清空文件，曾经清空过源码。
