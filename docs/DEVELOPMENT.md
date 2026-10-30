# 开发说明

## 构建与测试

```
npm install
npm test            # 离线测试
npm run typecheck
npm run build       # dist/plugin（正式版）、dist/dev（开发版加载器）、dist/preview（浏览器预览）
python scripts\package_ccx.py        # → releases\WavePlug_Studio_<版本>_local.ccx
python scripts\package_ccx.py dev    # → releases\WavePlug_Studio_DEV_<版本>_local.ccx
```

`node_modules` 若在另一系统上安装过，需要补装对应平台的 esbuild（`@esbuild/win32-x64` / `@esbuild/darwin-x64`）。

## 安装（Adobe UPIA）

mainpc 不使用 UXP Developer Tool，而是用 J 盘提取出的 Adobe UPIA 安装 `.ccx`：

1. 完全关闭 Photoshop。
2. 右键 `scripts\install_ccx.cmd` → **以管理员身份运行**。它会切到 C 盘工作目录、安装 `releases` 中**最新生成**的 `.ccx`，并把环境与 `/list all` 结果写入 `reports\install_*.log`。
3. 以列表中显示 `Enabled` 为准，**不要以退出码判断**（失败时 UPIA 也返回 0）。

已知错误：

| 状态 | 原因 | 处理 |
|---|---|---|
| `-198` | UPIA 把缺盘符的用户目录 `\Users\WAVE\AppData\Roaming\Adobe` 按当前盘解析；在 F:/J: 下运行就找不到 | 工作目录切到 C 盘（脚本已处理）。证据：`C:\ProgramData\Adobe\UPI\Log\EMCL.log` |
| `-432` | 非管理员身份运行 | 以管理员身份运行 |

## 开发版（免重装迭代）

开发版 `WavePlug Studio Dev` 只装一次。它的面板每次打开时都从 `F:\waveplug\studio\dist\plugin` 读取最新构建运行；`npm run build` 之后点标题旁的橙色 ⟳ 即重新加载，不用关闭 Photoshop。

- 只有改 `plugin/manifest.json`（权限、名称）或 `dev/` 时才需要重新打包开发版并用 UPIA 安装。
- 开发版的数据（导入的工作流、设置）与正式版分开存放。
- 开发版额外拥有完整文件访问与动态代码权限；日志会同时写到 `reports\uxp_runtime.log`，并可在「ComfyUI 连接 → 保存调试文件」中保存每次发送/返回的图片和提交的工作流（`reports\debug_*`，文件较大，用完关闭）。

## 日志

- 正式版：`%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\27\External\com.waveplug.studio\PluginData\waveplug.log`
- 开发版：同目录的 `com.waveplug.studio.dev\…`，并镜像到 `F:\waveplug\studio\reports\uxp_runtime.log`

日志包含：每次运行的提示词/种子/选项、ComfyUI 复用缓存的节点、每个执行节点的耗时、发送与返回的尺寸、写回 Photoshop 的每一步、文档色彩模式/配置/分辨率。

## 已确认的 UXP 行为（Photoshop 27.10）

- 没有 `TextEncoder` / `TextDecoder`：上传用手写 UTF-8 编码，XHR 响应用 `Response` 解析。
- `<button>` 渲染为原生控件、忽略大部分样式且不显示内联 SVG：按钮用 `div[role=button]`。
- 原生输入框绘制在所有内容之上（无视 z-index）：打开覆盖页时把工作区从 DOM 中移走；**不要**用 `visibility` 切换（0.1.4 实测伴随宿主崩溃）。
- 原生 `textarea` 可能把 placeholder 合并进输入值：不使用 placeholder。
- `imaging.getSelection` / `getLayerMask` 只返回选区自身包围盒内的数据，需要按 `sourceBounds` 放回。
- 置入的 PNG 若没有分辨率信息，会按 72 dpi 换算后缩放到画布；写入 `pHYs` 后按像素 1:1 置入。

## 待验证

- ComfyUI 目前带 `--enable-cors-header` 启动（不是插件加的）。去掉该参数后插件能否连接尚未验证。
- 16 位文档、参考图槽位、文生图任务类型尚未实现或实测。
