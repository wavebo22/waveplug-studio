# WaveLayer 拖拽性能研究与优化

基线提交：269bf04（local-test，2026-11-04）。本轮优化是基线之后的实验修改，尚未再次提交。

## 现有瓶颈（来自真实运行日志）

1. Photoshop AI 组边界：日志中的 layer group-boundary recovered 曾记录 attempts: 5 才找到相邻组正确位置；操作期间宿主处于模态状态。已有 itemIndex - 1 优先尝试和间隙偏移缓存能减少调用次数，但不能消除宿主执行耗时。
2. 全树读取：206 层文档的一次 layer tree read 约 330–345 ms。以前必须等待 Photoshop 移动完成及这次读取后，WaveLayer 才能显示新顺序。
3. 拖拽 UI 热路径：旧 drawGhost 每次 mousemove 重新生成提示 DOM、同步读取宽高/面板布局；trackDrop 在同一目标区域反复计算计划。

## 首轮优化

- 本地乐观排序：previewMoveTree 只更新 WaveLayer 的本地树，保留 AI 结果组内部变体的原子性、多选及跨组。鼠标松开后立即呈现预期顺序。
- Photoshop 真实结果优先：宿主 executeAsModal 提交后由通知重新读取真实树。移动期间阻止过时的树读取覆盖预览，错误或部分执行失败则刷新恢复。
- 提示减负：仅在内容改变时重建 DOM 和读取尺寸；缓存面板几何。避免未经验证的 3D transform，保持已知可用的绝对定位。
- 计划缓存：拖拽源和树未改变，且悬停位置、区域及 Alt 未改变时，复用 dropPlan/copyPlan 的结果。
- 诊断日志：每次拖拽记录 layer drag performance：visualMs、本地渲染；nativeMs，Photoshop 操作；totalMs，整个调用耗时。

这改善的是视觉反馈，不保证 Photoshop 文档操作本身的执行耗时缩短；宿主失败时面板按真实结果恢复。
Alt 复制因为副本图层 ID 必须由 Photoshop 创建才能获知，本轮没有使用虚拟副本占位。

## 基准与限制

Node/Windows 纯算法测试：207 层、2000 次 previewMoveTree，平均 0.0284 ms，p95 0.0479 ms，最高 0.2693 ms。
注意：此数据不包含 Photoshop UXP DOM 渲染或内部图层操作，不能用于推断真实 UI 帧率。
专项测试覆盖 AI 整组、普通组嵌套、多选、非法计划及源树不变；未操作任何用户 PSD。
Adobe UXP 不是 Chromium 浏览器，部分 CSS transform/动画能力不完整；本轮没有更改插件 manifest 的 CSSNextSupport。
根据 Adobe 文档，Photoshop 文档改动仍需要模态执行，无法保证原生图层栏一样的底层时延。

## 下一步实测及架构研究

1. 使用 WavePlug_TEST_ 测试 PSD 进行 10 次相邻 AI 组拖动，读取 layer drag performance 中的 visualMs / nativeMs / totalMs 及 layer tree read；复核 Alt 复制、跨组、多选和末尾落点。
2. 如果出现预览回跳，给宿主事件与本地渲染增加版本序号，仅对齐有差异的层级，不要立刻整体刷新。
3. 如果鼠标移动阶段掉帧，针对 trackDrop、虚拟行 draw、缩略图队列和 hit 事件做实际 UXP Profile，避免把 Node 纯算法时间当成 UI 性能。
4. 如果 nativeMs 是主瓶颈，研究可靠的单次 Action Manager 索引移动及 group-end 边界定位；先验证再考虑移除 DOM 首次尝试与补救回退。
5. 长期可研究轻量增量图层同步，减少全量 multiGet；需要覆盖 Undo/Redo、来自其他插件的编辑和选区变化，避免 UI 与真实 PSD 不一致。

## 2026-11-08 拖拽释放引擎重写（源码 + 已构建，Photoshop 待实机验收）

用户反馈指示线显示正确但释放后经常不移动，且需要把鼠标精确放在图层上方才有机会成功。最近日志中有 drag probe，但没有 destination / move result，说明部分手势没有进入提交阶段。

### 旧链路问题

