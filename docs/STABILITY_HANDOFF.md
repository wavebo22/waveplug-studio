# 稳定性 / 性能修复交接（2026-11-03）

另一个 AI 做了源码审查，这一轮逐条核实并修了一部分。**全部只改了源码并打包，没有提交**；`npx tsc --noEmit -p .` 通过，`npm test` 98 个全过，`dist/` 已重新打包。

## 1. 已修（确认程度：只打包，用户未在 PS 里确认，除非另注）

| 问题 | 改了什么 | 位置 | 测试 |
|---|---|---|---|
| WebSocket 建连前 close / 无响应时 `waitFor` 永久卡住（已复现：`STUCK historyCalls 0`） | `connectWs` 一定结束：close-before-open、error、超时（默认 5 s，不超过任务超时）都 reject，之后只轮询 `/history` | `src/core/comfy/client.ts` | `tests/comfy_ws.test.ts` |
| 首次扩图：`addVariation` 失败时结果图丢失，画布已扩大、留下空组 | 三步都在 try 里，失败一律 `StashedResult`（结果可另存），提示写明哪几步已改了 PSD、要撤销哪几条历史 | `src/app/generate.ts`（runOutpaint 写入段） | `tests/outpaint_run.test.ts` |
| 缩略图 -32005（日志 324 条，全是"PS 正忙"：无法更新智能对象文件 / 不能使用移动工具…）失败 3 次后永久缓存为空 | 退避重试 2.5 s 起翻倍、最长 60 s、一直重试，旧图保留；只有 Unknown layer/document 算没有图；`imageData` 为空当空图层（修了 `reading 'dispose'` 崩溃） | `src/ps/uxpLayers.ts` `thumbnails()`、`src/ui/layerTree.ts` `fetchThumbs/scheduleRetry`、`src/core/layers/thumbs.ts` `thumbRetryDelay` | `tests/layer_tree.test.ts` |
| 开发版 ⟳ 累积 document/window 监听和 400 ms 定时器 | `ui/dom.ts` 新增 `listen()` / `every()` / `disposeGlobals()`，所有全局监听改走它；`__waveplugDispose` 调 `disposeGlobals()` | `src/ui/dom.ts`、各 UI 文件、`src/main.uxp.ts` | `tests/dom_globals.test.ts` |
| 连点 ⟳ 时多个版本同时存活（日志里 1 秒内 5 次 start dev、缩略图日志成对） | loader 在异步读文件**之前**调 dispose；新版本启动时再调一次上一个的 dispose（没改 loader，不用重装） | `src/main.uxp.ts` | — |
| 参考图把整张原图转成 base64 当缩略图 | 文件：PS 打开 → 读 128 px → 关闭（`UxpHost.imageFileThumbnail`；文件已打开时就地读、不关）；失败显示扩展名。剪贴板：先缩到 128 px 再编码。上传仍用原图字节 | `src/ps/uxpHost.ts`、`src/main.uxp.ts` `pickImage`、`src/ui/app.ts` `pasteReference` | — |
| 参考图没有删除按钮 | 右上角 ×（`.ref-del`），和菜单里"移除"共用 `removeRef()` | `src/ui/app.ts`、`plugin/styles.css` | — |
| `History state is already suspended` 不重试 | `whenFree` 也按 PS 正忙重试 | `src/ps/uxpLayers.ts` | — |
| 删除时选中里有刚删掉的图层 → `无法执行「select」` | 面板过滤掉不在最新读取里的 id；`run()` 的 `prepare` 只选文档里还存在的图层 | `src/ui/layerTree.ts` `deleteSelected`、`src/ps/uxpLayers.ts` `run` | — |

## 2. 图层选择与 Delete：自动选中下一层、点击空白取消选择（已构建，PS 待复测）\n
**2026-11-04 快捷键专属焦点修复**：用户反馈 Delete 快捷键偶发失效，但垃圾桶和拖拽删除正常。已将快捷键监听改为 `window` 捕获阶段；删除 / 选层后延迟重试焦点；实体的第二次 Delete 在前一次删除忙时最多排队一次，并在刷新后按 Photoshop 真实选中层继续。新增无上限快捷键事件日志，弥补旧版只记录前 50 次的问题。`npm run typecheck`、`npm test`（102 项）、`npm run build` 通过；**尚未在 Photoshop 实机复测**。详见 [`DELETE_AUDIT.md`](DELETE_AUDIT.md)。


