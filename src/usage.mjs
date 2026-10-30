// 一个账号还剩多少、花了多少，也就是 Magpie 用量卡片显示的内容。
//
// 卡片上只有一个额度窗口。New API 的余额（quota）和已用（used_quota）本来就是
// 同一个钱包的两端，分成两行就是把同一件事报两遍，也画不出有意义的进度条：
//
//   窗口 = { used: 已用百分比, amount: 已用, limit: 已用 + 剩余, unit: 货币 }
//
// 这是 Magpie 自己那套额度形状（host.js 的 windows）：卡片显示
// `已用 / 总额 单位 · 60.5% used`，配一条真进度条；点数字能在已用与剩余之间切换。
//
// 窗口带 `aside: true`，这是有意的。aside 把钱包挡在三样东西之外：
//   - 整窗估算（internal/usage 的 holds）：钱包没有重置时钟，算不出来，
//     否则卡片会多一行「整窗：数据不足」；
//   - 额度走势（provider/quota_history.go 的 pointOf 跳过 aside）：
//     钱包没有重置周期，画出来的是充值记录，不是额度走势；
//   - 路由的额度比较（allowanceOf 跳过 aside）：Magpie 那套「用完就歇到下次
//     重置」对钱包不成立，硬套只会让账号因为花掉的钱多而被排到后面。
// 余额见底时请求会被站点拒绝，fallback 照常换下一个账号。
//
// 分组不单独占一行：分组写在模型名里（`model · 站点 · 分组`），倍率也在那里；
// 只有真需要处理的分组（没 key、key 被拒）才提醒一句，那是一条提示不是额度。

import { getStatus, getUserSelf } from "./api.mjs";
import { caches, cacheKey, groupsMissing, groupsNeedingAttention, groupsOf } from "./state.mjs";

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

  const windows = [walletWindow(self, info)];

  // 从那一张分组表算出来：哪些没有 key，哪些被站点拒绝。
  // 合成一行，因为两者都表示「重新登录来修」。这是一条提示，不是额度：
  // 不带 `used` 就是纯文本行，Magpie 不会给它画进度条和走势线。
  const missing = groupsMissing(md);
  const problems = groupsNeedingAttention(md).filter((g) => !missing.includes(g));
  if (missing.length || problems.length) {
    const groupsMap = groupsOf(md);
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

  // 不带 signIn：一次干净读取会清掉失效标记，正常工作的令牌本该如此。
  // 只有令牌被拒时，钩子才补上 "kept"。
  return {
    plan: self.group || "",
    user: self.username || "",
    windows,
  };
}

/**
 * 钱包那一条：剩余和已用合成一个窗口，一条进度条。
 *
 * `used` 是已用份额，`amount`/`limit`/`unit` 让它显示成
 * 「已用 / 总额 单位 · 百分比」，点数字能在已用与剩余之间切换
 * （app.js 的 quotaFill / quotaText / quotaCount）。
 */
export function walletWindow(self, info) {
  const left = quotaAsNumber(self.quota, info);
  const spent = quotaAsNumber(self.usedQuota, info);
  const total = left + spent;
  const name = t("Balance");

  // 没充过也没花过：没有比例可画，只报读数。不带 used 就是纯文本行，
  // Magpie 不会给它画进度条。总额不到一分钱时同理——两位小数会显示成 0。
  if (!(total >= 0.01)) {
    return { name, display: t("{left} left", { left: formatQuota(self.quota, info) }), aside: true };
  }

  const used = Math.round(Math.max(0, Math.min(100, (spent / total) * 100)) * 10) / 10;
  return {
    name,
    used,
    amount: spent,
    limit: total,
    unit: info.currency ? quotaUnit(info) : "quota",
    aside: true,
  };
}
