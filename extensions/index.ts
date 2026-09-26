/**
 * CC Switch → pi 同步（启动时一次）
 *
 * 把 CC Switch 里**当前选中**的中转站卡同步成 pi 的 provider：
 *
 *   Claude 面 → provider `cc-switch`     （走本地代理 127.0.0.1:15721）
 *   Codex  面 → provider `ccs-codex`     （直连中转站）
 *
 * 每个面只显示「当前那张卡」的模型，不把所有人的模型堆出来。
 * 启动时读一次，之后不轮询 —— 会话中途模型列表不会被换掉。
 * 想重读：/ccsync
 *
 * ── 两个面的差异 ──────────────────────────────────────────
 * Claude 面的模型是 CC Switch 卡里的**固定槽位**
 *   （ANTHROPIC_DEFAULT_SONNET_MODEL / _OPUS_ / _FABLE_），
 *   代理的 /v1/models 返回空，所以只能从卡里读。
 *
 * Codex 面用 key 直连中转站的 /models，能拿到该 key 开放的完整列表。
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DB = path.join(os.homedir(), ".cc-switch", "cc-switch.db");

// ─────────────────────────────────────────────────────────────
//  配置
// ─────────────────────────────────────────────────────────────

/**
 * 每个面跟随哪些中转站。
 *
 *   "current"  → 只跟随该面**当前选中**的卡。默认，最干净。
 *
 *   [ "your-relay.example.com", "api.deepseek.com" ]
 *              → 每个站各出一个 provider，可同时在 /model 里选。
 *                将来加中转站，往数组里加域名即可，不用改代码。
 */
const FOLLOW: "current" | string[] = "current";

/** Claude 面的 provider id（固定，不随 key 变，默认模型不会丢）。 */
const CLAUDE_PROVIDER_ID = "cc-switch";

/** Codex 面的 provider id。 */
const CODEX_PROVIDER_ID = "ccs-codex";

/** Claude 面经过的 CC Switch 本地代理（协议转换在它那儿做）。 */
const CLAUDE_PROXY_URL = "http://127.0.0.1:15721";

/** 代理不校验 key，真 key 由 CC Switch 注入。 */
const CLAUDE_PROXY_KEY = "cc-switch-local";

/** 上游 /models 请求超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 模型元数据（中转站不可信，统一给宽值）。 */
/**
 * 全局上下文上限（路线 1：按需求统一设 600K）。
 * 注意：这是 pi 账本上的数字，上游真实上限未必有这么高。
 *   cc-switch（Claude 面）真实 200K
 *   ccs-codex（Codex 面）真实 400K
 */
const CONTEXT_WINDOW = 600_000;

const CODEX_CONTEXT = CONTEXT_WINDOW;
const CODEX_MAX_TOKENS = 128_000;
const CLAUDE_CONTEXT = CONTEXT_WINDOW;
const CLAUDE_MAX_TOKENS = 64_000;

// ─────────────────────────────────────────────────────────────
//  读 CC Switch
// ─────────────────────────────────────────────────────────────

/** Claude 面卡里的模型槽位（按优先级）。 */
const CLAUDE_SLOTS = [
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_MODEL",
];

type Row = { id: string; name: string; settings_config: string; is_current: number };

/** 从 config.toml 片段里取 `key = "value"`。 */
function toml(text: string, key: string): string {
  return (text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m")) || [])[1] || "";
}

/** baseUrl → 显示用的站名。 */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

/** baseUrl → provider id 用的短名。 */
function slug(url: string): string {
  return host(url)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** 打开 CC Switch 库（只读）。 */
async function openDb(): Promise<any | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(DB, { readOnly: true });
  } catch {
    return null;
  }
}

/** 读某个面所有的卡（未解析）。 */
async function readRows(appType: string): Promise<Row[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        "SELECT id, name, settings_config, is_current FROM providers " +
          "WHERE app_type=? ORDER BY COALESCE(created_at, 0), rowid",
      )
      .all(appType);
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/** 从一行里判断它的 baseUrl（两个面的字段位置不同）。 */
function rowBaseUrl(appType: string, sc: any): string {
  if (appType === "claude") return sc?.env?.ANTHROPIC_BASE_URL || "";
  return toml(sc?.config || "", "base_url");
}

