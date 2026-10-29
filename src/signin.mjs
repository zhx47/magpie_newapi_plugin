// Signing in: what happens when the user types a base URL and an access
// token.
//
// New API splits credentials in two: the dashboard access token (rights to
// /api/*) and per-group API keys (the `sk-...` a relay request carries).
// This hook collects both:
//   - the token, for the account's identity, balance and check-in;
//   - every group key it can find or reveal, plus whatever the user pasted.
//
// It never fails because a management endpoint is closed: a site whose
// /api/pricing is root-only still signs in, and its models come from
// /v1/models. It only fails when the access token itself is refused.

import {
  createToken,
  getStatus,
  getUserGroups,
  getUserSelf,
  getPricing,
  isAuthError,
  listTokens,
  revealTokenKeys,
  tokenUsable,
} from "./api.mjs";
import {
  cleanLabel,
  hashKey,
  hostOf,
  mergeGroupKeys,
  normalizeBase,
  parseGroupFilter,
  parseGroupKeys,
  sortGroups,
} from "./util.mjs";
import { readCachedKeys, writeCachedKeys } from "./state.mjs";

const PROVIDER = "newapi";

/** Validate the base URL prompt, in Magpie's prompt style (message or undefined). */
export function validateBase(value) {
  const base = normalizeBase(value);
  if (!base) return "Enter an http(s) URL, e.g. https://newapi.example.com";
  return undefined;
}

/** The access token prompt: a JWT or an opaque token, never an sk- key. */
export function validateAccessToken(value) {
  const s = String(value ?? "").trim();
  if (!s) return "Enter the site's access token (not an sk- API key)";
  if (/^sk-/i.test(s)) return "That is a relay API key. Use the access token from the site's account settings.";
  return undefined;
}

/** Every token usable for relay, grouped by the group it serves. */
export function tokensByGroup(tokens, defaultGroupName) {
  const out = {};
  for (const t of tokens) {
    if (!tokenUsable(t)) continue;
    const group = t.group || defaultGroupName || "default";
    (out[group] ??= []).push(t);
  }
  return out;
}

function keyInfoOf(tokens, revealed) {
  const info = {};
  for (const t of tokens) {
    const key = revealed.get(t.id);
    if (!key) continue;
    info[hashKey(key)] = {
      exp: t.expiredTime,
      models: t.modelLimitsEnabled
        ? String(t.modelLimits ?? "")
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    };
  }
  return info;
}

/** Whether a token has a content-significant title to find again by name. */
function tokenName(label, group, stamp) {
  const safe = String(group).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 20);
  return `magpie-${cleanLabel(label, "site")}-${safe}-${stamp}`.slice(0, 50);
}

/**
 * Create tokens for the groups that have none, then find and reveal them.
 * Best effort: whatever fails stays missing and is reported to the user.
 */
export async function ensureKeys({ base, token, userId, label, groups, fetchImpl, max = 5 }) {
  const created = {};
  const wanted = sortGroups(groups ?? []);
  if (!wanted.length) return created;

  for (const group of wanted.slice(0, max)) {
    const stamp = Date.now().toString(36).slice(-5);
    const name = tokenName(label, group, stamp);
    try {
      await createToken(base, token, userId, group, name, { fetchImpl });
    } catch {
      continue;
    }
    try {
      const tokens = await listTokens(base, token, userId, { fetchImpl });
      const mine = tokens
        .filter((t) => t.name === name && t.group === group)
        .sort((a, b) => b.id - a.id)[0];
      if (!mine) continue;
      const revealed = await revealTokenKeys(base, token, userId, [mine.id], { fetchImpl });
      const key = revealed.get(mine.id);
      if (key) created[group] = [key];
    } catch {
      // the token exists but its key is not readable: the user pastes it
    }
  }
  return created;
}

/**
 * The whole sign-in. `directory` is Magpie's config dir, where the key
 * cache lives; `client` is only used by later hooks, not here.
 */
