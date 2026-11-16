# WaveLayer 内嵌编辑工作台技术 Demo（2026-11-04）

## 2026-11-13：重做一期（工作台 + 右键发送到）与后续规划

一期已实现，内容见 `docs/README.md` 11-13 条目。代码：`core/layers/workbench.ts`（纯模型：去重、持久化、按 docKey 重绑、状态、选择、设置）、`core/layers/placementRestore.ts`（位置还原）、`ui/workbench.ts`、`ui/workbenchStore.ts`、`ps/uxpWorkbench.ts`（置入 / 发送）、`LayerTree.openDocs / probeStaged`。测试：`workbench_model`、`placement_restore`、`workbench_send`，以及原有 `workbench_*`。

二、三期已在同日实现（helper 0.11.0），见 `docs/README.md`。下面是当时的规划：
- **二期**：helper 原生「工作台」surface（参照外置生成面板），切换文档时一直显示；发布为放置目标，从任意文档拖进去暂存；helper 连接时内嵌区收起。
- **三期**：从浮窗拖出：到 PS 置入当前文档（精确到图层行要先验证屏幕坐标映射）；到其他软件复用 OLE / Illustrator 通道；暂存时存 PNG 快照，源关闭后按快照置入为智能对象；（可选）从资源管理器拖入文件。
- 一期没做的：清单内拖动排序、从工作台拖回图层列表定点置入、置入后转智能对象。

## 2026-11-04：精简工作台 GUI / 确认失败原因的兼容性提示

根据实际用户测试，跨 RGB → CMYK 的色相/饱和度复制目前已经能够成功运行，本轮不再改动核心复制顺序；重点改为**精简控制和可靠提示**。

### GUI 变化
- 移除「加入已选图层」按钮。仍然通过 WaveLayer 图层行正常拖入工作台，支持多选和整个图层组。
- 底部原「放入当前文档」替换为单色线框 **置入图标**，悬停 title/ARIA 显示文字说明。图标使用 SVG，不会在执行中被替换成文字；执行中禁用重复点击。
- 底部原「导出 · 待接入」替换为线框 **导出图标**，该功能仍未开发，保持禁用，悬停有说明。**没有假装实现真正的导出动作**。
- 底部两图标靠右对齐；原工作台折叠、拖入提示仅在拖动出现、底部箭头行为均保持不变。

### 兼容性提示规则
- **无格式差异、操作成功**：不弹警告，保留一行成功状态。
- **格式差异但复制成功**：显示可关闭的非模态内嵌提示；对比 Photoshop Document 的颜色模式、位深、颜色配置文件（仅在双方数据已知且不同的情况下报告）；提示检查颜色、蒙版、调整层编辑参数，但不将“格式不同”视为“复制失败”。
- **实际失败**：红色边线的内嵌错误详情，按失效来源文档、图层已删除、源引用无效、复制未生成目标层、部分复制、目标新增数量不符、文件夹建组失败、图层移入失败、组内容校验失败等分别给出**已确认的错误现象**及行动建议。
- 若 Photoshop 没有提供可以确定的内部错误原因，明确提示 **“原因待确认”**，不猜测一定由 RGB / CMYK 引起；保留「查看原始错误」折叠入口用于排查。
- 不增加反复弹出的系统模态对话框，不会自动栅格化、跳过失败图层、更改文档颜色模式，也不会因仅有格式差异而阻止用户工作。
- 在 `src/core/layers/workbenchCompatibility.ts` 维护可测试的通知与诊断类型；`src/ps/uxpWorkbench.ts` 返回成功后的格式差异列表，抛出携带已确认现象/建议/原始异常的类型化错误；`src/ui/workbenchDemo.ts` 负责显示、关闭和展开技术详情。

### 测试
- `node --test tests/workbench_compatibility.test.ts tests/workbench_color_mode.test.ts tests/workbench_placement.test.ts`：确认多种格式差异和未知异常的提示准确，不把模式差异误判为复制失败。
- `npm run typecheck`、`npm test`、`npm run build` 全部通过；全套测试 **132/132**。
- **Photoshop UI 的实际显示尚需重新加载开发版并确认**。建议在 `WavePlug_TEST_` 临时文档中测试三种情况：普通成功；RGB→CMYK 成功后提醒；关闭来源 PSD 后看到“来源已关闭”的明确原因。不要在正式 PSD 里进行破坏性测试。
- 代码仍是 `local-test` 工作树里的未提交改动；用户先前要求的 Git 基线 `85bce50` 不变。

