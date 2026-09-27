# Changelog

## 1.5.0

### 新增：鼠标操控窗口

窗口改成鼠标驱动，键盘照样能用。

```
╔═ MODEL PICKER ══════════════════ SYS ▸ ONLINE NODE 1/3 ╤══╗
║▐ Claude ▌ ▕ Codex ▏ ▕ 鸡蛋 ▏                              ║   ← 分组按钮条
║════════════════════════════════════════════════════════════║
║─ ccs-codex Codex 面 (10)───────────────────────────────────║
║▐◉  1  deepseek-v4-flash                    600K ◈◆        ▌║   ← 单击选中
║│   2  deepseek-v4-flash-0731               600K ◈◆        │║      双击确认
║│   3  deepseek-v4-pro                      600K ◈◆        │║
║└──────────────────────────────────────────────────────────┘║
║[1/10] ▓▓▓░░░░░░░░░░░░░░░░░  FILTER OFF                     ║
║ 思考  low │ medium │ high                                  ║   ← 点击设思考强度
╚═▓▒░ cyberspace model selector ░▒▓══════════════════════════╝
```

| 操作 | 行为 |
|---|---|
| 单击模型 | 选中（移动光标），窗口不关 |
| **双击**模型 | 确认选择 |
| `d` / `D` | 设为默认（写 `settings.json`）|
| 单击分组标签 | 切换分组 |
| 单击思考强度 | 设置 low / medium / high |
| 滚轮 | 上下移动光标，越界自动翻页 |
| 数字键 `1-9 0` | 定位到第 N 项 |
| `Enter` | 确认选择 |
| `Esc` | 关闭 |

### 思考强度会持久化

点一下就写进 `settings.json` 的 `defaultThinkingLevel`，下次启动生效。

### 分组按钮可自定义

分组来自两个地方：

1. **CC Switch** 的两个面（`cc-switch` Claude / `ccs-codex` Codex），自动
2. **额外分组**：`~/.pi/agent/ccswitch-extra.json`

```json
{
  "groups": [
    {
      "id": "ccs-egg",
      "label": "鸡蛋",
      "name": "鸡蛋 · DeepSeek",
      "baseUrl": "https://your-relay.example.com/v1",
      "apiKey": "sk-...",
      "api": "openai-responses",
      "contextWindow": 600000,
      "maxTokens": 128000,
      "enabled": true
    }
  ]
}
```

标签条上的文字取 `label`（内置两个面显示 `Claude` / `Codex`，
其余显示配置里的 `label`，没写就显示 provider id）。

### 实现要点（踩坑记录）

#### ① pi 默认不报鼠标**按键**事件

pi 进 TUI 时只开了 `?1003h`（任意移动）+ `?1006h`（SGR 格式），
**没开 `?1000h`（按钮事件）**。所以滚轮能收到、点击收不到。
开窗时自己补上，关窗时还原：

```ts
const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1000l\u001b[?1002l";
process.stdout.write(MOUSE_ON);
// …ctx.ui.custom(...)
process.stdout.write(MOUSE_OFF);
```

#### ② 鼠标事件走 `handleMouse`，不走 `handleInput`

pi 的 `handleViewportInput` 会把 SGR 序列**全部消费掉**，
然后 `dispatchMouseToOverlay` → `component.handleMouse(event)`。
所以必须给 `ctx.ui.custom` 返回的组件加 `handleMouse`，
只在 `handleInput` 里解析 SGR 是收不到的。

#### ③ 返回值必须带 `handled: true`

pi 的 `dispatchMouseEvent` 有这么一段：

```js
let result = component.handleMouse?.(event);
if (result) {
  if ("target" in result) return result;
  if (!(!result.handled && !result.capture && !result.focus))
    return { ...result, handled: true, …, target: {...} };
}
// 否则整个结果被丢弃
```

返回 `{render: true}` 会被静默丢掉 → pi 不记 `mousePressTarget`
→ release 时走不到 `getComponentClickCount` → **`clickCount` 永远是 1，双击永远不成立**。

```ts
handleMouse(event: any) {
  const redraw = picker.handleMouseEvent(event);
  if (redraw) tui.requestRender();
  return { handled: true, render: redraw };
}
```

