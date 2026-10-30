import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildModels, discover } from "../src/models.mjs";
import { makeFetch } from "../src/fetch.mjs";
import { buildUsage } from "../src/usage.mjs";
import { pressCheckin } from "../src/checkin.mjs";
import { signIn, validateAccessToken } from "../src/signin.mjs";
import { groupsOf, knownAccounts } from "../src/state.mjs";
import { syncAccount } from "../src/sync.mjs";
import { formatQuota, quotaAsNumber, quotaInfo } from "../src/util.mjs";
import { ACCESS_TOKEN, DEFAULT_KEY, SVIP_KEY, VIP_KEY, startNewAPI } from "./mock-newapi.mjs";

/** 一条同时服务两个分组的 token（hyxware 那种站点才有）。 */
const COMBO_KEY = SVIP_KEY;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "newapi-plugin-test-"));
}

function authOf(result) {
  assert.equal(result.type, "success", `sign-in failed: ${result.error ?? ""}`);
  return { type: "api", key: result.key, metadata: result.metadata };
}

/** 内部辅助函数要的 metadata：base、令牌、user id 放在一起。 */
function runtimeOf(result) {
  const auth = authOf(result);
  return { ...auth.metadata, accessToken: auth.key };
}

/** 某个分组模型的条目，按 id 后缀找（站点标识是 mock 的 host:port）。 */
function entry(models, group, model, suffix = "") {
  const found = Object.entries(models).find(([id]) => id.endsWith(`/${group}/${model}${suffix}`));
  assert.ok(found, `no model ${group}/${model}${suffix} among ${Object.keys(models).slice(0, 10).join(", ")}`);
  return found[1];
}

/** Magpie 的宿主在登录之后写的文件：plugin-auth.json。 */
function saveAuth(directory, signed) {
  const file = path.join(directory, "plugin-auth.json");
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    all = {};
  }
  all["newapi"] = { type: "api", key: signed.key, metadata: signed.metadata };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

/** 没有 key、也没有失败记录的分组，按 metadata 的存法。 */
function pend(md) {
  return Object.entries(groupsOf(md))
    .filter(([, g]) => !g.key && !g.tried)
    .map(([name]) => name)
    .sort();
}

/** 某个分组持有的 key。 */
function key(md, group) {
  return groupsOf(md)[group]?.key;
}

/** 持有 key 的那些分组。 */
function keyed(md) {
  return Object.keys(groupsOf(md)).filter((g) => groupsOf(md)[g].key);
}

function has(models, group, model, suffix = "") {
  return Object.keys(models).some((id) => id.endsWith(`/${group}/${model}${suffix}`));
}

test("sign in reveals the keys it may and names the groups it may not", async () => {
  const site = await startNewAPI();
  try {
    const directory = tmpdir();
    const result = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory });
    const md = authOf(result).metadata;

    assert.equal(md.baseURL, site.base);
    assert.match(md.email, /\(alice\)$/);
    assert.equal(md.email, md.accountId);
    assert.equal(md.userId, 1);
    assert.deepEqual(Object.keys(md.groups).sort(), ["default", "svip", "vip"]);
    assert.equal(key(md, "default"), DEFAULT_KEY);
    assert.equal(key(md, "vip"), VIP_KEY);
    assert.deepEqual(pend(md), ["svip"]);
    // 签到开关是 Magpie 的，账号里不再存这一项。
    assert.equal("checkin" in md, false);
    assert.equal(md.status.quotaPerUnit, 500000);
    assert.equal(md.status.checkin, true);

    // 除账号本身之外，磁盘上没有别的东西。
    assert.equal(fs.existsSync(path.join(directory, "newapi-keys.json")), false);
  } finally {
    await site.close();
  }
});

test("sign in keeps a pasted key when reveal is denied", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const result = await signIn(
      {
        baseURL: site.base,
        accessToken: ACCESS_TOKEN,
        "groupkey:default": "sk-pasted-default-1",
        "groupkey:vip": "sk-pasted-vip-2",
      },
      { directory },
    );
    const md = authOf(result).metadata;
    assert.equal(key(md, "default"), "sk-pasted-default-1");
    assert.equal(key(md, "vip"), "sk-pasted-vip-2");
    assert.deepEqual(pend(md), ["svip"]);
  } finally {
    await site.close();
  }
});

test("a second sign-in keeps the keys the account had", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const first = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN, "groupkey:svip": "sk-pasted-svip-3" }, { directory });
    saveAuth(directory, first);

    // 选中刚刚保存的那个账号，它的 key 会一并用上。
    const account = knownAccounts(directory)[0];
    const second = await signIn({ pick: account.key }, { directory });
    const md = authOf(second).metadata;
    assert.equal(key(md, "svip"), "sk-pasted-svip-3");
    assert.deepEqual(pend(md), ["default", "vip"]);
  } finally {
    await site.close();
  }
});

