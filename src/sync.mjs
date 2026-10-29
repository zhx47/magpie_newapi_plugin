// Keeping an account current.
//
// A New API site's groups are not fixed: an operator adds, renames or closes
// them, and an existing key can be revoked. The account's sign-in metadata is
// a snapshot taken when the user signed in, so on its own it would show the
// groups of that day forever.
//
// Magpie calls `provider.models` with the account in scope, where
// `client.auth.set` writes to that account, so the plugin keeps its own
// metadata fresh: it re-reads the groups on a slow clock, checks the keys it
// has, creates ones it may, and writes back what changed. `auth.checkin`,
// which Magpie runs once a day, does the same, so a site that is checked in
// but never listed still follows its groups.
//
// Nothing here throws for a site that is briefly unreachable: the metadata it
// had is kept, and the next attempt tries again.

import {
  ChallengeError,
  createToken,
  getUserGroups,
  isAuthError,
  listModelsForKey,
  listTokens,
  revealTokenKeys,
  tokenUsable,
} from "./api.mjs";
import { groupKeysOf, caches, cacheKey } from "./state.mjs";
import { cleanLabel, hashKey, mergeGroupKeys, normalizeApiKey, sortGroups } from "./util.mjs";

/** How long a listing trusts the groups it last read. */
export const SYNC_EVERY_MS = 10 * 60_000;

/**
 * When each account was last synced, in memory. A metadata field would only
 * be written when something else changed, so an account whose groups were
 * steady would sync on every listing — the bug this map replaces.
 */
const lastSync = new Map();

/** How long a key's verdict is trusted, so a listing does not re-check each one. */
const KEY_TTL_MS = 5 * 60_000;

/**
 * Whether a key works, by asking the site for the models it may call.
 *
 * The answer is the same request a listing makes for the group, so it is
 * kept in that cache under the same key: a sign-in, the sync and the model
 * list then cost one request per key, not three. `models` may be empty —
 * a key with no models is still a working key.
 */
export async function checkKey(base, group, key, { fetchImpl } = {}) {
  const k = normalizeApiKey(key);
  if (!k) return { ok: false, why: "no key" };
  const cache = cacheKey(base, group || "_", k);
  const verdict = caches.keyCheck.get(cache);
  if (verdict) return verdict;

  let out;
  try {
    const models = await caches.modelList.getOr(cache, 60_000, () => listModelsForKey(base, k, { fetchImpl }));
    out = { ok: true, models };
  } catch (e) {
    if (e instanceof ChallengeError) return { ok: false, why: "the site asked for a captcha" };
    if (isAuthError(e)) out = { ok: false, why: "the site refused it" };
    else if (e?.status === 0) return { ok: false, why: "the site could not be reached", transient: true };
    else out = { ok: false, why: String(e?.message ?? e).slice(0, 120) };
  }
  // A network blip is not a verdict: don't keep it.
  if (!out.transient) caches.keyCheck.set(cache, out, KEY_TTL_MS);
  return out;
}

/** The site's groups now, or null when it could not be asked. */
export async function readGroups({ base, token, userId, fetchImpl }) {
  try {
    const groups = await getUserGroups(base, token, userId, { fetchImpl });
    return Object.keys(groups).length ? groups : null;
  } catch (e) {
    if (e instanceof ChallengeError || isAuthError(e)) throw e;
    return null;
  }
}

/**
 * Keys for the groups that have none.
 *
 * A group is only created for when its token list has no usable token at
 * all: a token the site already holds is reused (its key revealed), never
 * duplicated. A group whose token was made but whose key could not be
 * revealed is reported as `attempted`, so the caller can leave it to the
 * user instead of making another one on the next run — the bug this fixes
 * made a hundred tokens for one group.
 *
 * The new token is found by the ids the list did not have before, not by
 * its name: a name is truncated and stamped, and a mismatch used to look
 * like "nothing was created" and be retried for ever.
 */
