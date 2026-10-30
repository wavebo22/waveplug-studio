> **历史文档**：这是 0.1.x 首次实机测试时给本地 AI 的交接说明，当时的智能对象方案已在 0.2.0 被「AI 填充图层组」取代。安装与开发请看 [DEVELOPMENT.md](DEVELOPMENT.md)。

# WavePlug Studio · 本地实机测试交接（给 mainpc 上的 AI）

你接手的是 **WavePlug Studio 0.1.0** 的第一次实机测试。代码已写完并通过离线测试，但**从未在 Photoshop UXP 中运行过，也从未连接真实 ComfyUI 生成过**。你的任务是**测试并如实记录**，必要时做最小修复。测完后，报告会交回给原开发者（另一个 Claude）审阅和继续开发。

## 0. 先读这些

1. `F:\waveplug\studio\README.md` — 结构与状态
2. `F:\waveplug\studio\poc\README.md` — 智能对象版本链实机 POC（ExtendScript 已验证的流程和结论）
3. `F:\waveplug\studio\src\ps\uxpHost.ts` — 本次最需要验证的文件（POC 的 batchPlay / UXP DOM 改写版）
4. `F:\waveplug\studio\src\app\generate.ts` — 一次生成的完整流程
5. 产品设计基线：`F:\waveplug\docs\WavePlug_V1.4_Claude_Handoff\CLAUDE_START_HERE.md`

## 1. 硬性规则（违反任何一条都要停下来问用户）

- **不碰用户的 PSD。** 只在你自己新建、名字以 `WavePlug_TEST_` 开头的文档上测试。Photoshop 里如果有未保存的用户文档，**不得关闭、保存或重启 Photoshop**，需要重启时先请用户自己保存。
- **ComfyUI 端零改动。** 不装节点、不改启动脚本或参数、不改 `custom_nodes`、不改用户的工作流文件。只用原有方式启动：
  `J:\AI things\ComfyUI\ComfyUI_windows_portable\run_nvidia_gpu_qwen21.bat`
- **不卸载、不覆盖**旧插件 `com.waveplug.psai`、OpenLayer、sd-ppp。
- **不把软件装到 C 盘**（用户偏好 D 盘；项目在 F 盘）。插件的安装方式**以用户给你的方案为准**。
- **不虚报。** 「接口通了」「工作流能执行」「画面效果好」是三件不同的事，要分开写。没测到的写「未测」，失败写「失败」并附原文报错。
- 代码修改规则见第 5 节。

## 2. 准备

```
cd /d F:\waveplug\studio
git status                    :: 应为干净的 main 分支
git checkout -b local-test
rmdir /s /q node_modules      :: 现有 node_modules 是在 macOS 上装的，esbuild 二进制不能在 Windows 用
npm install
npm test                      :: 预期 11 pass
npm run typecheck
npm run build                 :: 产物：dist\plugin（UXP 插件目录）、dist\preview
```

记录：Photoshop 版本、Node 版本、ComfyUI 版本（`/system_stats`）、显卡与显存。

### 2.1 WavePlug Studio 0.1.1 的实机安装方法（2026-10-31 已验证）

**安装必须从用户配置文件所在的 C: 盘作为当前工作驱动器运行 UPIA。** 这一点与 CCX 存放在哪个盘、UPIA EXE 存放在哪个盘是两回事；项目和安装器依然分别保留在 F:、J:，**不需要迁移安装包或安装新软件**。

先请用户**亲自保存所有 PSD 并完全退出 Photoshop**；检查任务管理器无 `Photoshop.exe`。不能自行保存或结束 Photoshop。

命令行安装（以下命令已在 mainpc 实际执行、成功）：

```bat
cd /d C:\Users\WAVE
"J:\AI things\OpenLayer\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "F:\waveplug\studio\releases\WavePlug_Studio_0.1.1_local.ccx"
"J:\AI things\OpenLayer\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /list all
```

也可以双击 `F:\waveplug\studio\scripts\install_ccx.cmd`，它已在运行安装器前执行 `cd /d "%USERPROFILE%"`，并记录 `WORKDIR`、环境变量、安装原文和 `/list all` 到 `reports\install_*.log`。**本次成功验证的是上述命令行方法；修改后的双击脚本尚未单独双击回归，不要将其写成已通过。**