- 依赖 document 冒泡 mousemove / mouseup；子控件或 UXP 宿主控件可能先截断事件。
- 释放阶段用 getBoundingClientRect 与 clientX/clientY 判断是否在面板/列表内。项目已确认 UXP 中这两套坐标不可靠，因此会出现指示线正确但释放被判定为列表外。
- 释放位置沿用上一次 mousemove 的 correction，未在 hit overlay 命中时用 mouseup 自身的 offsetY 再校正。
- pointerup 与 mouseup 没有统一的一次性提交状态。

### 新链路

- 纯逻辑状态机：armed → dragging → released；取消路径为 cancelled。pointerup / mouseup 共用一个 release handler，状态机保证一次拖拽只提交一次。
- window / document 捕获阶段监听 mousemove、pointerup、mouseup，避免子行、chip 或宿主控件阻断。
- 拖拽区域由真实 event.target 判定为 list / delete / tool / workbench / panel / outside；工作台仍使用自身 drop-target 检查。普通列表释放不再经过 getBoundingClientRect 门槛。
- list hit overlay 是 list-local Y 的权威来源。mousemove 与 pointerup / mouseup 使用同一套 offsetY 校正；释放时重新 track()，使指示线与最终提交共用同一个目标计算结果。
- 最终 Alt 状态以释放事件为准；释放日志区分 captured、有效目标、无目标、plan rejected，便于判断问题停在事件、目标计算还是 Photoshop 执行阶段。
- Photoshop 的 tree.move / repairLayerPlacement 执行算法保持不变，避免在没有 native move 失败证据时同时改动宿主放置逻辑。

### 保留范围

普通单层 / 多选移动、Alt 复制、文件夹上方 / 内部 / 下方、AI 结果组完整移动、智能滤镜 / 效果 / 蒙版 / 变体子行、左侧删除区、底部工具栏、编辑工作台、外置参考图拖放均沿用原有入口。

### 验证状态

- npm run typecheck 通过。
- npm run build 通过，dist/plugin/index.js 已更新。
- git diff --check 通过。
- 按用户要求未运行 npm test，未启动 Photoshop / ComfyUI。需要用户刷新开发版后在 WavePlug_TEST_ 文档实测；若仍失败，优先查看新日志 layer drag release captured、layer drag release、layer drag release without list target，区分释放事件是否到达、最终区域判定、目标计划和 Photoshop 原生移动结果。

### 2026-11-08 四周命中缓冲区（50px）

图层列表四周增加 50px 透明 sibling hit-zone，仅在拖拽激活后显示。位置通过 list.offsetTop / offsetLeft / offsetWidth / offsetHeight 布局值同步，不用 UXP 鼠标 client rect。顶部缓冲区映射到 firstRow 顶部插入槽；底部映射到最后一个完整可见行之后；左右缓冲区不再放在列表外侧（外侧空间会被 UXP 面板边界裁切），而是放在列表内部可达区域：左侧从 32px 删除轨道之后开始，右侧贴列表内缘，各提供 50px 命中带；通过各自 hit-zone 的 offsetY 映射到对应可见行。鼠标离开面板后重新进入时，捕获事件命中侧边 hit-zone，区域状态从 outside/panel 恢复为 list，并重新计算目标。工作台优先级改为检查真实 `workbench.el` 事件目标，不再用 `getBoundingClientRect()` 与 clientX/clientY 混合判断，避免错误抢占侧边回入。悬停与释放使用相同映射，并在释放时调用统一 track()，所以指示线和最终放置目标保持一致。

四个缓冲区仅在 dragging 状态启用，不占布局空间。左侧删除区保留优先级并占 32px，其右侧为完整 50px 放置带；右侧为完整 50px 放置带。底部工具栏和编辑工作台保留更高优先级；工作台覆盖区域仍按原有工作台放置行为处理。若面板极窄，纯逻辑边界函数会自动缩窄左右命中带，保证两侧不重叠。

## Adobe 官方参考

- Photoshop Layer.move: https://developer.adobe.com/photoshop/uxp/ps_reference/classes/layer/
- executeAsModal: https://developer.adobe.com/photoshop/uxp/ps_reference/media/executeasmodal/
- batchPlay: https://developer.adobe.com/photoshop/uxp/ps_reference/media/batchplay/
- UXP CSS changelog: https://developer.adobe.com/uxp/uxp-api/changelog

