# WaveLayer for Illustrator（0.1.0，未在 Illustrator 实测）

WavePlug 的 Illustrator 版，第一个面板是 **WaveLayer**：代替 Illustrator 自带图层面板的增强版，并且能和 Photoshop 里的 WavePlug **牵手工作**。不含任何 ComfyUI 功能。

## WavePlug 程序和安装包

**WavePlug.exe** 是一个程序：外置框架（外置面板、拖拽卡片、性能监视、卡死保护、ComfyUI 管理、两边面板的连接、从网页拖入）加上主窗口。平时在右下角托盘里，点托盘图标、开始菜单或桌面的「WavePlug」打开主窗口：

- **总览**：Photoshop / Illustrator 是否在运行、插件和面板装了哪个版本、是否已连上本程序、安装位置、ComfyUI 能否连接。
- **安装与更新**：安装 / 更新 / 卸载 Photoshop 插件和 Illustrator 面板（从安装文件夹里的 `WavePlug.pak`）；检查更新（`latest.json`）、「用安装程序更新…」；「卸载 WavePlug」删除整个程序；开发者区（从源码更新、从源码重新安装、生成安装包、发布到 GitHub、AI 面板用开发版）。更新来源可填 GitHub 仓库 `owner/仓库名`（`setup/update.rs`：`github_repo`、`latest` 读 `releases/latest`，找 `WavePlug_Setup_*.exe` 附件）或 latest.json；窗口每次打开自动检查一次。默认来源 `update::DEFAULT_SOURCE`（现在为空）。
- **功能设置**：随 Photoshop 启动、性能监视、卡死保护、ComfyUI 地址 / 启动文件 / 自动启动等。和 Photoshop 插件「设置」页是同一份（插件连上后才能改），改了插件马上生效。另有「关闭 Photoshop 后继续在托盘运行」。
- **帮助与日志**：各部分说明、打开日志 / 数据文件夹、导出诊断信息（复制到桌面）、清理缓存。

**分享给别人**：在 `studio` 双击 `release.cmd`（或主窗口 › 开发者 › 生成安装包），得到 `releases\WavePlug_Setup_版本.exe`。对方双击：

1. 选安装位置（默认 `%LOCALAPPDATA%\Programs\WavePlug`，可以「浏览…」改；选的不是 WavePlug 文件夹时会在里面建一个 `WavePlug`）。
2. 勾选同时安装 Photoshop 插件 / Illustrator 面板（自动找到的版本会显示出来）、桌面快捷方式，点「安装」。Photoshop 插件用 Adobe 的 UPIA 装，会请求一次管理员权限，Photoshop 要关着；没装上的部分以后在主窗口里再装。
3. 装好后「打开 WavePlug」。

安装文件夹里：`WavePlug.exe`、`WavePlug.pak`（安装内容，供以后安装 / 修复插件）、`WavePlug.installed`、`data\`（`setup.json` 设置、`logs\` 日志、`cache\` 缓存）。**所有缓存和日志都在这里**，卸载时整个文件夹删除。程序登记在 Windows「设置 › 应用」里，可以从那里卸载（运行 `WavePlug.exe --uninstall`，打开主窗口确认）。

插件里也带着同一个程序（`waveplug-overlay.exe`）：装了 WavePlug 后它一启动就改为启动安装文件夹里的 `WavePlug.exe` 并退出，所以始终只有一个程序、一份数据。源码里的开发版（`dist\` 旁边有 `reports\`）不转交，日志照旧写到 `reports\`。Photoshop 插件只有一个：开发机上它自己从 `dist\plugin` 加载（`plugin/loader.js`）；编译程序时已安装的 `WavePlug.exe` 也会更新。

更新：主窗口「检查更新」→「下载并安装」，或「用安装程序更新…」。新安装程序以 `--update <安装文件夹>` 启动，替换程序（运行中的 WavePlug 发现 exe 换了会自动重启成新版）并重装已经装了的插件 / 面板，然后自己关闭。

代码：程序 `native/overlay/src/app.rs`（主窗口）、`tray.rs`（托盘）、`paths.rs`（数据位置、注册表）、`setup/`（安装逻辑，主程序和安装程序共用）；安装程序 `native/overlay/src/setup/main.rs`（bin `waveplug-setup`）；打包 `scripts/package_setup.mjs`。

## 安装（开发版，在 Windows 主机上）

1. 在 `studio` 运行 `npm run build`，生成 `dist\ai`。
2. 双击 `ai\install_dev.cmd`。它会：
   - 在注册表 `HKCU\Software\Adobe\CSXS.11/12/13` 写 `PlayerDebugMode=1`（只对当前用户，允许 Illustrator 载入未签名的 CEP 面板）；
   - 把 `%APPDATA%\Adobe\CEP\extensions\com.waveplug.ai.wavelayer` 链接到 `dist\ai`。
3. **完全退出** Illustrator 再打开，打开「窗口 › 扩展功能 › WaveLayer」（有的版本叫「扩展功能（旧版）」/ Extensions (Legacy)）。脚本最后会列出检查结果，都是 `[OK]` 才对。
   看不到菜单时：确认 `%APPDATA%\Adobe\CEP\extensions\com.waveplug.ai.wavelayer\CSXS\manifest.xml` 存在；CEP 日志在 `%TEMP%\CEP*-ILST.log`。
4. 以后改了代码：双击 `studio\update.cmd`（见下），面板 2 秒内自动载入新版本和宿主脚本，不用点刷新，也不用重启 Illustrator。

**一键更新（以后每次都只做这一步）**：双击 `studio\update.cmd`。它会：外置框架的源码改过才重新编译（正在运行的会自动换成新版本）→ 构建 Photoshop 插件和 Illustrator 面板 → Illustrator 面板没装就装上。打开着的 WavePlug（Photoshop 开发版）和 WaveLayer（Illustrator）面板 2 秒内自动载入新版本。只有 manifest 改了时才需要重启软件，脚本最后会提示。第一次用之前，两个面板各手动刷新一次（Photoshop 点 ⟳，Illustrator 点刷新），让它们带上自动载入的功能。

发行版（不需要 PlayerDebugMode）：CEP 面板要打包成签名的 ZXP。用 Adobe 的 `ZXPSignCmd`：`ZXPSignCmd -selfSignedCert CN 0 WavePlug WavePlug 密码 cert.p12` 生成证书一次，之后 `ZXPSignCmd -sign dist\ai WaveLayer.zxp cert.p12 密码 -tsa http://timestamp.digicert.com`，用 Creative Cloud 的安装工具（或 UPIA：`UnifiedPluginInstallerAgent /install WaveLayer.zxp`）安装。打包前删掉 `dist\ai\.debug`。