---

## 2026-11-04：RGB → CMYK 调整图层「复制数量不符」保护

**症状**：从 RGB PSD 向 CMYK PSD 复制色相/饱和度等调整图层时，插件提示「复制后目标 PSD 新增图层数量不符，预期 1，实际 0」。原因不能简单归结为色相/饱和度在 CMYK 不支持：该调整本身在 CMYK 可用，但跨模式复制有时会返回原图层代理却没有在目标 PSD 里生成实际图层。不同模式下其他调整类型的支持和视觉效果也可能不同。

**变更**（`src/ps/uxpWorkbench.ts`）：
- 依据来源/目标 `Document.mode` 比较 RGB、CMYK 等颜色模式。
- 当颜色模式不同、同一批里同时包含普通图层和调整图层时，逐个隔离调整图层的复制，避免 Photoshop 悄悄丢失一个调整层、但成功复制了其他层。
- 每次复制都以目标文档真实新增的**根图层 ID**为准，不能因为 Photoshop 返回了 `Layer[]` 就认为复制成功。
- **零新增 + 单个图层**时尝试 `Layer.duplicate(target)`，无论前一个 `Document.duplicateLayers` 返回正常还是抛错；若确实出现目标层才算成功。
- 两种原生接口都零新增时，抛出**包含具体层名、来源颜色模式、目标颜色模式**的错误；**不自动跳过、栅格化调整层，也不转换用户的源 PSD 或目标 PSD 的颜色模式**。
- 已经部分复制成功的批次不自动重试，继续用原有 Photoshop 历史事务回滚路径，以降低重复副本风险。

**回归测试**：`node --test tests/workbench_color_mode.test.ts`。新增场景：原生批量 API 返回代理但目标零新增；单层 API 成功补救；两种 API 都静默失败；RGB 调整层混合普通像素层批量；部分复制不可重试。首次运行旧代码复现「预期 1，实际 0」，补救后红→绿。当前完整测试 **128/128**、TypeScript 检查和构建均通过。**尚无 Photoshop 真机针对 RGB → CMYK 调整层的实测成功证明**，需在临时 PSD 中测试。

**官方资料**：
- <https://developer.adobe.com/photoshop/uxp/ps_reference/classes/document/> — `Document.mode`, `duplicateLayers`。
- <https://developer.adobe.com/photoshop/uxp/ps_reference/classes/layer/> — `Layer.kind`, `duplicate`。
- <https://helpx.adobe.com/photoshop/desktop/adjust-color/color-corrections/apply-a-hue-or-saturation-adjustment.html> — CMYK 中的色相/饱和度调整。
- <https://helpx.adobe.com/photoshop/desktop/adjust-color/color-modes/convert-an-image-to-another-color-mode.html> — 颜色模式转换会改变颜色值。

**复测建议**：先在 `WavePlug_TEST_` RGB 小图层中添加可编辑「色相/饱和度 1」，再创建 `WavePlug_TEST_` CMYK 文档，测试从工作台放入；比较能否看到实际的 CMYK 调整层及参数，且图层数量相同。若两种复制 API 都失败，用户可以改在 CMYK 中创建新调整层并重新输入参数，或将 RGB 效果封装成智能对象以保留 RGB 内编辑；不能宣称跨模式调整视觉一致。

---

## 2026-11-04：27 项暂存放入时报 `Cannot read properties of undefined (reading 'map')`

