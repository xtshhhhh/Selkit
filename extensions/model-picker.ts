/**
 * Model Picker — 赛博朋克风分组模型选择窗口
 *
 * 解决的问题：当 pi 里同时有多个 provider（Claude 面 / Codex 面 / 多个中转站），
 * 内置 /model 是一个扁平长列表，几十条挤在一起。
 *
 * 提供的入口：
 *   Ctrl+L    → 分组窗口（靠换编辑器拦原始字节 0x0C）
 *   /models   → 同上
 *   /mp       → 同上
 *
 *   注意：/model 不覆盖，保持 pi 原生。
 *   （内置 /model 分支在 TUI 层，且输入法全角等坑太多）
 *
 * 窗口特性：
 *   - 左右分栏：左侧模型列表，右侧 COMMAND DECK 指令面板
 *   - 模型按 provider 分组，每组独立编号框
 *   - 数字键 1-9 / 0 直接选中，PgUp/PgDn 换组
 *   - D 把当前项设为 pi 的持久默认模型
 *   - 模糊过滤（支持 [Cloud]、glm-5.3 这类名字）
 *
 * 另外自动维护 settings.json 的 enabledModels。
 *
 * 依赖：只用 pi 自带组件，无第三方依赖。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─────────────────────────────────────────────────────────────
//  配置
// ─────────────────────────────────────────────────────────────

/** 每组每页最多显示多少个。 */
const PAGE_SIZE = 10;

/** 右侧指令面板宽度（列）。 */
const DECK_WIDTH = 25;

/** 终端宽度小于此值时隐藏右侧指令面板（自适应）。 */
const DECK_MIN_TERM_WIDTH = 100;

/**
 * 自动写入 settings.json 的 enabledModels。
 * 用通配符 —— CC Switch 换卡后模型名变了也不失效。
 * 设为 undefined 则完全不碰 settings.json。
 */
const ENABLED_PATTERNS: string[] | undefined = ["cc-switch/*", "ccs-codex/*"];

/**
 * 是否启用 Ctrl+L 窗口入口（需要换掉输入框）。
 * true  → Ctrl+L 打开本窗口
 * false → 完全不碰输入框；用 /models 或 /mp
 * 升级 pi 后若输入框异常，改成 false 即可恢复。
 */
const OVERRIDE_MODEL_COMMAND = true;

/**
 * 全角 → 半角归一化。
 * 中文输入法开着时打 /model 会变成 ／ｍｏｄｅｌ（U+FF0F…），
 * 直接比较会不相等。这里把全角 ASCII（U+FF01..U+FF5E）与全角空格转回半角。
 */
function normalizeCommand(s: string): string {
  return [...s]
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0);
      if (c === 0x3000) return " ";
      return ch;
    })
    .join("")
    .trim();
}

// ─────────────────────────────────────────────────────────────
//  settings.json
// ─────────────────────────────────────────────────────────────

function agentDir(): string {
  const env = process.env.PI_AGENT_DIR;
  if (env) return env.replace(/^~/, os.homedir());
  return path.join(os.homedir(), ".pi", "agent");
}

function settingsPath(): string {
  return path.join(agentDir(), "settings.json");
}

function readSettings(): Record<string, any> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