export async function createKeysFor({ base, token, userId, label, groups, tokens, fetchImpl, max = 5 }) {
  const created = {};
  const attempted = [];
  const wanted = sortGroups(groups ?? []);
  if (!wanted.length) return { created, attempted };

  /** The newest usable token of a group among tokens, or undefined. */
  const existingOf = (group) =>
    (tokens ?? [])
      .filter((t) => (t.group || "default") === group && tokenUsable(t))
      .sort((a, b) => b.id - a.id)[0];

  // A token the site already has is better than one more: reveal it.
  const toReveal = [];
  for (const group of wanted) {
    const have = existingOf(group);
    if (have) toReveal.push(have);
  }
  if (toReveal.length) {
    try {
      const revealed = await revealTokenKeys(base, token, userId, toReveal.map((t) => t.id), { fetchImpl });
      for (const tk of toReveal) {
        const key = revealed.get(tk.id);
        if (key) created[tk.group || "default"] = [key];
      }
    } catch {
      // not readable: the caller falls back to asking for it
    }
  }

  for (const group of wanted.filter((g) => !created[g]).slice(0, max)) {
    // One more look: the reveal above may have missed a group that has a
    // token this call did not see.
    if (existingOf(group)) {
      attempted.push(group);
      continue;
    }

    const before = new Set((tokens ?? []).map((t) => t.id));
    const stamp = Date.now().toString(36).slice(-5);
    const safe = String(group).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 20);
    const name = `magpie-${cleanLabel(label, "site")}-${safe}-${stamp}`.slice(0, 50);

    try {
      await createToken(base, token, userId, group, name, { fetchImpl });
    } catch {
      // the site refused to make one: leave it to the user, and do not try
      // again on the next run
      attempted.push(group);
      continue;
    }

    try {
      const after = (await listTokens(base, token, userId, { fetchImpl })).filter((t) => t.group === group);
      const made = after.filter((t) => !before.has(t.id)).sort((a, b) => b.id - a.id)[0] ?? existingOf(group);
      if (!made) {
        attempted.push(group);
        continue;
      }
      const revealed = await revealTokenKeys(base, token, userId, [made.id], { fetchImpl });
      const key = revealed.get(made.id);
      if (key) created[group] = [key];
      else attempted.push(group);
    } catch {
      // the token exists but its key is not readable: the user pastes it,
      // and no second one is made
      attempted.push(group);
    }
  }

  for (const group of wanted.slice(max)) attempted.push(group);
  return { created, attempted };
}

