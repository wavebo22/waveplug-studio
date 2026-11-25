# 外附介面（native/overlay）交接

> 2026-11-04。给接手的 AI。先读项目根（`studio/`）的 [`AGENTS.md`](../../AGENTS.md)（不提交、不切分支、先看日志再改）；**回复用户用繁体中文、少用英文词**。
> 使用说明见同目录 [`README.md`](README.md)。文中路径都相对 `studio/`。
> 用户要求（11-04）：这套系统要**可复用、可重现、易修改**，它是将来所有插件外附界面的雏形。

## 1. 是什么、现在在哪

UXP 把每个插件面板画在独立的子窗口里，HTML 画不出面板边界。`native/overlay` 是 Rust 写的 Windows 小程序，和插件通过 `ws://127.0.0.1:47821` 通信，在面板外画**外附介面**（surface）。

第一个外附介面：**外置生成面板**（名称约定：「外置生成面板」；「工作台」只指 WaveLayer 图层面板里的「编辑工作台」）。Photoshop 文档有选区时出现在画布右下角，内容就是插件的生成页。

| 阶段 | 状态 |
|---|---|
| 1 分析与方案 | 完成（见第 7 节的已定决策） |
| 2 界面 Demo（`--demo`） | 完成，用户 11-04 在 Windows 上确认 |
| 3 接入：逻辑附属窗口、双向通信、状态同步、选区显示 / 隐藏、模式和参数同步 | **Windows 上已实测主面板显示与画布快捷键**（2026-11-05 用户确认）；前后台与最小化联动修复已编译部署，仍须用户验证切换行为。Mac 上曾用假插件跑通端到端 |
| 4 完整功能：生成 / 取消、收藏、参考图（含缩略图）、进度和错误、生成完成提示 | **代码已接通**：参考图支持当前图层 / 文件 / 剪贴板、真实缩略图、删除；数量框 X 重置和滚轮增减（2026-11-05） |
| 5 稳定性测试 | 进行中：Rust / TypeScript 测试通过，等待 Photoshop 现场验证移动角标与参考图 |

用户要求严格分阶段，每阶段确认后再进下一阶段。

**接手第一件事**：在 Windows 上编译新版 EXE 和 UXP，PS 的开发版面板点一次 ⟳ 载入新版脚本；此后不再需要用户手动双击启动 EXE，插件检测到 WebSocket 未连接时会通过 UXP 的 `shell.openPath` 启动外置框架（初次需用户授权）。核验 `reports/uxp_runtime.log` 的 `overlay connected`，以及 `reports/overlay_runtime.log` 中的 Photoshop 生命周期绑定；不得恢复旧的跨进程主窗口所有者绑定。

## 2. 架构：共用层 + 每个介面自己的层

```
插件（UXP）                                         小程序（Rust）
src/core/overlay/protocol.ts   ⇄ 协议 ⇄             src/protocol.rs
src/core/overlay/sections.ts   只发变化的区块
src/core/overlay/hub.ts        介面登记、版本号、    src/server.rs   连线（不认识任何介面）
                               重连重发、操作分发    src/host.rs     视窗、收状态、画当前介面、送操作
src/app/overlay.ts             连线、重试、合并发送  src/win.rs      Windows：附属视窗、位置、跟随 PS
                                                     src/panel/mod.rs  `Surface` 规格
── 每个介面 ──
src/core/overlay/generatePanel.ts  区块和操作的格式  src/panel/generate/mod.rs   套用区块、操作转 JSON
src/ui/generateSurface.ts          何时显示、操作交给  src/panel/generate/state.rs 面板数据和操作
                                   生成页的现有函数    src/panel/generate/view.rs  画面板
src/ui/app.ts  startOverlay()      生成页提供状态和     src/panel/generate/demo.rs  假数据 Demo
                                   改状态的入口
```

原则：
- **插件是唯一的大脑**：判断、生成、Photoshop 操作都在插件里；外附介面只画收到的状态、回报用户操作。
- **状态分区块**（`sections`），每次只发变化了的区块（`changedSections`）；每个介面一个只增不减的版本号 `rev`，小程序丢弃旧版本；重连（`hello`）后全部重发并恢复显示。
- **正在输入的不被覆盖**：提示词框 / 数量框有焦点时，插件发来的旧值不覆盖；提示词停止输入 300 ms 才发（`PROMPT_PAUSE`），其他操作发出前先把待发的提示词补上，保证顺序。
- 插件端多次状态变化在 40 ms 内合并成一条（`SYNC_MS`）。

## 3. 协议（两边一起改：`src/protocol.rs` ⇄ `src/core/overlay/protocol.ts`）

插件 → 小程序：