export async function signIn(inputs, { directory, fetchImpl } = {}) {
  const base = normalizeBase(inputs?.baseURL);
  const token = String(inputs?.accessToken ?? "").trim();
  if (!base) return { type: "failed", error: "Enter the site's base URL, e.g. https://newapi.example.com" };
  if (!token) return { type: "failed", error: "Enter the site's access token (not an sk- API key)" };

  const userId = String(inputs?.userId ?? "").trim();

  let status = null;
  try {
    status = await getStatus(base, { fetchImpl, timeout: 8000 });
  } catch {
    // status is decoration: a site that hides it still works
  }

  let self;
  let unreachable = false;
  try {
    self = await getUserSelf(base, token, userId, { fetchImpl });
  } catch (e) {
    if (isAuthError(e)) {
      return {
        type: "failed",
        error: userId
          ? `The site refused the access token (${describe(e)}). Check the token, and the user id.`
          : `The site refused the access token (${describe(e)}). Older New API needs your user id — fill the User id field.`,
      };
    }
    // A network blip must not lose the sign-in: keep what the user typed and
    // let the next listing fail loudly instead. A site that cannot be reached
    // at all is different — nothing about the token was checked, so say so
    // rather than sign in to nothing.
    unreachable = e?.status === 0;
    self = { id: Number(userId) || 0, username: "", group: "", quota: 0, usedQuota: 0, requestCount: 0 };
  }

  const label = cleanLabel(inputs?.siteLabel, hostOf(base));
  const accountId = `${label} (${self.username || self.id || userId || "user"})`;
  const filter = parseGroupFilter(inputs?.groupFilter);

  let groups = {};
  try {
    groups = await getUserGroups(base, token, userId, { fetchImpl });
  } catch {
    groups = {};
  }

  let pricing = null;
  try {
    pricing = await getPricing(base, token, userId, { fetchImpl });
  } catch {
    pricing = null;
  }

  let tokens = [];
  try {
    tokens = await listTokens(base, token, userId, { fetchImpl });
  } catch {
    tokens = [];
  }

  const byGroup = tokensByGroup(tokens, self.group);
  let revealed = new Map();
  try {
    const ids = Object.values(byGroup).flat().map((t) => t.id);
    revealed = await revealTokenKeys(base, token, userId, ids, { fetchImpl });
  } catch {
    revealed = new Map();
  }

  const fromTokens = {};
  for (const [group, list] of Object.entries(byGroup)) {
    for (const t of list) {
      const key = revealed.get(t.id);
      if (key) (fromTokens[group] ??= []).push(key);
    }
  }

  const manual = parseGroupKeys(inputs?.groupKeys);
  const cached = directory ? readCachedKeys(directory, base, self.id || userId, self.username) : { groupKeys: {} };
  let groupKeys = mergeGroupKeys(cached.groupKeys, fromTokens, manual);

  // Groups the site lists but Magpie has no key for. A filter names the
  // groups the user wants; a key for a group outside it is left out with
  // the rest, so the account holds only what was asked for.
  if (filter.length) {
    for (const group of Object.keys(groupKeys)) {
      if (!filter.includes(group)) delete groupKeys[group];
    }
  }
  // The groups the site knows: /api/user/self/groups when it answered, plus
  // the ones the token list and the pasted keys name. A site whose group
  // endpoint hiccupped still reports what it can, rather than "none".
  const known = new Set([
    ...Object.keys(groups ?? {}),
    ...Object.keys(byGroup ?? {}),
    ...Object.keys(groupKeys),
  ]);
  const siteGroups = filter.length ? [...known].filter((g) => filter.includes(g)) : [...known];
  let pending = sortGroups(siteGroups.filter((g) => !groupKeys[g]?.length));

  if (pending.length && inputs?.autoCreate === "yes") {
    const created = await ensureKeys({
      base,
      token,
      userId,
      label,
      groups: pending,
      fetchImpl,
    });
    if (Object.keys(created).length) {
      groupKeys = mergeGroupKeys(groupKeys, created);
      pending = sortGroups(siteGroups.filter((g) => !groupKeys[g]?.length));
    }
  }

  // Nothing could be reached and nothing was pasted: this is not a sign-in.
  if (unreachable && !Object.keys(groupKeys).length) {
    return {
      type: "failed",
      error: `Could not reach ${base}. Check the URL and the network, then sign in again.`,
    };
  }

  if (directory) writeCachedKeys(directory, base, self.id || userId, self.username, groupKeys);

  const keyInfo = keyInfoOf(tokens, revealed);
  const checkinOn = inputs?.checkin !== "off";

  return {
    type: "success",
    key: token,
    metadata: {
      accountId,
      email: accountId, // host.js's whoOf() reads this for account identity
      baseURL: base,
      userId: self.id || Number(userId) || undefined,
      username: self.username || "",
      siteLabel: label,
      defaultGroup: self.group || Object.keys(groupKeys)[0] || "default",
      groupFilter: filter.join(","),
      groups,
      groupKeys,
      keyInfo,
      pendingGroups: pending,
      checkin: checkinOn ? "auto" : "off",
      checkinBlocked: "",
      status: {
        quotaPerUnit: status?.quotaPerUnit ?? 500000,
        currency: status?.displayInCurrency ?? true,
        quotaDisplayType: status?.quotaDisplayType ?? "",
        currencySymbol: status?.customCurrencySymbol ?? "",
        currencyRate: status?.customCurrencyExchangeRate ?? 1,
        usdExchangeRate: status?.usdExchangeRate ?? 1,
        checkin: status?.checkinEnabled ?? false,
        turnstile: status?.turnstile ?? false,
        systemName: status?.systemName ?? "",
        version: status?.version ?? "",
      },
      pricingVersion: pricing?.pricingVersion ?? "",
      updatedAt: new Date().toISOString(),
    },
  };
}

function describe(e) {
  const message = String(e?.message ?? e ?? "").trim();
  return message.length > 160 ? `${message.slice(0, 160)}…` : message || "no reason given";
}

export { PROVIDER };
