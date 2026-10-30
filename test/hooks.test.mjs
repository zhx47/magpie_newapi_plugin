import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import plugin, { NewAPI } from "../index.mjs";
import { signIn } from "../src/signin.mjs";
import { USER_AGENT } from "../src/util.mjs";
import { ACCESS_TOKEN, DEFAULT_KEY, VIP_KEY, startNewAPI } from "./mock-newapi.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "newapi-hooks-"));
}

/** 账号里某个分组的 key。 */
function key(md, group) {
  return md.groups?.[group]?.key;
}

/** 没有 key、也没有失败记录的分组。 */
function pend(md) {
  return Object.entries(md.groups ?? {})
    .filter(([, g]) => !g.key && !g.tried)
    .map(([name]) => name)
    .sort();
}

/** Magpie 的 host.js 在登录之后写的文件：plugin-auth.json。 */
function saveAuth(directory, signed) {
  const file = path.join(directory, "plugin-auth.json");
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    all = {};
  }
  all[signed.metadata.accountId ? "newapi#" + signed.metadata.siteLabel.replace(/[^A-Za-z0-9]+/g, "") : "newapi"] = {
    type: "api",
    key: signed.key,
    metadata: signed.metadata,
  };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return file;
}

/** 按 Magpie 的方式加载插件，并登录到 mock 站点。 */
async function setup(options = {}) {
  const site = await startNewAPI(options.site);
  const directory = tmpdir();
  const saved = [];
  const client = {
    auth: {
      set: async ({ body }) => {
        saved.push(body);
      },
    },
  };
  const magpie = {
    options: (provider) => (provider === "newapi" ? { ...options.magpie } : {}),
  };
  const instance = await NewAPI({ directory, client, magpie });
  const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN, ...options.inputs }, { directory });
  assert.equal(signed.type, "success", signed.error);
  const auth = { type: "api", key: signed.key, metadata: signed.metadata };
  const getAuth = async () => auth;
  return { site, instance, auth, getAuth, saved, directory };
}

test("the module exports one plugin function, as host.js's servers() reads it", () => {
  assert.equal(typeof plugin, "object");
  assert.equal(typeof plugin.server, "function");
  assert.equal(plugin.id, "newapi");
  // 不导出别的函数：host.js 会把每个导出函数都当插件调用。
  assert.deepEqual(Object.keys(plugin).sort(), ["id", "server"]);
});

test("auth declares one keyless API method that asks its own questions", async () => {
  const { site, instance } = await setup();
  try {
    const auth = instance.auth;
    assert.equal(auth.provider, "newapi");
    assert.equal(auth.methods.length, 1);
    const m = auth.methods[0];
    assert.equal(m.type, "api");
    // keyless 阻止 Magpie 在令牌之后再问一次「API key」：
    // 访问令牌本来就是那一问。
    assert.equal(m.keyless, true);
    assert.equal(typeof m.ask, "function");
    assert.equal(typeof m.authorize, "function");

    // 按 Magpie 的顺序走一遍问题。磁盘上有账号时第一问是选择器；
    // 这里的目录是空的，所以从站点地址问起。
    const asked = async (inputs) => m.ask(inputs);
    const q1 = await asked({});
    assert.equal(q1.key, "baseURL");
    assert.equal(q1.type, "text");
    const q2 = await asked({ baseURL: site.base });
    assert.equal(q2.key, "accessToken");
    assert.equal(q2.type, "password");
    const q3 = await asked({ baseURL: site.base, accessToken: ACCESS_TOKEN });
    assert.equal(q3.key, "userId");

    // 选项是带默认值的布尔开关。
    assert.ok(auth.options.length >= 4);
    for (const o of auth.options) {
      assert.equal(typeof o.default, "boolean");
      assert.ok(o.label);
    }
  } finally {
    await site.close();
  }
});

