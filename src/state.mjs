// 账号状态只放在一个地方：Magpie 的账号 metadata。
//
// 一个 New API 账号就是一个站点（baseURL + 访问令牌）加它提供的那些分组。
// 每个分组最多有一个 key、最多有一个问题，所以一张表就够了：
//
//   metadata.groups = {
//     "default": { ratio: 1,   key: "sk-..." },
//     "vip":     { ratio: 0.8, key: "sk-...", problem: "refused" },
//     "staged":  { ratio: 1,   tried: true },        // 要过 key 但要不到
//   }
//
//   ratio    站点给的分组倍率（给了才有）
//   desc     站点给的描述（给了才有）
//   key      该分组的 key，站点有多条时取最新一条
//   problem  key 为什么不能用："refused"（站点拒绝）
//            或 "gone"（站点不再提供这个分组）
//   tried    向站点要过 key 但要不到，不要再建第二个
//
// 磁盘上没有第二份：重新登录时从 Magpie 的 plugin-auth.json 读账号，
// metadata 本来就存在那里。

import fs from "node:fs";
import path from "node:path";

import { hashKey, isMaskedKey, normalizeApiKey, normalizeBase, sortGroups } from "./util.mjs";

const TTL_MS = 60_000;
const MAX_ENTRIES = 64;

/** 一个按字符串键的小型 TTL 缓存，最多 MAX_ENTRIES 条。 */
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
    // 删了再插，保持「最近用过」的顺序
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
   * 命中就返回，否则算出来再存。失败（reject）不缓存，
   * 空答案也不缓存：站点偶尔抽一下，不该在整个 TTL 里都显示成空。
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

/** 模块级缓存：按站点、按 key 的哈希分区（从不按 key 本身）。 */
export const caches = {
  status: new TtlCache(10 * 60_000),
  // 一个 key 在 /v1/models 上的判定，让每次列举只校验一次。
  keyCheck: new TtlCache(5 * 60_000),
  pricing: new TtlCache(TTL_MS),
  modelList: new TtlCache(TTL_MS),
  userModels: new TtlCache(TTL_MS),
  usage: new TtlCache(30_000),
};

/** 缓存项的键：站点，加必要时的 key 哈希。 */
export function cacheKey(base, ...parts) {
  return [base, ...parts.map((p) => (typeof p === "string" && p.length > 24 ? hashKey(p) : String(p ?? "")))].join("|");
}

// ---- 请求可以用哪个 key ------------------------------------------------

/**
 * 某个分组签请求能用的 key：就是它自己的 key，除非站点拒绝过它、
 * 或者站点已经不再提供这个分组。metadata 里每个分组只留一条 key，
 * 没有可轮换的东西：被拒的 key 不再重试，因为站点已经说不，
 * 再试一次只是白花一个请求。
 */
export function keysToTry(groups, group) {
  const entry = groupsOf({ groups })[group];
  if (!entry?.key || entry.problem) return [];
  return [entry.key];
}

/** 某分组持有的 key，诊断用。 */
export function nextKey(groups, group) {
  return groupsOf({ groups })[group]?.key ?? "";
}

/** metadata 里的分组表，去掉读不出来的东西。 */
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

/** 某分组的 key，没有就返回空串。 */
export function keyOf(md, group) {
  return groupsOf(md)[group]?.key ?? "";
}

/** 这个分组是否有站点没拒绝过的 key。 */
export function usable(md, group) {
  const g = groupsOf(md)[group];
  return !!g?.key && !g.problem;
}

/** 站点提供、但还没有 key 的分组，按稳定顺序。 */
export function groupsMissing(md) {
  return sortGroups(
    Object.entries(groupsOf(md))
      .filter(([, g]) => !g.key && !g.tried)
      .map(([name]) => name),
  );
}

/** 所有需要用户处理的分组：没 key、key 被拒、或分组已消失。 */
export function groupsNeedingAttention(md) {
  return sortGroups(
    Object.entries(groupsOf(md))
      .filter(([, g]) => Boolean(g.problem))
      .map(([name]) => name),
  );
}

/** default 在前，其余按字母（实现只有 util.mjs 里那一份）。 */
export { sortGroups };

/**
 * 账号的自包含视图：base、访问令牌、user id 摆成调用方要读的样子，
 * 免得每个调用方都去记令牌究竟在 `auth.key` 还是 `metadata` 里。
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

/** accountOf，但把令牌塞回 metadata，给只接收 metadata 的辅助函数用。 */
export function runtimeMd(auth) {
  const { md, base, token, userId } = accountOf(auth);
  return { ...md, baseURL: base, accessToken: token, userId };
}

/**
 * 插件已经有的账号，从 Magpie 的 plugin-auth.json 读：用户登录过几个站点
 * 就有几个。登录时可以把它们列出来，于是「重输一个 Magpie 还存着的
 * 访问令牌」不再是用户必须凭记忆做的事。
 *
 * `directory` 是 Magpie 的配置目录（插件的 `input.directory`）。
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

/**
 * 已经存在的那个账号：同一个站点、同一个访问令牌。
 *
 * 用它把旧的分组表（尤其是手填的 key）带回来。用户没在账号选择器里
 * 点它，而是又填了一遍站点地址和令牌，说的仍是同一个账号——之前那条
 * 路径会把旧表整个丢掉，手填的 key 于是一次登录就没了。
 *
 * 站点地址和令牌都要对上：同一站点换了令牌，可能是另一个账号。
 */
export function savedAccount(directory, base, token) {
  const site = normalizeBase(base);
  const tok = String(token ?? "");
  if (!site || !tok) return null;
  const mine = knownAccounts(directory).filter((a) => normalizeBase(a.base) === site && a.accessToken === tok);
  if (!mine.length) return null;
  // 同一站点、同一令牌有多条（重复登录过）：取分组最多的那份，
  // 它最可能是用户填过 key 的。
  return mine.reduce((best, a) => (a.groups.length > best.groups.length ? a : best));
}
