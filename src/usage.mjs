// 一个账号用了多少、还剩多少，也就是 Magpie 用量卡片显示的内容：
// 钱包余额、已用额度与请求数、Magpie 知道的分组，以及签到是否关闭或被拦。
//
// 钱包窗口（有 `balance`、没有 `used`）让 Magpie 把账号当成预付的，
// 按剩余多少排序。纯文本窗口（只有 `display`、**不带** `used`）只读不计数，
// 所以不会影响路由。

import { getStatus, getUserSelf } from "./api.mjs";
import { caches, cacheKey, groupsMissing, groupsNeedingAttention, groupsOf, sortGroups } from "./state.mjs";

import { formatQuota, quotaAsNumber, quotaInfo, quotaUnit } from "./util.mjs";
import { t } from "./i18n.mjs";

/** 账号自己的数字，短暂缓存：余额变化很慢。 */
export async function readAccount(md, opts = {}) {
  const base = md.baseURL;
  const key = cacheKey(base, "self", md.accessToken);
  return caches.usage.getOr(key, 30_000, () => retried(() => getUserSelf(base, md.accessToken, md.userId, { ...opts, timeout: 10_000 })));
}

/** 连接本身失败（status 0）时重读一次。 */
async function retried(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.status !== 0) throw e;
    return fn();
  }
}

/** 站点的显示设置，缓存一段时间。 */
export async function readStatus(md, opts = {}) {
  return caches.status.getOr(cacheKey(md.baseURL, "status"), 10 * 60_000, () => getStatus(md.baseURL, { ...opts, timeout: 8000 }));
}

/**
 * 组装用量回答。访问令牌被拒时抛错，让调用方决定是用
 * `signIn: "kept"` 保住账号，还是让它标记为失效。
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
    // 人民币要除这个汇率；不乘它，人民币余额会少算一个汇率倍数。
    usd_exchange_rate: status?.usdExchangeRate ?? md.status?.usdExchangeRate,
  });

  const groupsMap = groupsOf(md);
  const groupNames = sortGroups(Object.keys(groupsMap));
  const groupList = groupNames.length ? groupNames.join(", ") : t("No groups yet · check in or open Usage to read them");
  const ratio = groupNames
    .filter((name) => Number(groupsMap[name].ratio) > 0)
    .map((name) => `${name} ×${groupsMap[name].ratio}`)
    .join(", ");

  // 除了钱包，每一行都不带 `used`。Magpie 把带 `used` 的窗口当成额度的比例：
  // 0 会画成 0% 进度条、一条趋势线，还有下面的「数据不足」
  // （#2045 的 HoldsLow），而这些行并不是那个意思。
  // 不带 `used` 时窗口就是纯文本，不参与任何计数。
  const windows = [
    {
      // 钱包读数，也就是 Magpie #3950 要的形状：只有数字和单位，没有 `used`。
      // 不加 `aside`：aside 窗口在组装账号额度时会被跳过，
      // 而路由正是按这个余额来比较预付账号的。
      name: t("Balance"),
      balance: quotaAsNumber(self.quota, info),
      unit: quotaUnit(info),
      display: t("{left} left", { left: formatQuota(self.quota, info) }),
    },
    {
      name: t("Used"),
      display: t("{used} used · {n} requests", {
        used: formatQuota(self.usedQuota, info),
        n: Number(self.requestCount || 0).toLocaleString("en-US"),
      }),
    },
    {
      name: t("Groups"),
      display: ratio ? `${groupList} (${ratio})` : groupList,
    },
  ];

  // 从那一张分组表算出来：哪些没有 key，哪些被站点拒绝。
  // 合成一行，因为两者都表示「重新登录来修」。
  const missing = groupsMissing(md);
  const problems = groupsNeedingAttention(md).filter((g) => !missing.includes(g));
  if (missing.length || problems.length) {
    const bits = [];
    if (missing.length) bits.push(t("no key: {groups}", { groups: missing.join(", ") }));
    if (problems.length) {
      const refused = problems.filter((g) => groupsMap[g]?.problem !== "gone");
      const gone = problems.filter((g) => groupsMap[g]?.problem === "gone");
      if (refused.length) bits.push(t("refused: {groups}", { groups: refused.join(", ") }));
      if (gone.length) bits.push(t("gone: {groups}", { groups: gone.join(", ") }));
    }
    windows.push({
      name: t("Group keys"),
      display: `${bits.join(" · ")}${t("— sign in again to fix")}`,
    });
  }

  if (md.checkin === "off") {
    windows.push({ name: t("Daily check-in"), display: t("Auto check-in off · check in on the site") });
  }

  // 不带 signIn：一次干净读取会清掉失效标记，正常工作的令牌本该如此。
  // 只有令牌被拒时，钩子才补上 "kept"。
  return {
    plan: self.group || "",
    user: self.username || "",
    windows,
  };
}
