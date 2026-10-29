// Signing in: what happens when the user types a base URL and an access
// token.
//
// New API splits credentials in two: the dashboard access token (rights to
// /api/*) and per-group API keys (the `sk-...` a relay request carries).
// This hook collects both:
//   - the token, for the account's identity, balance and check-in;
//   - every group key it can find or reveal;
//   - then, group by group, whatever is still missing, one question each.
//
// The questions are Magpie's `ask(inputs)` hook on the method: it may look
// things up between questions, so the groups can be read from the site
// first and each one asked by name instead of one text field to splice.
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
  isMaskedKey,
  mergeGroupKeys,
  normalizeApiKey,
  normalizeBase,
  parseGroupFilter,
  parseGroupKeys,
  sortGroups,
} from "./util.mjs";
import { TtlCache, cacheKey, readCachedKeys, readCachedKeysForSite, writeCachedKeys } from "./state.mjs";

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

/** A token name to find a created token again by. */
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

// The questions run one per call, and each needs the site's groups: without
// this, a sign-in with three missing groups read six endpoints four times.
const surveys = new TtlCache(60_000);

/** What the first calls found out: used by the questions and the result alike. */
async function surveyOnce(inputs, fetchImpl) {
  const base = normalizeBase(inputs?.baseURL);
  const token = String(inputs?.accessToken ?? "").trim();
  const userId = String(inputs?.userId ?? "").trim();
  if (!base) return { failed: "Enter the site's base URL, e.g. https://newapi.example.com" };
  if (!token) return { failed: "Enter the site's access token (not an sk- API key)" };

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
        failed: userId
          ? `The site refused the access token (${describe(e)}). Check the token, and the user id.`
          : `The site refused the access token (${describe(e)}). Older New API needs your user id — fill the User id field.`,
      };
    }
    // A network blip must not lose the sign-in: keep what the user typed and
    // let the next listing fail loudly instead. A site that cannot be reached
    // at all is different: nothing about the token was checked.
    unreachable = e?.status === 0;
    self = { id: Number(userId) || 0, username: "", group: "", quota: 0, usedQuota: 0, requestCount: 0 };
  }

  const [groups, pricing, tokens] = await Promise.all([
    getUserGroups(base, token, userId, { fetchImpl }).catch(() => ({})),
    getPricing(base, token, userId, { fetchImpl }).catch(() => null),
    listTokens(base, token, userId, { fetchImpl }).catch(() => []),
  ]);

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

  return { base, token, userId, status, self, unreachable, groups, pricing, tokens, revealed, byGroup, fromTokens };
}

/** survey, kept for a minute under the answers it was made from. */
function survey(inputs, fetchImpl) {
  const base = normalizeBase(inputs?.baseURL);
  const token = String(inputs?.accessToken ?? "").trim();
  if (!base || !token) return surveyOnce(inputs, fetchImpl);
  const key = cacheKey(base, "signin", token, String(inputs?.userId ?? ""));
  return surveys.getOr(key, 60_000, () => surveyOnce(inputs, fetchImpl));
}

/** The groups a site serves that still need a key, in the order they are asked. */
function pendingGroupsOf(found, inputs, cachedKeys) {
  const filter = parseGroupFilter(inputs?.groupFilter);
  const known = new Set([
    ...Object.keys(found.groups ?? {}),
    ...Object.keys(found.byGroup ?? {}),
    ...Object.keys(cachedKeys),
    ...Object.keys(parseGroupKeys(inputs?.groupKeys)),
  ]);
  const wanted = filter.length ? [...known].filter((g) => filter.includes(g)) : [...known];
  const have = mergeGroupKeys(cachedKeys, found.fromTokens, parseGroupKeys(inputs?.groupKeys));
  return sortGroups(wanted.filter((g) => !have[g]?.length));
}

/**
 * The questions after the first three, as Magpie asks them one at a time.
 * Each missing group is its own field, titled with its name; asking again
 * asks the one after it, since a question answered is passed back in.
 */