test("a masked reveal is never taken for a key", async () => {
  const site = await startNewAPI({ reveal: "masked" });
  try {
    const result = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() });
    const md = authOf(result).metadata;
    assert.equal(key(md, "default"), undefined);
    assert.deepEqual(pend(md), ["default", "svip", "vip"]);
  } finally {
    await site.close();
  }
});

test("a refused access token fails with what to fix", async () => {
  const site = await startNewAPI();
  try {
    const result = await signIn({ baseURL: site.base, accessToken: "wrong-token" }, { directory: tmpdir() });
    assert.equal(result.type, "failed");
    assert.match(result.error, /User id/);
  } finally {
    await site.close();
  }
});

test("an sk- key is refused by the access token prompt", () => {
  assert.match(validateAccessToken("sk-not-a-token"), /relay API key/);
  assert.equal(validateAccessToken("an-access-token"), undefined);
  assert.match(validateAccessToken(""), /access token/);
});

test("models carry the site, the group and a per-model protocol", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const discovered = await discover({ md });
    const { models } = buildModels({ md, groups: discovered.groups, pricing: discovered.pricing, options: {} });

    // default 和 vip 都提供 gpt-4o：是 Magpie 的两个模型，不是一个。
    const d4 = entry(models, "default", "gpt-4o");
    const v4 = entry(models, "vip", "gpt-4o");
    assert.notEqual(d4.api.id, v4.api.id);
    assert.equal(d4.api.npm, "@ai-sdk/openai-compatible");
    assert.equal(d4.api.url, `${site.base}/v1`);
    assert.equal(entry(models, "vip", "gpt-5").api.npm, "@ai-sdk/openai");
    assert.equal(entry(models, "vip", "claude-sonnet-4.5").api.npm, "@ai-sdk/anthropic");
    // Gemini 也有 chat 端点，所以默认选 chat。
    assert.equal(entry(models, "vip", "gemini-2.5-pro").api.npm, "@ai-sdk/openai-compatible");
    // 只有 embeddings 的模型不是聊天模型。
    assert.equal(has(models, "default", "text-embedding-3-small"), false);
    // svip 没有 key，所以列不出东西。
    assert.equal(has(models, "svip", "gpt-5"), false);
  } finally {
    await site.close();
  }
});

test("exposeAllProtocols lists every protocol a model supports", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const discovered = await discover({ md });
    const { models } = buildModels({
      md,
      groups: discovered.groups,
      pricing: discovered.pricing,
      options: { exposeAllProtocols: true },
    });
    // 第一个协议保留裸 ID，第二个才带后缀。
    const plain = entry(models, "vip", "gpt-5");
    const chat = entry(models, "vip", "gpt-5", "@chat");
    assert.equal(plain.api.npm, "@ai-sdk/openai");
    assert.equal(chat.api.npm, "@ai-sdk/openai-compatible");
    assert.equal(plain.api.id, chat.api.id);
    assert.ok(has(models, "vip", "claude-sonnet-4.5", "@chat"));
    assert.ok(has(models, "vip", "gemini-2.5-pro", "@chat"));
  } finally {
    await site.close();
  }
});

test("a closed pricing square still lists models from /v1/models", async () => {
  const site = await startNewAPI({ pricingClosed: true });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const discovered = await discover({ md });
    assert.equal(discovered.pricing, null);
    const { models } = buildModels({ md, groups: discovered.groups, pricing: discovered.pricing, options: {} });
    assert.ok(has(models, "default", "gpt-4o"));
    assert.ok(has(models, "vip", "claude-sonnet-4.5"));
    assert.equal(entry(models, "vip", "claude-sonnet-4.5").api.npm, "@ai-sdk/openai-compatible");
  } finally {
    await site.close();
  }
});

