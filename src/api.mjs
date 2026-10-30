// New API 的 HTTP 接口：统一信封（{success, message, data}）、
// 管理接口（用户、分组、定价、令牌、签到）和推理接口
// （models、chat、responses、messages、gemini）。
//
// New API 大多数管理类失败都用 HTTP 200 + {success:false, message} 回答，
// 所以这里从不只看状态码。

import { USER_AGENT, fetchWithTimeout, joinURL } from "./util.mjs";
import { t } from "./i18n.mjs";

// Magpie 给一个供应商的整个模型钩子只有 20 秒（gui/providers.go 的 Refetch）。
// 单个请求绝不能吃掉全部，否则列举会以 "context deadline exceeded" 失败，
// 而不是把本来能拿到的列表显示出来。
const DEFAULT_TIMEOUT = 8000;
const LIST_TIMEOUT = 10000;

/** 带 HTTP 状态码和站点原话的错误。 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = "", url = "", body = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.url = url;
    this.body = body;
  }
}

/** 这个错误是否表示访问令牌本身被拒绝。 */
export function isAuthError(err) {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/**
 * 这个错误是否是 Cloudflare / Turnstile 质询：站点要一个浏览器。
 * 这里绝不尝试绕过。
 */
export function challengeKind(err) {
  if (err?.code === "cf") return "cf";
  if (err?.code === "turnstile") return "turnstile";
  const text = `${err?.message ?? ""} ${err?.body ?? ""}`.toLowerCase();
  if (/turnstile|cf-challenge|__cf_chl_|just a moment|attention required|checking your browser/.test(text)) {
    return /turnstile/.test(text) ? "turnstile" : "cf";
  }
  return "";
}

/** 把质询表示成错误，让每个调用方用同一种方式处理。 */
export class ChallengeError extends ApiError {
  constructor(kind, message, details = {}) {
    super(message || (kind === "turnstile" ? "the site asks for a Turnstile token" : "the site asks for a Cloudflare challenge"), {
      ...details,
      code: kind,
    });
    this.name = "ChallengeError";
  }
}

function looksLikeChallenge(res, text) {
  const mitigated = (res.headers.get("cf-mitigated") ?? "").toLowerCase();
  if (mitigated === "challenge") return "cf";
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/html")) {
    const lower = text.toLowerCase();
    if (lower.includes("just a moment") || lower.includes("cdn-cgi/challenge-platform") || lower.includes("__cf_chl_")) return "cf";
    if (lower.includes("cf-challenge") || lower.includes("attention required")) return "cf";
  }
  const server = (res.headers.get("server") ?? "").toLowerCase();
  if (res.status === 403 && server.includes("cloudflare")) return "cf";
  return "";
}

