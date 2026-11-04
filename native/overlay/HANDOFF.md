# 浮动生成条（native/overlay）交接

> 2026-11-04。给接手 Rust 端设计的 AI。先读项目根（`studio/`）的 [`AGENTS.md`](../../AGENTS.md)（不提交、不切分支、中文回复、先看日志再改）。
> 使用说明见同目录的 [`README.md`](README.md)；本文讲现状、设计和接下来要做的事。文中的路径都相对 `studio/`。

## 1. 它是什么，为什么要它

UXP 把每个插件面板画在一个独立的子窗口里，HTML 永远画不出面板边界（悬停提示、弹窗、拖拽预览都被关在面板里）。`native/overlay` 是一个 Rust 写的 Windows 小程序，和插件通过本机 WebSocket 通信，**在面板外**画东西。

第一个功能：**选区浮动生成条**。在 PS 里建立选区后，选区正下方居中弹出（和 PS 自带的「上下文任务栏」同一位置）：

```
[ 提示词……………… ] [ 1 ] [ 生成 ] ×
```

用户已确认（11-04）：能弹出、位置可以。这是原型，用户要求接下来由你负责 Rust 端的设计。

## 2. 现状

| 项 | 状态 |
|---|---|
| Rust 程序 | 在用户的 Windows 主机上编译运行成功（`dist/waveplug-overlay.exe`，286 KB） |
| 插件端 | 已构建；`npx tsc --noEmit -p .` 通过，`npm test` 165 项全过 |
| 按选区坐标定位 | 已实现，**还没有日志证据**：`reports/uxp_runtime.log` 里还没有 `overlay show` 行（可能用户没在这版插件之后点 ⟳）。如果没有这行，生成条走的是第 4 节的「鼠标钩子」回退 |
| Git | 全部未提交（`native/` 未跟踪）。只在用户要求时提交 |

**接手第一件事**：请用户点 ⟳、画一个选区，然后在日志里找 `overlay show`，确认 `view` 不是 null、`anchor` 和屏幕上的实际位置一致（见第 4 节）。

## 3. 架构

```
PS 事件 ──► 插件 refresh() ──► syncOverlay()
                                 │  读选区 + 画布视图，换算成屏幕坐标
                                 ▼
              ws://127.0.0.1:47821  {"type":"show", prompt, count, anchor}
                                 ▼
                       waveplug-overlay.exe（Win32 窗口）
                                 │  用户输入、按生成
                                 ▼
              {"type":"generate", prompt, count} ──► onOverlay() ──► generate()
```

- 小程序是 **WebSocket 服务端**，插件是客户端。插件连不上时每 3 秒静默重试，插件其他功能完全不受影响。
- 生成本身**全部由插件做**：小程序只收集提示词和数量。
- 只在 Photoshop 里连接（`svc.host.kind === "uxp"`），浏览器预览不连。

### 文件

| 文件 | 作用 |
|---|---|
| `native/overlay/Cargo.toml` | 依赖：`windows-sys 0.59`、`tungstenite 0.24`、`serde`。release 用 `opt-level = "z"`、LTO、strip |
| `native/overlay/src/main.rs` | 入口，`windows_subsystem = "windows"`（无控制台）。非 Windows 只打印一句话 |
| `native/overlay/src/protocol.rs` | 消息类型和端口，含单元测试 |
| `native/overlay/src/server.rs` | WebSocket 服务线程：非阻塞读写，每 15 ms 一轮；新连接替换旧连接（开发版 ⟳ 会重连）；连接断开时向窗口发 Hide |
| `native/overlay/src/window.rs` | 窗口、控件、绘制、定位、鼠标钩子、前台检测 |
| `native/overlay/build.cmd` | 先 `cargo test` 再 `cargo build --release`；结束正在运行的旧 exe → 复制到 `dist/` → 启动新的 |
| `src/core/overlay/protocol.ts` | 插件端消息类型、`selectionKey` / `overlayStep`（何时弹出 / 收起）、`docToScreen`（选区 → 屏幕坐标） |
| `src/app/overlay.ts` | 插件端连接、重试；用 `onDispose` 保证开发版 ⟳ 时关掉旧连接 |
| `src/ui/app.ts` | `syncOverlay()`（在 `refresh()` 末尾调用）和 `onOverlay()`（收到生成 → 写入提示词和数量 → `generate()`） |
| `src/ps/host.ts` / `src/ps/uxpHost.ts` | 可选方法 `canvasView(docId)`，读 PS 的视图信息 |
| `tests/overlay_protocol.test.ts` | 弹出 / 收起规则、消息解析、坐标换算（用 11-04 实测数据） |