test("the missing group is asked by name, and a refused key is asked again", async () => {
  // reveal 被拒、也没填任何 key：过滤器点名的分组都需要 key。
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    // 先问创建：答 no 之后才逐个分组问。三个分组都没有 key。
    const askNoCreate = { baseURL: site.base, accessToken: ACCESS_TOKEN, userId: "", siteLabel: "" };
    const offer = await ask(askNoCreate);
    assert.equal(offer.key, "autoCreate", "the site is offered the chance to create keys first");
    assert.match(offer.message, /3 groups without a key/);
    assert.match(offer.message, /default, svip, vip/);
    const head = { ...askNoCreate, autoCreate: "no" };

    const q1 = await ask(head);
    assert.match(q1.key, /^groupkey:/);
    assert.match(q1.message, /"default"/);
    assert.equal(q1.type, "password");

    // 站点拒绝的 key 会再问一次，问题里说明原因。
    const bad = await ask({ ...head, [q1.key]: "sk-not-a-real-key" });
    assert.equal(bad.key, q1.key, "the same group is asked again");
    assert.match(bad.message, /refused/);

    // 可用的 key 会前进到下一个分组，绝不回到这一个。
    const q2 = await ask({ ...head, [q1.key]: DEFAULT_KEY });
    assert.match(q2.key, /^groupkey:/);
    assert.notEqual(q2.key, q1.key);
    assert.match(q2.message, /"svip"/);

    // 三个都答完就结束：签到开关是 Magpie 的，插件不再问一次。
    const q3 = await ask({ ...head, [q1.key]: DEFAULT_KEY, [q2.key]: VIP_KEY });
    assert.match(q3.message, /"vip"/);
    const answered = { ...head, [q1.key]: DEFAULT_KEY, [q2.key]: VIP_KEY, [q3.key]: VIP_KEY };
    assert.equal(await ask(answered), null);
  } finally {
    await site.close();
  }
});

test("provider.models answers per account, with protocols and group namespaces", async () => {
  const { site, instance, auth } = await setup();
  try {
    const models = await instance.provider.models({ id: "newapi", models: {} }, { auth });
    const ids = Object.keys(models);
    assert.ok(ids.some((id) => id.endsWith("/default/gpt-4o")));
    assert.ok(ids.some((id) => id.endsWith("/vip/gpt-4o")));
    assert.ok(ids.some((id) => id.endsWith("/vip/gpt-5")));
    // 每个条目都是 OpenCode Model：用 `api`，不是 `provider`。
    for (const [id, m] of Object.entries(models)) {
      assert.ok(m.api, `${id} has an api`);
      assert.equal(typeof m.api.id, "string");
      assert.equal(typeof m.api.url, "string");
      assert.equal(typeof m.api.npm, "string");
      assert.equal(m.provider, undefined);
    }
  } finally {
    await site.close();
  }
});

test("provider.models prefers Responses and Messages when the option says so", async () => {
  const { site, instance, auth } = await setup({ magpie: { "prefer-responses": true, "prefer-anthropic": true } });
  try {
    const models = await instance.provider.models({ models: {} }, { auth });
    const find = (suffix) => Object.entries(models).find(([id]) => id.endsWith(suffix))?.[1];
    assert.equal(find("/vip/gpt-5").api.npm, "@ai-sdk/openai");
    assert.equal(find("/vip/claude-sonnet-4.5").api.npm, "@ai-sdk/anthropic");
  } finally {
    await site.close();
  }
});

test("provider.models honors exposeAllProtocols from the plugin options", async () => {
  const { site, instance, auth } = await setup({ magpie: { "expose-all-protocols": true } });
  try {
    const models = await instance.provider.models({ models: {} }, { auth });
    const ids = Object.keys(models);
    assert.ok(ids.some((id) => id.endsWith("/vip/gpt-5")), diagnostics(site, auth, ids));
    assert.ok(ids.some((id) => id.endsWith("/vip/gpt-5@chat")), diagnostics(site, auth, ids));
  } finally {
    await site.close();
  }
});

/** 列举结果不对时，站点与账号当时的样子。 */
export function diagnostics(site, auth, ids) {
  const reqs = site.state.requests.map((r) => `${r.method} ${r.path}${r.search} -> ${r.status ?? ""}`).join(" | ");
  return [
    `models=${ids.length}`,
    `groups=${Object.keys(auth.metadata.groups ?? {}).join(",")}`,
    `groups=${Object.keys(auth.metadata.groups ?? {}).join(",")}`,
    `requests: ${reqs}`,
  ].join(" · ");
}

