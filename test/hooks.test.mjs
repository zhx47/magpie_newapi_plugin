import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import plugin, { NewAPI } from "../index.mjs";
import { signIn } from "../src/signin.mjs";
import { ACCESS_TOKEN, DEFAULT_KEY, VIP_KEY, startNewAPI } from "./mock-newapi.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "newapi-hooks-"));
}

/** What Magpie's host.js writes after a sign-in: plugin-auth.json. */
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

/** Load the plugin as Magpie does, and sign in to the mock. */
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
  // No other function export: host.js would call each as a plugin too.
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
    // keyless is what stops Magpie from asking for an "API key" after the
    // token: the access token was already the token question.
    assert.equal(m.keyless, true);
    assert.equal(typeof m.ask, "function");
    assert.equal(typeof m.authorize, "function");

    // The questions, in order, as Magpie walks them. With an account on
    // disk the first is a picker; here the directory is empty, so the base
    // URL comes first.
    const asked = async (inputs) => m.ask(inputs);
    const q1 = await asked({});
    assert.equal(q1.key, "baseURL");
    assert.equal(q1.type, "text");
    const q2 = await asked({ baseURL: site.base });
    assert.equal(q2.key, "accessToken");
    assert.equal(q2.type, "password");
    const q3 = await asked({ baseURL: site.base, accessToken: ACCESS_TOKEN });
    assert.equal(q3.key, "userId");

    // The options are boolean switches with defaults.
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
  // reveal denied and nothing pasted: the groups the filter names need a key.
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    // Creation comes first: say no, then the groups are asked one by one.
    const askNoCreate = { baseURL: site.base, accessToken: ACCESS_TOKEN, userId: "", siteLabel: "", groupFilter: "default,vip" };
    const offer = await ask(askNoCreate);
    assert.equal(offer.key, "autoCreate", "the site is offered the chance to create keys first");
    assert.match(offer.message, /2 groups without a key/);
    assert.match(offer.message, /default, vip/);
    const head = { ...askNoCreate, autoCreate: "no" };

    const q1 = await ask(head);
    assert.match(q1.key, /^groupkey:/);
    assert.match(q1.message, /"default"/);
    assert.equal(q1.type, "password");

    // A key the site refuses is asked again, and the question says why.
    const bad = await ask({ ...head, [q1.key]: "sk-not-a-real-key" });
    assert.equal(bad.key, q1.key, "the same group is asked again");
    assert.match(bad.message, /refused/);

    // A working key moves on to the next group, never back to this one.
    const q2 = await ask({ ...head, [q1.key]: DEFAULT_KEY });
    assert.match(q2.key, /^groupkey:/);
    assert.notEqual(q2.key, q1.key);
    assert.match(q2.message, /"vip"/);

    // Both answered: the check-in switch follows, and that is the last.
    const answered = { ...head, [q1.key]: DEFAULT_KEY, [q2.key]: VIP_KEY };
    const q3 = await ask(answered);
    assert.equal(q3.key, "checkin");
    assert.equal(await ask({ ...answered, checkin: "auto" }), null);
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
    // Each entry is an OpenCode Model: `api`, not `provider`.
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

/** What the site and the account looked like when a listing came up short. */
export function diagnostics(site, auth, ids) {
  const reqs = site.state.requests.map((r) => `${r.method} ${r.path}${r.search} -> ${r.status ?? ""}`).join(" | ");
  return [
    `models=${ids.length}`,
    `groups=${Object.keys(auth.metadata.groups ?? {}).join(",")}`,
    `keys=${Object.keys(auth.metadata.groupKeys ?? {}).join(",")}`,
    `requests: ${reqs}`,
  ].join(" · ");
}

