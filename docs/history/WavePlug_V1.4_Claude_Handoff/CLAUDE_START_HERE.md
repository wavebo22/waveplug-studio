# PS AI Studio / WavePlug — Claude 开发交接

**设计基线：V1.4（2026-10-30）**  
**目标机器：mainpc / Windows / Adobe Photoshop / 本地 ComfyUI**  
**建议工程目录：`F:\waveplug`**

## 0. 交付包里有什么

| 文件 | 用途 |
| --- | --- |
| `PS_AI_Studio_V1.4_设计与技术交接.docx` | 经整理的完整需求、架构边界、验收标准、阶段计划。**产品需求主文档**。 |
| `PS_AI_Studio_V1.4_UI_Preview.html` | 双击用浏览器打开的**单文件离线可交互原型**，有模拟 PS 画布与图层区。**UI 交互基准**。 |
| `UI_Desktop_V1.4.png` | 插件在模拟 Photoshop 中的整体样式截图。 |
| `UI_Advanced_V1.4.png` | 展开的高级参数与 LoRA 强度截图。 |
| `UI_Calibration_V1.4.png` | 节点下拉校准窗口截图。 |
| `workflow_mapping_example.json` | 节点 ID、字段、PS 数据角色的配置示意（非真实工作流）。 |

**注意**：HTML 是浏览器中的交互原型，不是可直接载入 Photoshop 的 UXP 插件，也没有连接 Photoshop / ComfyUI。图层、生成、LoRA、校准均使用演示数据。

## 1. 请 Claude 首先执行的任务

1. **只读检查 mainpc 现有环境**：Photoshop 版本、UXP 支持、ComfyUI 路径与版本、模型及工作流目录、已有插件和可用连接方式。不得提前卸载、覆盖或升级现有 OpenLayer / ComfyUI。
2. 在 `F:\waveplug` 建立**新工程与全新插件 ID**。避免占用 C 盘（用户应用软件更倾向集中在 D 盘，工程指定在 F 盘）。
3. 阅读 DOCX 与 HTML。先做 **S1 智能对象版本自动化 POC** 与 **S2 PS ↔ ComfyUI 数据闭环 POC**，再进行外观精修。
4. 遵循阶段验收；遇到 UXP API 限制、节点输入已连接导致不能覆盖等问题，明确记录并展示降级策略，不要暗中改写功能范围。
5. 通过 POC 后逐步实现 V1.4 单页工作台。每阶段交付可运行代码、安装说明、测试结果、缺陷清单和回滚说明。

## 2. UI 已确定，不要重新设计页面结构

面板纵向顺序固定：

1. 顶部产品栏（名称 + 连接状态）。
2. **生成历史置顶**：编号 001 / 002 / 003 ...，小缩略图，点击切换智能对象内对应图层独显；不单独开结果页。
3. **工作流选择缩成单行**：紧凑选择器 + 右侧「校准」图标。
4. 提示词文本框。
5. **参考素材紧接提示词下方**：横向缩略图，不额外加标题或分隔线；下方「参考当前画面」开关与选区只读状态。
6. 一个主要「生成」按钮。
7. **高级参数默认折叠**：现有已校准 LoRA 的强度滑块/数值框，及已映射的步数、随机种子等。
8. 底部状态信息。

视觉：暗色、扁平、硬边、紧凑、无金属质感，不堆渐变装饰。HTML 内左侧“模拟 PS 画布”和右侧“模拟图层面板”只是展示上下文，**不是插件要另做的页面**。

## 3. 用户最终确认的产品逻辑

- **单一生成入口**，不再分“AI 生成”与“局部编辑”两页。
- 选区由 PS 决定。有选区就使用选区；无选区则默认为画布。要保留羽化灰度蒙版，不得只用外接矩形。
- “参考当前画面”开启时尝试把 PS 画面作为工作流的图像输入；关闭时从零生成。**只有对应工作流支持该路径时才允许执行**，不能默默向要求图片的编辑工作流送空值。
- 参考素材可来自 PS 图层或外部图片，按已手动校准的槽位逐一上传与绑定；不要猜测哪个图片对应哪个节点。
- 工作流仍由用户在 ComfyUI 内手动编辑，包括模型、LoRA、ControlNet、节点连接。PS 插件只在**执行副本**中覆盖已校准的输入字段，绝不自动增删/重接 LoRA 节点。
- 已存在的 LoRA 强度可在高级参数中调整。若需要 MODEL 与 CLIP 两个参数为 0 才真正关闭，两者都必须先映射/验证。
- 同一生成任务使用一个 Photoshop 智能对象；每次完成后在内部追加真实 PS 图层 001、002...，点击历史版本进行独显。用户可双击智能对象进入内部 PSB，亲手修改、保存、删除某层。**插件不能阻止或覆盖这些手工编辑**。
- 版本编号永久递增，不因删除重新编号。删除最新版本后，下一次也不能复用旧编号。
- 新任务与续写旧智能对象应由**显式选中目标智能对象 / 显式建立任务组**区分，不能只靠选区坐标相同就擅自合并。

## 4. 技术方案与谨慎点

### 4.1 Photoshop 端（建议 UXP Panel）