#### ④ 坐标就是 `render()` 的行号

pi 传的 `event.y` 相对 overlay 左上角，就是 `render()` 输出的下标。
不用自己再加偏移 —— 但 `render()` 拼装时最外层会先插一行标题，
所以记录命中区域时要 `+1`。

#### ⑤ `status` 行会让下面的行号漂移

原来 `status` 排在进度条和思考条之间，一出现就把思考条推下一行，
记录的命中区域就和实际位置错开 1 行。把 `status` 移到最底部。

#### ⑥ 标签的命中区间要算上装饰符

`▐ text ▌` 里的 `▐`/`▌` 各占 1 列，只按文字算会出现点边缘落空：

```ts
const from = x;
x += 1 + visibleWidth(text) + 1;   // 含两侧装饰符
const to = x;
```

### 验证

**单测 27/27**：

- 渲染宽度 12–150 列逐行精确相等
- 思考条 y 不随 `status` 出现/消失而漂移（三个分组下都是 16）
- 点思考条三项 → `low` / `medium` / `high` 都正确
- 点模型第 1–10 行 → 光标分别落在 0–9
- 第 1 行：单击不关窗、`clickCount:2` 关窗且 `kind=select`
- 键盘 `PgDn` / `d` 仍然可用

**真机（node-pty，140 列）**：

| 操作 | 结果 |
|---|---|
| Ctrl+L 开窗 | ✓ `NODE 1/3` |
| 点「鸡蛋」标签 | ✓ `NODE 3/3`，`▐ 鸡蛋 ▌` 高亮，列表 `ccs-egg 鸡蛋 (2)` |
| 单击模型 | ✓ 状态行 `// PICK >> deepseek-v4.1-flash-expires-on-0910` |
| 双击模型 | ✓ 提示条「已切换模型」 |
| 点 `low` | ✓ 状态行 `THINK >> low`，`settings.json` 写入 `defaultThinkingLevel: "low"` |
| 滚轮 | ✓ `{"type":"wheel","wheelDelta":-3}` |

启动耗时 1174 / 1112 / 1188 ms（没变慢）。

### 顺带

- 面板右侧 `COMMAND DECK` 换成鼠标版说明
- 思考强度初始值从 `settings.json` 的 `defaultThinkingLevel` 读取
## 1.4.0

### 新增：额外分组（CC Switch 之外的中转站）

以前只有两个面（`cc-switch` Claude 面 / `ccs-codex` Codex 面）。
现在可以加任意多个自己的分组，在窗口里独立成一组。

**配置写在 `~/.pi/agent/ccswitch-extra.json`**（含 key，不进仓库）：

```json
{
  "groups": [
    {
      "id": "ccs-egg",
      "label": "鸡蛋",
      "name": "鸡蛋 · DeepSeek",
      "baseUrl": "https://your-relay.example.com/v1",
      "apiKey": "sk-...",
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
| `id` | provider id。**固定后别改**，改了默认模型会丢 |
| `label` | 窗口里显示的分组名 |
| `name` | provider 的完整名 |
| `baseUrl` / `apiKey` | 中转站地址与 key |
| `api` | `openai-responses` 或 `openai-completions` |
| `contextWindow` / `maxTokens` | 模型元数据 |
| `enabled` | 设 `false` 可临时禁用 |

加第二个分组就往 `groups` 里再塞一个对象，不用改代码。

### 实现要点

**① 和主流程一样分两段跑**

- **工厂函数**：读本地缓存注册（~1ms），保证默认模型能解析
- **`session_start`**：联网刷新

**② 网络失败不缩水**

沿用主流程那套：`fetchCodexModels` 返回 `undefined` 表示「不知道」，
这时用上次缓存，不用 pinned 单条覆盖。

**③ 分组标签从配置读**

`model-picker.ts` 的 `providerLabel()` 先查 `ccswitch-extra.json` 里的
`label`，所以新分组不用改 picker。

**④ 缓存分离**

额外分组的模型列表存 `~/.pi/agent/ccswitch-extra-models.json`，
和 CC Switch 那套互不干扰。

### 验证

真机（150 列）：

```
╔═ MODEL PICKER ══════════════════ SYS ▸ ONLINE NODE 3/3 ╤══╗
║┌─[ ccs-egg ] 鸡蛋 (2)────────────────────────────────────┐│ 1-9 0  定位到第 N 项
║▐▸  1  deepseek-v4.1-flash                  600K ◈◆      ▌│ PgUp/Dn  切换分组
║│   2  deepseek-v4.1-flash-expires-on-0910  600K ◈◆      ││ ←  →  切换分组
║└────────────────────────────────────────────────────────┘│ d  D  设为默认
                                                             │ 总数  15
                                                             │ 分组  3
