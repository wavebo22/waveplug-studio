# WavePlug Studio — AI 接入说明

Photoshop UXP 插件：连接本地 ComfyUI，把 AI 结果以图层组 + 变体的形式写回文档；另有「工具」页和独立的「WavePlug 图层」面板。

**先读 [`docs/README.md`](docs/README.md)**：那里有文档阅读顺序和当前状态。

最重要的几条：

- 回复用户用中文。
- **不要提交、不要切分支**，除非用户明确要求（分支 `local-test`；`reports/` 的日志不提交）。
- 验证：`npx tsc --noEmit -p .`、`npm test`；构建：`npm run build`。用户在 PS 开发版面板点 ⟳ 加载。
- PS 里出问题，**先读 `reports/uxp_runtime.log`**，拿到证据再改。用户额度紧张，不要盲试。
- 纯逻辑放 `src/core/` 并写测试；修改 PS 文档的操作放在 `step()` 里，保证是一步历史记录。
- 改文件时不要用「先清空再写」的写法（曾经清空过源码），写到 `.new` 文件再 `mv`，或者用编辑工具。
- `workflows/` 下两个未跟踪的 JSON 不属于本项目的改动，不要动。
