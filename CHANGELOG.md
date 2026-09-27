# Changelog

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