test("fetch picks the group's key, restores the model and signs by endpoint", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const doFetch = makeFetch(async () => ({ type: "api", key: ACCESS_TOKEN, metadata: md }));

    const chat = await doFetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JSON.stringify(["vip", "gpt-4o"]), messages: [] }),
    });
    const seenChat = await chat.json();
    assert.equal(
      chat.status,
      200,
      `keys=${keyed(md)} · groups=${Object.keys(md.groups)} · seed=${pend(md)} · body=${JSON.stringify(seenChat)} · reqs=${site.state.requests.map((r) => `${r.method} ${r.path}->${r.status}`).join(",")}`,
    );
    assert.equal(seenChat.seen.model, "gpt-4o");
    assert.equal(seenChat.seen.group, "vip");
    assert.equal(seenChat.seen.auth, VIP_KEY);

    const messages = await doFetch(`${site.base}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify({ model: JSON.stringify(["vip", "claude-sonnet-4.5"]), messages: [] }),
    });
    const seenMessages = await messages.json();
    assert.equal(seenMessages.seen.model, "claude-sonnet-4.5");
    assert.equal(seenMessages.seen.group, "vip");
    const sent = site.state.requests.filter((r) => r.path === "/v1/messages").at(-1);
    assert.equal(sent.headers["x-api-key"], VIP_KEY);
    assert.equal(sent.headers.authorization, undefined);
  } finally {
    await site.close();
  }
});

test("fetch rewrites a Gemini path and signs with x-goog-api-key", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const doFetch = makeFetch(async () => ({ type: "api", key: ACCESS_TOKEN, metadata: md }));
    const id = encodeURIComponent(JSON.stringify(["vip", "gemini-2.5-pro"]));
    const res = await doFetch(`${site.base}/v1beta/models/${id}:streamGenerateContent?alt=sse`, { method: "POST" });
    const seen = await res.json();
    assert.equal(seen.seen.model, "gemini-2.5-pro");
    assert.equal(seen.seen.group, "vip");
    const sent = site.state.requests.filter((r) => r.path.includes(":streamGenerateContent")).at(-1);
    assert.equal(sent.headers["x-goog-api-key"], VIP_KEY);
  } finally {
    await site.close();
  }
});

test("fetch never sends the access token to a relay endpoint", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const doFetch = makeFetch(async () => ({ type: "api", key: ACCESS_TOKEN, metadata: md }));
    await doFetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "x-goog-api-key": ACCESS_TOKEN },
      body: JSON.stringify({ model: JSON.stringify(["default", "gpt-4o"]) }),
    });
    const sent = site.state.requests.filter((r) => r.path === "/v1/chat/completions").at(-1);
    assert.equal(sent.headers.authorization, `Bearer ${DEFAULT_KEY}`);
    assert.equal(sent.headers["x-goog-api-key"], undefined);
  } finally {
    await site.close();
  }
});

test("a group without a key answers how to fix it without lapsing the account", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const doFetch = makeFetch(async () => ({ type: "api", key: ACCESS_TOKEN, metadata: md }));
    const res = await doFetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: JSON.stringify(["svip", "gpt-5"]) }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("x-magpie-sign-in"), "kept");
    const body = await res.json();
    assert.match(body.error.message, /svip/);
    assert.match(body.error.message, /sign in again/i);
  } finally {
    await site.close();
  }
});

test("a refused key is not used at all", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    // 站点把这个分组的 key 拒了：账号里每个分组只有一条 key，
    // 没有第二条可退——请求直接说明情况，而不是再花一次。
    md.groups.vip = { ratio: 0.8, key: "sk-bad-key-0000", problem: "refused" };
    const doFetch = makeFetch(async () => ({ type: "api", key: md.accessToken, metadata: md }));
    const res = await doFetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: JSON.stringify(["vip", "gpt-5"]) }),
    });
    assert.equal(res.status, 503);
    assert.equal(site.state.requests.filter((r) => r.path === "/v1/chat/completions").length, 0);
  } finally {
    await site.close();
  }
});

test("usage is one wallet: left and spent on one meter", async () => {
  const site = await startNewAPI({ quota: 5_000_000, usedQuota: 1_000_000 });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const usage = await buildUsage(md);
    // 5,000,000 剩余 + 1,000,000 已用 = 6,000,000 总额，已用 1/6。
    const wallet = usage.windows.find((w) => w.name === "Balance");
    assert.equal(wallet.used, 16.7);
    assert.equal(wallet.amount, 2);
    assert.equal(wallet.limit, 12);
    assert.equal(wallet.unit, "$");
    // 余额和已用不再是两行。
    assert.equal(usage.windows.filter((w) => w.name === "Balance").length, 1);
    assert.equal(usage.windows.some((w) => w.name === "Used" || w.name === "Groups"), false);
    const missing = usage.windows.find((w) => w.name === "Group keys");
    assert.match(missing.display, /no key: svip/);
    // 干净读取不提登录状态，这正好会清掉失效标记。
    assert.equal(usage.signIn, undefined);
  } finally {
    await site.close();
  }
});

test("usage shows raw quota when the site displays tokens", async () => {
  const site = await startNewAPI({ displayInCurrency: false, quotaDisplayType: "TOKENS" });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const usage = await buildUsage(md);
    const wallet = usage.windows.find((w) => w.name === "Balance");
    assert.equal(wallet.limit, 6_000_000);
    assert.equal(wallet.unit, "quota");
  } finally {
    await site.close();
  }
});

test("check-in claims once and reports the credit", async () => {
  const site = await startNewAPI({ checkedInToday: false });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "claimed");
    assert.equal(result.credit, 0.01); // 5,000 quota / 500,000 per dollar
    assert.match(result.message, /\+\$0\.0100/);
    assert.equal(site.state.checkedIn.length, 1);
  } finally {
    await site.close();
  }
});

test("check-in already done reads as done", async () => {
  const site = await startNewAPI({ checkedInToday: true });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "done");
    assert.equal(result.credit, 0.01);
  } finally {
    await site.close();
  }
});

test("a Turnstile site is a captcha, and nothing is pressed", async () => {
  const site = await startNewAPI({ turnstileCheck: true });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const before = site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length;
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "captcha");
    // 站点自己的开关就是信号；不带令牌的 POST 只会失败。
    assert.equal(site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length, before);
  } finally {
    await site.close();
  }
});

test("a Cloudflare challenge on check-in is a captcha", async () => {
  const site = await startNewAPI({ challenge: "cf" });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "captcha");
    assert.equal(result.blocked, "cf");
    assert.match(result.message, /Cloudflare/);
  } finally {
    await site.close();
  }
});

test("autoCreate makes a token for the missing group and reveals it", async () => {
  const site = await startNewAPI();
  try {
    const result = await signIn(
      { baseURL: site.base, accessToken: ACCESS_TOKEN, autoCreate: "yes" },
      { directory: tmpdir() },
    );
    const md = authOf(result).metadata;
    assert.deepEqual(pend(md), []);
    assert.equal(site.state.created.length, 1);
    assert.equal(site.state.created[0].group, "svip");
    assert.match(key(md, "svip"), /^sk-created-/);
  } finally {
    await site.close();
  }
});

test("a pasted key lands in the one groups map, and every group is listed", async () => {
  const site = await startNewAPI();
  try {
    const result = await signIn(
      { baseURL: site.base, accessToken: ACCESS_TOKEN, "groupkey:vip": VIP_KEY },
      { directory: tmpdir() },
    );
    const md = { ...authOf(result).metadata, accessToken: result.key };
    // 手填的 key 和站点给的 key 存在同一个地方。
    assert.equal(key(md, "vip"), VIP_KEY);
    assert.deepEqual(pend(md), ["svip"]);
    // 问答的答案不会被 Magpie 的 save() 带进账号（它把 undefined 序列化掉）。
    const saved = JSON.parse(JSON.stringify(md));
    assert.equal(Object.keys(saved).some((k) => k.startsWith("groupkey:")), false, "the answer is not kept");

    // 没有过滤器：两个有 key 的分组都列出模型。
    const discovered = await discover({ md });
    const { models } = buildModels({ md, groups: discovered.groups, pricing: discovered.pricing, options: {} });
    assert.ok(has(models, "vip", "gpt-5"));
    assert.ok(has(models, "default", "gpt-4o"));
  } finally {
    await site.close();
  }
});

test("the plugin hook answers check-in with the site's own block", async () => {
  const site = await startNewAPI({ challenge: "cf" });
  try {
    const { NewAPI } = await import("../index.mjs");
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const saved = [];
    const plugin = await NewAPI({
      directory: tmpdir(),
      magpie: { options: () => ({}) },
      client: { auth: { set: async ({ body }) => void saved.push(body) } },
    });
    const getAuth = async () => ({ type: "api", key: ACCESS_TOKEN, metadata: md });

    const blocked = await plugin.auth.checkin(getAuth);
    assert.equal(blocked.outcome, "captcha");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].metadata.checkinBlocked, "cf");

    // 已经标记过了：不再发请求。
    const again = await plugin.auth.checkin(async () => saved[0]);
    assert.equal(again.outcome, "captcha");
  } finally {
    await site.close();
  }
});

test("keys never appear in a sign-in result", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const result = await signIn(
      { baseURL: site.base, accessToken: ACCESS_TOKEN, "groupkey:vip": "sk-secret-vip-999" },
      { directory: tmpdir() },
    );
    assert.equal(result.type, "success");
    // key 存在 metadata 里（这是应该的），但绝不进消息。
    assert.ok(!String(result.error ?? "").includes("sk-secret-vip-999"));
    const usage = await buildUsage({ ...result.metadata, accessToken: result.key });
    assert.ok(!JSON.stringify(usage).includes("sk-secret-vip-999"));
  } finally {
    await site.close();
  }
});

// ---- 真实站点（v1.0.0-rc.46）呈现的形状 --------------------------------

test("a legacy-only site is read and pressed on /api/user/checkin", async () => {
  const site = await startNewAPI({ legacyCheckinOnly: true, checkedInToday: false });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "claimed");
    // 奖励用的是旧形状（data.reward = 3000）。
    assert.equal(result.credit, 0.006);
    const posts = site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin"));
    assert.deepEqual(posts.map((r) => r.path), ["/api/user/checkin"]);
    // 下一次读取看到已完成，仍然走老路径。
    const again = await pressCheckin(md);
    assert.equal(again.outcome, "done");
  } finally {
    await site.close();
  }
});

test("a legacy-only site with today's check-in is done, not a 404", async () => {
  const site = await startNewAPI({ legacyCheckinOnly: true, checkedInToday: true });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "done");
    // mock 记录的奖励是 5,000 额度 = $0.01。
    assert.equal(result.credit, 5000 / 500000);
    assert.equal(site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length, 0);
  } finally {
    await site.close();
  }
});

test("the usage card of a CNY site reads in yuan", async () => {
  // quota_per_unit 500000、usd_exchange_rate 7.3：人民币站点的形状。
  const site = await startNewAPI({ quota: 1_234_567, usedQuota: 765_432, usdExchangeRate: 7.3, quotaDisplayType: "CNY" });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const usage = await buildUsage(md);
    const wallet = usage.windows.find((w) => w.name === "Balance");
    assert.equal(wallet.unit, "¥");
    // 1,234,567 剩余 + 765,432 已用，按 500000/美元、7.3 汇率换算。
    assert.ok(Math.abs(wallet.limit - 29.2) < 0.01, `limit ${wallet.limit}`);
    assert.ok(Math.abs(wallet.amount - 11.18) < 0.01, `amount ${wallet.amount}`);
    assert.equal(wallet.used, 38.3);
  } finally {
    await site.close();
  }
});

test("a CNY check-in credit is in yuan too", async () => {
  const site = await startNewAPI({ legacyCheckinOnly: true, usdExchangeRate: 7.3, quotaDisplayType: "CNY" });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "claimed");
    // 3,000 额度 = $0.006 = ¥0.0438；奖励按站点单位计。
    assert.equal(result.credit, 0.006 * 7.3);
    assert.match(result.message, /¥0\.04/);
  } finally {
    await site.close();
  }
});

test("a CNY site shows its own exchange rate", () => {
  // 真实站点：quota_display_type CNY、usd_exchange_rate 7.3。
  const info = quotaInfo({
    quota_per_unit: 500000,
    display_in_currency: true,
    quota_display_type: "CNY",
    usd_exchange_rate: 7.3,
  });
  assert.equal(info.symbol, "¥");
  assert.equal(info.rate, 7.3);
  // 1,234,567 quota = 2.469134 USD, × 7.3 = ¥18.02
  assert.equal(formatQuota(1234567, info), "¥18.02");
  assert.equal(quotaAsNumber(1234567, info), 18.024678);
});

test("a USD site ignores the CNY rate", () => {
  const info = quotaInfo({ quota_per_unit: 500000, display_in_currency: true, quota_display_type: "USD", usd_exchange_rate: 7.3 });
  assert.equal(info.rate, 1);
  assert.equal(formatQuota(500000, info), "$1.00");
});

test("a Turnstile site is a captcha from its status, before any press", async () => {
  const site = await startNewAPI({ turnstileCheck: true, legacyCheckinOnly: true });
  try {
    const auth = authOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    // 状态里 turnstile_check: true，所以整个签到请求都跳过。
    assert.equal(
      auth.metadata.status.turnstile,
      true,
      `status=${JSON.stringify(auth.metadata.status)} · reqs=${site.state.requests.map((r) => `${r.method} ${r.path}->${r.status}`).join(",")}`,
    );
    const md = { ...auth.metadata, accessToken: auth.key };
    const result = await pressCheckin(md);
    assert.equal(result.outcome, "captcha");
    assert.equal(site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length, 0);
  } finally {
    await site.close();
  }
});

// ---- 两个账号、同一个标识 ----------------------------------------------

test("a second account of one site sends to its own site, not the first's", async () => {
  // 两个站点提供相同的分组与模型名（同一台 New API 主机上的两个账号就是这样）。
  // Magpie 按 id 合并它们的模型列表，所以条目的 api.url 是第一个站点的；
  // 请求仍然必须发到站点 B。
  const a = await startNewAPI();
  const b = await startNewAPI();
  try {
    const mdA = runtimeOf(await signIn({ baseURL: a.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    // 手工填同一个站点标识，就像用户登录第二个账号时可能会做的那样。
    const mdB = runtimeOf(await signIn({ baseURL: b.base, accessToken: ACCESS_TOKEN, siteLabel: mdA.siteLabel }, { directory: tmpdir() }));
    assert.equal(mdA.siteLabel, mdB.siteLabel, "the collision under test");

    // Magpie 为合并后的条目会拼出的地址：站点 A 的 base 与分组。
    const merged = { id: encodeURIComponent(JSON.stringify(["default", "gpt-4o"])), url: `${a.base}/v1` };
    const doFetch = makeFetch(async () => ({ type: "api", key: mdB.accessToken, metadata: mdB }));
    const res = await doFetch(`${merged.url}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: merged.id, messages: [] }),
    });
    assert.equal(res.status, 200);
    const seen = await res.json();
    assert.equal(seen.seen.model, "gpt-4o");
    // 是 B 回答的，说明请求发到了 B，而且用的是 B 的 key。
    assert.equal(b.state.requests.filter((r) => r.path === "/v1/chat/completions").length, 1);
    assert.equal(a.state.requests.filter((r) => r.path === "/v1/chat/completions").length, 0);
    assert.equal(seen.seen.auth, DEFAULT_KEY);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a group the second account has no key for is not signed with another group's key", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    // 站点上有 vip，但这个账号没有它的 key。
    delete md.groups.vip.key;
    const doFetch = makeFetch(async () => ({ type: "api", key: md.accessToken, metadata: md }));
    const res = await doFetch(`${site.base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: JSON.stringify(["vip", "gpt-5"]) }),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /vip/);
    assert.equal(site.state.requests.filter((r) => r.path === "/v1/chat/completions").length, 0);
  } finally {
    await site.close();
  }
});

// ---- 魔改站点的 PoW 签到（runanytime 那类） -----------------------------

const POW_PREFIX = "checkin:1792565712:6573:57c20d569dc58d08:";

/** mock 站点在本机，所以把它当作名单里的主机。 */
function powOpts(site) {
  return { specialHosts: [new URL(site.base).hostname] };
}

test("a PoW site solves the challenge and submits it", async () => {
  const site = await startNewAPI({ pow: { prefix: POW_PREFIX, difficulty: 10 } });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md, powOpts(site));
    assert.equal(result.outcome, "claimed", JSON.stringify(result));
    assert.equal(result.credit, 0.01, "5000 awarded of 500000");
    // 一张题、一个解，题目和解一起提交。
    assert.equal(site.state.powChallenges.length, 1);
    const post = site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).at(-1);
    assert.equal(new URL(`http://x${post.search}`).searchParams.get("pow_challenge"), "challenge-1");
    assert.match(new URL(`http://x${post.search}`).searchParams.get("pow_nonce"), /^[0-9a-f]{8}$/);
  } finally {
    await site.close();
  }
});