**验收唯一标准**：控制台确实显示 `Installation Successful`，并且 `/list all` 的 Photoshop 行含 `Enabled  WavePlug Studio  0.1.1`，同时保留 `OpenLayer` 和 `WavePlug - PS AI Studio`。UPIA 失败时也会返回进程退出码 0，不能只依靠 `%ERRORLEVEL%`。成功后请用户**自行启动 Photoshop**，重新测试 A1（面板底部 0.1.1）→ A3（地址 `127.0.0.1`，「保存并连接」）→ 不论结果均读取 `C:\Users\WAVE\AppData\Roaming\Adobe\UXP\PluginsStorage\PHSP\27\External\com.waveplug.studio\PluginData\waveplug.log` **全文**。失败止步 A4，成功继续 B–E。

**-198 根因和取证**：2026-10-31 在 `F:\waveplug\studio` 工作目录用同一安装器/CCX/管理员令牌运行，UPIA 输出 `Failed to install, status = -198!`。Adobe 自带的 `C:\ProgramData\Adobe\UPI\Log\EMCL.log` 记录：

```text
utils::CFileUtils::createDirectoriesWithOwnership: Adobe folder neither exist, nor have the permission to create "\Users\WAVE\AppData\Roaming\Adobe", status = -198
CExtensionManager::initAllUserFileSystem, createDirectoriesWithOwnership failed for path C:\Users\WAVE\AppData\Roaming\Adobe\UPI with status -198
```

`HOMEPATH=\Users\WAVE`；日志中第一条路径**缺少盘符**。在 F: 工作目录，根相对路径 `\Users\WAVE\AppData\Roaming\Adobe` 不存在；绝对路径 `C:\Users\WAVE\AppData\Roaming\Adobe` 实际存在。**仅将 UPIA 工作目录改到 `C:\Users\WAVE`，保留管理员令牌和 AgentDock TEMP 不变，就安装成功了。**因此，已经验证的必要修复是“改变工作驱动器”，并非重启 Photoshop、删除旧插件、编辑 Adobe 数据库或系统注册表。UPIA 内部确切 Win32 路径解析调用没有 ProcMon 捕获；日志与单变量对照实验高度支持其将缺盘符的路径在当前驱动器上解析这一机制。

官方日志位置：`C:\ProgramData\Adobe\UPI\Log\EMCL.log` 和 `Upia.log`；远程高权限环境是 WAVE 用户（HKCU 和用户配置文件一致）、`TEMP=C:\Users\WAVE\.agentdock\tmp`、`Integrity=High`，桌面 Explorer 为非提升令牌。在成功实验中这些权限/环境均没有改变，故**不能将 -198 简单归因于“必须使用非管理员桌面会话”**。

**安全**：只在 `local-test` 更新测试脚本和文档；不要删除/覆盖 `com.waveplug.psai`、OpenLayer、sd-ppp，不要修改 ComfyUI、`UPI.db` 或 `UPISys.db`。如需手动更改 Adobe 目录/注册表，请先取得用户授权。本次修复没有此类手动更改。

## 3. 测试清单

每项都要写结果：**通过 / 失败 / 未测 / 部分通过**，加上证据（报错原文、截图路径、日志片段、耗时）。
UXP 控制台报错用 UXP 开发工具或用户方案中可用的调试方式获取，尽量原文保存。

### A. 安装与连接

| 编号 | 操作 | 期望 |
|---|---|---|
| A1 | 按用户的方案安装 `dist\plugin`，打开「增效工具 → WavePlug Studio」 | 面板出现，底部显示 `0.1.0`，控制台无报错 |
| A2 | ComfyUI 未启动时打开面板 | 右上角「未连接」，生成按钮禁用并写原因 |
| A3 | 启动 ComfyUI 后点右上角状态 → 保存并连接 | 显示 `ComfyUI 0.37.x` |
| A4 | **若 A3 失败**：在 UXP 控制台执行 `await (await fetch("http://127.0.0.1:8188/system_stats")).status`，以及尝试 `new WebSocket("ws://127.0.0.1:8188/ws")` | 记录状态码 / 报错原文。**403 = ComfyUI 来源校验拦截**，此时停下，把证据写进报告，不要自行改 ComfyUI 启动参数 |

