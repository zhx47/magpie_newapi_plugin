// 让账号保持最新。
//
// New API 站点的分组会变：管理员新增、改名或关闭分组，key 也可能被吊销。
// 账号的 metadata 里有一张分组表（见 state.mjs），登录之后只有这个模块写它：
//
//   - 站点提供的每个分组都在表里，带倍率和描述；
//   - 站点已有可用 token 的分组，直接取它的 key；
//   - 站点拒绝某个 key 时，把该分组标成 refused；
//   - 站点不再提供的分组标成 gone，key 仍然保留；
//   - 没有 key 的分组向站点要一次（开了自动创建才要）；
//     要不到就标成 tried，以后不再建第二个。
//
// 它只在 `auth.usage`（10 分钟节流）和 `auth.checkin`（每天一次）里跑，
// 绝不在 `provider.models` 里跑：Magpie 给那个钩子一共 20 秒，
// 还和其他供应商共用，所以它必须是纯读。

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
import { t } from "./i18n.mjs";

/** 一次读取信任它上次看到的结果多久。 */
export const SYNC_EVERY_MS = 10 * 60_000;

/**
 * 每个账号上次同步的时间，只放内存。写成 metadata 字段的话，
 * 只有别的东西也变了才会写回，于是分组稳定的账号每次读取都会重新同步
 * ——这正是它取代的那个 bug。
 */
const lastSync = new Map();

/**
 * 一个 key 能不能用：向站点要它能调的模型。这和列举模型时对同一分组发的
 * 是同一个请求，所以共用那个缓存键：登录、同步、列模型加起来只花
 * 每个 key 一次请求，而不是三次。
 *
 * 回答里的 `why` 就是分组的 `problem` 记的东西："refused"。
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
  // 网络抖动不是判定结果，不缓存。
  if (!out.transient) caches.keyCheck.set(cache, out, 5 * 60_000);
  return out;
}

/** 站点当前的分组，问不到就返回 null。 */
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
 * 给还没有 key 的分组找 key，来源是站点已经有的 token：
 * 每个分组取最新那条可用的 token，reveal 出它的 key。这里不创建任何东西。
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
    // 读不出来：这些分组交给用户手填
  }
  return found;
}

/**
 * 让站点为某个分组建一个 token 并取回 key。一个 token、一个分组、不重试：
 * 返回 `undefined` 表示「没要到」，调用方据此把分组标成 tried。
 *
 * 新 token 靠「列表里多出来的 id」找，不靠名字：名字会被截断并带时间戳，
 * 一旦对不上就像「什么都没建成」，于是被无限重试——一个分组就这样堆出
 * 一百多个 token。
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
 * 把账号的 `groups` 更新到最新。
 *
 * 返回 `{ groups, changed, notes }`：`groups` 是要写回的整张表，
 * 什么都没变时就是原来那张。站点连不上就原样不动。
 */
export async function syncAccount(md, { fetchImpl, autoCreate = false, now = Date.now(), force = false, budgetMs = 8000 } = {}) {
  const base = String(md?.baseURL ?? "");
  const token = String(md?.accessToken ?? md?.token ?? "");
  const userId = String(md?.userId ?? "");
  const before = groupsOf(md);
  const notes = [];

  if (!base || !token) return { groups: before, changed: false, notes: [t("not signed in")] };
  const id = `${base}|${userId || "user"}`;
  const last = lastSync.get(id) ?? 0;
  if (!force && now - last < SYNC_EVERY_MS) return { groups: before, changed: false, notes: [] };
  lastSync.set(id, now);

  // 预算用完前读到多少就写多少，剩下的留到下一次。
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

  // 站点自己的分组表：名字、倍率、描述。
  let siteGroups = null;
  try {
    siteGroups = await inTime(readGroups({ base, token, userId, fetchImpl }));
    if (!siteGroups) notes.push(t("the site's groups could not be read"));
  } catch (e) {
    notes.push(`读不到站点的分组：${String(e?.message ?? e).slice(0, 100)}`);
  }

  const next = {};
  for (const [name, info] of Object.entries(siteGroups ?? {})) {
    const old = before[name] ?? {};
    const entry = {};
    const ratio = Number(info?.ratio);
    if (ratio > 0) entry.ratio = ratio;
    if (typeof info?.desc === "string" && info.desc) entry.desc = info.desc;
    if (old.key) entry.key = old.key;
    // 问题是针对「站点手里的那个 key」的，不是针对分组：
    // 只要还持有当初被判定的那个 key，就保留这个判定。
    if (old.problem && old.problem !== "gone" && old.key) entry.problem = old.problem;
    if (!entry.key && old.tried) entry.tried = true;
    next[name] = entry;
  }

  // 站点不再提供的分组：key 留着（分组可能回来），标成 gone，
  // 这样没有地方会列出或使用它。
  if (siteGroups) {
    for (const [name, old] of Object.entries(before)) {
      if (name in next) continue;
      next[name] = { ...old, problem: "gone" };
    }
  }

  const siteNames = siteGroups ? Object.keys(siteGroups) : Object.keys(before);
  const filter = groupFilterOf(md);
  const wanted = filter.length ? siteNames.filter((g) => filter.includes(g)) : siteNames;

  // 没有 key 的分组：先看站点已有的 token，允许创建时再建新的。
  let needKeys = sortGroups(wanted.filter((g) => !next[g]?.key && !next[g]?.tried));
  if (needKeys.length) {
    const tokens = (await inTime(listTokens(base, token, userId, { fetchImpl }))) ?? [];
    const found = await keysFromTokens({ base, token, userId, groups: needKeys, tokens, fetchImpl });
    for (const [group, key] of Object.entries(found)) {
      next[group] = { ...next[group], key };
      notes.push(`从站点找到了 ${group} 的 key`);
    }
    needKeys = needKeys.filter((g) => !next[g]?.key);

    if (autoCreate && needKeys.length && left() > 1500) {
      for (const group of needKeys) {
        if (left() <= 0) break;
        const key = await inTime(createKey({ base, token, userId, label: md?.siteLabel ?? "", group, tokens, fetchImpl }));
        if (key) {
          next[group] = { ...next[group], key };
          delete next[group].tried;
          notes.push(`为 ${group} 创建了 key`);
        } else {
          next[group] = { ...next[group], tried: true };
        }
      }
    }
  }

  // 账号持有的每个 key 都校验一遍：被拒的等于没有，
  // 把它说出来，用户才会去换。
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
          notes.push(`${group}: 被站点拒绝`);
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
