# WaveLayer 图层删除链路审计（2026-11-04）

## 已遍历范围
- UI：`src/ui/layerTree.ts` 中的 Delete/Backspace、底栏垃圾桶、右键、拖动到垃圾桶、蒙版/滤镜/效果删除、悬停定位和刷新队列。
- 核心：`src/core/layers/tree.ts` 中的 `deleteTargets`、`planLayerDeletion`、`nextLayerAfterDelete` 与菜单启用逻辑。
- UXP：`src/ps/uxpLayers.ts` 的批处理、具体图层 ID、蒙版/滤镜/变体的删除命令；`src/ps/uxpHost.ts` 的 `step` 历史事务和 `deleteVariation`；`src/ps/uxpTools.ts` 的 `act`、`selectLayers`。
- 注意：`uxpTools.clearMasked()` 删除像素，并不是删除图层，必须区别处理。

## 已有日志证据
- 11-03 14:09、14:15 曾出现 Photoshop 拒绝 delete；14:28 选中 ID 过期；更早出现 History state is already suspended。
- 15:50 的记录显示多次成功删除 10、6、4 个图层等，并且回读后选中下一层；故障属于部分条件下失败，并非 Delete 一律无效。
- 14:29 的 “Photoshop 未删除图层 #1” 属于旧的 DOM delete() 实现，不能直接归因给后来的 batchPlay 版本。
- `reports/uxp_runtime.log` 是后续复现时的关键证据。

## 本轮源码修改
1. UI 的所有删除入口共用防重入状态（键盘、底栏、右键、拖动，以及蒙版/滤镜/效果删除）；不再只有键盘与工具栏受保护。
2. 删层期间不让图层树的旧刷新覆盖 UI 选择；显式 ID 删层不再先执行悬停预览的恢复选择，避免在已删图层上执行 select。
3. 增加逐层预检：去重、过滤失效 ID、父图层组包含其子图层；背景/完全锁定图层先跳过，不自动解锁。
4. 普通图层多选按 ID 逐项删除，并区分单层失败与整体模态/历史异常。其他合法图层继续处理；取消/历史中断仍回滚。
5. 删除命令使用静默 batchPlay；重新枚举 Photoshop 存活图层，确认哪些实际删除，记录每个失败图层的名称与 ID。
6. 返回 `LayerDeleteResult`（deleted、skipped、selected）；WaveLayer 按宿主实际选中状态更新，避免用旧的“预测下一层”覆盖 PS。
7. 检查活动文档 ID，防止切换 PSD 时的旧命令在另一个文档执行。
8. WaveLayer 变体及主面板的 `deleteVariation` 改为可等待的按 ID 删除，显式检查错误和是否真的消失。
9. 新增纯逻辑测试，覆盖父子选择、过期 ID、背景图层、锁定图层、重复选择等。

## 仍需真实 Photoshop 验证
- 单层连续 Delete、Backspace、工具栏、右键、拖动垃圾桶。
- 多选跨组、父子同时选择、带部分锁定/背景层，是否能删除其余合法图层。
- 最后一个普通图层/只有背景、部分锁定、画板、剪贴图层的实际宿主行为。
- 蒙版、矢量蒙版、智能滤镜、效果、变体的删除及撤销。
- 一次 Ctrl+Z 是否撤销同一批删除；切换文档与其它插件并发 modal 时不误删。
- 未收到键盘事件的情况仍属于键盘焦点问题，不能只靠删除命令修复。

日志筛选建议：`layer panel key`、`layer delete targets`、`layer delete failed`、`layer delete not removed`、`layer delete result`、`layer delete busy`、`layer panel delete next`、`layer command`。

**限制：本轮未在用户真实 PSD 上执行任何删除。自动化测试通过不代表已在 Photoshop 中彻底解决。没有提交 Git 或切换分支。**

## 2026-11-04 追加复测：空画板删除同样耗时 34 秒（当前结论）

