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

## Adobe 官方参考

- Photoshop Layer.move: https://developer.adobe.com/photoshop/uxp/ps_reference/classes/layer/
- executeAsModal: https://developer.adobe.com/photoshop/uxp/ps_reference/media/executeasmodal/
- batchPlay: https://developer.adobe.com/photoshop/uxp/ps_reference/media/batchplay/
- UXP CSS changelog: https://developer.adobe.com/uxp/uxp-api/changelog
