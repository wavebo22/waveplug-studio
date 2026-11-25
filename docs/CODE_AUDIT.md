# 代码检查记录

逐项检查重复接口、冗余代码 / 数据和 bug 的结果。**只记录，没改代码**；修了一项就在那一项后面写「已修（提交号）」。

## 2026-11-25 第一轮

基线：`npx tsc --noEmit -p .` 0 错误；`npm test` 404/404；`cargo check --target x86_64-pc-windows-gnu --all-targets` 0 警告。TS ↔ Rust 的消息类型（`src/core/overlay/protocol.ts` ↔ `native/overlay/src/protocol.rs`）一一对应，没有重复或缺失的接口。

### Bug

1. **开发版热重载时定时器泄漏**。每次构建自动重载（`main.uxp.ts` 的 `__waveplugDispose`），下面这些裸 `setInterval` 不会被清，旧的继续跑，重载 N 次就有 N 份：
   - `src/ui/app.ts` `watchCanvas`（200 ms，读 PS 画布并发 `canvas` 给 helper，旧的也发）
   - `src/ui/app.ts` `setInterval(shareAppSettings, 2000)`
   - `src/ui/layersPanel.ts` 读画布范围（每次 4 次 PS 查询）
   - `src/ui/hintBar.ts` 1 秒的 `sync`
   - `src/ps/uxpHost.ts` `probeStalls`（200 ms）
   `src/ui/dom.ts` 已有会随 `disposeGlobals()` 清掉的 `every(fn, ms)`，但没人用。只影响开发版（正式版不自动重载）。
   小问题：`uxpLayers.ts` 的 `onEdited` / `onChange` 丢掉了 `onModalDone` 返回的 off，`onChange` 的 80 ms 定时器 dispose 时不清（注册表是模块内的，重载后旧的不会再被触发，实际无害）。`overlay.ts` dispose 时 `appSettings/keys/report/wanted/webDrop` 五个监听集合没清（连接已关，无害）。
2. **helper 过旧的提醒失效**：`EXPECTED_HELPER_VERSION` 还是 `0.15.0`，而功能门槛最高到 0.21.0、helper 已是 0.28.0；装着 0.15–0.27 的旧 helper 日志也不报「outdated」。11-25 新加的 `canvas` 消息（0.28）没有任何版本判断。

### 冗余代码 / 数据

- `layer-drag-start`：`layerTree.ts` 在最外层又发一次第一层缩略图 `thumb`（与 `layers[0].thumb` 重复），Rust `host.rs` 直接 `thumb: _` 丢掉；Rust `protocol.rs` 还留着旧版插件的 `layerId` / `name` 兼容字段和 `host.rs` 里的兜底分支。helper 与插件强绑定，可删。
- 12 个按功能分的 `*_HELPER_VERSION`；`BARMODE` / `MONITOR` / `HANG` 只出现在注释里。按「helper 一定在线」的设计，可合成一个版本号，连同面板侧的退路（面板自己的红色删除区、自己的菜单、面板内状态栏）。
- 没人调用：`src/ai/model.ts` `depthOf`、`parentKey`；`src/core/workflow/profile.ts` `bindingFingerprint`；`src/ui/workbenchStore.ts` `resetWorkbenchForTests`；`src/ui/dom.ts` `every`（见 bug 1，修的时候用上）。
- 旧安装流程：`scripts/package_ccx.py`、`install_ccx.cmd`、`install_dev.cmd`、`uninstall_legacy.cmd/.ps1`；现在发布是 `release.mjs → package_setup.mjs`（setup.exe）。`ai/install_dev.cmd` 仍在用，别删。
- 历史资料：`poc/`（含 832 KB 的 PSD）、`reports/` 里 10-31 的实测记录。

### 文档过时