| 消息 | 含义 |
|---|---|
| `{"type":"hello"}` | 刚连上；版本号从头算 |
| `{"type":"show","panel":"generate","view":{left,top,right,bottom}}` | 显示介面，贴着 `view`（画布在屏幕上的范围，物理像素）摆放；`view` 可为 null |
| `{"type":"hide","panel":"generate"}` | 隐藏 |
| `{"type":"state","panel":"generate","rev":7,"sections":{…}}` | 介面状态（只含变化的区块） |
| `{"type":"layer-drag-start","docId":60,"layerId":15,"name":"图层 3","thumb":"data:image/jpeg;base64,…"}` | WaveLayer 开始跨窗口拖图层；thumb 是可选的小缩略图，不是生图输入 |
| `{"type":"layer-drag-cancel"}` | Escape 或源面板取消拖动 |
| `{"type":"hover-frame","rect":{…},"clip":{…}}` | 悬停边框：在 `rect`（屏幕物理像素）外侧画细蓝框，裁到 `clip`（画布视图）；`rect:null` 隐藏。由 `src/frame.rs` 处理，不进 UI 线程 |

小程序 → 插件：

| 消息 | 含义 |
|---|---|
| `{"type":"ready","version":"0.2.0"}` | 握手后立即发 |
| `{"type":"action","panel":"generate","action":{"kind":"set-mode","mode":"extract"}}` | 用户操作；`action` 的格式由介面自己定、自己检查 |
| `{"type":"view-request","panel":"generate"}` | PS 窗口移动 / 改变大小，请插件重新算画布范围并再发 `show` |

### 3.1 ComfyUI 与 Photoshop 生命周期（2026-11-05 新增，11-06 重做启动部分）

**11-06 随 PS 启动失效的原因与改法**（源码，PS 待实测）：
- 原因：开发版 `launchOverlay` 启动的是 `dist\waveplug-overlay-dev.cmd`，这个文件在悬停 POC 回滚时被删掉；`openPath` 的失败只写日志、界面不提示，且每次只试一次。日志里 11-05 22:44 之后 PS 重启了三次，外置框架一次都没连上。另外 `.cmd` 会弹终端，`build.cmd` 用 `taskkill` 更新会连带杀掉 ComfyUI。
- 现在：直接启动 exe（开发版 `G:\waveplug\studio\dist\waveplug-overlay.exe`，发行版插件文件夹里的 exe），路径固定不变；失败时状态栏提示原因。设置「ComfyUI 连接 › 启动与关闭」：外置框架 / ComfyUI 的运行状态和「启动 / 重启」按钮，开关「随 Photoshop 启动外置框架」（`helperAutoStart`，默认开）、「随 Photoshop 启动 ComfyUI」（原「不随…」反向开关，字段不变）、「随 Photoshop 一同关闭 ComfyUI」、「启动时不自动打开网页」。
- 更新不失效：exe 原地替换（改名 + 复制），helper 每 2 秒看一次自己 exe 的大小和时间，连续两次是同一个新文件就重启成新版（`src/life.rs`）。插件端在本会话连上过 helper 之后不再自动启动第二份，避免和正在重启的那份抢端口。
- 重启不关 ComfyUI：受管 ComfyUI 的 Job Object 有名字（`Local\WavePlugComfyUI-…`），信息写在 `%LOCALAPPDATA%\WavePlug\comfy_managed.json`。旧 helper 先关掉 kill-on-close、写状态，带 `--replace` 启动新 exe，等新 exe 按名字打开 Job（命名对象在最后一个句柄关闭时就会消失，所以必须在旧进程退出前打开）并通过事件 `Local\WavePlugHelperHandover` 确认，再退出；新 helper 恢复 kill-on-close 设置，等端口空出后监听。没接上时 ComfyUI 继续运行，按「已有实例」连接。
- 协议：`{"type":"restart-helper"}`；`manage-comfy` 增加 `restart`（只重启 WavePlug 启动的 ComfyUI；外部实例回 `external-running`，正在生成时回 `restart-required`）。

- UXP：`src/app/overlay.ts` 在 WebSocket 未连接时只尝试一次 `svc.launchOverlay()`；插件首次请求 `shell.openPath` 需要系统授权。Manifest v5 已声明 `.exe` 的 `launchProcess` 权限，发行构建把 `waveplug-overlay.exe` 随 `dist/plugin` 打包。EXE 使用 Windows GUI 子系统，**不出现控制台窗口**。
- ComfyUI：`src/ui/app.ts` 的「ComfyUI 连接」设置页有三个开关，由 `src/app/services.ts` 持久化：①「启动时不自动打开网页」默认开启（`comfyNoBrowser=true`，Rust 在 WavePlug 启动 ComfyUI 时向 BAT 的 `%*` 或 EXE 传 `--disable-auto-launch`，对已经运行的进程不重启）；②「不随 Photoshop 自动启动 ComfyUI」默认关闭（存储正向字段 `comfyAutoStartWithPhotoshop=true`，只阻止 ComfyUI 自动启动，外置框架 EXE 仍正常启动，手动点「启动」不受限制）；③「随 Photoshop 一同关闭 ComfyUI」默认开启（`comfyCloseWithPhotoshop=true`）。UXP 连上 EXE 后发送 `{"type":"manage-comfy","path":"…","base":"http://127.0.0.1:8188","closeWithPhotoshop":true,"restartIfNeeded":false,"disableBrowser":true,"startIfMissing":true}`；原生管理器发回 `{"type":"comfy-status","state":"not-configured|autostart-disabled|starting|ready|already-running|...","message":"…","owned":false}`。
- EXE：`src/comfy.rs` 用 Windows Job Object 管理**仅由 WavePlug 自己启动**的 ComfyUI 进程树；true 用无终端方式启动，并在 Photoshop 进程退出时结束；false 使用可见终端启动，并将 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 清零，Photoshop 退出时保留 ComfyUI。已经存在的外部实例只检测/连接，**绝不接管或结束**。
- 切换 true→false 时：仅当本次受管 ComfyUI 的队列空闲，才安全重启以显示终端；仍在生成时先更新保留策略，暂不重启，下次手动启动/重试时生效。反向切换尽量原地隐藏终端。启动文件丢失、无配置、远程地址、端口占用都要给明确原因，不得重复启动 ComfyUI。
- `src/win.rs` 使用 Photoshop **进程句柄**（不是窗口是否在前台）监控真正退出，届时无条件关闭外置框架；**不能因为用户切到其他程序或最小化 Photoshop 就终止 ComfyUI**。
- 回归：Rust `cargo test --release --offline` 包含受管进程树终止/保留测试；UXP `npm run typecheck`、`npm test`。真实 ComfyUI 自动启动需在 PS 开发版 ⟳ 载入新脚本后现场验证。不得为测试直接关闭用户现有 Photoshop 文档或工作流。

