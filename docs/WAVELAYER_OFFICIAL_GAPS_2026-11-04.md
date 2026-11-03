# WaveLayer × Photoshop 官方能力差距审计（2026-11-04）

> **仅调研，不修改插件源码。** 主机：Photoshop 2026 27.10。依据 Adobe HelpX 与 Photoshop UXP API 官方文档，逐项对照当前 `local-test` 分支及 `docs/LAYER_PANEL_HANDOFF.md`。功能已在源码声明 ≠ 已经实机验证。

## 当前已覆盖，不重复设计

图层树与折叠展开；画板范围/颜色；图层搜索和类型筛选；Ctrl/Shift 多选；图层及组拖拽排序、Alt 复制；单选/多选复制、组建/解组、合并/栅格化；显示/隐藏和批量拖动；普通位置锁/像素锁/透明锁/全锁；混合模式、填充和不透明度；蒙版/矢量蒙版/智能滤镜蒙版选中、启停、部分删除及最近加入的跨图层拖拽移动/Alt 复制；图层样式/智能滤镜子项开合/排序/删除；链接/断开链接；智能对象独立副本、打开内容及 AI 变体。底部垃圾桶与左侧红区删除并存。WaveLayer 主动拦截 Delete/Backspace 已停用。部分最近添加的 UXP 描述符尚需 Photoshop 真机测试。

## 推荐缺口：优先级与可行性

| 级别 | 缺失 / 不完整 | 当前情况 | 推荐交互入口 | 技术和风险 |
|---|---|---|---|---|
| P1 | 高级筛选（效果、混合模式、可见/锁定/蒙版/剪贴/颜色、属于某个画板、组合条件；一键关闭筛选） | 仅搜索、类型、共用/不可编辑/AI | 搜索旁过滤弹层，不增常驻一排 icon | **低—中**：已有 `TreeLayer` 多数属性，少数需按需读取；建议缓存过滤索引避免重跑 |
| P1 | 智能对象链接健康度和修复（丢失、过期、更新、重链、替换内容、嵌入、导出） | 识别嵌入/外链、共用及“断开链接”，无维护命令和文件告警 | 状态图标二级菜单 + 缺失/过期角标 | **中—高**：文件对话框、token 与 UXP batchPlay；避免无意替换所有同源实例 |
| P1 | 图层/组快速导出、导出为新文档 | 主面板其他输出功能≠ WaveLayer 逐层输出 | 右键「快速导出 PNG / 导出为… / 提取到新文档」 | **中—高**：尽量调用 PS 原生 Quick Export 以继承偏好；独立文件导出与命名冲突需处理 |
| P2 | 选择相似图层 / 选择全部 / 选择链接图层 | 已有多选、选中同源智能对象，无通用同类型选择 | 右键「选择」子菜单 | **低**：`TreeLayer` 类型和链接数据已有；`tree.select` 需批量确认 |
| P2 | 多图层对齐/分布（六种对齐及水平/垂直等间距） | 已有图层顺序拖动，但没有画布几何排列功能 | 多选右键「对齐与分布」子菜单 | **中**：优先用原生 Photoshop Align/Distribute；自行用 bounds 算旋转/蒙版/组可能与 PS 不一致 |
| P2 | 蒙版密度/羽化（普通/矢量/滤镜） | 蒙版缩略图交互很多，但尚无参数控制 | 缩略图右键「蒙版参数」两控件 | **低—中**：UXP Layer 的 `layerMaskDensity/Feather`, `vectorMaskDensity/Feather`, `filterMaskDensity/Feather` 官方 R/W；执行需要 modal，读写要校验 |
| P2 | 画板专属操作（按画板筛选、防自动嵌套锁、解散画板、尺寸位置） | 已有画板分组与颜色、常规锁，但无第 5 类自动嵌套锁及画板参数 | 画板行右键/二级属性弹层 | **中—高**：独立画板组语义，不将“解散画板”当成“删除图层”；超大文档注意宿主性能 |
| P2 | Photoshop 2026 的“清晰度和去朦胧”“颗粒”调整图层 | `src/ps/host.ts` 的 `ADJUSTMENTS` 尚未列这两项 | 现有调整图层菜单末尾 | **中**：PS 27.3 增加，UXP LayerKind 在 27.4 支持，实际创建 descriptor 应录制校验 |
| P3 | 缩略图来源模式（图层实际边界 / 整个画板或文档） | 已有无/小/中/大；缩略图目前按画板/画布比例读，未提供两种范围切换 | 原有「缩略图」设置次级选项 | **中**：缓存键包含比例/区域，超大文档避免强制全尺寸渲染 |
| P3 | 智能对象重置变换 | 可编辑/转换/复制，缺少单项重置变换 | 右键智能对象子菜单 | **低—中**：官方有 Layer > Smart Objects > Reset Transform |
| P3 | 无损导出分组与规范命名、批量重命名 | 原生 PS 有逐层导出、新建文档；WaveLayer 暂无针对 UI 切图的批处理 | 右键或小型批处理弹层 | **中—高**：新增独有价值，但不是补齐原生图层面板所必需 |