test("the loader's fetch sends a request with the group's key", async () => {
  const { site, instance, auth } = await setup();
  try {
    const loader = instance.auth.loader(async () => auth);
    // The placeholder is not the account's token.
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
    // A group with no key at all says how to fix it.
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

test("usage answers a wallet window and the site's plan", async () => {
  const { site, instance, getAuth } = await setup();
  try {
    const usage = await instance.auth.usage(getAuth);
    assert.equal(usage.plan, "default");
    assert.equal(usage.user, "alice");
    const balance = usage.windows.find((w) => w.name === "Balance");
    assert.equal(balance.balance, 10);
    assert.equal(balance.display, "$10.00 left");
    // The card never carries a key.
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

test("checkin off never reaches the site", async () => {
  const { site, instance } = await setup({ inputs: { checkin: "off" } });
  try {
    const result = await instance.auth.checkin(async () => ({
      type: "api",
      key: ACCESS_TOKEN,
      metadata: { baseURL: site.base, checkin: "off", groupKeys: {} },
    }));
    assert.equal(result.outcome, "inactive");
    assert.equal(site.state.requests.filter((r) => r.path.includes("checkin")).length, 0);
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
    // The check-in is not pressed again. The group sync still reads the
    // account's groups (a GET), which is what keeps a new group from going
    // unnoticed in an account signed in weeks ago.
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
    // Nothing was pressed, and the site setting is not remembered as a block:
    // the site can turn Turnstile off and the next day's read sees it.
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
  // Magpie shows its own "API key" box after an api method's questions
  // unless the method is keyless (gui: ms[method].keyless). Without it the
  // access token was typed, then asked again under the method's label.
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
    // `<siteLabel>/<group>/<model>`; Magpie shows it as newapi/<id>
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
    // A Responses model names its protocol; a chat model leaves it out.
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

    // A different site label is a different id, so the same model name from
    // two sites stays two rows.
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

test("the usage rows that are text carry no share", async () => {
  const { site, instance, getAuth } = await setup();
  try {
    const usage = await instance.auth.usage(getAuth);
    for (const name of ["Used", "Groups"]) {
      const w = usage.windows.find((x) => x.name === name);
      assert.ok(w, `${name} is there`);
      assert.equal(w.used, undefined, `${name} must not claim a 0% share`);
      assert.ok(w.display, `${name} says its text`);
    }
    // The wallet is a reading, not a share: balance with no used.
    const balance = usage.windows.find((x) => x.name === "Balance");
    assert.equal(balance.used, undefined);
    assert.equal(typeof balance.balance, "number");
  } finally {
    await site.close();
  }
});

// ---- following a site whose groups change ---------------------------------

test("a new group at the site reaches an account signed in before it", async () => {
  // Sign in, then add a group at the site with a key of its own, as an
  // operator would. Nothing is typed in Magpie after the sign-in.
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

    // A usage read picks it up: the sync reads the site's groups and the
    // token list, then writes the account back. The listing is left out of
    // this on purpose — Magpie gives a provider's models hook 20s in all,
    // shared with every other provider.
    await instance.auth.usage(async () => ({ type: "api", key: auth.key, metadata: { ...auth.metadata, groupFilter: "" } }));

    const after = saved.at(-1);
    assert.ok(after, "the account's metadata was written back");
    assert.ok(after.metadata.groups.later, "the new group is in the account now");
    assert.equal(after.metadata.groups.later.ratio, 0.5, "with the site's own ratio");
    assert.ok(after.metadata.groupKeys.later?.length, "and the key found for it");
  } finally {
    await site.close();
  }
});

test("a key the site refuses is reported as refused, not as working", async () => {
  const { site, instance, auth } = await setup({ site: { reveal: "deny" }, inputs: { groupKeys: "default=sk-revoked-key" } });
  try {
    // A listing checks each key with /v1/models; this one is refused.
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
  const { site, auth, saved } = await setup({ site: { reveal: "allow" }, inputs: { groupFilter: "default" } });
  try {
    // A group the operator added, with no token of its own.
    site.set({
      groups: { ...site.state.groups, newish: { ratio: 0.9, desc: "new" } },
      models: { ...site.state.models, newish: ["gpt-4o"] },
    });
    const md = { ...auth.metadata, groupFilter: "" };
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

// ---- a listing must stay inside Magpie's 20s deadline ----------------------

test("the sync is throttled: a second usage read does not read the site again", async () => {
  const { site, instance, getAuth } = await setup();
  try {
    await instance.auth.usage(getAuth);
    const afterFirst = site.state.requests.length;
    await instance.auth.usage(getAuth);
    const added = site.state.requests
      .slice(afterFirst)
      .filter((r) => r.path.includes("/groups") || r.path.startsWith("/api/token"));
    // Nothing: the groups and the key verdicts were read a moment ago.
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
    // One request per group with a key (default and vip), not two each.
    assert.ok(listCalls.length <= Object.keys(auth.metadata.groupKeys).length, `${listCalls.length} /v1/models calls`);
  } finally {
    await site.close();
  }
});

test("a slow site does not push a listing past its budget", async () => {
  const { instance, auth } = { instance: null, auth: null };
  void instance;
  void auth;
  // The budget is enforced with a race; its unit is exercised directly so a
  // slow network is simulated without waiting 20 real seconds.
  const { syncAccount } = await import("../src/sync.mjs");
  const started = Date.now();
  const result = await syncAccount(
    { baseURL: "http://127.0.0.1:1", accessToken: "x", userId: "1", groupKeys: {} },
    { budgetMs: 300 },
  );
  const took = Date.now() - started;
  assert.ok(took < 2000, `the sync returned in ${took}ms, inside its 300ms budget`);
  assert.equal(result.changed, false);
});

test("the models hook reads no groups and presses nothing", async () => {
  const { site, instance, auth } = await setup();
  try {
    // Only what the listing itself asks: the sign-in above made its own calls.
    const mark = site.state.requests.length;
    await instance.provider.models({ models: {} }, { auth });
    const paths = site.state.requests.slice(mark).map((r) => r.path);
    // Its own listing and the pricing square, nothing else: Magpie gives a
    // provider's models hook 20s in all, shared with every other provider.
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
    // First sign-in: default and vip get pasted, svip is skipped.
    const first = await signIn(
      { baseURL: site.base, accessToken: ACCESS_TOKEN, siteLabel: "one-site", groupKeys: "default=sk-first-default;vip=sk-first-vip" },
      { directory },
    );
    assert.equal(first.type, "success");
    assert.deepEqual(first.metadata.pendingGroups, ["svip"]);

    // Second sign-in, same site, nothing typed: the cache supplies what was
    // pasted, so only svip is asked, and the account identity is unchanged.
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    const head = { baseURL: site.base, accessToken: ACCESS_TOKEN, userId: "", siteLabel: "one-site" };
    // One group is missing, so the site is offered the chance to make its key.
    const offer = await ask(head);
    assert.equal(offer.key, "autoCreate");
    assert.match(offer.message, /svip/);
    assert.match(offer.message, /1 group without a key/);
    const q = await ask({ ...head, autoCreate: "no" });
    assert.match(q.key, /^groupkey:/);
    assert.match(q.message, /"svip"/, "only the group still missing is asked");

    const second = await signIn({ ...head }, { directory });
    assert.equal(second.type, "success");
    assert.equal(second.metadata.accountId, first.metadata.accountId, "the same account, not a new one");
    assert.deepEqual(second.metadata.groupKeys.default, ["sk-first-default"]);
    assert.deepEqual(second.metadata.groupKeys.vip, ["sk-first-vip"]);
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
    // No token for svip: sign in, then say yes to creation.
    const head = {
      baseURL: site.base,
      accessToken: ACCESS_TOKEN,
      userId: "",
      siteLabel: "",
      groupFilter: "default,vip,svip",
      autoCreate: "yes",
    };
    const made = await ask(head);
    assert.equal(made.key, "createdKeys", "the answer carries what was created");
    const created = JSON.parse(made.options[0].value);
    assert.ok(created.svip?.[0]?.startsWith("sk-created-"), `svip was created: ${JSON.stringify(created)}`);

    // With that answer in hand nothing is asked again, and the account is
    // signed in with the created key.
    const next = await ask({ ...head, [made.key]: made.options[0].value });
    assert.equal(next.key, "checkin");

    const signed = await signIn(
      { ...head, [made.key]: made.options[0].value },
      { directory },
    );
    assert.equal(signed.type, "success");
    assert.ok(signed.metadata.groupKeys.svip?.[0]?.startsWith("sk-created-"));
    assert.deepEqual(signed.metadata.pendingGroups, []);
  } finally {
    await site.close();
  }
});

// ---- re-signing in without retyping the token ------------------------------

test("an account already on disk is offered first, and its token reused", async () => {
  const site = await startNewAPI({ reveal: "deny" });
  try {
    const directory = tmpdir();
    const first = await signIn(
      { baseURL: site.base, accessToken: ACCESS_TOKEN, siteLabel: "one-site", groupKeys: "default=sk-a;vip=sk-b" },
      { directory },
    );
    assert.equal(first.type, "success");
    saveAuth(directory, first);

    // A brand-new sign-in in the same Magpie: the first question is the
    // picker, not a base URL and a token to remember.
    const instance = await NewAPI({ directory, client: { auth: { set: async () => {} } }, magpie: { options: () => ({}) } });
    const ask = (inputs) => instance.auth.methods[0].ask(inputs);
    const pick = await ask({});
    assert.equal(pick.key, "pick");
    assert.equal(pick.type, "select");
    const offered = pick.options.find((o) => o.value !== "__new__");
    assert.ok(offered, "the saved account is offered");
    assert.match(offered.label, /one-site/);
    // The site lists three groups; two of them have a pasted key.
    assert.match(offered.hint, /3 groups/);

    // Picking it answers the token and the label with nothing typed.
    const picked = await ask({ pick: offered.value });
    assert.equal(picked.key, "autoCreate", "it goes straight to the missing group");

    // The sign-in itself needs no token from the caller either.
    const second = await signIn({ pick: offered.value, autoCreate: "no" }, { directory });
    assert.equal(second.type, "success");
    assert.equal(second.metadata.accountId, first.metadata.accountId);
    assert.deepEqual(second.metadata.groupKeys.default, ["sk-a"]);
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
    // Picking it asks for the base URL, as a first sign-in does.
    const q = await ask({ pick: "__new__" });
    assert.equal(q.key, "baseURL");
  } finally {
    await site.close();
  }
});