/** New API 信封里的消息；没有就取正文的短形式。 */
function envelopeMessage(payload, text) {
  if (payload && typeof payload === "object") {
    const m = payload.message ?? payload.error?.message ?? payload.msg ?? payload.detail;
    if (typeof m === "string" && m.trim()) return m.trim();
    if (payload.error && typeof payload.error === "object" && typeof payload.error.code === "string") return payload.error.code;
  }
  const s = String(text ?? "").trim();
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * 向 New API 站点发一个请求。
 *
 * `token` 作为 Authorization bearer 发出（管理接口）。
 * `apiKey` 按目标推理接口读的方式发出（Bearer、x-api-key 或 x-goog-api-key），
 * 由接口决定。
 * `userId` 在知道时作为 New-Api-User 发出，给需要它的老版本用。
 */
export async function newapiFetch(base, path, options = {}) {
  try {
    return await newapiFetchOnce(base, path, options);
  } catch (e) {
    // 站点还没回答连接就断了，说明不了站点怎样：再试一次。
    // 只要收到回答，无论多糟，都是最终结果。
    if (e instanceof ApiError && e.status === 0 && options.retry !== false) {
      await new Promise((r) => setTimeout(r, 150));
      return newapiFetchOnce(base, path, { ...options, retry: false });
    }
    throw e;
  }
}

async function newapiFetchOnce(base, path, options = {}) {
  const {
    method = "GET",
    token = "",
    apiKey = "",
    authStyle = "bearer",
    userId = "",
    body,
    query,
    headers: extra,
    timeout = DEFAULT_TIMEOUT,
    fetchImpl = globalThis.fetch,
    signal,
  } = options;

  let url = joinURL(base, path);
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }

  const headers = { accept: "application/json", "user-agent": USER_AGENT };
  for (const [k, v] of Object.entries(extra ?? {})) headers[k] = String(v);
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  else if (apiKey) {
    if (authStyle === "anthropic") headers["x-api-key"] = apiKey;
    else if (authStyle === "gemini") headers["x-goog-api-key"] = apiKey;
    else headers.authorization = `Bearer ${apiKey}`;
  }
  if (userId) headers["New-Api-User"] = String(userId);

  let res;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
      timeout,
    );
  } catch (e) {
    if (e?.name === "AbortError") throw new ApiError(t("the request was cancelled"), { url });
    // cause 里才是真正的故障（ECONNREFUSED、ENOTFOUND、证书），
    // 光一句 "fetch failed" 对用户毫无信息。
    const cause = e?.cause?.code ?? e?.cause?.errno ?? "";
    const why = cause ? `${e?.message ?? e} (${cause})` : (e?.message ?? String(e));
    throw new ApiError(t("could not reach {url}: {why}", { url, why }), { url });
  }

  const text = await res.text();
  const kind = looksLikeChallenge(res, text);
  if (kind) throw new ChallengeError(kind, "", { status: res.status, url, body: text.slice(0, 500) });

  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }

  if (!res.ok) {
    throw new ApiError(envelopeMessage(payload, text) || `${res.status} ${res.statusText}`, {
      status: res.status,
      url,
      body: text.slice(0, 500),
    });
  }

  if (payload && typeof payload === "object" && payload.success === false) {
    const message = envelopeMessage(payload, text);
    const turnstile = /turnstile/i.test(message) || /captcha/i.test(message);
    if (turnstile) throw new ChallengeError("turnstile", message, { status: res.status, url, body: text.slice(0, 500) });
    throw new ApiError(message || t("New API refused the request"), { status: res.status, url, body: text.slice(0, 500) });
  }

  return { payload, status: res.status, url, text };
}

/** GET /api/status —— 公开；额度单位、货币显示、签到与 Turnstile 开关。 */
export async function getStatus(base, opts = {}) {
  const { payload } = await newapiFetch(base, "/api/status", { ...opts, timeout: opts.timeout ?? 8000 });
  const data = payload?.data ?? payload ?? {};
  return {
    version: String(data.version ?? ""),
    systemName: String(data.system_name ?? ""),
    logo: String(data.logo ?? ""),
    quotaPerUnit: Number(data.quota_per_unit) > 0 ? Number(data.quota_per_unit) : 500000,
    displayInCurrency: data.display_in_currency !== false,
    quotaDisplayType: String(data.quota_display_type ?? ""),
    customCurrencySymbol: String(data.custom_currency_symbol ?? ""),
    customCurrencyExchangeRate: Number(data.custom_currency_exchange_rate) || 1,
    usdExchangeRate: Number(data.usd_exchange_rate) > 0 ? Number(data.usd_exchange_rate) : Number(data.price) > 0 ? Number(data.price) : 1,
    checkinEnabled: data.checkin_enabled === true,
    turnstile: data.turnstile_check === true || data.turnstile === true,
    turnstileSiteKey: String(data.turnstile_site_key ?? ""),
    raw: data,
  };
}

/** GET /api/user/self —— id、用户名、分组、剩余额度、已用额度、请求数。 */
export async function getUserSelf(base, token, userId, opts = {}) {
  const { payload } = await newapiFetch(base, "/api/user/self", { ...opts, token, userId });
  const data = payload?.data ?? payload ?? {};
  return {
    id: Number(data.id) || 0,
    username: String(data.username ?? ""),
    displayName: String(data.display_name ?? ""),
    group: String(data.group ?? ""),
    quota: Number(data.quota) || 0,
    usedQuota: Number(data.used_quota) || 0,
    requestCount: Number(data.request_count) || 0,
    affQuota: Number(data.aff_quota) || 0,
    raw: data,
  };
}

function parseGroupPayload(payload) {
  const data = payload?.data ?? payload ?? {};
  const out = {};
  if (!data || typeof data !== "object") return out;
  if (Array.isArray(data)) {
    // 有些分支直接返回一串名字。
    for (const item of data) {
      if (typeof item === "string" && item.trim()) out[item.trim()] = { ratio: 0, desc: "" };
      else if (item && typeof item === "object") {
        const name = String(item.group ?? item.name ?? item.key ?? "").trim();
        if (name) out[name] = { ratio: Number(item.ratio) || 0, desc: String(item.desc ?? item.description ?? "") };
      }
    }
    return out;
  }
  for (const [name, value] of Object.entries(data)) {
    if (!name.trim()) continue;
    if (value && typeof value === "object") {
      out[name] = {
        ratio: Number(value.ratio) || 0,
        desc: String(value.desc ?? value.description ?? ""),
      };
    } else {
      out[name] = { ratio: Number(value) || 0, desc: "" };
    }
  }
  return out;
}

