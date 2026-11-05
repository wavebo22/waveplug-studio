# WavePlug 悬停像素轮廓：决策存档与 POC 计划

日期：2026-11-06
项目：F:\waveplug\studio
状态：已存档；POC 正在进行
范围：WaveLayer 图层行悬停、指定图层 Alpha 读取、画布蓝色轮廓绘制。此文件记录用户确认的方向与实验验收条件，不代表功能已经实现。

## 1. 用户确认的目标

用户希望恢复并重新设计 WavePlug 之前的悬停定位能力，但不再通过临时选中 Photoshop 图层来显示边界。

目标交互：

1. 鼠标停留在 WaveLayer 的某个图层行上。
2. 根据该行的 documentID + layerID 读取该图层真实像素和 Alpha。
3. 根据非透明像素提取不规则轮廓；不能用图层矩形 bounds 代替。
4. 在 Photoshop 画布上显示细蓝色轮廓线，不填充、不发光、不改变画布亮度。
5. 鼠标离开图层行或 WaveLayer 列表后，立即隐藏轮廓。
6. 悬停过程中不改变 Photoshop 当前选中图层、不创建历史记录、不修改或保存 PSD。

## 2. 硬性约束

### 不抢焦点、不拦截鼠标

- 显示轮廓时不得激活 Overlay 窗口或改变前台窗口。
- 不得获取键盘焦点。
- Photoshop 画布仍须正常接收点击、拖动、画笔、选区、空格平移、Alt/Ctrl+滚轮缩放等操作。
- 现有生成面板继续保留其当前交互规则；轮廓层不得改变它。

### 低性能开销

- 事件驱动，不使用高频轮询。
- 只在悬停目标图层变化时触发读取。
- 使用短延迟确认悬停目标；鼠标离开时立即隐藏，不等待像素读取完成。
- 缓存键至少包含文档 ID、图层 ID 和图层内容版本/失效代数。
- 相同图层命中缓存时不重复读取；文档切换、图层内容变化、图层移动/变换或可见性/蒙版变化时使缓存失效。
- 快速经过多个图层时取消或丢弃过期任务，不能排队执行一串旧读取。
- 限制读取尺寸，后台提取轮廓，释放 Imaging imageData。
- 记录读取、轮廓计算和 Overlay 更新耗时，评估是否影响 WaveLayer 和 Photoshop。

## 3. 旧方案回溯

### 旧 WaveLayer hover-select

- 旧代码位于 src/ui/layerTree.ts。
- 停留约 60ms 后调用 tree.select() 临时选中悬停图层，依赖 Photoshop 原生变换控件/边缘显示范围。
- 离开后恢复原面板选择。
- 旧开关为 wp.layers.peek，默认关闭。
- 旧实现通过 Promise 队列串行执行选择命令；快速划过会积压 Photoshop 选择操作，并可能在非移动工具下误选图层和造成卡顿。
- 新 POC 不复用 tree.select()，也不排队提交选择命令。

### 旧跨面板悬停浮层 POC

- 曾采用约 300ms 显示、鼠标离开触发区域约 250ms 后隐藏、可固定的交互。
- 受 UXP 原生窗口标题栏和关闭按钮限制，未继续采用。
- 本次目标不是复活该 UXP Dialog，而是验证像素轮廓绘制。

## 4. 当前代码基础与已知事实

- src/ps/uxpHost.ts 已有 layerPixels(docId, layerId, maxEdge)，通过 imaging.getPixels({ documentID, layerID }) 读取指定图层；当前封装使用 executeAsModal。
- src/ps/uxpLayers.ts 已有缩略图读取路径：按指定 documentID + layerID 调用 imaging.getPixels()，支持 sourceBounds、targetSize，读取 imageData.components，并处理 r.level 和 r.sourceBounds。
- reports/uxp_runtime.log 已有实际读取日志，部分图层返回 4 个组件（RGBA），缩略图读取耗时约数十至数百毫秒。该路径是现有证据，不等于已经验证适合高频悬停。
- native/overlay/src/win.rs 的现有生成面板使用 WS_EX_NOACTIVATE 和 WM_MOUSEACTIVATE -> MA_NOACTIVATE，目的是点击面板时不夺走键盘；它不是鼠标穿透窗口，不能直接覆盖整个画布。
- 因此画布轮廓需要独立验证透明、鼠标穿透的绘制层；不得让现有生成面板承担全画布命中测试。

## 5. 实验阶段

### A. 指定图层像素与 Alpha

- 在专用 WavePlug_TEST_ 文档中验证 Photoshop 2026 的 Imaging API。
- 只读指定 documentID + layerID，不临时选中、不合并、不栅格化、不复制或改写原图层。
- 检查 imageData.components、Alpha 通道、sourceBounds、level 和透明边缘。
- 先支持普通像素图层；之后再分别评估智能对象、文字、形状、蒙版、图层效果和特殊色彩模式。
- 用合成像素单元测试验证轮廓提取、透明阈值、孤立像素和多连通区域。

### B. 原生绘制层

- 评估独立透明 Overlay，覆盖范围尽量限制在 Photoshop 画布。
- 必须同时验证不激活、键盘焦点不变、鼠标点击/拖动能到达 Photoshop。
- 不能只凭 WS_EX_NOACTIVATE 判定鼠标穿透成功。
- 优先做最小可撤销的独立 POC，不改现有生成面板窗口。

### C. 坐标映射

- 将图层文档像素坐标映射到 Photoshop 画布屏幕物理像素。
- 验证缩放、平移、画布窗口移动、DPI 缩放；旋转画布单独验证。
- 映射不准确时不接入正式交互。

## 6. 验收标准

- 轮廓跟随真实 Alpha 形状，而非矩形边界。
- 悬停图层不会改变 Photoshop 当前选择。
- 鼠标离开后轮廓立即消失。
- Overlay 显示/隐藏前后，前台窗口与键盘焦点保持不变。
- Photoshop 画布的鼠标点击、拖动和工具操作不被截获。
- 同一图层缓存命中时不再次调用 getPixels()；快速扫过不会形成旧任务队列。
- 记录真实读取耗时、计算耗时、缓存命中率和内存释放情况。
- 若 API、鼠标穿透或坐标映射关键路径不成立，停止 POC 并说明原因，不以矩形框或临时选层冒充成功。

## 7. 本轮保护范围

- Git 分支保持 local-test；不提交、不切分支。
- 保留仓库现有所有未提交修改和未跟踪文件，不重置、不清理、不覆盖。
- 不修改或保存当前用户 PSD；只在专用 WavePlug_TEST_ 文档中做实机测试。
- POC 与正式功能隔离；未经用户确认，不部署或默认开启正式悬停轮廓功能。
