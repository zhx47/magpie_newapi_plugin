// Small shared helpers: URL normalization, hashing, key masking, quotas.
// Nothing here talks to the network; everything is pure and testable.

/** Normalize a New API base URL to scheme + host (+ optional sub path), no trailing slash. */
export function normalizeBase(input) {
  let s = String(input ?? "").trim();
  if (!s) return "";
  // A host typed without a scheme gets https; anything with another scheme
  // is refused rather than mangled into an https URL.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) return "";
  } else {
    s = "https://" + s;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (!u.host) return "";
  // /v1, /v1beta and /api are API roots, not site roots: strip them so the
  // same site typed either way lands on one account and one key cache.
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(v1beta|v1|api)$/i, "");
  u.hash = "";
  u.search = "";
  return `${u.protocol}//${u.host}${path}`;
}

/** The host of a normalized base, used as the default site label. */
export function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return "";
  }
}

/** A site label safe to sit in a model id: no spaces, no slashes. */
export function cleanLabel(input, fallback = "") {
  const s = String(input ?? "").trim();
  if (!s) return fallback;
  return s.replace(/[\s/\\]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || fallback;
}

/** Join a base and a path without doubling slashes. */
export function joinURL(base, path) {
  const b = String(base ?? "").replace(/\/+$/, "");
  const p = String(path ?? "").replace(/^\/+/, "");
  return p ? `${b}/${p}` : b;
}

/** Stable non-cryptographic hash, used for in-memory cache keys only. */
export function hashKey(s) {
  let h = 2166136261;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Mask a secret for messages: first 4 and last 4, enough to recognize it. */
export function maskSecret(s) {
  const str = String(s ?? "");
  if (!str) return "";
  if (str.length <= 8) return "*".repeat(str.length);
  return `${str.slice(0, 4)}${"*".repeat(10)}${str.slice(-4)}`;
}

/** Replace any known secret that leaked into a string with its mask. */
export function scrubSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets ?? []) {
    const secret = String(s ?? "").trim();
    if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(maskSecret(secret));
  }
  return out;
}

/** New API stores a token key without the sk- prefix. Keys may come either way. */
export function normalizeApiKey(input) {
  return String(input ?? "").trim();
}

/** Whether a token list entry's key is masked (the list endpoint never reveals it). */
export function isMaskedKey(value) {
  const s = String(value ?? "");
  if (!s) return false;
  return s.includes("*") || s.includes("•");
}

/** Parse "vip=sk-1;default=sk-2" / newline / comma / JSON into { group: [keys] }. */
export function parseGroupKeys(input) {
  const out = {};
  const raw = String(input ?? "").trim();
  if (!raw) return out;
  const add = (group, key) => {
    const g = normalizeGroupName(group);
    const k = normalizeApiKey(key);
    // A masked key is what the site's list shows, never a usable key.
    if (!g || !k || isMaskedKey(k)) return;
    (out[g] ??= []).push(k);
  };
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      for (const [group, value] of Object.entries(j ?? {})) {
        if (Array.isArray(value)) for (const v of value) add(group, v);
        else add(group, value);
      }
      return dedupeGroups(out);
    } catch {
      // fall through to the text form
    }
  }
  for (const line of raw.split(/[\n;,]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 0) continue;
    add(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  return dedupeGroups(out);
}

export function normalizeGroupName(input) {
  return String(input ?? "").trim();
}

function dedupeGroups(groups) {
  const out = {};
  for (const [group, keys] of Object.entries(groups)) {
    const seen = new Set();
    const list = [];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(key);
    }
    if (list.length) out[group] = list;
  }
  return out;
}

/** Group names in a stable order: default first, then alphabetical. */
export function sortGroups(names) {
  return [...new Set(names.filter(Boolean))].sort((a, b) => {
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
}

/** Parse the group filter prompt (comma separated). Empty means all. */
export function parseGroupFilter(input) {
  return String(input ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Quota display: New API counts 1 currency unit as quota_per_unit quota
 * (500000 by default). `display` controls whether the site shows money or
 * raw quota, and `symbol`/`rate` when it shows a currency of its own.
 */
export function quotaInfo(status) {
  const perUnit = Number(status?.quota_per_unit) > 0 ? Number(status.quota_per_unit) : 500000;
  const displayType = String(status?.quota_display_type ?? "").toUpperCase();
  const currency = status?.display_in_currency !== false && displayType !== "TOKENS";
  const symbol =
    displayType === "CNY"
      ? "¥"
      : displayType === "CUSTOM"
        ? String(status?.custom_currency_symbol ?? "") || "¤"
        : displayType === "USD"
          ? "$"
          : String(status?.custom_currency_symbol ?? "") || "$";
  // New API's own rule (GetUsdToCurrencyRate): USD is 1, CNY uses the site's
  // usd_exchange_rate, CUSTOM its custom rate, TOKENS has none. Reading only
  // the custom rate showed a CNY site's ¥37.30 as ¥5.11.
  const usdRate = Number(status?.usd_exchange_rate ?? status?.price) > 0 ? Number(status?.usd_exchange_rate ?? status?.price) : 1;
  const customRate =
    Number(status?.custom_currency_exchange_rate) > 0 ? Number(status.custom_currency_exchange_rate) : 1;
  const rate =
    displayType === "CNY" ? usdRate : displayType === "CUSTOM" ? customRate : 1;
  return { perUnit, currency, symbol, rate, displayType };
}

/** Render a quota amount as money or raw quota, as the site displays it. */
export function formatQuota(quota, info) {
  const q = Number(quota);
  if (!Number.isFinite(q)) return "—";
  if (!info?.currency) return `${Math.round(q).toLocaleString("en-US")} quota`;
  const money = (q / info.perUnit) * (info.rate || 1);
  // Whole units read at cents, like the site's own card; under one unit the
  // extra digits are the only way to see anything at all.
  const digits = Math.abs(money) >= 1 ? 2 : 4;
  return `${info.symbol}${money.toFixed(digits)}`;
}

/** A quota amount as a plain number for a wallet window (in the site's unit). */
export function quotaAsNumber(quota, info) {
  const q = Number(quota) || 0;
  if (!info?.currency) return q;
  return Number(((q / info.perUnit) * (info.rate || 1)).toFixed(6));
}

/** Unit label for a wallet window. */
export function quotaUnit(info) {
  return info?.currency ? info.symbol || "$" : "quota";
}

/** Fetch with a timeout, cancelled by the caller's signal as well. */
export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs} ms`)), Math.max(1, timeoutMs));
  const outer = init?.signal;
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}