- 用户截图显示 **27 项**，目标 PSD 放入失败；插件提示 TypeError `Cannot read properties of undefined (reading 'map')`。
- 与此前同环境 **4 项跨 PSD 成功**的实机日志形成对照：`workbench target copies ... count:4` 和 `workbench placed ... count:4`；本次日志只看到暂存 27 项，没有复制成功记录。**不能仅凭日志断言错误一定在 `duplicateLayers` 内部**，因此新增了分阶段日志和精确的复制失败提示。
- 紧密回归：`node --test tests/workbench_placement.test.ts`。先在隔离 Photoshop DOM mock 中让 27 个图层触发 `undefined.map`，修改前测试失败并复现同样的 TypeError，修改后全部通过。
- 实现：`src/ps/uxpWorkbench.ts` 现在每次最多复制 **4** 项（当前环境有 4 项成功的实机记录）；若该批次抛错且**目标 PSD 没有产生新图层**，则拆成小批次再试；若单图层 `Document.duplicateLayers()` 也失败且无副本，就尝试官方 `Layer.duplicate()`。所有新图层 ID 仍从目标文档自身图层树重新定位，不再复用来源 Layer proxy。
- 如果批次在抛错前已**部分**复制到目标文档，明确**拒绝自动重试**以免制造重复素材，由原有 `step()` 尝试回滚。任何不能确认完整数量的复制也中断。
- 覆盖测试：27 个素材拆批成功；四项仍失败后再二分；宿主出现部分复制时坚决停止；源/目标图层 ID 碰撞保护。仍属 mock 测试，实际 Photoshop **尚需重新加载 Dev 插件并用临时 PSD 验证**。
- 修改不影响来源 PSD；不清空工作台。注意此前失败时历史事务不保证完全清掉目标 PSD 副本，重新执行之前先检查目标是否有上次留下的复制件。

---

## 2026-11-04：跨文档放入时 `You can only move layers in the same document.`

- 本次实际错误来自 `reports/uxp_runtime.log`：目标 docId=`978`，新组 id=`105`，移动图层 id=`296` 时，Photoshop 报 `You can only move layers in the same document.`；用户截图确实在「放入当前文档」阶段失败。
- 旧代码直接对 `src.doc.duplicateLayers(sourceLayers, target)` 返回的 `Layer` 对象调用 `move(group, PLACEINSIDE)`。在跨 PSD 情况下，返回对象可能仍被宿主绑定到来源文档；即使视觉上的副本创建在目标，`move()` 依然以源对象上下文执行。
- 修复：每个来源批次复制前记录**目标文档全部图层 ID**，复制完成后只选择目标文档中新增的顶层对象（自动排除被复制组的子图层）；仅用目标新生成的 ID 和从 `target.layers` 重新获取的目标图层对象进行移动。**不对返回的跨文档 Layer proxy 调用 move()**。如果 Photoshop 返回的 ID 不等于目标生成 ID，按目标文档新增图层快照回退；若新生成层数量不匹配，则主动中止并进入原有回滚路径，避免误动旧层。
- 红绿回归命令：`node --test tests/workbench_placement.test.ts`。修改前模拟源文档绑定 proxy 时**红灯**，复现与实际截图完全相同的英文异常；修复后**绿灯**。额外加入目标已有图层与源返回 ID 碰撞的用例，验证不误移动已有图层。
- 局限：这仍是 **mock UXP API 回归测试**，尚未在 Photoshop 实际文档完成跨文档移入验证（当前 Photoshop MCP 返回 `Photoshop info not available`）。请先在独立 `WavePlug_TEST_` 临时文档里验证 1/4 个图层、组及蒙版，再测试正式 PSD。第一次失败时此前目标 PSD 可能已留下副本，测试前先检查。

---

## 2026-11-04：「放入当前文档」多图层建组失败诊断与修复