- `docs/DEVELOPMENT.md`、`docs/PROJECT_STATUS.md` 还在教 `package_ccx.py` / `install_ccx.cmd`。
- `native/overlay/HANDOFF.md` 3.3：性能监视已并入底部状态栏（`monitor.rs`），不再是右下角独立窗口。
- 底部状态栏位置在 `monitor.rs` 的 `bar_rect` 算，没走 `layout.rs`（与 4.0 节「只由 layout.rs 决定」不一致）。
- `CHANGELOG.md` 1.3.3 写「WavePlug 程序 0.17.0」，实际 0.28.0。

## 2026-11-25 第二轮

范围：`src/core`（每个模块都有测试，没再发现问题）、ComfyUI 客户端和生图流程、`src/ps` 里结果没检查的 `play()`、UI 的图层命令收尾、Rust 里会 panic 的地方（`Cargo.toml` 是 `panic = "abort"`，任何一个线程 panic 整个 WavePlug 程序和所有外置窗口都会消失）。

### Bug

3. **Illustrator 置入失败时改错图层**（`src/ps/uxpBridge.ts` `placeFromIllustrator`）：`placeEvent` 用的是不检查结果的 `play()`。置入被 PS 拒绝时，`doc.activeLayers[0]` 还是用户原来选中的图层，代码把它当成新置入的：**改成 Illustrator 对象的名字**，选了「像素」还会尝试栅格化，并把这个图层作为关联返回给 Illustrator。应改用 `act()`（失败即抛错、整步回滚），或像 `buildBoardFromIllustrator` 那样比对置入前的图层 id。
4. **「从 Illustrator 更新」失败也报成功**（同文件 `replaceFromIllustrator`）：`select` 和 `placedLayerReplaceContents` 都用 `play()`，替换失败（图层不是智能对象、文件读不了）时照样写日志 `bridge replaced` 并回成功。select 失败时还会替换到当时选中的别的智能对象上。同样改用 `act()`。
5. **更新程序可能闪退**（`native/overlay/src/setup/update.rs`）：`latest.json` 的 `sha256` 直接由 serde 读入，没有像 GitHub 那条路（`parse_digest`）那样校验长度和十六进制；直连失败转下载节点时 `&want[..12]` 遇到少于 12 个字节（或第 12 字节落在中文中间）会 panic → 整个程序退出。另外大写的 sha256 永远和 `file_sha256` 的小写对不上，下载节点全部失败。应在 `parse_latest` 里用 `parse_digest` 同样的规则规范化 / 丢弃。
6. **ComfyUI 中途没了会空等 30 分钟**（`src/core/comfy/client.ts` `waitFor`）：`/history` 的错误被 `.catch(() => null)` 吞掉，ComfyUI 关掉或崩溃时一直轮询到 30 分钟超时，界面停在「排队中 / 执行中」；任务在 ComfyUI 网页里被删出队列（不会有 WebSocket 事件、history 里也永远没有）同样如此。建议连续若干次连不上就报错，并定期看 `/queue` 里还有没有这个任务。被别处中断（`execution_interrupted`）时报的是笼统的「ComfyUI 执行失败」。

### 小问题

- `uxpHost.ts` `readGroupImage`：`select` 失败不检查，会复制 / 合并当时选中的别的图层，读回错的图（历史记录不提交，文档本身不受影响）。
- `app.ts` `watchCanvas` 只要有文档就每 200 ms 读一次 PS（PS 不在前台也读），可以在 PS 不在前台时停掉。

### 查过没问题的

- `client.ts` 上传、取消、WebSocket 连接超时；`generate.ts` 的裁剪 / 缩放 / 变体参考图重传。
- 图层命令：`act()` 失败即抛错，`step()` 回滚；`run()` 的 `deleting` 在 finally 里复位。
- 新的「合并图」：`stampVisible` 没有选中图层时不改选择，用 PS 当前的选择。
- Rust 的 `lock().unwrap()`：`panic = "abort"` 下锁不会中毒，不会因此 panic；字符串切片的下标都来自 `find` / `rfind`，落在字符边界上（上面第 5 条除外）。

## 2026-11-25 第三轮：实际使用的日志