用户明确反馈**即使空画板也会卡顿**。最新日志（文档 305，画板 ID 398）记录 2026-11-03T17:51:46.326Z 的 `layer artboard delete begin` 至 17:52:20.310Z 的 `layer artboard delete completed`，**仅 Photoshop `batchPlay({_obj:"delete"})` 就耗时 33,984 毫秒**；此前同一文档普通图层约 48–114 毫秒。画板为空/已经删空其他子图层，排除“仅因为画板内图层数量多或存在锁定组”的解释。原有 `step()` 历史提交和 UI 重读发生在命令返回之后，因此无法解释这 34 秒。新增进度提示有助于区分等待，但不能加速 Photoshop 命令本身。

Photoshop 为 27.10（Windows），此前用户曾在 27.10 版本上复现。**优先验证 Photoshop 原生画板删除性能，不应继续盲目修改 WaveLayer 删除接口。**可靠外部资料：
- Adobe 官方“已知问题”2026-09-25：画板较多时**移动**会卡顿，建议使用画板工具选项齿轮关闭 Auto-size Canvas。该记录尚不直接覆盖“删除”场景：
  https://helpx.adobe.com/photoshop/desktop/troubleshoot/performance-stability-issues/known-and-fixed-issues.html
- Adobe 社区 2026-08-22 用户报告近期 Photoshop 创建/删除/移动画板导致冻结，2026-10-15 Adobe 社区经理建议分别试“切换 Auto-Resize Artboard”和“在画板上方放空白图层”：
  https://community.adobe.com/questions-712/photoshop-bad-performance-artboards-moving-and-more-1638274
- Adobe 社区 2026-08-06：Adobe 社区经理将画板移动慢与 Canvas Autosize 重算图层位置联系起来并建议关闭自动调整：
  https://community.adobe.com/bug-reports-711/photoshop-25-9-hangs-when-moving-artboard-1169336

**下一步验证顺序**：临时 PSD（非用户工作文件）原生 Layers 面板删除空画板并计时 → 关闭 Artboard Tool 选项齿轮中的 Auto-size Canvas（先记住原值）→ 原生 Layers 再测 → WaveLayer 再测 → 视结果决定是否需要专门的替代删除接口。**不要默认修改用户 Auto-size Canvas 设置**：关闭后，移到画布边界外的画板可能不可见。并非已证明根因或已修复，不应误标为“性能修复完成”。

## 2026-11-04 画板删除：当前不可用 + 长时间执行（前一轮）

用户截图：`已删除 0 个图层、跳过 1 个：画板 1 拷贝：WavePlug Studio Dev 命令“删除”当前不可用`，伴随短暂无响应。排查 `reports/uxp_runtime.log`：docId 305 的画板 ID 398 在 17:34:19/21 和 17:35:26 被 Photoshop 拒绝；17:34:30 批量删除曾跳过锁定的子组「组 2」(ID 399)，17:34:38 删除该组成功；同一画板在 17:34:42→17:35:19（约 37 s）、17:36:16→17:36:51（约 34 s）、17:37:39→17:38:20（约 41 s）成功删除。锁定子组与失败高度相关，但不能证明它是全部失败的唯一原因。长时间执行发生在 Photoshop batchPlay `delete` 阶段，不只是图层树刷新。

改动：