/**
 * GET /api/user/self/groups，老路径作为后备：
 * /api/user/groups 与 /api/user_group_map（AnyRouter 之类的分支）。
 * 404 或空答案就换下一个路径。
 */
export async function getUserGroups(base, token, userId, opts = {}) {
  const paths = ["/api/user/self/groups", "/api/user/groups", "/api/user_group_map"];
  let lastError;
  for (const path of paths) {
    try {
      const { payload } = await newapiFetch(base, path, { ...opts, token, userId });
      const groups = parseGroupPayload(payload);
      if (Object.keys(groups).length) return groups;
    } catch (e) {
      if (e instanceof ChallengeError) throw e;
      lastError = e;
      if (isAuthError(e)) throw e;
      const status = /** @type {ApiError} */ (e)?.status;
      if (status !== 404 && status !== 0) throw e;
    }
  }
  if (lastError) return {};
  return {};
}

/**
 * GET /api/pricing —— 模型广场：哪些分组提供某个模型、它支持哪些端点类型，
 * 以及各分组倍率。多数站点公开，有些要登录，少数只对管理员开放
 * （这时返回空，调用方退回 /v1/models 与 /api/user/models）。
 */
export async function getPricing(base, token, userId, opts = {}) {
  let payload;
  try {
    ({ payload } = await newapiFetch(base, "/api/pricing", {
      ...opts,
      token,
      userId,
      timeout: opts.timeout ?? 15000,
    }));
  } catch (e) {
    if (e instanceof ChallengeError) throw e;
    return null;
  }

  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const models = new Map();
  for (const item of list) {
    const name = String(item?.model_name ?? item?.model ?? "").trim();
    if (!name) continue;
    models.set(name.toLowerCase(), {
      model: name,
      groups: Array.isArray(item.enable_groups) ? item.enable_groups.map(String) : [],
      endpoints: Array.isArray(item.supported_endpoint_types) ? item.supported_endpoint_types.map(String) : [],
      quotaType: Number(item.quota_type) || 0,
      modelRatio: Number(item.model_ratio) || 0,
      modelPrice: Number(item.model_price) || 0,
      completionRatio: Number(item.completion_ratio) || 0,
      cacheRatio: item.cache_ratio === undefined ? undefined : Number(item.cache_ratio),
      ownerBy: String(item.owner_by ?? ""),
    });
  }

  const groupRatio = {};
  for (const [name, value] of Object.entries(payload?.group_ratio ?? {})) {
    const n = Number(value);
    if (Number.isFinite(n)) groupRatio[name] = n;
  }
  const usableGroup = {};
  for (const [name, desc] of Object.entries(payload?.usable_group ?? {})) {
    usableGroup[name] = String(desc ?? "");
  }
  const autoGroups = Array.isArray(payload?.auto_groups) ? payload.auto_groups.map(String) : [];
  return { models, groupRatio, usableGroup, autoGroups, pricingVersion: String(payload?.pricing_version ?? "") };
}

/** GET /api/token/ 的一页（列表接口从不返回完整 key）。 */
function parseTokenPage(payload) {
  const data = payload?.data ?? payload ?? {};
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const total = Number(data?.total) || items.length;
  return { items, total };
}

/**
 * 账号的全部 token，跨页读取。站点返回的 `key` 是掩码；
 * 完整值要另走 revealTokenKeys，而且只对它允许的 id 有效。
 */