```

- `SYS ▸ ONLINE NODE 3/3`、`分组 3`、`总数 15`（3 + 10 + 2）
- 三个分组标签都对：`Claude 面` / `Codex 面` / `鸡蛋`
- 在 `ccs-egg` 组里按 `1` → `d` 成功设默认（`ccs-egg/deepseek-v4.1-flash`）
- 启动耗时 1029 / 1072 / 1066 ms（没变慢）

## 1.3.5

### 修复：默认模型失效，被顶成列表第一个

现象：`settings.json` 里明明写着

```json
"defaultProvider": "ccs-codex",
"defaultModel": "deepseek-v4.1-flash-expires-on-0910"
```

启动后却变成了 `cc-switch/[Cloud]GLM-5.3-Flash`（可选中列表的第一个）。

### 根因：v1.3.0 那次启动优化把它挪到了错误的时机

pi 的启动顺序（`main.js:575-640`）：

```
① resourceLoader 加载扩展（跑工厂函数）
② resolveModelScope
③ buildSessionOptions → 解析默认模型   ← 在这一步找 provider
④ createAgentSessionFromServices → emit session_start
```

**解析默认模型发生在 `session_start` 之前。**

v1.3.0 为了不让网络请求阻塞启动，把 provider 注册整个挪进了
`session_start`。结果第 ③ 步执行时 `ccs-codex` 还没注册：

```js
// model-resolver.js:503
if (defaultProvider && defaultModelId) {
    const found = modelRuntime.getModel(defaultProvider, defaultModelId);
    if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
        return { model, thinkingLevel, ... };      // 找不到 → 跳过
    }
}
// 第 4 步：拿第一个可用模型
const availableModels = [...modelRuntime.getAvailableSnapshot()];
return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL };
```

### 修法

把「用本地缓存注册」这一半挪回**工厂函数**（读文件约 1ms），
网络刷新仍留在 `session_start`：

```ts
// 工厂函数里（第 ③ 步之前）
const cached = readCache();
if (cached) {
  if (cached.claude.length) pi.registerProvider(CLAUDE_PROVIDER_ID, { ... });
  if (cached.codex.models.length) pi.registerProvider(CODEX_PROVIDER_ID, { ... });
}

// session_start 里只做联网刷新
pi.on("session_start", async () => { await sync(); });
```

这样两个目标同时满足：

| 目标 | 做法 |
|---|---|
| 启动不阻塞 | 工厂只读本地缓存（~1ms），不联网 |
| 默认模型能解析 | provider 在第 ③ 步之前就存在 |

### 验证

真机 footer（150 列）：

```
0.0%/600k (auto)                    deepseek-v4.1-flash-expires-on-0910 • high
```

修复前是 `[Cloud]GLM-5.3-Flash`。

| 测试 | 结果 |
|---|---|
| 默认模型 | `deepseek-v4.1-flash-expires-on-0910` ✓ |
| 启动耗时 | 1041 / 1070 / 1074 ms（没变慢）|
| 模型完整性 | `ccs-codex` 组存在，`glm-5.3` / `kimi-k3` 都在 ✓ |
## 1.3.4

### 修复：窗口里只剩 1 个模型

现象：`ccs-codex` 面从 10 个模型缩成 **1 个**（只剩卡里 pin 的那个）。

### 根因：网络抖动 → 缓存被「残缺列表」覆盖

三个环节连起来正好把一个临时故障固化成永久状态：

```
上游连接超时
   ↓
fetchCodexModels() 返回 []
   ↓