test("a site that dropped its PoW signs in as before", async () => {
  // mock 不开 pow，但站点在名单里：插件问一次题目，站点回 404，
  // 于是照常签到，不会卡在「这道题算不出来」。
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md, powOpts(site));
    assert.equal(result.outcome, "claimed", JSON.stringify(result));
    assert.equal(site.state.requests.filter((r) => r.path === "/api/user/pow/challenge").length, 1, "问过一次");
    assert.equal(site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length, 1, "只按了一次");
  } finally {
    await site.close();
  }
});

test("a challenge the site turned down is asked for again, once", async () => {
  // 题是一次性的：算题和等请求都可能让题过期。第一次被判无效时，
  // 插件重新要一道题再试，而不是直接失败。
  const site = await startNewAPI({ pow: { prefix: POW_PREFIX, difficulty: 10 }, powRejectFirst: 1 });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md, powOpts(site));
    assert.equal(result.outcome, "claimed", JSON.stringify(result));
    assert.equal(site.state.powChallenges.length, 2, "换了第二道题");
    const posts = site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin"));
    assert.equal(posts.length, 2);
    // 第二次带的是新题，不是重放旧的那张。
    assert.equal(new URL(`http://x${posts[1].search}`).searchParams.get("pow_challenge"), "challenge-2");
  } finally {
    await site.close();
  }
});