export async function listTokens(base, token, userId, opts = {}) {
  const pageSize = 100;
  const maxPages = 10;
  const all = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const { payload } = await newapiFetch(base, "/api/token/", {
      ...opts,
      token,
      userId,
      query: { p: page, page_size: pageSize, size: pageSize },
      timeout: LIST_TIMEOUT,
    });
    const { items, total: t } = parseTokenPage(payload);
    total = t || total;
    all.push(...items);
    if (items.length < pageSize) break;
    if (total && all.length >= total) break;
  }

  return all.map((item, index) => {
    const group = String(item.group ?? item.token_group ?? item.group_name ?? "").trim();
    const autoGroups = Array.isArray(item.auto_groups)
      ? item.auto_groups.map(String)
      : typeof item.auto_groups === "string" && item.auto_groups
        ? (() => {
            try {
              const v = JSON.parse(item.auto_groups);
              return Array.isArray(v) ? v.map(String) : [];
            } catch {
              return [];
            }
          })()
        : [];
    return {
      id: Number(item.id) || 0,
      name: String(item.name ?? `token-${index + 1}`),
      key: String(item.key ?? ""),
      group,
      autoGroups,
      status: Number(item.status ?? 1),
      expiredTime: Number(item.expired_time ?? -1),
      remainQuota: Number(item.remain_quota) || 0,
      unlimitedQuota: item.unlimited_quota === true,
      modelLimitsEnabled: item.model_limits_enabled === true,
      modelLimits: String(item.model_limits ?? ""),
      allowUserQuotaQuery: item.allow_user_quota_query !== false,
      accessedTime: Number(item.accessed_time) || 0,
      raw: item,
    };
  });
}

/** 这个 token 还能用：未禁用、未过期、没用完。 */
export function tokenUsable(t, now = Date.now() / 1000) {
  if (!t) return false;
  if (t.status === 2 || t.status === 3) return false; // 已禁用 / 已过期
  if (t.expiredTime > 0 && t.expiredTime < now) return false;
  if (!t.unlimitedQuota && t.remainQuota <= 0) return false;
  return true;
}

/**
 * 按 id 取 token 的完整 key，能取到多少算多少。
 * 先试批量接口，剩下的逐个取。任何失败都不致命：
 * 调用方保留已拿到的，剩下的问用户。
 */
export async function revealTokenKeys(base, token, userId, ids, opts = {}) {
  const keys = new Map();
  const pending = [...new Set(ids.filter((id) => Number(id) > 0))];
  if (!pending.length) return keys;

  for (let i = 0; i < pending.length; i += 100) {
    const chunk = pending.slice(i, i + 100);
    try {
      const { payload } = await newapiFetch(base, "/api/token/batch/keys", {
        ...opts,
        token,
        userId,
        method: "POST",
        body: { ids: chunk },
      });
      const map = payload?.data?.keys ?? payload?.keys ?? {};
      for (const [id, key] of Object.entries(map)) {
        const k = String(key ?? "").trim();
        if (k && !k.includes("*") && !k.includes("•")) keys.set(Number(id), k);
      }
    } catch (e) {
      if (e instanceof ChallengeError || isAuthError(e)) {
        // 完全没有 reveal 权限：逐个问也没意义。
        return keys;
      }
    }
  }

  for (const id of pending) {
    if (keys.has(id)) continue;
    try {
      const { payload } = await newapiFetch(base, `/api/token/${id}/key`, { ...opts, token, userId, method: "POST" });
      const key = String(payload?.data?.key ?? payload?.key ?? "").trim();
      if (key && !key.includes("*") && !key.includes("•")) keys.set(id, key);
    } catch (e) {
      if (e instanceof ChallengeError || isAuthError(e)) break;
    }
  }
  return keys;
}

/**
 * POST /api/token/ —— 为某个分组建一个 token。New API 只回 success，
 * 既不给 id 也不给 key，所以调用方要重新列一遍 token 再 reveal。
 */
export async function createToken(base, token, userId, group, name, opts = {}) {
  await newapiFetch(base, "/api/token/", {
    ...opts,
    token,
    userId,
    method: "POST",
    body: {
      name: String(name).slice(0, 50),
      unlimited_quota: true,
      expired_time: -1,
      remain_quota: 0,
      allow_ips: "",
      model_limits_enabled: false,
      model_limits: "",
      group: String(group),
    },
  });
}

