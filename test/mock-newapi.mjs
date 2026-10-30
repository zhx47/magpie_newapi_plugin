// 测试用的「盒装 New API 站点」：本插件用到的那些接口，
// 以及 New API 真实发出的信封（拒绝时是 HTTP 200 + success:false、
// 列表里的 key 是掩码、要求质询时返回质询页）。

import http from "node:http";
import { createHash } from "node:crypto";

import { digestMatches } from "../src/runanytime.mjs";

let mockSeq = 0;

// 每个测试进程一个监听器，每个站点是它下面的一个路径前缀。
// 每个测试都起一个新服务器会不停消耗临时端口（Windows 上还会堆 TIME_WAIT），
// 表现为明明在监听的站点偶尔报 "fetch failed"。
const sites = new Map();
let listening = null;
let listenerRef = null;

function listener() {
  if (listening) return listening;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const m = url.pathname.match(/^\/s\d+-[a-z0-9]+/);
    const site = m ? sites.get(m[0]) : undefined;
    if (!site) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "no such mock site" }));
      return;
    }
    site.handle(req, res);
  });
  // 让事件循环在测试结束后能正常退出。
  server.unref();
  listenerRef = server;
  listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`127.0.0.1:${port}`);
    });
  });
  return listening;
}

/** 关掉共享的监听器（测试不需要；常驻进程可能需要）。 */
export function shutdownMock() {
  sites.clear();
  if (listenerRef) {
    listenerRef.closeAllConnections?.();
    listenerRef.close();
    listenerRef = null;
    listening = null;
  }
}

export const ACCESS_TOKEN = "test-access-token-1234567890";
export const DEFAULT_KEY = "sk-default-key-0001";
export const VIP_KEY = "sk-vip-key-0002";
export const SVIP_KEY = "sk-svip-key-0003";
export const MASKED_VIP = "sk-v***0002";

const PRICING = [
  {
    model_name: "gpt-4o",
    enable_groups: ["default", "vip"],
    supported_endpoint_types: ["openai"],
    model_ratio: 1,
    completion_ratio: 4,
  },
  {
    model_name: "gpt-5",
    enable_groups: ["vip"],
    supported_endpoint_types: ["openai", "openai_response"],
    model_ratio: 2,
    completion_ratio: 4,
  },
  {
    model_name: "claude-sonnet-4.5",
    enable_groups: ["vip"],
    supported_endpoint_types: ["anthropic", "openai"],
    model_ratio: 3,
    completion_ratio: 5,
  },
  {
    model_name: "gemini-2.5-pro",
    enable_groups: ["vip"],
    supported_endpoint_types: ["gemini", "openai"],
    model_ratio: 1.1,
    completion_ratio: 4,
  },
  {
    model_name: "text-embedding-3-small",
    enable_groups: ["default"],
    supported_endpoint_types: ["embeddings"],
  },
  {
    model_name: "deepseek-chat",
    enable_groups: ["default"],
    supported_endpoint_types: ["openai"],
  },
];

const GROUP_MODELS = {
  default: ["gpt-4o", "deepseek-chat"],
  vip: ["gpt-4o", "gpt-5", "claude-sonnet-4.5", "gemini-2.5-pro"],
  svip: ["gpt-5"],
};

const GROUPS = {
  default: { ratio: 1, desc: "" },
  vip: { ratio: 0.8, desc: "VIP" },
  svip: { ratio: 0.6, desc: "SVIP" },
};

/**
 * 起一个假的 New API。可选项：
 *   reveal: "allow" | "deny" | "masked"  （token key 的 reveal 行为）
 *   challenge: "" | "cf" | "turnstile"   （签到接口的行为）
 *   pricingClosed: bool                  （/api/pricing 回 403）
 *   checkinEnabled: bool
 *   turnstileCheck: bool                 （/api/status 说需要 Turnstile）
 *   statusTurnstile: bool                （只有 /api/status 说需要，签到接口本身能过：
 *                                         runanytime 就是这种——它挂着 Turnstile，
 *                                         但带访问令牌的 PoW 签到是通的）
 *   quotaPerUnit, quota, usedQuota（额度单位、余额、已用额度）
 *   leanList: bool                       （列表只回 id/name/key/status，分组与额度在详情里）
 *   multiGroup: bool                     （一个 token 的 groups 是数组，可勾多个分组）
 */