test("a challenge that keeps failing gives up after one retry", async () => {
  const site = await startNewAPI({ pow: { prefix: POW_PREFIX, difficulty: 10 }, powRejectFirst: 5 });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md, powOpts(site));
    assert.equal(result.outcome, "failed");
    assert.match(String(result.message), /pow/i);
    assert.equal(site.state.powChallenges.length, 2, "只重试一次，不会一直要题");
  } finally {
    await site.close();
  }
});

test("a host outside the list never asks for a challenge", async () => {
  const site = await startNewAPI({ pow: { prefix: POW_PREFIX, difficulty: 10 } });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    // 不传 specialHosts：站点不在名单里，按普通 New API 处理。
    const result = await pressCheckin(md);
    assert.equal(site.state.requests.some((r) => r.path === "/api/user/pow/challenge"), false);
    assert.equal(result.outcome, "failed", "站点要求 PoW，没带就被拒");
    assert.match(String(result.message), /pow/i);
  } finally {
    await site.close();
  }
});

// ---- 掩码 key 的自动回填 ------------------------------------------------

test("a masked list is revealed, GET or POST, whichever the site takes", async () => {
  // 列表是掩码、batch 接口没有，只有 GET 的 /:id/key 能拿到明文。
  const site = await startNewAPI({ reveal: "allow", revealMethod: "GET" });
  try {
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() });
    const md = authOf(signed).metadata;
    assert.equal(key(md, "default"), DEFAULT_KEY, "GET reveal 拿到的 key");
    assert.equal(key(md, "vip"), VIP_KEY);
    assert.deepEqual(pend(md), ["svip"]);
    // 只对掩码的 key 请求，明文的不白问
    assert.ok(site.state.requests.some((r) => r.method === "GET" && /\/api\/token\/\d+\/key$/.test(r.path)));
  } finally {
    await site.close();
  }
});