1. `planLayerDeletion` 在**整块画板**的预检中递归查找完全锁定的子图层/组；若发现则直接跳过画板，并给出「画板内『××』已锁定，请先解锁」。不擅自解锁用户图层，也不影响其他可删除选中层。普通图层组延续原有语义。
2. `canDropToDelete` 也使用同一预检：全部无法删除时，不激活左侧红色拖拽删除区；底部垃圾桶可触发快速原因提示。
3. `layerTree.ts` 根据用户实际选中的 artboard ID，在提交 Photoshop modal 前显示「正在删除画板…」，先让面板绘制该提示；成功后显示耗时，失败保留明确原因。
4. `layersPanel.ts` 新增持久 `busy` 状态；不会再 3 秒自动清除画板删除进度提示。
5. `uxpLayers.ts` 通过 `RunOptions.artboardIds` 辨认画板，执行之前做真实 DOM 子层预检；对执行中的画板删除调用 Photoshop `executeAsModal` 的 `reportProgress`（原生进度及取消入口），并分别记录每个画板的成功/失败耗时。收到宿主取消请求时主动回滚，不继续删除其他层。
6. 新增回归测试：嵌套锁定组阻止删除整画板、与可删普通层多选时不阻断后者、解锁后可删以及左侧红区的条件。

Adobe 官方 `executeAsModal` 文档说明长任务会呈现原生进度 UI 并支持取消：<https://developer.adobe.com/photoshop/uxp/ps_reference/media/executeasmodal/>。

**限制**：不能保证把 Photoshop 内核处理大型画板所需的 30–40 秒直接缩短；此轮减少无效调用和误以为卡死的情况。未经 Photoshop 实机验证，禁止在重要 PSD 上直接试验。仍需检查长画板删除能否取消、一次 Ctrl+Z 是否完整撤销及锁定子组提示是否精确。

## 2026-11-04 蒙版跨图层拖拽移动 / Alt 复制（前一轮）

用户要求蒙版拥有与 WaveLayer 图层样式图标相同的拖拽操作。设计与 Adobe Photoshop 原生图层蒙版 / 矢量蒙版的拖拽方式一致：直接拖动移动、按住 Alt 拖动复制；拖到左侧红区或底部垃圾桶仍然删除。参考 Adobe 官方帮助文档。

- `src/ui/layerTree.ts`：蒙版缩略图现沿用图层样式的 `trackOnto` 行级目标高亮；Alt 显示复制色和“复制到…”提示，普通拖动显示“移到…”；松开调度 `moveMask` / `moveVectorMask` / `moveFilterMask`，其他既有蒙版单击、Alt+单击查看蒙版及拖动删除入口不变。
- `src/core/layers/tree.ts`：`canDropMaskOnto` 过滤目标是自身、背景层、锁定层及锁定组内图层、已有同类蒙版的图层；矢量蒙版不移到形状图层，智能滤镜蒙版只能移到存在智能滤镜且无滤镜蒙版的智能对象。拒绝直接覆盖已有蒙版，防止丢失原数据。
- `src/ps/maskTransfer.ts`：分离可测试的 UXP Action Manager 描述符：以原图层 ID 和目标图层 ID 引用 mask channel / vectorMask path / filterMask channel。
- `src/ps/uxpLayers.ts`：执行之前再次检查图层、锁定、类型及实际蒙版状态；先在目标建立复制并校验，**移动时才删除源蒙版**，随后再次核对；整条操作放在一个 `step()` 历史事务中，失败回滚以免丢失蒙版。原有 `deleteMask` 系列命令未修改。
- `tests/layer_tree.test.ts` 及 `tests/mask_transfer.test.ts` 增加非法目标及 Action Manager 描述符的纯逻辑测试。

**验证范围：** 已做 TypeScript、Node 自动化测试与 build；mainpc 的 Photoshop MCP 当前报 `Photoshop info not available`，因此本轮**没有 Photoshop 真机移动 / Alt 复制验证**。特别是矢量蒙版及智能滤镜蒙版的 Action Manager 命令需实际确认，不应视为已完全验证。请使用临时 PSD 测试普通蒙版移动、Alt 复制、矢量蒙版、锁定/已有蒙版目标、左侧红区删除及 Ctrl+Z 撤销。

## 2026-11-04 左侧拖拽删除区（前一轮）

用户决定：保留底部垃圾桶的单击和拖拽删除；列表左侧增加仅在拖动可删除对象时显示的 32px 红色目标区域。鼠标在红区内松开直接删除，移出即取消，不弹确认（Photoshop Ctrl+Z 可撤销）。不新增固定列，也不改变原有图层排序。

