# WavePlug Studio 0.1.1 · UPIA -198 安装修复报告

- 日期：2026-10-31（UTC+08）
- 项目：`F:\waveplug\studio`；分支：`local-test`
- 源码基线：`48e2106`（含 `839fd82` 及前几轮实机报告）
- 安装脚本修复提交：`a751374`
- **结论：安装成功。UPIA 返回 `Installation Successful`，`/list all` 确认 Photoshop 2026 的 WavePlug Studio 0.1.1 为 Enabled，OpenLayer 和旧版 WavePlug 插件仍然 Enabled。**
- 范围：仅证明安装注册成功；Photoshop 未启动，UI 及 ComfyUI 端到端测试未测。

## 1. 根因和取证

**已证实的原因**：本机 J 盘提取版 Adobe UPIA 对当前工作驱动器有依赖；其 Adobe 用户目录校验日志使用了缺少驱动器号的路径。远程命令从 F: 工作目录运行时返回 -198，改成 C: 当前工作目录后安装成功，其他关键环境保持不变。

2026-10-31 01:39 的 Adobe 原生日志：
`C:\ProgramData\Adobe\UPI\Log\EMCL.log`

```text
10/31/26 01:39:31:724 | [ERROR] |  | Upia | EMCL |  |  |  | 19056 | utils::CFileUtils::createDirectoriesWithOwnership: Adobe folder neither exist, nor have                             the permission to create "\Users\WAVE\AppData\Roaming\Adobe", status = -198
10/31/26 01:39:31:724 | [ERROR] |  | Upia | EMCL |  |  |  | 19056 | CExtensionManager::initAllUserFileSystem, createDirectoriesWithOwnership failed for path C:\Users\WAVE\AppData\Roaming\Adobe\UPI with status -198
10/31/26 01:39:31:724 | [ERROR] |  | Upia | EMCL |  |  |  | 19056 | CExtensionManager::InstallExtensionForAll: initAllUserFileSystem() failed, status is -198!
```

本机实测：

```text
CURRENT_DIRECTORY=F:\waveplug\studio
HOMEPATH=\Users\WAVE
APPDATA=C:\Users\WAVE\AppData\Roaming
RELATIVE_ROOT_TEST=False
ABS_C_ROOT_TEST=True
ABS_F_ROOT_TEST=False
```

Adobe 错误码表对应 `EXMAN_FAILED_USER_ADOBE_DIR_NOT_PRESENT = -198`：
https://community.adobe.com/questions-628/exmancmd-upia-error-codes-as-of-oct-31-2022-685810

日志说明 UPIA 当时认为 `\Users\WAVE\AppData\Roaming\Adobe` 不存在或不可创建，而真实的 `C:\Users\WAVE\AppData\Roaming\Adobe` 存在。**根相对路径缺少盘符，加上当前工作目录位于 F: 的组合，与失败吻合；只切换工作驱动器成功，是关键对照证据。** 未运行 Process Monitor，不能声称已观察到 UPIA 内部的具体 Win32 API 调用。

另：EMCL 日志含 `-504` 数据库更新/用户记录警告，以及 XManConfig 找不到的告警；**成功安装的日志中依然出现这些警告**。因此不能将它们直接判定为本次阻塞的根因，也不能据此修改 Adobe 数据库。

## 2. 远程命令与用户桌面会话对照

| 检查项 | AgentDock 命令环境（实测） | 桌面会话（只读信息） |
|---|---|---|
| 用户 | `WAVEBOBO\WAVE`；`whoami /all` 确认 | `query user`：`wave`、console、Session 2；Explorer 进程属主经 `GetOwner` 确认为 `WAVEBOBO\WAVE` |
| 令牌权限 | 高完整性 / Elevated，Administrators 已启用 | Session 2 的 `explorer.exe` 令牌非提升（Not elevated） |
| USERPROFILE | `C:\Users\WAVE` | 用户配置注册表对应 `C:\Users\WAVE` |
| APPDATA | `C:\Users\WAVE\AppData\Roaming` | 未独立读取 Explorer 进程环境变量 |
| LOCALAPPDATA | `C:\Users\WAVE\AppData\Local` | 未独立读取 Explorer 进程环境变量 |
| HOMEDRIVE / HOMEPATH | `C:` / `\Users\WAVE` | HKCU Volatile Environment 的记录相同 |
| TEMP | `C:\Users\WAVE\.agentdock\tmp` | 未直接采集桌面进程的 TEMP |
| HKCU / ProfileList | HKCU 对应 WAVE，AppData Shell Folder、ProfileImagePath 正确 | 同一交互会话；没有观察到另一个用户配置文件 |
| 工作目录 | F: 失败；**C: 成功** | 不再重复安装已启用版本，因此未运行桌面双击安装脚本 |

**成功的实验仍然使用高权限令牌和 AgentDock TEMP**，所以“必须非管理员运行”和“TEMP 不同”都不是解决这次 -198 的必要条件。用户桌面 Explorer 的非提升令牌是只读确认；未将其未采样的环境变量伪称为实际测得。

## 3. 安装修复实验与结果

关键控制变量保持相同：
- 安装器：`J:\AI things\OpenLayer\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe`
- 安装包：`F:\waveplug\studio\releases\WavePlug_Studio_0.1.1_local.ccx`；SHA-256 `F661E19EB33CD9D7AB9BFB2D8E3D150BAA87EF17D81896BE0744E28C0AA30A67`
- Windows 用户 WAVE，Elevated 令牌、TEMP、关闭状态的 Photoshop、旧插件、UPIA 数据库都未改变。