调试：`ai/.debug` 打开 CEP 远程调试，Chrome 访问 `http://localhost:8099` 可以看面板的控制台。

牵手 Photoshop 需要外置框架 **0.15.0**（`native\overlay\build.cmd` 重新编译）：它随 Photoshop 启动，Illustrator 面板连到它上面和 Photoshop 插件通信。Photoshop 没开时，WaveLayer 照常工作，只是 Photoshop 那一栏灰掉。外置框架还是旧版本（0.15.0 以前只能连一个客户端）时，面板会马上断开、不再重连，并提示更新，以免把 Photoshop 插件挤下线。Photoshop 插件的「ComfyUI 连接」设置页会显示 Illustrator 是否已连接。

## 功能

**图层树**
- 图层、子图层、编组、剪切组、复合路径、文字、链接 / 嵌入图像、符号……名字照 Illustrator 的叫法（`<路径>`、`<编组>`、文字内容）。图层左边是图层颜色条，路径行显示填色小方块。
- 折叠的图层 / 编组右边显示里面有几项。展开时才读取子项（大文档不卡）；每层最多列 400 项，多的显示「还有 N 项」。Alt+点三角：展开里面所有层级。
- 每 0.7 秒检查一次文档有没有变（很轻的检查），变了才重读；鼠标在面板上时每 4 秒补读一次，移进面板时也会刷新。
- 为了不卡 Illustrator：一次最多列 3000 个节点（超出的显示「还有 N 项」），搜索最多看 30000 个对象、列 500 个结果，自动同步只在文档变化或每 20 秒扫描一次关联对象。

**选择**
- 点行 = 在 Illustrator 里选中这个对象；点图层 = 设为当前图层。Ctrl / Shift 多选，↑↓ 移动选择，←→ 折叠 / 展开。
- 行右边的圆点：图层行 = 选中图层里的全部对象；对象行 = 加选 / 减选。
- 「跟随选择」（设置里，默认开）：在画布上选中对象时，自动展开到它所在的位置。工具栏的「定位」按钮手动做同样的事。

**显示 / 锁定**
- 点眼睛 / 锁；**按住往下拖**可以一次改很多行。
- Alt+点：只显示 / 只解锁这一项（同级的其他项隐藏 / 锁定），再 Alt+点一次全部恢复。