test("a POST-only site is revealed too", async () => {
  const site = await startNewAPI({ reveal: "allow", revealMethod: "POST" });
  try {
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() });
    const md = authOf(signed).metadata;
    assert.equal(key(md, "default"), DEFAULT_KEY);
    assert.equal(key(md, "vip"), VIP_KEY);
  } finally {
    await site.close();
  }
});

test("a site that reveals with neither method leaves the groups to the user", async () => {
  const site = await startNewAPI({ revealMethod: "none" });
  try {
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() });
    const md = authOf(signed).metadata;
    assert.deepEqual(pend(md), ["default", "svip", "vip"], "三个分组都需要手填");
  } finally {
    await site.close();
  }
});

test("a list that is already plaintext is taken as it is", async () => {
  const site = await startNewAPI({ maskKeys: true, revealMethod: "none" });
  try {
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() });
    const md = authOf(signed).metadata;
    // 站点连 reveal 接口都没有，但列表里就是明文：不需要再问。
    assert.equal(key(md, "default"), DEFAULT_KEY);
    assert.equal(key(md, "vip"), VIP_KEY);
    assert.equal(site.state.requests.some((r) => /\/api\/token\/\d+\/key$/.test(r.path)), false);
  } finally {
    await site.close();
  }
});

/** 拒绝读分组的 fetch：模拟把 /groups 藏在权限后面的站点。 */
function refuseGroups(fetchImpl) {
  return async (url, init) => {
    if (String(url).includes("/groups")) {
      return new Response(JSON.stringify({ success: false, message: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return fetchImpl(url, init);
  };
}

test("a site that refuses its groups endpoint keeps the account's own table", async () => {
  // 站点拒绝 /groups（很多站点把它藏在权限后面）：分组表不能因此被清空，
  // 手填的 key 更不能丢——用户的正是这条路。
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const md = runtimeOf(
      await signIn(
        { baseURL: site.base, accessToken: ACCESS_TOKEN, "groupkey:default": "sk-my-own", "groupkey:vip": "sk-my-vip" },
        { directory: tmpdir() },
      ),
    );
    const out = await syncAccount(md, { fetchImpl: refuseGroups(globalThis.fetch), force: true });
    assert.deepEqual(Object.keys(out.groups).sort(), ["default", "svip", "vip"], "分组一个都没少");
    assert.equal(out.groups.default.key, "sk-my-own", "手填的 key 还在");
    assert.equal(out.groups.vip.key, "sk-my-vip");
  } finally {
    await site.close();
  }
});

test("a sync that cannot reach the site changes nothing", async () => {
  const site = await startNewAPI();
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const before = JSON.stringify(md.groups);
    const out = await syncAccount(md, {
      fetchImpl: async () => {
        throw Object.assign(new Error("offline"), { status: 0 });
      },
      force: true,
    });
    assert.equal(JSON.stringify(out.groups), before, "连不上就什么都不动");
    assert.equal(out.changed, false);
  } finally {
    await site.close();
  }
});

// ---- 按 host 特化的站点（hyxware.com） --------------------------------------
//
// 这些站点在 New API 上做了自己的改动，读法与通用路径不同。测试让本机
// mock 冒充名单里的站点（specialHosts），与 runanytime.mjs 的做法一致。

/** 让 sync/signIn 把一个本机 mock 当成名单里的站点。 */
function asSpecial(site) {
  return [new URL(site.base).hostname];
}

test("hyxware: a lean list is filled from the token details", async () => {
  // 这个站点的列表只回 id/name/key/status：分组和额度在详情里。
  // 少了分组，一个分组都找不到 key；少了额度，token 会被当成用完了。
  const site = await startNewAPI({ leanList: true, reveal: "allow" });
  try {
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, {
      directory: tmpdir(),
      specialHosts: asSpecial(site),
    });
    const md = authOf(signed).metadata;
    assert.equal(key(md, "default"), DEFAULT_KEY, "详情补出的分组和 key");
    assert.equal(key(md, "vip"), VIP_KEY);
    assert.deepEqual(pend(md), ["svip"], "只有真没有 token 的分组才缺 key");
    assert.ok(site.state.detailsRead >= 2, "列表缺字段时读了详情");
  } finally {
    await site.close();
  }
});

test("hyxware: one token serving two groups keys both of them", async () => {
  // 魔改点：一个 token 可以同时勾多个分组（groups 是数组）。
  // 聚合 token 只建了一条，但两个分组都能用它——两个分组都要拿到 key。
  const site = await startNewAPI({ leanList: true, reveal: "allow" });
  try {
    site.state.tokens = [
      { id: 7, name: "combo", key: COMBO_KEY, group: "vip", groups: ["vip", "svip"], status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
    ];
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, {
      directory: tmpdir(),
      specialHosts: asSpecial(site),
    });
    const md = authOf(signed).metadata;
    assert.equal(key(md, "vip"), COMBO_KEY, "token 自己的分组");
    assert.equal(key(md, "svip"), COMBO_KEY, "它另外勾的分组也是同一条 key");
    assert.deepEqual(pend(md), ["default"]);
  } finally {
    await site.close();
  }
});

test("hyxware: a group only a token knows about joins the table", async () => {
  // 站点公开的分组表里没有 A，但一条 A,B 的 token 说明 A 能用：
  // A 也要进表，否则它永远没有 key。
  const site = await startNewAPI({ leanList: true, reveal: "allow" });
  try {
    site.state.tokens = [
      { id: 8, name: "combo", key: COMBO_KEY, group: "vip", groups: ["vip", "extra"], status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
    ];
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, {
      directory: tmpdir(),
      specialHosts: asSpecial(site),
    });
    const md = authOf(signed).metadata;
    assert.deepEqual(Object.keys(groupsOf(md)).sort(), ["default", "extra", "svip", "vip"]);
    assert.equal(key(md, "extra"), COMBO_KEY, "token 认领的分组进了表并拿到 key");
  } finally {
    await site.close();
  }
});

test("hyxware: the sync keeps the keys it just found", async () => {
  const site = await startNewAPI({ leanList: true, reveal: "allow" });
  try {
    site.state.tokens = [
      { id: 9, name: "combo", key: COMBO_KEY, group: "vip", groups: ["vip", "svip"], status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
    ];
    const md = runtimeOf(
      await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir(), specialHosts: asSpecial(site) }),
    );
    const out = await syncAccount(md, { force: true, specialHosts: asSpecial(site) });
    assert.equal(out.groups.vip.key, COMBO_KEY, "同步后还是同一条 key");
    assert.equal(out.groups.svip.key, COMBO_KEY);
  } finally {
    await site.close();
  }
});