外置生成面板的区块（`GenerateSections`）：`mode`、`prompt`、`hint`、`favorites`、`refs`、`count`、`action`（按钮文字）、`blocked`（不能生成的原因）、`params`（高级参数：`number` / `toggle` / `seed`）、`run`（进度）、`status`。操作（`GenerateAction`）：`set-mode`、`set-prompt`、`set-count`、`set-number`、`reset-number`、`set-toggle`、`set-seed`、`new-seed`、`toggle-favorite`、`pick-favorite`、`remove-favorite`、`add-ref`、`drop-ref`、`remove-ref`、`finish-layer-drag`、`generate`、`cancel`。

### 3.2 右键菜单（2026-11-12，0.8.0，未实测）

`src/menu.rs`，不是一个 `Surface`：独立线程上的 Win32 弹出菜单，和 `frame.rs` 一样不经过 UI 线程。`menu-open` 带整棵菜单树（插件 `src/core/layers/contextMenu.ts` 生成），helper 只负责显示和回报选了哪一行的 id（`menu-result`）。不抢前台、靠低级鼠标钩子关菜单的原因和实测要点见 `docs/README.md` 11-12 条目。`plan()`（树 → 弹出菜单和命令编号）是纯函数，有测试；改菜单外观（自绘、图标）从这里的 `build()` 入手。

### 3.3 性能监视（2026-11-14，0.13.0，未实测）

`src/monitor.rs`，不是一个 `Surface`：和 `frame.rs` 一样是独立线程上的纯 Win32 窗口（`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST`，`WM_NCHITTEST → HTTRANSPARENT`），GDI 画文字，不经过 egui，不拿鼠标、键盘和前台。

- **协议**：插件 → 小程序 `{"type":"monitor","on":true,"comfy":"http://127.0.0.1:8188"}`（`view` 可选）。插件每次连上都重发（`src/app/overlay.ts` 的 `setMonitor`）；断线时关闭。设置项 `perfMonitor`（默认开），在「ComfyUI 连接 › 启动与关闭」。
- **位置**：画布右下角，留 12 px。画布范围取自任何 `show` 消息带的 `view`（`host.rs` 的 `on_command`），`hide generate`（没有文档）时清掉，退到 PS 主窗口右下角；`view` 不在 PS 窗口内时也退回。和完成提醒（同一个角）重叠时移到它上方。不能拖动（窗口是穿透的）。
- **显示规则**：窗口线程每 250 ms 看一次：PS（或小程序自己的窗口）在前台且没最小化才显示，连续两次不在前台就隐藏。隐藏期间采样线程不采样。
- **数据**（采样线程，每秒一次）：CPU `GetSystemTimes` 差值；内存 `GlobalMemoryStatusEx`；GPU / 显存 `nvml.dll`（只从 System32 加载，第 0 块显卡，没有就不显示这两行）；PS 进程工作集 `K32GetProcessMemoryInfo`；暂存盘每 5 秒扫一次各固定盘根目录的 `Photoshop Temp*` 文件，取合计最大的那个盘和它的剩余空间；ComfyUI 每 3 秒读一次 `/system_stats` 的 `torch_vram_total`（只读本机地址，`comfy.rs` 的 `system_stats`）。读不到的项不显示。
- **颜色**：占用 ≥ 80% 黄、≥ 92% 红；PS 占物理内存 ≥ 60% 黄、≥ 75% 红；暂存盘剩余 < 50 GB 黄、< 20 GB 红。行的文字和阈值是纯函数 `rows()`，有测试；定位 `place()` / `area()` 也有测试。
- **日志**：`monitor: on / off`、`window ready`、`nvml ready`（或没有 GPU 行的原因）、`shown at x,y WxH rows=N`、`hidden`。

### 3.4 卡死保护（2026-11-14，0.14.0，未实测）

`src/hang.rs`（监测和备份）+ `host.rs` 的 `hang_dialog`（egui 第三个视窗，标题 `HANG_TITLE`，由 `win::place_dialog` 放在 PS 窗口中间、置顶）。