`live.length ? live : pinned` 退回卡里 pin 的单个模型
   ↓
writeCache() 把「1 个」写进缓存
   ↓
下次启动用缓存秒注册 → 永远只有 1 个
```

`sub.unsee.you` 是 Cloudflare 后的站点，实测会**间歇性连接超时**
（`UND_ERR_CONNECT_TIMEOUT`）：同一时刻 curl 能通、node fetch 超时；
重跑几次又有成功。所以这不是域名挂了，是抖。

### 修法

**① 区分「网络失败」和「真的没有模型」**

`fetchCodexModels` 现在返回 `string[] | undefined`：

```ts
// 明确的服务端回复（200/401/404）→ 算拿过答复了，可以是空数组
if (!res.ok) return [];
// 三次网络层失败 → 返回 undefined，表示「不知道」
return undefined;
```

**② 网络失败时退回旧缓存，而不是只留 pinned**

```ts
let models: string[] = [];
if (live !== undefined) {
  models = live.length ? live : pinned ? [pinned] : [];
} else {
  // live === undefined：网络失败，用上次缓存
  const prev = readCache();
  if (prev && prev.codex.baseUrl === baseUrl && prev.codex.models.length) {
    models = prev.codex.models;
  } else if (pinned) {
    models = [pinned];
  }
}
```

**③ 只拿单条结果时不覆盖缓存**

```ts
const cacheOk =
  cache.codex.models.length > 1 ||
  (cache.codex.models.length === 1 && !readCache()?.codex.models.length);
