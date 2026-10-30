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
// runanytime.hxi.me 是特例：它在签到前加了一道工作量证明，而且它的
// 状态接口和 /api/status 都挂着 Turnstile。带访问令牌的签到本身是通的
// （解完题就成），所以那个站点不读状态、不看 Turnstile，直接取题、算题、
// 提交（见 runanytime.mjs 与下面的 pressRunAnyTime）。
//
// Magpie 自己那个按账号的「每日签到」开关仍然决定这个钩子跑不跑。

import { ChallengeError, getCheckinStatus, getPowChallenge, postCheckin, challengeKind } from "./api.mjs";
import { PowError, isRunAnyTimeSite, solveChallenge } from "./runanytime.mjs";
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

/** 账号 metadata 里的显示设置，用来把额度换算成用户看到的数字。 */
function infoOf(md) {
  return quotaInfo({
    quota_per_unit: md.status?.quotaPerUnit,
    display_in_currency: md.status?.currency,
    quota_display_type: md.status?.quotaDisplayType,
    custom_currency_symbol: md.status?.currencySymbol,
    custom_currency_exchange_rate: md.status?.currencyRate,
    usd_exchange_rate: md.status?.usdExchangeRate,
  });
}

/**
 * 站点的题目算出来的东西：`{ challengeId, nonce }`。
 * 站点没有这道门槛（接口不在）就是 null。
 */
async function powFor(base, token, userId, opts) {
  const challenge = await getPowChallenge(base, token, userId, opts);
  if (!challenge) return null;
  return { challengeId: challenge.challengeId, nonce: solveChallenge(challenge) };
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

  const info = infoOf(md);

  // runanytime 那类站点：不读状态、不看 Turnstile。它的状态接口和
  // /api/status 都挂着 Turnstile，读了只会得到「去 App 里签到」，
  // 而带访问令牌的 PoW 签到本身是通的。
  if (isRunAnyTimeSite(base, opts?.specialHosts)) {
    return pressRunAnyTime(base, token, userId, info, opts);
  }

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
    result = await withTransportRetry(() => postCheckin(base, token, userId, { ...opts, path: state?.path }));
  } catch (e) {
    if (e instanceof ChallengeError) return challengeResult(e.code);
    const kind = challengeKind(e);
    if (kind) return challengeResult(kind);
    throw e;
  }
  return answerOf(result, info);
}

/**
 * runanytime.hxi.me 的签到：取题 → 算题 → 提交，不读状态。
 *
 * 不读状态是有意的：这个站点的状态接口和 /api/status 都挂着 Turnstile，
 * 读到的只会是「该去 App 里签到」，而带访问令牌的 PoW 签到本身是通的。
 *
 * 提交的路径交给通用的那条顺序（新的在前，404 再试旧的）：这个站点的
 * 两种布局都见过。第一次提交可能因为题过期或被用过而失败——题是一次性
 * 的，而算题、等请求都可能把时间花掉。被站点说 PoW 不对就重新要一道题
 * 再试一次，绝不重放旧题；第二次还不行就如实报告，不会一直要题。
 *
 * 站点把这道门槛去掉了（题目接口 404）就照常提交，和别的站点一样。
 */
async function pressRunAnyTime(base, token, userId, info, opts) {
  try {
    const pow = await powFor(base, token, userId, opts);
    // 路径交给通用顺序：这个站点的两种布局都见过。
    let result = await withTransportRetry(() => postCheckin(base, token, userId, { ...opts, ...(pow ? { pow } : {}) }));
    if (pow && powRefused(result)) {
      const again = await powFor(base, token, userId, opts);
      if (again) {
        result = await withTransportRetry(() => postCheckin(base, token, userId, { ...opts, pow: again }));
      }
    }
    return answerOf(result, info);
  } catch (e) {
    if (e instanceof PowError) return { outcome: "failed", message: t(POW_MESSAGES[e.reason] ?? POW_MESSAGES.exhausted) };
    if (e instanceof ChallengeError) return challengeResult(e.code);
    const kind = challengeKind(e);
    if (kind) return challengeResult(kind);
    throw e;
  }
}

/**
 * 站点的签到回答 → Magpie 的 outcome。
 *
 * 成功就是 claimed/done；「今天已经签过」「签到没开」这两种是站点在
 * 说状态，不是失败；Turnstile 拒绝如实报告，但不标记账号。
 */
function answerOf(result, info) {
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
  if (/turnstile|captcha|verification failed|验证/i.test(message)) {
    return { outcome: "captcha", message: message || t(CAPTCHA_KEY.turnstile) };
  }
  return { outcome: "failed", message: message || t("check-in failed") };
}