- **监测**：独立线程每秒对 PS 主窗口（`win::photoshop_main_hwnd`，最小化也能找到）`SendMessageTimeoutW(WM_NULL, SMTO_BLOCK | SMTO_ABORTIFHUNG, 1000 ms)`。PS 做长操作时一般仍在处理消息，模态对话框也会处理消息，所以不会误报；打开超大文件这类真不处理消息的情况会弹框，选「继续等待」即可（`WAIT_MORE_SECS` = 60 秒后再问）。PS 重新响应时关闭对话框并发 `host::notify` 提示。
- **对话框不属于 PS**：不设 `GWLP_HWNDPARENT`，跨进程把窗口挂在卡死的窗口下面可能连带卡住。它可以被激活（PS 卡死时键盘本来也到不了 PS）。
- **备份**：`run_backup` 扫描恢复文件夹（深度 3），逐个复制；文件名匹配文档用 `match_doc`（不分大小写、取最长的文档名，至少 2 个字），目标路径 `backup_target`，重名加「 (2)」`free_name`。都是纯函数，有测试。复制时 PS 可能正在写这个文件，所以结果里列出失败的文件。每个找到的文件、复制目标、失败原因都写日志。
- **关闭 PS**：`TerminateProcess`。之后 `win.rs` 的 `watch` 看到 PS 退出，照常关闭外置框架（和按设置关闭 ComfyUI）。PS 下次启动时也会自己提示恢复。
- **待实测**：PS 恢复文件的真实命名（决定能否放到原文件旁边）；对话框在 PS 卡死时能否正常显示和点击；`SMTO_ABORTIFHUNG` 在 PS 打开大文件时的误报情况。

### 3.5 第二个客户端：Illustrator（2026-11-14，0.15.0，未实测）

`server.rs` 可以同时连两个客户端：**Photoshop 插件**（不报到，第一条消息就是普通命令，新的连接替换旧的）和 **Illustrator 的 WaveLayer 面板**（`ai/`，第一条消息 `{"type":"join","role":"illustrator"}`）。只有 Photoshop 的消息进 host；host 的事件（`server::send`）只发给 Photoshop。

- `{"type":"bridge","to":…,"msg":…}` 原样转给另一边，变成 `{"type":"bridge","from":…,"msg":…}`；对面不在时回 `{"kind":"missing","reqId":…}`。消息内容的格式在 `src/core/overlay/bridge.ts`。
- 一方连上或断开时，另一方收到 `{"type":"peer","role":…,"connected":…}`；新连上的一方马上收到对方当前在不在。
- 被同角色新连接替换掉的旧连接，断开时不算「Photoshop 走了」，不触发 `on_disconnect`。
- 纯函数 `route()` / `missing()` 有测试。

## 4. 新增一个外附介面（步骤）

以「图层工具面板」为例，名称 `layertools`：

1. **插件，格式**：新建 `src/core/overlay/layerToolsPanel.ts`，写区块类型 `LayerToolsSections`（每个字段是一个区块，可 JSON 化）、操作类型和 `parseLayerToolsAction(raw)`（逐字段检查，不合格返回 null）。照 `generatePanel.ts`。
2. **插件，接线**：新建 `src/ui/layerToolsSurface.ts`，`overlay.hub.register({ id: "layertools", sections, parseAction, onAction, onViewRequest })`；决定何时 `hub.show` / `hub.hide`；状态可能变化处调用 `overlay.queueSync()`。照 `generateSurface.ts`。
3. **小程序，介面**：新建 `src/panel/layertools/`，实现 `Surface`（`panel/mod.rs`）：`id()` 返回同一个名称；`apply(sections)` 只更新收到的区块；`ui(ui)` 画画面并返回操作 JSON。界面元件和颜色用 `panel/theme.rs`（token 取自 `plugin/styles.css`）。照 `panel/generate/`。
4. **小程序，登记**：在 `src/host.rs` 的 `surfaces()` 里加一行。
5. **测试**：插件端照 `tests/overlay_protocol.test.ts` / `tests/overlay_hub.test.ts` 测格式；小程序端照 `panel/generate/mod.rs` 里的 `tests` 测套用区块和操作 JSON；用 `tools/fake_plugin.ts` 的写法做一个假插件跑端到端，加 `WAVEPLUG_HOST_SHOT` 截图核对。

共用层（连线、版本号、重连、视窗、显示 / 隐藏、位置）不需要改。

**目前的限制**：小程序只有一个视窗，同一时间只显示一个介面（`host.rs` 的 `current`）。要同时显示多个，在 `host.rs` 里为每个介面开一个 egui 视窗（eframe 的多视窗），`win.rs` 按介面名称找视窗。

## 5. 外置生成面板的细节

