// 登录：用户输入站点地址和访问令牌之后发生的事。
//
// New API 把凭据分成两种：后台的访问令牌（/api/* 的权限）和各分组的 API key
// （推理请求带的那个 `sk-...`）。这个钩子把两者都收上来：
//   - 令牌，用来认账号、读余额、签到；
//   - 它能找到或 reveal 出来的每个分组 key；
//   - 然后逐个分组问还缺的那些，一个分组一个问题。
//
// 这些问题是 Magpie 的 `ask(inputs)` 钩子：它可以在两次提问之间去查询，
// 所以能先从站点读出分组，再按名字逐个问，而不是让人在一个文本框里拼。
//
// 管理接口关着不会让登录失败：/api/pricing 只对管理员开放的站点照样能登录，
// 模型从 /v1/models 拿。只有访问令牌本身被拒才算失败。

import {
  createToken,
  getStatus,
  getUserGroups,
  getUserSelf,
  getPricing,
  isAuthError,
  listTokens,
  revealTokenKeys,
  tokenUsable,
} from "./api.mjs";
import {
  cleanLabel,
  hostOf,
  isMaskedKey,
  normalizeApiKey,
  normalizeBase,
  sortGroups,
} from "./util.mjs";
import { TtlCache, cacheKey, groupsOf, knownAccounts } from "./state.mjs";
import { checkKey, createKey } from "./sync.mjs";
import { createdIn, forgetLogin, loginKey, markAsked, wasAsked } from "./session.mjs";
import { t } from "./i18n.mjs";

const PROVIDER = "newapi";

/** 校验站点地址这一问，按 Magpie 的 prompt 约定：返回错误消息或不返回。 */
export function validateBase(value) {
  const base = normalizeBase(value);
  if (!base) return t("Enter an http(s) URL, e.g. https://newapi.example.com");
  return undefined;
}

/** 访问令牌这一问：JWT 或不透明令牌，绝不是 sk- 开头的推理 key。 */
export function validateAccessToken(value) {
  const s = String(value ?? "").trim();
  if (!s) return t("Enter the site's access token (not an sk- API key)");
  if (/^sk-/i.test(s)) return t("That is a relay API key. Use the access token from the site's account settings.");
  return undefined;
}

/** 所有还能用于推理的 token，按它服务的分组归类。 */
export function tokensByGroup(tokens, defaultGroupName) {
  const out = {};
  for (const t of tokens) {
    if (!tokenUsable(t)) continue;
    const group = t.group || defaultGroupName || "default";
    (out[group] ??= []).push(t);
  }
  return out;
}

// 提问是一次调用问一个，每次都要站点分组：没有这层缓存，
// 三个分组缺失的登录会把六个端点读四遍。
const surveys = new TtlCache(60_000);

/** 最初几次调用查到的东西：提问和最终结果都用它。 */
async function surveyOnce(inputs, fetchImpl) {
  const base = normalizeBase(inputs?.baseURL);
  const token = String(inputs?.accessToken ?? "").trim();
  const userId = String(inputs?.userId ?? "").trim();
  if (!base) return { failed: t("Enter an http(s) URL, e.g. https://newapi.example.com") };
  if (!token) return { failed: t("Enter the site's access token (not an sk- API key)") };

  let status = null;
  try {
    status = await getStatus(base, { fetchImpl, timeout: 8000 });
  } catch {
    // 状态只是装饰：站点不返回它也能用
  }

  let self;
  let unreachable = false;
  try {
    self = await getUserSelf(base, token, userId, { fetchImpl });
  } catch (e) {
    if (isAuthError(e)) {
      return {
        failed: userId
          ? t("The site refused the access token ({why}). Check the token, and the user id.", { why: describe(e) })
          : t("The site refused the access token ({why}). Older New API needs your user id — fill the User id field.", {
              why: describe(e),
            }),
      };
    }
    // 网络抖动不能让登录白填：保住用户敲的内容，让下一次列举去报错。
    // 完全连不上的站点是另一回事：关于令牌什么都没验证到。
    unreachable = e?.status === 0;
    self = { id: Number(userId) || 0, username: "", group: "", quota: 0, usedQuota: 0, requestCount: 0 };
  }

  const [groups, pricing, tokens] = await Promise.all([
    getUserGroups(base, token, userId, { fetchImpl }).catch(() => ({})),
    getPricing(base, token, userId, { fetchImpl }).catch(() => null),
    listTokens(base, token, userId, { fetchImpl }).catch(() => []),
  ]);

  const byGroup = tokensByGroup(tokens, self.group);
  let revealed = new Map();
  try {
    const ids = Object.values(byGroup).flat().map((t) => t.id);
    revealed = await revealTokenKeys(base, token, userId, ids, { fetchImpl });
  } catch {
    revealed = new Map();
  }

  // 每个分组最新的一条可用 token，能读到就带上它的 key。
  const fromTokens = {};
  for (const [group, list] of Object.entries(byGroup)) {
    const newest = [...list].sort((a, b) => b.id - a.id)[0];
    const key = newest ? revealed.get(newest.id) : "";
    if (key) fromTokens[group] = key;
  }

  return { base, token, userId, status, self, unreachable, groups, pricing, tokens, revealed, byGroup, fromTokens };
}

