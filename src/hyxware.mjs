// hyxware.com：一个 token 可以同时勾多个分组的站点。
//
// 原版 New API 的 `GET /api/token/` 一次给出一个 token 的全貌（分组、额度、
// 过期时间），一个 token 只服务一个分组。这个站点的列表只回
// id/name/key/status/创建时间：
//
//   GET /api/token/?p=0&page_size=100
//   → { id, name, key(掩码), status, created_time, accessed_time }
//
// 分组和额度在详情里，而且 `groups` 是数组——一个 token 可以同时服务
// chat 和 claude 两个分组：
//
//   GET  /api/token/42       → { group: "chat", groups: ["chat"], unlimited_quota: true, ... }
//   POST /api/token/42/key   → { key: "..." }      （GET 这条在这个站点上是 404）
//
// 所以这里只做一件事：把列表读成通用代码期待的形状。每个 token 按它
// 服务的**每一个**分组各出现一条（同一个 key 出现多次），分组由 `group`
// 和 `groups` 拼接去重。通用逻辑「每个分组取最新一条 token」于是给每个
// 分组都拿到那条 key，聚合 token 覆盖到的分组不会因为「没有单独为它建的
// token」被判成缺 key。
//
// 只有 sites.mjs 在这个 host 上会调用本文件，通用路径完全不知道它。

import { listTokens, newapiFetch, revealTokenKeys, tokenUsable } from "./api.mjs";
import { isMaskedKey } from "./util.mjs";

/** 这个站点的 host。sites.mjs 按它分派。 */
export const HOSTS = ["hyxware.com"];

/** 详情接口一次问几个：一个账号二十来个 token，够快又不至于打满站点。 */
const DETAIL_CONCURRENCY = 6;

/** 补齐详情最多花多久；没赶上的这一轮不认领分组，下一轮再来。 */
const DETAIL_BUDGET_MS = 6000;

/**
 * 详情缓存：站点 + id → 详情。分组和额度在几分钟里几乎不变，
 * 而一次同步可能读好几遍列表（同步自己、建完 key 之后再看一眼），
 * 每次都把二十来个详情重新问一遍是纯浪费。
 */
const details = new Map();
const DETAIL_TTL = 10 * 60_000;

function cachedDetail(key) {
  const hit = details.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    details.delete(key);
    return null;
  }
  return hit.value;
}

function keepDetail(key, value) {
  details.set(key, { value, expires: Date.now() + DETAIL_TTL });
  while (details.size > 256) details.delete(details.keys().next().value);
}

/**
 * 站点的 token → 通用代码要的 token 列表（每个服务过的分组一条）。
 *
 * 列表里没有分组，就逐个问详情；详情说还能用、而列表里还是掩码的，
 * 再问 `/:id/key` 取明文。详情读不到的 token 这一轮不参与：不知道它
 * 服务哪个分组，硬塞进默认分组只会把别的分组的 key 弄错。
 */
export async function readTokens({ base, token, userId = "", fetchImpl, budgetMs = DETAIL_BUDGET_MS } = {}) {
  const listed = await listTokens(base, token, userId, { fetchImpl });
  if (!listed.length) return [];

  const deadline = Date.now() + budgetMs;
  const found = new Map();
  await eachLimited(listed, DETAIL_CONCURRENCY, async (t) => {
    if (!t.id || Date.now() > deadline) return;
    const hit = cachedDetail(`${base}|${t.id}`);
    if (hit) {
      found.set(t.id, hit);
      return;
    }
    try {
      const { payload } = await newapiFetch(base, `/api/token/${t.id}`, { fetchImpl, token, userId });
      const d = payload?.data ?? payload;
      if (d && typeof d === "object") {
        found.set(t.id, d);
        keepDetail(`${base}|${t.id}`, d);
      }
    } catch {
      // 详情读不到：这个 token 这一轮不认领分组。
    }
  });

  // 只对「详情说它还能用、但列表里是掩码」的 token 取明文：
  // 一百多个 token 每个都问一遍是白花请求，禁用/过期的更没必要问。
  const need = [];
  for (const t of listed) {
    const d = found.get(t.id);
    if (!d || !tokenUsable(merged(t, d)) || !isMaskedKey(t.key)) continue;
    if (!need.includes(t.id)) need.push(t.id);
  }
  let revealed = new Map();
  if (need.length) {
    try {
      revealed = await revealTokenKeys(base, token, userId, need, { fetchImpl });
    } catch {
      // 没有 reveal 权限：这些分组的 key 只能手填。
      revealed = new Map();
    }
  }

  const out = [];
  for (const t of listed) {
    const d = found.get(t.id);
    if (!d) continue;
    const full = merged(t, d);
    const key = revealed.get(t.id) ?? (isMaskedKey(t.key) ? "" : String(t.key ?? "").trim());
    for (const group of groupsServed(t, d)) out.push({ ...full, group, key });
  }
  return out;
}

/**
 * 一个 token 服务的分组：`group` 加上 `groups` 数组，去重且保持顺序。
 * 一个都没有才落到默认分组。
 */
export function groupsServed(listed, detail) {
  const names = [];
  const push = (v) => {
    const s = String(v ?? "").trim();
    if (s && !names.includes(s)) names.push(s);
  };
  push(detail?.group);
  for (const g of Array.isArray(detail?.groups) ? detail.groups : []) push(g);
  push(listed?.group);
  return names.length ? names : ["default"];
}

/** 列表的 token 加上详情里才有的额度字段，缺什么补什么。 */
function merged(t, d) {
  return {
    ...t,
    status: Number(d?.status ?? t.status) || 1,
    expiredTime: d?.expired_time !== undefined ? Number(d.expired_time) || -1 : t.expiredTime,
    remainQuota: d?.remain_quota !== undefined ? Number(d.remain_quota) || 0 : t.remainQuota,
    unlimitedQuota: d?.unlimited_quota !== undefined ? d.unlimited_quota === true : t.unlimitedQuota,
    modelLimitsEnabled: d?.model_limits_enabled !== undefined ? d.model_limits_enabled === true : t.modelLimitsEnabled,
    modelLimits: d?.model_limits !== undefined ? String(d.model_limits ?? "") : t.modelLimits,
  };
}

/** 有上限的并发遍历，避免把站点的接口一起打满。 */
async function eachLimited(items, limit, fn) {
  let at = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (at < items.length) await fn(items[at++]);
  });
  await Promise.all(workers);
}
