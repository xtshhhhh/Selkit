/**
 * Model Picker — 分组模型选择窗口
 *
 * 解决的问题：当 pi 里同时有多个 provider（Claude 面 / Codex 面 / 多个中转站），
 * 内置 /model 是一个扁平长列表，几十条挤在一起。
 *
 * 这个扩展提供 /mp 命令，打开一个居中的浮层窗口：
 *   - 模型按 provider 分组显示，一眼看清哪个面有哪些模型
 *   - 数字键 1-9 / 0 直接选中（不用移动光标）
 *   - PgUp/PgDn 或 ←/→ 切换分组
 *   - D 键把当前项设为 pi 的持久默认模型
 *
 * 另外自动维护 settings.json 的 enabledModels，让内置 /model 默认只显示
 * 本扩展管理的 provider，不再混入内置 provider 的一堆模型。
 *
 * 依赖：只用到 pi 自带的 pi-tui 组件，无第三方依赖。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  Input,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// ─────────────────────────────────────────────────────────────
//  配置
// ─────────────────────────────────────────────────────────────

/** 每组最多显示多少个；超过则分页。 */
const PAGE_SIZE = 10;

/** 单行里模型名的最大显示宽度（超过截断）。 */
const NAME_MAX = 46;

/**
 * 自动写入 settings.json 的 enabledModels。
 * 用通配符，所以 CC Switch 换卡后模型名变了也不会失效。
 * 设为 undefined 则完全不碰 settings.json。
 */
const ENABLED_PATTERNS: string[] | undefined = ["cc-switch/*", "ccs-codex/*"];

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

