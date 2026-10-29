import assert from "node:assert/strict";
import { test } from "node:test";

import { readTarget, rewriteBodyModel, rewriteGeminiPath } from "../src/fetch.mjs";
import { wireId } from "../src/protocols.mjs";

test("readTarget reads the body's encoded model", () => {
  const body = JSON.stringify({ model: wireId("vip", "gpt-5"), messages: [] });
  assert.deepEqual(readTarget("/v1/chat/completions", body), { group: "vip", model: "gpt-5" });
});

test("readTarget reads a Gemini path segment", () => {
  const path = `/v1beta/models/${wireId("vip", "gemini-2.5-pro")}:streamGenerateContent`;
  assert.deepEqual(readTarget(path, ""), { group: "vip", model: "gemini-2.5-pro" });
});

test("readTarget falls back to a bare model", () => {
  assert.deepEqual(readTarget("/v1/responses", JSON.stringify({ model: "gpt-4o" })), { group: "", model: "gpt-4o" });
  assert.equal(readTarget("/v1/models", ""), null);
  assert.equal(readTarget("/v1/chat/completions", "not json"), null);
});

test("rewriteBodyModel puts the bare model in and keeps the rest", () => {
  const body = JSON.stringify({ model: wireId("vip", "gpt-5"), stream: true, messages: [{ role: "user", content: "hi" }] });
  const out = JSON.parse(rewriteBodyModel(body, "gpt-5"));
  assert.equal(out.model, "gpt-5");
  assert.equal(out.stream, true);
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
});

test("rewriteBodyModel leaves a body that has no model", () => {
  const body = JSON.stringify({ prompt: "hi" });
  assert.equal(rewriteBodyModel(body, "x"), body);
});

test("rewriteGeminiPath replaces only the model segment", () => {
  const id = wireId("vip", "gemini-2.5-pro");
  const href = `https://x/v1beta/models/${id}:streamGenerateContent?alt=sse`;
  assert.equal(rewriteGeminiPath(href, "gemini-2.5-pro"), "https://x/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
});

test("wireId stays safe in a Gemini path", () => {
  const id = wireId("vip", "vendor/model:beta");
  const href = `https://x/v1beta/models/${id}:generateContent`;
  const seg = href.split("/models/")[1].split(":")[0];
  assert.deepEqual(readTarget(`/v1beta/models/${seg}:generateContent`, ""), { group: "vip", model: "vendor/model:beta" });
});

// ---- the URL always belongs to the account doing the asking ---------------

import { ownURL } from "../src/fetch.mjs";

test("a URL at the account's own site is left exactly as Magpie built it", () => {
  const md = { baseURL: "https://a.example.com" };
  const href = "https://a.example.com/v1/chat/completions";
  const got = ownURL(href, md);
  assert.equal(got.sameSite, true);
  assert.equal(got.href, href);
});

test("a URL at another site is rebuilt on the account's own base", () => {
  // The merged model list gave the first account's api.url (site A) while the
  // account doing the asking is site B: sending there would sign A's request
  // with B's key.
  const md = { baseURL: "https://b.example.com" };
  const got = ownURL("https://a.example.com/v1/chat/completions", md);
  assert.equal(got.sameSite, false);
  assert.equal(got.href, "https://b.example.com/v1/chat/completions");
});

test("a rebuilt Gemini URL keeps its model and action", () => {
  const md = { baseURL: "https://b.example.com" };
  const id = encodeURIComponent(JSON.stringify(["vip", "gemini-2.5-pro"]));
  const got = ownURL(`https://a.example.com/v1beta/models/${id}:streamGenerateContent?alt=sse`, md);
  assert.equal(got.href, `https://b.example.com/v1beta/models/${id}:streamGenerateContent?alt=sse`);
});

test("a base with a path prefix is respected", () => {
  const md = { baseURL: "https://proxy.example.com/newapi" };
  const got = ownURL("https://a.example.com/v1/messages", md);
  assert.equal(got.href, "https://proxy.example.com/newapi/v1/messages");
  // and a request already under it is left alone
  assert.equal(ownURL("https://proxy.example.com/newapi/v1/messages", md).sameSite, true);
});

test("one key per group: a refused one is not tried, a working one is", async () => {
  const { keysToTry } = await import("../src/state.mjs");
  // The metadata holds one key per group, so there is nothing to fall back
  // on: a refused key answers 503 (the caller says so) instead of spending
  // the request again on a key the site already turned away.
  assert.deepEqual(keysToTry({ vip: { key: "sk-a", problem: "refused" } }, "vip"), []);
  assert.deepEqual(keysToTry({ vip: { key: "sk-a" } }, "vip"), ["sk-a"]);
  assert.deepEqual(keysToTry({ vip: { key: "sk-a", problem: "gone" } }, "vip"), []);
  assert.deepEqual(keysToTry({ vip: { tried: true } }, "vip"), []);
  assert.deepEqual(keysToTry({}, "vip"), []);
});
