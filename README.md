# Selkit

> 原名 `pi-ccswitch-sync`，v1.5.0 起改名为 **Selkit**。
> 旧地址 `github.com/xtshhhhh/pi-ccswitch-sync` 仍会自动重定向，已安装的不用动。

把 [CC Switch](https://github.com/farion1231/cc-switch) 里当前选中的中转站卡片同步成 [pi](https://github.com/earendil-works/pi-coding-agent) 的模型 provider，并提供一个分组模型选择窗口。

**解决的问题**：CC Switch 里同一个面可能有很多张卡（多个中转站、或同一个站的多把 key），每张卡开放的模型都不一样。如果不处理，pi 的模型列表会堆满几十条你用不上的模型。这个扩展让 pi **只显示当前该用的那张卡**的模型。

## 命令

| 命令 | 作用 |
|---|---|
| `Ctrl+L` | **打开分组模型选择窗口** |
| `/models` | 同上 |
| `/mp` | 同上（短别名）|
| `/ccsync` | 手动重新同步（重读 CC Switch 并把模型列表更新进 pi）|

> **关于 `/model`**：pi 内置的 `/model` 分支在 TUI 层的 `setupEditorSubmitHandler()`，早于扩展命令执行，扩展拦不住。所以这里**不覆盖 `/model`**，请用 `Ctrl+L` 或 `/models`。

## 窗口长什么样

```
╔═ SELKIT ═════════════════════════════════════════════════════SYS ▸ ONLINE NODE 1/3 ╤═════════════════════════╗
║▐ Codex ▌ ▕ Claude ▏ ▕ 鸡蛋 ▏                                                       │═ COMMAND DECK           ║
║════════════════════════════════════════════════════════════════════════════════════│ 鼠标  单击选中          ║
║─ ccs-codex Codex 面 (9)────────────────────────────────────────────────────────────│ 双击  确认选择          ║
║│   1  deepseek-v4-flash                                            600K ◈◆        ││ 滚轮  上下移动          ║
║│   2  deepseek-v4-flash-0731                                       600K ◈◆        ││ 点标签  切换分组        ║
║│   3  deepseek-v4-pro                                              600K ◈◆        ││ 点思考  设置强度        ║
║│   4  deepseek-v4.1-flash                                          600K ◈◆        ││ ←  →  切换分组          ║
║│◉  5  deepseek-v4.1-flash-expires-on-0910                          600K ◈◆        ││ ↑  ↓  移动光标          ║
║│   6  glm-5.1                                                      600K ◈◆        ││ 1-9 0  定位第 N 项      ║
║│   7  glm-5.2                                                      600K ◈◆        ││ Enter  确认选择         ║
║▐▸  8  glm-5.3                                                      600K ◈◆        ▌│ d  D  设为默认          ║
║│   9  kimi-k3                                                      600K ◈◆        ││ r  R  重新同步          ║
║│                                                                                  ││ Esc  关闭窗口           ║
║└──────────────────────────────────────────────────────────────────────────────────┘│─────────────────────────║
║[8/9] ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  FILTER OFF                │ ░ STATUS ░              ║
║ 思考  low │ medium │ high                                                          │  当前                   ║
║ // PICK >> glm-5.3  （双击确认 · d 设默认）                                        │  deepseek-v4.1-flas...  ║
║                                                                                    │ 总数  14                ║
║                                                                                    │ 分组  3                 ║
║                                                                                    │ 页码  —                 ║
╚═▓▒░ SELKIT · cyberspace model selector ░▒▓═════════════════════════════════════════╧═════════════════════════╝

**符号**：`◉` = 当前模型 · `▸` = 光标 · `◈` = 支持推理 · `◆` = 支持图片

终端宽度 < 100 列时右侧说明面板自动隐藏，只留左侧。

## 鼠标操作

| 操作 | 行为 |
|---|---|
| 单击模型 | 选中（移动光标），窗口不关 |
| **双击**模型 | 确认选择 |
| 单击分组标签 | 切换分组 |
| 单击思考强度 | 设置 `low` / `medium` / `high`，并写入 `settings.json` |
| 滚轮 | 上下移动光标，越界自动翻页 |

## 键盘操作

| 按键 | 动作 |
|---|---|
| `1`-`9`, `0` | 定位到本页第 1-10 项（不关窗，再按 `Enter` 或 `d`）|
| `PgUp` / `PgDn` | 切换 provider 分组 |
| `←` / `→` | 同上（过滤框为空时）|
| `↑` / `↓` 或 `j` / `k` | 移动光标 |
| `<` / `>` | 组内翻页 |
| `Enter` | 选中光标处模型 |
| `d` / `D` | 把光标处模型设为**持久默认**（写 `settings.json`）|
| `r` / `R` | 重新拉取模型列表 |
| 打字 | 模糊过滤 |
| `Esc` | 有输入时先清空，否则关闭 |

## 安装

```bash
pi install git:github.com/xtshhhhh/Selkit
```

或本地试用：

```bash
pi install /path/to/Selkit
```

只试一次、不写进配置：

```bash
pi -e git:github.com/xtshhhhh/Selkit
```

## 前置条件

1. **CC Switch 已安装并有配置**（数据库位于 `~/.cc-switch/cc-switch.db`）。
2. **Node.js >= 22**（用到内置的 `node:sqlite`）。
3. Claude 面需要 CC Switch 的**本地代理在运行**（默认 `127.0.0.1:15721`）。

## 它怎么工作

启动时读一次 CC Switch 的 SQLite 数据库，把**当前选中**的卡注册成 pi provider：

| 面 | provider id | 连接方式 | 模型来源 |
|---|---|---|---|
| Claude | `cc-switch` | CC Switch 本地代理 | 卡里的 `ANTHROPIC_DEFAULT_*_MODEL` 槽位 |
| Codex | `ccs-codex` | 直连中转站 | 上游 `/models` 接口 |
| 额外分组 | 自定义 | 直连中转站 | 上游 `/models` 接口 |

### 两个面的关键差异

**Claude 面**：模型是卡里的**固定槽位**，不是上游全列表。CC Switch 代理的 `/v1/models` 返回空列表，所以只能从 `ANTHROPIC_DEFAULT_SONNET_MODEL` / `_OPUS_` / `_FABLE_` / `_HAIKU_` / `ANTHROPIC_MODEL` 这些环境变量里读。

Claude 面走代理：pi 用占位 key，**真 key 由 CC Switch 代理注入**。模型名原样透传，由代理路由到当前卡的上游。

**Codex 面**：用卡里的 key 直连中转站 `/models`，拿到该 key 开放的完整列表。

### 同步时机与启动速度

**只在 pi 启动时读一次**，之后不轮询 —— 避免会话中途模型列表被换掉。

启动分两步，为的是不拖慢 pi：

1. **扩展工厂里**从本地缓存注册 provider（约 1ms）。这一步必须在工厂里做完 —— pi 解析默认模型发生在 `session_start` **之前**，晚注册会导致默认模型找不到而回退到第一个模型。
2. **`session_start` 里**再联网刷新。

缓存文件：

- `~/.pi/agent/ccswitch-models-cache.json` — Claude / Codex 两个面的模型
- `~/.pi/agent/ccswitch-extra-models.json` — 额外分组的模型

**网络失败不会把列表清空**：拉取函数区分「服务器说没有」和「网络挂了」，后者沿用上次缓存；也绝不会把缓存缩成只剩一个模型。

想手动重读：在 pi 里运行 `/ccsync`。

## 额外分组（除 Claude / Codex 之外）

pi 里除了 CC Switch 的两个面，还可以加任意多个中转站分组。

新建 `~/.pi/agent/ccswitch-extra.json`：

```json
{
  "groups": [
    {
      "id": "ccs-egg",
      "label": "鸡蛋",
      "name": "鸡蛋 · DeepSeek",
      "baseUrl": "https://your-relay.example.com/v1",
      "apiKey": "sk-xxxxxxxx",
      "api": "openai-responses",
      "contextWindow": 600000,
      "maxTokens": 128000,
      "enabled": true
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | provider id，**定了就别改** —— 改了 pi 里的默认模型会丢 |
| `label` | 窗口标签条上显示的文字 |
| `name` | provider 的显示名 |
| `baseUrl` | 中转站地址，带 `/v1` |
| `apiKey` | 该站的 key |
| `api` | `openai-responses` / `openai-completions` / `anthropic-messages` |
| `contextWindow` | 上下文长度，不写用默认 |
| `maxTokens` | 最大输出 token |
| `enabled` | `false` 可临时禁用该分组 |

**这个文件不会进仓库**（`.gitignore` 已排除），key 只留在本机。

加完重启 pi 或跑 `/ccsync`，标签条上就会出现新分组。

> `api` 怎么选：拿 key 试 `POST /chat/completions` 和 `POST /responses`，
> 哪个返回 200 就用哪个。有些站会拒绝 `/v1/messages`（返回 403
> "This group does not allow /v1/messages dispatch"），那就别用 `anthropic-messages`。

## 自动维护 enabledModels

扩展会在 pi 启动时把 `settings.json` 的 `enabledModels` 设为通配形式：

```json
["cc-switch/*", "ccs-codex/*", "ccs-egg/*"]
```

效果：pi 内置的模型列表默认进入 scoped 模式，只列出这些面的模型，不再混入其他 provider 的一大堆模型。

用**通配符**而不是逐个列出模型名，所以换卡后模型名变了也不会失效。想手动调整就用 pi 原生的 `/scoped-models`。

## 配置

编辑 `extensions/index.ts` 顶部的常量：

```ts
// 每个面跟随哪些中转站
//   "current"                     → 只跟随当前选中的卡（默认）
//   ["your-relay.example.com"]    → 每个站各出一个 provider
const FOLLOW: "current" | string[] = "current";

const CLAUDE_PROVIDER_ID = "cc-switch";               // Claude 面的 provider id
const CODEX_PROVIDER_ID  = "ccs-codex";               // Codex 面的 provider id
const CLAUDE_PROXY_URL   = "http://127.0.0.1:15721";  // CC Switch 本地代理
const CLAUDE_PROXY_KEY   = "cc-switch-local";         // 占位 key（由代理替换）
const FETCH_TIMEOUT_MS   = 5_000;
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

## 上下文长度

中转站的模型元数据（上下文长度、是否支持推理）不可信，扩展里给的是**宽值**
（Claude 200K / Codex 400K）。

想给某个模型真实的上下文长度，**在自己的 `~/.pi/agent/models.json` 里覆盖**，
不要改扩展：

```json
{
  "providers": {
    "ccs-codex": {
      "modelOverrides": {
        "deepseek-v4.1-flash": { "contextWindow": 600000 }
      }
    }
  }
}
```

## 已知限制

- **同一站的多把 key 只会取一张**（优先 `is_current` 那张）。因为同站的卡 `baseUrl` 相同，同时注册会撞 provider id。不同站请用「额外分组」。
- 上游模型列表会波动（某个模型被临时下架再上架），属正常现象，扩展会沿用上次缓存。
- 只在 CC Switch 已经有配置时才有意义。没装 CC Switch 的话不会注册 Claude / Codex，但额外分组不受影响。

## 开发

扩展是两个 TypeScript 文件，没有构建步骤 —— pi 直接加载 `.ts`：

- `extensions/index.ts` — 同步逻辑（读 CC Switch → 注册 provider）
- `extensions/model-picker.ts` — 分组模型选择窗口

调试：改完文件后在 pi 里跑 `/ccsync`，或重启 pi。

### 关于鼠标实现

pi 默认只开 `?1003h` + `?1006h`，**没开 `?1000h`（按钮事件）**，所以必须自己补：

```ts
const MOUSE_ON  = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1000l\u001b[?1002l";
```

鼠标事件走 `ctx.ui.custom` 返回组件的 `handleMouse(event)`，**不走 `handleInput`**
（pi 会把 SGR 序列全部消费掉再转发）。而且返回值必须带 `handled: true`，
否则会被 pi 静默丢弃，双击计数永远停在 1：

```ts
handleMouse(event) {
  const redraw = picker.handleMouseEvent(event);
  if (redraw) tui.requestRender();
  return { handled: true, render: redraw };
}
```

`event.x` / `event.y` 是相对 overlay 左上角的 0-based 坐标，就是 `render()` 输出的行号。

## 许可

MIT