## 4. 协议

一个 WebSocket 文本帧 = 一个 JSON 对象。**两边的定义要一起改**：`protocol.rs` ⇄ `protocol.ts`，端口 `47821` 两处都写死了。

插件 → 小程序：

| 消息 | 含义 |
|---|---|
| `{"type":"hello"}` | 刚连上 |
| `{"type":"show","prompt":"…","count":1,"anchor":{left,top,right,bottom}}` | 有新选区。`anchor` 是选区在屏幕上的矩形（物理像素），可省略 |
| `{"type":"hide"}` | 选区没了 / 面板开始生成 / 当前模式不需要选区 |

小程序 → 插件：

| 消息 | 含义 |
|---|---|
| `{"type":"ready","version":"0.1.0"}` | 握手后立即发 |
| `{"type":"generate","prompt":"…","count":2}` | 按了生成或 Enter。插件端把数量限制在 1–4 |

**何时弹出**（插件端 `overlayStep`）：选区标识（文档 id + 边界）变化且不为空 → show；变为空 → hide；没变 → 不动。面板刚打开时第一次读到的选区**不弹**。只在局部重绘 / 融图 / 抠图 / 文生图模式弹，扩图、放大不弹；正在生成时不弹。

## 5. 定位：选区 → 屏幕坐标

PS 不直接给画布的屏幕位置。11-04 用 PS MCP 在用户的 PS 里实测，文档上有这些属性（batchPlay `get`，`_target: [{_property}, {_ref:"document", _id}]`）：

| 属性 | 实测值 | 含义 |
|---|---|---|
| `zoom` | `{_unit:"percentUnit", _value:1}` | **1 = 100%**（虽然单位叫 percent，值是倍数） |
| `center` | `horizontal 360.17、vertical 586`，单位 `distanceUnit` | 视图中心对应的文档点，单位是**点（1/72 英寸）**；× 分辨率 / 72 才是文档像素（这份 1080×1759 的文档换算后是 540, 879，即文档中心） |
| `resolution` | — | 文档 ppi，用于上一行换算 |
| `viewInfo.activeView.globalBounds` | `left 1008, top 139, right 3037, bottom 2087` | 画布视图在屏幕上的范围，看起来是**物理像素** |
| `viewTransform` | 报错 | 这个 PS 版本没有 |

换算（`docToScreen`）：

```
屏幕 x = (视图 left + right) / 2 + (文档 x − center.x) × zoom
屏幕 y = (视图 top + bottom) / 2 + (文档 y − center.y) × zoom
```

小程序收到 `anchor` 后：放在选区下方 `GAP_SELECTION = 14`（96 DPI 下，按显示器 DPI 缩放）、水平居中；下方放不下放上方，都放不下放进选区底部；最后保证不超出显示器工作区。

**回退**（插件读不到视图、或消息里没有 `anchor`）：
1. 低级鼠标钩子（`WH_MOUSE_LL`）记录的**最近一次在 PS 上的左键拖动**扫过的范围，2.5 秒内有效（框选、套索时就是选区范围）。
2. 再不行，放在鼠标右下方。

**还没核实的假设**：`globalBounds` 和 Windows 都是物理像素；视图中心就是 globalBounds 的中心（标尺、滚动条是否算在里面不确定）。如果位置整体偏移一个固定量，先怀疑后者；如果偏移随缩放变大，怀疑 `zoom` 或 `center` 的单位。日志 `overlay show` 一行里有 `sel`、`view`、`anchor`，拿它和截图对比。

## 6. 窗口行为（window.rs）

- **纯 Win32**：一个 `WS_POPUP` + `WS_EX_TOPMOST | WS_EX_TOOLWINDOW` 窗口；提示词和数量是无边框的 `EDIT`，「生成」「×」是 owner-draw 按钮。选纯 Win32 是为了中文输入法可靠。外观在 `WM_PAINT` / `WM_CTLCOLOREDIT` / `WM_DRAWITEM` 里自己画。
- **不抢焦点**：`SetWindowPos(..., SWP_NOACTIVATE)` 显示，PS 继续接收键盘；用户点进提示词框才激活窗口，激活时全选原有提示词。
- **Enter / Esc**：在消息循环里拦截 `WM_KEYDOWN`。输入法组字时 Enter 是 `VK_PROCESSKEY`，所以确认中文词不会误触发生成。
- **焦点还给 PS**：显示时记下前台窗口（PS），生成 / Esc / × 之后 `SetForegroundWindow` 还给它。
- **自动收起**：
  - 插件发 hide；
  - 在 PS 上按下鼠标左键（鼠标钩子里判断：不在生成条范围内、前台是 PS）——画下一个选区时旧的立刻消失；
  - 每 250 ms 检查前台窗口：既不是 PS 也不是本进程（输入法候选框属于本进程）就收起；
  - 插件断开连接。
