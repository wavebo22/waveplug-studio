# 文档索引

给接手 WavePlug Studio 的 AI（以及人）。按顺序读：

| 顺序 | 文档 | 讲什么 | 什么时候读 |
|---|---|---|---|
| 1 | [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | 项目全貌：版本和 git 状态、开发流程、架构、功能清单、待办、用户偏好、踩过的坑摘要 | 一定要读 |
| 2 | [`LAYER_PANEL_HANDOFF.md`](LAYER_PANEL_HANDOFF.md) | 「WavePlug 图层」面板：现在停在哪里、按确认程度分的功能、缩略图方案、悬停定位的 bug、和 PS 原版相比还缺什么 | 碰图层面板之前 |
| 2b | [`STABILITY_HANDOFF.md`](STABILITY_HANDOFF.md) | 11-03 稳定性 / 性能修复：已修的、Delete 键没解决的证据和下一步、核实过还没修的 | 接手时先读；碰网络、扩图、缩略图、Delete 键之前 |
| 2c | [`DELETE_AUDIT.md`](DELETE_AUDIT.md) | 图层删除全链路审计、源码修复及需实测的边界 | Delete / 垃圾桶 / 多选删除 |
| 2d | WAVELAYER_DRAG_PERFORMANCE.md | WaveLayer 拖拽优化研究、实测指标、乐观排序实验 | 修改图层拖拽之前 |
| 2e | [`UI_DESIGN_SYSTEM.md`](UI_DESIGN_SYSTEM.md) | UI 规范 v0 草案：token、组件规则、UXP 限制、现状审计、迁移步骤 | 写或改任何界面样式之前 |
| 2f | [`../native/overlay/HANDOFF.md`](../native/overlay/HANDOFF.md) | 外附介面（`native/overlay`，Rust 写的 Windows 小程序；目前是外置生成面板）：分层架构、协议、新增一个外附介面的步骤、PS 画布坐标、阶段进度 | 碰 `native/overlay` 或插件的 overlay 代码之前 |
| 3 | [`DEVELOPMENT.md`](DEVELOPMENT.md) | 构建、打包、用 UPIA 安装、开发版、日志位置、已确认的 UXP 行为 | 要打包、安装或排查环境时 |
| — | [`../README.md`](../README.md) | 面向用户的使用说明（1.0 时写的，部分功能没写进去） | 想知道用户看到什么时 |
| — | [`../CHANGELOG.md`](../CHANGELOG.md) | 已发布版本的改动 | 发版时 |
| — | [`history/`](history/) | 历史资料：V1.4 设计交接、0.1.x 实机测试交接。**已过时，只作参考** | 需要追溯最初的设计意图时 |

## 当前状态一览（2026-11-12）

- **11-13 WaveLayer：拖拽时自动滚动重做；新图层不再落进 AI 图层组（只改插件，已构建；PS 没实测）**：
  - **自动滚动**：原来只在列表上下各 22 px 的窄条里、每 90 ms 滚一行，很难触发。现在改为 `dragGeometry.edgeScrollRate`：
    - 距离上下边缘 36 px 内开始滚动，越往外越快：从每秒 4 行到每秒 30 行，超出边缘 36 px 时最快（拖拽区域本来就把列表上下各延伸 50 px）。
    - 每 30 ms 按小数行累计，滚动连续，不再一顿一顿。
  - **AI 图层被当成文件夹**：WaveLayer 选中 AI 图层时，PS 里选中的是 AI 组本身。这时新建、置入或粘贴的图层会被 PS 放进组里，组就不再「只有 vN 变体」，于是被当成普通文件夹。
    - 修复：每次读取图层树时，`tree.ts` 的 `aiStrayMoves` 找出这次新出现、直接位于 AI 组里、名字不是 vN 的图层，在一步历史记录「WavePlug 移出 AI 图层」里依次移到组的正上方，状态栏会提示。
    - 安全措施：真正移动前，host 在这一步里按当前名字再核对一次（`move(…, { onlyIf: isAiStray })`），所以正在写回的变体（先置入、再改名为 vN）不会被误移。
    - 原来就在组里的图层、刚打开的文档都不处理；撤销这一步后也不会再移回去。
  - tsc 通过，npm 253/253。
- **11-13 拖拽卡片改到箭头旁边，箭头照常显示（helper 0.10.1，源码；插件已构建；helper 需在 Windows 上 `build.cmd` 重建；PS 没实测）**：
  - 用户实测 0.9.1 的隐藏箭头有问题，而且不跟手，所以整套撤掉：
    - 不再在整个拖拽期间共享 Photoshop 的输入状态，恢复为只在系统拖拽（OLE）期间共享。
    - 去掉 `SetCursor(NULL)`。
    - GiveFeedback 恢复使用系统光标（箭头带 + / ⃠）。
  - 卡片不再盖在光标上，改放在箭头右下方（`card::origin`，1× 时偏移 18,22），落点和它下面的内容都能看见。
  - 靠近显示器工作区的右边或下边时，卡片翻到箭头左边或上方。工作区由 `GetMonitorInfoW` 取得，多显示器、任务栏都考虑在内。
  - `EXPECTED_HELPER_VERSION` 升到 0.10.1。tsc 通过，npm 248/248，cargo test 69/69，Windows 目标检查无警告。
- **11-13 拖进 Illustrator：像素嵌入，文字和形状可编辑，可用组合键切换（helper 0.10.0，源码；插件已构建；helper 需在 Windows 上 `build.cmd` 重建；PS / Illustrator 没实测）**：
  - 方案和限制见 [`CROSS_APP_DRAG_DROP_SPEC.md`](CROSS_APP_DRAG_DROP_SPEC.md) 第 16 节。
  - 松手在 Illustrator 上时，helper 取消系统拖放，改用 COM 脚本把合成 SVG 导入为嵌入内容：文字和形状可编辑，像素嵌入，相对位置不变，内容中心放在落点。
  - 松手时按住 Ctrl：全部作为嵌入图片；按住 Alt：普通拖放。
  - 片段生成在 `src/core/overlay/svgFragment.ts`，SVG 合成在 `native/overlay/src/drag/compose.rs`，导入在 `drag/illustrator.rs`。
  - `EXPECTED_HELPER_VERSION` 升到 0.10.0。tsc 通过，npm 248/248，cargo test 69/69，Windows 目标检查无警告。
- **（已被 0.10.1 取代：实测有问题且不跟手，已撤掉）11-13 图层拖拽时隐藏鼠标箭头（helper 0.9.1）**：
  - 拖拽开始时，helper 引擎线程就共享 Photoshop 的输入状态（`drag/win.rs` 的 `attach_input`），用 `SetCursor(NULL)` 隐藏箭头。隐藏发生在三处：开始时、鼠标钩子每次移动后、30 ms 的检查定时器里。
  - 系统拖拽（OLE）阶段，`GiveFeedback` 返回 `S_OK`，不再使用系统自带的「箭头 + / ⃠」。是否能放下由卡片文字说明，落点是卡片中心。
  - 结束时 `detach_input` 解除共享，再发一次 0 位移（`nudge`），让箭头立即恢复。这种隐藏不是持久的：即使 helper 崩溃，下一次 WM_SETCURSOR 也会让箭头回来。
  - 日志里的 `drag cursor hidden input_shared=…` 表示共享是否成功。如果 PS 内拖拽时箭头仍然闪现，说明 UXP 在每次移动时自己设置了光标，需要拿日志再看。
  - `EXPECTED_HELPER_VERSION` 升到 0.9.1。tsc 通过，npm 240/240，cargo test 62/62，Windows 目标检查无警告。

- **11-12 变体栏立即消失、生成面板常驻收起、出现 / 消失 / 展开 / 收起加动画（helper 0.9.0，源码；插件已构建；helper 需在 Windows 上 `build.cmd` 重建；PS 完全没实测）**：
  - 用户要求覆盖上一条的两点：① **变体栏**不再等 450 ms，选中的不是 AI 图层（或没选图层）就立刻消失（`variantsSurface.ts` 的 `HIDE_DELAY_MS = 0`）。代价：插件自己的命令中途读不到 AI 组的那一瞬间，栏会滑出再滑入——如果实测觉得闪，把延迟调回 150–200 ms 是折中。② **生成面板**不再因为没有选区而消失：只要有文档就一直在（`generateSurface.ts` 的 `wish`），没在用时本来就是收起的一条（`host.rs` 的 `collapsed`：鼠标不在上面、没有输入、没有任务时收起），只有「没有文档」才真正拿走。
  - **动画**（`native/overlay/src/anim.rs`，纯函数部分有测试）：
    - 生成面板出现：从下方 22 px 滑上来，150 ms；消失：向下滑 22 px（110 ms）后再移出屏幕。
    - 变体栏出现：从左侧 22 px 滑入；消失：向左滑出后移出屏幕。
    - 生成面板展开 / 收起（以及内容高度变化）：高度在 140 ms 内过渡（`host.rs` 的 `fit`），底边不动。
    - 都是 ease-out，只动位置和高度，**没有做透明度渐变**：窗口是 GPU 表面，改成分层窗口做 alpha 没法在看不到的情况下保证不黑屏。
    - 实现要点：每个窗口一个计数器（`LINKED_SLIDE` / `VARIANT_SLIDE`），新的滑动或立即停放会让正在进行的那次停下；滑入时每一步都重新读目标位置（`PLACED` / `VARIANT_GEOMETRY`），所以滑动途中高度适配或画布移动不会把窗口留在旧位置。停放（PS 切到后台）和恢复也走同一套滑动。
  - 已知不完美：收起时面板内容先消失、外框再缩（展开时是内容随外框露出）；变体栏自身的高度自适应没有加过渡，出现时高度跳动的问题仍在。
  - `EXPECTED_HELPER_VERSION` 升到 0.9.0。tsc 通过，npm 240/240，cargo test 62/62（Mac），Windows 目标检查无警告。

- **11-12 外置生成面板 / 变体栏的出现和隐藏重做（helper 0.8.1，源码；插件已构建；helper 需在 Windows 上 `build.cmd` 重建；PS 待实测）**：
  - 证据（`reports/overlay_runtime.log`）：① `hide` → 0.5 秒后 `show generate` → 0.3 秒后又 `hide`，面板闪一下；② `variants parked: foreground=other` 和 `variants restored` 在 250 ms 内来回；③ 变体栏每次出现都先以旧尺寸出现再 `autofit height` 跳几次。
  - **插件端：统一的显示规则**（`src/core/overlay/visibility.ts`，纯函数，测试 `tests/overlay_visibility.test.ts`）。两个介面都用它：需要时立刻出现；不需要时要**连续 450 ms** 都不需要才隐藏；没有文档立刻隐藏；换了文档 / 换了 AI 图层立刻重新摆放。原因：插件自己的命令（回写结果、恢复选区、重读 AI 组）中途 Photoshop 会短暂报告「没有选区 / 读不到 AI 图层」，以前每次都跟着隐藏再出现。
  - **生成进行中面板不再消失**：以前只看有没有选区，而生成过程本身会丢掉选区，进度和「取消」跟着面板一起没了。现在「有选区，或正在生成」都算需要。
  - **变体栏等待隐藏期间保留内容**：以前读不到 AI 图层的那一瞬间会先发一份空状态，把栏清空。
  - **helper 端（`win.rs`）**：① 前台窗口是 helper 自己的其他窗口（右键菜单、拖拽卡片、提示框、悬停边框）时，不再当成「用户切到了别的程序」——以前只认主面板和变体栏两个窗口，其余自家窗口一到前台就把面板停放；② 前台窗口为空（Windows 切换激活的瞬间）不改变状态；③ 停放前要连续 2 次检查（共 500 ms）Photoshop 都不在前台，生成面板和变体栏都一样。
  - **没做的**：这一轮只重做了出现 / 隐藏的逻辑，**面板的外观和布局没有重新设计**（我看不到实际窗口，需要用户说明要改成什么样）；变体栏出现时高度跳动（现象 ③）没修，它在 `variant_place` / autofit 里，要对着实机调。
  - `EXPECTED_HELPER_VERSION` 升到 0.8.1（旧 helper 仍可用，设置页会提示重建）。tsc 通过，npm 239/239，cargo test 59/59（Mac，`win.rs` 的测试只在 Windows 上跑），Windows 目标检查无警告。

- **11-12 日志系统补全，为多人实测准备（源码 + 已构建，浏览器预览已点通，PS 待实测）**：
  - **每个错误带原因和来龙去脉**（`src/app/log.ts`，无 UXP 依赖，测试 `tests/log.test.ts`）：warn / error 第一次出现时，日志行下面跟两行——`原因：`（`explain()` 按消息归类：PS 拒绝命令、PS 正忙、图层已不存在、切换了文档、连不上 ComfyUI、超时、helper 版本旧、用户取消、读像素失败、内存不足、目标位置不允许、权限、插件自身缺陷；认不出的写「未归类」）和 `之前的操作：`（最近 6 条操作足迹）。同一个问题再出现只记原始行并计数（数字和 id 不同也算同一个）。Error 对象现在记全：自带字段（Photoshop 的 `number`、ComfyUI 的 `detail`）、前 6 层堆栈、`cause` 链。
  - **操作足迹**（`crumb()`）：右键菜单行、图层命令、工具页按钮、生成、以及插件执行的每个 PS 命令（`uxpHost.modal` 的名称，缩略图和选择图层除外）。
  - **没人接住的错误也进日志**：`window` 的 `error` 和 `unhandledrejection`（`main.uxp.ts`），以前只到开发者控制台。
  - **PS 拒绝的命令**：`photoshop refused <命令> {message,result,target}`（上一条已加）。同时把 PS 的错误弹窗关掉了，根因见下一条。
  - **文件**：插件数据文件夹里 `waveplug.log`（全部）和新增的 `waveplug-errors.log`（只有警告和错误，短，方便直接看）；超过 4 MB 在启动时改名为 `*.prev.log` 重新开始（只留一代）。开发版另外镜像到 `reports/uxp_runtime.log` 和 `reports/uxp_errors.log`。每次启动写一行 `==== session start ====`。
  - **给测试者的入口**：设置（点右上角连接状态）› 排查问题 ›「导出诊断报告…」，存成一个 txt：环境（插件版本、构建时间、Photoshop 版本和语言、系统、UXP、外置框架版本）、每种问题一条（次数、首末时间、原因、之前的操作）、最近 40 条操作、最近 600 行日志。按钮上方显示本次运行记录到几种错误 / 警告。**报告里有图层名、文件名、提示词，不含图片**——发给外部测试者前要说明。
  - 还没做：helper（`overlay_runtime.log`）没有并进报告；日志里 `layer panel focus restore` 这类高频 info 行没有降噪；没有自动上传，报告靠测试者手动发。
  - **根因补记（上一轮没写进来）**：PS 弹「WavePlug Studio Dev: 命令…当前不可用」是因为 batchPlay 的 `dialogOptions: "dontDisplay"` 只隐藏命令自己的对话框，被拒绝时 PS 仍弹错误框；有后备方案的命令失败被代码吞掉，但框照弹。已在唯一入口 `uxpHost.ts` 的 `play()` 统一改成 `"silent"`（明确要对话框的 `"display"` 除外），失败照旧以错误结果返回、由插件状态栏报告。
  - tsc 通过，npm 236/236。

- **11-12 工具页重做 + 文档优化 + 批量重命名（源码 + 已构建，浏览器预览已点通，PS 待实测）**：
  - **去掉和右键菜单重复的**：整张「智能对象」卡片（断开链接、查找同源、转换、转为可编辑、解包、重置变换、替换 / 导出内容）不再出现在工具页，这些命令在 WavePlug 图层面板右键 › 智能对象 / 转换 里。工具页顶部有一行说明指过去。`LayerTools` 的这些方法没删，右键菜单在用。
  - **整理到右键菜单**（转换 ▶）：分别转换为智能对象（多选时）、按行拆分文字、裁剪边缘、拆分像素岛。后两个用工具页上次的参数（`pixelSettings()`）；像素岛超过 20 块时不在菜单里执行，提示去工具页确认。菜单行 id 是 `tool:*`，`LayerTree.runTool` 先选中图层再调 `LayerTools`。
  - **文档瘦身 → 文档优化**（`core/layers/slim.ts`，文件名没改）：先出报告（图层 / 组 / 智能对象数量、未压缩像素估算），项目分两组——「安全优化」（画面和可编辑性不变：AI 变体、画布外像素、空图层）默认勾选；「需要你决定」（超大智能对象、隐藏图层、不透明度 0、Alpha 通道）默认不勾，包括原来默认勾选的「缩小超大智能对象」。按钮显示已选项数和估算大小。新增：隐藏的**组**整体算一项（以前组里没单独隐藏的图层不算在内）、不透明度为 0 的图层（新种类 `transparent`）、图层过多 / 画布过大的建议。`scanDoc` 多读了 `parentId` 和 `opacity`（DOM 属性）；`transparent` 走和隐藏图层相同的删除分支。
  - **批量重命名**（新，`core/layers/batchRename.ts` + `LayerTools.renameLayers`）：查找 / 替换、前缀、后缀、末尾序号；先预览前 3 个再执行，一步撤销。PS 端用的是和单个重命名相同的 `set layer name` 描述符。
  - 过程中误覆盖过已有的 `core/layers/rename.ts`（行内重命名用的 `matchesInlineRenameRow`），已从 git HEAD 原样恢复，`git status` 确认无差异。
  - tsc 通过，npm 232/232。

- **11-12 右键菜单改为外置原生菜单（helper 0.8.0，源码；插件已构建；helper 必须在 Windows 上 `native\\overlay\\build.cmd` 重建；PS 完全没实测）**：
  - 用户要求参照 Blender 重新整理，并直接用外置框架显示。菜单现在是一棵树（`core/layers/contextMenu.ts`）：标题（图层名 · 类型；智能对象是「名 · PSB · 链接×N」）→ 智能对象 ▶（WavePlug 自己的工具放最前，原来左边那条图标栏取消了）→ 混合选项 / 重命名 / 复制 / 删除 → 新建组、合并 ▶、转换 ▶、排列 ▶（置顶 / 前移 / 后移 / 置底，新）、对齐 ▶、分布 ▶ → 蒙版 ▶、剪贴蒙版、图层样式 ▶ → 锁定、只显示、链接、图层颜色 ▶ → 选择 ▶、导出 ▶。快捷键写在右侧。上一条「两级菜单」的 `layerMenuGroups` 已删除，被这棵树取代。
  - helper 端 `native/overlay/src/menu.rs`：真正的 Win32 弹出菜单（`CreatePopupMenu` / `TrackPopupMenuEx`），在鼠标位置弹出，子菜单向侧面展开，屏幕边缘自动翻转，都是 Windows 自带行为。独立线程，**不抢 Photoshop 焦点**：属主窗口 no-activate、不设为前台；因此 Windows 不会自己在点别处时关菜单，用低级鼠标钩子（`WH_MOUSE_LL`）在菜单窗口（类名 `#32768`）之外按下任意键时 `EndMenu()`，点击照常传给被点的窗口。Esc 由插件发 `menu-close`（键盘在 PS 里）。深色菜单用 uxtheme 序号 135 / 136（未公开接口，取不到就是浅色）。日志 `menu <id>: N rows at x,y -> <选了什么>`。
  - 协议：`menu-open {menuId,title,items}`、`menu-close {menuId?}` → `menu-result {menuId,item|null}`。插件 `overlay.openMenu()`：helper 没连上或版本低于 `MENU_HELPER_VERSION`（0.8.0）时返回 null，面板改用自己的弹出菜单显示同一棵树（子菜单点开后替换显示）。`EXPECTED_HELPER_VERSION` 升到 0.8.0，旧 helper 会在设置页提示重建。
  - 清理：`popupMenu.ts` 的侧栏和 `clickPair`（双击断开链接）及其 CSS、测试删除——「断开共用」「选中同源」现在是菜单里的明确两行。
  - **实测先看这几件**：① 菜单是否出现在鼠标位置、PS 标题栏是否保持激活；② 点菜单外面能否关掉；③ 按住右键弹出后松开会不会误选第一行（第一行是不可点的标题，按理不会）；④ 外置生成面板会不会因此被隐藏；⑤ 是否深色。任何一项不对先读 `reports/overlay_runtime.log` 的 `menu` 行。
  - 验证：tsc 通过，npm 227/227，cargo test 59/59（Mac），`cargo check --target x86_64-pc-windows-gnu` 无警告。浏览器预览只能验证面板内的后备菜单（已点通）。

- **11-12 右键菜单改成两级（源码 + 已构建，预览已点通，PS 待实测）**：原来 35 行一长列，面板矮时下面看不见。现在第一级约 16 行：混合选项、重命名、复制、删除 | 从图层新建组、（取消编组）、剪贴蒙版、锁定、（只显示此图层）、（链接 / 取消链接）| 蒙版 ›、图层样式 ›、合并与转换 ›、智能对象 ›、导出 ›、对齐与分布 ›、选择 ›、图层颜色 ›。括号里的只在适用时出现（不再置灰占位）；带 › 的点开第二级，里面仍然置灰显示不适用的命令。分组在 `core/layers/tree.ts` 的 `layerMenuGroups`（`layerMenu` 仍是全部命令的来源，快捷键和测试都用它），测试保证没有命令丢失或重复。npm 229/229。

- **11-12 项目从 F: 迁到 G:\\waveplug\\studio**：`dev/loader.js` 的 ROOT、`main.uxp.ts` 的日志镜像 / debug 图片 / 开发版 helper 路径、文档里的路径都改成 G:。**已安装的开发版加载器里写死的还是 F:，必须重装一次**：关闭 PS，以管理员运行 `scripts\\install_dev.cmd`（加载器版本 1.4.0 → 1.4.1，`releases/WavePlug_Studio_DEV_1.4.1_local.ccx` 已打包）。`scripts/uninstall_legacy.*` 里的 F: 是历史脚本，没动。

- **11-12 WaveLayer 补齐原版图层面板命令（源码 + 已构建，浏览器预览已点通，PS 全部待实测）**：
  - 右键菜单新增：来自图层的画板…、向下合并 / 合并组、合并可见图层、拼合图像、栅格化图层样式、通过拷贝新建智能对象、嵌入链接的智能对象 / 转换为链接对象…、重新链接到文件…、快速导出为 PNG、复制 CSS、复制 SVG、对齐与分布…（6 种对齐 + 8 种分布）。
  - 底栏新增 ☰ 面板菜单：新建图层…（PS 对话框）、选择…、合并可见图层、拼合图像、删除隐藏的图层、删除空图层、锁定组内的所有图层、快捷键开关。
  - 快捷键（鼠标在面板上、没在输入时；`wp.layers.shortcuts`，☰ 里可关）：Ctrl+J 复制、Ctrl+G / Shift+Ctrl+G 编组 / 解组、Alt+Ctrl+G 剪贴蒙版、Ctrl+E 合并、Shift+Ctrl+E 合并可见、Ctrl+[ ] 前后移一层、Shift+Ctrl+[ ] 置顶 / 置底、Alt+[ ] 选上 / 下一个、Alt+Ctrl+A 全选、Ctrl+, 显示 / 隐藏、Ctrl+/ 锁定。Delete 仍然不拦截。每次触发记日志 `layer panel shortcut`。**没验证过 PS 会不会同时也执行自己的同名快捷键（那样会执行两次）——实测时先看这个，有问题就在 ☰ 里关掉。**
  - PS 层实现分三类（`src/ps/uxpLayers.ts`）：普通描述符（`actionDescs`：mergeVisible、flattenImage、rasterizeLayer what=layerStyle、placedLayerMakeCopy、placedLayerConvertToEmbedded、align / distribute + alignDistributeSelector）；带 PS 对话框的（`DIALOG_COMMANDS`，dialogOptions display：新建图层、转换为链接对象、重新链接、来自图层的画板）；只有菜单项的（`MENU_COMMANDS`：按标题扫一遍菜单建索引 `menuIndex`，日志 `layer menu command` 记候选 id；快速导出取离「复制 CSS」最近的那个，避开 文件 › 导出 里导出整个文档的同名项）。**这些描述符都是按 Adobe 的事件名写的，没有在 PS 里录制核对过**，失败会在状态栏报错并记 `layer command`。
  - 排序和对齐的判断在 `core/layers/tree.ts`（`arrangeTarget`、`neighbourRow`、`arrangeProblem`），测试 `tests/layer_arrange.test.ts`。排序复用拖拽的 `dropPlan` + `drop`。
  - 还没做：蒙版浓度 / 羽化、第 5 个锁（防止画板自动嵌套）、隔离图层、新建框架、属性面板联动、面板选项、2026 新调整图层、批量重命名。
  - tsc 通过，npm 228/228。

- **11-12 WaveLayer「选择…」命令（源码 + 已构建，浏览器预览已点通，PS 待实测）**：右键菜单末尾新增「选择…」，二级菜单 8 项：所有图层、反向选择、相似图层、相同颜色、链接的图层、同一组内、隐藏的图层、空图层；每项标出会选中几个，不适用时置灰并说明原因。只改选择（走原有 `tree.select`），不新增任何写 PSD 的描述符；选完后用现有的删除 / 编组 / 锁定等命令处理。逻辑在 `core/layers/selectSets.ts`，测试 `tests/layer_select_sets.test.ts`。同时清理：`lockPlan` 的过期测试（背景层解锁）、`app.ts` 里没有入口的 `deleteVariation` / `regenerate`。tsc 通过，npm 223/223，cargo 56/56。

- **11-12 跨软件拖拽易用性（helper 0.7.3，待 Windows 重建和实测）**：卡片写明目标程序（复制到 微信 / 文件夹…）；放下后在状态栏提示结果；多文件导出时显示进度；单个图层额外提供 PNG 和 DIBV5 图像数据，Office 等只认图片的软件也能放；针对微信偶发失败补了日志并加了 0 位移的模拟鼠标移动。cargo 56/56，npm 215/216（锁定用例）。详见 `CROSS_APP_DRAG_DROP_SPEC.md` 15.4。

- **11-12 跨软件拖拽：Alt+Tab、导出复用、缓存上限（helper 0.7.2，待 Windows 重建和实测）**：被 Windows 中断的系统拖拽（例如 Alt+Tab）在左键仍按着时自动继续；松手位置和判断写入日志；没改过的图层不再重复导出（按历史状态生成键，helper 存一份，会话目录用硬链接）；一次最多 20 个图层，缓存最多 1GB、保留 24 小时，每次拖拽后清理。npm 213/214（锁定用例），cargo 53/53。详见 `CROSS_APP_DRAG_DROP_SPEC.md` 15.3。

- **11-12 跨软件拖拽卡死修复（helper 0.7.1，待 Windows 重建和实测）**：0.7.0 拖进微信时 DoDragDrop 永不返回（helper 没拿到 Photoshop 里那次按键）。现在拖拽期间接上 Photoshop 的输入状态，松手以物理左键为准，并加了看门狗：松手 500ms 后发 Esc，3 秒后重启 helper。详见 `CROSS_APP_DRAG_DROP_SPEC.md` 15.2。

- **11-12 跨软件拖拽 P0–P2 插件端（源码 + 已构建，需 helper 0.7.0，待 PS 实测）**：WaveLayer 拖拽第一次离开面板（region 变 outside）且 overlay 已连接时，把选中的非组图层按列表顺序导出为 PNG（`layerImage` + `encodePng`，保留透明度）到临时目录 `waveplug_drag_<sessionId>_<order>.png`，路径用 `file.nativePath`；先发 `external-drag-prepare`，全部写完且仍在拖拽时发 `external-drag-ready`（只传路径，不传图片字节）。拖拽结束而 helper 未接管时发 `external-drag-cancel` 并删临时文件；收到 `external-drag-files-copied` 删临时文件；收到 `external-drag-finished` 结束拖拽、不做任何内部动作。列表内重排、子项拖拽（蒙版 / 效果等）不导出。状态机和判定在 `src/core/overlay/externalDrag.ts`（`tests/external_drag.test.ts`），`PsHost.exportLayerPng`、`EXPECTED_HELPER_VERSION` = 0.7.0。日志看 `external drag export … ms`、`external drag cancel`、`external drag finished`。tsc 通过，npm 209/210（仅已知「锁定」用例失败），build 通过。
- **11-12 跨软件拖拽 P0–P2 helper 端（helper 0.7.0，源码，待 Windows 重建和 PS 实测）**：拖拽引擎线程接入 OLE。插件导出的 PNG 先复制进 helper 缓存，光标进入其他软件的窗口时启动 DoDragDrop，以 CF_HDROP 提供文件。协议、卡片文字和松手规则见 `CROSS_APP_DRAG_DROP_SPEC.md` 15.1。cargo test 52/52，Windows 目标 check 无警告。插件端（导出与协议）另行实现。

- **11-12 拖拽卡片 / 外部落点重写为拖拽引擎（helper 0.6.0，需 Windows 重建并在 PS 实测）**：卡片和参考图槽位的判定移出 egui，交给独立线程（`native/overlay/src/drag/`）。卡片只在文字变化时绘制，鼠标移动由低级钩子直接移动窗口；悬停和松手由同一次命中测试决定。之前的 vsync / 限速补丁已撤掉。cargo test 40/40，Windows 目标 check 无警告；插件期望 helper 0.6.0。见 `CROSS_APP_DRAG_DROP_SPEC.md` 第 15 节。

- **11-12 拖拽卡片 20fps 卡顿（helper 0.5.2，需重建）**：日志显示 helper 拖拽时每 50 ms 才更新一次卡片（3 个窗口各等一次 vsync）。关闭 vsync，并在拖拽结束时记录卡片帧率（`drag card frames/fps/max_gap_ms`）；插件端 `perf` 证明插件处理每次移动 <1 ms。cargo test 30/30，Windows 目标 check 无警告。详见 `WAVELAYER_DRAG_PERFORMANCE.md`。

- **11-12 修复 build.cmd 偶发测试失败（ComfyUI 进程组同名冲突）**：`closing_managed_job_terminates_the_batch_and_its_children` 返回 258（WAIT_TIMEOUT）。原因是进程组名只用 pid + 毫秒，两个并行测试同一毫秒启动时，`CreateJobObjectW` 打开了对方的进程组，另一项测试清掉了「关闭即结束」标志。名称加入进程内序号，并拒绝已存在的同名进程组（ERROR_ALREADY_EXISTS）。接管时按保存的完整名称打开，旧名称仍兼容。Windows 目标 check 无警告；Windows 上的测试需要用 build.cmd 验证。

- **11-12 拖拽判定权移到 helper + helper 版本检查（源码，helper 需在 Windows 重建）**：外置参考图槽位上卡片仍显示「不能放在这里」，查证是 helper 没有重建（日志仍是 `start 0.5.0`，exe 是 11-07 的旧版本），新逻辑根本没运行。现在由 helper 仲裁卡片判定（`drag_target.rs`：原生目标 > 插件），判定变化会写入日志；helper 升到 0.5.1，插件发现 helper 版本旧于 `EXPECTED_HELPER_VERSION` 时记录警告并在设置页提示。规则见 `CROSS_APP_DRAG_DROP_SPEC.md` 第 15 节。tsc、build 通过，npm 201/202（锁定用例，旧问题），cargo test 29/29，Windows 目标 check 无警告。

- **11-12 WaveLayer 落点检测重写（源码 + 已构建，PS 待实机验收）**：日志证明 UXP 拖拽时事件 target 停在按下的行上，旧代码按「行中心 + 位移」估算导致落点偏差。新增 `core/layers/dragGeometry.ts`：用布局偏移校准 client→面板坐标（中位数、分轴、丢弃 0/0 合成事件），按布局矩形判定删除轨道 / 工具 / 工作台 / 列表（上下 50px 缓冲）/ 外部，移动和释放共用一套计算；文件夹分区恢复 25/50/25。tsc、build 通过；npm 200/201（失败项为 11-08 锁定用例，无关）。详见 `WAVELAYER_DRAG_PERFORMANCE.md`。
- **11-08 背景图层解锁修复（源码 + 已构建，待 PS 实机验收）**：背景层转换改用 Photoshop 原生 `layer.background` 属性引用，不再把 `background` 当作 ordinal；转换后读取新图层 ID 并映射恢复原选中状态。WaveLayer 行尾锁图标加入双击解锁，提示文案明确说明背景层会转换为普通图层；双击接入现有识别机制，不触发行拖拽或图层样式。`npm run typecheck`、`npm run build` 通过；按用户要求未运行测试、未启动 Photoshop。
- **11-08 WaveLayer 四周拖拽缓冲区（源码 + 已构建，待 PS 实机验收）**：图层列表四周增加 50px 透明放置缓冲区，仅拖拽期间显示；顶部映射到首个可见图层上方，底部映射到最后一个可见图层下方，左右改为列表内部可命中的 50px 带，避免外侧区域被 UXP 面板边界裁切；左侧避开 32px 删除轨道，右侧贴列表内缘，均按鼠标所在行计算。删除区、工具栏和编辑工作台保留优先级；拖拽控制器统一管理区域切换，避免边缘事件清除有效目标。TypeScript typecheck、UXP build、git diff --check 通过；未启动 Photoshop，待用户刷新开发版后实测。
- **11-08 WaveLayer 拖拽释放引擎重写（源码 + 已构建，Photoshop 待实机验收）**：新增 armed / dragging / released / cancelled 生命周期；通过 window/document 捕获阶段统一接收 pointerup / mouseup，释放阶段重新计算最终 listY 与 drop target，并用状态机防止双事件重复提交。目标区域改由真实事件 target + 工作台目标检测识别，删除 getBoundingClientRect 与 clientX/clientY 的列表释放门槛（UXP 两者坐标不可靠）。保留现有 Photoshop move/copy 算法、多选、Alt 复制、文件夹内外、蒙版/滤镜/效果/变体子行、左侧删除区、工具栏、工作台和外置参考图拖放。TypeScript typecheck、UXP build、git diff --check 通过；按用户要求未运行 npm test、未启动 Photoshop / ComfyUI，需用户刷新开发版后实测。详见 `WAVELAYER_DRAG_PERFORMANCE.md`。

- **11-07 外置面板画布磁吸 + 拖拽卡片视觉重做（已构建并热更新，待 PS 实机验收）**：折叠条提高至 12px（窗口总高 14px），描边改为清晰中性灰；拖动外置面板时按当前显示器 DPI 将 16 logical px 磁吸阈值换算为物理像素，靠近 Photoshop 画布四边时吸附，分别记录水平/垂直吸附边，重显与画布尺寸变化后仍保持贴边；自由拖动位置继续通过 OFFSET 保留。拖拽预览卡片改为单一圆角 surface、单描边、状态色短竖条、40×40 等比缩略图、13px 粗体标题（超长省略）及语义色状态胶囊；多选仅显示轻微错位的后置卡片，移除重复边框和顶部斜线，保持 232×68 logical px、中心锚点和 DPI 定位不变。新增四边磁吸、DPI 阈值和 free position 测试。Rust serial suite 46/46 通过，Release build 通过；helper 0.5.0 已热更新为 PID 16388，ComfyUI `/system_stats` HTTP 200；三个部署目录 EXE SHA-256 一致。待用户在 Photoshop 实测卡片外观与磁吸行为。
- **11-07 拖拽预览定尺 + 外置生图栏自动折叠 + 侧边删除区恢复（已构建并部署，待 PS 实机验收）**：拖拽卡片统一 232×68 逻辑尺寸，和 Win32 DPI 定位共用尺寸常量；缩略图源边长最多 2048，解码后缩至 96×96 以内，42×42 容器内按原比例 contain，防止极端长宽比/高分辨率图层撑大或拉伸预览。外置生图栏默认收起为 12px 黑色细条（窗口总高 14px），带清晰中性描边，鼠标悬停展开；拖拽预览活动时，鼠标进入折叠条上方 72 个逻辑像素的 DPI 感知热区也会展开。离开后自动收起；生成运行、输入焦点、收藏/高级/参考菜单打开或提示词防抖期间保持展开。首次显示直接以折叠高度创建，不闪现整块面板。侧边删除区改为所有拖拽时都可见；不可删除对象显示灰色禁用态，并清除旧排序目标，避免释放时误重排；真正删除判定、撤销与底部工具栏垃圾桶不变。TypeScript typecheck、npm tests、UXP build 通过；Rust 44/44、Release build 通过；`git diff --check` 通过。helper 0.5.0 已热更新并重新连接（PID 30408）；ComfyUI 原进程 PID 2872 保持运行，`/system_stats` HTTP 200。UXP 开发版 bundle 已构建，需用户点击顶部 ⟳ 后验收；本轮未自动操作 Photoshop。
- **11-07 WaveLayer 拖拽卡片去黑色背框 + 中心定位（已构建并热更新，Photoshop 待实机验收）**：去掉拖拽 viewport 的 `with_transparent(true)`，改为不透明无边框窗口，仍在 HWND 上设置 `WS_EX_LAYERED | WS_EX_TRANSPARENT` 与 alpha=255 保持鼠标穿透；背景先绘制，主卡片和多图层叠片按层级覆盖，避免透明窗口黑色背框。定位统一为鼠标对应 232×68 逻辑卡片的中心，Win32 按鼠标所在显示器 DPI 计算物理窗口左上角，只移动不重设尺寸。删除 UXP 抓取点采集和 `anchorX/anchorY` 协议字段；旧 UXP 消息的额外字段仍由 Serde 忽略。多图层摆动、动作颜色、缩略图与文字布局不变。TypeScript typecheck、npm tests、UXP build 通过；Rust 41/41、Release build 通过。helper 已热更新为 PID 31608，ComfyUI 原进程 PID 2872 保持运行，`/system_stats` HTTP 200。需用户点击开发版顶部 ⟳ 加载 UXP 新版后实测；本轮未自动操作 Photoshop。
- **11-07 ComfyUI 冷启动状态与图层拖拽跟手性修复（已构建并热更新，UXP 待手动刷新）**：ComfyUI 连接问题是 UXP 在 helper/ComfyUI 冷启动期间提前探测失败，后续连接成功却留下旧错误状态。开发版现有 managed cold-start 时等待 native manager 的 starting/ready 事件，不提前探测；连接检查加序号，过期结果不能覆盖新结果；成功时只清除本次精确匹配的旧连接错误。拖拽预览原本用弹簧追赶鼠标（x/y stiffness 95、damping 17），现改为 HWND 直接定位到当前 `GetCursorPos`，同步 `SetWindowPos`，仅旋转/堆叠视觉使用小幅阻尼弹簧；拖拽期间 8ms repaint。新增 2 个 Rust 测试：锚点始终等于鼠标、停止后倾斜回中。TypeScript typecheck 通过、npm 190/190、UXP build 通过；Rust serial suite 40/40、Release build 通过；helper 已热更新为 0.5.0，ComfyUI 进程 PID 30748 交接后未重启，`/system_stats` HTTP 200。需用户点击开发版顶部 ⟳ 加载最新 UXP 连接状态修复，再实测拖拽晃动。
- **11-07 开发环境单版本整理**：通过 Adobe UPIA 卸载正式版 `WavePlug Studio 0.2.3`，复查 `/list all` 仅剩 `WavePlug Studio Dev 1.4.0` Enabled；开发版 loader 仍从 `G:\\waveplug\\studio\\dist\\plugin` 加载最新代码。为开发版加入一次性生命周期设置迁移：自动启动外置框架、自动启动 ComfyUI、Photoshop 退出时关闭 WavePlug 管理的 ComfyUI、启动时不打开网页、关闭调试文件自动保存；迁移完成后设置仍可由用户修改，不会每次加载强制覆盖。UXP 类型检查与 190 项测试通过、构建通过；Rust 38 项测试首轮 1 项 Windows 进程结束状态测试偶发失败，单项重跑通过；Release 构建成功，EXE 已同步到 dist / plugin / dev，SHA-256 一致。Photoshop 现场加载和关闭联动待用户启动后验收。
- **11-07 内置生图页整理（源码 + 已构建，Photoshop 待现场验收）**：移除内置生图页的变体缩略图卡片，保留独立 native 变体栏的数据同步、缩略图和切换；数量行统一为外置面板的重置按钮 + 34px 整数框 / 主按钮，滚轮每格增减，范围 1～4。提示词字号与数量行高度统一；顶部工作流栏、生成/工具切换及六模式工具栏未改。TypeScript 类型检查通过，npm 190/190，`npm run build` 完成，`git diff --check` 通过。未操作 Photoshop，需用户现场验收。
- **11-06 WaveLayer 重命名交互整体重做 + 全局输入框透明底（源码 + 已打包，PS 交互由用户验收）**：重命名采用 input 原位替换名称 span，取消绝对定位；保护虚拟行并处理滚动/筛选/切换文档。重命名双击阈值 400ms / 4px。全局文字/数字/搜索 input 与 textarea 在 DOM 创建时直接设置透明背景、无背景图/阴影，同时以简单类型选择器覆盖 CSS；不影响复选框和滑杆。用户反馈上一版 CSS 透明底无变化，因此新增 DOM inline style 作为强制覆盖。TypeScript 类型检查通过，npm 189/189，最新 `npm run build` 完成，`plugin/styles.css` 与 `dist/plugin/styles.css` SHA-256 一致。按用户要求未再操作 Photoshop；未提交 Git。
- **11-06 WaveLayer QA 问题修复（源码 + 已打包，PS 待实测）**：针对 `reports/WAVELAYER_*_2026-11-06.md`。① 整组 Alt 复制落点修不回来时（QA-WL-01，四个散落子层），`copy()` 不再 `clone.delete()`，改为抛错让整个历史步骤回滚，文档不留任何改动；多项复制中任一项失败则整批撤销。② `read()` 在有文档但 `activeDocument` 暂为空时抛错而不是返回「无文档」；`refresh()` 读取失败时保留旧列表并按 0.25→4 s 退避重试，不再显示「未打开文档」（QA-WL-02）。删除 / 乐观移动期间被跳过的刷新在结束后补一次。③ 缩略图缓存只保留最近 4 个文档。④ 实测（11-06 08:02）回滚生效但 A1 仍失败：组副本落在 G_Hidden（普通层）上方，AM 索引探测 ±4 够不到（组本身占多个槽位）。`repairLayerPlacement` 在目标是普通层时先用 DOM `move(rel, before/after)` 修正，再走索引探测；加了专项测试，A1 待复测。⑤ 复测（08:14）普通拖动也失败：组紧挨在 G_Hidden 上方时 `move(G_Hidden, PLACEAFTER)` 不报错也不移动。现在改为移动那个普通层到组的另一侧（`bringToFront` / `sendToBack`，或相对组外侧的普通兄弟层），绝不相对组本身放置；移动和 Alt 复制都走这条，加了专项测试，待复测。⑥ 仍失败；用户定位：落在行**下半部**（放到该层之后）必失败，落到下一行上半部（放到下一层之前）正常。日志 08:19 目标不相邻时组也跑到第 0 位，说明组 PLACEAFTER 普通层会被放到父级顶部。`safeLayerAnchor` 改为永不用 PLACEAFTER：之后 = 下一个兄弟层之前；没有下一个则放到该层之前再置底。待复测。`ThumbCache.clear()` 不清 versions 是有意的（行重绘靠版本递增），不改。tsc 通过，npm 181/181（复制回滚加了断言），`npm run build` 完成。未提交 Git。
- **11-06 外置框架和 ComfyUI 随 PS 启动 / 关闭重做（源码，PS 待实测）**：之前失效是因为开发版启动的 `waveplug-overlay-dev.cmd` 已被删除且失败无提示。现在直接启动 exe（不显示终端），设置页新增「启动与关闭」（开关 + 启动 / 重启按钮），exe 原地替换后 helper 自动重启成新版且不关闭 ComfyUI。tsc、npm 181/181、Rust Windows 目标检查无警告、Rust 20/20。详见 [`../native/overlay/HANDOFF.md`](../native/overlay/HANDOFF.md) 第 3.1 节。**需在 Windows 上运行新的 `build.cmd`**；第一次仍要手动关掉旧 0.4.0（它没有自动更新功能）。未提交 Git。
- **11-06 WaveLayer 悬停边框（用户已在 PS 确认，效果与 PS 原版一致）**：替换旧的「悬停定位」。鼠标停在图层行上，外置 helper 在画布上画出该图层范围的细蓝框（点击穿透、不激活、不读像素、不选中图层）。tsc 通过，npm 181/181，Mac 上 `cargo check --target x86_64-pc-windows-gnu` 通过、`cargo test` 19/19（Windows 专属测试需在主机上跑）；UXP `npm run build` 完成。详见 [`LAYER_PANEL_HANDOFF.md`](LAYER_PANEL_HANDOFF.md) 第 5 节。
- **11-04 WaveLayer 图标换成 PS 式实心单色（PS 实测确认，用户反馈看得懂）**：按用户提供的 PS 原版图层面板截图重画 26 个图标（`dom.ts` 的 `PS_GLYPHS`，实心、even-odd 单路径）：底栏链接改横向链条，蒙版链接改竖向链条（`psChainV`），智能对象改折角纸，剪贴箭头改向下，锁定透明像素改棋盘格（`psChecker`）。图层类型（组 / 文字 / 调整 / 形状）和状态图标（可编辑、独立、链接）去掉彩色，统一 `--c-text-2`；不可编辑、AI、共用分组色保留。未提交 Git。
- **11-05 外置生成面板 / WaveLayer 参考图拖放（已部署，等待 Photoshop 现场验证）**：新增从 WaveLayer 普通图层行直接拖到外置生图面板参考图槽位；目标槽位悬停高亮，松开后替换该槽位，UXP 保存源图层 ID，生成时读取原图层像素。跨窗口 mouse-up / Escape 会回传完成动作，清理 WaveLayer 源拖动态。组、AI 结果组和子项拖拽不触发此功能，不改变原有图层排序 / Alt 复制 / 工作台 / 删除区。Rust 34 项、TypeScript 172 项测试通过，类型检查、UXP 构建和 Rust Release 构建通过。最终 helper 已同步到 dist、plugin、dev 三个入口，ComfyUI 已重新启动且 HTTP 8188 正常。**还需在 Photoshop 开发版点橙色 ⟳ 载入最新 UXP bundle，并在测试 PSD 上实测拖放**。详见 [`../native/overlay/HANDOFF.md`](../native/overlay/HANDOFF.md)。
- **11-04 WaveLayer 顶部重排（PS 实测确认）**：按用户确认的效果图改为 PS 式三行——搜索 + 展开/折叠 + 漏斗/竖向筛选开关；混合模式 + 不透明度；锁定 + 填充（两个百分比框右对齐成一列）。缩略图按钮移到标题行，选中图层信息改为悬停提示。窄面板自动换行。详见 [`UI_DESIGN_SYSTEM.md`](UI_DESIGN_SYSTEM.md) 第 7 节。未提交 Git。
- **11-04 WaveLayer 双击 PNG 智能对象先转 PSB 再打开（已构建，Photoshop 待实测）**：双击智能对象缩略图或智能对象标识、以及右键「编辑智能对象内容」均复用统一编辑入口。实时读取目标图层 smartObject.fileReference；仅 PNG（大小写不敏感）会先选中所点的**唯一**图层，执行已有的「转为可编辑」工具并确认成功、取得新 PSB 图层 ID 后才使用 placedLayerEditContents 打开；转换失败或结果 ID 异常则报明确错误，不打开原 PNG。PSB/PSD 及其他格式仍直接打开。新增 5 项纯流程测试 + 1 项 UXP 模拟调用顺序与错误处理测试；未在用户 PSD 实测、未提交 Git。

- **11-04 WaveLayer 智能对象右键极简状态/操作栏（已构建，PS 待验证）**：仍为左侧快捷区、右侧普通图层菜单；左侧压缩为两枚单行状态标签（仅 PNG/PSB 等内容格式，以及 链接×N/独立/外链），下方四项非重复操作（替换/导出/解包/重置）改为从上到下单列排列，根据实机截图再次收紧为 44px 侧栏（状态标签与图标按钮统一为 30px，侧栏右侧仅 1px 内边距），右侧普通菜单左内边距缩至 2px；运行时侧栏宽度限制在 40–44px，普通菜单总宽也缩至最多 292px；右侧普通图层菜单保持并排，去掉大标题、状态字段名、固定说明行。状态颜色直接复用 WaveLayer 图层标签现有 lt-tag 属性配色：可编辑 PSB 绿色、PNG 等不可编辑珊瑚色、共享琥珀色、独立青绿色、外链蓝色。保留类型单击转 PSB、共享单击选同源/快速双击断开共享及锁定/多选保护，四个图标重绘为与对话示意一致的 Lucide 风格刷新、下载、图层、逆时针旋转线性图标；链接状态兼容 UXP dblclick 与两次 click 两种事件序列，避免重复断开，执行所有智能对象工具前先按 WaveLayer 实际目标图层 ID 同步 Photoshop 选中状态。图标悬停可看名称/提示。现有未提交开发改动和 PSD 保留，尚未 Git 提交。


- **11-04 WaveLayer 组间拖动性能优化（已构建，实机速度待复测）**：真实日志反复出现 AI 组外放置需要 5 次 AM 试探（约 2 秒）。组下方紧挨另一个组时优先使用已在用户 Photoshop 日志中验证成功的 nextGroup.itemIndex - 1；记录同一两个组间隙实际成功的索引偏移，后续最多一次索引读取 + 一次移动指令，特殊文档仍回退完整校验算法。取消拖拽完成后重复的完整图层列表刷新，改由宿主模态结束通知统一刷新；200 多图层时每次列表重读约 330ms。保留移动/Alt 复制、AI 组不接受其它图层、撤销和位置校验。专项测试对常见错误落点明确限制调用次数。真实 Photoshop 加速幅度待使用 WavePlug_TEST_ PSD 复测，未提交 Git。



- **11-04 WaveLayer 组间正常拖拽（本轮修正，实机待验证）**：实际操作日志显示移动图层 161 到 AI 组 144 **下方**时，被 Photoshop 误放入相邻组 150（预期父组 157），使上一版的「检测到错位则报错取消」反复触发。已补充 Photoshop Action Manager 的 itemIndex / move-to-index 组边界修复路径：先按原生 DOM 移动/复制，如果父组或位置不对，读取真实图层索引（计入隐藏的 sectionEnd 标记与背景索引偏移），自动尝试定位并逐次验证，成功后作为正常移动，不再提示错误。原生 DOM 直接拒绝操作时，也尝试通过 AM 定位。对普通移动和 Alt 复制统一生效，AI 结果组及其全部变体保持原样；单次 Photoshop 历史步骤。新增模拟两个相邻组、原生错误插组/原生抛错、嵌套组/组底的专项回归测试。正式 PSD 未修改，需在 WavePlug_TEST_ 测试文档实机验证，未提交 Git。


- **11-04 WaveLayer 复制/移动图层误入 AI 组边界修复（源码与自动测试通过，PS 待实测）**：放置到 AI 图层或任意普通图层组**下方**时，不再直接以目标组使用 PLACEAFTER（部分场景会意外进入组内）；优先以该组的**下一个同级图层为锚点、在其上方插入**。若目标组已是同级最后一项，先放到组上方、再在正确父组内置底。对普通移动与 Alt 拖动复制均逐项读取 Photoshop 实际嵌套父级和顺序验证；异常副本自动删除，异常移动回滚整个历史步骤。专项模拟测试覆盖相邻同级、组底部、普通组内嵌套 AI 组、AI 组自身复制以及模拟 Photoshop 错误放置行为。尚未在 Photoshop 实测，未提交 Git。


- **11-04 WaveLayer Alt 拖动复制（已构建，Photoshop 待验证）**：普通拖动仍是移动；Alt+拖动单层、多选、普通组或 AI 变体组时复制，放开 Alt 立即切回移动。复制结果以黄色插入线和鼠标旁「+ 复制」区分，非法目标不执行。多选按文档从上到下顺序写入，同组/空组/背景边界受保护，整组使用原生 Layer.duplicate 保留子图层、蒙版及智能对象共享关系；新副本自动选中，复制在一个 Photoshop 历史记录中可撤销。拖动到新建图层按钮仍复制，拖到工作台仍只添加引用，拖到左侧红区/垃圾桶仍删除。已补 copyPlan 和模拟 UXP 复制专项测试；仅修改源码与构建，不实测用户 PSD、不提交 Git。


- **11-04 WaveLayer→变体栏选中联动及生成后自动选中（已构建，PS 待验证）**：生图 Host 同时订阅 WaveLayer 的内部选层模态命令，兼容 Photoshop 原版图层面板通知；刷新只响应选层/切换变体等命令，不响应读取蒙版和缩略图，避免递归。生成一轮结束后（包括多变体和抠图后续移除）选中实际生成的外层 AI 结果组，WaveLayer 高亮该行，而不是组内 vN 子图层；生成中切换到其他文档则不强行抢回。变体缩略图加载改为跟随当前组，避免快速切换时卡在旧组。新增选层联动与通知清理专项测试。类型检查、自动化测试、构建通过；尚未在 Photoshop 实机复测，也未提交 Git。

- **11-04 生图数量输入修复（已构建，PS 待验证）**：生成数量从原生下拉框改为 1～4 的数字输入框；即时保存有效输入，失焦时纠正越界值；面板刷新时不覆盖正在输入的数字，切换工作流时不串写设置。类型检查、114 项测试、构建通过；此轮未提交。

- **11-04 生图蒙版/变体栏联动（已构建，PS 待验证）**：变体栏移除结果组下拉框，跟随当前 Photoshop 选中的 AI 图层/组及其可见变体；对局部重绘、融图和抠图，选择相同位置与完整蒙版才继续添加变体，蒙版不一致则新建 AI 结果组。无选区时选中原 AI 图层仍可沿用旧蒙版；「再生成」无视当前选区，明确沿用目标蒙版。文生图有选区时也检查其蒙版是否与目标结果组一致；扩图仍按扩展尺寸区分。新增逐像素蒙版判定测试；类型检查、测试和构建通过。此轮未提交，也未在 Photoshop 实测。


- **最新：整块画板删除卡顿 / 命令不可用的专项处理（PS 待验证）**：日志确认画板 ID 398 曾因删除命令不可用失败，也有成功删除耗时约 34–41 秒的记录。现在删除前先找画板内部完全锁定的图层组并快速提示；实际执行大画板删除时持续显示进度，并使用 Photoshop 原生进度与取消入口，新增执行耗时日志。画板的 Photoshop 内核耗时不能保证减少。详见 [`DELETE_AUDIT.md`](DELETE_AUDIT.md)。

- **此前：蒙版拖拽移动 / Alt 复制已编码（PS 待验证）**：图层蒙版、矢量蒙版、智能滤镜蒙版可拖到其他没有同类蒙版的有效图层，正常拖动为移动，Alt 拖动为复制。复用样式图标的目标行高亮；原有左侧红区、底栏垃圾桶仍可删除。UXP 先复制校验、再按需删除源，合并一个撤销步骤。新增描述符和目标判断单测。详见 [`DELETE_AUDIT.md`](DELETE_AUDIT.md)。

- **此前：左侧拖拽删除区已编码（PS 待验证）**：基线先提交为 `8ce523f`。可删除图层、组、蒙版、智能滤镜、效果、变体在拖动时显示列表左侧 32px 红区；在区内松开立即删除，离开取消；底部垃圾桶保留点击和拖动。WaveLayer 不再监听 Delete/Backspace。源码修改暂未第二次提交；详见 [`DELETE_AUDIT.md`](DELETE_AUDIT.md)。


- 11-04 WaveLayer 删除链路及快捷键补修：统一删除入口、逐项失败隔离、回读真实删除/选中结果、跨文档保护；快捷键改为捕获阶段监听，延迟恢复焦点，并排队一次明确的快速二次按键。`npm run typecheck`、102 项测试和 build 通过。**快捷键问题仍待 Photoshop 实机复测**。见 [`DELETE_AUDIT.md`](DELETE_AUDIT.md)。


- 11-03 稳定性及图层交互：Delete 删除后自动选中下一存活图层；**新增单击图层列表空白处清空选择**（WavePlug 与 Photoshop 同步，支持取消多选，拖拽/工具栏/滚动条不触发）。源码已更新并重建 `dist/`，**未提交**；`npm run typecheck` 通过，`npm test` 101 项通过。Delete 用户反馈基本正常；空白取消选择已处理唯一背景图层限制；不透明度 / 填充已改为原版式百分比框与下拉滑块。**最近一次顶部重排及三个筛选图标 Tooltip 修改因用户反馈已撤回，现恢复到重排前的代码；此前百分比框改动仍需在 PS 实测。**见 [`STABILITY_HANDOFF.md`](STABILITY_HANDOFF.md)。

以下是 11-02 的状态：


- 分支 `local-test`。最后一个正式版是 1.1.0；`5e21588` 已提交但没发布；**整个图层面板都没提交**。只在用户要求时提交。
- `npx tsc --noEmit -p .` 没有报错，`npm test` 88 个全过。
- `dist/` 是 11-02 13:27 打包的。之后又有一批图层面板改动只改了源码，没打包、没测（`LAYER_PANEL_HANDOFF.md` 第 3.3 节）。
- 图层面板的「悬停定位」会把 PS 卡死，而且默认开着。等用户选定重做方案（`LAYER_PANEL_HANDOFF.md` 第 5 节）。
- 用户在 11-02 要求**暂停修改**。接手后先问用户下一步做什么。

## 和用户协作

- 回复用中文；说清楚做了什么、什么还没验证。
- 用户额度很紧张：PS 里的问题**先看 `reports/uxp_runtime.log`**，拿到证据再改，不要盲试。
- 用户在 Windows 的 PS 里测试，开发环境是挂载了同一个目录的 Mac。用户在开发版面板点 ⟳ 加载新的打包结果。
- 可能有多个 AI 会话同时改这个项目。动手前看一下文件的修改时间。

## 维护这些文档

- 状态变了就更新上面的「当前状态一览」，以及对应文档里的「停在哪里」那一节。
- 功能的确认程度分三档写清楚：用户已在 PS 里确认 / 已打包未确认 / 只改了源码。
- 新踩的 UXP 坑记到 `LAYER_PANEL_HANDOFF.md` 第 6 节或 `DEVELOPMENT.md`，并在 `PROJECT_STATUS.md` 第 9 节留一行摘要。
