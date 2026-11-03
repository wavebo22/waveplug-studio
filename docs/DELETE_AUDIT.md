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

## 2026-11-04 快捷键专属故障补充

用户反馈：快捷键删除在部分情况下停止工作，但同一时刻底部垃圾桶按钮和拖拽删除仍然正常。该差异指向键盘事件/焦点链路，而非底层图层删除 API。

检查发现两个诊断/实现缺口：
- Delete 键监听原先位于 `document` 冒泡阶段；子控件或宿主事件处理可能先截获按键。现改为 `window` 捕获阶段，且只对 Delete / Backspace 拦截，不影响输入框编辑。
- `keysLogged` 最多记录 50 次、`refocusLogged` 最多记录 30 次，超过后恰好无法观察长期使用时的故障。现在每次快捷键按下/抬起都会记录目标、活动元素、panelActive、pointerIn、repeat、deleting、当前文档及选中 ID。

本轮快捷键修复：
1. 删除 / 选层后不只同步执行一次 `blur/focus`，而是在 0 / 80 / 220 ms 重试；仍要求面板是最近交互面板、鼠标仍在面板内，且没有输入或拖拽，避免抢走画布焦点。
2. 键盘在上一轮删除尚未完成时再次按下，若是新的实体按键（非系统 key-repeat），最多排队一次；上次删除完成后等待图层树刷新，再从 Photoshop 当前选中层继续，不复用旧 ID。系统自动重复键不排队，防止长按误删大量图层。
3. 若键盘事件未送达插件，不会假装执行删除；未激活、输入框、删除忙、选择过期均有明确日志。

验证：`npm run typecheck` 通过；`npm test` 102/102 通过；`npm run build` 完成。**这轮尚未经过 Photoshop 实机快捷键复测**。复测时先点击 WaveLayer 图层行，在鼠标仍留在面板内的情况下连续按 Delete；如果失效，检查 `layer panel shortcut keydown`、`layer panel shortcut keyup`、`layer panel focus restore`、`layer panel focus restore skipped`、`layer delete request busy`、`layer keyboard delete queued`。如果 keydown/keyup 完全没有日志，说明事件没有进入 UXP 面板；若有 keydown 但无 delete result，再按状态字段定位。
