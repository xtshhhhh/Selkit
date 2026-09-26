# Changelog

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