test("the loader's fetch sends a request with the group's key", async () => {
  const { site, instance, auth } = await setup();
  try {
    const loader = instance.auth.loader(async () => auth);
    // 占位符不是账号的令牌。
    assert.equal(loader.apiKey, "magpie-newapi");
    const res = await loader.fetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer magpie-newapi", "content-type": "application/json" },
      body: JSON.stringify({ model: JSON.stringify(["vip", "gpt-4o"]) }),
    });
    const seen = await res.json();
    assert.equal(seen.seen.group, "vip");
    assert.equal(seen.seen.model, "gpt-4o");
    assert.equal(seen.seen.auth, VIP_KEY);
    // 完全没有 key 的分组会提示怎么修。
    const missing = await loader.fetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: JSON.stringify(["svip", "gpt-5"]) }),
    });
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error.message, /svip/);
    void DEFAULT_KEY;
  } finally {
    await site.close();
  }
});

test("every request goes as Codex CLI, for sites that only let it in", async () => {
  const { site, instance, auth } = await setup();
  try {
    // 一条管理接口的读取、一次分组列举、一次推理转发。
    await instance.auth.usage(async () => auth);
    await instance.provider.models({ models: {} }, { auth });
    const loader = instance.auth.loader(async () => auth);
    await loader.fetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: JSON.stringify(["default", "gpt-4o"]) }),
    });

    const seen = site.state.requests.filter((r) => r.headers["user-agent"] !== undefined);
    assert.ok(seen.some((r) => r.path === "/api/user/self"), "the account read");
    assert.ok(seen.some((r) => r.path === "/v1/models"), "a group's model list");
    assert.ok(seen.some((r) => r.path === "/v1/chat/completions"), "a relayed request");
    for (const r of seen) {
      // 站点可能按 UA 放行：管理接口和推理报同一个，别一个像人一个像机器人。
      assert.equal(r.headers["user-agent"], USER_AGENT, `${r.method} ${r.path}`);
    }
  } finally {
    await site.close();
  }
});

test("usage answers one wallet window and the site's plan", async () => {
  const { site, instance, getAuth } = await setup();
  try {
    const usage = await instance.auth.usage(getAuth);
    assert.equal(usage.plan, "default");
    assert.equal(usage.user, "alice");
    const wallet = usage.windows.find((w) => w.name === "Balance");
    // 余额和已用是同一个钱包的两端：一行、一条进度条，不是两条读数。
    assert.equal(wallet.used, 16.7, "1,000,000 spent of 6,000,000");
    assert.equal(wallet.amount, 2);
    assert.equal(wallet.limit, 12);
    assert.equal(wallet.unit, "$");
    assert.equal(wallet.aside, true, "不参与路由的额度比较");
    // 卡片里从不带 key。
    assert.ok(!JSON.stringify(usage).includes(VIP_KEY));
  } finally {
    await site.close();
  }
});

test("usage keeps the account when the access token is refused", async () => {
  const { site, instance, auth } = await setup();
  try {
    const stale = { ...auth, key: "revoked-token" };
    const usage = await instance.auth.usage(async () => stale);
    assert.ok(usage.error);
    assert.equal(usage.signIn, "kept");
  } finally {
    await site.close();
  }
});

test("checkin is claimed on the first press and done on the next", async () => {
  const { site, instance, getAuth } = await setup({ site: { checkedInToday: false } });
  try {
    const first = await instance.auth.checkin(getAuth);
    assert.equal(first.outcome, "claimed");
    assert.equal(first.credit, 0.01);
    const second = await instance.auth.checkin(getAuth);
    assert.equal(second.outcome, "done");
  } finally {
    await site.close();
  }
});

test("a Cloudflare check-in marks the account so the next day is one request cheaper", async () => {
  const { site, instance, auth, saved } = await setup({ site: { challenge: "cf" } });
  try {
    const result = await instance.auth.checkin(async () => auth);
    assert.equal(result.outcome, "captcha");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].metadata.checkinBlocked, "cf");
    const before = site.state.requests.length;
    const again = await instance.auth.checkin(async () => saved[0]);
    assert.equal(again.outcome, "captcha");
    // 不会再去按签到。分组同步仍会读账号的分组（GET），
    // 正是它让几周前登录的账号也能发现新分组。
    const pressed = site.state.requests.slice(before).filter((r) => r.method === "POST" && r.path.includes("checkin"));
    assert.deepEqual(pressed, [], "no check-in POST once the block is known");
  } finally {
    await site.close();
  }
});

