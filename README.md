# WavePlug Studio

Photoshop UXP 面板：把当前画面 + 选区交给 ComfyUI 局部重绘工作流，结果按版本 001、002… 追加进同一个智能对象。
插件 ID `com.waveplug.studio`（与旧版 `com.waveplug.psai` 并存，互不影响）。**ComfyUI 端零改动**：只调用其原生接口。

## 目录

| 路径 | 内容 |
|---|---|
| `src/core/workflow/` | API 工作流读取、界面格式 → API 转换、自动识别、配置（profile）、执行副本注入 |
| `src/core/comfy/client.ts` | ComfyUI 原生 HTTP/WS 客户端（上传、提交、进度、历史、取图、只取消自己的任务） |
| `src/core/image/` | PNG 编码、选区 → 透明通道 / 遮罩文件、区域计算 |
| `src/core/xmp.ts` | 版本号计数器（存于 PSB 的 XMP，删层后编号不复用） |
| `src/ps/uxpHost.ts` | Photoshop 侧：读画面与选区、建任务组、写入版本、Layer Comp 切换、手动编辑后的同步 |
| `src/app/generate.ts` | 一次生成的完整流程（快照 → 上传 → 执行 → 写回发起时的文档） |
| `src/ui/` | 面板与校准界面 |
| `src/preview/` | 浏览器预览（模拟 PS 与 ComfyUI，只用于看界面与交互） |
| `poc/` | 智能对象版本链实机 POC（ExtendScript）与报告 |
| `tests/` | 离线测试；`tests/fixtures/ui/` 为用户机上 5 个真实工作流 |

## 命令

```
npm install
npm test          # 离线测试
npm run typecheck
npm run build     # dist/plugin = 可加载的 UXP 插件目录；dist/preview = 浏览器预览
```

## 状态（2026-10-30）

- 已实机验证（Photoshop 27.10，ExtendScript）：智能对象内追加版本、主文档切换 Layer Comp、羽化遮罩、选区外像素不变、手删后同步、编号不复用、XMP 计数器读写。见 `poc/README.md`。
- 已离线验证：5 个真实工作流的识别（孤海局部重绘两版全部关键项「明确」；编辑/文生图工作流被正确拒绝）、执行副本注入、重新导入时绑定迁移、PNG/透明通道编码、ComfyUI 客户端协议。
- **尚未验证**：插件在 UXP 中的首次运行（未安装）；UXP 网络请求是否被 ComfyUI 来源校验拦截；`uxpHost.ts` 中 batchPlay / DOM 调用的实机行为；真实 Qwen 生成闭环。