/** 用分组 key 调 GET /v1/models：这个 key 能调哪些模型。 */
export async function listModelsForKey(base, key, opts = {}) {
  const { payload } = await newapiFetch(base, "/v1/models", {
    ...opts,
    apiKey: key,
    timeout: opts.timeout ?? LIST_TIMEOUT,
  });
  const data = payload?.data ?? payload?.models ?? [];
  const out = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      const id = typeof item === "string" ? item : String(item?.id ?? "");
      if (id) out.push(id);
    }
  } else if (data && typeof data === "object") {
    // Gemini 风格：{ models: [ { name: "models/x" } ] }
    for (const item of data.models ?? []) {
      const raw = String(item?.name ?? item?.id ?? "");
      if (raw) out.push(raw.replace(/^models\//, ""));
    }
  }
  return [...new Set(out)];
}

/** GET /api/user/models?group= —— 模型广场关闭时的后备模型列表。 */
export async function listUserModels(base, token, userId, group, opts = {}) {
  const { payload } = await newapiFetch(base, "/api/user/models", {
    ...opts,
    token,
    userId,
    query: group ? { group } : undefined,
  });
  const data = payload?.data ?? [];
  if (Array.isArray(data)) return data.map(String).filter(Boolean);
  if (data && typeof data === "object") return Object.keys(data).filter(Boolean);
  return [];
}

/** GET /api/user/self/checkin —— 签到开关与今天的状态。 */
export const CHECKIN_PATHS = ["/api/user/self/checkin", "/api/user/checkin"];

/** 站点回答过的签到路径，下次先问对的那个。 */
const checkinPathKnown = new Map();

function parseCheckinStatus(payload, path) {
  const data = payload?.data ?? payload ?? {};
  const stats = data.stats ?? {};
  const records = Array.isArray(stats.records) ? stats.records : Array.isArray(data.records) ? data.records : [];
  return {
    path,
    enabled: data.enabled === true,
    minQuota: Number(data.min_quota) || 0,
    maxQuota: Number(data.max_quota) || 0,
    checkedInToday: stats.checked_in_today === true,
    totalCheckins: Number(stats.total_checkins) || Number(stats.checkin_count) || 0,
    totalQuota: Number(stats.total_quota) || 0,
    records,
  };
}

/**
 * 站点的签到状态。New API 有过两种布局：较新的
 * /api/user/self/checkin（在后台的 self 路由下），和较老的
 * /api/user/checkin——有些版本（v1.0.0-rc.46 就是）只有后者。
 * 两种都会试，记住能回答的那个。
 */
export async function getCheckinStatus(base, token, userId, opts = {}) {
  const known = checkinPathKnown.get(base);
  const paths = known ? [known, ...CHECKIN_PATHS.filter((p) => p !== known)] : CHECKIN_PATHS;
  let lastError;
  for (const path of paths) {
    try {
      const { payload } = await newapiFetch(base, path, { ...opts, token, userId, timeout: opts.timeout ?? 8000 });
      // 没有这些字段的答案说明命中了站点的别的路由（一个 200 的页面或空正文），
      // 不是签到状态。
      const state = parseCheckinStatus(payload, path);
      if (payload?.data === undefined && payload?.success === undefined) {
        lastError = lastError ?? new ApiError("the site answered no check-in state", { url: path });
        continue;
      }
      checkinPathKnown.set(base, path);
      return state;
    } catch (e) {
      if (e instanceof ChallengeError) throw e;
      if (isAuthError(e)) throw e;
      const status = /** @type {ApiError} */ (e)?.status;
      // 404/405：不是这种布局。其他状态码就是站点在说话了。
      if (status !== 404 && status !== 405) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new ApiError(t("the site has no check-in endpoint"), { status: 404 });
}

/**
 * 按下签到。`path` 是读状态时找到的布局；没有就两种都试，新的在前。
 * 某个路径回 404/405 不算拒绝：站点用的是另一种布局。
 */
export async function postCheckin(base, token, userId, opts = {}) {
  const known = opts.path ?? checkinPathKnown.get(base);
  const paths = known ? [known, ...CHECKIN_PATHS.filter((p) => p !== known)] : CHECKIN_PATHS;
  let lastError;
  for (const path of paths) {
    try {
      const { payload } = await newapiFetch(base, path, { ...opts, token, userId, method: "POST" });
      const r = checkinResult(payload);
      // 旧接口用 {data:{reward}} 回答，或者只给一句 message。
      if (!r.success && payload?.data?.reward !== undefined) {
        return { success: true, message: r.message, data: { quota_awarded: Number(payload.data.reward) || 0, checkin_date: String(payload.data.checkin_date ?? "") } };
      }
      checkinPathKnown.set(base, path);
      return r;
    } catch (e) {
      if (e instanceof ChallengeError) throw e;
      if (isAuthError(e)) throw e;
      const status = /** @type {ApiError} */ (e)?.status;
      if (status !== 404 && status !== 405) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new ApiError(t("the site has no check-in endpoint"), { status: 404 });
}

function checkinResult(payload) {
  const data = payload?.data ?? payload ?? {};
  const success = payload?.success !== false && (payload?.success === true || data.success === true || payload?.message === "success");
  return {
    success,
    message: String(payload?.message ?? data.message ?? ""),
    data: {
      quota_awarded: Number(data.quota_awarded ?? data.reward ?? 0) || 0,
      checkin_date: String(data.checkin_date ?? ""),
    },
  };
}