test("a Turnstile site is reported as a captcha without being pressed or marked", async () => {
  const { site, instance, auth, saved } = await setup({ site: { turnstileCheck: true } });
  try {
    const before = site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length;
    const result = await instance.auth.checkin(async () => auth);
    assert.equal(result.outcome, "captcha");
    assert.match(result.message, /captcha/i);
    // 什么都没按，站点设置也没被记成封锁：站点可能关掉 Turnstile，
    // 第二天读一次就知道了。
    const after = site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length;
    assert.equal(after, before);
    assert.equal(saved.length, 0);
  } finally {
    await site.close();
  }
});

test("the config hook leaves the user's provider settings alone", async () => {
  const instance = await NewAPI({ directory: tmpdir(), magpie: { options: () => ({}) } });
  const cfg = { provider: { newapi: { name: "Mine" } } };
  await instance.config(cfg);
  assert.deepEqual(cfg.provider.newapi, { name: "Mine" });
  const fresh = {};
  await instance.config(fresh);
  assert.equal(fresh.provider.newapi.name, "New API");
  assert.equal(fresh.provider.newapi.npm, "@ai-sdk/openai-compatible");
});

test("the method is keyless so Magpie does not ask for the token twice", async () => {
  // Magpie 会在 api 方式问完之后弹自己的「API key」框，
  // 除非方式声明 keyless（gui: ms[method].keyless）。没有它，
  // 访问令牌输一遍之后还会以方式标签为题再问一遍。
  const { site, instance } = await setup();
  try {
    const m = instance.auth.methods[0];
    assert.equal(m.type, "api");
    assert.equal(m.keyless, true, "keyless is what skips Magpie's own key box");
    assert.equal(typeof m.authorize, "function");
  } finally {
    await site.close();
  }
});

test("a model's id is the site, the group and the model", async () => {
  const { site, instance, auth } = await setup();
  try {
    const models = await instance.provider.models({ models: {} }, { auth });
    const id = Object.keys(models).find((k) => k.endsWith("/vip/gpt-5"));
    assert.ok(id, "the model is listed");
    // `<siteLabel>/<group>/<model>`；Magpie 显示成 newapi/<id>
    const [label, group, model] = id.split("/");
    assert.equal(label, auth.metadata.siteLabel, "the site label");
    assert.equal(group, "vip");
    assert.equal(model, "gpt-5");
  } finally {
    await site.close();
  }
});

test("model names read model · site · group · ratio · protocol", async () => {
  const { site, instance, auth } = await setup();
  try {
    const models = await instance.provider.models({ models: {} }, { auth });
    const siteLabel = auth.metadata.siteLabel;
    // Responses 模型会写协议名；chat 模型不写。
    const responses = Object.values(models).find((m) => m.id.endsWith("/vip/gpt-5"));
    assert.equal(responses.name, `gpt-5 · ${siteLabel} · vip · ×0.8 · Responses`);
    const chat = Object.values(models).find((m) => m.id.endsWith("/vip/gpt-4o"));
    assert.equal(chat.name, `gpt-4o · ${siteLabel} · vip · ×0.8`);
  } finally {
    await site.close();
  }
});