/** 挑出要用的卡：优先 is_current=1，其次最后一张。 */
function pickByFollow(
  rows: Row[],
  appType: string,
  follow: "current" | string[],
): { row: Row; sc: any }[] {
  const parsed = rows
    .map((r) => {
      let sc: any = {};
      try {
        sc = JSON.parse(r.settings_config || "{}");
      } catch {
        return null;
      }
      return { row: r, sc, baseUrl: rowBaseUrl(appType, sc) };
    })
    .filter((x): x is { row: Row; sc: any; baseUrl: string } => !!x && !!x.baseUrl);

  if (follow === "current") {
    const cur = parsed.find((p) => p.row.is_current === 1) ?? parsed[parsed.length - 1];
    return cur ? [{ row: cur.row, sc: cur.sc }] : [];
  }

  const out: { row: Row; sc: any }[] = [];
  for (const wanted of follow) {
    const matches = parsed.filter((p) => p.baseUrl.includes(wanted));
    if (!matches.length) continue;
    // 站内优先当前选中的
    const chosen = matches.find((m) => m.row.is_current === 1) ?? matches[matches.length - 1];
    out.push({ row: chosen.row, sc: chosen.sc });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//  Claude 面
// ─────────────────────────────────────────────────────────────

/** 从 Claude 卡里取模型槽位（去重，去掉空值）。 */
function claudeModels(sc: any): string[] {
  const env = sc?.env || {};
  const out: string[] = [];
  for (const slot of CLAUDE_SLOTS) {
    const v = env[slot];
    if (typeof v === "string" && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

/** 拉 Claude 面卡对应的模型列表。 */
async function resolveClaude(): Promise<{ id: string; baseUrl: string; models: string[] }[]> {
  if (FOLLOW === "current") {
    const picked = pickByFollow(await readRows("claude"), "claude", "current");
    if (!picked.length) return [];
    const models = claudeModels(picked[0].sc);
    return models.length ? [{ id: CLAUDE_PROVIDER_ID, baseUrl: "", models }] : [];
  }

  const picked = pickByFollow(await readRows("claude"), "claude", FOLLOW);
  const out: { id: string; baseUrl: string; models: string[] }[] = [];
  const seen = new Set<string>();
  for (const p of picked) {
    const models = claudeModels(p.sc);
    if (!models.length) continue;
    const baseUrl = p.sc?.env?.ANTHROPIC_BASE_URL || "";
    const id = `ccs-claude-${slug(baseUrl)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, baseUrl, models });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//  Codex 面
// ─────────────────────────────────────────────────────────────

/** 拉某张 codex 卡开放的模型；失败返回空数组。 */
async function fetchCodexModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const list = json?.data ?? json?.models ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((m: any) => m?.id).filter((x: any): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** 拉 Codex 面卡对应的模型列表。 */
async function resolveCodex(): Promise<
  { id: string; name: string; baseUrl: string; apiKey: string; models: string[] }[]
> {
  const picked = pickByFollow(await readRows("codex"), "codex", FOLLOW);
  const out: { id: string; name: string; baseUrl: string; apiKey: string; models: string[] }[] = [];
  const seen = new Set<string>();

  for (const p of picked) {
    const baseUrl = rowBaseUrl("codex", p.sc);
    const apiKey = p.sc?.auth?.OPENAI_API_KEY || "";
    if (!baseUrl || !apiKey) continue;

    const live = await fetchCodexModels(baseUrl, apiKey);
    const pinned = toml(p.sc?.config || "", "model");
    const models = live.length ? live : pinned ? [pinned] : [];
    if (!models.length) continue;

    // current 模式用固定 id；多站模式按域名区分
    const id = FOLLOW === "current" ? CODEX_PROVIDER_ID : `ccs-codex-${slug(baseUrl)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: p.row.name || id, baseUrl, apiKey, models });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//  注册
// ─────────────────────────────────────────────────────────────

function modelMeta(id: string, contextWindow: number, maxTokens: number) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

export default async function (pi: ExtensionAPI) {
  /** 上一次注册过的 provider id，用来清掉已废弃的。 */
  let registered: string[] = [];

  async function sync(): Promise<string> {
    const keep: string[] = [];
    const parts: string[] = [];

    // ── Claude 面 ──
    try {
      for (const c of await resolveClaude()) {
        pi.registerProvider(c.id, {
          name: FOLLOW === "current" ? "CC Switch · Claude 面" : `CC Switch · ${host(c.baseUrl)}`,
          baseUrl: CLAUDE_PROXY_URL,
          apiKey: CLAUDE_PROXY_KEY,
          api: "anthropic-messages",
          // 模型名原样透传给代理，由 CC Switch 路由到当前卡的上游
          models: c.models.map((m) => modelMeta(m, CLAUDE_CONTEXT, CLAUDE_MAX_TOKENS)),
        });
        keep.push(c.id);
        parts.push(`claude=${c.models.length}`);
      }
    } catch {}

    // ── Codex 面 ──
    try {
      for (const c of await resolveCodex()) {
        pi.registerProvider(c.id, {
          name: `CC Switch · codex …${c.apiKey.slice(-4)}`,
          baseUrl: c.baseUrl,
          apiKey: c.apiKey,
          api: "openai-responses",
          models: c.models.map((m) => modelMeta(m, CODEX_CONTEXT, CODEX_MAX_TOKENS)),
        });
        keep.push(c.id);
        parts.push(`codex=${c.models.length}`);
      }
    } catch {}

    // 清掉这次不再需要的
    for (const old of registered) {
      if (!keep.includes(old)) pi.unregisterProvider(old);
    }
    registered = keep;

    return parts.length ? parts.join("  ") : "CC Switch 里没有可用的卡";
  }

  // ── 只在启动时同步一次 ──────────────────────────────────
  try {
    await sync();
  } catch {
    /* 读不到就退回 models.json 里的静态配置 */
  }

  // ── 手动重读 ────────────────────────────────────────────
  pi.registerCommand("ccsync", {
    description: "重新读取 CC Switch 的卡并刷新模型列表",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(`已同步 ${await sync()}`, "info");
      } catch (err) {
        ctx.ui.notify(`同步失败：${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });
}