if (cache.claude.length && cacheOk) writeCache(cache);
else if (cache.claude.length) {
  // codex 面没拿到，只更新 claude 部分
  const prev = readCache();
  if (prev) writeCache({ claude: cache.claude, codex: prev.codex });
}
```

**④ 加重试**

网络层失败时重试 2 次（间隔 250ms / 500ms）；单次超时从 10s 降到 5s
（成功时实测 < 2s，5s 足够，重试也不会拖太久）。

### 验证

| 测试 | 结果 |
|---|---|
| 连续跑 3 次 `pi`，缓存稳定 | 3/3 都是 `codex=10 claude=3` |
| 模拟网络失败（超时设 1ms）| 缓存仍是 **10 个**，没被覆盖成 1 个 ✓ |
| 重试逻辑单独测 | 第 1 次 1968ms 成功 → 10 个 |
| 真机 TUI（150 列）`Ctrl+L` → `PgDn` | 窗口 `总数 13`，10 个 codex 模型全在，含 `glm-5.3` / `kimi-k3` ✓ |
| 启动耗时 | 1021 / 1007 / 1044 ms |

### 顺带

上游现在返回 **10 个**模型（`glm-5.3`、`kimi-k3` 之前一度消失，是上游自己撤了又放回来）。
## 1.3.3

### 修复：按小写 `d` 没反应

两个问题叠在一起，正好让「选中后按 `d`」这条路上什么都没有。

#### 问题 1：只认大写 `D`

```ts
if (data === "D") return this.setDefaultCursor();
```

小写 `d` 匹配不上，于是掉进了**过滤框**，被当成搜索字符 ——
列表被过滤，看着就像「没反应」。

现在大小写都认（`j k` / `r R` 同理）：

```ts
if (data === "D" || data === "d") return this.setDefaultCursor();
if (data === "R" || data === "r") { ... }
if (data === "j" || data === "J") return this.moveCursor(1);
if (data === "k" || data === "K") return this.moveCursor(-1);
```

#### 问题 2：数字键会立刻关窗

```ts
if (/^[1-9]$/.test(data)) return this.selectByNumber(Number(data));
//                                        ↑ 里面直接 finish() 关窗
```

按 `2` 窗口就关了，**根本没机会再按 `d`**。

现在数字键只**移动光标**，不选中：

```ts
private selectByNumber(n: number): void {
  ...
  this.cursor = target;
  this.status = `// PICK >> 已定位第 ${n} 项，Enter 选中 / D 设默认`;
}
```

于是「选中再按 `d`」才成立：

| 操作 | 结果 |
|---|---|
| `1-9 0` | 光标定位到该组第 N 项，**窗口不关** |
| `Enter` | 确认选择（只切当前会话）|
| `d` / `D` | 设为默认（写 `settings.json`）|

#### 顺带的文案更新

指令面板里：

```
1-9 0    定位到第 N 项      ← 原来是「选择模型」
Enter    确认选择
d  D     设为默认          ← 标注大小写都行
r  R     重新同步
```

### 验证

**单测 26/26**，覆盖：

- `d` 和 `D` 都返回 `kind=default`
- `j` / `J` / `k` 移动后再按 `d` / `D` 仍正确
- `1 2 3 0` 按下去窗口都不关
- 按 `1` 再 `d` → `default`；按 `1` 再 `Enter` → `select`
- 数字键按分组定位正确（`PgDn` 到 `ccs-codex` 组按 `2` 选中该组第 2 项）
- 超出组内数量 → 提示「第 N 项不存在」，不关窗
- `r` / `R` 重同步不关窗
- 渲染宽度 12–150 列仍然精确对齐

**真机**（node-pty，120 列）复现你的操作序列：

```
Ctrl+L  →  PgDn  →  2  →  d
```

结果：

```
╭─◆ 默认模型已设置───────────────────────────────────────────────╮
│ ccs-codex/deepseek-v4-flash-0731───────────────────────────────│
╰────────────────────────────────────────────────────────────────╯
```
## 1.3.2

### 新增：按 `D` 设默认后弹出提示条

以前按 `D` 只调 `ctx.ui.notify(..., "info")` —— 那只是往对话区追加**一行暗色小字**，
很容易被忽略。现在改成在**输入框上方**画一条赛博朋克框线提示，3 秒后自动消失：

```
╭─◆ 默认模型已设置───────────────────────────────────────────────╮
│ cc-switch/[AN]gemini-3.8-flash-thinking────────────────────────│
╰────────────────────────────────────────────────────────────────╯
```

实现用 `ctx.ui.setWidget(key, rows, { placement: "aboveEditor" })`：

```ts
ctx.ui.setWidget("model-picker-toast", [top, mid, bot], { placement: "aboveEditor" });
toastTimer = setTimeout(() => {
  ctx.ui.setWidget("model-picker-toast", undefined);   // 3 秒后消失
}, 3000);
```

- 框宽跟着终端列数走（`process.stdout.columns`，钳在 28–66，且每行宽度精确相等）
- `setWidget` 不可用时回退到 `notify`
- 普通选择（回车/数字键）也弹提示条："已切换模型"

### 顺带修正：先验证凭据，再写盘

原来顺序是「写 `settings.json` → `pi.setModel()`」，可能出现
「盘写成功了，但该 provider 没凭据、用不了」。现在调过来了：

```ts
const set = await pi.setModel(model);      // ① 先验证
if (!set) { ctx.ui.notify("没有凭据", "error"); return; }
const wrote = saveDefaultModel(...);       // ② 再写盘
```

### 验证

- 单测 18/18：命令注册 · Ctrl+L 拦截 · `/model` 放行 · 渲染宽度 12–150 列精确对齐
- 流程测试：`setModel` 调用 → `setWidget` 3 行宽度 `[60,60,60]` → `settings.json` 写入 → 3 秒后自动清除，全部通过
- 真机（node-pty 120 列）：`Ctrl+L` 开窗 ✓ 按 `D` 弹出提示条 ✓

## 1.3.1

### 窗口恢复到最后那版（赛博朋克）

v1.3.0 误把窗口退回成了旧的简版。现在恢复 v1.2.4 的外壳：

- 左右分栏，右侧 `COMMAND DECK` 指令面板
- 92% 居中 overlay
- 模型按 provider 分组，每组独立编号框
- 数字键 `1-9 / 0` 选中，`PgUp/PgDn` `←/→` 换组，`<` `>` 翻页
- `D` 设默认，`R` 重新同步，打字过滤，`Esc` 关闭

### 入口：只留 Ctrl+L

| 入口 | 说明 |
|---|---|
| `Ctrl+L` | 分组窗口（拦原始字节 `0x0C`）|
| `/models` | 同上 |
| `/mp` | 同上 |
| `/model` | **不覆盖**，保持 pi 原生 |

`/model` 覆盖在 5 个版本里始终无法稳定生效，原因层层叠加：

1. pi 在 TUI 层就吃掉 `/model`（`setupEditorSubmitHandler` 早于扩展命令）
2. `ctrl+l` 在 `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 里，`registerShortcut` 被跳过
3. 换编辑器后 pi 覆盖 `onSubmit`；差分渲染少 1 列会让画面错乱
4. 中文输入法全角 `／ｍｏｄｅｌ` 与 `/model` 永不相等