来源：Windows 开发机 `G:\waveplug\studio\reports\` 的 `uxp_errors.log`（11-12 起）、`uxp_runtime.log`（18 MB）、`overlay_runtime.log`、`comfy_runtime.log`，截至 11-25 08:58。

### Bug（日志里有证据）

7. **双击智能对象会触发好几次「编辑智能对象内容」**：583 次打开里有 139 次（约 1/4）紧跟着一条「当前文档已切换，已取消操作以防误删其他 PSD」，面板状态栏显示「操作失败」（11-12 到 11-25 每天都有，共 144 条）。PNG 智能对象还会出现「无法读取智能对象内容格式，已停止打开」（19 条）：第一次正在把 PNG 转成 PSB，后面几次同时去读格式。原因：`layerTree.ts` 的自定义双击检测和原生 `dblclick` 只靠 `DOUBLE_CLICK_DEDUPE`（180 ms）去重，打开文档时面板线程被模态占住，第二、三次事件处理时已超过 180 ms；几次 `run("editContents")` 一起排队，第一次打开新文档后其余的被 `requireActiveDoc` 拦下。应按「同一图层的 editContents 正在进行就忽略」去重；被我们自己打开文档拦下的那几次不要报错。
8. **只有一个图层的文档里「合并图」按钮没用**（11-25 08:30 实测 3 次）：在智能对象打开的「图层 3.psb」（只有一层）里点，PS 回「命令“合并可见图层”当前不可用」（-25920）；切到别的文档就成功了。PS 的盖印可见图层要至少两个可见图层。只有一个可见图层时应改用 `stampSelected` 单图层那条路（复制 → 转智能对象 → 栅格化）。
9. **变体图层没有蒙版时，每次刷新都报错并重做一次模态读取**（11-23 10:46–10:54，12 次）：`uxpHost.ts` `groupInfo` 里 `getLayerMask` 返回的结果没有 `imageData`，`grayInto` 访问 `d.width` 和 finally 里的 `r.imageData.dispose()` 抛 `Cannot read properties of undefined (reading 'dispose')`。退回图层范围没问题，但失败的结果不缓存，下一次刷新又开一次「WavePlug 读取填充范围」模态。应在 `grayInto` 里处理没有 `imageData` 的情况（当作没有蒙版），并缓存退回的范围。

### 只是噪音（建议降级或改说明）

- `canvas view display scale unavailable`（371 条，最多的一类）：都是 PS 最小化时（Windows 把窗口放到 -32000，`cx ≈ -30084`），已经每分钟只记一次。可降为 info。
- `refresh failed` / `tools inspect` / `workbench open docs` 的 `Cannot read properties of undefined (reading 'activeDocument' | 'documents')`（约 30 条）：发生在 PS 正在退出、`require("photoshop").app` 已经没了的时候（之前都有 `overlay disconnected`）。不影响使用，但 `log.ts` 把它归为「插件自身的错误（代码缺陷），请把这份报告发给开发者」，有误导。
- 「命令“删除 / 移动 / 选择 / 变换”当前不可用」（各十几条，最后在 11-23）：PS 正处于别的模态或编辑状态，插件已按失败处理并提示。
- `active fill group unreadable … AI 填充图层组里没有变体`（约 60 条）：用户把变体删光后的 AI 组，预期行为。

### 外置框架、ComfyUI

- `overlay_runtime.log`（0.17.0 → 0.28.0，8 次启动）：没有任何 panic、错误或失败记录。
- `comfy_runtime.log`：每次启动都报「人脸自动矫正」节点 `DLL load failed while importing _dlib_pybind11`（121 次）。是 WavePlug ComfyUI 包缺 dlib 的 DLL，节点用不了，不影响内置工作流。
- 8 条 `/prompt` 的 `JSONDecodeError`（带 BOM、键名没引号）连着出现，不是插件发的格式（插件用 `JSON.stringify`），像是手动用 PowerShell 测试留下的，不用管。