- 读取：当前文档、图层、可见合成像素、活动选区及其灰度蒙版、画布尺寸、参考图层。
- 回写：先核对生成任务创建时的文档与目标智能对象是否仍存在；再在 modal scope 内回填。
- 所有改动应非破坏性、可撤销；不要直接覆盖原始设计图层。
- 真实智能对象内部 PSB 追加与 Layer Comps 自动切换是 **首要技术风险**。Photoshop 原生支持智能对象 Layer Comps，但自动化链路必须通过真实 POC 验证。若失败，可以阶段性用普通新图层做“连通性演示”，但**不得冒充最终需求已经完成**。
- 浏览器 HTML 内置 SVG/CSS 的表现方式不能假定全部直接支持 UXP；必要时以适配后的原生 HTML/CSS 或 Spectrum 控件实现相同布局与行为。

### 4.2 ComfyUI 通信端

- 以用户当前**已能运行的工作流 API JSON**作为原始模板。克隆内存副本，按映射字段写入值，再提交，不覆盖原始 JSON。
- `GET /object_info` 获取当前节点类型的输入定义；对应节点 ID 和字段名必须从真实 API JSON 中读取。
- `POST /upload/image`、`POST /upload/mask` 上传所需资源；`POST /prompt` 提交；`GET /history/{prompt_id}` 获取结果；`GET /view` 取回图片；`/ws` 跟踪过程。
- 输出映射指定**结果节点及输出项**，不是把 PS 图片写入 Save Image 的 images 输入。
- 如果输入字段已经通过其他节点连线而不是可替换的文件/字符串参数，需用户在 ComfyUI 手动提供适配入口；本版本不改图连线。
- 非本插件任务的队列不应被“取消任务”误打断。
- 服务默认 `127.0.0.1:8188`；不要向公网开放。UXP 网络权限、文件访问与 WebSocket 必须实机验证。

### 4.3 任务状态与安全回填

- 生成前快照：文档 ID、目标 SO ID、任务 ID、选区 bounds+mask、图像尺寸、工作流指纹、映射版本。
- 返回前复核目标仍有效；用户在等待时切换到另一个 PSD，不能把结果写进当前活动 PSD。
- 出错时显示原因并把结果留在暂存区；不创建空白智能对象、不覆盖原图。临时文件要可控清理。
- 区分“接口有效/工作流可执行/模型视觉效果好”三个不同概念。

## 5. 建议开发顺序（不要跳步）

| 阶段 | 范围 | 验收门槛 |
| --- | --- | --- |
| P0 | 只读环境检查、全新 UXP 工程、连接状态 | 不碰已有插件/模型；面板可安装打开。 |
| P1 | **智能对象 POC**：同一 SO 内手工/程序追加 001/002 并从主文档切换 | 能实测创建、切换、手工编辑/删除与正确同步。 |
| P2 | **通信 POC**：PS 图像/蒙版/提示词 → 固定 Qwen 工作流 → 返回图片 | 节点数据不串位，选区外源像素不改变，失败安全。 |
| P3 | 节点下拉校准与映射保存/校验 | API JSON 不被覆盖；更新后错误映射被阻止。 |
| P4 | V1.4 全 UI、参考图槽、LoRA 滑块、历史版本 | UI 顺序和 HTML 原型一致；只调整已映射字段。 |
| P5 | 回归与打包 | 多 PSD、断线、取消、缺节点、16-bit/Alpha 边界均有报告。 |

**首个 Demo 只需一个已验证的 Qwen-Image 2.1 工作流，固定 1 主图片 + 1 蒙版 + 1 提示词 + 1 最终输出。** 参考图和 LoRA 扩展在稳定闭环后增加。

## 6. Claude 可以直接接受的任务指令

> 读取当前目录中的 `PS_AI_Studio_V1.4_设计与技术交接.docx`、`PS_AI_Studio_V1.4_UI_Preview.html` 和本文件，接手 PS AI Studio（WavePlug）Demo 开发。V1.4 的 UI 布局与交互顺序是已确认的产品设计，不要擅自更改。请先只读检查 mainpc 上的 Photoshop、UXP、ComfyUI 和已安装插件，建立 `F:\waveplug` 下的独立开发工程，不覆盖原环境；优先用最小 POC 验证“真实 Photoshop 智能对象内部追加版本 + Layer Comp 切换”和“PS 图像/选区蒙版 → ComfyUI → PS 的完整传输”。工作流由用户在 ComfyUI 维护，PS 插件只对已校准字段执行参数替换，绝不自动增删或重连 LoRA 节点。每一步实际验证、保留日志和可回滚版本，遇到不支持的技术功能须说明，不要用假的成功提示掩盖。

## 7. 官方资料

- [Adobe UXP 概览](https://developer.adobe.com/uxp/)
- [Photoshop Selection API](https://developer.adobe.com/photoshop/uxp/ps_reference/classes/selection/)
- [Adobe executeAsModal](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal)
- [Photoshop 智能对象内 Layer Comps](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/create-layer-compositions/create-and-manage-layer-comps.html)
- [ComfyUI 官方服务器接口](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [ComfyUI WebSocket 消息](https://docs.comfy.org/development/comfyui-server/comms_messages)
