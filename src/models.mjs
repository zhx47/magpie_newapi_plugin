// Turning a New API site into Magpie models.
//
// A model id is `<siteLabel>/<group>/<model>`, so the same model name in two
// groups is two models in Magpie. Each one declares its own `api.npm`,
// which is what lets one group hold chat, Responses, Messages and Gemini
// models side by side, and one model offer more than one of them.
//
// `api.id` encodes the group and the wire model, because every group of a
// site shares one base URL: the plugin's fetch reads it back and puts the
// bare model in the request. It is percent-encoded JSON so that a model name
// with `/` or `:` cannot break Gemini's URL path.

import { chooseProtocols, isChatEndpoint, labelOf, protocolSuffix, wireId } from "./protocols.mjs";
import { cacheKey, caches } from "./state.mjs";
import { getPricing, getStatus, listModelsForKey, listUserModels } from "./api.mjs";
import { parseGroupFilter, sortGroups } from "./util.mjs";

const NPM = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
};

/** The base URL of a protocol for this site. */
export function baseForProtocol(base, proto) {
  return proto === "gemini" ? `${base}/v1beta` : `${base}/v1`;
}

/**
 * The model's id: the site, the group and the model.
 *
 * `<siteLabel>/<group>/<model>`, and Magpie shows it as `newapi/<that>`.
 *
 * Two accounts of one site with the same label share these ids on purpose:
 * same site, same group, same model, so a second copy in the picker would be
 * a duplicate with nothing to tell it apart. Magpie merges accounts' lists by
 * id, so one row stands for both, and both stay request candidates (the
 * gateway pools a provider's accounts; a first one that fails is passed over).
 * A different site has a different label, and its same-named model is its own
 * id.
 */
export function catalogId(md, group, model, proto, suffix) {
  return `${md.siteLabel}/${group}/${model}${suffix}`;
}

/**
 * The name Magpie shows: the model, the site, the group, the ratio and the
 * protocol.
 *
 * `gpt-4o · 42API · vip · ×0.8`. The site label is the first id segment and
 * names the row, so a model served by two sites reads as two rows with
 * different sites, and a model served by two accounts of one site reads as
 * one row.
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
 * One Magpie model entry (an OpenCode Model, as `provider.models` returns).
 * `baseModel`, when the provider already had this id, gives the limits and
 * capabilities Magpie or models.dev knew.
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
 * Fetch (and cache) everything the site says about its models: the pricing
 * square, the status, and one `/v1/models` per group key. Nothing here
 * throws for a single group: a group whose key fails is simply left out.
 */
export async function discover({ md, groupKeys, fetchImpl, signal }) {
  const base = md.baseURL;
  const token = String(md.accessToken ?? md.token ?? "");
  // Status is decoration for the listing (balance units, check-in switches):
  // a site that hides or breaks it must not hide the models too.
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
  const tokenInfo = {};
  const wanted = parseGroupFilter(md.groupFilter);
  const names = Object.keys(groupKeys).filter((g) => !wanted.length || wanted.includes(g));

  await Promise.all(
    names.map(async (group) => {
      const keys = groupKeys[group] ?? [];
      for (const key of keys) {
        try {
          const models = await caches.modelList.getOr(cacheKey(base, group, key), 60_000, () =>
            listModelsWithRetry(base, key, { fetchImpl, signal }),
          );
          if (models.length) {
            groups[group] = sortGroups([...(groups[group] ?? []), ...models]);
            tokenInfo[key] = tokenInfo[key] ?? {};
            break;
          }
        } catch {
          // a dead key: the next one may answer; all dead, the group stays out
        }
      }
    }),
  );

  // No key at all: the site's account-scoped list still says which models
  // each group would serve, so the user sees what to paste a key for.
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
        // that group stays out this time
      }
    }
  }

  // No key answered for a group: fall back to the account-scoped list, which
  // does not need a relay key, so the group is still visible (with a warning
  // in the usage card that it has no key).
  const missing = names.filter((g) => !groups[g]);
  if (missing.length) {
    try {
      const all = await caches.userModels.getOr(cacheKey(base, "user-models"), 60_000, () =>
        listUserModels(base, token, md.userId, "", { fetchImpl, signal }),
      );
      if (all.length) {
        for (const group of missing) {
          // /api/user/models with no group is the union of every usable
          // group; it cannot say which one, so it only fills a group the
          // user pasted a key for and whose key call failed.
          groups[group] = sortGroups(all);
        }
      }
    } catch {
      // still nothing: the group has no models this time
    }
  }

  return { status, pricing, groups, tokenInfo };
}
/**
 * `/v1/models` for a group key, retried once when the connection itself
 * failed: a dropped socket must not hide a whole group's models for the
 * cache's lifetime.
 */
async function listModelsWithRetry(base, key, opts) {
  try {
    return await listModelsForKey(base, key, opts);
  } catch (e) {
    if (e?.status !== 0) throw e;
    return listModelsForKey(base, key, opts);
  }
}

/** The endpoint types a model supports, from pricing (empty when unknown). */
function endpointsOf(pricing, model) {
  return pricing?.models?.get(String(model).toLowerCase())?.endpoints ?? [];
}

/**
 * Every model of every group as Magpie entries, keyed by catalog id.
 * `options` are the plugin's switches.
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
      // A model that only speaks embeddings, images, video or rerank is not
      // a chat model: Magpie would have nothing to send it.
      if (endpoints.length && !endpoints.some(isChatEndpoint)) continue;

      const protos = chooseProtocols(endpoints, model, options);
      for (let i = 0; i < protos.length; i++) {
        const proto = protos[i];
        // The first protocol keeps the bare id, so turning the extra-protocol
        // switch on never invalidates a pick an agent already saved.
        const suffix = i === 0 ? "" : protocolSuffix(proto);
        const id = catalogId(md, group, model, proto, suffix);
        const baseModel = options.hostModels?.[catalogId(md, group, model, proto, "")];
        out[id] = modelEntry({ catalogId: id, md, group, model, proto, ratio, baseModel });
      }
    }
  }

  return { models: out, perGroup, ratioByGroup, groupRatio };
}
