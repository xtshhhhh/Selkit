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

// ── 鼠标（SGR 1006 扩展模式）──────────────────────────────
//
// 实测：pi 把鼠标序列原样送进组件的 handleInput，但从不调用
// handleMouse。所以这里自己解析。
//
//   ESC [ < btn ; col ; row M    按下
//   ESC [ < btn ; col ; row m    抬起
//
// col/row 是 1-based。btn 位含义：
//   0=左键 1=中键 2=右键 32=左键拖动 64=滚轮上 65=滚轮下

// pi-tui 进 TUI 时只开了 ?1003h（任意移动）和 ?1006h（SGR 格式），
// 没开 ?1000h（按钮事件）—— 所以只报移动、不报点击。
// 打开窗口时自己补上，关窗时还原，免得影响 pi 自身的输入处理。
const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1000l\u001b[?1002l";

const MOUSE_RE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

interface MouseHit {
  type: "press" | "release" | "wheel";
  button: number;
  x: number; // 0-based
  y: number; // 0-based
  wheel: number; // -1 上 1 下 0 无
}

function parseMouse(data: string): MouseHit | undefined {
  const m = MOUSE_RE.exec(data);
  if (!m) return undefined;
  const btn = Number(m[1]);
  const x = Number(m[2]) - 1;
  const y = Number(m[3]) - 1;
  const up = m[4] === "m";
  const wheelBit = btn & 64;
  if (wheelBit) {
    return { type: "wheel", button: btn & 3, x, y, wheel: (btn & 1) === 0 ? -1 : 1 };
  }
  // 32=拖动，44=拖动抬起等，统一当 motion 忽略
  if ((btn & 32) !== 0 && !up) return undefined;
  return { type: up ? "release" : "press", button: btn & 3, x, y, wheel: 0 };
}

// ── 思考强度 ──────────────────────────────────────────────
const THINK_LEVELS = ["low", "medium", "high"] as const;
type ThinkLevel = (typeof THINK_LEVELS)[number];

/** 双击判定窗口（毫秒）。 */
const DOUBLE_CLICK_MS = 420;

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

/** 把思考强度写进 settings.json 的 defaultThinkingLevel。 */
function saveThinkingLevel(level: string): boolean {
  const s = readSettings();
  if (!s) return false;
  s.defaultThinkingLevel = level;
  return writeSettings(s);
}

/** 读当前思考强度（settings.json 里没有就返回 undefined）。 */
function readThinkingLevel(): string | undefined {
  const s = readSettings();
  const v = s?.defaultThinkingLevel;
  return typeof v === "string" ? v : undefined;
}

// ─────────────────────────────────────────────────────────────
//  数据
// ─────────────────────────────────────────────────────────────

type Group = { provider: string; label: string; models: Model<Api>[] };

/**
 * 分组标题右边的注释。
 *
 * 除内置两个面外，其余分组从 ~/.pi/agent/ccswitch-extra.json 里读 label，
 * 这样加新中转站时不用改这里。
 */
function providerLabel(provider: string, sample: Model<Api> | undefined): string {
  if (provider === "cc-switch") return "Claude 面";
  if (provider === "ccs-codex") return "Codex 面";

  // 额外分组：读配置里的 label
  try {
    const p = path.join(os.homedir(), ".pi", "agent", "ccswitch-extra.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const g = (j?.groups ?? []).find((x: any) => x?.id === provider);
    if (g?.label) return String(g.label);
  } catch {}

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
  | { kind: "select"; model: Model<Api>; think: string }
  | { kind: "default"; model: Model<Api>; think: string }
  | { kind: "cancel" };

type PickerOptions = {
  allModels: Model<Api>[];
  enterSetsDefault: boolean;
  onDone: (r: PickerResult) => void;
  onRefresh: () => Promise<Model<Api>[]>;
  getCurrent: () => Model<Api> | undefined;
  /** 用于鼠标操作后请求重绘。 */
  tui?: any;
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

  // ── 鼠标：渲染时记录命中区域，点击时反查 ──
  /** 分组按钮条上每个按钮的 x 区间（该行是 y=1，即 0-based row 1）。 */
  private tabHits: { i: number; from: number; to: number }[] = [];
  /** 模型列表每行对应的「页内序号」（0-based）；-1 表示该行不是模型行。 */
  private rowHits: number[] = [];
  /** 思考强度按钮的 x 区间。 */
  private thinkHits: { i: number; from: number; to: number }[] = [];
  /** 渲染时记录的布局信息，供鼠标反查。 */
  private layout = { tabRow: 1, listTop: 3, thinkRow: 0, width: 0 };
  /** 模型列表第一行在 L 中的下标（不含外层标题行）。 */
  private listTopRow = 0;

  /** 上次点击（判定双击）。 */
  private lastClick = { at: 0, key: "" };

  /** 当前思考强度。 */
  private think: ThinkLevel = "high";

  /** 用 settings.json 里的 defaultThinkingLevel 覆盖初始值。 */
  private loadThink(): void {
    const v = readThinkingLevel();
    if (v && (THINK_LEVELS as readonly string[]).includes(v)) this.think = v as ThinkLevel;
  }

  constructor(opts: PickerOptions) {
    this.opts = opts;
    this.filterInput = new Input({ prompt: "▸ ", placeholder: "type to filter…" });
    this.filterInput.focused = true;
    this.filterInput.onEscape = () => this.opts.onDone({ kind: "cancel" });
    this.filterInput.onSubmit = () => this.selectCursor();
    this.groups = this.rebuild();
    this.clamp();
    this.loadThink();
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
    this.opts.onDone({ kind: asDefault ? "default" : "select", model, think: this.think });
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

  // ─────────────────────────────────────────────────────────
  //  思考强度
  // ─────────────────────────────────────────────────────────

  private setThink(i: number): void {
    const lv = THINK_LEVELS[Math.max(0, Math.min(THINK_LEVELS.length - 1, i))];
    if (!lv) return;
    this.think = lv;
    this.status = `// THINK >> ${lv}`;
  }

  private moveThink(delta: number): void {
    const i = THINK_LEVELS.indexOf(this.think);
    this.setThink((i + delta + THINK_LEVELS.length) % THINK_LEVELS.length);
  }

  // ─────────────────────────────────────────────────────────
  //  鼠标
  // ─────────────────────────────────────────────────────────
  //
  // pi 不转发 handleMouse，所以这里解析 SGR 序列，再用渲染时
  // 记录的命中区域反查点到了什么。

  private hitTab(y: number, x: number): number | undefined {
    for (const h of this.tabHits) if (x >= h.from && x < h.to) return h.i;
    return undefined;
  }

  private hitThink(y: number, x: number): number | undefined {
    for (const h of this.thinkHits) if (x >= h.from && x < h.to) return h.i;
    return undefined;
  }

  /** 模型列表里第 y 行对应哪个模型（返回组内绝对下标）。 */
  private hitModel(y: number): number | undefined {
    const rel = y - this.layout.listTop;
    if (rel < 0 || rel >= this.rowHits.length) return undefined;
    const local = this.rowHits[rel];
    if (local === undefined || local < 0) return undefined;
    return this.pageIndex * PAGE_SIZE + local;
  }

  /**
   * pi 的 overlay 鼠标分发入口。
   *
   * pi 的 event 形如：
   *   { type: "press"|"release"|"click"|"wheel"|"move"|"drag",
   *     button: "left"|"middle"|"right"|"none",
   *     x, y, width, height, wheelDelta?, clickCount? }
   * 坐标已相对本 overlay。返回 true 表示需要重绘。
   */
  /**
   * pi 的 overlay 鼠标分发入口。
   *
   * pi 的事件形如：
   *   { type: "press"|"release"|"click"|"wheel"|"move"|"drag",
   *     button: "left"|"middle"|"right"|"none",
   *     x, y, width, height, wheelDelta?, clickCount? }
   * 坐标已相对本 overlay。返回 true 表示需要重绘。
   *
   * 关键：**只认 pi 的 click，不自己判双击**。
   * pi 对一次单击会依次发 press → release → click，自己再判一次双击
   * 会把 press 和 click 当成两次点击，反而永远判不出真正的双击。
   * pi 在 click 里已经带了 clickCount，直接用。
   */
  handleMouseEvent(event: any): boolean {
    if (!event) return false;
    const x = Number(event.x ?? 0);
    const y = Number(event.y ?? 0);

    // ── 滚轮 ──
    if (event.type === "wheel" || event.wheelDelta !== undefined) {
      const d = (event.wheelDelta ?? 0) < 0 ? -1 : 1;
      this.onMouse({ type: "wheel", button: 0, x, y, wheel: d }, this.opts.tui);
      return true;
    }

    // press / release 必须「认领」这次手势，两个原因：
    //
    // 1. pi 只有在组件对 press 返回真值时，才会记下 mousePressTarget
    //    （见 handleMouseEvent：type==="press" && (…mousePressTarget=result.target)）
    // 2. 之后 release 才会走 getComponentClickCount 去累加 clickCount
    //
    // 我们若对 press 返回假值，pi 就把点击交给文本选择逻辑，
    // 每次都是全新一轮 —— clickCount 永远是 1，双击永远不成立。
    if (event.type === "press") {
      const i = this.hitModel(y);
      // 只认领列表里的（以及标签条/思考条上的）点击，别抢别处的
      const mine = y === this.layout.tabRow || y === this.layout.thinkRow || i !== undefined;
      return mine;
    }
    if (event.type === "release") return false;
    if (event.type !== "click") return false;
    if (event.button !== "left" && event.button !== undefined) return false;

    return this.clickAt(x, y, (event.clickCount ?? 1) >= 2);
  }

  /** 处理一次点击；(x,y) 是 overlay 内 0-based 坐标。 */
  private clickAt(x: number, y: number, doubleClick: boolean): boolean {
    // ── 分组按钮条 ──
    if (y === this.layout.tabRow) {
      const i = this.hitTab(y, x);
      if (i === undefined || i === this.groupIndex) return false;
      this.groupIndex = i;
      this.pageIndex = 0;
      this.cursor = 0;
      this.status = "";
      return true;
    }

    // ── 思考强度 ──
    if (y === this.layout.thinkRow) {
      const i = this.hitThink(y, x);
      if (i === undefined) return false;
      this.setThink(i);
      return true;
    }

    // ── 模型列表 ──
    const idx = this.hitModel(y);
    if (idx === undefined) return false;
    const g = this.groups[this.groupIndex];
    const model = g?.models[idx];
    if (!model) return false;

    this.cursor = idx - this.pageIndex * PAGE_SIZE;

    if (doubleClick) {
      this.finish(model); // 双击 = 确认选择
      return true;
    }

    this.status = `// PICK >> ${model.id}  （双击确认 · d 设默认）`;
    return true;
  }
  private onMouse(ev: MouseHit, tui: any): void {
    const { x, y } = ev;

    // ── 滚轮：上下移动光标，到头就翻页 ──
    if (ev.type === "wheel") {
      const g = this.groups[this.groupIndex];
      if (!g) return;
      const n = g.models.length;
      const next = this.cursor + ev.wheel;
      if (next < 0 || next >= n) {
        this.movePage(ev.wheel);
      } else {
        this.cursor = next;
        // 滚出当前页就自动翻页
        const page = Math.floor(this.cursor / PAGE_SIZE);
        if (page !== this.pageIndex) this.pageIndex = page;
      }
      tui.requestRender();
      return;
    }

    if (ev.type !== "press" || ev.button !== 0) return;

    // ── 分组按钮条 ──
    if (y === this.layout.tabRow) {
      const i = this.hitTab(y, x);
      if (i !== undefined && i !== this.groupIndex) {
        this.groupIndex = i;
        this.pageIndex = 0;
        this.cursor = 0;
        this.status = "";
        tui.requestRender();
      }
      return;
    }

    // ── 思考强度按钮 ──
    if (y === this.layout.thinkRow) {
      const i = this.hitThink(y, x);
      if (i !== undefined) {
        this.setThink(i);
        tui.requestRender();
      }
      return;
    }

    // ── 模型列表 ──
    const idx = this.hitModel(y);
    if (idx === undefined) return;
    const g = this.groups[this.groupIndex];
    const model = g?.models[idx];
    if (!model) return;

    // 双击判定
    const now = Date.now();
    const key = model.provider + "/" + model.id;
    const isDouble = this.lastClick.key === key && now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { at: now, key };

    this.cursor = idx - this.pageIndex * PAGE_SIZE;
    if (isDouble) {
      this.lastClick = { at: 0, key: "" };
      this.finish(model); // 双击 = 确认选择
      return;
    }
    this.status = `// PICK >> ${model.id}  （双击确认 · d 设默认）`;
    tui.requestRender();
  }

  handleInput(data: string, tui?: any): void {
    // 鼠标序列优先处理（pi 不会走 handleMouse）
    
    const mouse = parseMouse(data);
    if (mouse) {
      this.onMouse(mouse, tui ?? this.opts.tui);
      return;
    }

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
    const totalW = Math.max(2, width);
    const leftW = hasDeck ? totalW - 2 - deckW - 1 : Math.max(2, totalW - 2);

    const cur = this.opts.getCurrent();
    const inner = leftW; // 左栏可用宽度（不含外框竖线）

    // ── 命中区域重置（每次渲染重建）──
    this.tabHits = [];
    this.rowHits = [];
    this.thinkHits = [];
    this.layout.width = totalW;
    

    const L: string[] = [];
    const push = (line: string) => {
      L.push(fit(line, inner));
      return L.length - 1; // 返回该行在 L 里的下标
    };

    // ══════════════════════════════════════════════════════
    //  分组按钮条（第 1 行，可点击）
    // ══════════════════════════════════════════════════════
    //
    // 用 L 的下标记录 y；最外层还会加一行标题，所以真实 y 要 +1。
    {
      const parts: string[] = [];
      let x = 0;
      const tabs: { i: number; from: number; to: number }[] = [];
      for (let i = 0; i < this.groups.length; i++) {
        const g = this.groups[i]!;
        const label = g.provider === "cc-switch" ? "Claude" : g.provider === "ccs-codex" ? "Codex" : (g.label || g.provider);
        const on = i === this.groupIndex;
        const text = " " + label + " ";
        // 装饰符不占「逻辑宽度」但占「屏幕宽度」：
        //   ▐ / ▌ 各 1 列，▕ / ▏ 各 1 列
        // 命中区间要把它们算进去，否则点标签边缘会落空。
        const before = parts.length ? " " : "";
        x += visibleWidth(before);
        parts.push(before);
        const from = x;
        x += 1 + visibleWidth(text) + 1;
        const to = x;
        parts.push(on ? neon("▐") + accent(T.bold(text)) + neon("▌") : dim("▕") + cyan(text) + dim("▏"));
        tabs.push({ i, from, to });
      }
      if (!this.groups.length) parts.push(dim("  // NO GROUPS"));
      const pad = Math.max(0, inner - x);
      const row = parts.join("") + " ".repeat(pad);
      const y = push(row);
      for (const t of tabs) this.tabHits.push({ i: t.i, from: t.from, to: t.to });
      this.layout.tabRow = y + 1; // +1：拼装时最外层会先插一行标题
    }

    // ── 分隔线 ──
    push(neon("═".repeat(Math.max(0, inner))));

    // ══════════════════════════════════════════════════════
    //  模型列表
    // ══════════════════════════════════════════════════════
    const g = this.groups[this.groupIndex];
    const pc = this.pageCount();

    if (!g) {
      push(dim("  // NO MATCH  没有匹配的模型"));
      push(dim("  // Esc 清空过滤 / 关闭"));
    } else {
      const head = ` ${g.provider} ` + (g.label ? `${g.label} ` : "") + `(${g.models.length})`;
      push(dim("─") + accent(T.bold(head)) + dim("─".repeat(Math.max(0, inner - visibleWidth(head) - 1))));
      this.listTopRow = L.length; // 下一行就是第一个模型

      const rightW = 13;
      const nameW = Math.max(8, inner - 4 - rightW);
      const rows = this.pageModels();

      for (const { model, num, localIndex } of rows) {
        const isCursor = localIndex === this.cursor;
        const isCur = !!cur && cur.provider === model.provider && cur.id === model.id;
        const keyLabel = num === 10 ? "0" : String(num);
        const marker = isCur ? G.active : isCursor ? G.cursor : G.blank;
        const tags = (model.reasoning ? G.think : " ") + (model.input?.includes("image") ? G.image : " ");
        const right = fmtContext(model.contextWindow) + " " + tags;
        const raw = `${marker} ${keyLabel.padStart(2)}  ${model.id}`;
        const shown = truncateToWidth(raw, nameW);
        const painted = isCur ? ok(shown) : isCursor ? accent(T.bold(shown)) : cyan(shown);
        const body = painted + " ".repeat(Math.max(1, nameW - visibleWidth(shown))) + dim(fit(right, rightW));
        push((isCursor ? neon("▐") : dim("│")) + fit(body, inner - 2) + (isCursor ? neon("▌") : dim("│")));
        this.rowHits.push(localIndex);
      }

      // 补空行，让列表高度稳定（翻页时光标不跳）
      for (let i = rows.length; i < PAGE_SIZE; i++) {
        push(dim("│") + " ".repeat(Math.max(0, inner - 2)) + dim("│"));
        this.rowHits.push(-1);
      }

      push(neon("└") + dim("─".repeat(Math.max(0, inner - 2))) + neon("┘"));
    }

    // 列表第一行的 y = 它在 render() 输出里的下标。
    // 注意：pi 给 handleMouse 的 event.y 就是 render() 输出的行号，
    // 不需要再补偿任何偏移。
    this.layout.listTop = this.listTopRow + 1; // +1：同上

    // ── 进度条 ──
    if (g) {
      const startIdx = this.pageIndex * PAGE_SIZE;
      const pos = Math.min(g.models.length, Math.max(1, this.cursor - startIdx + 1));
      const barW = Math.max(6, inner - 34);
      const filledW = Math.max(0, Math.round((pos / Math.max(1, g.models.length)) * barW));
      const bar = neon(fill(G.block, filledW)) + dim(fill(G.light, barW - filledW));
      push(dim(`[${pos}/${g.models.length}] `) + bar + dim(`  FILTER ${this.filterInput.getValue() ? "ON " : "OFF"}`));
    }

    // ══════════════════════════════════════════════════════
    //  思考强度（底部，可点击）
    // ══════════════════════════════════════════════════════
    //
    // 注意：这一行必须落在固定的 y 上，所以放在 status 之前。
    // 否则每次 status 出现/消失，思考条的 y 就会漂 1 行，
    // 渲染时记录的命中区域和用户实际点的位置对不上。
    {
      const label = " 思考 ";
      const parts: string[] = [dim(label)];
      let x = visibleWidth(label);
      for (let i = 0; i < THINK_LEVELS.length; i++) {
        const lv = THINK_LEVELS[i]!;
        const on = this.think === lv;
        const text = " " + lv + " ";
        const from = x;
        x += visibleWidth(text);
        parts.push(on ? ok(T.bold(text)) : dim(text));
        this.thinkHits.push({ i, from, to: x });
        if (i < THINK_LEVELS.length - 1) { parts.push(dim("│")); x += 1; }
      }
      const pad = Math.max(0, inner - x);
      const y = push(parts.join("") + " ".repeat(pad));
      this.layout.thinkRow = y + 1; // +1：同上
    }

    // status 放最后，它变长变短都不影响上面各行的 y
    if (this.status) push(warn(" " + this.status));

    // ══════════════════════════════════════════════════════
    //  右栏 COMMAND DECK
    // ══════════════════════════════════════════════════════
    const R: string[] = [];
    if (hasDeck) {
      const row = (k: string, v: string) => cyan(" " + k) + dim("  " + v);
      R.push(accent("═ COMMAND DECK "));
      for (const [k, v] of [
        ["鼠标", "单击选中"],
        ["双击", "确认选择"],
        ["滚轮", "上下移动"],
        ["点标签", "切换分组"],
        ["点思考", "设置强度"],
        ["←  →", "切换分组"],
        ["↑  ↓", "移动光标"],
        ["1-9 0", "定位第 N 项"],
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

    // ══════════════════════════════════════════════════════
    //  拼装外框
    // ══════════════════════════════════════════════════════
    // 内容行 = ║ + leftW + │ + deckW + ║
    // 顶行   = ╔ + title/fill(leftW) + ╤ + deckW + ╗
    const used = visibleWidth(" MODEL PICKER ") + visibleWidth("SYS ▸ ONLINE ") +
      visibleWidth(`NODE ${this.groupIndex + 1}/${Math.max(1, this.groups.length)} `);
    let top: string;
    if (leftW - used - 1 >= 4) {
      top = neon("═") + accent(T.bold(" MODEL PICKER ")) +
        neon(fill("═", leftW - used - 1)) + cyan("SYS ▸ ONLINE ") +
        neon(`NODE ${this.groupIndex + 1}/${Math.max(1, this.groups.length)} `);
    } else {
      const t = truncateToWidth(" MODEL PICKER ", Math.max(4, leftW - 3));
      top = neon("═") + accent(T.bold(t)) + neon(fill("═", leftW - 1 - visibleWidth(t)));
    }

    const rowsN = Math.max(L.length, R.length);
    const out: string[] = [
      neon("╔") + fit(top, leftW) + (hasDeck ? neon("╤") + dim(fill("═", deckW)) : "") + neon("╗"),
    ];
    for (let i = 0; i < rowsN; i++) {
      out.push(
        neon("║") + fit(L[i] ?? "", leftW) + (hasDeck ? neon("│") + fit(R[i] ?? "", deckW) : "") + neon("║"),
      );
    }

    // 底行宽度必须与内容行完全相等，否则终端重绘错位。
    // 内容行 = ║ + leftW + │ + deckW + ║ = leftW + deckW + 3
    // 底行   = ╚═ + foot + fill + ╧ + deckW + ╝ = foot + fill + deckW + 4
    // 令相等 → fill = leftW - foot - 1
    const foot = "▓▒░ cyberspace model selector ░▒▓";
    const footShown = truncateToWidth(foot, Math.max(4, leftW - 2));
    out.push(
      neon("╚═") + dim(footShown) +
        neon(fill("═", Math.max(0, leftW - 1 - visibleWidth(footShown)))) +
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

    // 补开按钮事件追踪（pi 只开了移动追踪）。
    // 忘了关的话，pi 自己的鼠标处理会收到多余的 press/release。
    let mouseOn = false;
    try {
      process.stdout.write(MOUSE_ON);
      mouseOn = true;
    } catch {
      /* 写不了就算了，键盘仍可用 */
    }

    const result = await ctx.ui.custom<PickerResult>(
      (tui, theme, _kb, done) => {
        T = theme as unknown as ThemeLike;
        const picker = new ModelPicker({
          allModels,
          enterSetsDefault,
          getCurrent: () => ctx.model as Model<Api> | undefined,
          onDone: (r) => done(r),
          tui, // 鼠标操作后请求重绘用
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
            picker.handleInput(data, tui);
            tui.requestRender();
          },
          // ── 鼠标 ──
          //
          // pi 会把 SGR 序列全部消费掉，然后走 dispatchMouseToOverlay →
          // component.handleMouse(event)。所以必须实现在这里，
          // 光有 handleInput 是收不到的。
          //
          // event.x / event.y 已经是相对本 overlay 左上角的 0-based 坐标。
          // ── 鼠标 ──
          //
          // pi 的 dispatchMouseEvent 有个坑：返回对象里必须带
          // handled / capture / focus 之一，否则整个结果被丢弃，
          // pi 就不会记下 mousePressTarget，双击计数也永远涨不起来。
          // 所以这里固定回 handled: true。
          handleMouse(event: any) {
            const redraw = picker.handleMouseEvent(event);
            if (redraw) tui.requestRender();
            return { handled: true, render: redraw };
          },
        } as Component & { focused: boolean; handleMouse?: (e: any) => any };
      },
      { overlay: true, overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center" } },
    );

    if (mouseOn) {
      try { process.stdout.write(MOUSE_OFF); } catch {}
    }

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
      saveThinkingLevel(result.think);
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
    const thinkChanged = result.think !== readThinkingLevel();
    if (thinkChanged) saveThinkingLevel(result.think);
    toast(
      ctx,
      "已切换模型",
      `${model.provider}/${model.id}${thinkChanged ? `  ·  ${result.think}` : ""}`,
      "ok",
    );
  }

  const handler = async (args: string, ctx: ExtensionContext) => {
    await open(ctx, (args ?? "").trim().toLowerCase() === "default");
  };

  // 三个入口等效，随便用哪个
  pi.registerCommand("models", { description: "分组模型选择窗口（同 Ctrl+L）", handler });
  pi.registerCommand("mp", { description: "分组模型选择窗口（同 Ctrl+L）", handler });

  // ── Ctrl+L 入口
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
