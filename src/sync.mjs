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
import { cleanLabel, mergeGroupKeys, normalizeApiKey, sortGroups } from "./util.mjs";

/** How long a listing trusts the groups it last read. */
export const SYNC_EVERY_MS = 10 * 60_000;

/** How long a key's verdict is trusted, so a listing does not re-check each one. */
const KEY_TTL_MS = 5 * 60_000;

/**
 * Whether a key works, by asking the site for the models it may call.
 * `models` is empty when the site answered with none: a key with no models
 * is still a working key.
 */
export async function checkKey(base, key, { fetchImpl } = {}) {
  const k = normalizeApiKey(key);
  if (!k) return { ok: false, why: "no key" };
  const cached = caches.keyCheck.get(cacheKey(base, "key", k));
  if (cached) return cached;
  let verdict;
  try {
    const models = await listModelsForKey(base, k, { fetchImpl });
    verdict = { ok: true, models };
  } catch (e) {
    if (e instanceof ChallengeError) return { ok: false, why: "the site asked for a captcha" };
    if (isAuthError(e)) verdict = { ok: false, why: "the site refused it" };
    else if (e?.status === 0) return { ok: false, why: "the site could not be reached", transient: true };
    else verdict = { ok: false, why: String(e?.message ?? e).slice(0, 120) };
  }
  // A network blip is not a verdict: don't keep it.
  if (!verdict.transient) caches.keyCheck.set(cacheKey(base, "key", k), verdict, KEY_TTL_MS);
  return verdict;
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

/** Create tokens for the named groups and reveal them; what failed stays out. */
export async function createKeysFor({ base, token, userId, label, groups, fetchImpl, max = 5 }) {
  const created = {};
  const wanted = sortGroups(groups ?? []).slice(0, max);
  for (const group of wanted) {
    const stamp = Date.now().toString(36).slice(-5);
    const safe = String(group).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 20);
    const name = `magpie-${cleanLabel(label, "site")}-${safe}-${stamp}`.slice(0, 50);
    try {
      await createToken(base, token, userId, group, name, { fetchImpl });
      const tokens = await listTokens(base, token, userId, { fetchImpl });
      const mine = tokens.filter((t) => t.name === name && t.group === group).sort((a, b) => b.id - a.id)[0];
      if (!mine) continue;
      const revealed = await revealTokenKeys(base, token, userId, [mine.id], { fetchImpl });
      const key = revealed.get(mine.id);
      if (key) created[group] = [key];
    } catch {
      // the token may exist without its key being readable: the user pastes it
    }
  }
  return created;
}

/** Only the metadata fields this sync owns. */
function slice(md) {
  return {
    groups: md.groups ?? {},
    groupKeys: groupKeysOf(md),
    pendingGroups: Array.isArray(md.pendingGroups) ? md.pendingGroups : [],
    keyProblems: md.keyProblems ?? {},
    groupsSyncedAt: md.groupsSyncedAt ?? "",
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
export async function syncAccount(md, { fetchImpl, autoCreate = false, now = Date.now(), force = false } = {}) {
  const base = String(md?.baseURL ?? "");
  const token = String(md?.accessToken ?? md?.token ?? "");
  const userId = String(md?.userId ?? "");
  const before = slice(md);
  const notes = [];

  if (!base || !token) return { fields: before, changed: false, notes: ["not signed in"] };
  const last = Date.parse(before.groupsSyncedAt);
  if (!force && Number.isFinite(last) && now - last < SYNC_EVERY_MS) {
    return { fields: before, changed: false, notes: [] };
  }

  let groups = before.groups;
  try {
    const live = await readGroups({ base, token, userId, fetchImpl });
    if (live) groups = live;
    else notes.push("the site's groups could not be read");
  } catch (e) {
    notes.push(`the site's groups could not be read: ${String(e?.message ?? e).slice(0, 120)}`);
  }

  let groupKeys = { ...before.groupKeys };
  const keyProblems = {};

  // A key the site hands out for a group is the best one there is: read the
  // token list and reveal what may be revealed, so a group added (or a token
  // created elsewhere) needs no second sign-in.
  try {
    const tokens = await listTokens(base, token, userId, { fetchImpl });
    const usable = tokens.filter((tk) => tokenUsable(tk));
    const missingGroup = (tk) => !groupKeys[tk.group || "default"]?.length;
    const ids = usable.filter(missingGroup).map((tk) => tk.id);
    if (ids.length) {
      const revealed = await revealTokenKeys(base, token, userId, ids, { fetchImpl });
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
  await Promise.all(
    groupsWithKeys.map(async (group) => {
      const key = groupKeys[group]?.[0];
      if (!key) return;
      const verdict = await checkKey(base, key, { fetchImpl });
      if (verdict.ok) return;
      if (verdict.transient) {
        notes.push(`${group}: ${verdict.why}`);
        return;
      }
      keyProblems[group] = verdict.why;
      notes.push(`${group}: ${verdict.why}`);
    }),
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
  if (autoCreate && pending.length) {
    const created = await createKeysFor({
      base,
      token,
      userId,
      label: md?.siteLabel ?? "",
      groups: pending,
      fetchImpl,
    });
    if (Object.keys(created).length) {
      groupKeys = mergeGroupKeys(groupKeys, created);
      pending = sortGroups(wanted.filter((g) => !groupKeys[g]?.length));
      notes.push(`created a key for ${Object.keys(created).join(", ")}`);
    }
  }

  const fields = {
    groups,
    groupKeys,
    pendingGroups: pending,
    keyProblems,
    groupsSyncedAt: new Date(now).toISOString(),
  };
  const changed =
    !same(fields.groups, before.groups) ||
    !same(fields.groupKeys, before.groupKeys) ||
    !same(fields.pendingGroups, before.pendingGroups) ||
    !same(fields.keyProblems, before.keyProblems);
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