/** 原子写，写前留 .bak；坏文件不覆盖。 */
function writeSettings(next: Record<string, any>): boolean {
  const p = settingsPath();
  try {
    const current = readSettings();
    if (current === null) return false;
    fs.writeFileSync(p + ".bak", JSON.stringify(current, null, 2) + "\n");
    fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function syncEnabledModels(): void {
  if (!ENABLED_PATTERNS) return;
  const s = readSettings();
  if (!s) return;
  const cur = s.enabledModels;
  const same =
    Array.isArray(cur) &&
    cur.length === ENABLED_PATTERNS.length &&
    cur.every((v: unknown, i: number) => v === ENABLED_PATTERNS[i]);
  if (same) return;
  s.enabledModels = [...ENABLED_PATTERNS];
  writeSettings(s);
}

function saveDefaultModel(provider: string, modelId: string): boolean {
  const s = readSettings();
  if (!s) return false;
  s.defaultProvider = provider;
  s.defaultModel = modelId;
  return writeSettings(s);
}

// ─────────────────────────────────────────────────────────────
//  数据
// ─────────────────────────────────────────────────────────────

type Group = { provider: string; label: string; models: Model<Api>[] };

function providerLabel(provider: string, sample: Model<Api> | undefined): string {
  if (provider === "cc-switch") return "Claude 面";
  if (provider === "ccs-codex") return "Codex 面";
  try {
    const host = sample?.baseUrl ? new URL(sample.baseUrl).host : "";
    if (host) return host;
  } catch {}
  return "";
}

function buildGroups(models: Model<Api>[], current: Model<Api> | undefined): Group[] {
  const byProvider = new Map<string, Model<Api>[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider);
    if (list) list.push(m);
    else byProvider.set(m.provider, [m]);
  }
  const groups: Group[] = [];
  for (const [provider, list] of byProvider) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    groups.push({ provider, label: providerLabel(provider, list[0]), models: list });
  }
  groups.sort((a, b) => a.provider.localeCompare(b.provider));
  if (current) {
    const i = groups.findIndex((g) => g.provider === current.provider);
    if (i > 0) groups.unshift(...groups.splice(i, 1));
  }
  return groups;
}

/** 子序列模糊匹配。 */
function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of n) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

