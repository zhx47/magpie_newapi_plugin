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