- **显示规则**（`generateSurface.ts` 的 `refresh`）：当前文档有选区就显示，否则隐藏；不看模式、工作流、生成状态。切换文档时重新取画布范围。`refresh` 在 `app.ts` 的 `refresh()` 末尾调用（PS 每次可能改变文档 / 选区时都会走到）。
- **状态从哪来**（`app.ts` 的 `startOverlay`）：直接读生成页现有的变量和函数；按钮文字 `actionLabel()`、参考图标签 `refTag()`、参数范围 `paramRange()` 是从原有代码抽出来、两边共用的，改一处两边一起变。高级参数清单 `panelParams()` 和 `renderAdvanced()` 的顺序、规则一致，改其中一个要同步另一个。
- **操作怎么执行**：调用生成页原有的函数（`setMode`、`setPromptText`、数量写回、参数设置、`generate`、`cancel`、☆ 收藏按钮本身的 `click()`）。参考图 `add-ref` / `remove-ref` 已接到 UXP 的 `addReferenceFromSurface` / `removeRef`：当前图层取 PS 当前选中普通图层，文件走 `svc.pickImage`，剪贴板走 `pasteReference`；原始文件字节留在 UXP，仅把 128 px PNG 缩略图 data URL 发给 Rust。Rust 按槽位缓存纹理，点击 × 删除后仍调用同一个 UXP 数组移除函数。
- **同步点**：`renderAction`、`renderFav`、`renderRefs`、`renderAdvanced`、`renderStatus` 开头调用 `outSync()`。

### 5.1 模式只认面板自己的四个，折叠成底栏（2026-11-24 重做，未在 PS 实测）

- **问题**：插件和外置面板共用一个模式。插件里用过放大 / 扩图，或选中放大结果时插件自动跟随成「放大」，面板四个标签都不亮、按钮仍写「开始」，点了就跑放大。
- **现在**：面板只显示 / 只运行 `PANEL_MODES`（局部重绘 / 融图 / 抠图 / 文生图）。`shownPanelMode()`：插件模式在四个里就照它，否则用面板上次的模式（`settings.panelMode`，`setMode` 切到这四个之一时记下）。插件停在放大 / 扩图时，`app.ts` 的 `standbyPanelSections()` 发那个模式保存的提示词和数量，`note` 区块说明「在这里操作会切回…」。面板的任何操作（除切模式 / 取消）先经 `modeBeforeAction()` 把插件切回面板显示的模式再执行；`generate` 带上点击时标签显示的 `mode`，以它为准；运行中切不过去就丢弃这次操作并写日志。纯函数在 `generatePanel.ts`，测试在 `tests/overlay_protocol.test.ts`。
- **底栏**（`host.rs` 的 `bar()`）：折叠时整个窗口是一条 26 px 的底栏（原来是 12 px 黑条），左边「✦ 生图 · 模式」，右边是状态（运行进度 / 错误 / 不能生成的原因 / 提示 / 就绪），运行时底边有进度线；展开时同一条栏留在最下面当页脚（鼠标还在它上面，不会一展开就移出去），右边是「固定」按钮和角标。内容由 `Surface::bar()` 提供。
- **展开 / 收起**：悬停立即展开；Windows 上除了 egui 的悬停，还直接比对光标和窗口范围（`cursor_in_panel_reveal_zone(0.0)`），不怕漏掉第一次移入。鼠标离开后等 `COLLAPSE_GRACE`（500 ms）才收起（纯函数 `fold_now`，有测试）。「固定」后一直展开（本次运行有效）。截图自检：主程序加 `WAVEPLUG_HOST_OPEN=1` 以固定展开状态启动；假插件加 `WAVEPLUG_FAKE_IDLE=1` 发空闲 + 提示的状态。

## 6. Windows 部分（`src/win.rs`）

