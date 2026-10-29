// The account's state, kept in one place: Magpie's account metadata.
//
// A New API account is a site (base URL + access token) and the groups that
// site serves. Each group has at most one key and at most one problem, so
// one map holds everything:
//
//   metadata.groups = {
//     "default": { ratio: 1,   key: "sk-..." },
//     "vip":     { ratio: 0.8, key: "sk-...", problem: "refused" },
//     "staged":  { ratio: 1,   tried: true },        // no key could be had
//   }
//
//   ratio    the site's group ratio, when it gives one
//   desc     the site's description, when it gives one
//   key      the group's key, the first the site offers
//   problem  why the key does not work: "refused" (the site turned it away)
//            or "gone" (the site no longer serves the group)
//   tried    a key was asked of the site and none could be had: do not make
//            another one
//
// There is no second copy of this on disk: `signIn` reads the account it is
// re-signing in to from Magpie's plugin-auth.json, which is where the
// metadata already lives.

import fs from "node:fs";
import path from "node:path";

import { hashKey, isMaskedKey, normalizeApiKey, sortGroups } from "./util.mjs";

const TTL_MS = 60_000;
const MAX_ENTRIES = 64;

/** A tiny TTL cache keyed by a string, bounded by MAX_ENTRIES. */
export class TtlCache {
  constructor(ttl = TTL_MS) {
    this.ttl = ttl;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttl = this.ttl) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttl });
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  /**
   * Cached, or computed and kept. A rejection is not cached, and neither is
   * an empty answer: a site that hiccupped once must not look empty for the
   * whole TTL.
   */
  async getOr(key, ttl, make) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await make();
    if (isEmptyAnswer(value)) return value;
    return this.set(key, value, ttl);
  }
}

function isEmptyAnswer(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value === "";
  return false;
}

/** Module-wide caches, keyed by site and by key hash (never by the key itself). */
export const caches = {
  status: new TtlCache(10 * 60_000),
  // A key's verdict from /v1/models, so a listing checks each key once.
  keyCheck: new TtlCache(5 * 60_000),
  pricing: new TtlCache(TTL_MS),
  modelList: new TtlCache(TTL_MS),
  userModels: new TtlCache(TTL_MS),
  usage: new TtlCache(30_000),
};

/** The key of a cache entry: the site, and the key's hash when one matters. */
export function cacheKey(base, ...parts) {
  return [base, ...parts.map((p) => (typeof p === "string" && p.length > 24 ? hashKey(p) : String(p ?? "")))].join("|");
}

// ---- the key a request may use -------------------------------------------

/**
 * The keys a request may be signed with, for a group: its key, unless the
 * site refused it or no longer serves the group. One key per group is all
 * the metadata holds, so there is nothing to rotate: a refused key is not
 * tried, since the site already said no and asking again spends the request.
 */
export function keysToTry(groups, group) {
  const entry = groupsOf({ groups })[group];
  if (!entry?.key || entry.problem) return [];
  return [entry.key];
}

/** The key a group holds, for diagnostics. */
export function nextKey(groups, group) {
  return groupsOf({ groups })[group]?.key ?? "";
}

/** The groups as the metadata holds them, cleaned of anything unreadable. */
export function groupsOf(md) {
  const out = {};
  for (const [name, value] of Object.entries(md?.groups ?? {})) {
    const group = String(name ?? "").trim();
    if (!group) continue;
    const raw = value && typeof value === "object" ? value : {};
    const key = normalizeApiKey(raw.key);
    const entry = {};
    if (Number(raw.ratio) > 0) entry.ratio = Number(raw.ratio);
    if (typeof raw.desc === "string" && raw.desc) entry.desc = raw.desc;
    if (key && !isMaskedKey(key)) entry.key = key;
    if (typeof raw.problem === "string" && raw.problem) entry.problem = raw.problem;
    if (raw.tried === true) entry.tried = true;
    out[group] = entry;
  }
  return out;
}

/** A group's key, or "" when it has none. */
export function keyOf(md, group) {
  return groupsOf(md)[group]?.key ?? "";
}

/** Whether a group has a key the site has not refused. */
export function usable(md, group) {
  const g = groupsOf(md)[group];
  return !!g?.key && !g.problem;
}

/** The groups the site serves and a key is missing for, in a stable order. */
export function groupsMissing(md) {
  const filter = groupFilterOf(md);
  return sortGroups(
    Object.entries(groupsOf(md))
      .filter(([name, g]) => !filter.length || filter.includes(name))
      .filter(([, g]) => !g.key && !g.tried)
      .map(([name]) => name),
  );
}

/** Every group that needs the user: no key, a refused key, or one gone. */
export function groupsNeedingAttention(md) {
  const filter = groupFilterOf(md);
  return sortGroups(
    Object.entries(groupsOf(md))
      .filter(([name, g]) => (!filter.length || filter.includes(name)) && g.problem)
      .map(([name]) => name),
  );
}

/** The group filter the user set at sign-in. */
export function groupFilterOf(md) {
  return String(md?.groupFilter ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** default first, then alphabetical (util.mjs has the one implementation). */
export { sortGroups };

/**
 * The metadata as a self-contained object for the helpers that take one: the
 * base, the access token and the user id in the shape they read, so callers
 * never have to remember which of `auth.key` and `metadata` holds the token.
 */
export function accountOf(auth) {
  const md = auth?.metadata ?? {};
  return {
    md,
    base: String(md.baseURL ?? ""),
    token: String(auth?.key ?? md.accessToken ?? ""),
    userId: String(md.userId ?? ""),
  };
}

/** accountOf, with the token put back into the metadata for helpers that take only that. */
export function runtimeMd(auth) {
  const { md, base, token, userId } = accountOf(auth);
  return { ...md, baseURL: base, accessToken: token, userId };
}

/**
 * The accounts this plugin already has, read from Magpie's plugin-auth.json:
 * one per site the user signed in to. A sign-in can then offer them, so
 * re-entering an access token that Magpie still holds is not something the
 * user has to do from memory.
 *
 * `directory` is Magpie's config dir (the plugin's `input.directory`).
 */
export function knownAccounts(directory) {
  if (!directory) return [];
  let all;
  try {
    all = JSON.parse(fs.readFileSync(path.join(directory, "plugin-auth.json"), "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const [key, auth] of Object.entries(all ?? {})) {
    if (!key.startsWith("newapi")) continue;
    const md = auth?.metadata ?? {};
    const base = String(md.baseURL ?? "");
    if (!base || !auth?.key) continue;
    out.push({
      key,
      base,
      userId: String(md.userId ?? ""),
      username: String(md.username ?? ""),
      siteLabel: String(md.siteLabel ?? ""),
      accountId: String(md.accountId ?? md.email ?? key),
      accessToken: String(auth.key),
      groups: Object.keys(groupsOf(md)),
      checkin: String(md.checkin ?? "auto"),
      metadata: md,
    });
  }
  return out.sort((a, b) => a.accountId.localeCompare(b.accountId));
}
