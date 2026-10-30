// 按 host 特化的站点。
//
// 有些站点在 New API 上做了自己的改动，接口形状和原版不一样。差异写进
// 各自的文件，通用代码只在本文件分派一次：
//
//   hyxware.com  token 可以同时勾多个分组，列表接口不给分组和额度（见 hyxware.mjs）
//
// 名单之外的站点一律走原版 New API 的路径，行为与没有本文件时完全一致：
// 分组表以站点为准，token 列表一个 token 一条。新站点要特化就再加一个
// 文件、在这里挂一行，不去动通用代码。

import { listTokens } from "./api.mjs";
import { HOSTS as HYXWARE_HOSTS, groupsServed, readTokens as readHyxwareTokens } from "./hyxware.mjs";

/** hyxware.com 的实现。 */
const HYXWARE = { hosts: HYXWARE_HOSTS, readTokens: readHyxwareTokens, groupsServed };

/** 特化站点的表。 */
const SITES = [HYXWARE];

/** 地址的主机名（小写）；读不出来就是空串。 */
function hostnameOf(base) {
  try {
    return new URL(String(base ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 这个地址该用哪份特化实现，没有就返回 null。
 *
 * `hosts` 只给测试用：把它当作「这些 host 就是 hyxware」，让本机 mock
 * 冒充名单里的站点。与 runanytime.mjs 的 `isRunAnyTimeSite(base, hosts)` 同一个做法。
 */
export function siteFor(base, hosts) {
  const host = hostnameOf(base);
  if (!host) return null;
  if (hosts) return hosts.includes(host) ? HYXWARE : null;
  return SITES.find((s) => s.hosts.includes(host)) ?? null;
}

/**
 * 账号的全部 token。
 *
 * 通用站点：`GET /api/token/` 一页页读，一个 token 一条。
 * 特化站点：它自己决定怎么读（hyxware 按 token 服务的每个分组各出一条）。
 */
export async function readTokenList({ base, token, userId = "", fetchImpl, specialHosts, budgetMs } = {}) {
  const site = siteFor(base, specialHosts);
  if (site) return site.readTokens({ base, token, userId, fetchImpl, budgetMs });
  return listTokens(base, token, userId, { fetchImpl });
}

/**
 * 站点的分组表之外、token 另外认领的分组。
 *
 * 只有特化站点会回答：聚合 token 服务 A、B 两个分组，而站点公开的分组表
 * 里只有 B 时，A 也该进账号的表，否则它永远拿不到 key。通用站点返回空
 * 数组，分组表仍然完全以站点为准。
 */
export function groupsFromTokens(base, tokens, specialHosts) {
  const site = siteFor(base, specialHosts);
  if (!site) return [];
  const names = new Set();
  for (const t of tokens ?? []) {
    for (const g of site.groupsServed(t)) names.add(g);
  }
  return [...names];
}