- 开发前先提交基线 `8ce523f`（`local-test`）；新功能修改与该提交分离，尚未再次提交。
- `src/ui/layerTree.ts`：左边的 `lt-left-delete` 覆盖层只在有效拖拽激活后显示，`mouseenter/leave` 切换红区高亮；红区优先于图层排序插入标记，松开后复用原来的删除命令，离开红区后取消目标。水平拖动超过 5px 也可开始拖拽。
- 支持图层及多选图层、图层组、图层蒙版、矢量蒙版、智能滤镜蒙版、单个/全部智能滤镜、单个/全部图层样式，以及单个变体图层。蒙版和变体缩略图新增拖拽入口，但原有单击编辑/切换仍保留。
- `src/core/layers/tree.ts`：`canDropToDelete` 在 UI 侧预检是否至少有一个合法可删对象，背景层、完全锁定层、锁定组内的图层不会单独激活红区，最终删除仍由 Photoshop 处理和核实。
- **WaveLayer 已停止监听 Delete / Backspace**，并取消旧的快捷键排队逻辑；Photoshop 原生快捷键未修改。右键菜单的删除项也未改变。
- `plugin/styles.css`：32px 左侧红色覆盖层；平时隐藏，拖动时半透明，进入后红色高亮。底部垃圾桶保留原样。

测试覆盖：`tests/layer_tree.test.ts` 增加显示条件、背景层、锁定组、蒙版、滤镜、效果、变体的预检；TypeScript 和自动化测试通过。**本轮实际 Photoshop 拖拽命中、取消和 Ctrl+Z 仍须用临时 PSD 验证。**

## 2026-11-04 快捷键专属故障补充（历史记录，当前已停用）

用户反馈：快捷键删除在部分情况下停止工作，但同一时刻底部垃圾桶按钮和拖拽删除仍然正常。该差异指向键盘事件/焦点链路，而非底层图层删除 API。

检查发现两个诊断/实现缺口：
- Delete 键监听原先位于 `document` 冒泡阶段；子控件或宿主事件处理可能先截获按键。现改为 `window` 捕获阶段，且只对 Delete / Backspace 拦截，不影响输入框编辑。
- `keysLogged` 最多记录 50 次、`refocusLogged` 最多记录 30 次，超过后恰好无法观察长期使用时的故障。现在每次快捷键按下/抬起都会记录目标、活动元素、panelActive、pointerIn、repeat、deleting、当前文档及选中 ID。

本轮快捷键修复：
1. 删除 / 选层后不只同步执行一次 `blur/focus`，而是在 0 / 80 / 220 ms 重试；仍要求面板是最近交互面板、鼠标仍在面板内，且没有输入或拖拽，避免抢走画布焦点。
2. 键盘在上一轮删除尚未完成时再次按下，若是新的实体按键（非系统 key-repeat），最多排队一次；上次删除完成后等待图层树刷新，再从 Photoshop 当前选中层继续，不复用旧 ID。系统自动重复键不排队，防止长按误删大量图层。
3. 若键盘事件未送达插件，不会假装执行删除；未激活、输入框、删除忙、选择过期均有明确日志。

验证：`npm run typecheck` 通过；`npm test` 102/102 通过；`npm run build` 完成。**这轮尚未经过 Photoshop 实机快捷键复测**。复测时先点击 WaveLayer 图层行，在鼠标仍留在面板内的情况下连续按 Delete；如果失效，检查 `layer panel shortcut keydown`、`layer panel shortcut keyup`、`layer panel focus restore`、`layer panel focus restore skipped`、`layer delete request busy`、`layer keyboard delete queued`。如果 keydown/keyup 完全没有日志，说明事件没有进入 UXP 面板；若有 keydown 但无 delete result，再按状态字段定位。
