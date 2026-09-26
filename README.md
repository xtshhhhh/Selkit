# pi-ccswitch-sync

把 [CC Switch](https://github.com/farion1231/cc-switch) 里当前选中的中转站卡片同步成 [pi](https://github.com/earendil-works/pi-coding-agent) 的模型 provider。

**解决的问题**：CC Switch 里同一个面可能有很多张卡（多个中转站、或同一个站的多把 key），每张卡开放的模型都不一样。如果不处理，pi 的 `/model` 列表会堆满几十条你用不上的模型。这个扩展让 pi **只显示当前该用的那张卡**的模型。

## 命令

| 命令 | 作用 |
|---|---|
| `/model` | **打开分组模型选择窗口**（覆盖内置） |
| `Ctrl+L` | 同上（覆盖内置键位） |
| `/models` | 同上（保底别名，万一上面的失效） |

> **为什么需要覆盖**：`/model` 的内置分支在 TUI 层 `setupEditorSubmitHandler()`，
> 早于扩展命令；而 `Ctrl+L` 对应的 `app.model.select` 在 pi 的
> `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 清单里，扩展快捷键会被跳过。
>
> 本扩展用 `setEditorComponent` 换掉输入框，在 `handleInput` 里直接拦 `Ctrl+L` 字节和 `/model` 提交。
> 若升级 pi 后输入框异常，把顶部的 `OVERRIDE_MODEL_COMMAND` 改成 `false` 即可恢复原生行为（此时用 `/models`）。

### 窗口长什么样

```
╔═ MODEL PICKER ════════════════════════════════SYS ▸ ONLINE NODE 1/2 ╤═════════════════════╗
║────────────────────────────────────────────────────────────────────│═ COMMAND DECK         ║
║┌─[ cc-switch ] Claude 面 (3)───────────────────────────────────────┐│ 1-9 0  选择模型       ║
║▐▸  1  [AN]gemini-3.8-flash-thinking                    200K ◈◆     ▌│ PgUp/Dn  切换分组     ║
║│◉  2  [Cloud]GLM-5.3-Flash                             200K ◈◆     ││ ←  →  切换分组        ║
║│   3  deepseek-v4.1-flash                              200K ◈◆     ││ ↑  ↓  移动光标        ║
║└───────────────────────────────────────────────────────────────────┘│ j  k  移动光标        ║
║────────────────────────────────────────────────────────────────────│ <  >  组内翻页        ║
║                                                                    │ Enter  确认选择       ║
║                                                                    │ D  设为默认           ║
║                                                                    │ R  重新同步           ║
║                                                                    │ Esc  关闭窗口         ║
║                                                                    │───────────────────────║
║                                                                    │ ░ STATUS ░            ║
║                                                                    │  当前                 ║
║                                                                    │  [Cloud]GLM-5.3-Flash ║
║                                                                    │ 总数  13              ║
║                                                                    │ 分组  2               ║
║                                                                    │ 页码  —               ║
║────────────────────────────────────────────────────────────────────├───────────────────────║
║[2/3] ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░  FILTER OFF                           │                       ║
╚═▓▒░ cyberspace model selector ░▒▓══════════════════════════════════╧═════════════════════╝
```

**符号**：`◉` = 当前模型 · `▸` = 光标 · `◈` = 支持推理 · `◆` = 支持图片

**自适应**：终端宽度 < 100 列时右侧 COMMAND DECK 自动隐藏。

### 按键

| 按键 | 动作 |
|---|---|
| `1`-`9`, `0` | 直接选中本页第 1-10 个模型（`0` = 第 10 个）|
| `PgUp` / `PgDn` | 切换 provider 分组 |
| `←` / `→` | 同上（过滤框为空时）|
| `↑` / `↓` 或 `j` / `k` | 移动光标 |
| `<` / `>` | 组内翻页（组内 > 10 个时）|
| `Enter` | 选中光标处模型 |
| `D` | 把光标处模型设为**持久默认**（写 settings.json）|
| `R` | 重新拉取模型列表 |
| 打字 | 模糊过滤（支持 `[Cloud]`、`glm-5.3` 这类名字）|
| `Esc` | 有输入时先清空，否则关闭 |

## 效果

```
provider   model
cc-switch  [Cloud]GLM-5.3-Flash
cc-switch  deepseek-v4.1-flash
cc-switch  [AN]gemini-3.8-flash-thinking
ccs-codex  deepseek-v4.1-flash
ccs-codex  gemini-3.8-flash
ccs-codex  mimo-v2.6-flash
```

（启用前可能是 28 条，启用后 6 条。）

## 安装

```bash
pi install git:github.com/xtshhhhh/pi-ccswitch-sync
```

或本地试用：

```bash
pi install /path/to/pi-ccswitch-sync
```

只试一次、不写进配置：

```bash
pi -e git:github.com/xtshhhhh/pi-ccswitch-sync
```

## 前置条件

1. **CC Switch 已安装并有配置**（数据库位于 `~/.cc-switch/cc-switch.db`）。
2. **Node.js >= 22**（用到内置的 `node:sqlite`）。
3. Claude 面需要 CC Switch 的**本地代理在运行**（默认 `127.0.0.1:15721`）。

## 自动维护 enabledModels

扩展会在 pi 启动时把 `settings.json` 的 `enabledModels` 设为：

```json
["cc-switch/*", "ccs-codex/*"]
```

效果：pi 内置的 `/model` 打开时**默认进入 scoped 模式**，只列出这两个面的模型，
不再混入其他 provider 的一大堆模型。

用**通配符**而不是逐个列出模型名，所以 CC Switch 换卡后模型名变了也不会失效。
一个模型都不会丢。

想手动调整就用 pi 原生的 `/scoped-models`。

## 它怎么工作

启动时读一次 CC Switch 的 SQLite 数据库，把**当前选中**的卡注册成 pi provider：

| 面 | provider id | 连接方式 | 模型来源 |
|---|---|---|---|
| Claude | `cc-switch` | CC Switch 本地代理 | 卡里的 `ANTHROPIC_DEFAULT_*_MODEL` 槽位 |
| Codex | `ccs-codex` | 直连中转站 | 上游 `/models` 接口 |

### 两个面的关键差异

**Claude 面**：模型是卡里的**固定槽位**，不是上游全列表。CC Switch 代理的 `/v1/models` 返回空列表，所以只能从 `ANTHROPIC_DEFAULT_SONNET_MODEL` / `_OPUS_` / `_FABLE_` / `_HAIKU_` / `ANTHROPIC_MODEL` 这些环境变量里读。

Claude 面走代理：pi 用占位 key，**真 key 由 CC Switch 代理注入**。模型名原样透传，由代理路由到当前卡的上游。

**Codex 面**：用卡里的 key 直连中转站 `/models`，拿到该 key 开放的完整列表。

### 同步时机

**只在 pi 启动时读一次**，之后不轮询 —— 避免会话中途模型列表被换掉。

想手动重读：在 pi 里运行 `/ccsync`。

## 配置

编辑扩展文件顶部的常量：

```ts
// 每个面跟随哪些中转站
//   "current"                     → 只跟随当前选中的卡（默认）
//   ["your-relay.example.com"]    → 每个站各出一个 provider
const FOLLOW: "current" | string[] = "current";

const CLAUDE_PROVIDER_ID = "cc-switch";               // Claude 面的 provider id
const CODEX_PROVIDER_ID  = "ccs-codex";               // Codex 面的 provider id
const CLAUDE_PROXY_URL   = "http://127.0.0.1:15721";  // CC Switch 本地代理
const CLAUDE_PROXY_KEY   = "cc-switch-local";         // 占位 key（由代理替换）
const FETCH_TIMEOUT_MS   = 10_000;
const CODEX_CONTEXT      = 400_000;
const CODEX_MAX_TOKENS   = 128_000;
const CLAUDE_CONTEXT     = 200_000;
const CLAUDE_MAX_TOKENS  = 64_000;
```

provider id 是**固定的**，不随 key 变 —— 所以换 key 后 pi 里的默认模型不会丢。

### 多站模式

把 `FOLLOW` 改成数组即可，provider id 会按域名自动生成：

```ts
const FOLLOW: "current" | string[] = ["cdn.example.com", "api.deepseek.com"];
```

```
ccs-claude-cdn-example-com  ...
ccs-codex-api-deepseek-com  ...
```

## 已知限制

- **同一站的多把 key 只会取一张**（优先 `is_current` 那张）。因为同站的卡 `baseUrl` 相同，同时注册会撞 provider id。
- 中转站的模型元数据（上下文长度、是否支持推理）不可信，这里统一给的是宽值。要精确值请自行改 `modelMeta()`。
- 只在 CC Switch 已经有配置时才有意义。没装 CC Switch 的话这个扩展不会注册任何 provider。

## 开发

扩展就是单个 TypeScript 文件 `extensions/index.ts`，没有构建步骤 —— pi 直接加载 `.ts`。

调试：改完文件后在 pi 里跑 `/ccsync`，或重启 pi。

## 许可

MIT