- **逻辑附属视窗（2026-11-05）**：主生成面板是独立顶层窗口，**禁止设置 `GWLP_HWNDPARENT` 指向 Photoshop**；实测跨进程真实 owner 会破坏 PS 画布快捷键。保留 `WS_EX_NOACTIVATE`（启动后 eframe 可能覆盖样式，`watch()` 会恢复），在 Photoshop 前台且主窗口未最小化时临时置顶；切换其他程序、最小化或关闭 Photoshop 时移到 `PARK` 屏幕外，返回后由 `PLACED` 缓存的坐标和尺寸还原。不是用 `ShowWindow` 真隐藏。初次从浏览器启动时通过枚举顶层视窗寻找后台 Photoshop；最小化期间不采用 UXP 的异常屏幕坐标。**不要恢复旧的跨进程拥有者绑定**。
- **位置**：画布**左下角**（用户 11-04 要求），留 12 px（按显示器 DPI 缩放），加上用户拖动的偏移（`OFFSET`，拖动结束时 `drag_finished` 记下，程序运行期间有效），并限制在画布内；高度不超过画布高度。没有画布范围时退回 PS 视窗，再退回显示器工作区。
- **移动**：只能用右下角角标（`host.rs` 的 `grip`）拖动。不要使用 `ViewportCommand::StartDrag`；当前窗口必须保持 `WS_EX_NOACTIVATE`，由 `win::move_by` 在拖动期间使用同步 `SetWindowPos(... SWP_NOACTIVATE)` 逐帧移动，松开时 `drag_finished` 将物理位移写入 `OFFSET`。角标命中区 20 px，视觉仍为三条短斜线。这样避免原生非客户区拖动与 no-activate 冲突，不影响 Photoshop 快捷键。
- **键盘一直留在 PS**：面板视窗带 `WS_EX_NOACTIVATE`（点按钮不会启用视窗，像屏幕键盘、绘图软件的工具浮窗）。只有提示词框 / 数量框要打字时（`ctx.wants_keyboard_input()`，`host.rs` 的 `track_typing`）才去掉这个样式并拿键盘（`win::set_typing(true)`），不打字了立刻恢复并还给 PS。11-04 历史：第一版点过面板后 Alt 缩放失效；第二版「事后还键盘」后，画布上大部分移动快捷键仍失效，所以改成根本不拿键盘。
- **日志**：`reports/overlay_runtime.log`（`log.rs`）：启动、show / hide 位置、typing 开关、键盘在谁手上（photoshop / overlay / other）每次变化都记一行；角标拖动记录 drag started / finished 坐标、delta 与累计 OFFSET。
- **跟随 Photoshop 统一一套规则（2026-11-24）**：生成面板、变体栏、编辑工作台、底部状态栏（`monitor.rs`）都只看 `win::photoshop_present()`。`watch()` 每 250 ms 算一次：PS 主窗口在且没最小化，并且前台（经 `steady_front`：helper 自己的菜单 / 提示 / WavePlug 窗口、短暂无前台都沿用上一次）是 photoshop / overlay / variants / workbench 之一；回来立即显示，离开要连续 `PARK_AFTER_TICKS`（2 次）才隐藏（纯函数 `present_now` / `next_presence`，有测试）。以前各窗口各有一套：状态栏把 helper 自己的窗口也算作 PS 在前台，所以切到别的软件后它常留在屏幕上。日志 `photoshop present true/false: foreground=…`。
- **跟随 PS**：每 250 ms 看一次 PS 主视窗位置，变了就发 `view-request`，插件重新算画布再发 `show`。
- **「隐藏」= 停在画面外**（`PARK`，-32000），不真的隐藏：11-04 第一版用 `ShowWindowAsync` 真隐藏 / 显示，但 egui 在第一次画面时会照它自己记的「隐藏」再藏一次，结果有时选区时不出现、取消选区时反而出现。现在视窗对 egui 来说一直是开着的，只是位置在画面外。启动时设为工具视窗（不在工作列、不在 Alt+Tab）。
- 从伺服器线程直接移动视窗，用非同步呼叫（`SWP_ASYNCWINDOWPOS`）。视窗靠唯一标题 `WavePlug 外置生成面板`（`host::TITLE`）找到。