### B. 导入与自动校准

样本工作流：`孤海 Qwen2.1 Turbo PS专用\Qwen-2.1-移除、局部重绘_PS插件连接本地comfyui专用_本机适配.json`

| 编号 | 操作 | 期望 |
|---|---|---|
| B1 | 「+」→「ComfyUI 中已保存的工作流」→ 选样本 | 校准页预填：主画面 `#303`（明确）、提示词 `#22.Text`（明确）、输出 `#38`（明确）、种子 `#267.noise_seed`、参数 `#304/#306/#307` 勾选 |
| B2 | 勾选「允许提示词为空」后保存 | 工作流下拉出现该项，提示词占位文字提到「留空 = 移除」 |
| B3 | 在 ComfyUI 中「导出 (API)」同一工作流 → 「+」→ API JSON 文件导入 | 与 B1 识别结果一致（导入同名会走「更新」，报告保留/迁移/失效数量） |
| B4 | 导入 `▶▷Qwen-image21-图像编辑.json` | 校准页红框提示「没有任何遮罩入口」，不能保存为可用工作流 |
| B5 | 把 B3 导出的 JSON 复制一份并删掉 `304` 节点，以同名再次导入 | 提示「1 项需重新绑定」，其余绑定保留 |

### C. 智能对象版本链（核心，对应 POC）

在新建的 `WavePlug_TEST_1`（1600×1000，RGB 8 位，画几块不同颜色的形状）上：

| 编号 | 操作 | 期望 |
|---|---|---|
| C1 | 矩形选区 + 羽化 20px，提示词「一个红色陶瓷杯」，不选中任何 AI 结果 → 生成 | 版本区标签为「新任务」；生成后图层面板出现 1 个「AI 结果 · xxxx」智能对象（带图层蒙版），面板历史出现 001 |
| C2 | 选中该智能对象（标签变为「续写 · …」），改提示词 → 生成 | 同一智能对象内追加 002，主文档自动显示 002，**没有新建第二个智能对象** |
| C3 | 再生成一次 → 003；在面板依次点击 001 / 003 | 画面切换正确，智能对象位置与大小不变 |
| C4 | 双击智能对象进入 PSB，删除 `003` 图层，保存并关闭 | 面板历史只剩 001、002（自动同步）。记录同步是否发生、是否有报错 |
| C5 | 再生成 | 新版本为 **004**（不是 003） |
| C6 | 在 PSB 里用画笔修改 002 并保存 | 主文档切到 002 时显示修改后的内容；不产生新编号 |
| C7 | 取样检查：选区外的像素在生成前后是否完全一致 | 一致（附取样坐标与数值） |
| C8 | 不建选区、但选中已有任务组 → 生成 | 使用任务组自带的遮罩生成新版本 |
| C9 | 不建选区、也不选中任务组 | 生成按钮禁用，写「请先建立选区」 |
| C10 | 提示词留空 → 生成（移除模式） | 选区内的内容被移除，而不是报「请输入提示词」 |

每次生成记录各阶段耗时：读取画面、上传、ComfyUI 执行、取回、写入智能对象。

### D. 安全与异常

| 编号 | 操作 | 期望 |
|---|---|---|
| D1 | 生成过程中切换到另一个测试文档 `WavePlug_TEST_2` | 结果写回 TEST_1 的任务组，TEST_2 不变 |
| D2 | 生成过程中关闭 TEST_1（不保存） | 不写入任何文档；底部出现「保存未写入的结果」，可以另存为 PNG |
| D3 | 生成过程中点「取消」 | 只取消本插件的任务（再用别的方式往 ComfyUI 排一个任务，确认它没被打断） |
| D4 | 生成过程中关闭 ComfyUI | 清楚报错；不创建空的智能对象，不改原图 |
| D5 | 新建 16 位或 CMYK 文档后生成 | 被拦下，提示只支持 RGB 8 位 |
| D6 | 把任务组智能对象旋转 15° 后选中它再生成 | 提示「被旋转或变形，无法续写」 |
| D7 | 连续快速双击生成 | 只提交一个任务 |
| D8 | 生成时 Photoshop 是否卡顿 | 主观描述 + 耗时 |

