// A New API site in a box, for tests: the endpoints this plugin uses,
// with the envelopes New API really sends (HTTP 200 + success:false for a
// refusal, masked keys in the list, a challenge page when asked).

import http from "node:http";

let mockSeq = 0;

// One listener per test process, every site a path prefix under it. A fresh
// server per test churned ephemeral ports (and Windows' TIME_WAIT with them),
// which showed up as occasional "fetch failed" on a site that was listening.
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
  // Keep the event loop free to exit once the tests are over.
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

/** Stop the shared listener (tests do not need this; a long-lived process may). */
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
 * Start a fake New API. Options:
 *   reveal: "allow" | "deny" | "masked"  (token key reveal behaviour)
 *   challenge: "" | "cf" | "turnstile"   (check-in endpoint behaviour)
 *   pricingClosed: bool                  (/api/pricing answers 403)
 *   checkinEnabled: bool
 *   turnstileCheck: bool                 (/api/status says Turnstile)
 *   quotaPerUnit, quota, usedQuota
 */
export async function startNewAPI(options = {}) {
  const state = {
    reveal: options.reveal ?? "allow",
    challenge: options.challenge ?? "",
    pricingClosed: options.pricingClosed ?? false,
    checkinEnabled: options.checkinEnabled ?? true,
    turnstileCheck: options.turnstileCheck ?? false,
    quotaPerUnit: options.quotaPerUnit ?? 500000,
    displayInCurrency: options.displayInCurrency ?? true,
    quotaDisplayType: options.quotaDisplayType ?? "USD",
    quota: options.quota ?? 5_000_000,
    usedQuota: options.usedQuota ?? 1_000_000,
    checkedInToday: options.checkedInToday ?? false,
    // Some builds (v1.0.0-rc.46) only have /api/user/checkin for both GET
    // and POST; the self route is a 404 there.
    legacyCheckinOnly: options.legacyCheckinOnly ?? false,
    usdExchangeRate: options.usdExchangeRate ?? 7.3,
    checkedIn: [],
    created: [],
    requests: [],
    tokens: [
      { id: 1, name: "default", key: DEFAULT_KEY, group: "default", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
      { id: 2, name: "vip", key: VIP_KEY, group: "vip", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
      // svip has no token at all, so a key must be pasted or created.
    ],
  };

  // Each site also gets a path prefix of its own: the plugin caches by base
  // URL, and a later test reusing an ephemeral port must not read an earlier
  // site's cached status.
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
      // A Cloudflare challenge reaches the check-in route first.
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
          turnstile_check: state.turnstileCheck,
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
        usable_group: GROUPS,
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
      json({ success: true, data: GROUPS });
      return;
    }

    if (url.pathname === "/api/user/models") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      const group = url.searchParams.get("group") || "";
      const models = group ? GROUP_MODELS[group] ?? [] : [...new Set(Object.values(GROUP_MODELS).flat())];
      json({ success: true, data: models });
      return;
    }

    // ---- tokens ----
    if (url.pathname === "/api/token/" && req.method === "GET") {
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
      const items = state.tokens.map((t) => ({ ...t, key: maskKey(t.key) }));
      json({ success: true, data: { page: 1, page_size: 100, total: items.length, items } });
      return;
    }

    const batch = url.pathname.match(/^\/api\/token\/batch\/keys$/);
    if (batch && req.method === "POST") {
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
    if (one && req.method === "POST") {
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
      // New API's AddToken returns no id and no key.
      json({ success: true, message: "" });
      return;
    }

    // ---- relay ----
    if (url.pathname === "/v1/models" || url.pathname === "/v1beta/models") {
      const t = state.tokens.find((x) => x.key === apiKey);
      if (!t) return json({ error: { message: "invalid token", type: "invalid_request_error" } }, 401);
      const models = GROUP_MODELS[t.group] ?? [];
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
      // The old path: a real check-in for a legacy-only site, a 404 otherwise
      // unless a test asks for the old reward shape.
      if (!options.legacyCheckin && !state.legacyCheckinOnly) {
        json({ success: false, message: "not found" }, 404);
        return;
      }
      if (bearer !== ACCESS_TOKEN) return json({ success: false, message: "unauthorized" }, 401);
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