**整理**
- 双击改名（F2 也可以）；多选右键「批量重命名」：查找替换、前缀后缀、序号，先预览再改。
- 拖动排序、拖进图层或编组；拖到图层行的上下边 = 放进那个图层的最上 / 最下。**Alt+拖动 = 复制**。拖不进去的地方行会标红，状态栏说明原因。
- 右键：复制、删除、新建子图层、收集到新图层、编组 / 取消编组（Ctrl+G / Ctrl+Shift+G）、建立 / 释放剪切蒙版、建立 / 释放复合路径、排列、全部显示、全部解锁、**选择相同**（填色、描边、粗细、不透明度、混合模式、外观、图形样式、符号实例）。
- 设置 › 整理文档：删除空图层、空编组、空文字（锁定的不动）。
- 图层右键：**图层颜色**（Illustrator 的十种）、**打印**开关、**预览 / 轮廓**、**释放到图层（顺序）**（每个对象一个子图层）、**合并所选图层**、**导出图层为 PNG（2 倍）/ SVG**（每个图层一个文件，文件名是图层名，重名加序号；Illustrator 会问存到哪个文件夹）。
- 列表下方的**外观条**：选中项的不透明度（滚轮每格 5%）和混合模式，多选一起改。
- **文档检查**（顶栏的警告按钮）：缺失的链接图像、未嵌入的链接图像、游离点、空文字、空编组、空图层、隐藏 / 锁定的对象、无填色无描边的路径、不打印的图层；每项「选中」在 Illustrator 里选中并定位。
- 展开状态按文档分开记住（最近 20 个文档），切换文档不会乱。
- 所有改动都可以撤销：面板有焦点时按 Ctrl+Z / Ctrl+Shift+Z（键盘在面板上时 Illustrator 收不到快捷键），或点底栏的撤销按钮。设置里有快捷键列表。

**搜索**
- 在整个文档里按名字或文字内容找，结果带所在路径（`内容 › Logo`）。筛选按钮：按类型（路径、文字、编组、剪切组、图像……）和状态（隐藏、锁定、空、已发到 PS、缺失链接）。「全选结果」在 Illustrator 里选中所有结果。

**画板**：顶栏下拉切换画板并适合窗口；旁边的按钮选中当前画板上的所有对象。画板按钮打开**画板管理**：改名（回车）、切换、缩放到选中对象、删除（至少留一个，上面的对象不删）、按选中对象新建画板、**按 Photoshop 文档新建画板**（同样大小，放在最右边画板的右侧）。

**文档**：顶栏左边的文档名是下拉框，可以切换 Illustrator 里打开的文档。

## 牵手 Photoshop

面板上方的 Photoshop 栏显示连接状态和 Photoshop 当前文档（名字、分辨率）。

| 按钮 | 做什么 |
|---|---|
| 发送 ＋ 方式 | Illustrator 里选中的对象 → Photoshop 当前文档。右边的下拉框选方式（会记住）：**矢量智能对象**（可无损缩放，双击还能在 Illustrator 里编辑，之后能「更新」）或**像素图层**（按 Photoshop 文档的分辨率栅格化）。没有打开文档时作为新文档打开 |
| 更新 | 选中的对象以前发送过（行上有蓝色 **PS** 标记，点标记也行）：把 Photoshop 里对应智能对象的内容换成现在的样子。**什么都没选时更新整个文档的所有关联** |
| 画板 | 当前画板在 Photoshop 里作为新文档打开（和画板一样大，分辨率在设置里选，默认 300 ppi）：**每个对象单独一个矢量智能对象**，图层 / 子图层 / 编组变成 Photoshop 的组，名字、位置、不透明度、混合模式、显示状态都不变。每个对象都带关联，以后都能「更新」 |

- 「画板」的细节：编组会拆开（每个对象一层）；拆开后超过 300 个对象时编组整个作为一个智能对象；还超过就提示先编组。剪切组、复合路径总是整个一层。不透明度和混合模式放在 Photoshop 图层上，智能对象里面的内容是 100% / 正常，所以不会叠两次（更新时也一样）。只在画板外面的对象不发送。
- 图层右键 › **按图层分别发送**：每个选中的图层成为 Photoshop 里单独的智能对象（名字是图层名），都以当前画板为页面，所以彼此的相对位置不变。
- 设置 › **发送时保留在画板上的位置**：「发送」也以画板为页面（Photoshop 文档和画板一样大时，放进去就在同样的位置）。

**关联和「更新」是怎么回事**：发送时，Illustrator 对象的「备注」里写一行 `wavelink:ID`，Photoshop 插件记下 ID → 文档和图层（图层 ID，不靠名字）。「更新」时 Illustrator 把这些对象重新导出，Photoshop 用「替换内容」换掉那个智能对象里面的东西：
- Photoshop 里对这个**图层**做的事都保留：移动、缩放、旋转、改名、挪到别的组、图层样式、蒙版、不透明度、混合模式、智能滤镜。
- 但智能对象**里面**的内容整个被 Illustrator 的现在的样子换掉：如果在 Photoshop 里双击智能对象改过里面（在 Illustrator 里编辑后保存），这些修改会被覆盖。
- Illustrator 里对象变大或变小：智能对象跟着变，Photoshop 保持原来的缩放比例和中心位置。用「保留在画板上的位置」或「画板」发送的不受影响（页面固定）。
- 图层在 Photoshop 里删了、栅格化了（不再是智能对象）、或文档关了：提示找不到 / 失败，重新发送就行。文档关了再打开：按文档名找回。