**唯一改变**：工作目录改为 `C:\Users\WAVE`（等价于执行 `cd /d C:\Users\WAVE`）。

实际终端原文：

```text
CWD=C:\Users\WAVE
HOMEPATH=\Users\WAVE
TEMP=C:\Users\WAVE\.agentdock\tmp
PS_CLOSED=TRUE
=== INSTALL C DRIVE CWD ===
Installing extension with file path = F:\waveplug\studio\releases\WavePlug_Studio_0.1.1_local.ccx
Installation Successful for extension with file path = F:\waveplug\studio\releases\WavePlug_Studio_0.1.1_local.ccx for all users
INSTALL_PROCESS_EXIT=0
```

`/list all` 的 Photoshop 原文：

```text
3 extensions installed for Photoshop 2026 64 (ver 27.10.0)
 Enabled    OpenLayer                                                   0.37.0
 Enabled    WavePlug - PS AI Studio                                      0.6.1
 Enabled    WavePlug Studio                                              0.1.1
```

UPIA 自带日志 `C:\ProgramData\Adobe\UPI\Log\Upia.log` 记录：

```text
10/31/26 02:18:04:413 | [INFO] |  | Upia | Upia |  |  |  | 7628 | Upia::upia::Upia::handleInstallExtension: Execution completed with status 0
```

插件注册文件 `C:\Program Files\Common Files\Adobe\UXP\PluginsInfo\v1\PS.json` 含：
```json
{"name":"WavePlug Studio","path":"$systemPlugins\\External\\com.waveplug.studio_0.1.1","pluginId":"com.waveplug.studio","status":"enabled","type":"uxp","versionString":"0.1.1"}
```

插件目录 `C:\Program Files\Common Files\Adobe\UXP\Plugins\External\com.waveplug.studio_0.1.1` 存在。以上是用户要求的 UPIA 安装所自动完成的插件注册与文件部署，**没有手工编辑注册文件**。

## 4. 最终可用的安装方法

用户自行保存全部 PSD 并完全退出 Photoshop（无 Photoshop.exe）后，使用：

```bat
cd /d C:\Users\WAVE
"J:\AI things\OpenLayer\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "F:\waveplug\studio\releases\WavePlug_Studio_0.1.1_local.ccx"
"J:\AI things\OpenLayer\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /list all
```

验收必须同时看到 `Installation Successful` 与 `Enabled WavePlug Studio 0.1.1`。**UPIA 在安装失败时也可能把进程退出码置 0，不可据此当成功。**

修复了 `scripts\install_ccx.cmd`：安装前执行 `cd /d "%USERPROFILE%"`；日志增加 `HOMEDRIVE`、`HOMEPATH` 和 `WORKDIR`。此脚本**未再桌面双击安装回归**，仅其中工作盘符切换已在真实命令行实验验证。`docs\LOCAL_TEST_HANDOFF.md` §2.1 已补充可复用命令和诊断流程。

## 5. 改动、离线测试及回滚

| 文件 | 改动 |
|---|---|
| `scripts\install_ccx.cmd` | 新增工作目录切换及日志信息；修复提交 `a751374` |
| `docs\LOCAL_TEST_HANDOFF.md` | 新增 §2.1：已验证安装方法和 -198 排查 |
| `reports\INSTALL_FIX_20261031.md` | 本报告 |
| Photoshop 插件产品源码 | **无修改** |

脚本修改后已执行：
- `npm test`：**12/12 通过**，169.3445 ms。
- `npm run typecheck`：**通过**。
- `npm run build`：**通过**。

本次**无需手工**创建/删除 Adobe 目录、修改 Windows 注册表、用户环境变量、`UPI.db` 或 `UPISys.db`。需要撤销脚本改动时可先审查 `git revert a751374` 对应差异，但当前没有回滚需求。

## 6. Photoshop 实机测试仍需用户启动后继续

**当前 A1 的安装子步骤已通过，A1 的面板 UI 验收及 A2–E3 均未测。** 用户尚未确认自行启动 Photoshop，本轮未打开、重启或关闭该程序，未碰任何 PSD。

后续执行顺序：
1. 用户自己启动 Photoshop；确认后从 A1 检查“增效工具 → WavePlug Studio”，面板底部应显示 0.1.1，记录控制台。
2. 点击右上角连接状态，填 `127.0.0.1`，点击「保存并连接」，原文记录结果。
3. 无论成功失败都读取并附上 `C:\Users\WAVE\AppData\Roaming\Adobe\UXP\PluginsStorage\PHSP\27\External\com.waveplug.studio\PluginData\waveplug.log` **全文**。
4. 若连接失败，停在 A4，记录 UXP fetch/WebSocket 或 403 原文；不能自行修改 ComfyUI。
5. 若连接成功，继续 B/C/D/E；所有 Photoshop 改动只发生在新建的 `WavePlug_TEST_` 文档，不接触用户 PSD。
6. 用户启动后额外检查 Photoshop 实际管理员权限与 ExtendScript/COM 自动化，记录是否出现“ActiveX 部件不能创建对象”。**本轮因未启动 Photoshop，两个检查均未测。**

## 7. 安全回顾

未自行打开/保存/关闭用户文档或 Photoshop；未改变 ComfyUI 节点、模型、工作流、启动参数；未卸载或覆盖 `com.waveplug.psai`、OpenLayer、sd-ppp；未人工编辑 Adobe UPI 数据库（UPIA 安装可能按其正常机制更新注册数据）。没有安装其他独立软件到 C:，插件仅按 Adobe 现有规定安装在其 UXP 插件目录中。