/** survey 的结果按它的输入缓存一分钟。 */
function survey(inputs, fetchImpl) {
  const base = normalizeBase(inputs?.baseURL);
  const token = String(inputs?.accessToken ?? "").trim();
  if (!base || !token) return surveyOnce(inputs, fetchImpl);
  const key = cacheKey(base, "signin", token, String(inputs?.userId ?? ""));
  return surveys.getOr(key, 60_000, () => surveyOnce(inputs, fetchImpl));
}

/**
 * 这次登录到目前为止拿到的 key，一张「分组 → key」的表：
 * 站点给的、创建步骤建的、用户贴的，以及——选中已有账号时——它本来持有的。
 */
export function keysSoFar(found, inputs, picked) {
  const out = { ...found.fromTokens };

  const fromPick = {};
  if (picked) {
    for (const [group, g] of Object.entries(groupsOf(picked.metadata))) {
      if (g.key && !g.problem) fromPick[group] = g.key;
    }
  }
  const pasted = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (!key.startsWith("groupkey:")) continue;
    const group = key.slice("groupkey:".length);
    const k = normalizeApiKey(value);
    if (group && k && !isMaskedKey(k)) pasted[group] = k;
  }

  // 后面的来源覆盖前面的：手填的 key 胜过站点给的。
  for (const src of [fromPick, createdIn(loginKey(inputs, found.base)), pasted]) {
    for (const [group, key] of Object.entries(src)) {
      if (key) out[group] = key;
    }
  }
  return out;
}

/** 站点提供、还缺 key 的分组，按提问顺序。 */
function pendingGroupsOf(found, keys) {
  return sortGroups(Object.keys(found.groups ?? {}).filter((g) => !keys[g]));
}

/**
 * 开头几问之后的问题，Magpie 一次问一个。
 * 每个缺 key 的分组各占一个输入框，标题就是分组名；已回答的问题会传回来，
 * 所以再问一次就是问下一个。
 */
export async function nextQuestion(inputs, { directory, fetchImpl } = {}) {
  // Magpie 已经有的账号不需要凭记忆重敲令牌：第一问就把本插件登录过的站点
  // 列出来，选中一个就等于回答了站点地址、令牌、user id 和标识。
  inputs = resolvePick(inputs, directory);
  if (!inputs?.baseURL && inputs?.pick === undefined) {
    const known = knownAccounts(directory);
    if (known.length) {
      return {
        type: "select",
        key: "pick",
        message: t("Which account? Picking one reuses the access token Magpie already has."),
        options: [
          ...known.map((a) => ({
            label: `${a.accountId} — ${a.base.replace(/^https?:\/\//, "")}`,
            value: a.key,
            hint: `${a.groups.length} · ${a.checkin === "off" ? t("Auto check-in off · check in on the site") : t("Daily check-in")}`,
          })),
          { label: t("Another site (paste its access token)"), value: NEW_SITE },
        ],
      };
    }
  }

  // 开头几问不需要查询。
  if (!inputs?.baseURL) return prompt("baseURL");
  if (!inputs?.accessToken) return prompt("accessToken");
  if (inputs?.userId === undefined) return prompt("userId");
  if (inputs?.siteLabel === undefined) return prompt("siteLabel");

  const found = await survey(inputs, fetchImpl);
  if (found.failed) {
    // 令牌不行：再问一遍，别继续问那些没有令牌根本答不了的问题。
    return { ...prompt("accessToken"), message: `${found.failed}\n${t("Access token")}` };
  }

  const picked = knownAccounts(directory).find((a) => a.key === inputs?.pick);
  const keys = keysSoFar(found, inputs, picked);
  let pending = pendingGroupsOf(found, keys);
  const autoCreate = inputs?.autoCreate;

  // 先试创建：站点自己建的 token 不用人打字，
  // 只有它给不出来的才该让人手填。
  if (pending.length && autoCreate === undefined) {
    const names = pending.join(", ");
    return {
      type: "select",
      key: "autoCreate",
      message:
        pending.length === 1
          ? t("{n} group without a key ({names}). Let the site create one for each?", { n: 1, names })
          : t("{n} groups without a key ({names}). Let the site create one for each?", { n: pending.length, names }),
      options: [
        { label: t("Yes, create a token for each"), value: "yes" },
        { label: t("No, I will paste them"), value: "no" },
      ],
    };
  }

  // 每个分组只向站点要一次，要没要到都记在会话里（不写进 inputs）。
  // 建好的 key 立刻算进「已有」，所以不再多问一个「要接着填吗」，
  // 直接问仍然缺的那些。
  const session = loginKey(inputs, found.base);
  let left = pending;
  if (pending.length && autoCreate === "yes") {
    const todo = pending.filter((group) => !wasAsked(session, group));
    for (const group of todo) {
      const key = await createKey({
        base: found.base,
        token: found.token,
        userId: found.userId,
        label: cleanLabel(inputs?.siteLabel, hostOf(found.base)),
        group,
        tokens: found.tokens ?? [],
        fetchImpl,
      }).catch(() => undefined);
      markAsked(session, group, key);
    }
    left = pending.filter((g) => !keys[g] && !createdIn(session)[g]);
  }

  // 站点给不出来的，逐个分组问。回答存在 groupkey:<分组> 下，
  // 已经问过的分组不会再问。
  if (left.length) {
    for (const group of left) {
      const at = inputKey(group);
      if (typeof inputs?.[at] === "string") continue;

      // 之前某轮填的 key 先校验再问下一题：只有站点能说它行不行，
      // 被拒的就再问一次，而不是带进账号里。
      for (const [key, value] of Object.entries(inputs ?? {})) {
        if (!key.startsWith("groupkey:") || !value) continue;
        const forGroup = key.slice("groupkey:".length);
        const verdict = await checkKey(found.base, forGroup, value, { fetchImpl });
        if (verdict.ok || verdict.transient) continue;
        return {
          type: "password",
          key,
          message: t('API key for group "{group}" — the site refused it', { group: forGroup }),
          placeholder: t("paste another key, or leave empty to skip this group"),
        };
      }

      return {
        type: "password",
        key: at,
        message: t('API key for group "{group}"', { group }),
        placeholder: t("sk-... (leave empty to skip this group)"),
      };
    }
  }

  if (inputs?.checkin === undefined) return prompt("checkin");
  return null;
}