所以保留「换编辑器拦 `Ctrl+L`」这一条已经被真机验证可行的路，
不再碰 `/model`。

### 实测

真机（node-pty，150 列）：

```
╔═ MODEL PICKER ══════════════════════════════ SYS ▸ ONLINE NODE 2/2 ╤══╗
║┌─[ ccs-codex ] Codex 面 (8)─────────────────────────────────────────┐│═ COMMAND DECK
║▐▸  1  deepseek-v4-flash                              600K ◈◆       ▌│ 1-9 0  选择模型
║│   2  deepseek-v4-flash-0731                         600K ◈◆       ││ PgUp/Dn  切换分组
║│   3  deepseek-v4-pro                                600K ◈◆       ││ ←  →  切换分组
║│   4  deepseek-v4-pro-0813                           600K ◈◆       ││ ↑  ↓  移动光标
║│   5  deepseek-v4.1-flash                            600K ◈◆       ││ j  k  移动光标
║│   6  deepseek-v4.1-flash-expires-on-0910            600K ◈◆       ││ <  >  组内翻页
║│   7  glm-5.1                                        600K ◈◆       ││ Enter  确认选择
║│   8  glm-5.2                                        600K ◈◆       ││ D  设为默认
╚═▓▒░ cyberspace model selector ░▒▓═══════════════════════════════════╧══╝
```

测试 20/20：命令注册、Ctrl+L 拦截、`/model` 放行、渲染宽度 12–150 列精确对齐。

> 模型数从 13 变成 11（`ccs-codex` 8 个）是因为上游 `sub.unsee.you`
> 撤掉了 `glm-5.3` / `kimi-k3`，实时 `/models` 也确实只返回 8 个。

## 1.3.0

### 回退：不再覆盖 `/model` 和 `Ctrl+L`

试了 5 个版本都没能让 `/model` 在所有环境稳定生效。原因太多且互相叠加：

- pi 在 TUI 层就吃掉 `/model`（`setupEditorSubmitHandler` 早于扩展命令）
- `ctrl+l` 在 `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 里，扩展注册被跳过
- 换编辑器后 `onSubmit` 被 pi 覆盖、差分渲染少 1 列导致画面错乱
- 中文输入法全角 `／ｍｏｄｅｌ` 与半角不相等

**结论：不折腾了。回到 `/mp`。**

| 入口 | 说明 |
|---|---|
| `/mp` | 分组模型选择窗口 |
| `Ctrl+Shift+M` | 同上 |
| 窗口 | 92% 居中 overlay |

窗口内容（实测）：

```
▸ ccs-codex · Codex 面 (10)
▸  1  deepseek-v4-flash                600k think,img
   2  deepseek-v4-flash-0731           600k think,img
   ...
   0  kimi-k3                          600k think,img
