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
  normalizeApiKey,
  normalizeBase,
  parseGroupFilter,
  parseGroupKeys,
  sortGroups,
} from "./util.mjs";
import { TtlCache, cacheKey, groupsOf, knownAccounts } from "./state.mjs";
import { checkKey, createKey } from "./sync.mjs";

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
/** A token name to find a created token again by. */
function tokenName(label, group, stamp) {
  const safe = String(group).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 20);
  return `magpie-${cleanLabel(label, "site")}-${safe}-${stamp}`.slice(0, 50);
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

  // The newest usable token of each group, with its key when readable.
  const fromTokens = {};
  for (const [group, list] of Object.entries(byGroup)) {
    const newest = [...list].sort((a, b) => b.id - a.id)[0];
    const key = newest ? revealed.get(newest.id) : "";
    if (key) fromTokens[group] = key;
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

/**
 * The keys a sign-in has so far, as one map of group → key: what the site
 * handed over, what a creation step made, what the user pasted, and — for a
 * picked account — the keys it already held.
 */
export function keysSoFar(found, inputs, picked) {
  const out = { ...found.fromTokens };

  const fromPick = {};
  if (picked) {
    for (const [group, g] of Object.entries(groupsOf(picked.metadata))) {
      if (g.key && !g.problem) fromPick[group] = g.key;
    }
  }
  const pasted = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (!key.startsWith("groupkey:")) continue;
    const group = key.slice("groupkey:".length);
    const k = normalizeApiKey(value);
    if (group && k && !isMaskedKey(k)) pasted[group] = k;
  }
  const legacy = {};
  for (const [group, value] of Object.entries(parseGroupKeys(inputs?.groupKeys))) {
    const k = normalizeApiKey(Array.isArray(value) ? value[0] : value);
    if (k) legacy[group] = k;
  }

  // Later sources win: a key typed by hand beats one the site offered.
  for (const src of [fromPick, createdKeys(inputs), pasted, legacy]) {
    for (const [group, key] of Object.entries(src)) {
      if (key) out[group] = key;
    }
  }
  return out;
}

/** The groups a site serves that still need a key, in the order they are asked. */
function pendingGroupsOf(found, inputs, keys) {
  const filter = parseGroupFilter(inputs?.groupFilter);
  const names = Object.keys(found.groups ?? {});
  const wanted = filter.length ? names.filter((g) => filter.includes(g)) : names;
  return sortGroups(wanted.filter((g) => !keys[g]));
}

/**
 * The questions after the first three, as Magpie asks them one at a time.
 * Each missing group is its own field, titled with its name; asking again
 * asks the one after it, since a question answered is passed back in.
 */