- **完成提醒**（共用功能，不属于某个介面）：插件 `hub.toast(title, text, view)` → `{"type":"toast"}`；小程序用 egui 的第二个视窗（`host.rs` 的 `notice`，标题 `WavePlug 提示`）画黄色边框的提示，`win::place_toast` 放到画布右下角并设为 PS 的附属、不启用视窗；`ms` 到了或点一下就关。外置生成面板在 `generateSurface.ts` 里检测「运行中 → 结束且不是错误 / 取消」时发出。
- **动画（2026-11-24 重做）**：展开 / 收起不再逐帧改窗口高度（以前每帧异步 `SetWindowPos`，GPU 画面跟着重建尺寸、内容从上往下排，所以底栏和内容一直跳）。现在窗口保持展开时的高度，收起时只用窗口区域（`win::clip_panel`，`SetWindowRgn`）露出底部的底栏；展开 / 收起在 `RESIZE_SECS`（0.16 秒）里缓动区域高度（`host.rs` 的 `fold_height`，有测试），过渡期间一直画展开的内容。被区域挡住的部分鼠标穿透到 PS，`cursor_in_panel_reveal_zone` 按露出的部分算。窗口真正改高度只在展开内容变高 / 变矮时（收藏夹展开等），一次同步改完。滑入滑出（`anim::slide`）每步用 `DwmFlush` 跟屏幕刷新走，不再固定睡 15 ms。
- **变体栏尺寸与删除（2026-11-24）**：以前 egui 的视窗设置（每帧按内容变的 `with_inner_size` / `with_max_inner_size`）和 `win.rs` 的异步 `SetWindowPos` 同时改窗口大小、取整不同，加变体、拖缩略图滑杆时窗口一直抖。现在 egui 只在建窗口时给一次尺寸（`variant_made_size`），之后只有 `win::variant_apply_size` 在 UI 线程同步改尺寸：窗口立即取「现在露出的」和「目标」中较大的那个，用窗口区域（`clip_rail`）在 `RESIZE_SECS` 里缓动露出 / 收起差值（纯函数 `rail_size_at` / `rail_window_size`，有测试）。按住鼠标时窗口尺寸和上次设的不同 = 用户在拖底边，以用户的为准。悬停缩略图时右上角出现小垃圾桶，点了发 `{"kind":"delete-variant",layerId,groupId}`，插件用 `deleteVariation`（一步历史记录，删掉显示中的那个时最后一个顶上）；只剩一个变体时不显示。
- **高度贴合内容**：`host.rs` 的 `fit` 量内容高度，`win::fit_height` 保持底边不动调整高度。
- **数量控件（2026-11-05）**：数量框左侧的 × 是重置到 1 的按钮；鼠标悬停在数字输入框上滚轮，每格增减 1，范围固定 1–4；走原来的 `SetCount` 动作，UXP 保存并同步。
- **参考图缩略图（2026-11-05）**：`GenerateSections.refs[].thumb` 为可选 PNG/JPEG data URL；`RefIn` 对旧消息兼容（thumb 缺省）。Rust 统一限制 URL 256 KB、解码后 192 KB、图片最大 512×512；缩略图拒绝与解码失败写入日志，纹理在同槽位且 URL 未变时复用。
- **WaveLayer 图层拖入参考图与拖拽虚影（2026-11-06，初版 0.2.0）**：普通图层拖动超过阈值后，UXP 发送 `layer-drag-start`（docId / layerId / name / 可选缓存缩略图 data URL）。WaveLayer 面板内显示半透明缩略图、图层名和当前放置动作；鼠标进入原生外置面板后，Rust 在主 UI 帧中读取 Win32 全局光标，在面板内绘制同一张缩略图和「拖入参考图」提示，参考图槽位仍由原逻辑高亮。缩略图只用于拖拽预览；实际生图仍从 Photoshop 原图层读取像素，不使用缩略图作为输入。
  - **释放路由**：mouseup 在 WaveLayer 面板外时交给原生 helper，不再进入 UXP 普通图层排序 / Alt 复制路径；在 WaveLayer 面板内释放仍保留普通排序和编辑工作台投放。面板隐藏时，helper 在鼠标释放 / Escape 后发送一次 `finish-layer-drag`；WebSocket 断线时 UXP 结束源拖动态。避免重复移动和拖动态残留。
  - **虚影范围**：分别在 WaveLayer 面板和外置面板内部跟随鼠标；不创建全屏透明顶层窗口，避免影响 PS 点击、快捷键和焦点。
  - **验证与部署（2026-11-06 重启切换）**：TypeScript 类型检查通过、npm 177/177、Rust 34/34、UXP Release 构建和 Rust Release 构建通过，`git diff --check` 通过。Helper 0.3.0 已部署到 `dist/waveplug-overlay.exe`、`dist/plugin/waveplug-overlay.exe`、`dist/dev/waveplug-overlay.exe`，pending 文件保留；四份 SHA-256 均为 `97C12488F65D0B07ED3CC98BB87CF3CA6E427FBA568252FF97820F5458200E51`。旧 0.2.0 备份：`dist/waveplug-overlay.pre-0.3.0-20261106-014837.exe`。新版 Helper PID 38768，由 Windows MCP 独立托管；WebSocket 47821 正常监听。Photoshop PID 12708 已退出，测试文档 `测试.psd` 在保存提示中选择「否」丢弃修改；Photoshop 重启为 PID 19332。UXP 开发加载器重新读取 `dist/plugin/index.js`，日志确认 `overlay connected`、`overlay ready 0.3.0`。ComfyUI 已按 `close_with_photoshop=true` 重启，启动器 PID 14424、Python PID 13380；`127.0.0.1:8188/system_stats` 返回 HTTP 200，版本 0.37.0，队列 0/0。
  - **UXP 加载**：Photoshop 重启后开发加载器自动读取 `G:\waveplug\studio\dist\plugin` 最新 `index.js` 和 `styles.css`；无需再点橙色 `⟳`。本轮 bundle 构建后需在开发面板点橙色 `⟳`，加载八槽位逻辑。悬停定位仍维持旧功能默认关闭，新的交互尚未确定。
  - **现场验收**：Photoshop 当前无打开文档（`photoshop_get_state`：0 documents），测试 PSD 已按用户要求不保存关闭，未触发真实生图。仍需打开专用 `WavePlug_TEST_` PSD 验证 2–8 层拖放、普通排序、Alt 复制、工作台、无效释放、Escape 和快速连续拖动。Helper 在其他应用前台时会按设计停靠；切回 Photoshop 前台后恢复。
- **多图层批量参考图（2026-11-06，helper 协议 0.4.0）**：一次拖动多选普通图层时，UXP 按 WaveLayer 当前图层顺序收集有效图层 ID / 名称，最多发送 8 个候选；native preview 显示缩略图与「N 个图层 / 依次放入空槽位」。松开某个参考图槽位后，helper 发送 `drop-refs`，UXP 从该槽位起向后分配空槽位，逐个读取各图层 128 px 缩略图并保存 `{kind:"layer",docId,layerId}`；生图时仍从原 Photoshop 图层读取像素。已有参考图不覆盖，跳过已占用槽位；空位不足时部分放入，并提示未放入数量。拖入的组 / AI 结果组仍不作为参考图。
  - **参考图上限（2026-11-06 扩展）**：`MAX_REFERENCES=8` / `MAX_REFERENCE_SLOTS=8`；自动识别的工作流最多使用 8 个可用 IMAGE 输入；显式 reference bindings 也只处理 1–8 槽。UXP 和 native 槽位布局均支持最多 8 张，均使用可换行布局。提示词编号：画布图1，参考图图2～图9。
  - **协议兼容**：`layer-drag-start` 新格式为 `layers[] + totalCount + thumb`；Rust 仍接受旧版单层 `layerId + name`。旧 `drop-ref` 动作由 UXP 兼容层转为单项 `drop-refs`。
  - **验证**：本轮结果见 `reports/LIVE_TEST_2026-11-06_refs8-hover-locator.md`。Helper 0.4.0 已构建待启用；当前运行的 0.3.0 不接受第 7、8 槽，需安全重启 Helper 后生效。UXP bundle 需刷新后生效。真实 2–8 层拖放仍待 `WavePlug_TEST_` 实机验收。

