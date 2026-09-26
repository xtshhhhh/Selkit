# Changelog

## 1.0.0

首个版本。

- Claude 面 → provider `cc-switch`（走 CC Switch 本地代理）
- Codex 面 → provider `ccs-codex`（直连中转站）
- 只跟随 CC Switch 当前选中的卡
- 启动时同步一次；`/ccsync` 手动重读
- `FOLLOW` 支持 `"current"` 与数组（多站）两种模式