1-9 0 选模型 · PgUp/PgDn ← → 换组 · ↑↓ jk 移动
D 设默认 · < > 翻页 · R 刷新 · 打字=过滤 · Esc 关
```

### 优化：启动快一倍

`ccswitch-sync.ts` 在扩展工厂函数里 `await sync()`，而 pi 会 `await factory(api)`，
所以整个同步（含网络请求）都在阻塞启动。

用 `PI_TIMING=1` 实测，工厂耗时 **1955ms**：

```
ccswitch-sync.ts factory: 1955ms
```

**改法**

1. `await sync()` 移进 `session_start`（TUI 就绪后才跑）。
   pi 文档保证初始加载后 `registerProvider` 立即生效。
2. 加本地缓存 `~/.pi/agent/ccswitch-models-cache.json`：
   启动时先用缓存**秒注册**，再后台联网刷新。

**效果**

| 指标 | 优化前 | 优化后 |
|---|---|---|
| `--list-models` | 2717ms | **1248ms** |
| `ccswitch-sync` 工厂 | 1955ms | **0ms** |
| TUI 就绪 | ~2.5s | **~1.6s** |

模型完整性不变（13 个：cc-switch 3 + ccs-codex 10）。

## 1.2.4

### 修复：中文输入法开着时 `/model` 打不开

**现象**：`Ctrl+L` 正常，但打字 `/model` 没反应。
关键线索就是这个组合 —— 两者走的是**同一个** `handleInput`，
一个行一个不行，说明问题不在拦截逻辑，而在**比较的字符串**。

**根因**：中文输入法处于全角状态时，`/model` 会输入成全角字符：

| 字符 | 半角（正常） | 全角（输入法） |
|---|---|---|
| `/` | `U+002F` | `U+FF0F` |
| `m` | `U+006D` | `U+FF4D` |
| `o` | `U+006F` | `U+FF4F` |
| `d` | `U+0064` | `U+FF44` |
| `e` | `U+0065` | `U+FF45` |
| `l` | `U+006C` | `U+FF4C` |

`t === "/model"` 与 `／ｍｏｄｅｌ` 不相等，自然拦不住。
而 `Ctrl+L` 是按键、不经过输入法，所以一直正常。

**修法**：比较前做全角 → 半角归一化。

```ts
function normalizeCommand(s: string): string {
  return [...s]
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0);
      if (c === 0x3000) return " ";   // 全角空格
      return ch;
    })
    .join("")
    .trim();
}
```

### 还原

- `overlayOptions` 恢复为 `width: "92%", maxHeight: "92%", anchor: "center"`（92% 居中）

### 验证

| 输入 | 结果 |
|---|---|
| `/model` | 拦截 ✓ |
| `／model`（全角斜杠） | 拦截 ✓ |
| `／ｍｏｄｅｌ`（全角） | 拦截 ✓ |
| `/model `（尾空格） | 拦截 ✓ |
| `／ｍｏｄｅｌ　`（全角+全角空格） | 拦截 ✓ |
| `/models` `/other` `hello` | 透传 ✓ |
| `Ctrl+L` | 拦截 ✓ |

每行渲染宽度在 12–150 列全部精确对齐。

真机（node-pty，150 列）验证：半角 `/model` 与全角 `／ｍｏｄｅｌ` 都能打开窗口。

## 1.2.3

### 修复：底部边框少 1 列，导致终端画面错乱

这是上两版「看起来没反应」的**真正原因**。

**症状**：按 `/model` 或 `Ctrl+L` 后终端画面撕裂、错位，左侧/右侧残留其它文字，
看起来像窗口没打开或渲染失败。

**根因**：`render()` 的底部边框比内容行**少 1 列**。

```
内容行 = ║ + leftW + │ + deckW + ║        = leftW + deckW + 3
底部行 = ╚═(2) + foot + fill + ╧ + deckW + ╝(1)
```

代码写成 `fill = leftW - 2 - foot`，但 `╚═` 占 **2** 列，应减 1：

```diff
- fill("═", leftW - 2 - visibleWidth(footShown))
+ fill("═", leftW - 1 - visibleWidth(footShown))
```

pi-tui 用差分渲染，宽度不一致的行会让终端光标定位错乱，后续所有重绘都会叠加偏移。

**验证**：断言每行 `visibleWidth(line) === 终端宽度`：

| 终端宽度 | 修复前 | 修复后 |
|---|---|---|
| 147 | 最后一行 146 ✗ | 全部 147 ✓ |
| 120 | 最后一行 119 ✗ | 全部 120 ✓ |
| 80 | 最后一行 79 ✗ | 全部 80 ✓ |
| 20 | 最后一行 19 ✗ | 全部 20 ✓ |

12 种宽度全部通过。

### 改进

- `overlayOptions` 改为 `width: "100%"` + `anchor: "top-left"`。
  原来 92% 居中会在四周留出未清除的背景残影。
- 删除 `/mp` 命令（保留 `/models` 作保底别名）。

### 真机验证

用 node-pty 起真实 TUI（150 列）并录制按键：

```
Ctrl+L   → 按键 0x0c → 命中 → 打开窗口 ✓
/model   → 按键 0x0d → 命中 → 打开窗口 ✓
窗口渲染 → 每行 150 列精确对齐 ✓
数字键 1 → 模型切换为 cc-switch/[AN]gemini-3.8-flash-thinking ✓
```

内置命令的「先例」也确认了：输入 `/model` 时上方会显示补全提示
`→ model <provider/model> — Select model`，但补全菜单**不消费 Enter**，
所以一次 Enter 即可触发。

## 1.2.2

### 修复：Ctrl+L 和 `/model` 打不开窗口

两个触发器都失效，原因是 pi 从源头堵死了。

**`Ctrl+L` 为什么不行**

`app.model.select` 默认键就是 `ctrl+l`，而且它在
`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 清单里。
`runner.getShortcuts()` 见到保留键位直接 `continue` 跳过扩展注册：

