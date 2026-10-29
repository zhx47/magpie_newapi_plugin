// OpenCode v1 插件入口：供应商的声明，以及 Magpie 调用的那些钩子。
//
// 一个供应商 `newapi`，一个站点一个账号。站点的一切
// （分组、key、模型、余额、签到）都挂在账号上，所以两个站点从不共享状态。
// 模型 ID 里带站点和分组，于是同名模型出现在两个分组里就是 Magpie 的两个模型。

import { ChallengeError, isAuthError } from "./src/api.mjs";
import { blockedResult, offResult, pressCheckin } from "./src/checkin.mjs";
import { makeFetch } from "./src/fetch.mjs";
import { buildModels, discover } from "./src/models.mjs";
import { PROVIDER, nextQuestion, signIn } from "./src/signin.mjs";
import { accountOf, caches, groupsOf, runtimeMd } from "./src/state.mjs";
import { syncAccount } from "./src/sync.mjs";
import { buildUsage } from "./src/usage.mjs";
import { languageOf, t } from "./src/i18n.mjs";

const pkg = {
  name: "New API",
  npm: "@ai-sdk/openai-compatible",
  api: "",
};

/**
 * 供应商的开关（Magpie 的 auth.options 形状）。
 * 文案是英文原文，经过 t() 换成 Magpie 当前的语言。
 */
function optionList() {
  return [
    {
      key: "auto-create-keys",
      label: t("Create missing group keys"),
      description: t("Ask the site to create an API token for each group Magpie has no key for."),
      default: false,
      confirm: t("This creates API tokens named magpie-... on your New API site."),
    },
    {
      key: "expose-all-protocols",
      label: t("List every protocol a model supports"),
      description: t("Show a separate model for chat, Responses, Messages and Gemini when the site supports more than one."),
      default: false,
    },
    {
      key: "prefer-responses",
      label: t("Prefer Responses for GPT-5 and Codex models"),
      description: t("Send GPT-5 class models on OpenAI's Responses API when the site offers it."),
      default: true,
    },
    {
      key: "prefer-anthropic",
      label: t("Prefer Messages for Claude models"),
      description: t("Send Claude models on Anthropic's Messages API when the site offers it, keeping thinking and cache control."),
      default: true,
    },
  ];
}

/**
 * 用户可以用的登录方式。
 *
 * `keyless: true` 是访问令牌不会被问两遍的原因：对 "api" 方式，
 * Magpie 在问完问题后还会弹自己的「API key」框，除非方式声明
 * authorize 自带凭据。本插件就是自带——令牌上面已经问过了——所以那个框被跳过。
 *
 * 提问用 `ask(inputs)` 而不是静态的 `prompts` 列表：先从站点读出分组，
 * 再为每个缺 key 的分组单独弹一个输入框，标题就是分组名。
 */
const METHODS = [
  {
    type: "api",
    label: "New API access token",
    placeholder: "access token, not sk-...",
    keyless: true,
    async ask(inputs) {
      return nextQuestion(inputs ?? {}, { directory: pluginDirectory() });
    },
    async authorize(inputs) {
      return signIn(inputs, { directory: pluginDirectory() });
    },
  },
];

// Magpie 的配置目录，加载时给出（input.directory）。
// 用模块级变量而不是闭包，是因为上面那个方法的 authorize 也要读它。
let directory = "";
function pluginDirectory() {
  return directory;
}

/** 用户设置的那些开关，每次调用都重读，改了不用重启。 */
function optionsOf(input) {
  const read = typeof input?.magpie?.options === "function" ? input.magpie.options(PROVIDER) : {};
  // Magpie 只回它认得的键；缺的那个就是声明的默认值。
  const on = (key) => (typeof read?.[key] === "boolean" ? read[key] : optionList().find((o) => o.key === key)?.default === true);
  return {
    autoCreateKeys: on("auto-create-keys"),
    exposeAllProtocols: on("expose-all-protocols"),
    preferResponses: on("prefer-responses"),
    preferAnthropic: on("prefer-anthropic"),
  };
}

/** 从站点读出账号的分组与模型，缓存由 state.mjs 管。 */
async function listingOf(auth, options, hostModels) {
  const md = runtimeMd(auth);
  const groups = groupsOf(md);
  const usableGroups = Object.values(groups).filter((g) => g.key && !g.problem).length;
  if (!md.baseURL || !usableGroups) {
    return { md, groups: {}, pricing: null, built: { models: {}, perGroup: {} } };
  }
  const discovered = await discover({ md });
  const built = buildModels({
    md,
    groups: discovered.groups,
    pricing: discovered.pricing,
    options: { ...options, hostModels },
  });
  return { md, ...discovered, built };
}

/** 模型钩子，provider 声明与它共用这一份。 */
async function modelsFor(provider, auth, options) {
  if (!auth) return {};
  const { md, groups, built } = await listingOf(auth, options, provider?.models ?? {});
  const haveKeys = Object.values(groupsOf(md)).some((g) => g.key && !g.problem);
  // 每个 key 都失败，或者站点什么都没回答：抛错，让 Magpie 保留原来的
  // 列表并说明原因，而不是把选择器清空。站点回答了、但只列出非聊天模型，
  // 那是空列表，不是错误。
  if (haveKeys && !Object.keys(groups).length) {
    throw new Error(
      t("New API: no models listed for {site}. Check the group keys and that the site's /v1/models answers.", {
        site: md.siteLabel ?? md.baseURL,
      }),
    );
  }
  return built.models;
}