- 用户报告五个工作台项，点击放入后显示 `Photoshop 未成功建立图层组`。
- 此消息来自旧 `src/ps/uxpWorkbench.ts` 的 `if (!group || group.id === undefined)`，而非 Photoshop 原生的错误文本。旧代码尝试一次调用 `target.groupLayers(copied)`，当没有得到有效返回值时立即报错。日志证实此前单图层跨文档放入成功过，但本次失败没有记录 `groupLayers` 的具体宿主返回值，**无法断言组是否已经被创建**。
- 官方 API 支持 `Document.createLayerGroup({name})` 和 `Layer.move(group, PLACEINSIDE)`，因此改为：先复制、创建空文件夹，再将复制件逐个移动进去；最后重新读取目标文档图层树，按 ID 验证每一个复制件在新文件夹里。任何失败都会触发原有目标文档 `step()` 的回滚流程，并显示更具体的错误。
- 回归环：`node --test tests/workbench_placement.test.ts`。**旧代码红灯**：模拟 `groupLayers() === null` 时抛出与用户截图一致的错误；**改后绿灯**：实际 `placeWorkbenchLayers` 在同一隔离 UXP mock 中建立含两个 AI 图层组的文件夹。全套测试 116/116、TypeScript 检查、构建均通过。该 mock 测试不能证明 Photoshop 真机完全兼容。
- **需要真机验证**：重新加载 `WavePlug 图层 Dev`，用临时 `WavePlug_TEST_` PSD 在两个来源 PSD 之间放入多图层 / AI 图层组；确认新文件夹实际存在、内部数量和 Photoshop 历史可撤销，若失败记录 `reports/uxp_runtime.log`。
- Git 仍保留之前用户要求提交的基线 `85bce50`；本轮工作台源码与修复未提交，不修改用户原 PSD。

---

## 2026-11-04 新增：一键放入当前文档 + 拖拽提示和收起箭头

已在现有内嵌工作台上继续实现：

- **放入当前文档**按钮：把工作台全部暂存的图层引用复制到**当前活动 PSD**，统一建立一个真正的 Photoshop 文件夹图层，名称默认为 `工作台素材`，重复插入自动命名 `工作台素材 2` 等。保持源 PSD 图层不变，暂存清单不清空，便于继续向其他 PSD 放置。
- 使用 Photoshop 公开的 `Document.duplicateLayers(layers, targetDocument)` + `Document.groupLayers(copies)`。按来源 PSD 批量调用，提高多图层场景效率；图层位置按 Photoshop 的原生跨文档复制行为保留，不自动缩放/居中。
- **先验全部来源，再执行写入**：源 PSD 已关闭、图层已删除或 ID 不合法则直接失败。若同时暂存父组和它的子孙图层，实际只复制父组，避免组内元素重复出现。所有目标文档写入包含在一次 `step()` 历史事务中，复制或建组失败应回滚目标 PSD。支持 Ctrl+Z。
- 「放入中」状态禁止重复点击；开始复制前让 UI 有机会绘制执行提示；Photoshop modal 过程中按批次报告进度。返回成功时显示数量和文件夹名，失败显示原因。快速导出按钮仍未接入、保持禁用。
- **上方拖入提示**：仅在图层拖拽进行中显示。正常打开工作台查看、操作清单时完全隐藏，节省空间。
- **下方独立箭头**：在工作台区域下方居中，展开后一直显示，可以收起。收起时工作台和箭头都隐藏；开始拖动图层自动弹出工作台和箭头，取消则重新隐藏。原有底部「工作台」按钮继续保留，允许不拖拽时手动展开。
- 临时弹出的工作台依然覆盖图层列表底部，不改变列表原有高度；成功拖入后固定成为列表下方子栏目。
- `src/ps/uxpWorkbench.ts`：写入 Photoshop 的单事务流程；`src/core/layers/workbench.ts`：来源分批、父子去重的纯函数；`src/preview/main.preview.ts`：预览模式也模拟文件夹插入；`tests/workbench_demo.test.ts`：来源分批和父子去重测试。

Photoshop 官方接口：
- <https://developer.adobe.com/photoshop/uxp/ps_reference/classes/document/> （`duplicateLayers`, `groupLayers`）
- <https://developer.adobe.com/photoshop/uxp/ps_reference/classes/photoshop/> （`activeDocument`）

**验证限制**：源码 TypeScript、Node 测试与构建通过不等于 Photoshop 内真实跨文档图层复制已验证。应先在 `WavePlug_TEST_` 临时 PSD 中测试 1 层、同文档多层、两个不同来源 PSD、多层包含蒙版/效果/智能对象及失败回滚。大型 PSD 可能因 Photoshop 内核耗时而卡顿。无需修改原来的 WavePlug Studio 面板。

---

## 为什么改方案

