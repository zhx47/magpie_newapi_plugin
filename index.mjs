// The OpenCode v1 plugin entry: the provider's declaration and the hooks
// Magpie calls.
//
// One provider, `newapi`, with one account per site. Everything a site has
// (groups, keys, models, balance, check-in) hangs off its account, so two
// sites never share state. A model id carries the site and the group, so
// the same model name in two groups is two models in Magpie.

import { ChallengeError, isAuthError } from "./src/api.mjs";
import { blockedResult, offResult, pressCheckin } from "./src/checkin.mjs";
import { makeFetch } from "./src/fetch.mjs";
import { buildModels, discover } from "./src/models.mjs";
import { PROVIDER, nextQuestion, signIn } from "./src/signin.mjs";
import { accountOf, caches, groupKeysOf, runtimeMd, withMetadata } from "./src/state.mjs";
import { groupsNeedingAttention, syncAccount } from "./src/sync.mjs";
import { buildUsage } from "./src/usage.mjs";

const pkg = {
  name: "New API",
  npm: "@ai-sdk/openai-compatible",
  api: "",
};

/** The provider's switches, all boolean (Magpie's auth.options shape). */
const OPTIONS = [
  {
    key: "auto-create-keys",
    label: "Create missing group keys",
    description: "Ask the site to create an API token for each group Magpie has no key for.",
    default: false,
    confirm: "This creates API tokens named magpie-... on your New API site.",
  },
  {
    key: "expose-all-protocols",
    label: "List every protocol a model supports",
    description: "Show a separate model for chat, Responses, Messages and Gemini when the site supports more than one.",
    default: false,
  },
  {
    key: "prefer-responses",
    label: "Prefer Responses for GPT-5 and Codex models",
    description: "Send GPT-5 class models on OpenAI's Responses API when the site offers it.",
    default: true,
  },
  {
    key: "prefer-anthropic",
    label: "Prefer Messages for Claude models",
    description: "Send Claude models on Anthropic's Messages API when the site offers it, keeping thinking and cache control.",
    default: true,
  },
];

/**
 * The methods a user can sign in with.
 *
 * `keyless: true` is what keeps the access token from being asked twice:
 * Magpie shows its own "API key" box after the questions of an "api" method
 * unless the method says its authorize supplies the credential. Ours does —
 * the token was already asked above — so the extra box is skipped.
 *
 * The questions are `ask(inputs)` rather than a static `prompts` list: the
 * groups are read from the site first, then each group without a key is
 * asked in a field of its own, titled with its name.
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

// Magpie's config directory, given at load (input.directory). A global
// rather than a closure value so the method's authorize above can read it.
let directory = "";
function pluginDirectory() {
  return directory;
}

/** The options as the user set them, read at each call so a change lands without a restart. */
function optionsOf(input) {
  const read = typeof input?.magpie?.options === "function" ? input.magpie.options(PROVIDER) : {};
  // Magpie hands back only keys it kept; a missing one is the declared default.
  const on = (key) => (typeof read?.[key] === "boolean" ? read[key] : OPTIONS.find((o) => o.key === key)?.default === true);
  return {
    autoCreateKeys: on("auto-create-keys"),
    exposeAllProtocols: on("expose-all-protocols"),
    preferResponses: on("prefer-responses"),
    preferAnthropic: on("prefer-anthropic"),
  };
}

/** Load the account's groups and models from the site, with the caches in state.mjs. */
async function listingOf(auth, options, hostModels) {
  const md = runtimeMd(auth);
  const groupKeys = groupKeysOf(md);
  if (!md.baseURL || !Object.keys(groupKeys).length) {
    return { md, groups: {}, pricing: null, built: { models: {}, perGroup: {} } };
  }
  const discovered = await discover({ md, groupKeys });
  const built = buildModels({
    md,
    groups: discovered.groups,
    pricing: discovered.pricing,
    options: { ...options, hostModels },
  });
  return { md, ...discovered, built };
}