**2026-11-04 图层删除全链路排查**：见 [`DELETE_AUDIT.md`](DELETE_AUDIT.md)。已统一多种删除入口、逐层预检并隔离部分错误、依据宿主实际结果更新选中、加文档切换防护，并检查变体删除。新增纯逻辑测试；**尚未在 Photoshop 实机验证本轮修改**。


**2026-11-03 顶部重排已撤回**：尝试把顶部工具区拆分为独立行并补三个筛选图标 Tooltip，用户反馈“很多地方都错了”，要求撤回。本次仅将 `src/ui/layerTree.ts` 和 `plugin/styles.css` 中该轮重排及三个 Tooltip 修改恢复至此前状态，不撤销此前已完成的 Delete、空白取消选择和百分比框改造。此次重排**不应视为已修复**，后续布局需重新评估。


**2026-11-03 23:13 不透明度 / 填充控件改为 Photoshop 原版样式**：`src/ui/layerTree.ts` 将常驻横向滑杆替换为「标签 + 82 px 百分比框 + 下拉箭头」；填充行在标签前增加锁图标。百分比框可直接输入，Enter / 失焦确认、Esc 取消；下拉箭头展开小型滑块弹层，继续支持拖动精细调整。多选、混合值显示、无选中时禁用状态保留。`plugin/styles.css` 删除常驻滑杆行布局并添加紧凑字段 / 弹层样式。`npm run typecheck`、`npm test`（101 项）、`npm run build` 均通过；**尚未在 Photoshop 实机确认尺寸与交互**。


**2026-11-03 背景图层边界修复（typecheck / 101 项测试 / build 通过，PS 待复测）**：用户在实测时确认只有一个「背景」图层时点击空白会弹出 Photoshop 错误「命令‘取消选择图层’当前不可用」。日志有 `layer panel clear selection blank` 及随后 `layer tree select ... selectNoLayers` 失败；根因不是空白点击命中。`src/ps/uxpLayers.ts` 在 `doc.layers.length === 1 && doc.layers[0].isBackgroundLayer` 时直接跳过 Photoshop 不支持的选择取消命令，记 `layer deselect skipped`；其他情况下改用 batchPlay `_options.dialogOptions="silent"` 并捕获错误，不再弹原生错误窗口。`src/ui/layerTree.ts` 空白点击允许只清除 WavePlug 高亮，缓存 Photoshop 原有选中 ID；当 Photoshop 选择保持不变时不再刷新恢复高亮，等用户重新点图层或 Photoshop 改选时恢复同步；`src/core/layers/tree.ts` 的 `selectionAfterLocalClear` 及相应测试覆盖状态转换。**注意仅剩背景时 Photoshop 实际仍有一个活动图层，WavePlug 列表清空高亮不等于 Photoshop 真实无选层。**

**2026-11-03 22:53 新增图层列表空白单击取消选择**：`src/ui/layerTree.ts` 在列表 `list`/`inner`（或空结果提示）空白处的普通左键单击时，将 UI `selected` 置空、`anchor` / `focus` 清理，并使用共用的 `commitSelection()` 队列调用 `tree.select(doc, [])`，同步执行 Photoshop `selectNoLayers`。仅响应在空白区开始且位移不超过 4 px 的普通左键点击，不响应图层行、滚动条、工具栏、搜索或拖拽释放；复用 `selectGen` 避免旧 Ctrl/Shift 选层任务回写。已更新图层列表提示文本。`npm run typecheck`、`npm test`（100 项）、`npm run build` 通过，**尚未在 Photoshop 实机确认**。

### 之前：自动选中下一图层 + 多选顺序修复（22:42 已构建）