## 官方关键依据（截至 2026-11-04）

- Photoshop UXP Layer 属性（蒙版密度/羽化、锁、图层边界等）：
  https://developer.adobe.com/photoshop/uxp/ps_reference/classes/layer/
- UXP Document 保存格式与图层操作：
  https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document
- 官方 Smart Object 过滤（嵌入/本地链接/缺失/过期）：
  https://helpx.adobe.com/photoshop/desktop/create-manage-layers/smart-objects/filter-the-layers-panel-by-smart-objects.html
- 更新或重链外部智能对象：
  https://helpx.adobe.com/photoshop/desktop/create-manage-layers/smart-objects/update-linked-smart-objects.html
- 替换智能对象内容：
  https://helpx.adobe.com/photoshop/desktop/create-manage-layers/smart-objects/replace-the-contents-of-a-smart-object.html
- Quick Export 及用户预设的命名/文件格式/位置：
  https://helpx.adobe.com/photoshop/desktop/save-and-export/export-files-to-different-formats/export-your-work-using-the-quick-export-as-option.html
- 图层/组新建独立文档：
  https://helpx.adobe.com/photoshop/desktop/create-manage-layers/get-started-layers/create-document-from-layer-or-group.html
- 多层对齐 / 分布：
  https://helpx.adobe.com/photoshop/desktop/create-manage-layers/create-layer-compositions/align-content-of-layers-and-groups.html
  https://helpx.adobe.com/ca/photoshop/desktop/create-manage-layers/create-layer-compositions/distribute-layers-groups-evenly.html
- 画板专用选项（第 5 类自动嵌套锁、解散、尺寸）：
  https://helpx.adobe.com/photoshop/desktop/create-manage-layers/layout-design-tools/artboard-properties.html
- 选择相似图层：
  https://helpx.adobe.com/ca/photoshop/desktop/create-manage-layers/transform-manipulate-layers/select-layers.html
- Photoshop 2026 Grain & Clarity/Dehaze：
  https://helpx.adobe.com/ph_fil/photoshop/desktop/whats-new/photoshop-on-desktop-release-notes.html
  https://developer.adobe.com/photoshop/uxp/2022/ps-reference/modules/constants
- 官方性能建议（缩小或禁用缩略图）：
  https://helpx.adobe.com/photoshop/desktop/troubleshoot/performance-stability-issues/fine-tune-photoshop-features-for-performance.html
- `batchPlay` 官方建议先优先考虑 DOM，再用描述符弥补空缺；复杂描述符需录制、核对及实机测试：
  https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/batchplay

## 建议开发次序

1. **一轮短周期：高级筛选 + 选择相似层**；尽量只修改 `TreeLayer` 的查询/UI，不新增高风险宿主写操作。
2. **智能对象维护**：先做链接丢失/过期告警的只读展示，再做替换/重链/更新写入功能。
3. **蒙版密度/羽化和 2026 新调整图层**：已有官方属性/类型，适合补齐参数与功能菜单。
4. **导出选中图层和多层对齐/分布**：设计交付价值很高，但必须明确输出边界、用户路径和原生 PS 行为。
5. **画板专属管理、缩略图模式与其它长期功能**：待性能和真实宿主 API 验证完成再做。

## 不建议重复做的

- 重新实现已有的图层树、多选排序、蒙版/FX 拖拽、智能对象断开链接；
- 再增加常驻工具栏的一排图标——优先二级菜单；
- 恢复 WaveLayer Delete 键拦截（曾间歇性失败且用户已决定停用）；
- 未经实测的浮动窗口/原生 Hybrid addon；
- 为了“功能齐全”增加 3D、视频动画、复杂图层复合系统。

**审计与建议不等于已编码或已经通过 PS 实机验证。本文件只做功能研究，没有修改 WaveLayer 执行逻辑。**
