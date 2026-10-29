// 把 New API 站点变成 Magpie 的模型。
//
// 模型 ID 是 `<siteLabel>/<group>/<model>`，所以同一个模型名出现在两个分组里
// 就是 Magpie 里的两个模型。每个模型各自声明 `api.npm`，正是这一点让同一个
// 分组里能同时有 chat、Responses、Messages、Gemini 四种模型，
// 也让一个模型可以列出多种协议。
//
// `api.id` 把分组和上游模型名一起编码，因为一个站点的所有分组共用一个 base URL：
// 插件的 fetch 把它解回来，再把裸的模型名写进请求。它是 percent-encode 过的
// JSON，这样名字里带 `/` 或 `:` 也不会破坏 Gemini 的 URL 路径。

import { chooseProtocols, isChatEndpoint, labelOf, protocolSuffix, wireId } from "./protocols.mjs";
import { cacheKey, caches, groupsOf } from "./state.mjs";
import { getPricing, getStatus, listModelsForKey, listUserModels } from "./api.mjs";
import { parseGroupFilter, sortGroups } from "./util.mjs";

const NPM = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
};

/** 某种协议在这个站点上的 base URL。 */
export function baseForProtocol(base, proto) {
  return proto === "gemini" ? `${base}/v1beta` : `${base}/v1`;
}

/**
 * 模型的 ID：站点、分组、模型。
 *
 * `<siteLabel>/<group>/<model>`，Magpie 显示成 `newapi/<这一串>`。
 *
 * 同一站点、同名的两个账号**故意**共用这些 ID：同站点、同分组、同模型，
 * 在选择器里多一行只是重复项，没有任何东西能区分。Magpie 按 ID 合并各账号的
 * 列表，于是一行代表两个账号，而两者都仍然是请求候选
 * （网关把同一供应商的账号放在一个池里，第一个失败会跳过）。
 * 不同站点用不同标识，同名模型是各自的 ID。
 */
export function catalogId(md, group, model, proto, suffix) {
  return `${md.siteLabel}/${group}/${model}${suffix}`;
}

/**
 * Magpie 显示的模型名：模型、站点、分组、倍率、协议。
 *
 * `gpt-4o · acme · vip · ×0.8`。站点标识是 ID 的第一段，也用来标明这一行，
 * 于是两个站点提供的同名模型显示成两行、各带自己的站点，
 * 而同一站点两个账号提供的同一个模型只显示一行。
 */
export function displayName(siteLabel, model, group, ratio, proto) {
  const bits = [model];
  if (siteLabel) bits.push(siteLabel);
  if (group) bits.push(group);
  if (ratio && Number(ratio) > 0) bits.push(`×${ratio}`);
  const label = labelOf(proto);
  if (label) bits.push(label);
  return bits.join(" · ");
}

/**
 * 一个 Magpie 模型条目（OpenCode Model，也就是 `provider.models` 返回的东西）。
 * `baseModel` 是 Magpie 或 models.dev 已经知道的同 ID 条目，
 * 提供上下文长度与能力这些默认值。
 */
export function modelEntry({ catalogId: id, md, group, model, proto, ratio, baseModel }) {
  const apiId = wireId(group, model);
  const npm = NPM[proto] ?? NPM.chat;
  const url = baseForProtocol(md.baseURL, proto);
  const entry = {
    id: id ?? catalogId(md, group, model, proto, ""),
    name: displayName(md.siteLabel, model, group, ratio, proto),
    api: { id: apiId, url, npm },
    limit: baseModel?.limit ?? { context: 0, output: 0 },
    capabilities: baseModel?.capabilities ?? {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true },
    },
    cost: baseModel?.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: baseModel?.variants ?? {},
    release_date: baseModel?.release_date ?? "",
  };
  if (baseModel?.options) entry.options = baseModel.options;
  if (baseModel?.headers) entry.headers = baseModel.headers;
  return entry;
}

/**
 * 读取（并缓存）站点关于模型的全部信息：模型广场、状态，
 * 以及每个分组 key 的一份 `/v1/models`。单个分组失败不抛错，
 * 那个分组只是从结果里缺席。
 */