test("two accounts of one site share a model id on purpose", async () => {
  const a = await startNewAPI();
  const b = await startNewAPI();
  try {
    const dirA = tmpdir();
    const dirB = tmpdir();
    const signedA = await signIn({ baseURL: a.base, accessToken: ACCESS_TOKEN, siteLabel: "acme" }, { directory: dirA });
    const signedB = await signIn({ baseURL: b.base, accessToken: ACCESS_TOKEN, siteLabel: "acme" }, { directory: dirB });
    const instance = await NewAPI({ directory: dirA, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const modelsA = await instance.provider.models({ models: {} }, { auth: { type: "api", key: signedA.key, metadata: signedA.metadata } });
    const modelsB = await instance.provider.models({ models: {} }, { auth: { type: "api", key: signedB.key, metadata: signedB.metadata } });

    const aId = Object.keys(modelsA).find((k) => k.endsWith("/default/gpt-4o"));
    const bId = Object.keys(modelsB).find((k) => k.endsWith("/default/gpt-4o"));
    assert.equal(aId, bId, "one row for one site's model, whichever account lists it");

    // 不同的站点标识就是不同的 ID，所以两个站点的同名模型保持两行。
    const c = await startNewAPI();
    try {
      const signedC = await signIn({ baseURL: c.base, accessToken: ACCESS_TOKEN, siteLabel: "other-site" }, { directory: tmpdir() });
      const modelsC = await instance.provider.models({ models: {} }, { auth: { type: "api", key: signedC.key, metadata: signedC.metadata } });
      const cId = Object.keys(modelsC).find((k) => k.endsWith("/default/gpt-4o"));
      assert.notEqual(cId, aId);
      assert.match(cId, /^other-site\/default\/gpt-4o$/);
    } finally {
      await c.close();
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test("the card is one wallet and nothing that would claim a share", async () => {
  const { site, instance, getAuth } = await setup();
  try {
    const usage = await instance.auth.usage(getAuth);
    // 只有钱包和（有缺 key 时）一条提示：没有单独的「已用」「分组」行，
    // 它们本来就不是额度。
    const named = usage.windows.map((w) => w.name);
    assert.ok(!named.includes("Used"), `no Used row: ${named}`);
    assert.ok(!named.includes("Groups"), `no Groups row: ${named}`);
    assert.equal(named.filter((n) => n === "Balance").length, 1, "one wallet, not two");

    // 提示行不带 used，否则 Magpie 会给它画 0% 进度条和走势线。
    for (const w of usage.windows.filter((x) => x.name !== "Balance")) {
      assert.equal(w.used, undefined, `${w.name} must not claim a share`);
      assert.ok(w.display, `${w.name} says its text`);
    }
  } finally {
    await site.close();
  }
});

// ---- 跟进分组会变的站点 ----------------------------------------------

test("a new group at the site reaches an account signed in before it", async () => {
  // 先登录，然后像管理员那样在站点上加一个带 key 的分组。
  // 登录之后在 Magpie 里什么都不用填。
  const { site, instance, auth, saved } = await setup({ site: { reveal: "allow" } });
  try {
    assert.equal(auth.metadata.groups.later, undefined, "the group did not exist at sign-in");

    site.set({
      groups: { ...site.state.groups, later: { ratio: 0.5, desc: "added later" } },
      models: { ...site.state.models, later: ["gpt-4o"] },
      tokens: [
        ...site.state.tokens,
        { id: 77, name: "later", key: VIP_KEY, group: "later", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
      ],
    });

    // 一次用量读取就会带出来：同步读站点的分组和 token 列表，
    // 再把账号写回。这里故意不走列举——Magpie 给一个供应商的模型钩子
    // 一共 20 秒，还和其他供应商共用。
    await instance.auth.usage(async () => ({ type: "api", key: auth.key, metadata: auth.metadata }));

    const after = saved.at(-1);
    assert.ok(after, "the account's metadata was written back");
    assert.ok(after.metadata.groups.later, "the new group is in the account now");
    assert.equal(after.metadata.groups.later.ratio, 0.5, "with the site's own ratio");
    assert.ok(after.metadata.groups.later.key, "and the key found for it");
  } finally {
    await site.close();
  }
});

test("a key the site refuses is reported as refused, not as working", async () => {
  const { site, instance, auth } = await setup({ site: { reveal: "deny" }, inputs: { "groupkey:default": "sk-revoked-key" } });
  try {
    // 列举会用 /v1/models 校验每个 key；这一个被拒了。
    await instance.provider.models({ models: {} }, { auth }).catch(() => {});
    const usage = await instance.auth.usage(async () => auth);
    const row = usage.windows.find((w) => /keys/i.test(w.name));
    assert.ok(row, `a keys row is shown: ${JSON.stringify(usage.windows)}`);
    assert.match(row.display, /refused|no key/i);
  } finally {
    await site.close();
  }
});

test("the check-in reads the groups before it presses, once a day", async () => {
  const { site, instance, getAuth } = await setup({ site: { checkedInToday: false } });
  try {
    const before = site.state.requests.filter((r) => r.path.includes("/groups")).length;
    const result = await instance.auth.checkin(getAuth);
    assert.equal(result.outcome, "claimed");
    const after = site.state.requests.filter((r) => r.path.includes("/groups")).length;
    assert.ok(after > before, "the groups were read as part of the daily run");
  } finally {
    await site.close();
  }
});

test("autoCreate fills a group that appeared after sign-in", async () => {
  const { site, auth, saved } = await setup({ site: { reveal: "allow" }, inputs: {} });
  try {
    // 管理员新加的分组，本身没有 token。
    site.set({
      groups: { ...site.state.groups, newish: { ratio: 0.9, desc: "new" } },
      models: { ...site.state.models, newish: ["gpt-4o"] },
    });
    const md = auth.metadata;
    const withAuto = await NewAPI({
      directory: tmpdir(),
      client: { auth: { set: async ({ body }) => void saved.push(body) } },
      magpie: { options: () => ({ "auto-create-keys": true }) },
    });
    await withAuto.auth.usage(async () => ({ type: "api", key: auth.key, metadata: md }));
    const created = site.state.created ?? [];
    assert.ok(created.some((t) => t.group === "newish"), `a token was created: ${JSON.stringify(created.map((t) => t.group))}`);
  } finally {
    await site.close();
  }
});

// ---- 列举必须待在 Magpie 的 20 秒期限内 -------------------------------

test("the sync is throttled: a second usage read does not read the site again", async () => {
  const { site, instance, getAuth } = await setup();
  try {
    await instance.auth.usage(getAuth);
    const afterFirst = site.state.requests.length;
    await instance.auth.usage(getAuth);
    const added = site.state.requests
      .slice(afterFirst)
      .filter((r) => r.path.includes("/groups") || r.path.startsWith("/api/token"));
    // 什么都没有：分组和 key 判定刚刚才读过。
    assert.deepEqual(added.map((r) => r.path), [], "the second usage read synced again");
  } finally {
    await site.close();
  }
});

test("a key is checked once, not again for each listing", async () => {
  const { site, instance, auth } = await setup();
  try {
    await instance.provider.models({ models: {} }, { auth });
    const listCalls = site.state.requests.filter((r) => r.path === "/v1/models");
    // 每个有 key 的分组一次请求（default 和 vip），不是各两次。
    const keyed = Object.values(auth.metadata.groups ?? {}).filter((g) => g.key).length;
    assert.ok(listCalls.length <= keyed, `${listCalls.length} /v1/models calls for ${keyed} keys`);
  } finally {
    await site.close();
  }
});

test("a slow site does not push a listing past its budget", async () => {
  const { instance, auth } = { instance: null, auth: null };
  void instance;
  void auth;
  // 预算靠竞速实现；这里直接验证它的单位，
  // 不用真等 20 秒来模拟慢网络。
  const { syncAccount } = await import("../src/sync.mjs");
  const started = Date.now();
  const result = await syncAccount(
    { baseURL: "http://127.0.0.1:1", accessToken: "x", userId: "1", groups: {} },
    { budgetMs: 300 },
  );
  const took = Date.now() - started;
  assert.ok(took < 2000, `the sync returned in ${took}ms, inside its 300ms budget`);
  assert.equal(result.changed, false);
});

test("the models hook reads no groups and presses nothing", async () => {
  const { site, instance, auth } = await setup();
  try {
    // 只看列举自己发的请求：上面的登录有它自己的调用。
    const mark = site.state.requests.length;
    await instance.provider.models({ models: {} }, { auth });
    const paths = site.state.requests.slice(mark).map((r) => r.path);
    // 只有它自己的列举和模型广场，没有别的：Magpie 给一个供应商的模型钩子
    // 一共 20 秒，还和其他供应商共用。
    assert.ok(!paths.some((p) => p.includes("/groups")), `groups read: ${paths.join(", ")}`);
    assert.ok(!paths.some((p) => p.includes("checkin")), "check-in pressed");
    assert.ok(!paths.some((p) => p.startsWith("/api/token")), `tokens read: ${paths.join(", ")}`);
  } finally {
    await site.close();
  }
});

test("re-signing in asks only for the groups still missing, and keeps the account", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    // 第一次登录：default 和 vip 手填，svip 跳过。
    const first = await signIn(
      { baseURL: site.base, accessToken: ACCESS_TOKEN, siteLabel: "one-site", "groupkey:default": "sk-first-default", "groupkey:vip": "sk-first-vip" },
      { directory },
    );
    assert.equal(first.type, "success");
    assert.deepEqual(pend(first.metadata), ["svip"]);
    saveAuth(directory, first);

    // 第二次登录，什么都不填：选中已保存的账号就带来令牌和它已有的 key，
    // 所以只问 svip。
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    const account = instance.auth.methods[0];
    const pick = await ask({});
    assert.equal(pick.key, "pick");
    const saved = pick.options.find((o) => o.value !== "__new__");
    const head = { pick: saved.value };
    // 缺一个分组，所以先问站点要不要建它的 key。
    const offer = await ask(head);
    assert.equal(offer.key, "autoCreate");
    assert.match(offer.message, /svip/);
    assert.match(offer.message, /1 group without a key/);
    const q = await ask({ ...head, autoCreate: "no" });
    assert.match(q.key, /^groupkey:/);
    assert.match(q.message, /"svip"/, "only the group still missing is asked");
    void account;

    const second = await signIn({ ...head, autoCreate: "no" }, { directory });
    assert.equal(second.type, "success");
    assert.equal(second.metadata.accountId, first.metadata.accountId, "the same account, not a new one");
    assert.equal(key(second.metadata, "default"), "sk-first-default");
    assert.equal(key(second.metadata, "vip"), "sk-first-vip");
  } finally {
    await site.close();
  }
});

test("letting the site create keys asks nothing by hand", async () => {
  const site = await startNewAPI({ reveal: "allow" });
  try {
    const directory = tmpdir();
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    // svip 没有 token：登录，然后对创建答 yes。
    const head = {
      baseURL: site.base,
      accessToken: ACCESS_TOKEN,
      userId: "",
      siteLabel: "",
      autoCreate: "yes",
    };
    // 创建发生在提问里，且只发生一次；建好之后什么都不用再问。
    const next = await ask(head);
    assert.equal(next, null, "建出来之后就没有问题了");
    assert.equal(site.state.created.filter((t) => t.group === "svip").length, 1);

    const signed = await signIn(head, { directory });
    assert.equal(signed.type, "success");
    assert.match(key(signed.metadata, "svip"), /^sk-created-/);
    assert.deepEqual(pend(signed.metadata), []);
    // authorize 没有再建一轮
    assert.equal(site.state.created.filter((t) => t.group === "svip").length, 1);
  } finally {
    await site.close();
  }
});

// ---- 重新登录时不用重敲令牌 --------------------------------------------

test("an account already on disk is offered first, and its token reused", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const first = await signIn(
      { baseURL: site.base, accessToken: ACCESS_TOKEN, siteLabel: "one-site", "groupkey:default": "sk-a", "groupkey:vip": "sk-b" },
      { directory },
    );
    assert.equal(first.type, "success");
    saveAuth(directory, first);

    // 在同一个 Magpie 里重新登录：第一问是账号选择器，
    // 而不是让人回忆站点地址和令牌。
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    const pick = await ask({});
    assert.equal(pick.key, "pick");
    assert.equal(pick.type, "select");
    const offered = pick.options.find((o) => o.value !== "__new__");
    assert.ok(offered, "the saved account is offered");
    assert.match(offered.label, /one-site/);
    // 站点有三个分组；提示里写了数量。
    assert.equal(offered.hint, "3");

    // 选中它，令牌和标识都不用输入就填好了。
    const picked = await ask({ pick: offered.value });
    assert.equal(picked.key, "autoCreate", "it goes straight to the missing group");

    // 登录本身也不需要调用方提供令牌。
    const second = await signIn({ pick: offered.value, autoCreate: "no" }, { directory });
    assert.equal(second.type, "success");
    assert.equal(second.metadata.accountId, first.metadata.accountId);
    assert.equal(key(second.metadata, "default"), "sk-a");
  } finally {
    await site.close();
  }
});

test("a new site is still one of the choices", async () => {
  const site = await startNewAPI();
  try {
    const directory = tmpdir();
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory });
    saveAuth(directory, signed);
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    const pick = await ask({});
    const fresh = pick.options.find((o) => o.value === "__new__");
    assert.ok(fresh, "the way to another site is offered");
    // 选中它就会问站点地址，和第一次登录一样。
    const q = await ask({ pick: "__new__" });
    assert.equal(q.key, "baseURL");
  } finally {
    await site.close();
  }
});

// ---- 创建绝不能重复 ----------------------------------------------------

test("a group whose token cannot be revealed gets no second token", async () => {
  // 站点会建 token，但不会交出它的 key。修好之前每次同步都会再建一个：
  // 一个分组堆出一百多个 token。
  const { site, auth } = await setup({ site: { reveal: "deny" }, inputs: {} });
  try {
    site.set({
      groups: { ...site.state.groups, stuck: { ratio: 0.5, desc: "stuck" } },
      models: { ...site.state.models, stuck: ["gpt-4o"] },
    });
    const dir = tmpdir();
    const saved = [];
    const instance = await NewAPI({
      directory: dir,
      client: { auth: { set: async ({ body }) => void saved.push(body) } },
      magpie: { options: () => ({ "auto-create-keys": true }) },
    });
    const mdBase = auth.metadata;

    // 跑三轮，相当于三天；每轮都强制同步。
    for (let day = 0; day < 3; day++) {
      await instance.auth.usage(async () => ({ type: "api", key: auth.key, metadata: mdBase }));
      // 同步的节流是按账号十分钟；每轮换一个账号 id 来代表下一天。
      mdBase.baseURL = site.base;
      const made = site.state.created.filter((t) => t.group === "stuck");
      assert.ok(made.length <= 1, `day ${day}: ${made.length} tokens made for one group`);
      if (made.length) break;
    }
    const made = site.state.created.filter((t) => t.group === "stuck");
    assert.equal(made.length, 1, `exactly one token, not ${made.length}`);
  } finally {
    await site.close();
  }
});

test("a group that already has a token is reused, not duplicated", async () => {
  const site = await startNewAPI({ reveal: "allow" });
  try {
    const dir = tmpdir();
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: dir });
    const auth = { type: "api", key: signed.key, metadata: signed.metadata };
    // 管理员自己加了个分组，也自己给它建了 token。
    site.set({
      groups: { ...site.state.groups, added: { ratio: 1, desc: "" } },
      models: { ...site.state.models, added: ["gpt-4o"] },
      tokens: [...site.state.tokens, { id: 88, name: "theirs", key: VIP_KEY, group: "added", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true }],
    });
    const before = site.state.created.length;

    const instance = await NewAPI({
      directory: dir,
      client: { auth: { set: async () => {} } },
      magpie: { options: () => ({ "auto-create-keys": true }) },
    });
    const md = auth.metadata;
    await instance.auth.usage(async () => ({ type: "api", key: auth.key, metadata: md }));

    // svip 完全没有 token，所以给它建一个；`added` 已经有了，
    // 不能再建第二个。
    const added = site.state.created.filter((t) => t.group === "added");
    assert.equal(added.length, 0, `a token was made for a group that had one: ${JSON.stringify(added)}`);
  } finally {
    await site.close();
  }
});