- 设置 › **自动同步到 Photoshop**（默认关）：关联对象在 Illustrator 里改了，停手约 2 秒后自动更新 Photoshop。靠对象的「指纹」（类型、边界、填色、文字、不透明度、显示状态）判断有没有改。
- 右键 **PS** 标记：更新、**在 Photoshop 中选中**（切到那个文档并选中图层）、选中 Illustrator 里关联的对象。
- 右键菜单 › **Photoshop 前景色加入色板**（色板名 `PS #RRGGBB`）。

### 在 Photoshop 这边

WaveLayer 右键 › 发送到（Illustrator 面板连着时才出现）：
- **Illustrator：当前画板全部**：选中图层所在的画板（没选：第一个画板；没有画板：整个画布）放进 Illustrator 的**新画板**（一样大，放在最右边画板的右侧；Illustrator 没有打开文档时新建一个），图层组变成编组，名字、位置、不透明度、混合模式、显示状态带过去。按内容转换，尽量保留可编辑：
  - 文字图层 → 可编辑的文字；形状 / 纯色填充图层 → 可编辑的路径（转换不了的按图片）；
  - **矢量智能对象**（里面是 .ai / .pdf / .eps / .svg）→ 取出里面的原文件，在 Illustrator 里嵌入成矢量；带智能滤镜的按图片（保留效果）；
  - 像素图层、Photoshop 文档类智能对象（.psb）→ 嵌入的图片；
  - 调整图层没有对应的东西，不带；剪贴蒙版里的图层单独过去，不剪切（状态栏会提示）。
- **Illustrator：选中的图层**：选中的图层放进 Illustrator 当前画板的新图层，同样按上面的规则转换。
- 从 Illustrator 发来的图层（智能对象）右键：**从 Illustrator 更新**（请 Illustrator 重新导出并替换内容）和 **在 Illustrator 中选中**。

关联记录：备注里的 `wavelink:ID` 不影响原来的备注；Photoshop 插件最多记 1000 条。

## 代码

| 路径 | 内容 |
|---|---|
| `ai/host/wavelayer.jsx` | 宿主脚本（ExtendScript，ES3）：读树、选择、改名、移动、菜单命令、搜索、整理、导出 / 置入。对象用位置键寻址（`l0/i3/i1`），每次修改带上预期的名字和类型，文档变了就拒绝 |
| `src/ai/model.ts` | 纯逻辑：行、选择、拖放规则、展开状态 |
| `src/ai/panel.ts` | 面板界面 |
| `src/ai/host.ts` | evalScript 排队、合并重复的读取、脚本丢失时重新载入 |
| `src/ai/bridge.ts` | Illustrator 这边连外置框架 |
| `src/core/overlay/bridge.ts` | 两边共用的桥接消息格式 |
| `src/app/illustratorBridge.ts`、`src/ps/uxpBridge.ts` | Photoshop 这边：回答请求、置入、替换内容、导出图层 |
| `native/overlay/src/server.rs` | 外置框架接受两种客户端并转发 `bridge` 消息 |
| `src/ai/fake.ts` | Illustrator 对象模型的简化模拟：测试和浏览器预览用 |

测试：`tests/ai_host.test.ts`（宿主脚本在模拟的 Illustrator 里跑，并检查 ES3 语法）、`tests/ai_model.test.ts`、`tests/ai_ps_bridge.test.ts`（Photoshop 这边回答请求）。浏览器预览：`dist/ai-preview/index.html`（同一个面板和宿主脚本，假的 Photoshop；加 `?ps=off` 看未连接的样子）。

## 待实测（Illustrator 2026 / Photoshop）

- 图层里子图层和对象混排的顺序：靠 `zOrderPosition`，读不到时子图层排在前面。
- `pageItem.selected`、`hasSelectedArtwork` 在直接选择工具选中编组内部时的表现。
- 菜单命令名（`Find Fill Color menu item` 等）在中文版 Illustrator 里是否一致。
- 跨文档 `duplicate` 导出 .ai，以及 Photoshop 置入 .ai 时有没有弹出 PDF 选项。
- CEP 面板的 WebSocket 能否连上 `127.0.0.1:47821`。
- 「画板」发送：Photoshop 置入 .ai 时会不会因为「置入时调整图像大小」先缩小（代码会按记录的尺寸改回来）；`layer.move` / `createLayerGroup` 建组的顺序。
- Photoshop `placedLayerExportContents` 能否不选中图层直接导出智能对象内容；Illustrator 嵌入 .pdf / .eps 后是不是可编辑的矢量。
- 宿主脚本里的每个修改在 Illustrator 里是单独一步撤销（ExtendScript 不能把多步合成一步），例如合并图层会产生很多步。