function fmtContext(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

/** 只用单宽字符，避免 CJK 宽度问题。 */
const G = {
  cursor: "▸",
  active: "◉",
  blank: " ",
  think: "◈",
  image: "◆",
  block: "▓",
  light: "░",
} as const;

// ─────────────────────────────────────────────────────────────
//  主题桥
// ─────────────────────────────────────────────────────────────

type ThemeLike = { fg(color: string, text: string): string; bold(text: string): string };

// 默认直通，open() 时换成真实 theme
let T: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

const neon = (s: string) => T.fg("borderAccent", s);
const cyan = (s: string) => T.fg("mdLink", s);
const dim = (s: string) => T.fg("dim", s);
const accent = (s: string) => T.fg("accent", s);
const warn = (s: string) => T.fg("warning", s);
const ok = (s: string) => T.fg("success", s);

// ─────────────────────────────────────────────────────────────
//  窗口
// ─────────────────────────────────────────────────────────────

type PickerResult =
  | { kind: "select"; model: Model<Api> }
  | { kind: "default"; model: Model<Api> }
  | { kind: "cancel" };

type PickerOptions = {
  allModels: Model<Api>[];
  enterSetsDefault: boolean;
  onDone: (r: PickerResult) => void;
  onRefresh: () => Promise<Model<Api>[]>;
  getCurrent: () => Model<Api> | undefined;
};

/** 显示宽度感知的补齐/截断。 */
function fit(s: string, width: number): string {
  if (width <= 0) return "";
  const vis = visibleWidth(s);
  if (vis > width) return truncateToWidth(s, width);
  return s + " ".repeat(width - vis);
}

function fill(ch: string, width: number): string {
  if (width <= 0) return "";
  const w = Math.max(1, visibleWidth(ch));
  return ch.repeat(Math.max(0, Math.floor(width / w)));
}

class ModelPicker implements Component {
  private readonly opts: PickerOptions;
  private filterInput: Input;
  private groups: Group[];
  private groupIndex = 0;
  private pageIndex = 0;
  private cursor = 0;
  private status = "";
  private busy = false;
  private _focused = true;

  constructor(opts: PickerOptions) {
    this.opts = opts;
    this.filterInput = new Input({ prompt: "▸ ", placeholder: "type to filter…" });
    this.filterInput.focused = true;
    this.filterInput.onEscape = () => this.opts.onDone({ kind: "cancel" });
    this.filterInput.onSubmit = () => this.selectCursor();
    this.groups = this.rebuild();
    this.clamp();
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.filterInput.focused = v;
  }

  invalidate(): void {
    this.filterInput.invalidate();
  }

  private rebuild(): Group[] {
    const q = this.filterInput.getValue().trim();
    const matched = q
      ? this.opts.allModels.filter((m) => fuzzy(m.id, q) || fuzzy(m.provider, q))
      : this.opts.allModels;
    return buildGroups(matched, this.opts.getCurrent());
  }

  private pageCount(i = this.groupIndex): number {
    const g = this.groups[i];
    if (!g) return 1;
    return Math.max(1, Math.ceil(g.models.length / PAGE_SIZE));
  }

  private pageModels(): { model: Model<Api>; num: number; localIndex: number }[] {
    const g = this.groups[this.groupIndex];
    if (!g) return [];
    const start = this.pageIndex * PAGE_SIZE;
    return g.models.slice(start, start + PAGE_SIZE).map((model, i) => ({
      model,
      num: i + 1,
      localIndex: start + i,
    }));
  }

  private clamp(): void {
    if (this.groups.length === 0) {
      this.groupIndex = 0;
      this.pageIndex = 0;
      this.cursor = 0;
      return;
    }
    this.groupIndex = Math.min(Math.max(0, this.groupIndex), this.groups.length - 1);
    const pc = this.pageCount();
    this.pageIndex = Math.min(Math.max(0, this.pageIndex), pc - 1);
    this.cursor = Math.min(
      Math.max(0, this.cursor),
      Math.max(0, this.groups[this.groupIndex].models.length - 1),
    );
  }

  private finish(model: Model<Api>, forceDefault = false): void {
    const asDefault = forceDefault || this.opts.enterSetsDefault;
    this.opts.onDone(asDefault ? { kind: "default", model } : { kind: "select", model });
  }

  private selectCursor(): void {
    const m = this.groups[this.groupIndex]?.models[this.cursor];
    if (m) this.finish(m);
  }

  private setDefaultCursor(): void {
    const m = this.groups[this.groupIndex]?.models[this.cursor];
    if (m) this.finish(m, true);
  }

  /**
   * 按页内序号把光标移过去（1-10；10 用 0）。
   *
   * 注意：这里只移动光标，不直接选中 ——
   * 否则按完数字窗口就关了，根本来不及再按 D 设默认。
   * 想选中就再按 Enter。
   */
  private selectByNumber(n: number): void {
    const g = this.groups[this.groupIndex];
    if (!g) return;
    const target = this.pageIndex * PAGE_SIZE + n - 1;
    if (!g.models[target]) {
      this.status = `// ERR >> 第 ${n} 项不存在`;
      return;
    }
    this.cursor = target;
    this.status = `// PICK >> 已定位第 ${n} 项，Enter 选中 / D 设默认`;
  }

  private moveGroup(delta: number): void {
    if (this.groups.length === 0) return;
    const n = this.groups.length;
    this.groupIndex = (this.groupIndex + delta + n) % n;
    this.pageIndex = 0;
    this.cursor = 0;
    this.status = "";
  }

  private movePage(delta: number): void {
    const pc = this.pageCount();
    this.pageIndex = (this.pageIndex + delta + pc) % pc;
    const start = this.pageIndex * PAGE_SIZE;
    this.cursor = Math.min(start, Math.max(0, this.groups[this.groupIndex].models.length - 1));
    this.status = "";
  }

  private moveCursor(delta: number): void {
    const g = this.groups[this.groupIndex];
    if (!g || g.models.length === 0) return;
    const n = g.models.length;
    this.cursor = (this.cursor + delta + n) % n;
    this.pageIndex = Math.floor(this.cursor / PAGE_SIZE);
    this.status = "";
  }

  handleInput(data: string): void {
    const filtering = this.filterInput.getValue() !== "";

    // ── 两种模式都生效 ──
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
      if (this.filterInput.getValue()) {
        this.filterInput.setValue("");
        this.groups = this.rebuild();
        this.groupIndex = 0;
        this.pageIndex = 0;
        this.cursor = 0;
        return;
      }
      return this.opts.onDone({ kind: "cancel" });
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) return this.selectCursor();
    if (matchesKey(data, Key.pageUp)) return this.moveGroup(-1);
    if (matchesKey(data, Key.pageDown)) return this.moveGroup(1);
    if (matchesKey(data, Key.up)) return this.moveCursor(-1);
    if (matchesKey(data, Key.down)) return this.moveCursor(1);

    // ── 仅当过滤框为空时这些才是命令键 ──
    if (!filtering) {
      // 大小写都认：D/d 设默认，J/K 移动，R/r 重同步
      if (/^([1-9])$/.test(data)) return this.selectByNumber(Number(data));
      if (data === "0") return this.selectByNumber(10);
      if (data === "<") return this.movePage(-1);
      if (data === ">") return this.movePage(1);
      if (data === "j" || data === "J") return this.moveCursor(1);
      if (data === "k" || data === "K") return this.moveCursor(-1);
      if (matchesKey(data, Key.left)) return this.moveGroup(-1);
      if (matchesKey(data, Key.right)) return this.moveGroup(1);

      if (data === "D" || data === "d") return this.setDefaultCursor();
      if (data === "R" || data === "r") {
        if (this.busy) return;
        this.busy = true;
        this.status = "// RESYNC >> 同步中…";
        void this.opts
          .onRefresh()
          .then((models) => {
            this.opts.allModels = models;
            this.groups = this.rebuild();
            this.clamp();
            this.status = `// RESYNC >> OK  ${models.length} 个模型`;
          })
          .catch((e) => {
            this.status = `// RESYNC >> FAIL  ${e instanceof Error ? e.message : String(e)}`;
          })
          .finally(() => {
            this.busy = false;
          });
        return;
      }
    }

    // ── 其余交给过滤框 ──
    const before = this.filterInput.getValue();
    this.filterInput.handleInput(data);
    if (this.filterInput.getValue() !== before) {
      this.groups = this.rebuild();
      this.groupIndex = 0;
      this.pageIndex = 0;
      this.cursor = 0;
      this.status = "";
    }
  }

  // ── 渲染 ──

  render(width: number): string[] {
    const hasDeck = width >= DECK_MIN_TERM_WIDTH;
    const deckW = hasDeck ? DECK_WIDTH : 0;
    // 布局: ╔ + 左栏(leftW) + [│ + deckW] + ╗  =  totalW
    const totalW = Math.max(12, width);
    const leftW = hasDeck ? totalW - 2 - deckW - 1 : Math.max(4, totalW - 2);

    const g = this.groups[this.groupIndex];
    const pc = this.pageCount();
    const cur = this.opts.getCurrent();

    // ── 左栏（不含外框）──
    const L: string[] = [];
    {
      const title = " MODEL PICKER ";
      const sys = "SYS ▸ ONLINE ";
      const node = `NODE ${this.groupIndex + 1}/${Math.max(1, this.groups.length)} `;
      const head = "═";
      const used = visibleWidth(head) + visibleWidth(title) + visibleWidth(sys) + visibleWidth(node);
      if (leftW - used >= 4) {
        L.push(neon(head) + accent(T.bold(title)) + neon(fill("═", leftW - used)) + cyan(sys) + neon(node));
      } else {
        const t = truncateToWidth(title, Math.max(4, leftW - 3));
        L.push(neon(head) + accent(T.bold(t)) + neon(fill("═", leftW - 1 - visibleWidth(t))));
      }
    }
    L.push(dim(fill("─", leftW)));

    if (!g) {
      L.push(dim("  // NO MATCH  没有匹配的模型"));
      L.push(dim("  // Esc 清空过滤 / 关闭"));
    } else {
      const lab = g.label ? ` ${g.label}` : "";
      const headPlain = "┌─[ " + g.provider + " ]" + lab + ` (${g.models.length})`;
      L.push(
        neon("┌─[") + " " + accent(g.provider) + " " + neon("]") + cyan(lab) +
          dim(` (${g.models.length})`) +
          dim(fill("─", Math.max(0, leftW - visibleWidth(headPlain) - 1))) + neon("┐"),
      );

      const rightW = 12;
      const nameW = Math.max(8, leftW - 4 - rightW);
      for (const { model, num, localIndex } of this.pageModels()) {
        const isCursor = localIndex === this.cursor;
        const isCur = cur && cur.provider === model.provider && cur.id === model.id;
        const keyLabel = num === 10 ? "0" : String(num);
        const marker = isCur ? G.active : isCursor ? G.cursor : G.blank;
        const tags = (model.reasoning ? G.think : " ") + (model.input?.includes("image") ? G.image : " ");
        const right = fmtContext(model.contextWindow) + " " + tags;
        const raw = `${marker} ${keyLabel.padStart(2)}  ${model.id}`;
        const shown = truncateToWidth(raw, nameW);
        const painted = isCur ? ok(shown) : isCursor ? accent(shown) : cyan(shown);
        const inner = painted + " ".repeat(Math.max(1, nameW - visibleWidth(shown))) + dim(fit(right, rightW));
        L.push((isCursor ? neon("▐") : dim("│")) + fit(inner, leftW - 2) + (isCursor ? neon("▌") : dim("│")));
      }
      L.push(neon("└") + dim(fill("─", leftW - 2)) + neon("┘"));
    }

    L.push(dim(fill("─", leftW)));

    if (g) {
      const startIdx = this.pageIndex * PAGE_SIZE;
      const pos = Math.min(g.models.length, Math.max(1, this.cursor - startIdx + 1));
      const barW = Math.max(6, leftW - 34);
      const filledW = Math.max(0, Math.round((pos / Math.max(1, g.models.length)) * barW));
      const bar = neon(fill(G.block, filledW)) + dim(fill(G.light, barW - filledW));
      L.push(dim(`[${pos}/${g.models.length}] `) + bar + dim(`  FILTER ${this.filterInput.getValue() ? "ON" : "OFF"}`));
    }

    if (this.status) L.push(warn(" " + this.status));

    // ── 右栏（不含外框）──
    const R: string[] = [];
    if (hasDeck) {
      R.push(accent("═ COMMAND DECK "));
      const row = (k: string, v: string) => cyan(" " + k) + dim("  " + v);
      for (const [k, v] of [
        ["1-9 0", "定位到第 N 项"],
        ["PgUp/Dn", "切换分组"],
        ["←  →", "切换分组"],
        ["↑  ↓", "移动光标"],
        ["j  k", "移动光标"],
        ["<  >", "组内翻页"],
        ["Enter", "确认选择"],
        ["d  D", "设为默认"],
        ["r  R", "重新同步"],
        ["Esc", "关闭窗口"],
      ] as [string, string][]) {
        R.push(row(k, v));
      }
      R.push(dim(fill("─", deckW)));
      R.push(accent(" ░ STATUS ░"));
      R.push(dim("  当前"));
      R.push(dim("  " + (cur ? truncateToWidth(cur.id, deckW - 4) : "—")));
      R.push(row("总数", String(this.opts.allModels.length)));
      R.push(row("分组", String(this.groups.length)));
      R.push(row("页码", pc > 1 ? `${this.pageIndex + 1}/${pc}` : "—"));
    }

    // ── 拼装 ──
    const head = L.shift() ?? "";
    L.pop(); // 丢弃左栏最后的分隔线（底栏另画）
    if (L.length > 0 && L[L.length - 1] === undefined) L.pop();

    const rows = Math.max(L.length, R.length);
    const out: string[] = [neon("╔") + fit(head, leftW) + (hasDeck ? neon("╤") + dim(fill("═", deckW)) : "") + neon("╗")];

    for (let i = 0; i < rows; i++) {
      out.push(
        neon("║") + fit(L[i] ?? "", leftW) + (hasDeck ? neon("│") + fit(R[i] ?? "", deckW) : "") + neon("║"),
      );
    }

    // 底部边框宽度必须与内容行完全相等，否则终端重绘会错位。
    // 内容行 = ║ + leftW + │ + deckW + ║      = leftW + deckW + 3
    // 底部行 = ╚═ + foot + fill + ╧ + deckW + ╝ = foot + fill + deckW + 4
    // 令两者相等 → fill = leftW - foot - 1
    const foot = "▓▒░ cyberspace model selector ░▒▓";
    const footShown = truncateToWidth(foot, Math.max(4, leftW - 2));
    out.push(
      neon("╚═") + dim(footShown) + neon(fill("═", Math.max(0, leftW - 1 - visibleWidth(footShown)))) +
        (hasDeck ? neon("╧") + dim(fill("═", deckW)) : "") + neon("╝"),
    );

    return out;
  }

  snapshot() {
    return {
      groups: this.groups,
      groupIndex: this.groupIndex,
      pageIndex: this.pageIndex,
      cursor: this.cursor,
      filter: this.filterInput.getValue(),
    };
  }
}