export async function discover({ md, fetchImpl, signal }) {
  const base = md.baseURL;
  const token = String(md.accessToken ?? md.token ?? "");
  // 状态对列举只是装饰（额度单位、签到开关）：站点把它藏起来或弄坏，
  // 不能因此连模型也看不到。
  let status = null;
  try {
    status = await caches.status.getOr(cacheKey(base, "status"), 10 * 60_000, () => getStatus(base, { fetchImpl, signal }));
  } catch {
    status = null;
  }

  const pricing = await caches.pricing.getOr(cacheKey(base, "pricing"), 60_000, () =>
    getPricing(base, token, md.userId, { fetchImpl, signal }),
  );

  const groups = {};
  const wanted = parseGroupFilter(md.groupFilter);
  const groupsMap = groupsOf(md);
  // 只有持有可用 key 的分组才能用 key 列模型；没有 key 的由下面的
  // 账号级列表补上。
  const names = Object.keys(groupsMap).filter(
    (g) => (!wanted.length || wanted.includes(g)) && groupsMap[g].key && !groupsMap[g].problem,
  );

  await Promise.all(
    names.map(async (group) => {
      const key = groupsMap[group].key;
      try {
        const models = await caches.modelList.getOr(cacheKey(base, group, key), 60_000, () =>
          listModelsWithRetry(base, key, { fetchImpl, signal }),
        );
        if (models.length) groups[group] = sortGroups([...(groups[group] ?? []), ...models]);
      } catch {
        // key 已失效：同步会标出来，这里先跳过这个分组
      }
    }),
  );

  // 一个 key 都没有时，站点的账号级列表仍然能说明每个分组会提供什么模型，
  // 用户就知道该为哪个分组补 key。
  const siteGroups = Object.keys(md.groups ?? {});
  const noKeys = names.length === 0 && siteGroups.length > 0;
  if (noKeys) {
    for (const group of siteGroups) {
      try {
        const models = await caches.userModels.getOr(cacheKey(base, "user-models", group), 60_000, () =>
          listUserModels(base, token, md.userId, group, { fetchImpl, signal }),
        );
        if (models.length) groups[group] = sortGroups(models);
      } catch {
        // 这个分组这次先不列
      }
    }
  }

  // 某个分组没有 key 能回答：退回账号级列表——它不需要推理 key，
  // 所以分组仍然可见（用量卡片会提示它没有 key）。
  const missing = names.filter((g) => !groups[g]);
  if (missing.length) {
    try {
      const all = await caches.userModels.getOr(cacheKey(base, "user-models"), 60_000, () =>
        listUserModels(base, token, md.userId, "", { fetchImpl, signal }),
      );
      if (all.length) {
        for (const group of missing) {
          // 不带 group 的 /api/user/models 是所有可用分组的并集，
          // 它说不出是哪一个，所以只用来填「用户贴了 key、但那次请求失败」
          // 的分组。
          groups[group] = sortGroups(all);
        }
      }
    } catch {
      // 还是没有：这个分组这次没有模型
    }
  }

  return { status, pricing, groups };
}
/**
 * 用分组 key 调 `/v1/models`，连接本身失败时重试一次：
 * 一次掉线不该让整个分组的模型在整个缓存周期里都看不见。
 */
async function listModelsWithRetry(base, key, opts) {
  try {
    return await listModelsForKey(base, key, opts);
  } catch (e) {
    if (e?.status !== 0) throw e;
    return listModelsForKey(base, key, opts);
  }
}

/** 模型支持的端点类型，来自模型广场（不知道时为空）。 */
function endpointsOf(pricing, model) {
  return pricing?.models?.get(String(model).toLowerCase())?.endpoints ?? [];
}

/**
 * 所有分组的全部模型，转成 Magpie 条目，按 catalog id 索引。
 * `options` 是插件的那些开关。
 */
export function buildModels({ md, groups, pricing, options = {} }) {
  const out = {};
  const perGroup = {};
  const groupRatio = pricing?.groupRatio ?? {};
  const ratioByGroup = {};
  for (const [name, info] of Object.entries(md.groups ?? {})) {
    if (info && Number(info.ratio) > 0) ratioByGroup[name] = Number(info.ratio);
  }

  for (const [group, models] of Object.entries(groups)) {
    if (!Array.isArray(models) || !models.length) continue;
    perGroup[group] = models.length;
    const ratio = groupRatio[group] ?? ratioByGroup[group] ?? 0;
    for (const model of models) {
      const endpoints = endpointsOf(pricing, model);
      // 只会 embeddings、图片、视频或 rerank 的模型不是聊天模型：
      // Magpie 没有东西可以发给它。
      if (endpoints.length && !endpoints.some(isChatEndpoint)) continue;

      const protos = chooseProtocols(endpoints, model, options);
      for (let i = 0; i < protos.length; i++) {
        const proto = protos[i];
        // 第一个协议保留不带后缀的 ID，这样打开「列出所有协议」开关
        // 也不会让 agent 已经存下的选择失效。
        const suffix = i === 0 ? "" : protocolSuffix(proto);
        const id = catalogId(md, group, model, proto, suffix);
        const baseModel = options.hostModels?.[catalogId(md, group, model, proto, "")];
        out[id] = modelEntry({ catalogId: id, md, group, model, proto, ratio, baseModel });
      }
    }
  }

  return { models: out, perGroup, ratioByGroup, groupRatio };
}
