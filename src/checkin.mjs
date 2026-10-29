// The daily check-in, and the switches around it.
//
// Some New API sites protect their check-in endpoint with Cloudflare
// Turnstile or a managed challenge. An access token does not get past
// those: they need a browser. The plugin therefore:
//   - lets each site turn automatic check-in off at sign-in (`checkin=off`);
//   - detects a challenge and marks the account, so later days return
//     `captcha` without spending a request;
//   - never solves or bypasses a challenge.
// Magpie's own per-account "Daily check-in" switch still governs whether
// the hook runs at all.

import { ChallengeError, getCheckinStatus, postCheckin, challengeKind } from "./api.mjs";
import { formatQuota, quotaAsNumber, quotaInfo } from "./util.mjs";

const CAPTCHA_MESSAGE = {
  cf: "This site asks for a Cloudflare challenge. Check in on its website.",
  turnstile: "This site asks for a captcha. Check in on its website.",
};

/** What the hook says when auto check-in is off for the site. */
export function offResult() {
  return {
    outcome: "inactive",
    message: "Auto check-in is off for this site. Check in on the site itself.",
  };
}

/** What the hook says when a challenge was seen before. */
export function blockedResult(kind) {
  return {
    outcome: "captcha",
    message: CAPTCHA_MESSAGE[kind] ?? CAPTCHA_MESSAGE.cf,
  };
}

/**
 * A challenge as the hook's answer. Cloudflare's blocking page is marked (the
 * caller stores it, so the next day costs one request less); a Turnstile
 * token requirement is not, since a site setting can change.
 */
function challengeResult(kind) {
  const message = CAPTCHA_MESSAGE[kind] ?? CAPTCHA_MESSAGE.cf;
  return kind === "cf" ? { outcome: "captcha", message, blocked: "cf" } : { outcome: "captcha", message };
}

/** The account parts the check-in needs: base, access token and user id. */
function partsOf(md) {
  return {
    base: String(md?.baseURL ?? md?.base ?? ""),
    token: String(md?.accessToken ?? md?.token ?? ""),
    userId: String(md?.userId ?? ""),
  };
}

/** Read the check-in state without pressing it. */
export async function checkinState(md, opts = {}) {
  const { base, token, userId } = partsOf(md);
  return withTransportRetry(() => getCheckinStatus(base, token, userId, opts));
}

/**
 * Re-run a read that failed because the connection itself failed (status 0:
 * a dropped socket, a DNS blip). A site's own "no" is never retried.
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
 * Press the check-in. Returns the Magpie check-in result plus, when the
 * site asked for a challenge, `blocked: "cf"|"turnstile"` so the caller can
 * mark the account.
 */
export async function pressCheckin(md, opts = {}) {
  const { base, token, userId } = partsOf(md);
  if (!base || !token) return { outcome: "failed", message: "not signed in" };

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
      return { outcome: "captcha", message: CAPTCHA_MESSAGE[e.code] ?? CAPTCHA_MESSAGE.cf, blocked: e.code };
    }
    const kind = challengeKind(e);
    if (kind) return { outcome: "captcha", message: CAPTCHA_MESSAGE[kind], blocked: kind };
    throw e;
  }
  if (!state.enabled) {
    return { outcome: "inactive", message: "Check-in is not enabled on this site" };
  }
  if (state.checkedInToday) {
    const credit = state.records?.[0]?.quota_awarded;
    return {
      outcome: "done",
      credit: credit ? quotaAsNumber(credit, info) : 0,
      message: credit ? `Already checked in today · +${formatQuota(credit, info)}` : "Already checked in today",
    };
  }
  // The site says its check-in wants a Turnstile token: pressing it without
  // one can only be refused, so don't spend the request. Only a Cloudflare
  // challenge (a blocking page) is remembered: a site can turn Turnstile off,
  // and the next day's read sees that.
  if (md.status?.turnstile) {
    return { outcome: "captcha", message: CAPTCHA_MESSAGE.turnstile };
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
      message: awarded ? `Checked in · +${formatQuota(awarded, info)}` : "Checked in",
    };
  }

  const message = String(result.message ?? "").trim();
  if (/already checked in|今天已签到|已签到/i.test(message)) return { outcome: "done", message };
  if (/not enabled|disabled|未开启/i.test(message)) return { outcome: "inactive", message };
  // A Turnstile refusal is the site's switch, not a new discovery: report it
  // without marking the account (see the status check above).
  if (/turnstile|captcha|verification failed|验证/i.test(message)) {
    return { outcome: "captcha", message: message || CAPTCHA_MESSAGE.turnstile };
  }
  return { outcome: "failed", message: message || "check-in failed" };
}
