# Changelog

## 1.1.0

### 新增

- `/mp` 分组模型选择窗口：模型按 provider 分组，数字键 1-9/0 直接选中
- `PgUp`/`PgDn`、`←`/`→` 切换分组；`<`/`>` 组内翻页
- `D` 键把选中模型设为 pi 的持久默认（写 `settings.json`）
- `Ctrl+Shift+M` 快捷键
- 模糊过滤支持 `[Cloud]`、`glm-5.3` 这类含方括号和数字的模型名
- 自动维护 `enabledModels`，让内置 `/model` 默认只显示本扩展管理的 provider

### 说明

- `/model` 是 pi 内置命令，无法被扩展覆盖，所以命令名用 `/mp`
- 翻页键用 `<` `>` 而不是 `[` `]`，因为模型名常以 `[` 开头（如 `[Cloud]`、`[AN]`）

## 1.0.0

首个版本。

- Claude 面 → provider `cc-switch`（走 CC Switch 本地代理）
- Codex 面 → provider `ccs-codex`（直连中转站）
- 只跟随 CC Switch 当前选中的卡
- 启动时同步一次；`/ccsync` 手动重读
- `FOLLOW` 支持 `"current"` 与数组（多站）两种模式