- **拖动**：`WM_NCHITTEST` 把窗口自身空白处当作标题栏。
- **DPI**：进程设为 Per-Monitor V2；按鼠标或选区所在显示器的 DPI 重建字体、重排控件；处理 `WM_DPICHANGED`。Windows 11 上用 DWM 圆角。
- **颜色**取自插件 `plugin/styles.css` 的 token（`--c-bg` #323232、field #232323、line #5b5b5b、accent #3fb59f 等），布局常量在 `window.rs` 开头（96 DPI 下：提示词 220、数量 30、生成 56、× 20，内边距 8，控件高 24）。
- **单实例**：端口被占用就直接退出。
- **状态**：一个 `static mut STATE`，只在窗口线程访问；服务线程通过 `INBOX`（Mutex 队列）+ `PostMessageW(WM_APP+1)` 把命令交给窗口线程。

## 7. 已知问题和坑

- **build.cmd 复制失败曾被吞掉**：exe 正在运行时复制到 `dist/` 会失败，旧版脚本把错误重定向掉了，用户一直在跑旧版。现在脚本会先 `taskkill`。改 Rust 后让用户双击 `build.cmd`，再在 PS 里点 ⟳（插件端有改动时）。
- **编译在用户的 Windows 主机上**，写代码的机器是 Mac（没有 Rust）。用户编译时已经修过一处类型：`DwmSetWindowAttribute` 的属性参数在 windows-sys 0.59 里是 `u32`。改代码时 Win32 常量都写成数字（`window.rs` 开头）就是为了躲开 windows-sys 各版本的类型差异。
- **和 PS 自带的上下文任务栏位置重叠**，我们的在上层。用户说要完全和原版重叠，所以没有错开。
- `static mut` + `st()` 每次返回 `&'static mut`，在重入时（比如 `SetWindowPos` 触发 `WM_DPICHANGED`）严格说是别名 UB，实际可用。重构时可以换成 `Cell` 字段或把状态放到窗口的 `GWLP_USERDATA` 里。
- `keeps_bar` / `is_photoshop` 每次都 `OpenProcess` + 查进程名。250 ms 一次和按下鼠标时各一次，开销很小；如果加更多检查，可以缓存 PS 的进程 id。
- 没有托盘图标：只能在任务管理器里结束进程。
- UI 规范：[`docs/UI_DESIGN_SYSTEM.md`](../../docs/UI_DESIGN_SYSTEM.md)（字号最小 11px、控件高度 24 / 26、颜色只用 token）。生成条应该和面板保持同一套视觉。

## 8. 接下来可以做的（按建议顺序）

1. **核实按选区定位**（第 2 节）：日志里有 `overlay show`，并在不同缩放（50%、200%）、平移后、双显示器、Windows 缩放 150% / 200% 下各试一次。
2. **托盘图标**：退出、开机自启、显示连接状态。
3. **插件自动启动小程序**：manifest 已经声明了 `launchProcess`（`.exe`）；UXP 启动外部程序可能弹确认框，需要实测。启动失败要能退回「不运行也照常工作」。
4. **生成中状态**：现在按生成后就收起。可以考虑显示进度、完成后在原位置给出变体切换（像 PS 生成式填充那样的上一张 / 下一张）。这需要扩展协议：插件 → 小程序发进度和变体数。
5. **面板外的悬停提示**：用户最初的需求。插件发 `{"type":"tip","text":"…"}`，小程序在鼠标旁画一个不激活、鼠标可穿透（`WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`）的提示框。
6. **跨面板拖拽预览**：WaveLayer 拖到其他面板时，HTML 的跟随提示出不了源面板（见 `docs/WORKBENCH_DRAG_DEMO.md`）。可以由小程序画跟随鼠标的预览。
7. 协议加版本号和简单的握手校验（现在只监听 127.0.0.1，没有鉴权）。

## 9. 验证方法

- Rust：`cargo test`（`build.cmd` 会先跑）。`protocol.rs` 有解析 / 编码测试；窗口逻辑只能在 Windows 上手动测。
- 插件：`npx tsc --noEmit -p .`、`npm test`、`npm run build`。
- 实机：用户双击 `build.cmd`，在 PS 开发版面板点 ⟳，日志出现 `overlay connected` / `overlay ready`，画选区后看 `overlay show`。
- 不要改用户的正式 PSD；需要测试文档时用 `WavePlug_TEST_` 开头的文档。