/** Magpie 加载的插件函数。 */
export const NewAPI = async (input) => {
  if (typeof input?.directory === "string" && input.directory) {
    directory = input.directory;
    // 语言来自 Magpie 的 settings.json，就在同一个目录里。
    languageOf(directory);
  }

  const options = () => optionsOf(input);

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= { ...pkg };
    },

    auth: {
      provider: PROVIDER,
      methods: METHODS,
      options: optionList(),

      loader: (getAuth) => ({
        // 这里是占位符而不是账号的 key：否则 Magpie 会把访问令牌
        // 发到每个推理接口上。真正发请求时由 fetch 替换掉。
        apiKey: "magpie-newapi",
        fetch: makeFetch(getAuth),
      }),

      async usage(getAuth) {
        const auth = await getAuth();
        const { base, token } = accountOf(auth);
        if (!base || !token) return { error: t("not signed in"), windows: [] };
        // 账号登录好几周之后，站点的分组会变；卡片是用户会看的地方，
        // 所以在这里也刷新一次。
        const fresh = await refreshAccount(input, auth, { autoCreate: options().autoCreateKeys });
        try {
          return await buildUsage(runtimeMd(fresh ?? auth));
        } catch (e) {
          // 读余额失败不代表账号坏了：令牌被拒、接口被藏起来、连接断了，
          // 这几种情况下分组的 key 都还能推理，所以这里绝不把账号标记为失效。
          return { error: describe(e), windows: [], signIn: "kept" };
        }
      },

      async checkin(getAuth) {
        const auth = await getAuth();
        const { md, base, token } = accountOf(auth);
        if (!base || !token) return { outcome: "failed", message: t("not signed in") };

        // 每天一次，不管站点要不要签到：新分组、被吊销的 key、
        // 插件可以创建的 key，都在这里一并处理。
        const fresh = await refreshAccount(input, auth, {
          autoCreate: options().autoCreateKeys,
          force: true,
        });
        const current = fresh ?? auth;
        const cur = accountOf(current).md;

        if (cur.checkin === "off") return offResult();
        if (cur.checkinBlocked) return blockedResult(cur.checkinBlocked);

        let result;
        try {
          result = await pressCheckin(runtimeMd(current));
        } catch (e) {
          if (e instanceof ChallengeError) {
            await markCheckinBlocked(input, auth, e.code);
            return blockedResult(e.code);
          }
          if (isAuthError(e)) {
            return { outcome: "failed", message: `The site refused the access token: ${describe(e)}` };
          }
          return { outcome: "failed", message: describe(e) };
        }
        if (result.blocked) {
          await markCheckinBlocked(input, current, result.blocked);
          return { outcome: "captcha", message: result.message };
        }
        return result;
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        return modelsFor(provider, auth, options());
      },
    },
  };
};

// OpenCode v1 的对象形式：host.js 只取 `default.server`，
// 不会把每一个导出的函数都当成插件函数调用。
// （它的 `servers()` 正是这样处理的，所以这个入口不导出那些辅助函数。）
export default { id: PROVIDER, server: NewAPI };

/**
 * 把账号的分组表和 key 判定更新到最新，只在真有变化时写回。
 * 返回更新后的账号；写回失败时返回 null（调用方就用读到的内容继续）。
 */
async function refreshAccount(input, auth, { autoCreate = false, force = false, budgetMs } = {}) {
  const { md } = accountOf(auth);
  let synced;
  try {
    synced = await syncAccount({ ...runtimeMd(auth) }, { autoCreate, force, budgetMs });
  } catch {
    return null; // a site that is down answers nothing; keep what we have
  }
  if (!synced.changed) return null;
  const next = { ...auth, metadata: { ...md, groups: synced.groups } };
  try {
    await input?.client?.auth?.set?.({ path: { id: PROVIDER }, body: next });
    // 这个账号缓存的列举结果是用旧分组做的，作废。
    caches.modelList.clear();
    caches.userModels.clear();
    caches.usage.clear();
  } catch {
    // 没存下来：下一次同步会再试
  }
  return next;
}

/** 记住站点质询过签到，这样第二天能少一次请求。 */
async function markCheckinBlocked(input, auth, kind) {
  const md = auth?.metadata ?? {};
  if (!kind || md.checkinBlocked === kind) return;
  const next = {
    ...auth,
    metadata: {
      ...md,
      checkinBlocked: kind,
      checkinBlockedAt: new Date().toISOString(),
    },
  };
  try {
    await input?.client?.auth?.set?.({ path: { id: PROVIDER }, body: next });
    caches.usage.clear();
  } catch {
    // 这一次的结果照旧；下一次运行还会再遇到。
  }
}

function describe(e) {
  const message = String(e?.message ?? e ?? "").trim();
  return message.length > 300 ? `${message.slice(0, 300)}…` : message || "unknown error";
}

// 其他什么都不导出：原因见 default export 上面的说明。