**2026-11-03 22:42 增量修复**：用户反馈单选比之前稳定，但多选仍有问题，要求删除后自动选中下一层。

- `src/core/layers/tree.ts` 新增 `nextLayerAfterDelete()`：删除后优先选择可见列表中下方最近的存活图层；没有则选择上方。多选以最后被删的图层为基准；整组删除会跳过所有后代；没有存活图层就不主动选中。
- `src/ps/uxpLayers.ts` 使用明确的 layer ID 通过 `await act({_obj:"delete",_target:[layerRef,documentRef]})` 执行删除，替代上轮的 `Layer.delete()`（Adobe 官方文档显示该 DOM 方法返回 `void`，不能靠 `await` 确认完成）。成功后在同一 `step()` 内选中候选层，并回读 `targetLayersIDs` 记 `layer delete next` 日志。选中失败只记警告，不回滚已成功的删除。
- `src/ui/layerTree.ts`：删除成功后立刻将面板选中更新成下一层（而不是把已删的 ID 留到下一次 refresh）；Ctrl/Shift 快速选图层改成串行队列，过期操作跳过；删除执行期间拒绝新的行选中，减少模态命令冲突；蒙版删除保持原逻辑。
- `src/ps/host.ts`：`RunOptions.afterDeleteSelect` 可由 UI 指定下一可见行，PS 侧核实图层仍存在再选中。新增单测覆盖单删、多选、父子、最后一层、折叠可见行、过期 ID。
- **验证**：TypeScript 通过；`npm test` **100 项通过**；`npm run build` 完成，`dist/plugin` 已更新。未实际操作 Photoshop，所以**不能写成已修复完成**。未提交 git。
- **PS 复测重点**：测试 PSD 内先 ① 连续单删、② 多选不相邻层、③ 选中父组+子图层、④ 删除底部层、⑤ Ctrl+Z 单步撤销；如果失败比对 `layer panel key`、`layer delete targets`、`layer delete next`、`layer panel delete next`、`layer command delete`。对于 Photoshop 不允许删除的背景层 / 唯一图层，不能强制删除。

### 之前的尝试（保留对照）

**2026-11-03 14:26 这一轮修复**（已打包，PS 部分实测）

**当前结论：这是两个不同的故障，不能归为一个焦点问题。** 最新日志 14:14:55–14:15:03 连续收到 5 次 Delete（其中一次为 4 层多选），说明前一轮的 `blur() → focus()` 在部分场景里能让按键继续送达；然而 14:15:10 又出现 `layer command delete Error: Photoshop 无法执行「delete」`，此时键已经到了插件，错误发生在 Photoshop 删除命令。前一轮 14:09:59 多选也报相同错误。

**本轮改动**（**源码和 dist 已更新，未在 Photoshop 实测**）：

- `src/ps/uxpLayers.ts`：将 `action === "delete"` 从“先选择，再 batchPlay `delete targetEnum`”改为按真实图层 ID 找 DOM Layer 对象并逐个 `layer.delete()`，全部在一个 `step()` 历史步骤中执行；记录 `layer delete targets`（请求的 id 与实际目标）。
- `src/core/layers/tree.ts`：新增 `deleteTargets()`，去掉已不存在 / 重复的 id；如果父图层组和子图层同时选中，只删父组，避免再次删除不存在的子图层。对应测试 `tests/layer_tree.test.ts`。
- `src/ui/layerTree.ts`：Delete / Backspace / 垃圾桶统一增加删除中防重入，避免上一次还没结束就再次对同一批 id 执行删除。
- 现有焦点恢复和日志保留，不盲改。若删除动作成功但后续快捷键仍丢失，再单独处理焦点问题。

**验证**：`npm run typecheck` 通过；`npm test` **99 项通过**；`npm run build` 完成。**这不代表 UXP 真实宿主已验证。** 测试中没有模拟 Photoshop 对象 `Layer.delete()` 的实际行为。