/** Only the metadata fields this sync owns. */
function slice(md) {
  return {
    groups: md.groups ?? {},
    groupKeys: groupKeysOf(md),
    pendingGroups: Array.isArray(md.pendingGroups) ? md.pendingGroups : [],
    keyProblems: md.keyProblems ?? {},
    keyInfo: md.keyInfo ?? {},
    createAttempted: Array.isArray(md.createAttempted) ? md.createAttempted : [],
  };
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Bring an account's metadata up to date. Returns `{ fields, changed, notes }`
 * where `fields` holds only the keys this owns, ready to merge into the
 * account's metadata. `force` skips the slow clock (the check-in uses it).
 *
 * A site that cannot be reached leaves everything as it was; `notes` says so
 * without failing the caller.
 */
export async function syncAccount(md, { fetchImpl, autoCreate = false, now = Date.now(), force = false, budgetMs = 8000 } = {}) {
  const base = String(md?.baseURL ?? "");
  const token = String(md?.accessToken ?? md?.token ?? "");
  const userId = String(md?.userId ?? "");
  const before = slice(md);
  const notes = [];

  if (!base || !token) return { fields: before, changed: false, notes: ["not signed in"] };
  const id = `${base}|${userId || "user"}`;
  const last = lastSync.get(id) ?? 0;
  if (!force && now - last < SYNC_EVERY_MS) {
    return { fields: before, changed: false, notes: [] };
  }
  lastSync.set(id, now);

  // Magpie gives a listing 20s in all (gui/providers.go). The sync must never
  // eat it: whatever it has when the budget is gone is what it writes, and
  // the rest is settled on a later run.
  const deadline = now + budgetMs;
  const left = () => deadline - Date.now();
  /** p, or null when the sync's budget runs out first. The timer is cleared so it never holds the process open. */
  const inTime = async (p) => {
    let timer;
    try {
      return await Promise.race([
        p,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, left()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  let groups = before.groups;
  try {
    const live = await inTime(readGroups({ base, token, userId, fetchImpl }));
    if (live) groups = live;
    else notes.push("the site's groups could not be read");
  } catch (e) {
    notes.push(`the site's groups could not be read: ${String(e?.message ?? e).slice(0, 120)}`);
  }

  let groupKeys = { ...before.groupKeys };
  const keyProblems = {};
  let siteTokens = [];

  // A key the site hands out for a group is the best one there is: read the
  // token list and reveal what may be revealed, so a group added (or a token
  // created elsewhere) needs no second sign-in.
  try {
    const tokens = (await inTime(listTokens(base, token, userId, { fetchImpl }))) ?? [];
    siteTokens = tokens;
    const usable = tokens.filter((tk) => tokenUsable(tk));
    const missingGroup = (tk) => !groupKeys[tk.group || "default"]?.length;
    const ids = usable.filter(missingGroup).map((tk) => tk.id);
    if (ids.length && left() > 500) {
      const revealed = (await inTime(revealTokenKeys(base, token, userId, ids, { fetchImpl }))) ?? new Map();
      const found = {};
      for (const tk of usable) {
        const key = revealed.get(tk.id);
        if (!key) continue;
        const group = tk.group || "default";
        (found[group] ??= []).push(key);
      }
      if (Object.keys(found).length) {
        groupKeys = mergeGroupKeys(groupKeys, found);
        notes.push(`found a key for ${Object.keys(found).join(", ")}`);
      }
    }
  } catch (e) {
    if (e instanceof ChallengeError || isAuthError(e)) notes.push(`the site's keys could not be read: ${String(e?.message ?? e).slice(0, 100)}`);
  }

  // Check the key of every group this account holds: one the site refuses is
  // as good as missing, and saying so is what gets it replaced.
  const groupsWithKeys = sortGroups(Object.keys(groupKeys));
  await inTime(
    Promise.all(
      groupsWithKeys.map(async (group) => {
        const key = groupKeys[group]?.[0];
        if (!key || keyProblems[group]) return;
        const verdict = await checkKey(base, group, key, { fetchImpl });
        if (verdict.ok) return;
        if (verdict.transient) {
          notes.push(`${group}: ${verdict.why}`);
          return;
        }
        keyProblems[group] = verdict.why;
        notes.push(`${group}: ${verdict.why}`);
      }),
    ),
  );

  // A group the site no longer lists: its key is kept (the site may bring the
  // group back) but it is not offered as a model namespace.
  const siteNames = Object.keys(groups);
  for (const group of Object.keys(groupKeys)) {
    if (siteNames.length && !siteNames.includes(group)) {
      notes.push(`${group}: no longer a group at this site`);
    }
  }

  const filter = String(md?.groupFilter ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean);
  const wanted = filter.length ? siteNames.filter((g) => filter.includes(g)) : siteNames;
  let pending = sortGroups(wanted.filter((g) => !groupKeys[g]?.length));

  // Keys for the groups that have none, when the user allowed creating them.
  // A group the site already gave a key for, or one whose key it would not
  // hand over, is not tried again on the next run: making a second token
  // because the first could not be read is how one group ended up with a
  // hundred of them.
  const attempted = new Set(before.createAttempted ?? []);
  const toTry = pending.filter((g) => !attempted.has(g));
  if (autoCreate && toTry.length && left() > 1500) {
    const made = (await inTime(
      createKeysFor({
        base,
        token,
        userId,
        label: md?.siteLabel ?? "",
        groups: toTry,
        tokens: siteTokens,
        fetchImpl,
      }),
    )) ?? { created: {}, attempted: [] };
    if (Object.keys(made.created).length) {
      groupKeys = mergeGroupKeys(groupKeys, made.created);
      notes.push(`created a key for ${Object.keys(made.created).join(", ")}`);
    }
    for (const group of made.attempted ?? []) attempted.add(group);
    pending = sortGroups(wanted.filter((g) => !groupKeys[g]?.length));
  }

  // The fetch reads keyInfo to pick a key; a refused one is marked there so
  // a group with another key does not keep trying it.
  const keyInfo = { ...(before.keyInfo ?? {}) };
  for (const group of Object.keys(keyInfo)) {
    if (!keyProblems[group]) delete keyInfo[group].refused;
  }
  for (const [group, why] of Object.entries(keyProblems)) {
    const key = groupKeys[group]?.[0];
    if (!key) continue;
    keyInfo[hashKey(key)] = { ...(keyInfo[hashKey(key)] ?? {}), refused: why };
  }

  const fields = {
    groups,
    groupKeys,
    pendingGroups: pending,
    keyProblems,
    keyInfo,
    createAttempted: sortGroups([...attempted].filter((g) => !groupKeys[g]?.length)),
  };
  const changed =
    !same(fields.groups, before.groups) ||
    !same(fields.groupKeys, before.groupKeys) ||
    !same(fields.pendingGroups, before.pendingGroups) ||
    !same(fields.keyProblems, before.keyProblems) ||
    !same(fields.keyInfo, before.keyInfo) ||
    !same(fields.createAttempted, before.createAttempted);
  return { fields, changed, notes };
}

/**
 * The groups that need the user: without a key, or with one the site refused,
 * with the reason. Used by the usage card and the sign-in questions.
 */
export function groupsNeedingAttention(md) {
  const keys = groupKeysOf(md);
  const problems = md?.keyProblems ?? {};
  const names = sortGroups(Object.keys(md?.groups ?? {}).length ? Object.keys(md.groups) : Object.keys(keys));
  const filter = String(md?.groupFilter ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean);
  const wanted = filter.length ? names.filter((g) => filter.includes(g)) : names;
  return wanted
    .map((group) => {
      if (!keys[group]?.length) return { group, state: "missing", why: "no key" };
      if (problems[group]) return { group, state: "refused", why: problems[group] };
      return null;
    })
    .filter(Boolean);
}

/** A one-line summary of the account's groups, for a log or a card. */
export function groupsSummary(md) {
  const keys = groupKeysOf(md);
  const problems = md?.keyProblems ?? {};
  const names = sortGroups(Object.keys(md?.groups ?? {}).length ? Object.keys(md.groups) : Object.keys(keys));
  return names.map((g) => {
    if (!keys[g]?.length) return `${g} —`;
    if (problems[g]) return `${g} ✗`;
    return `${g} ✓`;
  });
}