- **悬停边框（2026-11-06，用户已在 PS 确认）**：`src/frame.rs`，独立线程上的纯 Win32 窗口（不用 egui、不逐帧重绘）。`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST`，再加 `WM_NCHITTEST → HTTRANSPARENT`、`WM_MOUSEACTIVATE → MA_NOACTIVATE`：鼠标、滚轮穿透到 PS，不激活、不拿键盘。窗口是一块纯色背景，用窗口区域（`SetWindowRgn`，外框减内框）只留四条边，并裁到画布视图，不会盖住 PS 的面板。线宽按显示器 DPI：100% 为 1 px，150% 为 2 px。服务器线程只 `PostMessageW`，最新的请求覆盖旧请求，不排队。插件断开时隐藏。11-06 POC 的独立透明窗口实测证明这类样式不改前台窗口、点击落到 PS（`reports/hover_passthrough_poc.log`，已备份）。

## 7. 已定决策（11-04，和用户确认过）

| 项 | 决定 |
|---|---|
| 界面技术 | Rust 原生，egui / eframe 0.31（glow）。**不用 WebView2**（用户不接受内存占用） |
| 字体 | 系统微软雅黑（`msyh.ttc` / `msyhbd.ttc`），内存映射（`memmap2`）+ 借用，不拷贝。Mac 上实测约 35 MB（整份读入时 330 MB） |
| 内容 | 照用户截图：4 个模式标签（局部重绘 / 融图 / 抠图 / 文生图）；扩图、放大暂不放（插件在这两个模式时面板没有标签亮起） |
| 提示文字 | 放在提示词框内，开始输入即消失 |
| 按钮文字 | 一律「开始」（`view.rs` 的 `START`），运行中「取消」；面板标签是唯一的模式来源，「开始」带着它（11-24） |
| 高级参数 | 外置面板不显示（`SHOW_ADVANCED = false`），在插件面板里调；状态仍照常同步 |
| 位置 | 画布左下角，只能用右下角角标拖动 |
| 完成提醒 | 画布右下角黄色框，8 秒或点击关闭 |
| 视窗层级 | **逻辑附属**：独立非激活主窗口，PS 前台时临时置顶、切换其他软件/最小化时停泊隐藏、返回后恢复位置；严禁恢复主面板跨进程 owner |
| 生成完成 | 第四阶段：即使面板已隐藏，也在原位置弹提示，点一下定位结果 |
| 原插件生成页 | 用户不再需要同时使用；插件面板仍需载入才能运行插件代码（面板收起时能否运行待实测） |

## 8. 已确认的 Photoshop 事实（11-04 用 PS MCP 实测）

| 文件属性（batchPlay `get`） | 实测 | 含义 |
|---|---|---|
| `zoom` | `{_unit:"percentUnit", _value:1}` | 1 = 100%（值是倍数） |
| `center` | `horizontal 360.17、vertical 586`（`distanceUnit`） | 视图中心对应的文件点，单位是**点**；× 分辨率 / 72 = 文件像素 |
| `viewInfo.activeView.globalBounds` | `1008, 139, 3037, 2087` | 画布视图在屏幕上的范围（看起来是物理像素） |
| `viewTransform` | 报错 | 这个 PS 版本没有 |

读取：`uxpHost.ts` 的 `canvasView()`；文件坐标 → 屏幕：`protocol.ts` 的 `docToScreen()`（外置生成面板目前只用 `view`，将来需要贴着选区的介面可以用 `docToScreen`）。

## 9. 编译、测试、坑

- **编译在用户的 Windows 主机上**：`build.cmd`。运行中的 exe 不能覆盖但能改名：脚本把它改名为 `waveplug-overlay.old-*.exe` 再复制新版，**不再 `taskkill`**（旧做法会连带杀掉它管理的 ComfyUI）。运行中的 helper 发现自己的 exe 被换掉后自动重启成新版（`src/life.rs`）。`npm run build` 往 `dist/plugin`、`dist/dev` 复制时也用同样的改名方式，并清理不再运行的 `.old-*.exe`。
- **Mac 上可以先检查**：这台 Mac 装了 Rust（`~/.cargo/bin`）和 Windows 目标：`cargo check --target x86_64-pc-windows-gnu`（只检查不链接）；`cargo test`；Mac 版能实际运行 Demo 和主程序（主程序在 Mac 上不隐藏）。
- 插件端：`npx tsc --noEmit -p .`、`npm test`、`npm run build`。
- windows-sys 0.59：`HWND` 等句柄是指针；Win32 常数在 `win.rs` 里写成数字，避开各版本的类型差异。
- egui 跟随系统明暗主题：`theme::install` 里固定为暗色，否则 Mac 浅色模式下元件变白。
- 旧的「选区浮动生成条」（`window.rs`，鼠标钩子 + 选区下方定位）在 git `9559c4d` 里，已被外置生成面板取代并删除。
- 不要改用户的正式 PSD；测试用 `WavePlug_TEST_` 开头的文件。
