// New API's HTTP surface: the envelope ({success, message, data}), the
// management endpoints (user, groups, pricing, tokens, check-in) and the
// relay endpoints (models, chat, responses, messages, gemini).
//
// New API answers most management failures with HTTP 200 and
// {success:false, message}, so nothing here trusts the status alone.

import { fetchWithTimeout, joinURL } from "./util.mjs";

// Magpie gives a provider's whole models hook 20s (gui/providers.go's
// Refetch). A single request must never be allowed to eat all of it, or the
// listing fails with "context deadline exceeded" instead of showing the list
// it could have shown.
const DEFAULT_TIMEOUT = 8000;
const LIST_TIMEOUT = 10000;

/** An error that carries the HTTP status and the site's own message. */
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

/** Whether an error means the access token itself is refused. */
export function isAuthError(err) {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/**
 * Whether an error is a Cloudflare / Turnstile challenge: the site wants a
 * browser. Nothing here tries to get past one.
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

/** A challenge as an error, so every caller handles it the same way. */
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

/** The message New API puts in an envelope, or a short form of the body. */
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
 * One request against a New API site.
 *
 * `token` goes as the Authorization bearer (management endpoints).
 * `apiKey` goes the way the relay endpoint reads it (Bearer, x-api-key or
 * x-goog-api-key), chosen per endpoint.
 * `userId` is sent as New-Api-User when known, for the versions that need it.
 */
export async function newapiFetch(base, path, options = {}) {
  try {
    return await newapiFetchOnce(base, path, options);
  } catch (e) {
    // A connection that dropped before the site answered says nothing about
    // the site: try once more. A response, however bad, is final.
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

  const headers = { accept: "application/json" };
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
    if (e?.name === "AbortError") throw new ApiError("the request was cancelled", { url });
    // The cause names the fault (ECONNREFUSED, ENOTFOUND, a certificate):
    // "fetch failed" alone tells a user nothing.
    const cause = e?.cause?.code ?? e?.cause?.errno ?? "";
    const why = cause ? `${e?.message ?? e} (${cause})` : (e?.message ?? String(e));
    throw new ApiError(`could not reach ${url}: ${why}`, { url });
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
    throw new ApiError(message || "New API refused the request", { status: res.status, url, body: text.slice(0, 500) });
  }

  return { payload, status: res.status, url, text };
}

/** GET /api/status — public; quota units, currency display, check-in and Turnstile switches. */
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

/** GET /api/user/self — id, username, group, quota, used quota, request count. */
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
    // Some forks answer a bare list of names.
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
 * GET /api/user/self/groups, with the older paths as fallbacks:
 * /api/user/groups and /api/user_group_map (forks such as AnyRouter).
 * A 404 or an empty answer moves on to the next path.
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
 * GET /api/pricing — the model square: which groups serve a model and which
 * endpoint types it supports, plus the group ratios. Public on most sites,
 * user-scoped on others, root-only on a few (then this returns empty and
 * the caller falls back to /v1/models and /api/user/models).
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

/** One page of GET /api/token/ (the list never includes the full key). */
function parseTokenPage(payload) {
  const data = payload?.data ?? payload ?? {};
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const total = Number(data?.total) || items.length;
  return { items, total };
}

/**
 * Every token of the account, across pages. `key` is masked by the site;
 * `revealTokens` gets the real value for the ids it is allowed to.
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

/** The token entry is still usable: enabled, not expired, and not used up. */
export function tokenUsable(t, now = Date.now() / 1000) {
  if (!t) return false;
  if (t.status === 2 || t.status === 3) return false; // disabled / expired
  if (t.expiredTime > 0 && t.expiredTime < now) return false;
  if (!t.unlimitedQuota && t.remainQuota <= 0) return false;
  return true;
}

/**
 * The full keys for token ids, as far as the account may see them.
 * Tries the batch endpoint once, then the per-token one for what is left.
 * Every failure is non-fatal: the caller keeps whatever it got and asks the
 * user for the rest.
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
        // No reveal permission at all: no point asking one by one.
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
 * POST /api/token/ — create a token for a group. New API answers success
 * without an id or a key, so the caller lists tokens again and reveals it.
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

/** GET /v1/models with a group key: the models that key may call. */
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
    // Gemini-style { models: [ { name: "models/x" } ] }
    for (const item of data.models ?? []) {
      const raw = String(item?.name ?? item?.id ?? "");
      if (raw) out.push(raw.replace(/^models\//, ""));
    }
  }
  return [...new Set(out)];
}

/** GET /api/user/models?group= — the fallback model list when pricing is closed. */
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

/** GET /api/user/self/checkin — the switch and today's state. */
export const CHECKIN_PATHS = ["/api/user/self/checkin", "/api/user/checkin"];

/** The paths a site has answered for check-in, so the next call asks the right one first. */
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
 * The site's check-in state. New API has had two layouts: the newer
 * /api/user/self/checkin (under the dashboard's self routes) and the
 * older /api/user/checkin, which some builds — v1.0.0-rc.46 among them —
 * keep alone. Both are tried; the one that answered is remembered.
 */
export async function getCheckinStatus(base, token, userId, opts = {}) {
  const known = checkinPathKnown.get(base);
  const paths = known ? [known, ...CHECKIN_PATHS.filter((p) => p !== known)] : CHECKIN_PATHS;
  let lastError;
  for (const path of paths) {
    try {
      const { payload } = await newapiFetch(base, path, { ...opts, token, userId, timeout: opts.timeout ?? 8000 });
      // An answer without the fields is the site's other route (a 200 page or
      // an empty body), not the check-in state.
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
      // 404/405: not this layout. Anything else is the site speaking.
      if (status !== 404 && status !== 405) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new ApiError("the site has no check-in endpoint", { status: 404 });
}

/**
 * Press the check-in. `path` is the layout the status read found; without
 * one both are tried, the newer first. A 404/405 on a path is not a
 * refusal: the site has the other layout.
 */
export async function postCheckin(base, token, userId, opts = {}) {
  const known = opts.path ?? checkinPathKnown.get(base);
  const paths = known ? [known, ...CHECKIN_PATHS.filter((p) => p !== known)] : CHECKIN_PATHS;
  let lastError;
  for (const path of paths) {
    try {
      const { payload } = await newapiFetch(base, path, { ...opts, token, userId, method: "POST" });
      const r = checkinResult(payload);
      // The older endpoint answers {data:{reward}} or only a message.
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
  throw lastError ?? new ApiError("the site has no check-in endpoint", { status: 404 });
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