export async function nextQuestion(inputs, { directory, fetchImpl } = {}) {
  // The first questions need no lookup.
  if (!inputs?.baseURL) return prompt("baseURL");
  if (!inputs?.accessToken) return prompt("accessToken");
  if (inputs?.userId === undefined) return prompt("userId");
  if (inputs?.siteLabel === undefined) return prompt("siteLabel");

  const found = await survey(inputs, fetchImpl);
  if (found.failed) {
    // A bad token: ask it again rather than going on to questions that
    // cannot be answered without one.
    return { ...prompt("accessToken"), message: `${found.failed}\nAccess token` };
  }

  const cached = directory
    ? readCachedKeys(directory, found.base, found.self.id || found.userId, found.self.username)
    : { groupKeys: {} };
  const siteCached = directory ? readCachedKeysForSite(directory, found.base) : {};
  let pending = pendingGroupsOf(found, inputs, mergeGroupKeys(siteCached, cached.groupKeys));
  const autoCreate = inputs?.autoCreate === "yes";
  const allGroups = Object.keys(found.groups ?? {}).length || Object.keys(found.byGroup ?? {}).length;

  // A site with a handful of groups needs no filter question; one with many
  // does, or every group is a model namespace in the picker.
  if (allGroups > 6 && inputs?.groupFilter === undefined) {
    return {
      type: "text",
      key: "groupFilter",
      message: `Only some groups? This site has ${allGroups} (comma separated; empty means all)`,
      placeholder: [...Object.keys(found.groups ?? {})].slice(0, 4).join(","),
    };
  }

  if (pending.length && !autoCreate) {
    // One group at a time. The answer is kept under groupkey:<group>, so a
    // group already answered is not asked again and the next one follows.
    for (const group of pending) {
      const at = inputKey(group);
      if (typeof inputs?.[at] === "string") continue;
      return {
        type: "password",
        key: at,
        message: `API key for group "${group}"`,
        placeholder: "sk-... (leave empty to skip this group)",
      };
    }
  }

  if (inputs?.checkin === undefined) return prompt("checkin");
  if (inputs?.autoCreate === undefined) {
    return {
      type: "select",
      key: "autoCreate",
      message: pending.length
        ? `Create API tokens on the site for ${pending.length} group${pending.length === 1 ? "" : "s"} without a key?`
        : "Create API tokens on the site when a group has no key?",
      options: [
        { label: "No, skip them", value: "no" },
        { label: "Yes, create a token for each", value: "yes" },
      ],
    };
  }
  return null;
}

const FIRST_PROMPTS = {
  baseURL: {
    type: "text",
    key: "baseURL",
    message: "New API base URL",
    placeholder: "https://newapi.example.com",
    validate: validateBase,
  },
  accessToken: {
    type: "password",
    key: "accessToken",
    message: "Access token",
    placeholder: "the site's access token (not an sk- key)",
    validate: validateAccessToken,
  },
  userId: {
    type: "text",
    key: "userId",
    message: "User id (old New API only; leave empty)",
    placeholder: "1",
  },
  siteLabel: {
    type: "text",
    key: "siteLabel",
    message: "Site label (the model prefix; empty uses the host)",
    placeholder: "example",
  },
  checkin: {
    type: "select",
    key: "checkin",
    message: "Daily check-in",
    options: [
      { label: "Automatic", value: "auto" },
      { label: "Off (check in on the site yourself)", value: "off" },
    ],
  },
};

function prompt(key) {
  return { ...FIRST_PROMPTS[key] };
}

/** The input key a group's pasted key is kept under. */
export function inputKey(group) {
  return `groupkey:${group}`;
}

/** The keys pasted in the per-group questions, as groupKeys. */
export function pastedKeys(inputs) {
  const out = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (!key.startsWith("groupkey:")) continue;
    const group = key.slice("groupkey:".length);
    const k = normalizeApiKey(value);
    if (group && k && !isMaskedKey(k)) out[group] = [k];
  }
  return out;
}

/**
 * The whole sign-in. `directory` is Magpie's config dir, where the key
 * cache lives.
 */
export async function signIn(inputs, { directory, fetchImpl } = {}) {
  const found = await survey(inputs, fetchImpl);
  if (found.failed) return { type: "failed", error: found.failed };
  const { base, token, userId, status, self, unreachable, groups, pricing, tokens, revealed, byGroup, fromTokens } = found;

  const label = cleanLabel(inputs?.siteLabel, hostOf(base));
  const accountId = `${label} (${self.username || self.id || userId || "user"})`;
  const filter = parseGroupFilter(inputs?.groupFilter);

  // Keys pasted one group at a time are the freshest, so they win over a
  // cache; the older free-form field still works for anyone used to it.
  const manual = mergeGroupKeys(parseGroupKeys(inputs?.groupKeys), pastedKeys(inputs));
  const cached = directory ? readCachedKeys(directory, base, self.id || userId, self.username) : { groupKeys: {} };
  let groupKeys = mergeGroupKeys(cached.groupKeys, fromTokens, manual);

  // A filter names the groups the user wants; a key for a group outside it
  // is left out with the rest, so the account holds only what was asked for.
  if (filter.length) {
    for (const group of Object.keys(groupKeys)) {
      if (!filter.includes(group)) delete groupKeys[group];
    }
  }

  const known = new Set([
    ...Object.keys(groups ?? {}),
    ...Object.keys(byGroup ?? {}),
    ...Object.keys(groupKeys),
  ]);
  const siteGroups = filter.length ? [...known].filter((g) => filter.includes(g)) : [...known];
  let pending = sortGroups(siteGroups.filter((g) => !groupKeys[g]?.length));

  const autoCreate = inputs?.autoCreate === "yes";
  if (pending.length && autoCreate) {
    const created = await ensureKeys({ base, token, userId, label, groups: pending, fetchImpl });
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

  // Kept even when a group is still missing: a second sign-in picks up here.
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
      displayName: self.displayName || "",
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