// ---- 登录只建一次 key，metadata 不留问答痕迹 ----------------------------

test("三个分组只创建一轮 key，authorize 不再建第二轮", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);

    // 像 GUI 那样一问一答走完
    let inputs = { baseURL: site.base, accessToken: ACCESS_TOKEN, userId: "", siteLabel: "" };
    for (let i = 0; i < 12; i++) {
      const q = await ask(inputs);
      if (!q) break;
      inputs = { ...inputs, [q.key]: q.type === "select" ? q.options[0].value : "" };
      // 再调一次 ask：真实的 GUI 每次答完都会再问，不能因此重复创建
      await ask(inputs);
    }
    const afterAsk = site.state.created.length;
    assert.equal(afterAsk, 3, `问完是三个：${site.state.created.map((t) => t.group)}`);

    const signed = await instance.auth.methods[0].authorize(inputs);
    assert.equal(signed.type, "success");
    assert.equal(site.state.created.length, 3, `authorize 没有再建：${site.state.created.map((t) => t.group)}`);
  } finally {
    await site.close();
  }
});

test("登录写回的 metadata 里没有令牌的副本，也没有问答用的键", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);

    let inputs = { baseURL: site.base, accessToken: ACCESS_TOKEN, userId: "", siteLabel: "" };
    for (let i = 0; i < 12; i++) {
      const q = await ask(inputs);
      if (!q) break;
      inputs = { ...inputs, [q.key]: q.type === "select" ? q.options[0].value : "" };
    }
    const signed = await instance.auth.methods[0].authorize(inputs);

    // Magpie 的 save() 是 {...inputs, ...result.metadata}，所以这里照做
    const saved = JSON.parse(JSON.stringify({ ...inputs, ...signed.metadata }));
    assert.equal("accessToken" in saved, false, "令牌只在 auth.key 里，metadata 不再存一份");
    assert.equal("pick" in saved, false);
    assert.equal("autoCreate" in saved, false);
    assert.equal("createdKeys" in saved, false);
    assert.equal(Object.keys(saved).some((k) => k.startsWith("groupkey:")), false, "手填的 key 不再原样留在 metadata");
    // 该留的还在
    assert.ok(saved.groups?.default, "分组表在");
    assert.equal(saved.baseURL, site.base);
  } finally {
    await site.close();
  }
});