test("hyxware: a plain site alongside it is unaffected", async () => {
  // 通用站点不该被特化逻辑碰到：同一个 mock，不传 specialHosts 时
  // 分组表就按站点给的那三个来。
  const site = await startNewAPI({});
  try {
    site.state.tokens = [
      { id: 10, name: "combo", key: COMBO_KEY, group: "vip", groups: ["vip", "extra"], status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
    ];
    const signed = await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() });
    const md = authOf(signed).metadata;
    assert.deepEqual(Object.keys(groupsOf(md)).sort(), ["default", "svip", "vip"], "没有 extra");
  } finally {
    await site.close();
  }
});

test("runanytime signs in without reading its status or Turnstile", async () => {
  // 这个站点的状态接口和 /api/status 都挂着 Turnstile：读状态只会得到
  // 「去它的 App 里签到」，而带访问令牌的 PoW 签到本身是通的。
  // 所以它不读状态、不看 Turnstile，直接取题 → 算题 → 提交。
  const site = await startNewAPI({
    pow: { prefix: POW_PREFIX, difficulty: 10 },
    statusTurnstile: true,
  });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    // 账号里记着「站点要 Turnstile」——普通站点这时会被直接拦下。
    md.status = { ...(md.status ?? {}), turnstile: true };
    const result = await pressCheckin(md, powOpts(site));
    assert.equal(result.outcome, "claimed", JSON.stringify(result));
    // 没读状态：没有那条 GET。
    assert.equal(
      site.state.requests.filter((r) => r.method === "GET" && r.path.includes("checkin")).length,
      0,
      "不读状态",
    );
    // 先要一道题，再带着解提交。
    assert.equal(site.state.powChallenges.length, 1);
    assert.equal(site.state.requests.filter((r) => r.method === "POST" && r.path.includes("checkin")).length, 1);
  } finally {
    await site.close();
  }
});

test("runanytime still reports a check-in the site already counted", async () => {
  const site = await startNewAPI({ pow: { prefix: POW_PREFIX, difficulty: 10 }, checkedInToday: true });
  try {
    const md = runtimeOf(await signIn({ baseURL: site.base, accessToken: ACCESS_TOKEN }, { directory: tmpdir() }));
    const result = await pressCheckin(md, powOpts(site));
    assert.equal(result.outcome, "done", JSON.stringify(result));
  } finally {
    await site.close();
  }
});