/** The models hook, shared by the provider declaration. */
async function modelsFor(input, provider, auth, options) {
  if (!auth) return {};
  // The list is what a reader picks from, so a group added to the site since
  // the sign-in is settled here too (on a slow clock: see sync.mjs).
  const current = await refreshAccount(input, auth, { autoCreate: options.autoCreateKeys });
  const { md, groups, built } = await listingOf(current ?? auth, options, provider?.models ?? {});
  const haveKeys = Object.keys(groupKeysOf(md)).length > 0;
  // Every key failed, or the site answered nothing: throw so Magpie keeps the
  // list it had and says why, instead of emptying the picker. A site that
  // answered but lists only non-chat models is an empty list, not an error.
  if (haveKeys && !Object.keys(groups).length) {
    throw new Error(
      `New API: no models listed for ${md.siteLabel ?? md.baseURL}. ` +
        "Check the group keys and that the site's /v1/models answers.",
    );
  }
  return built.models;
}

/** The plugin function Magpie loads. */
export const NewAPI = async (input) => {
  if (typeof input?.directory === "string" && input.directory) directory = input.directory;

  const options = () => optionsOf(input);

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= { ...pkg };
    },

    auth: {
      provider: PROVIDER,
      methods: METHODS,
      options: OPTIONS,

      loader: (getAuth) => ({
        // A placeholder rather than the account's key: Magpie would otherwise
        // send the access token to every relay endpoint. fetch replaces it.
        apiKey: "magpie-newapi",
        fetch: makeFetch(getAuth),
      }),

      async usage(getAuth) {
        const auth = await getAuth();
        const { base, token } = accountOf(auth);
        if (!base || !token) return { error: "not signed in", windows: [] };
        // A site's groups change under an account that was signed in weeks
        // ago; the card is where a reader looks, so it is refreshed here too.
        const fresh = await refreshAccount(input, auth, { autoCreate: options().autoCreateKeys });
        try {
          return await buildUsage(runtimeMd(fresh ?? auth));
        } catch (e) {
          // A balance read is not the account's health: a refused token, a
          // hidden endpoint or a dropped connection all leave the group keys
          // able to relay, so never mark the account lapsed here.
          return { error: describe(e), windows: [], signIn: "kept" };
        }
      },

      async checkin(getAuth) {
        const auth = await getAuth();
        const { md, base, token } = accountOf(auth);
        if (!base || !token) return { outcome: "failed", message: "not signed in" };

        // Once a day, whether or not the site checks in: a new group, a
        // revoked key and a key the plugin may create are all settled here.
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
        return modelsFor(input, provider, auth, options());
      },
    },
  };
};

// OpenCode v1's object form: host.js takes `default.server` alone and does
// not call every other exported function as a plugin. (Its `servers()`
// treats each function export as a plugin function, which is why the
// helpers below are not exported from this entry.)
export default { id: PROVIDER, server: NewAPI };

/**
 * Bring the account's group list and key verdicts up to date, writing back
 * only what changed. Returns the account as it now stands, or null when the
 * write failed (the caller goes on with what it read).
 */
async function refreshAccount(input, auth, { autoCreate = false, force = false } = {}) {
  const { md} = accountOf(auth);
  let synced;
  try {
    synced = await syncAccount({ ...runtimeMd(auth) }, { autoCreate, force });
  } catch {
    return null; // a site that is down answers nothing; keep what we have
  }
  if (!synced.changed) return synced.notes?.length ? { ...auth, metadata: withMetadata(md, synced.fields) } : null;
  const next = { ...auth, metadata: withMetadata(md, synced.fields) };
  try {
    await input?.client?.auth?.set?.({ path: { id: PROVIDER }, body: next });
    // The listing kept for this account was made from the old groups.
    caches.modelList.clear();
    caches.userModels.clear();
    caches.usage.clear();
  } catch {
    // not saved: the next sync tries again
  }
  return next;
}

/** Remember that the site challenged the check-in, so the next day is one request cheaper. */
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
    // The result of this run stands; the next run finds it again.
  }
}

function describe(e) {
  const message = String(e?.message ?? e ?? "").trim();
  return message.length > 300 ? `${message.slice(0, 300)}…` : message || "unknown error";
}

// Nothing else is exported: see the note on the default export.