/** 读 settings.json；坏文件返回 null（不动它）。 */
function readSettings(): Record<string, any> | null {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

/** 原子写 settings.json，写前留一份 .bak。 */
function writeSettings(next: Record<string, any>): boolean {
  const p = settingsPath();
  try {
    const current = readSettings();
    if (current === null) return false; // 坏文件不覆盖
    fs.writeFileSync(p + ".bak", JSON.stringify(current, null, 2) + "\n");
    fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** 需要时才写 enabledModels（避免每次启动都动文件）。 */
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

/** 持久设默认模型（写 defaultProvider + defaultModel）。 */
function saveDefaultModel(provider: string, modelId: string): boolean {
  const s = readSettings();
  if (!s) return false;
  s.defaultProvider = provider;
  s.defaultModel = modelId;
  return writeSettings(s);
}

// ─────────────────────────────────────────────────────────────
//  数据分组
// ─────────────────────────────────────────────────────────────

type Group = {
  provider: string;
  label: string;
  models: Model<Api>[];
};

/** 给 provider 起个短名字。 */
function providerLabel(provider: string, sample: Model<Api> | undefined): string {
  if (provider === "cc-switch") return "Claude 面";
  if (provider === "ccs-codex") return "Codex 面";
  try {
    const host = sample?.baseUrl ? new URL(sample.baseUrl).host : "";
    if (host) return host;
  } catch {}
  return "";
}

/** 按 provider 分组，当前模型的组排最前。 */
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

  // 当前模型所在组提到最前
  if (current) {
    const i = groups.findIndex((g) => g.provider === current.provider);
    if (i > 0) groups.unshift(...groups.splice(i, 1));
  }
  return groups;
}

/** 大小写不敏感的模糊匹配（子序列）。 */
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

/** 上下文长度显示：200000 → 200k, 1000000 → 1M */
function fmtContext(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

// ─────────────────────────────────────────────────────────────
//  窗口组件
// ─────────────────────────────────────────────────────────────

type PickerResult =
  | { kind: "select"; model: Model<Api> }
  | { kind: "default"; model: Model<Api> }
  | { kind: "cancel" };

type PickerOptions = {
  allModels: Model<Api>[];
  current: Model<Api> | undefined;
  /** 进入时 Enter 是否等同于设为默认。 */
  enterSetsDefault: boolean;
  onDone: (result: PickerResult) => void;
  onRefresh: () => Promise<Model<Api>[]>;
  onScopeToggle?: () => void;
};

class ModelPicker implements Component {
  private readonly opts: PickerOptions;
  private filterInput: Input;
  private groups: Group[];
  private groupIndex = 0;
  private pageIndex = 0;
  private cursor = 0; // 组内高亮下标
  private status = "";
  private busy = false;
  private _focused = true;

  constructor(opts: PickerOptions) {
    this.opts = opts;
    this.filterInput = new Input({ placeholder: "filter…" });
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

  /** 按当前过滤器重建分组。 */
  private rebuild(): Group[] {
    const q = this.filterInput.getValue().trim();
    const matched = q
      ? this.opts.allModels.filter((m) => fuzzy(m.id, q) || fuzzy(m.provider, q))
      : this.opts.allModels;
    return buildGroups(matched, this.opts.current);
  }

  /** 组内页数。 */
  private pageCount(i = this.groupIndex): number {
    const g = this.groups[i];
    if (!g) return 1;
    return Math.max(1, Math.ceil(g.models.length / PAGE_SIZE));
  }

  /** 当前页的模型（含全局序号）。 */
  private pageModels(): { model: Model<Api>; num: number; localIndex: number }[] {
    const g = this.groups[this.groupIndex];
    if (!g) return [];
    const start = this.pageIndex * PAGE_SIZE;
    return g.models.slice(start, start + PAGE_SIZE).map((model, i) => ({
      model,
      num: i + 1, // 页内序号 1-10
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
    const g = this.groups[this.groupIndex];
    this.cursor = Math.min(Math.max(0, this.cursor), Math.max(0, g.models.length - 1));
  }

  private selectCursor(): void {
    const g = this.groups[this.groupIndex];
    const m = g?.models[this.cursor];
    if (!m) return;
    this.opts.onDone(
      this.opts.enterSetsDefault ? { kind: "default", model: m } : { kind: "select", model: m },
    );
  }

  private setDefaultCursor(): void {
    const g = this.groups[this.groupIndex];
    const m = g?.models[this.cursor];
    if (!m) return;
    this.opts.onDone({ kind: "default", model: m });
  }

  /** 按页内序号选（1-10；10 用 0 键）。 */
  private selectByNumber(n: number): void {
    const g = this.groups[this.groupIndex];
    if (!g) return;
    const start = this.pageIndex * PAGE_SIZE;
    const target = start + n - 1;
    const m = g.models[target];
    if (!m) {
      this.status = `第 ${n} 项不存在`;
      return;
    }
    // 把光标也同步过去，这样紧接着按 D 不会选错
    this.cursor = target;
    this.opts.onDone(
      this.opts.enterSetsDefault ? { kind: "default", model: m } : { kind: "select", model: m },
    );
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
    const g = this.groups[this.groupIndex];
    this.cursor = Math.min(start, Math.max(0, g.models.length - 1));
    this.status = "";
  }

  private moveCursor(delta: number): void {
    const g = this.groups[this.groupIndex];
    if (!g || g.models.length === 0) return;
    const n = g.models.length;
    this.cursor = (this.cursor + delta + n) % n;
    // 跟随到对应页
    this.pageIndex = Math.floor(this.cursor / PAGE_SIZE);
    this.status = "";
  }

  handleInput(data: string): void {
    // 过滤框非空时，大多数按键都当输入处理（否则没法搜 "glm-5.3"、"[Cloud]"）
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

    // ── 只有过滤框为空时才是「命令键」──
    if (!filtering) {
      if (/^[1-9]$/.test(data)) return this.selectByNumber(Number(data));
      if (data === "0") return this.selectByNumber(10);
      if (data === "<") return this.movePage(-1);
      if (data === ">") return this.movePage(1);
      if (data === "j") return this.moveCursor(1);
      if (data === "k") return this.moveCursor(-1);
      if (matchesKey(data, Key.left)) return this.moveGroup(-1);
      if (matchesKey(data, Key.right)) return this.moveGroup(1);

      // ── 动作 ──
      if (data === "D") return this.setDefaultCursor();
      if (data === "R") {
        if (this.busy) return;
        this.busy = true;
        this.status = "刷新中…";
        void this.opts
          .onRefresh()
          .then((models) => {
            this.opts.allModels = models;
            this.groups = this.rebuild();
            this.clamp();
            this.status = `已刷新（${models.length} 个模型）`;
          })
          .catch((e) => {
            this.status = `刷新失败：${e instanceof Error ? e.message : String(e)}`;
          })
          .finally(() => {
            this.busy = false;
          });
        return;
      }
      if (data === "S") {
        this.opts.onScopeToggle?.();
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

  private hr(width: number, ch = "─"): string {
    return ch.repeat(Math.max(0, width));
  }

  /** 把一个字符串按显示宽度补/截到 width。 */
  private fit(s: string, width: number, padChar = " "): string {
    const vis = visibleWidth(s);
    if (vis > width) return truncateToWidth(s, width);
    return s + padChar.repeat(width - vis);
  }

  render(width: number): string[] {
    const out: string[] = [];
    const inner = Math.max(20, width - 2);
    const pad = " ";

    const line = (content: string) => out.push(pad + this.fit(content, inner) + pad);
    const rule = () => out.push(pad + this.hr(inner) + pad);

    // ── 顶栏 ──
    const g = this.groups[this.groupIndex];
    const pc = this.pageCount();
    const pageInfo = pc > 1 ? `  页 ${this.pageIndex + 1}/${pc}` : "";
    const groupInfo = this.groups.length ? `  组 ${this.groupIndex + 1}/${this.groups.length}` : "";
    line(`Model Picker${groupInfo}${pageInfo}`);

    // ── 搜索框（Input.render 自带 "> " 提示符和光标）──
    rule();
    const inputLine = this.filterInput.render(inner)[0] ?? "";
    out.push(pad + this.fit(" ", 0) + inputLine + pad);
    rule();

    if (!g) {
      line("没有匹配的模型");
      rule();
      line("Esc 关闭");
      return out;
    }

    // ── 组标题 ──
    const label = g.label ? ` · ${g.label}` : "";
    const count = `(${g.models.length})`;
    line(`▸ ${g.provider}${label} ${count}`);

    // ── 模型列表 ──
    const page = this.pageModels();
    for (const { model, num, localIndex } of page) {
      const isCursor = localIndex === this.cursor;
      const isCurrent =
        this.opts.current &&
        this.opts.current.provider === model.provider &&
        this.opts.current.id === model.id;

      const keyLabel = num === 10 ? "0" : String(num);
      const marker = isCurrent ? "●" : isCursor ? "▸" : " ";
      const ctx = fmtContext(model.contextWindow);
      const tags: string[] = [];
      if (model.reasoning) tags.push("think");
      if (model.input?.includes("image")) tags.push("img");

      const left = `${marker} ${keyLabel.padStart(2)}  ${model.id}`;
      const right = [ctx, tags.join(",")].filter(Boolean).join(" ");

      const avail = inner - right.length - 3;
      const leftFit = avail > 4 ? truncateToWidth(left, avail) : left;
      line(leftFit + " ".repeat(Math.max(1, avail - visibleWidth(leftFit))) + right);
    }

    if (pc > 1) {
      line(`  <  > 翻页（本组共 ${g.models.length} 个）`);
    }

    // ── 状态 ──
    if (this.status) {
      rule();
      line(this.status);
    }

    // ── 帮助 ──
    rule();
    line("过滤框空: 1-9 0 选模型 · PgUp/PgDn ← → 换组 · ↑↓ jk 移动");
    line(
      this.opts.enterSetsDefault
        ? "D 设默认 · < > 翻页 · R 刷新 · 打字=过滤 · Enter 确认 · Esc 关"
        : "D 设默认 · < > 翻页 · R 刷新 · 打字=过滤 · Esc 关",
    );

    return out;
  }
}

// ─────────────────────────────────────────────────────────────
//  扩展入口
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  /** 打开窗口。enterSetsDefault: 直接按 Enter 就是设默认。 */
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
      ctx.ui.notify("没有可用的模型（检查 provider 是否配置了凭据）", "warning");
      return;
    }

    const result = await ctx.ui.custom<PickerResult>(
      (tui, theme, _kb, done) => {
        const picker = new ModelPicker({
          allModels,
          current: ctx.model as Model<Api> | undefined,
          enterSetsDefault,
          onDone: (r) => done(r),
          onRefresh: async () => {
            await ctx.modelRegistry.refresh();
            return ctx.modelRegistry.getAvailable();
          },
          onScopeToggle: () => {
            ctx.ui.notify("scope 由 settings.json 的 enabledModels 控制（可用 /scoped-models 调整）", "info");
          },
        });

        const header = new Container();
        header.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        header.addChild(new Text(theme.fg("accent", theme.bold("  Model Picker")), 0, 0));

        const footer = new Container();
        footer.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          focused: true,
          render(w: number): string[] {
            return [
              ...header.render(w),
              ...picker.render(w),
              ...footer.render(w),
            ];
          },
          invalidate() {
            header.invalidate();
            picker.invalidate();
            footer.invalidate();
          },
          handleInput(data: string) {
            picker.handleInput(data);
            tui.requestRender();
          },
        } as Component & { focused: boolean };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "80%",
          maxHeight: "85%",
          anchor: "center",
        },
      },
    );

    if (!result || result.kind === "cancel") return;

    const model = result.model;

    if (result.kind === "default") {
      const ok = saveDefaultModel(model.provider, model.id);
      const set = await pi.setModel(model);
      if (!set) {
        ctx.ui.notify(`没有 ${model.provider}/${model.id} 的凭据`, "error");
        return;
      }
      ctx.ui.notify(
        ok
          ? `默认模型：${model.provider}/${model.id}`
          : `已切换，但写 settings.json 失败`,
        ok ? "info" : "warning",
      );
      return;
    }

    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(`没有 ${model.provider}/${model.id} 的凭据`, "error");
      return;
    }
    ctx.ui.notify(`模型：${model.provider}/${model.id}`, "info");
  }

  pi.registerCommand("mp", {
    description: "分组模型选择窗口（数字键选择，PgUp/PgDn 换组）",
    handler: async (args, ctx) => {
      const wantDefault = (args ?? "").trim().toLowerCase() === "default";
      await open(ctx, wantDefault);
    },
  });

  pi.registerShortcut("ctrl+shift+m", {
    description: "Model Picker（分组模型选择窗口）",
    handler: async (ctx) => {
      await open(ctx, false);
    },
  });

  // 启动时维护 enabledModels，让内置 /model 默认只显示本扩展管的 provider
  pi.on("session_start", async () => {
    try {
      syncEnabledModels();
    } catch {}
  });
}
