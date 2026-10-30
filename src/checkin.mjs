// 每日签到，以及围绕它的开关。
//
// 有些 New API 站点给签到接口加了 Cloudflare Turnstile 或托管质询。
// 访问令牌过不去——那需要浏览器。所以插件：
//   - 检测到质询就把账号标出来，之后的日子直接返回 `captcha`，
//     不再白花请求；
//   - 绝不破解或绕过任何质询。
//
// 开不开签到由 Magpie 自己的开关决定（Settings → 额度 → 对应账号，
// 以及 Plugins 里这个插件的每日签到）。插件不另设一个：两个开关
// 各说各的只会互相矛盾。
//
// 另一些站点（runanytime 那类魔改）在签到前加一道工作量证明：先要一道题，
// 算出一个 nonce，再带着题目一起提交。这不是质询，能算，所以插件算
// （见 pow.mjs）；只有名单里的站点才会多问一次题目。
//
// Magpie 自己那个按账号的「每日签到」开关仍然决定这个钩子跑不跑。

import { ChallengeError, getCheckinStatus, getPowChallenge, postCheckin, challengeKind } from "./api.mjs";
import { PowError, isPowSite, solvePow } from "./pow.mjs";
import { formatQuota, quotaAsNumber, quotaInfo } from "./util.mjs";
import { t } from "./i18n.mjs";

/** 签到被质询拦下时的文案，键与 outcomes 的 captcha 对应。 */
const CAPTCHA_KEY = {
  cf: "This site asks for a Cloudflare challenge. Check in on its website.",
  turnstile: "This site asks for a captcha. Check in on its website.",
};

/** PoW 求解失败时的文案，按原因分。 */
const POW_MESSAGES = {
  timeout: "The site's proof of work did not finish in time. Check in on its website.",
  exhausted: "The site's proof of work could not be solved. Check in on its website.",
};

/** 之前见过质询时，钩子回答什么。 */
export function blockedResult(kind) {
  return {
    outcome: "captcha",
    message: t(CAPTCHA_KEY[kind] ?? CAPTCHA_KEY.cf),
  };
}

/**
 * 把质询变成钩子的回答。Cloudflare 的拦截页会被记下来
 * （调用方存它，第二天的请求就能少一次）；要求 Turnstile 令牌的不记，
 * 因为站点设置随时会变。
 */
function challengeResult(kind) {
  const message = t(CAPTCHA_KEY[kind] ?? CAPTCHA_KEY.cf);
  return kind === "cf" ? { outcome: "captcha", message, blocked: "cf" } : { outcome: "captcha", message };
}

/** 签到需要的账号要素：base、访问令牌、user id。 */
function partsOf(md) {
  return {
    base: String(md?.baseURL ?? md?.base ?? ""),
    token: String(md?.accessToken ?? md?.token ?? ""),
    userId: String(md?.userId ?? ""),
  };
}

/**
 * 这个站点签到要不要先算题，要的话把 `{ challengeId, nonce }` 解出来。
 *
 * 只有名单里的站点才去问题目：普通 New API 没有这个接口，每次都问一遍
 * 就是白花一个请求。取不到题目（站点去掉了门槛）就当没有。
 */
async function powFor(base, token, userId, opts, hosts) {
  if (!isPowSite(base, hosts)) return null;
  const challenge = await getPowChallenge(base, token, userId, opts);
  // 站点把这道门槛去掉了：接口不在，就当没有，照常签到。
  if (!challenge) return null;
  return { challengeId: challenge.challengeId, nonce: solvePow(challenge) };
}

/**
 * 按下签到：要算题就先算。
 *
 * 第一次提交可能因为题过期或被用过而失败——题是一次性的，而算题、等请求
 * 都可能把时间花掉。被站点说 PoW 不对就重新要一道题再试一次，绝不重放旧题；
 * 第二次还不行就如实报告，不会一直要题。
 */
async function pressWithPow(base, token, userId, path, opts) {
  const hosts = opts?.powHosts;
  const pow = await powFor(base, token, userId, opts, hosts);
  const result = await withTransportRetry(() =>
    postCheckin(base, token, userId, { ...opts, path, ...(pow ? { pow } : {}) }),
  );
  if (!pow || !powRefused(result)) return result;

  const again = await powFor(base, token, userId, opts, hosts);
  if (!again) return result;
  return withTransportRetry(() => postCheckin(base, token, userId, { ...opts, path, pow: again }));
}