const FIRST_PROMPTS = {
  baseURL: {
    type: "text",
    key: "baseURL",
    message: t("New API base URL"),
    placeholder: "https://newapi.example.com",
    validate: validateBase,
  },
  accessToken: {
    type: "password",
    key: "accessToken",
    message: t("Access token"),
    placeholder: t("Enter the site's access token (not an sk- API key)"),
    validate: validateAccessToken,
  },
  userId: {
    type: "text",
    key: "userId",
    message: t("User id (old New API only; leave empty)"),
    placeholder: "1",
  },
  siteLabel: {
    type: "text",
    key: "siteLabel",
    message: t("Site label (the model prefix; empty uses the host)"),
    placeholder: "example",
  },
  checkin: {
    type: "select",
    key: "checkin",
    message: t("Daily check-in"),
    options: [
      { label: t("Automatic"), value: "auto" },
      { label: t("Off (check in on the site yourself)"), value: "off" },
    ],
  },
};

function prompt(key) {
  return { ...FIRST_PROMPTS[key] };
}

/** 某个分组手填的 key 存在哪个输入键下。只用于这一次问答，不写进账号。 */
export function inputKey(group) {
  return `groupkey:${group}`;
}

/** 表示「这个插件还没登录过的站点」的那个选择值。 */
export const NEW_SITE = "__new__";

/**
 * 选中一个已有账号时它给出的答案：站点地址、令牌、标识，
 * 就按 Magpie 保存的那份。用户自己敲的答案优先，
 * 所以选中的账号也能指向另一个令牌。
 */
export function resolvePick(inputs, directory) {
  const pick = inputs?.pick;
  if (!pick || pick === NEW_SITE) return inputs;
  const known = knownAccounts(directory).find((a) => a.key === pick);
  if (!known) return inputs;
  return {
    ...inputs,
    baseURL: inputs.baseURL || known.base,
    accessToken: inputs.accessToken || known.accessToken,
    userId: inputs.userId ?? known.userId,
    siteLabel: inputs.siteLabel || known.siteLabel,
  };
}

/**
 * 完整的登录。`directory` 是 Magpie 的配置目录，
 * 已保存的账号就是从这里读的。
 */
