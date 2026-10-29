// Keeping an account current.
//
// A New API site's groups change: an operator adds, renames or closes them,
// and a key can be revoked. The account's metadata holds one map of groups
// (see state.mjs), and this module is the only thing that writes it after
// sign-in:
//
//   - every group the site serves is in the map, with its ratio and
//     description;
//   - a group with a usable token at the site gets that key;
//   - a group whose key the site refuses is marked refused;
//   - a group the site no longer serves is marked gone, its key kept;
//   - a group with no key is asked of the site once (when creating is on);
//     if that fails it is marked tried, so no second token is ever made.
//
// It runs from `auth.usage` (on a ten-minute clock) and `auth.checkin`
// (once a day), never from `provider.models`: Magpie gives that hook 20s in
// all, shared with every other provider, so it stays a pure read.

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
import { caches, cacheKey, groupFilterOf, groupsOf, sortGroups } from "./state.mjs";
import { cleanLabel, normalizeApiKey } from "./util.mjs";

/** How long a read trusts what it last saw. */
export const SYNC_EVERY_MS = 10 * 60_000;

/**
 * When each account was last synced, in memory. A metadata field would only
 * be written when something else changed, so an account whose groups were
 * steady would sync on every read.
 */
const lastSync = new Map();

/**
 * Whether a key works, by asking the site for the models it may call. The
 * answer is the same request a listing makes for the group, so it is kept in
 * that cache under the same key: a sign-in, the sync and the model list then
 * cost one request per key, not three.
 *
 * The answer's `why` is what a group's `problem` records: "refused".
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
    if (e instanceof ChallengeError) return { ok: false, why: "captcha" };
    if (isAuthError(e)) out = { ok: false, why: "refused" };
    else if (e?.status === 0) return { ok: false, why: "unreachable", transient: true };
    else out = { ok: false, why: "refused" };
  }
  // A network blip is not a verdict.
  if (!out.transient) caches.keyCheck.set(cache, out, 5 * 60_000);
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
 * Keys for the groups that have none, taken from the tokens the site already
 * holds: the newest usable token of each group is revealed. Nothing is
 * created here.
 */
export async function keysFromTokens({ base, token, userId, groups, tokens, fetchImpl }) {
  const found = {};
  const wanted = new Set(groups ?? []);
  const newest = new Map();
  for (const t of (tokens ?? []).filter((x) => tokenUsable(x))) {
    const group = t.group || "default";
    if (!wanted.has(group) || newest.has(group)) continue;
    newest.set(group, t);
  }
  if (!newest.size) return found;

  try {
    const revealed = await revealTokenKeys(base, token, userId, [...newest.values()].map((t) => t.id), { fetchImpl });
    for (const [group, tk] of newest) {
      const key = revealed.get(tk.id);
      if (key) found[group] = key;
    }
  } catch {
    // not readable: the caller leaves those groups to the user
  }
  return found;
}

/**
 * Ask the site to make a token for a group and take its key. One token, one
 * group, no retry: `undefined` means "nothing could be had", which the caller
 * records as tried.
 *
 * The new token is found by the ids the list did not have before, not by its
 * name: a name is truncated and stamped, and a mismatch once looked like
 * "nothing was created" and was retried for ever — a hundred tokens for one
 * group.
 */
export async function createKey({ base, token, userId, label, group, tokens, fetchImpl }) {
  const before = new Set((tokens ?? []).map((t) => t.id));
  const stamp = Date.now().toString(36).slice(-5);
  const safe = String(group).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 20);
  const name = `magpie-${cleanLabel(label, "site")}-${safe}-${stamp}`.slice(0, 50);

  try {
    await createToken(base, token, userId, group, name, { fetchImpl });
  } catch {
    return undefined;
  }
  try {
    const after = (await listTokens(base, token, userId, { fetchImpl })).filter((t) => (t.group || "default") === group);
    const made = after.filter((t) => !before.has(t.id)).sort((a, b) => b.id - a.id)[0];
    if (!made) return undefined;
    const revealed = await revealTokenKeys(base, token, userId, [made.id], { fetchImpl });
    return revealed.get(made.id);
  } catch {
    return undefined;
  }
}

/**
 * Bring an account's `groups` up to date.
 *
 * Returns `{ groups, changed, notes }`: `groups` is the whole map to write
 * back, or the one it already had when nothing changed. A site that cannot be
 * reached leaves everything as it was.
 */
