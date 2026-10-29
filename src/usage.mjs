// What an account has used and holds, as Magpie's usage card shows it:
// the wallet's balance, the spend and request count, the groups Magpie
// knows, and whether check-in is off or blocked.
//
// A wallet window (`balance`, no `used`) makes Magpie treat the account as
// prepaid and route by what is left. Text windows (`used: 0` with
// `display`) are read, never counted, so they cannot skew routing.

import { getStatus, getUserSelf } from "./api.mjs";
import { caches, cacheKey, missingGroups } from "./state.mjs";
import { formatQuota, quotaAsNumber, quotaInfo, quotaUnit } from "./util.mjs";

/** The account's own numbers, cached briefly: balances move slowly. */
export async function readAccount(md, opts = {}) {
  const base = md.baseURL;
  const key = cacheKey(base, "self", md.accessToken);
  return caches.usage.getOr(key, 30_000, () => retried(() => getUserSelf(base, md.accessToken, md.userId, { ...opts, timeout: 10_000 })));
}

/** A read retried once when the connection itself failed (status 0). */
async function retried(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.status !== 0) throw e;
    return fn();
  }
}

/** The site's display settings, cached for a while. */
export async function readStatus(md, opts = {}) {
  return caches.status.getOr(cacheKey(md.baseURL, "status"), 10 * 60_000, () => getStatus(md.baseURL, { ...opts, timeout: 8000 }));
}

/**
 * Build the usage answer. Throws when the access token is refused, so the
 * caller can decide between `signIn: "kept"` and letting the account lapse.
 */
export async function buildUsage(md, opts = {}) {
  const self = await readAccount(md, opts);
  let status;
  try {
    status = await readStatus(md, opts);
  } catch {
    status = null;
  }

  const info = quotaInfo({
    quota_per_unit: status?.quotaPerUnit ?? md.status?.quotaPerUnit,
    display_in_currency: status?.displayInCurrency ?? md.status?.currency,
    quota_display_type: status?.quotaDisplayType ?? md.status?.quotaDisplayType,
    custom_currency_symbol: status?.customCurrencySymbol ?? md.status?.currencySymbol,
    custom_currency_exchange_rate: status?.customCurrencyExchangeRate ?? md.status?.currencyRate,
    // CNY divides by this; without it a CNY balance reads low by the rate.
    usd_exchange_rate: status?.usdExchangeRate ?? md.status?.usdExchangeRate,
  });

  const groups = Object.keys(md.groups ?? {}).length ? Object.keys(md.groups) : Object.keys(md.groupKeys ?? {});
  const groupList = groups.length ? groups.join(", ") : "—";
  const ratio = Object.entries(md.groups ?? {})
    .filter(([, v]) => Number(v?.ratio) > 0)
    .map(([name, v]) => `${name} ×${v.ratio}`)
    .join(", ");

  // `used` is left off every row but the wallet. Magpie reads a window with
  // a `used` as a share of an allowance: 0 becomes a 0% meter, a trend line
  // and "not enough data" under it (#2045's HoldsLow), which these rows are
  // not. Without it the window is text alone, counted by nothing.
  const windows = [
    {
      // A wallet reading, the shape Magpie's #3950 asks for: the figure and
      // its unit, no `used`. Not `aside`: an aside window is skipped when
      // the account's allowance is built, and this balance is what routing
      // weighs a prepaid account by.
      name: "Balance",
      balance: quotaAsNumber(self.quota, info),
      unit: quotaUnit(info),
      display: `${formatQuota(self.quota, info)} left`,
    },
    {
      name: "Used",
      display: `${formatQuota(self.usedQuota, info)} used · ${Number(self.requestCount || 0).toLocaleString("en-US")} requests`,
    },
    {
      name: "Groups",
      display: ratio ? `${groupList} (${ratio})` : groupList,
    },
  ];

  // Reckoned now: a key pasted since sign-in drops off without a re-login.
  const pending = missingGroups(md);
  if (pending.length) {
    windows.push({
      name: "Missing keys",
      display: `${pending.join(", ")} — sign in again to add them`,
    });
  }

  if (md.checkin === "off") {
    windows.push({ name: "Check-in", display: "Auto check-in off · check in on the site" });
  }

  // No signIn: a clean read clears a lapse mark, which is what a working
  // token should do. The hook adds "kept" only when the token was refused.
  return {
    plan: self.group || "",
    user: self.username || "",
    windows,
  };
}