用户两次测试均确认：Photoshop Windows UXP 的**跨独立浮动面板拖放**不可靠；原 HTML 追随提示无法跨越源面板的 GUI 边界。此前的原生 HTML5 技术测试仅成功过一次，不能支撑正式交互。

**决定**：整个编辑工作台放回 WaveLayer **同一 UXP 面板、图层列表下方**，不再依赖跨窗口事件或系统级拖动预览。用户在同一 WaveLayer 内拖动图层，原有鼠标拖放机制可以完成投放。

## 已编码的交互

- 默认收起：不占高度；底部工具行的「工作台」按钮可手动展开/关闭，并显示暂存数量。
- 从普通图层或图层组开始拖动超过 5px 时，工作台自动出现于 WaveLayer 下半部，**以同面板内部的临时浮层覆盖底部区域**，不压缩图层列表高度、不打断原有图层排序。
- 进入工作台范围，整块区域高亮，拖拽提示变为「加入编辑工作台」；在范围内松开鼠标将图层记录到清单，清单仍在图层列表下方，并变为普通固定子栏目。
- 拖离后不高亮；在区域外松开或 Escape 取消后，如果面板是拖动时自动打开的，则重新收起；手动打开过的工作台保持展开。
- 工作台支持图层引用清单、同文档/跨文档去重（`docId:layerId`）、单项移出和清空、来源 PSD 名称。另有「加入已选图层」备用入口。
- 原有图层排序、图层组拖动、蒙版移动和 Alt 复制、左侧红色删除区、底部垃圾桶仍继续使用之前各自的命令；**拖入工作台仅暂存图层引用，不执行移动或删除**。
- 拖拽提示 DOM 从列表内部提升为整个 WaveLayer 面板的绝对定位层，能在列表和工作台之间跟随鼠标，不再被列表 `overflow:hidden` 裁切。
- 「复制到当前文档」与「快速导出」在此**仅做禁用的视觉占位**，因为用户要求先快速验证交互。后续应接官方跨文档图层复制与导出 API，并处理源文档关闭、图层删除导致的失效引用。

## 代码

- `src/ui/layerTree.ts`：同一 panel 内接收拖拽，临时展现工作台、光标命中检测、投放优先级和重排防误触；全 panel 追随提示
- `src/ui/workbenchDemo.ts`：可折叠、自动展开的工作台 UI（实际仅创建在图层 panel）
- `src/ui/workbenchStore.ts`：独立清单状态和观察者；仅保存引用
- `src/core/layers/workbench.ts`：去重与坐标命中纯函数
- `src/main.uxp.ts`：移除 Studio 面板中的旧工作台注入
- `plugin/styles.css`：子栏目、临时覆盖展开、目标高亮、列表与子栏目共享追随框
- `tests/workbench_demo.test.ts`：跨文档去重、添加/移除/清空、监听与最终松开坐标

先前用户要求提交原有插件，Git 基线为 `85bce50`（`local-test`），**新的工作台 Demo 仍保持未提交**，可单独回退。

## Photoshop 手动验证清单

1. 在 Photoshop 2026 中重新加载「WavePlug 图层 Dev」；不需要额外安装程序、也不需要在 Studio 面板放接收框。
2. 初始应该只有底部「工作台」切换按钮，没有工作台内容。
3. 打开临时 `WavePlug_TEST_` PSD，抓住一个图层主行直接拖动；工作台应自动出现在图层列表下方，跟随提示不应在列表底部被裁切。
4. 在工作台任意位置松开：应显示名称/来源；原文档图层数量和顺序完全不变。收起后再按「工作台」仍应看到已暂存的内容。
5. 再试多选、按住 Alt（暂存不应变成复制）、拖入前移出工作台取消、按 Escape 取消。
6. 原来的图层排序、拖到组内、拖到红区删除、拖到底部垃圾桶删除、蒙版/图层效果的移动和 Alt 复制，需要分别做回归。
7. 如果 PSD 很大，请避免测试大画板删除；它与此工作台改造无关。

**当前结论**：TypeScript 与 Node 自动化测试通过不等于 Photoshop 内鼠标追随 / UI 重绘已完成实机验证。本轮没有实际执行 PSD 修改或调用 Photoshop 批处理。