## 2026-11-12 落点检测重写：几何命中（源码 + 已构建，Photoshop 待实机验收）

### 证据（reports/uxp_runtime.log，11-11 ～ 11-12）

- 真正拖动后的释放里，`hitTarget` 绝大多数为 false：UXP 拖拽期间仍把事件派发给按下的那一行（或列表本身），透明 hit 层很少是 target。旧代码因此退回到「按下行的**中心** + 鼠标位移」估算 listY，抓在行上/下半部时误差可达半行，指示线和实际判定都会偏。
- 同一次拖拽中 `clientY - offsetY`（以列表为 target 时）恒为 ≈134：client 坐标是稳定的，只是原点未知。
- 鼠标还在列表里时，会收到 offsetY=0、区域判为 outside 的合成事件（`reentered list from outside ... offsetY 0`），旧代码按 event.target 切换区域，导致预览闪成「不能放在这里」。
- 文件夹分区曾改成 上 55% = 上方、55–84% = 内部，用来抵消上面的偏差，结果更难放进文件夹。

### 新链路（`src/core/layers/dragGeometry.ts`）

- **校准**：每个可测量的事件（按下、armed 移动、拖动、释放）用布局偏移链 `offsetTop/offsetLeft`（+ 父级 clientTop/Left）算出指针在面板中的位置，得到 client→面板 偏移样本；取最近 9 个样本的中位数，X / Y 分轴，越界 offset 与 0/0 合成事件丢弃。按下事件即第一个样本，因此从第一帧就知道抓取点。
- **区域**：指针换算到面板坐标后，用布局矩形判定：删除轨道 > 底栏工具按钮 > 工作台 > 列表（含上下 50px、整面板宽的缓冲带）> 面板其他区域 > 外部。不再依赖 event.target、mouseenter/mouseleave。移动和释放走同一个 `locateDrag()`。
- **落点**：列表内 Y 直接 = 面板 Y − 行容器顶部；缓冲带夹到首个可见行上方 / 最后可见行之后（`clampDropListY`）。自动滚动只在列表内侧 22px 边带触发，缓冲带不滚动，作为稳定落点。
- 文件夹分区恢复 Photoshop 的 25% / 50% / 25%。
- 删除了 4 个 50px DOM 缓冲层及其 CSS、`dragListYAtPointer / dragCorrectionFromOffset / *DropBuffer*` 等旧函数。
- 新日志：`layer drag region`（区域切换，含面板坐标）；`layer drag release captured` 增加 panelX/panelY/listY/calibration。

### 验证状态

- `npx tsc --noEmit -p .` 通过；`npm run build` 通过；`git diff --check` 通过。
- npm test 201 项中 200 通过；失败的 1 项是 `layer_tree.test.ts` 的「锁定」用例，来自 11-08 背景层解锁改动的 `lockPlan`，与拖拽无关，未处理。
- Photoshop 未实测。需在开发版点 ⟳ 后测试：行上/下半部释放、文件夹上方/内部/下方、列表上下缓冲带、删除轨道、底栏三个按钮、工作台、拖出到外置参考图面板。若仍不准，看 `layer drag release captured` 的 calibration.samples 是否 > 0、dy 是否稳定。

### 2026-11-12 补充：外置参考图面板上的拖拽卡片状态

用户实测：拖到外置参考图槽位上卡片仍显示「不能放在这里」，但松手能放入。原因是卡片文字只由 UXP 发送，UXP 只能看到自己的面板，鼠标在面板外一律是 outside → invalid。
- Rust：`GenerateSurface` 每帧记录光标所在槽位的 `drop_hint`（放入参考图 / 替换参考图「图N」/ 依次放入 N 个参考图），新增 `Surface::external_drop_hint()`；host 绘制拖拽卡片时，面板未折叠且有 hint 就覆盖 UXP 的文字，色调为 move。
- UXP：参考图拖拽且区域为 outside 时显示「拖到参考图槽位上」（灰色），不再是「不能放在这里」。
- 验证：tsc、build 通过；npm 200/201（锁定用例，旧问题）；Mac 上 `cargo test` 26/26、`cargo check --target x86_64-pc-windows-gnu` 无警告。**helper 需要在 Windows 上运行 build.cmd 重新构建**，UXP 点 ⟳。