**下一步在测试 PSD 中操作**：点 Dev 面板 ⟳，测试单层连续 Delete、多层 Ctrl / Shift 选择后 Delete、同时选择父组与子层、带蒙版图层（键盘删除蒙版与底部垃圾桶一致）、切到画布再回图层面板后 Delete，最后按一次 Ctrl+Z 确认多选删除是一条历史记录。遇到失败优先读 `layer panel key`、`layer panel refocus`、`layer delete targets`、`layer command delete`；注意背景层 / 锁定层可能本来不可删。若 `layer panel key` 不出现，仍是焦点问题；若出现而报命令失败，检查目标 id 和图层状态。暂时不宣称完全解决。

### 前一轮现场记录（保留用于对照）


**现象（用户）**：刚打开文件时能删，连续删也行；停一会儿/点过别的图层后就删不了；切换一次文档又好了。多选删不了。

**证据（`reports/uxp_runtime.log`）**：

- 键确实能到面板：`layer panel key Delete SECTION … "focused":true`。多选时 `selected` 有 5 个 id，所以多选本身没问题，是按键没到。
- 14:10 那轮只到了**一次** Delete，之后一个都没有；那时 refocus 日志也没出现 → UXP 一直以为 section 有焦点，但键盘已回到 Photoshop。
- 推断：插件自己的 executeAsModal（选中图层 `WavePlug 选择图层`、删除、读缩略图）结束后，PS 拿回键盘；DOM 焦点状态不变，所以 `el.focus()` 什么也不做。

**现在的尝试（未验证）**：`layerTree.ts` 顶部的 `refocus()`——选中、图层命令、缩略图读完、鼠标进入面板时 `el.blur(); el.focus()`，只在指针在面板上（`pointerIn`）时做，免得抢走画布的快捷键（画布上的点击不会到插件的 document，`panelActive` 看不出来）。新增日志：`layer panel key`（前 50 次，带状态）、`layer panel refocus`、`layer panel window focus/blur`。

**下一步**：让用户点 ⟳ 后，鼠标停在面板上多删几轮，读这三类日志。

- 如果 `window focus` 在 refocus 后出现、Delete 又能到 → 方案成立。
- 如果仍然只到第一次 → UXP 不允许插件自己拿回键盘。备选：底部垃圾桶（可用）；给插件加菜单命令，让用户在 PS 键盘快捷键里绑键（**未验证可行**）。用户问过"直接代理原图层面板"：删除本来就是交给 PS 执行的，问题是键收不到，代理解决不了。

## 3. 核实过、还没修（按建议顺序）

| 问题 | 结论 | 位置 |
|---|---|---|
| fetch 失败后 XHR 重发同一请求，`POST /prompt` 可能重复提交 | 属实，概率低。建议只让 GET 回退 XHR | `src/ps/net.ts:33` |
| 活动文档在失败路径不恢复 | 属实。`createFillGroup` / `expandCanvas` 完全不恢复；`addVariation` / `placeUpscaledLayer` 只在成功路径恢复。应放 finally | `src/ps/uxpHost.ts` |
| XHR 没设 `timeout`，fetch 无截止时间 | 属实 | `src/ps/net.ts`、`client.ts` `json()` / `view()` |
| 图层树读取失败就清空列表 | 属实。应保留上一次快照 | `src/ui/layerTree.ts` `refresh()` |
| 图层读取慢（日志 p50 545 ms，最长 304 s） | 只记录 >300 ms 的，看不出正常情况。304 s 那次前后 9 分钟无日志，像 PS 被模态对话框卡住。插件侧真问题：每个 PS 事件都整树重读（148 层约 0.5–1 s）。**先加分段计时再改** | `src/ps/uxpLayers.ts` `read()` |
| `transferDetail` 峰值约 7–8 份整图缓冲（2048² ≈ 100 MB） | 属实，只影响大选区融图。可复用 blur 缓冲 | `src/core/image/compose.ts` |
| 返回图解码前不查总像素 | 属实，防御性 | `src/app/generate.ts` |
| 缩略图缓存无上限 | 属实但很小（几 KB 一张），按文档存，文档关闭不清 | `layerTree.ts` `thumbsByDoc`、`app.ts` `thumbs` |
