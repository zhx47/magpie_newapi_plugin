// 共用的小工具：URL 归一化、哈希、key 掩码、额度换算。
// 这里不发网络请求，全是纯函数，方便测试。

/** 把 New API 站点地址归一化成「协议 + 主机（+ 可选子路径）」，去掉末尾斜杠。 */
export function normalizeBase(input) {
  let s = String(input ?? "").trim();
  if (!s) return "";
  // 没写协议的主机补 https；写了别的协议就拒绝，不要硬改成 https。
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
  // /v1、/v1beta、/api 是接口前缀，不是站点根：去掉它们，
  // 同一个站点无论怎么写都落到同一个账号上。
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(v1beta|v1|api)$/i, "");
  u.hash = "";
  u.search = "";
  return `${u.protocol}//${u.host}${path}`;
}

/** 归一化地址里的主机，用作默认的站点标识。 */
export function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return "";
  }
}

/** 能安全放进模型 ID 的站点标识：不留空格和斜杠。 */
export function cleanLabel(input, fallback = "") {
  const s = String(input ?? "").trim();
  if (!s) return fallback;
  return s.replace(/[\s/\\]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || fallback;
}

/** 拼接 base 与路径，不会出现重复斜杠。 */
export function joinURL(base, path) {
  const b = String(base ?? "").replace(/\/+$/, "");
  const p = String(path ?? "").replace(/^\/+/, "");
  return p ? `${b}/${p}` : b;
}

/** 稳定的非加密哈希，只用于内存缓存的键。 */
export function hashKey(s) {
  let h = 2166136261;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 把密钥打码后放进消息：保留前 4 位和后 4 位，足够辨认。 */
export function maskSecret(s) {
  const str = String(s ?? "");
  if (!str) return "";
  if (str.length <= 8) return "*".repeat(str.length);
  return `${str.slice(0, 4)}${"*".repeat(10)}${str.slice(-4)}`;
}

/** 把漏进字符串里的已知密钥换成打码形式。 */
export function scrubSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets ?? []) {
    const secret = String(s ?? "").trim();
    if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(maskSecret(secret));
  }
  return out;
}

/** New API 存的 token key 不带 sk- 前缀；用户可能带，也可能不带。 */
export function normalizeApiKey(input) {
  return String(input ?? "").trim();
}

/** 判断 token 列表里的 key 是否是掩码（列表接口从不返回完整 key）。 */
export function isMaskedKey(value) {
  const s = String(value ?? "");
  if (!s) return false;
  return s.includes("*") || s.includes("•");
}

/** 分组名按稳定顺序：default 在前，其余按字母。 */
export function sortGroups(names) {
  return [...new Set(names.filter(Boolean))].sort((a, b) => {
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
}

/**
 * 额度显示：New API 把 1 个货币单位记为 quota_per_unit 点额度（默认 500000）。
 * `display` 决定站点按货币还是按原始额度显示，`symbol`/`rate` 是它用自有货币时的符号与汇率。
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
  // New API 自己的规则（GetUsdToCurrencyRate）：USD 是 1，CNY 用站点的
  // usd_exchange_rate，CUSTOM 用自定义汇率，TOKENS 没有货币。
  // 只读自定义汇率时，人民币站点的 ¥37.30 会显示成 ¥5.11。
  const usdRate = Number(status?.usd_exchange_rate ?? status?.price) > 0 ? Number(status?.usd_exchange_rate ?? status?.price) : 1;
  const customRate =
    Number(status?.custom_currency_exchange_rate) > 0 ? Number(status.custom_currency_exchange_rate) : 1;
  const rate =
    displayType === "CNY" ? usdRate : displayType === "CUSTOM" ? customRate : 1;
  return { perUnit, currency, symbol, rate, displayType };
}

/** 按站点的显示方式，把额度渲染成金额或原始额度。 */
export function formatQuota(quota, info) {
  const q = Number(quota);
  if (!Number.isFinite(q)) return "—";
  if (!info?.currency) return `${Math.round(q).toLocaleString("en-US")} quota`;
  const money = (q / info.perUnit) * (info.rate || 1);
  // 满一个单位就按分显示，和站点自己的卡片一致；不足一个单位时多留几位，
  // 否则什么都看不出来。
  const digits = Math.abs(money) >= 1 ? 2 : 4;
  return `${info.symbol}${money.toFixed(digits)}`;
}

/** 钱包窗口要的数字（按站点单位），不带符号。 */
export function quotaAsNumber(quota, info) {
  const q = Number(quota) || 0;
  if (!info?.currency) return q;
  return Number(((q / info.perUnit) * (info.rate || 1)).toFixed(6));
}

/** 钱包窗口的单位。 */
export function quotaUnit(info) {
  return info?.currency ? info.symbol || "$" : "quota";
}

/** 带超时的 fetch，同时响应调用方自己的 signal。 */
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