### 2026-11-12 列表内拖拽延迟

用户反馈：helper 0.5.1 上线后，列表内拖拽的显示反应有明显延迟。没有 UXP 端计时数据。已知事实：
- helper 每次判定变化都写一行日志（无缓冲，在 UI 线程上），几秒内写了 109 行。
- 几何重写后，插件每次 mousemove 都会读取约 10 个元素的布局偏移，并且是在 trackDrop 写完标记样式之后读，可能迫使 UXP 每次都重新布局。

改动：
- 插件：布局矩形和校准样本最多每 250ms 刷新一次。按下和松手时强制刷新，保证落点准确。列表高度用缓存值（visibleBottom / edgeDir）。指示线没有变化时不再写样式。
- helper：只在判定来源变化时（plugin ↔ 原生目标）写日志。
- 新增证据：`layer drag release captured` 增加 `perf {moves, avgMs, maxMs, layouts, maxGapMs}`。avgMs / maxMs 是插件处理每次移动的耗时，maxGapMs 是相邻两次 mousemove 的最大间隔。如果仍然卡，看这几个数：耗时高说明插件端慢；间隔大说明 UXP 事件来得慢，或者被 Photoshop 宿主阻塞。

#### 证据与根因（同日复测）

- 插件端 `perf`：每次 mousemove 平均处理 0.02–0.18 ms、最多 1 ms；长拖拽约 290 次/秒。**插件不是瓶颈。**（maxGapMs 包含鼠标停下的时间，不能单独作为卡顿证据。）
- helper 端 `drag verdict`：插件文字每次变化都会立即发出，但 helper 只按 33 / 50 / 66 ms 的步长接收（全是 16.7 ms 的整数倍，最常见是 3 帧），文字会跳过行。**helper 拖拽时只有约 20 fps。**
- 根因：eframe glow 后端默认开 vsync。每个 immediate viewport 的 swap 都要等一次刷新，而拖拽时每帧要画主窗口、变体栏、拖拽卡片三个窗口：3 × 16.7 ≈ 50 ms。
- 修复：`NativeOptions.vsync = false`。重绘本来就由显式请求驱动（拖拽时 8 ms，平时按需），不会空转；唯一无条件连续重绘的是开发用截图工具 `shot.rs`，截完会自己关闭。
- 新证据：每次拖拽结束时 helper 写 `drag card frames=… fps=… max_gap_ms=…`。修复后 fps 应接近 100 以上，不应再是 ~20。
- 注意：上一轮「只在来源变化时记日志」的改动当时也没生效，因为 helper 没有重建（日志仍逐行记录）。这次 helper 改动需要运行 build.cmd。
- 0.5.2 实测（01:02）：卡片 fps 696–936，max_gap 14–16 ms。关闭 vsync 后，各窗口和命令的重绘请求让 helper 全速空转。三个置顶窗口每秒刷新近千次，占满 GPU 和画面合成，用户仍感到强烈滞后。0.5.3 在 `Host::update` 开头硬性限速，帧间隔至少 8 ms（约 125 fps，`frame_wait`）。修复后日志里的卡片 fps 应在 100–125 之间。

### 2026-11-12 重写：拖拽引擎（helper 0.6.0）

关 vsync、限速都属于补丁，用户实测仍有滞后感。现已重写：卡片和外部落点移出 egui，放到独立的拖拽引擎线程（`native/overlay/src/drag/`，设计见 `CROSS_APP_DRAG_DROP_SPEC.md` 第 15 节）。卡片只在文字变化时绘制，鼠标移动由低级鼠标钩子直接移动窗口，所以拖拽期间 helper 不再每帧重画。vsync 恢复默认，8ms 限速和卡片帧率日志都已删除，改为每次拖拽结束写一行 `drag session … moves renders max_handler_us hook` 日志。卡片的倾斜摆动动画已去掉（它要求每帧重画），多选的后置叠片改为静态。
