# WavePlug Studio — AI 接入说明

Photoshop UXP 插件：连接本地 ComfyUI，把 AI 结果以图层组 + 变体的形式写回文档；另有「工具」页和独立的「WavePlug 图层」面板。

**先读 [`docs/README.md`](docs/README.md)**：那里有文档阅读顺序和当前状态。

最重要的几条：

- 回复用户用中文。
- **不要提交、不要切分支**，除非用户明确要求（分支 `local-test`；`reports/` 的日志不提交）。
- 验证：`npx tsc --noEmit -p .`、`npm test`；构建：`npm run build`。用户那边只需双击 `update.cmd`（按需编译外置框架 → 构建 → 没装时装 Illustrator 面板），PS 开发版和 Illustrator 面板发现 `build-stamp.txt` 变了会自动重新载入，不用点 ⟳。
- PS 里出问题，**先读 `reports/uxp_runtime.log`**，拿到证据再改。用户额度紧张，不要盲试。
- 纯逻辑放 `src/core/` 并写测试；修改 PS 文档的操作放在 `step()` 里，保证是一步历史记录。
- 改文件时不要用「先清空再写」的写法（曾经清空过源码），写到 `.new` 文件再 `mv`，或者用编辑工具。
- `workflows/` 下两个未跟踪的 JSON 不属于本项目的改动，不要动。
- 写或改界面样式前读 [`docs/UI_DESIGN_SYSTEM.md`](docs/UI_DESIGN_SYSTEM.md)：只用 `styles.css` 开头的 token（颜色、间距、控件高度），字号不小于 11px，有现成组件就复用。
- 外置窗口（`native/overlay`）的位置只由 `native/overlay/src/layout.rs` 决定（规则见 `native/overlay/HANDOFF.md` 4.0 节），新窗口也照这个，不要各自算位置。