export async function signIn(rawInputs, { directory, fetchImpl } = {}) {
  const inputs = resolvePick(rawInputs, directory);
  const found = await survey(inputs, fetchImpl);
  if (found.failed) return { type: "failed", error: found.failed };
  const { base, token, userId, status, self, unreachable, groups, pricing, tokens } = found;

  const label = cleanLabel(inputs?.siteLabel, hostOf(base));
  const accountId = `${label} (${self.username || self.id || userId || "user"})`;
  const picked = knownAccounts(directory).find((a) => a.key === inputs?.pick);

  const keys = keysSoFar(found, inputs, picked);

  // 站点认识的分组，加上选中的账号有、但这一轮没看到的
  // （站点的某个接口可能关着）。
  const known = new Set([
    ...Object.keys(groups ?? {}),
    ...Object.keys(keys),
    ...Object.keys(picked ? groupsOf(picked.metadata) : {}),
  ]);
  const siteGroups = [...known];

  // 没走问答就直接答 yes 的调用方（命令行、服务器）在这里创建。
  const session = loginKey(inputs, base);
  if (inputs?.autoCreate === "yes") {
    // 问答里已经要过的分组不再要第二次。没走过问答的调用方（命令行、
    // 服务器）在这里补上；要没要到都记进会话，免得 authorize 再建一轮。
    const todo = sortGroups(siteGroups.filter((g) => !keys[g] && !wasAsked(session, g)));
    for (const group of todo) {
      const key = await createKey({ base, token, userId, label, group, tokens, fetchImpl }).catch(() => undefined);
      markAsked(session, group, key);
      if (key) keys[group] = key;
    }
  }

  // 什么都连不上、也没填任何 key：这不算登录成功。
  if (unreachable && !Object.keys(keys).length) {
    return {
      type: "failed",
      error: t("Could not reach {base}. Check the URL and the network, then sign in again.", { base }),
    };
  }

  // 账号就一张表：站点提供的每个分组，带倍率、key，
  // 以及（如果有）key 的问题。
  const groupsMap = {};
  const had = picked ? groupsOf(picked.metadata) : {};
  for (const name of sortGroups([...siteGroups, ...Object.keys(keys)])) {
    const info = groups?.[name] ?? {};
    const entry = {};
    const ratio = Number(info.ratio ?? had[name]?.ratio);
    if (ratio > 0) entry.ratio = ratio;
    const desc = String(info.desc ?? had[name]?.desc ?? "");
    if (desc) entry.desc = desc;
    if (keys[name]) entry.key = keys[name];
    // 选中的账号原来那条 key 就是之前被拒的那条：这次登录给了它一次机会，
    // 于是判定保留到下一次同步再校验。
    else if (had[name]?.problem) entry.problem = had[name].problem;
    groupsMap[name] = entry;
  }

  // 这次登录结束，会话记录没用了。
  forgetLogin(loginKey(inputs, base));

  return {
    type: "success",
    key: token,
    metadata: interviewKeysCleared({
      accountId,
      email: accountId, // host.js's whoOf() 用它认账号
      baseURL: base,
      userId: self.id || Number(userId) || undefined,
      username: self.username || "",
      displayName: self.displayName || "",
      siteLabel: label,
      groups: groupsMap,
      checkin: inputs?.checkin !== "off" ? "auto" : "off",
      checkinBlocked: "",
      status: {
        quotaPerUnit: status?.quotaPerUnit ?? 500000,
        currency: status?.displayInCurrency ?? true,
        quotaDisplayType: status?.quotaDisplayType ?? "",
        currencySymbol: status?.customCurrencySymbol ?? "",
        currencyRate: status?.customCurrencyExchangeRate ?? 1,
        usdExchangeRate: status?.usdExchangeRate ?? 1,
        checkin: status?.checkinEnabled ?? false,
        turnstile: status?.turnstile ?? false,
        systemName: status?.systemName ?? "",
        version: status?.version ?? "",
      },
      pricingVersion: pricing?.pricingVersion ?? "",
      updatedAt: new Date().toISOString(),
    }, inputs),
  };
}

/**
 * 把只用于问答的键从 metadata 里抹掉。
 *
 * Magpie 的 save() 是 `{...inputs, ...result.metadata}`：问答的答案会原样
 * 留在账号 metadata 里，包括访问令牌（它已经在 auth.key 里了，不该再存一份）、
 * 选中的账号、创建开关，以及每个 `groupkey:<分组>`。
 * 置成 undefined 之后 JSON 序列化就不会写出来。
 */
function interviewKeysCleared(metadata, inputs) {
  const out = { ...metadata };
  for (const key of INTERVIEW_KEYS) out[key] = undefined;
  for (const key of Object.keys(inputs ?? {})) {
    if (key.startsWith("groupkey:")) out[key] = undefined;
  }
  return out;
}

/** 只用于问答、不该留在账号里的键。 */
const INTERVIEW_KEYS = ["accessToken", "pick", "autoCreate"];


function describe(e) {
  const message = String(e?.message ?? e ?? "").trim();
  return message.length > 160 ? `${message.slice(0, 160)}…` : message || "no reason given";
}

export { PROVIDER };