export async function startNewAPI(options = {}) {
  const state = {
    reveal: options.reveal ?? "allow",
    // 列表接口是否精简、token 是否能勾多个分组：hyxware 那类站点。
    leanList: options.leanList ?? false,
    multiGroup: options.multiGroup ?? false,
    detailsRead: 0,
    challenge: options.challenge ?? "",
    pricingClosed: options.pricingClosed ?? false,
    checkinEnabled: options.checkinEnabled ?? true,
    turnstileCheck: options.turnstileCheck ?? false,
    // 只有 /api/status 说需要 Turnstile，签到接口本身能过（runanytime 那种）。
    statusTurnstile: options.statusTurnstile ?? false,
    quotaPerUnit: options.quotaPerUnit ?? 500000,
    displayInCurrency: options.displayInCurrency ?? true,
    quotaDisplayType: options.quotaDisplayType ?? "USD",
    quota: options.quota ?? 5_000_000,
    usedQuota: options.usedQuota ?? 1_000_000,
    checkedInToday: options.checkedInToday ?? false,
    // 站点的分组及其模型，可变：管理员会增删，测试也一样。
    groups: { ...GROUPS },
    models: { ...GROUP_MODELS },
    // 有些版本（v1.0.0-rc.46）的 GET/POST 都只有 /api/user/checkin，
    // self 那条路由在它们那里是 404。
    legacyCheckinOnly: options.legacyCheckinOnly ?? false,
    // runanytime 那类站点：签到前必须先解一道 PoW
    pow: options.pow ?? null,
    // 前 N 次提交回「题不对」，用来测重取一道题再试
    powRejectFirst: options.powRejectFirst ?? 0,
    powRejected: 0,
    // 列表接口是否直接给明文 key（默认掩码）
    maskKeys: options.maskKeys ?? false,
    // reveal 接口只认哪个方法："" 两个都认，也可以是 "none"
    revealMethod: options.revealMethod ?? "",
    usdExchangeRate: options.usdExchangeRate ?? 7.3,
    checkedIn: [],
    powChallenges: [],
    created: [],
    requests: [],
    tokens: [
      { id: 1, name: "default", key: DEFAULT_KEY, group: "default", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
      { id: 2, name: "vip", key: VIP_KEY, group: "vip", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
      // svip 完全没有 token，所以它的 key 只能手填或新建。
    ],
  };

  // 每个站点还各有一个路径前缀：插件按 base URL 缓存，
  // 后面的测试复用了临时端口时，不能读到前一个站点的缓存。
  const prefix = `/s${++mockSeq}-${Date.now().toString(36)}`;

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith(prefix)) url.pathname = url.pathname.slice(prefix.length) || "/";
    const auth = req.headers.authorization ?? "";
    const bearer = auth.replace(/^Bearer\s+/i, "");
    const apiKey = bearer || req.headers["x-api-key"] || req.headers["x-goog-api-key"] || url.searchParams.get("key") || "";
    const body = await readBody(req);
    const entry = { method: req.method, path: url.pathname, search: url.search, body, headers: req.headers, status: 0 };
    state.requests.push(entry);
    res.on("finish", () => {
      entry.status = res.statusCode;
    });

    if (state.challenge === "cf" && req.headers["x-test-cf"] !== "off") {
      // Cloudflare 质询先拦在签到路由上。
      if (url.pathname.includes("/checkin")) {
        res.writeHead(403, { "content-type": "text/html", server: "cloudflare" });
        res.end("<!doctype html><title>Just a moment...</title><div id='cf-challenge'></div>");
        return;
      }
    }

    const json = (payload, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    // ---- public ----
    if (url.pathname === "/api/status") {
      json({
        success: true,
        data: {
          version: "0.9.0-test",
          system_name: "Test New API",
          quota_per_unit: state.quotaPerUnit,
          display_in_currency: state.displayInCurrency,
          quota_display_type: state.quotaDisplayType,
          custom_currency_symbol: "$",
          custom_currency_exchange_rate: 1,
          usd_exchange_rate: state.usdExchangeRate,
          price: state.usdExchangeRate,
          checkin_enabled: state.checkinEnabled,
          turnstile_check: state.turnstileCheck || state.statusTurnstile,
        },
      });
      return;
    }

    if (url.pathname === "/api/pricing") {
      if (state.pricingClosed) {
        json({ success: false, message: "unauthorized" }, 403);
        return;
      }
      json({
        success: true,
        data: PRICING,
        group_ratio: { default: 1, vip: 0.8, svip: 0.6 },
        usable_group: state.groups,
        auto_groups: ["vip"],
        pricing_version: "test",
      });
      return;
    }

    // ---- user ----
    if (url.pathname === "/api/user/self") {
      if (bearer !== ACCESS_TOKEN) {
        json({ success: false, message: "无权进行此操作，未登录且未提供 access token" }, 401);
        return;
      }
      json({
        success: true,
        data: {
          id: 1,
          username: "alice",
          display_name: "Alice",
          group: "default",
          quota: state.quota,
          used_quota: state.usedQuota,
          request_count: 1234,
        },
      });
      return;
    }

    if (url.pathname === "/api/user/self/groups" || url.pathname === "/api/user/groups") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      json({ success: true, data: state.groups });
      return;
    }

    if (url.pathname === "/api/user/models") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      const group = url.searchParams.get("group") || "";
      const models = group ? state.models[group] ?? [] : [...new Set(Object.values(state.models).flat())];
      json({ success: true, data: models });
      return;
    }

    // ---- tokens ----
    if (url.pathname === "/api/token/" && req.method === "GET") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      // maskKeys：列表里也是明文（老版本、或站点没开掩码）
      // leanList：只回 id/name/key/status/时间，分组和额度只在详情里。
      const items = state.tokens.map((t) => {
        const key = state.maskKeys ? t.key : maskKey(t.key);
        if (!state.leanList) return { ...t, key };
        return { id: t.id, name: t.name, key, status: t.status, created_time: 1, accessed_time: 0 };
      });
      json({ success: true, data: { page: 1, page_size: 100, total: items.length, items } });
      return;
    }

    const detail = url.pathname.match(/^\/api\/token\/(\d+)$/);
    if (detail && req.method === "GET") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      const t = state.tokens.find((x) => x.id === Number(detail[1]));
      if (!t) return json({ success: false, message: "token not found" }, 404);
      state.detailsRead += 1;
      // multiGroup 的站点用 groups 数组，可以勾多个分组。
      const groups = Array.isArray(t.groups) && t.groups.length ? t.groups : [t.group ?? "default"];
      json({
        success: true,
        data: { ...t, key: maskKey(t.key), groups, group: groups[0], auto_groups: null },
      });
      return;
    }

    const batch = url.pathname.match(/^\/api\/token\/batch\/keys$/);
    if (batch && req.method === "POST") {
      // 有的版本没有批量接口；只认 GET 的那些版本通常也没有（batch 是纯 POST）
      if (state.revealMethod === "none" || state.revealMethod === "GET") {
        return json({ success: false, message: "not found" }, 404);
      }
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      if (state.reveal === "deny") return json({ success: false, message: "无权进行此操作，没有权限" }, 403);
      const ids = JSON.parse(body || "{}").ids ?? [];
      const keys = {};
      for (const id of ids) {
        const t = state.tokens.find((x) => x.id === id);
        if (!t) continue;
        keys[id] = state.reveal === "masked" ? maskKey(t.key) : t.key;
      }
      json({ success: true, data: { keys } });
      return;
    }

    const one = url.pathname.match(/^\/api\/token\/(\d+)\/key$/);
    if (one) {
      if (state.revealMethod === "none") return json({ success: false, message: "not found" }, 404);
      // 有的版本只认 GET，有的只认 POST：另一个回 405，由插件换一个再试。
      if (state.revealMethod && state.revealMethod !== req.method) {
        return json({ success: false, message: "method not allowed" }, 405);
      }
      if (!["GET", "POST"].includes(req.method)) return json({ success: false, message: "method not allowed" }, 405);
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      if (state.reveal === "deny") return json({ success: false, message: "无权进行此操作，没有权限" }, 403);
      const t = state.tokens.find((x) => x.id === Number(one[1]));
      if (!t) return json({ success: false, message: "token not found" }, 404);
      json({ success: true, data: { key: state.reveal === "masked" ? maskKey(t.key) : t.key } });
      return;
    }

    if (url.pathname === "/api/token/" && req.method === "POST") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      const payload = JSON.parse(body || "{}");
      const id = 100 + state.tokens.length;
      const created = {
        id,
        name: payload.name,
        key: `sk-created-${id}-${payload.group}`,
        group: payload.group,
        status: 1,
        expired_time: payload.expired_time ?? -1,
        remain_quota: 0,
        unlimited_quota: true,
      };
      state.tokens.push(created);
      state.created.push(created);
      // New API 的 AddToken 既不返回 id 也不返回 key。
      json({ success: true, message: "" });
      return;
    }

    // ---- relay ----
    if (url.pathname === "/v1/models" || url.pathname === "/v1beta/models") {
      const t = state.tokens.find((x) => x.key === apiKey);
      if (!t) return json({ error: { message: "invalid token", type: "invalid_request_error" } }, 401);
      const models = state.models[t.group] ?? [];
      if (url.pathname === "/v1beta/models") {
        json({ models: models.map((m) => ({ name: `models/${m}` })) });
      } else {
        json({ object: "list", data: models.map((id) => ({ id, object: "model" })) });
      }
      return;
    }

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses" || url.pathname === "/v1/messages") {
      const t = state.tokens.find((x) => x.key === apiKey);
      if (!t) return json({ error: { message: "invalid token", type: "invalid_request_error" } }, 401);
      const payload = JSON.parse(body || "{}");
      json({
        seen: { path: url.pathname, model: payload.model, auth: apiKey, group: t.group, token: t.name },
      });
      return;
    }

    const gem = url.pathname.match(/^\/v1beta\/models\/([^/:]+):(streamGenerateContent|generateContent)$/);
    if (gem) {
      const t = state.tokens.find((x) => x.key === apiKey);
      if (!t) return json({ error: { message: "invalid token" } }, 401);
      json({ seen: { path: url.pathname, model: decodeURIComponent(gem[1]), group: t.group, token: t.name } });
      return;
    }

    // ---- proof of work (runanytime and its like) ----
    if (url.pathname === "/api/user/pow/challenge" && req.method === "GET") {
      if (!state.pow) return json({ success: false, message: "not found" }, 404);
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      if ((url.searchParams.get("action") ?? "") !== "checkin") {
        return json({ success: false, message: "invalid action" }, 400);
      }
      const challenge = {
        challenge_id: `challenge-${state.powChallenges.length + 1}`,
        prefix: state.pow.prefix,
        difficulty: state.pow.difficulty,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      state.powChallenges.push(challenge);
      json({ success: true, data: challenge });
      return;
    }

    // ---- check-in ----
    if (url.pathname === "/api/user/checkin" && req.method === "GET" && state.legacyCheckinOnly) {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      json({
        success: true,
        data: {
          enabled: state.checkinEnabled,
          min_quota: 1000,
          max_quota: 10000,
          stats: {
            checked_in_today: state.checkedInToday,
            records: state.checkedInToday ? [{ checkin_date: today(), quota_awarded: 5000 }] : [],
            total_checkins: state.checkedInToday ? 1 : 0,
            total_quota: state.checkedInToday ? 5000 : 0,
            checkin_count: state.checkedInToday ? 1 : 0,
          },
        },
      });
      return;
    }

    if (url.pathname === "/api/user/self/checkin" && req.method === "GET") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      if (state.legacyCheckinOnly) return json({ error: { message: "Invalid URL (GET /api/user/self/checkin)" } }, 404);
      json({
        success: true,
        data: {
          enabled: state.checkinEnabled,
          min_quota: 1000,
          max_quota: 10000,
          stats: {
            checked_in_today: state.checkedInToday,
            records: state.checkedInToday ? [{ checkin_date: today(), quota_awarded: 5000 }] : [],
            total_checkins: 0,
            total_quota: 0,
          },
        },
      });
      return;
    }

    if (url.pathname === "/api/user/self/checkin" && req.method === "POST") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      if (state.legacyCheckinOnly) return json({ error: { message: "Invalid URL (POST /api/user/self/checkin)" } }, 404);
      if (state.pow) {
        if (state.powRejected < state.powRejectFirst) {
          state.powRejected++;
          return json({ success: false, message: "pow challenge expired" }, 400);
        }
        const pow = checkPow(state, url);
        if (pow !== true) return json({ success: false, message: pow }, 400);
      }
      if (state.challenge === "turnstile" || state.turnstileCheck) {
        json({ success: false, message: "Turnstile token is empty" });
        return;
      }
      if (!state.checkinEnabled) {
        json({ success: false, message: "Check-in feature is not enabled" });
        return;
      }
      if (state.checkedInToday) {
        json({ success: false, message: "Already checked in today" });
        return;
      }
      state.checkedInToday = true;
      state.quota += 5000;
      state.checkedIn.push(today());
      json({ success: true, message: "Check-in successful", data: { quota_awarded: 5000, checkin_date: today() } });
      return;
    }

    if (url.pathname === "/api/user/checkin" && req.method === "POST") {
      // 老路径：只有老布局的站点用来真正签到；其他站点回 404，
      // 除非测试要求旧版的那个 reward 形状或这是 PoW 站点。
      if (!options.legacyCheckin && !state.legacyCheckinOnly && !state.pow) {
        json({ success: false, message: "not found" }, 404);
        return;
      }
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      if (state.pow) {
        const pow = checkPow(state, url);
        if (pow !== true) return json({ success: false, message: pow }, 400);
      }
      if (state.turnstileCheck || state.challenge === "turnstile") {
        json({ success: false, message: "Turnstile token is empty" });
        return;
      }
      if (state.checkedInToday) {
        json({ success: false, message: "Already checked in today" });
        return;
      }
      state.checkedInToday = true;
      state.quota += 3000;
      json({ success: true, message: "checkin success", data: { reward: 3000 } });
      return;
    }

    json({ success: false, message: `no such route: ${url.pathname}` }, 404);
  };

  sites.set(prefix, { handle });
  const host = await listener();
  const base = `http://${host}${prefix}`;
  return {
    base,
    state,
    close: async () => {
      sites.delete(prefix);
    },
    set(update) {
      Object.assign(state, update);
    },
  };
}

/**
 * PoW 站点的签到门槛：必须带 pow_challenge / pow_nonce，且 nonce 真的满足难度。
 * 返回 true 表示通过，否则是要回给站点的错误消息。
 */
function checkPow(state, url) {
  const challengeId = url.searchParams.get("pow_challenge") ?? "";
  const nonce = url.searchParams.get("pow_nonce") ?? "";
  if (!challengeId || !nonce) return "pow challenge required";
  const challenge = state.powChallenges.find((c) => c.challenge_id === challengeId);
  if (!challenge) return "unknown pow challenge";
  const digest = createHash("sha256").update(challenge.prefix + nonce).digest();
  if (!digestMatches(digest, challenge.difficulty)) return "invalid pow";
  return true;
}

function maskKey(key) {
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}**********${key.slice(-4)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(data));
  });
}