```js
if (builtInKeybinding?.restrictOverride === true) {
    addDiagnostic("conflicts with built-in shortcut. Skipping.");
    continue;
}
```

**`/model` 为什么不行**

内置 `/model` 分支在 `interactive-mode.js` 的 `setupEditorSubmitHandler()` 里，
早于扩展命令，甚至早于 `input` 事件（内置分支直接 `return`，到不了 `emitInput`）。

**修法**

唯一可行的是 `setEditorComponent` 换掉输入框，在 `handleInput` 里拦：

- `Ctrl+L` → 原始字节 `0x0C`
- `Enter` 提交的 `/model`

```js
ed.handleInput = (data) => {
  if (matchesKey(data, "ctrl+l")) { ed.setText(""); void open(ctx, false); return; }
  if (matchesKey(data, Key.enter)) {
    const t = ed.getText().trim();
    if (t === "/model" || t.startsWith("/model ")) { ed.setText(""); void open(ctx, false); return; }
  }
  superHandle(data);
};
```

### 删除

- `/mp` 命令已移除（多余）。保留 `/models` 作为保底别名
- 移除无用的 `registerShortcut("ctrl+l")` 与 `ctrl+shift+m`
  （前者被保留键位挡掉；后者在 Windows 终端编码成 Enter）

### 验证

| 场景 | 结果 |
|---|---|
| `Ctrl+L` | 已拦 |
| `/model` + Enter | 已拦 |
| 普通文本 + Enter | 透传给 pi |
| `/other` + Enter | 透传给 pi |

窗口渲染 20-140 列无溢出。

## 1.2.1

### 文档更正

修正 1.2.0 的错误声明：它说「内置键位没有 restrictOverride，扩展快捷键优先」，
这是**错的**。`app.model.select`（`ctrl+l`）就在保留清单里，扩展快捷键会被跳过。
1.2.2 已用编辑器拦截的方式真正修复。

原本 1.2.1 曾把上下文窗口统一改成 600K，该改动已回退 ——
上下文属于使用者自己的配置，不应由本插件决定。
需要的话用 `models.json` 的 `providers.<id>.modelOverrides.<modelId>.contextWindow` 覆盖。

## 1.2.0

### 新增

- **覆盖内置 /model**：靠 `setEditorComponent` 拦截提交（pi 会在工厂返回后覆盖 onSubmit，所以拦的是 handleInput 里的 Enter）
- **尝试覆盖 Ctrl+L**（1.2.2 修正：此说法错误，实际被保留键位挡掉）
- 窗口重做为赛博朋克风：双线边框、霓虹色、左右分栏
- **右侧 COMMAND DECK 指令面板**：按键表 + 实时状态（当前模型 / 总数 / 分组 / 页码）
- **自适应**：终端宽度 < 100 列时自动隐藏右侧面板
- 保底别名 `/models`（万一 /model 覆盖出问题）
- 开关 `OVERRIDE_MODEL_COMMAND`，设为 false 即可恢复 pi 原生 /model

### 修复

- 渲染溢出：左右分栏按显示宽度精确计算，20-140 列全部不超框
- 模型行光标用半边块字符代替竖线时多出 2 列的问题

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
