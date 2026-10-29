// Group keys, cached models and pricing: everything the plugin keeps in
// memory between hooks, plus the small on-disk cache that lets a second
// sign-in keep keys the user pasted by hand.
//
// Keys never go into logs or messages; the disk file is 0600.

import fs from "node:fs";
import path from "node:path";

import { hashKey, isMaskedKey, mergeGroupKeys, normalizeApiKey } from "./util.mjs";

const CACHE_FILE = "newapi-keys.json";
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
   * Cached, or computed and kept. A rejection is not cached. An empty
   * answer (null, undefined, [], "") is not cached either: a site that
   * hiccupped once must not look empty for the whole TTL.
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

/** Rotating key cursor per site+group, so a group with several keys is shared. */
const cursors = new Map();

/**
 * Keys that may sign a request for a group and model: a key the site said is
 * disabled, expired or limited to other models is skipped. `keyInfo` is by
 * the key's hash (util.mjs `hashKey`), so metadata never holds a second copy
 * of a secret under a plain name.
 */
function usableKeys(groupKeys, group, model, keyInfo = {}) {
  const list = Array.isArray(groupKeys?.[group]) ? groupKeys[group] : [];
  if (!list.length) return [];
  const ok = list.filter((key) => {
    const info = keyInfo[hashKey(key)];
    if (!info) return true;
    if (info.disabled) return false;
    if (info.exp > 0 && info.exp < Date.now() / 1000) return false;
    if (Array.isArray(info.models) && info.models.length && model) return info.models.includes(model);
    return true;
  });
  return ok.length ? ok : list;
}

export function nextKey(groupKeys, group, model, keyInfo = {}) {
  const pool = usableKeys(groupKeys, group, model, keyInfo);
  if (!pool.length) return "";
  const id = `${group}\u0000${model ?? ""}`;
  const at = cursors.get(id) ?? 0;
  cursors.set(id, (at + 1) % pool.length);
  return pool[at % pool.length];
}

/** Keys tried for one request: the rotating one first, then the rest. */
export function keysToTry(groupKeys, group, model, keyInfo = {}, limit = 2) {
  const pool = usableKeys(groupKeys, group, model, keyInfo);
  if (!pool.length) return [];
  const first = nextKey(groupKeys, group, model, keyInfo);
  const out = [first];
  for (const key of pool) {
    if (out.length >= limit) break;
    if (!out.includes(key)) out.push(key);
  }
  return out.filter(Boolean);
}

// ---- the on-disk key cache ---------------------------------------------------

function cachePath(directory) {
  const dir = directory || process.cwd();
  return path.join(dir, CACHE_FILE);
}

function readCacheFile(directory) {
  try {
    const text = fs.readFileSync(cachePath(directory), "utf8");
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeCacheFile(directory, data) {
  const file = cachePath(directory);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ignores modes; the file is still user-writable only.
    }
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing else to do
    }
  }
}

/** The cache id of a site account: base plus the site's own user. */
export function accountCacheKey(base, userId, username) {
  return `${base}|${userId || username || ""}`;
}

/**
 * Read the keys kept for a site account. Returns { groupKeys, at } where
 * groupKeys maps group names to an array of keys.
 */
export function readCachedKeys(directory, base, userId, username) {
  const id = accountCacheKey(base, userId, username);
  const all = readCacheFile(directory);
  const entry = all[id];
  const groupKeys = entry?.groupKeys && typeof entry.groupKeys === "object" ? entry.groupKeys : {};
  const clean = {};
  for (const [group, value] of Object.entries(groupKeys)) {
    const list = (Array.isArray(value) ? value : [value]).map(normalizeApiKey).filter((k) => k && !isMaskedKey(k));
    if (list.length) clean[group] = list;
  }
  return { groupKeys: clean, at: String(entry?.updatedAt ?? "") };
}

/**
 * Every key kept for a site, whichever account of it: sign-in asks for the
 * groups still missing a key before it knows which user the token belongs
 * to, and a second account of one site shares none of them.
 */
export function readCachedKeysForSite(directory, base) {
  const all = readCacheFile(directory);
  const out = {};
  for (const [id, entry] of Object.entries(all)) {
    if (!id.startsWith(`${base}|`)) continue;
    const keys = entry?.groupKeys;
    if (!keys || typeof keys !== "object") continue;
    for (const [group, value] of Object.entries(keys)) {
      const list = (Array.isArray(value) ? value : [value]).map(normalizeApiKey).filter((k) => k && !isMaskedKey(k));
      if (list.length) (out[group] ??= []).push(...list);
    }
  }
  return mergeGroupKeys(out);
}

/** Merge keys into the cache for a site account. Never throws. */
export function writeCachedKeys(directory, base, userId, username, groupKeys) {
  if (!groupKeys || !Object.keys(groupKeys).length) return;
  const id = accountCacheKey(base, userId, username);
  const all = readCacheFile(directory);
  const before = all[id]?.groupKeys ?? {};
  all[id] = { groupKeys: mergeGroupKeys(before, groupKeys), updatedAt: new Date().toISOString() };
  writeCacheFile(directory, all);
}

// ---- per-account metadata helpers -------------------------------------------

/** The parts of a sign-in every hook needs. `auth.key` is the site's access token (written by signIn); `metadata.accessToken` is only a fallback for an auth file written by an older version of this plugin. */
export function accountOf(auth) {
  const md = auth?.metadata ?? {};
  return {
    md,
    base: String(md.baseURL ?? ""),
    token: String(auth?.key ?? md.accessToken ?? ""),
    userId: String(md.userId ?? ""),
  };
}

/**
 * The metadata as a self-contained object for helpers that take one: the
 * base, the access token and the user id in the shape they read, so callers
 * never have to remember which of `auth.key` and `metadata` holds the token.
 */
export function runtimeMd(auth) {
  const { md, base, token, userId } = accountOf(auth);
  return { ...md, baseURL: base, accessToken: token, userId };
}

/** An account's metadata with the fields a sync owns replaced, the rest kept. */
export function withMetadata(md, fields) {
  return { ...(md ?? {}), ...(fields ?? {}) };
}

/** The group keys an account holds as arrays of full keys. */
export function groupKeysOf(metadata) {
  const out = {};
  for (const [group, value] of Object.entries(metadata?.groupKeys ?? {})) {
    const list = (Array.isArray(value) ? value : [value]).map(normalizeApiKey).filter((k) => k && !isMaskedKey(k));
    if (list.length) out[group] = list;
  }
  return out;
}

/** Groups the site lists (as Magpie knows them) that have no key. */
export function missingGroups(metadata) {
  const keys = groupKeysOf(metadata);
  const known = Object.keys(metadata?.groups ?? {});
  const names = known.length ? known : Object.keys(keys);
  const filter = String(metadata?.groupFilter ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean);
  const wanted = filter.length ? names.filter((g) => filter.includes(g)) : names;
  return wanted.filter((g) => !keys[g]?.length);
}
