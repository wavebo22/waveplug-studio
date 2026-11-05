# WavePlug 悬停像素轮廓实验：备份与回滚记录

日期：2026-11-06
项目：F:\waveplug\studio
分支：local-test

## 1. 回滚结论

悬停像素轮廓实验已从当前工作树撤回，恢复到实验接入前的状态：

- WaveLayer 恢复原有“悬停定位”逻辑；仍通过原来的 opt-in 开关控制。
- 移除本次新增的 UXP 单图层 Alpha 读取接口。
- 移除轮廓缓存、悬停防抖、过期任务处理和轮廓绘制调用。
- 移除 UXP / Rust 的 hover-outline 通信协议。
- 移除独立透明轮廓窗口及 Windows 定位、鼠标穿透代码。
- 移除开发专用 47822 端口、启动脚本和实验程序。
- 删除本次提交的 Alpha 算法、测试和实验设计文档。
- 重新构建 dist/plugin/index.js，避免继续加载包含实验代码的旧构建产物。

本次通过 Git Revert 撤销实验提交，没有 reset、checkout 或清空整个工作树。

## 2. Git 记录

- 实验提交：02eb3c9 — Add alpha-based hover outline POC
- 回滚提交：e53640e — Revert "Add alpha-based hover outline POC"
- 回滚前 HEAD：02eb3c97c63a35b8ebf1118d16c357f6bc37ed9c
- 当前分支：local-test

## 3. 备份位置

> **2026-11-06 更新**：下面的 `backups/` 快照目录和 ZIP 已按用户要求删除。实验的全部源码仍可从 Git 提交 `02eb3c9` 取回（例如 `git show 02eb3c9:src/core/layers/alphaOutline.ts`）；只有当时的测试 exe 和 POC 日志副本不再保留。悬停功能后来改为「悬停边框」，见 `docs/LAYER_PANEL_HANDOFF.md` 第 5 节。


完整文件快照目录：

F:\waveplug\studio\backups\hover-outline-poc-2026-11-06_0518

ZIP 归档：

F:\waveplug\studio\backups\hover-outline-poc-2026-11-06_0518.zip

ZIP 大小：1,921,178 bytes

备份包含 21 个文件，逐个保留回滚前的完整内容。SHA-256 和文件大小见同目录的 SHA256_MANIFEST.csv。

## 4. 备份文件清单

- docs/history/HOVER_PIXEL_OUTLINE_POC_2026-11-06.md
- src/core/layers/alphaOutline.ts
- tests/alpha_outline.test.ts
- src/ps/uxpHost.ts
- src/ps/host.ts
- src/ui/layersPanel.ts
- src/ui/layerTree.ts
- src/core/overlay/protocol.ts
- src/app/overlay.ts
- native/overlay/src/protocol.rs
- native/overlay/src/host.rs
- native/overlay/src/win.rs
- native/overlay/src/server.rs
- scripts/build.mjs
- src/main.uxp.ts
- dev/loader.js
- dev/waveplug-overlay-dev.cmd
- native/overlay/examples/hover_passthrough.rs
- reports/hover_passthrough_poc.log
- dist/waveplug-overlay-hover-test.exe
- dist/waveplug-overlay-dev.cmd

说明：部分源文件在实验开始前已经包含 WaveLayer、参考图拖拽、ComfyUI 管理和外置面板的其他未提交修改。备份保存的是这些文件的完整快照；回滚时只撤销了悬停轮廓相关代码，没有用快照覆盖其他工作。

## 5. 恢复方式

单文件恢复：
从备份目录下的 files 子目录，按原相对路径取出对应文件，覆盖项目中的同路径文件。

整组快照恢复：
将 files 目录内容复制回项目根目录。此操作会同时恢复快照时存在的其他未提交改动，仅在确实需要恢复整个实验前状态时使用。

建议先复制到临时目录检查，再决定是否覆盖当前文件。

## 6. 回滚后的验证

| 检查项 | 结果 |
|---|---|
| TypeScript 类型检查 | 通过 |
| npm build | 通过 |
| Rust cargo check | 通过 |
| Rust 单元测试 | 34/34 通过 |
| TypeScript 全量测试 | 1 项既有失败，其余通过 |
| POC 47822 服务 | 已停止 |
| 原有 47821 服务 | 保持运行 |
| 实验专用源码、启动脚本和二进制 | 已从工作树移除 |

### 既有测试失败说明

当前全量 TypeScript 测试仍有一项失败：

- 文件：tests/overlay_protocol.test.ts
- 测试：外置生成面板：选区按 PS 视图换算到屏幕坐标
- 当前实际值：left=1652, top=674, right=1752, bottom=774
- 测试期望：left=1922, top=1113, right=2022, bottom=1213

原因涉及当前工作树已有的 docToScreen 坐标换算公式与测试期望不一致。本次回滚没有修改该函数，也没有顺手改动这项既有行为，以免扩大回滚范围。

## 7. 保留范围

以下既有工作没有回滚：

- WaveLayer 图层栏与控件优化
- WaveLayer 图层拖拽、删除和蒙版传递
- 参考图拖拽
- 外置生成面板与变体面板
- ComfyUI 启动和进程管理
- 仓库中其他未提交文件与工作流

本记录只说明悬停像素轮廓实验的备份和撤销，不代表上述其他未提交工作已提交或完成。