// ─────────────────────────────────────────────────────────────
//  扩展入口
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ─────────────────────────────────────────────────────────────
  //  提示条（输入框上方，几秒后自动消失）
  // ─────────────────────────────────────────────────────────────
  //
  // 不用 ctx.ui.notify("info")：它只往对话区追加一行暗色文字，容易被忽略。
  // 这里用 setWidget 在输入框上方画一条框线提示。
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function toast(ctx: ExtensionContext, title: string, body: string, kind: "ok" | "warn"): void {
    const tint = kind === "ok" ? ok : warn;
    const mark = kind === "ok" ? "◆" : "▲";
    const w = Math.max(28, Math.min(66, process.stdout.columns ?? 60));
    const inner = w - 4;
    const head = mark + " " + title;
    const padTo = (t: string) => t + " ".repeat(Math.max(0, inner - visibleWidth(t)));
    const top = neon("╭─") + tint(head) +
      neon(fill("─", Math.max(0, w - 4 - visibleWidth(head)))) + neon("─╮");
    const mid = dim("│") + " " + accent(padTo(body)) + " " + dim("│");
    const bot = neon("╰") + neon(fill("─", w - 2)) + neon("╯");
    try {
      ctx.ui.setWidget("model-picker-toast", [top, mid, bot], { placement: "aboveEditor" });
    } catch {
      ctx.ui.notify(head + " " + body, kind === "ok" ? "info" : "warning");
      return;
    }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      try { ctx.ui.setWidget("model-picker-toast", undefined); } catch {}
    }, 3000);
  }
  async function open(ctx: ExtensionContext, enterSetsDefault: boolean): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Model Picker 需要交互模式（TUI）", "warning");
      return;
    }

    let allModels: Model<Api>[] = [];
    try {
      await ctx.modelRegistry.refresh();
      allModels = ctx.modelRegistry.getAvailable();
    } catch {
      allModels = ctx.modelRegistry.getAvailable();
    }

    if (allModels.length === 0) {
      ctx.ui.notify("没有可用模型（检查 provider 凭据）", "warning");
      return;
    }

    const result = await ctx.ui.custom<PickerResult>(
      (tui, theme, _kb, done) => {
        T = theme as unknown as ThemeLike;
        const picker = new ModelPicker({
          allModels,
          enterSetsDefault,
          getCurrent: () => ctx.model as Model<Api> | undefined,
          onDone: (r) => done(r),
          onRefresh: async () => {
            await ctx.modelRegistry.refresh();
            return ctx.modelRegistry.getAvailable();
          },
        });
        // ── 终端会把 Enter 发成 \r\n 两个字节 ──
        // 第一个字节（\r）被编辑器层截住、开窗；第二个（\n）这时已经
        // 落到窗口上，会被当成确认键 —— 结果是「开一下就关」。
        // 所以刚开窗的头 200ms 内丢弃 Enter 类字节。
        const openedAt = Date.now();
        const isEnter = (d: string) =>
          d === "\r" || d === "\n" || d === "\u001b[13u" || d === "\u001b[13;1u";

        return {
          focused: true,
          render(w: number): string[] {
            return picker.render(w);
          },
          invalidate() {
            picker.invalidate();
          },
          handleInput(data: string) {
            if (Date.now() - openedAt < 200 && isEnter(data)) return;
            picker.handleInput(data);
            tui.requestRender();
          },
        } as Component & { focused: boolean };
      },
      { overlay: true, overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center" } },
    );

    if (!result || result.kind === "cancel") return;
    const model = result.model;

    if (result.kind === "default") {
      // 先验证凭据再写盘，避免「写成功但用不了」
      const set = await pi.setModel(model);
      if (!set) {
        ctx.ui.notify(`没有 ${model.provider}/${model.id} 的凭据`, "error");
        return;
      }
      const wrote = saveDefaultModel(model.provider, model.id);
      if (wrote) {
        toast(ctx, "默认模型已设置", `${model.provider}/${model.id}`, "ok");
      } else {
        toast(ctx, "已切换，但写盘失败", `${model.provider}/${model.id}`, "warn");
      }
      return;
    }

    const set = await pi.setModel(model);
    if (!set) {
      ctx.ui.notify(`没有 ${model.provider}/${model.id} 的凭据`, "error");
      return;
    }
    toast(ctx, "已切换模型", `${model.provider}/${model.id}`, "ok");
  }

  const handler = async (args: string, ctx: ExtensionContext) => {
    await open(ctx, (args ?? "").trim().toLowerCase() === "default");
  };

  // 只留 /model 一个入口（/mp 已按要求删除）
  pi.registerCommand("models", { description: "分组模型选择窗口（同 Ctrl+L）", handler });
  pi.registerCommand("mp", { description: "分组模型选择窗口（同 Ctrl+L）", handler });

  // ── 只提供 Ctrl+L 入口 ──
  //
  // 为什么必须换编辑器（三条路都被 pi 堵死了）：
  //   1. registerCommand("model")  —— 无效。内置 /model 分支在
  //      interactive-mode.js 的 setupEditorSubmitHandler 里，早于扩展命令。
  //   2. registerShortcut("ctrl+l") —— 无效。app.model.select 默认键就是
  //      ctrl+l，且它在 RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS 清单里，
  //      runner.getShortcuts() 会直接 continue 跳过扩展注册。
  //   3. input 事件  —— 无效。内置命令在 TUI 层就 return 了，根本到不了
  //      emitInput。
  //
  // 唯一可行：用 setEditorComponent 换掉输入框，在 handleInput 里拦 Ctrl+L
  //（原始字节 0x0C）。/model 不插手，避开输入法全角等一堆麻烦。
  //
  //
  // 坑：pi 在工厂返回后会执行 newEditor.onSubmit = defaultEditor.onSubmit，
  // 覆盖我们设的 onSubmit，所以只能拦 handleInput。
  if (OVERRIDE_MODEL_COMMAND) {
    pi.on("session_start", async (_e, ctx) => {
      if (ctx.mode !== "tui") return;
      try {
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
          const ed = new CustomEditor(tui, theme, keybindings);
          const superHandle = ed.handleInput.bind(ed);

          ed.handleInput = (data: string) => {
            // ① Ctrl+L：内置键位被保留，只能在这里截
            if (matchesKey(data, "ctrl+l")) {
              ed.setText("");
              void open(ctx, false);
              return;
            }
            // ② /model 不插手，原样交给 pi
            superHandle(data);
          };

          return ed;
        });
      } catch {
        /* 换编辑器失败 → 退回 /models */
      }
    });
  }

  pi.on("session_start", async () => {
    try {
      syncEnabledModels();
    } catch {}
  });
}
