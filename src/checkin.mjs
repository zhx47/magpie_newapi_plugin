// 每日签到，以及围绕它的开关。
//
// 有些 New API 站点给签到接口加了 Cloudflare Turnstile 或托管质询。
// 访问令牌过不去——那需要浏览器。所以插件：
//   - 允许登录时给每个站点关掉自动签到（`checkin=off`）；
//   - 检测到质询就把账号标出来，之后的日子直接返回 `captcha`，
//     不再白花请求；
//   - 绝不破解或绕过任何质询。
// Magpie 自己那个按账号的「每日签到」开关仍然决定这个钩子跑不跑。

import { ChallengeError, getCheckinStatus, postCheckin, challengeKind } from "./api.mjs";
import { formatQuota, quotaAsNumber, quotaInfo } from "./util.mjs";
import { t } from "./i18n.mjs";

/** 签到被质询拦下时的文案，键与 outcomes 的 captcha 对应。 */
const CAPTCHA_KEY = {
  cf: "This site asks for a Cloudflare challenge. Check in on its website.",
  turnstile: "This site asks for a captcha. Check in on its website.",
};

/** 站点关掉了自动签到时，钩子回答什么。 */
export function offResult() {
  return {
    outcome: "inactive",
    message: t("Auto check-in is off for this site. Check in on the site itself."),
  };
}

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

  let state;
  try {
    state = await checkinState(md, opts);
  } catch (e) {
    if (e instanceof ChallengeError) {
      return challengeResult(e.code);
    }
    const kind = challengeKind(e);
    if (kind) return challengeResult(kind);
    throw e;
  }
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
  // 站点说它的签到需要 Turnstile 令牌：不带令牌按下去只会被拒，
  // 那就别花这个请求。只有 Cloudflare 拦截页会被记住：
  // 站点可能把 Turnstile 关掉，第二天读一次就知道了。
  if (md.status?.turnstile) {
    return { outcome: "captcha", message: t(CAPTCHA_KEY.turnstile) };
  }

  let result;
  try {
    result = await withTransportRetry(() => postCheckin(base, token, userId, { ...opts, path: state.path }));
  } catch (e) {
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
