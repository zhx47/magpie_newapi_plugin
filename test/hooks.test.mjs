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

test("auth declares one API-key method with the prompts the docs describe", () => {
  return (async () => {
    const { site, instance, close } = await setup();
    try {
      const auth = instance.auth;
      assert.equal(auth.provider, "newapi");
      assert.equal(auth.methods.length, 1);
      assert.equal(auth.methods[0].type, "api");
      const keys = auth.methods[0].prompts.map((p) => p.key);
      assert.deepEqual(keys, ["baseURL", "accessToken", "userId", "siteLabel", "groupFilter", "groupKeys", "checkin", "autoCreate"]);
      // Every prompt has a type and a message; the check-in has both choices.
      for (const p of auth.methods[0].prompts) {
        assert.ok(p.type, `${p.key} has a type`);
        assert.ok(p.message, `${p.key} has a message`);
      }
      const checkin = auth.methods[0].prompts.find((p) => p.key === "checkin");
      assert.deepEqual(
        checkin.options.map((o) => o.value),
        ["auto", "off"],
      );
      // The options are boolean switches with defaults.
      assert.ok(auth.options.length >= 4);
      for (const o of auth.options) {
        assert.equal(typeof o.default, "boolean");
        assert.ok(o.label);
      }
    } finally {
      await site.close();
    }
  })();
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
    assert.equal(site.state.requests.length, before, "no request once the block is known");
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