export async function syncAccount(md, { fetchImpl, autoCreate = false, now = Date.now(), force = false, budgetMs = 8000 } = {}) {
  const base = String(md?.baseURL ?? "");
  const token = String(md?.accessToken ?? md?.token ?? "");
  const userId = String(md?.userId ?? "");
  const before = groupsOf(md);
  const notes = [];

  if (!base || !token) return { groups: before, changed: false, notes: ["not signed in"] };
  const id = `${base}|${userId || "user"}`;
  const last = lastSync.get(id) ?? 0;
  if (!force && now - last < SYNC_EVERY_MS) return { groups: before, changed: false, notes: [] };
  lastSync.set(id, now);

  // Whatever was read before the budget ran out is what gets written; the
  // rest is settled on a later run.
  const deadline = now + budgetMs;
  const left = () => deadline - Date.now();
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

  // The site's own list of groups: names, ratios, descriptions.
  let siteGroups = null;
  try {
    siteGroups = await inTime(readGroups({ base, token, userId, fetchImpl }));
    if (!siteGroups) notes.push("the site's groups could not be read");
  } catch (e) {
    notes.push(`the site's groups could not be read: ${String(e?.message ?? e).slice(0, 100)}`);
  }

  const next = {};
  for (const [name, info] of Object.entries(siteGroups ?? {})) {
    const old = before[name] ?? {};
    const entry = {};
    const ratio = Number(info?.ratio);
    if (ratio > 0) entry.ratio = ratio;
    if (typeof info?.desc === "string" && info.desc) entry.desc = info.desc;
    if (old.key) entry.key = old.key;
    // A problem is about the key the site had, not the group: keep it while
    // the key it was seen with is still the one held.
    if (old.problem && old.problem !== "gone" && old.key) entry.problem = old.problem;
    if (!entry.key && old.tried) entry.tried = true;
    next[name] = entry;
  }

  // A group the site no longer serves: its key is kept (the group may come
  // back) and it is marked gone, so nothing lists or uses it.
  if (siteGroups) {
    for (const [name, old] of Object.entries(before)) {
      if (name in next) continue;
      next[name] = { ...old, problem: "gone" };
    }
  }

  const siteNames = siteGroups ? Object.keys(siteGroups) : Object.keys(before);
  const filter = groupFilterOf(md);
  const wanted = filter.length ? siteNames.filter((g) => filter.includes(g)) : siteNames;

  // Groups with no key: the site's tokens first, then new ones if allowed.
  let needKeys = sortGroups(wanted.filter((g) => !next[g]?.key && !next[g]?.tried));
  if (needKeys.length) {
    const tokens = (await inTime(listTokens(base, token, userId, { fetchImpl }))) ?? [];
    const found = await keysFromTokens({ base, token, userId, groups: needKeys, tokens, fetchImpl });
    for (const [group, key] of Object.entries(found)) {
      next[group] = { ...next[group], key };
      notes.push(`found a key for ${group}`);
    }
    needKeys = needKeys.filter((g) => !next[g]?.key);

    if (autoCreate && needKeys.length && left() > 1500) {
      for (const group of needKeys) {
        if (left() <= 0) break;
        const key = await inTime(createKey({ base, token, userId, label: md?.siteLabel ?? "", group, tokens, fetchImpl }));
        if (key) {
          next[group] = { ...next[group], key };
          delete next[group].tried;
          notes.push(`created a key for ${group}`);
        } else {
          next[group] = { ...next[group], tried: true };
        }
      }
    }
  }

  // Every key the account holds is checked: a refused one is the same as a
  // missing one, and saying so is what gets it replaced.
  await inTime(
    Promise.all(
      sortGroups(Object.keys(next))
        .filter((g) => next[g]?.key && next[g]?.problem !== "gone")
        .map(async (group) => {
          const verdict = await checkKey(base, group, next[group].key, { fetchImpl });
          if (verdict.ok) {
            if (next[group].problem === "refused") delete next[group].problem;
            return;
          }
          if (verdict.transient) {
            notes.push(`${group}: ${verdict.why}`);
            return;
          }
          next[group] = { ...next[group], problem: "refused" };
          notes.push(`${group}: refused`);
        }),
    ),
  );

  if (same(next, before)) return { groups: before, changed: false, notes };
  return { groups: next, changed: true, notes };
}

function same(a, b) {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function sorted(map) {
  return Object.fromEntries(sortGroups(Object.keys(map)).map((k) => [k, map[k]]));
}