export async function nextQuestion(inputs, { directory, fetchImpl } = {}) {
  // An account Magpie already holds needs no token typed from memory: the
  // first question offers the sites this plugin is signed in to, and picking
  // one answers the base URL, the token, the user id and the label at once.
  inputs = resolvePick(inputs, directory);
  if (!inputs?.baseURL && inputs?.pick === undefined) {
    const known = knownAccounts(directory);
    if (known.length) {
      return {
        type: "select",
        key: "pick",
        message: "Which account? Picking one reuses the access token Magpie already has.",
        options: [
          ...known.map((a) => ({
            label: `${a.accountId} — ${a.base.replace(/^https?:\/\//, "")}`,
            value: a.key,
            hint: `${a.groups.length} group${a.groups.length === 1 ? "" : "s"} · ${a.checkin === "off" ? "check-in off" : "check-in on"}`,
          })),
          { label: "Another site (paste its access token)", value: NEW_SITE },
        ],
      };
    }
  }

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

  const picked = knownAccounts(directory).find((a) => a.key === inputs?.pick);
  let pending = pendingGroupsOf(found, inputs, keysSoFar(found, inputs, picked));
  const autoCreate = inputs?.autoCreate;
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

  // Creation comes first: a token the site makes needs no typing, so only
  // what it cannot produce should be asked for by hand.
  if (pending.length && autoCreate === undefined) {
    const names = pending.join(", ");
    return {
      type: "select",
      key: "autoCreate",
      message:
        `${pending.length} group${pending.length === 1 ? "" : "s"} without a key (${names}). ` +
        "Let the site create one for each?",
      options: [
        { label: "Yes, create a token for each", value: "yes" },
        { label: "No, I will paste them", value: "no" },
      ],
    };
  }

  // Creating takes a request per group, so it happens once: the answer says
  // what came of it, and the next call reads that from `createdKeys`.
  if (pending.length && autoCreate === "yes" && typeof inputs?.[CREATED] !== "string") {
    const created = {};
    const made = [];
    for (const group of pending) {
      const key = await createKey({
        base: found.base,
        token: found.token,
        userId: found.userId,
        label: cleanLabel(inputs?.siteLabel, hostOf(found.base)),
        group,
        tokens: found.tokens ?? [],
        fetchImpl,
      }).catch(() => undefined);
      if (key) {
        created[group] = key;
        made.push(group);
      }
    }
    const failed = pending.filter((g) => !created[g]);
    const said = made.length ? `Created a key for ${made.join(", ")}.` : "The site created no key.";
    const left = failed.length
      ? ` ${failed.join(", ")} still need${failed.length === 1 ? "s" : ""} one pasted by hand: the site would not give it up.`
      : "";
    return {
      type: "select",
      key: CREATED,
      message: `${said}${left}`,
      options: [{ label: left ? "Paste them" : "Continue", value: JSON.stringify(created) }],
    };
  }

  // What the site would not produce, one group at a time. The answer is kept
  // under groupkey:<group>, so a group already answered is not asked again.
  if (autoCreate !== "yes" || pending.length) {
    for (const group of pending) {
      const at = inputKey(group);
      if (typeof inputs?.[at] === "string") continue;

      // A key typed on an earlier pass is checked before the next question:
      // the site is the only thing that can say whether it works, and a
      // refused one is asked again rather than carried into the account.
      for (const [key, value] of Object.entries(inputs ?? {})) {
        if (!key.startsWith("groupkey:") || !value) continue;
        const forGroup = key.slice("groupkey:".length);
        const verdict = await checkKey(found.base, forGroup, value, { fetchImpl });
        if (verdict.ok || verdict.transient) continue;
        return {
          type: "password",
          key,
          message: `API key for group "${forGroup}" — ${verdict.why}`,
          placeholder: "paste another key, or leave empty to skip this group",
        };
      }

      return {
        type: "password",
        key: at,
        message: `API key for group "${group}"`,
        placeholder: "sk-... (leave empty to skip this group)",
      };
    }
  }

  if (inputs?.checkin === undefined) return prompt("checkin");
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

/** Where the answer to "let the site create the keys" keeps what it made. */
export const CREATED = "createdKeys";

/** The pick answer that means "a site this plugin has not been signed in to". */
export const NEW_SITE = "__new__";

/**
 * The answers a picked account supplies: its base, its token and its
 * label, as the sign-in Magpie holds has them. An answer the user typed
 * wins, so a picked account can still be pointed at another token.
 */
export function resolvePick(inputs, directory) {
  const pick = inputs?.pick;
  if (!pick || pick === NEW_SITE) return inputs;
  const known = knownAccounts(directory).find((a) => a.key === pick);
  if (!known) return inputs;
  return {
    ...inputs,
    baseURL: inputs.baseURL || known.base,
    accessToken: inputs.accessToken || known.accessToken,
    userId: inputs.userId ?? known.userId,
    siteLabel: inputs.siteLabel || known.siteLabel,
  };
}

/** What the "let the site create them" step made: group → key. */
export function createdKeys(inputs) {
  const raw = inputs?.[CREATED];
  if (typeof raw !== "string" || !raw) return {};
  try {
    const made = JSON.parse(raw);
    const out = {};
    for (const [group, value] of Object.entries(made ?? {})) {
      const k = normalizeApiKey(Array.isArray(value) ? value[0] : value);
      if (k && !isMaskedKey(k)) out[group] = k;
    }
    return out;
  } catch {
    return {};
  }
}

/** The keys pasted in the per-group questions: group → key. */
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
export async function signIn(rawInputs, { directory, fetchImpl } = {}) {
  const inputs = resolvePick(rawInputs, directory);
  const found = await survey(inputs, fetchImpl);
  if (found.failed) return { type: "failed", error: found.failed };
  const { base, token, userId, status, self, unreachable, groups, pricing, tokens } = found;

  const label = cleanLabel(inputs?.siteLabel, hostOf(base));
  const accountId = `${label} (${self.username || self.id || userId || "user"})`;
  const filter = parseGroupFilter(inputs?.groupFilter);
  const picked = knownAccounts(directory).find((a) => a.key === inputs?.pick);

  const keys = keysSoFar(found, inputs, picked);

  // A filter names the groups the user wants; a key for a group outside it is
  // left out with the rest, so the account holds only what was asked for.
  if (filter.length) {
    for (const group of Object.keys(keys)) {
      if (!filter.includes(group)) delete keys[group];
    }
  }

  // The groups the site knows, plus any the picked account had that this
  // run did not see (one of the site's endpoints may be closed).
  const known = new Set([
    ...Object.keys(groups ?? {}),
    ...Object.keys(keys),
    ...Object.keys(picked ? groupsOf(picked.metadata) : {}),
  ]);
  const siteGroups = filter.length ? [...known].filter((g) => filter.includes(g)) : [...known];

  // A caller that answered yes without going through the questions (the CLI,
  // a server) creates them here.
  if (inputs?.autoCreate === "yes" && !Object.keys(createdKeys(inputs)).length) {
    for (const group of sortGroups(siteGroups.filter((g) => !keys[g]))) {
      const key = await createKey({ base, token, userId, label, group, tokens, fetchImpl }).catch(() => undefined);
      if (key) keys[group] = key;
    }
  }

  // Nothing could be reached and nothing was pasted: this is not a sign-in.
  if (unreachable && !Object.keys(keys).length) {
    return {
      type: "failed",
      error: `Could not reach ${base}. Check the URL and the network, then sign in again.`,
    };
  }

  // One map for the account: every group the site serves, with its ratio, its
  // key, and — when there is one — what is wrong with the key.
  const groupsMap = {};
  const had = picked ? groupsOf(picked.metadata) : {};
  for (const name of sortGroups([...siteGroups, ...Object.keys(keys)])) {
    const info = groups?.[name] ?? {};
    const entry = {};
    const ratio = Number(info.ratio ?? had[name]?.ratio);
    if (ratio > 0) entry.ratio = ratio;
    const desc = String(info.desc ?? had[name]?.desc ?? "");
    if (desc) entry.desc = desc;
    if (keys[name]) entry.key = keys[name];
    // The key the picked account had is the one that was refused before: the
    // sign-in just gave it another chance, so its verdict stands until the
    // next sync checks it again.
    else if (had[name]?.problem) entry.problem = had[name].problem;
    groupsMap[name] = entry;
  }

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
      groupFilter: filter.join(","),
      groups: groupsMap,
      checkin: inputs?.checkin !== "off" ? "auto" : "off",
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