/** 站点把这次签到算成 PoW 不通过（题过期、已被用过、难度不对）。 */
function powRefused(result) {
  return !result.success && /pow/i.test(String(result.message ?? ""));
}

/** 只读签到状态，不按下去。 */
export async function checkinState(md, opts = {}) {
  const { base, token, userId } = partsOf(md);
  return withTransportRetry(() => getCheckinStatus(base, token, userId, opts));
}

/**
 * 连接本身失败（status 0：掉线、DNS 抖动）时再读一次。
 * 站点自己说的「不行」绝不重试。
 */
async function withTransportRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.status !== 0) throw e;
    return fn();
  }
}

/**
 * 按下签到。返回 Magpie 要的签到结果；站点要求质询时额外带
 * `blocked: "cf"|"turnstile"`，让调用方去标记账号。
 */
export async function pressCheckin(md, opts = {}) {
  const { base, token, userId } = partsOf(md);
  if (!base || !token) return { outcome: "failed", message: t("not signed in") };

  const info = quotaInfo({
    quota_per_unit: md.status?.quotaPerUnit,
    display_in_currency: md.status?.currency,
    quota_display_type: md.status?.quotaDisplayType,
    custom_currency_symbol: md.status?.currencySymbol,
    custom_currency_exchange_rate: md.status?.currencyRate,
    usd_exchange_rate: md.status?.usdExchangeRate,
  });

  // 名单里的魔改站点：签到前要先解一道 PoW。
  const powSite = isPowSite(base, opts?.powHosts);

  let state;
  try {
    state = await checkinState(md, opts);
  } catch (e) {
    if (e instanceof ChallengeError) {
      return challengeResult(e.code);
    }
    const kind = challengeKind(e);
    if (kind) return challengeResult(kind);
    // 有的 PoW 站点只留了 POST 的签到，读不到状态。它本来就不靠状态决定
    // 签不签，所以照样按下去，让站点自己回答。
    if (!powSite) throw e;
    state = null;
  }
  if (state) {
    if (!state.enabled) {
      return { outcome: "inactive", message: t("Check-in is not enabled on this site") };
    }
    if (state.checkedInToday) {
      const credit = state.records?.[0]?.quota_awarded;
      return {
        outcome: "done",
        credit: credit ? quotaAsNumber(credit, info) : 0,
        message: credit
          ? t("Already checked in today · +{credit}", { credit: formatQuota(credit, info) })
          : t("Already checked in today"),
      };
    }
  }
  // 站点说它的签到需要 Turnstile 令牌：不带令牌按下去只会被拒，
  // 那就别花这个请求。只有 Cloudflare 拦截页会被记住：
  // 站点可能把 Turnstile 关掉，第二天读一次就知道了。
  if (md.status?.turnstile) {
    return { outcome: "captcha", message: t(CAPTCHA_KEY.turnstile) };
  }

  let result;
  try {
    result = await pressWithPow(base, token, userId, state?.path, opts);
  } catch (e) {
    if (e instanceof PowError) return { outcome: "failed", message: t(POW_MESSAGES[e.reason] ?? POW_MESSAGES.exhausted) };
    if (e instanceof ChallengeError) return challengeResult(e.code);
    const kind = challengeKind(e);
    if (kind) return challengeResult(kind);
    throw e;
  }

  if (result.success) {
    const awarded = Number(result.data?.quota_awarded) || 0;
    return {
      outcome: "claimed",
      credit: awarded ? quotaAsNumber(awarded, info) : 0,
      message: awarded ? t("Checked in · +{credit}", { credit: formatQuota(awarded, info) }) : t("Checked in"),
    };
  }

  const message = String(result.message ?? "").trim();
  if (/already checked in|今天已签到|已签到/i.test(message)) return { outcome: "done", message };
  if (/not enabled|disabled|未开启/i.test(message)) return { outcome: "inactive", message };
  // Turnstile 拒绝是站点自己的开关，不是新发现：如实报告，
  // 但不标记账号（理由见上面的状态检查）。
  if (/turnstile|captcha|verification failed|验证/i.test(message)) {
    return { outcome: "captcha", message: message || t(CAPTCHA_KEY.turnstile) };
  }
  return { outcome: "failed", message: message || t("check-in failed") };
}