### E. 界面

| 编号 | 检查 | 期望 |
|---|---|---|
| E1 | 面板宽度 280 / 340 / 420 px | 无横向溢出，历史缩略图可以横向滚动 |
| E2 | 与浏览器预览（`dist\preview`）对比 | 记录 UXP 渲染差异（字体、下拉框、复选框、滑块、SVG 图标、颜色变量） |
| E3 | 高级参数调整后生成 | ComfyUI 实际收到修改后的值（可在 ComfyUI 历史 / 队列中查看提交的工作流） |

## 4. 重点怀疑点（在 UXP 中从未运行过）

出错时优先看这些。每一处都写明「按原样可用」还是「改成了什么」：

1. `selectionBounds`：`get` 文档的 `selection` 属性，无选区时的返回形式
2. `imaging.getSelection` / `getLayerMask` / `putLayerMask` 的参数（尤其 `putLayerMask` 的 `colorSpace: "Grayscale"`）
3. `doc.createPixelLayer`、`imaging.putPixels` 的 `targetBounds`
4. `newPlacedLayer` 之后 `doc.activeLayers[0]` 是否就是新的智能对象
5. `placeEvent` + `createSessionToken` 置入 PNG；`layer.scale` / `translate` / `rasterize` 的签名与单位
6. `psb.layerComps.add({...})`、`comp.recapture({visibility:true})`、`comp.delete()` 是否存在
7. `XMPMetadataAsUTF8` 的 get / set（ExtendScript 已验证可行，UXP batchPlay 待验证）
8. `hostControl.suspendHistory` / `resumeHistory`
9. `smartObjectMore.transform` 的格式（`rectFromTransform` 假设为 8 个数字）
10. `addNotificationListener(["save"], …)` 在 PSB 保存时能否触发，以及触发时 `activeDocument` 是否为该 PSB
11. `imaging.getPixels` 的 `targetSize` 缩略图
12. ComfyUI 上传时，手写的 multipart 请求能否被正确接收

## 5. 代码修改规则

- 只在 `local-test` 分支上改。**一个问题一个提交**，提交信息格式：`fix(<编号>): <现象> → <原因> → <改法>`，例如 `fix(C2): layerComps.add 不存在 → UXP 27.10 中为 … → 改用 batchPlay make compsClass`。
- 只做让测试通过的最小修改，**不重构、不改界面设计、不改产品逻辑**（比如编号规则、新任务和续写的判定、只做局部重绘）。如果你认为逻辑本身有问题，写进报告的「建议」部分，不要直接改。
- 每次修改后都要跑 `npm test`、`npm run typecheck`、`npm run build`，并重新安装插件后复测。
- 新发现的 UXP API 行为，在 `poc\` 下补一个最小复现脚本或说明。

## 6. 交回内容

写在 `F:\waveplug\studio\reports\LIVE_TEST_<日期>.md`，结构如下：

1. **环境**：PS / UXP / Node / ComfyUI 版本，显卡，插件安装方式
2. **总结**：一句话现状，加上 A–E 各部分的通过数 / 总数
3. **测试结果表**：编号、结果、证据（报错原文、截图路径 `reports\shots\…`、耗时）
4. **修改清单**：每个提交的哈希、对应编号、改了什么、为什么（附 `git log --oneline main..local-test`）
5. **UXP API 实测结论**：第 4 节逐条写明可用、不可用，或换成了什么写法
6. **未解决问题**：现象、复现步骤、你的判断
7. **建议**：你认为原设计需要调整的地方（不要已经改掉）
8. **性能**：每个阶段的耗时

最后提交报告（`docs: live test report`），并告诉用户：「测试完成，报告在 `F:\waveplug\studio\reports\LIVE_TEST_<日期>.md`，修改在 `local-test` 分支」。
