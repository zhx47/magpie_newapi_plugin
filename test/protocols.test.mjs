import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authStyleOf,
  chooseProtocols,
  geminiModelSegment,
  isChatEndpoint,
  parseWireId,
  protocolOf,
  wireId,
} from "../src/protocols.mjs";

test("endpoint types map to Magpie protocols", () => {
  assert.equal(protocolOf("openai"), "chat");
  assert.equal(protocolOf("openai_response"), "responses");
  assert.equal(protocolOf("anthropic"), "anthropic");
  assert.equal(protocolOf("gemini"), "gemini");
  assert.equal(protocolOf("embeddings"), "");
  assert.equal(protocolOf("image_generation"), "");
});

test("only conversation endpoints are chat models", () => {
  assert.equal(isChatEndpoint("openai"), true);
  assert.equal(isChatEndpoint("openai_response"), true);
  assert.equal(isChatEndpoint("anthropic"), true);
  assert.equal(isChatEndpoint("gemini"), true);
  assert.equal(isChatEndpoint("embeddings"), false);
  assert.equal(isChatEndpoint("image_generation"), false);
  assert.equal(isChatEndpoint("openai_video"), false);
  assert.equal(isChatEndpoint("jina_rerank"), false);
});

test("chooseProtocols prefers the model maker's API", () => {
  assert.deepEqual(chooseProtocols(["openai"], "gpt-4o"), ["chat"]);
  assert.deepEqual(chooseProtocols(["openai_response"], "gpt-5"), ["responses"]);
  assert.deepEqual(chooseProtocols(["openai", "openai_response"], "gpt-5"), ["responses"]);
  assert.deepEqual(chooseProtocols(["openai", "openai_response"], "gpt-4o"), ["chat"]);
  assert.deepEqual(chooseProtocols(["openai", "anthropic"], "claude-sonnet-4.5"), ["anthropic"]);
  assert.deepEqual(chooseProtocols(["openai", "anthropic"], "some-model"), ["chat"]);
  assert.deepEqual(chooseProtocols(["gemini", "openai"], "gemini-2.5-pro"), ["chat"]);
  assert.deepEqual(chooseProtocols(["gemini"], "gemini-2.5-pro"), ["gemini"]);
});

test("protocol switches turn the preferences off", () => {
  assert.deepEqual(chooseProtocols(["openai", "openai_response"], "gpt-5", { preferResponses: false }), ["chat"]);
  assert.deepEqual(chooseProtocols(["openai", "anthropic"], "claude-x", { preferAnthropic: false }), ["chat"]);
});

test("exposeAllProtocols lists every protocol, Gemini first for Gemini models", () => {
  assert.deepEqual(chooseProtocols(["openai", "openai_response"], "gpt-5", { exposeAllProtocols: true }), ["responses", "chat"]);
  assert.deepEqual(chooseProtocols(["gemini", "openai"], "gemini-2.5-pro", { exposeAllProtocols: true }), ["gemini", "chat"]);
  assert.deepEqual(chooseProtocols(["anthropic", "openai"], "claude-x", { exposeAllProtocols: true }), ["anthropic", "chat"]);
});

test("no endpoint information means chat", () => {
  assert.deepEqual(chooseProtocols([], "anything"), ["chat"]);
  assert.deepEqual(chooseProtocols(undefined, "anything"), ["chat"]);
});

test("wireId round-trips groups and models with punctuation", () => {
  for (const [group, model] of [
    ["default", "gpt-4o"],
    ["vip", "vendor/model:beta"],
    ["a b", "x/y z"],
    ["组", "模型"],
  ]) {
    const id = wireId(group, model);
    assert.deepEqual(parseWireId(id), { group, model });
    // Gemini 会把它放进路径段：不能有未转义的斜杠或冒号
    assert.ok(!id.includes("/"));
    assert.ok(!id.includes(":"));
  }
});

test("parseWireId tolerates double encoding and refuses junk", () => {
  const id = wireId("vip", "gpt-5");
  assert.deepEqual(parseWireId(encodeURIComponent(id)), { group: "vip", model: "gpt-5" });
  assert.equal(parseWireId("gpt-4o"), null);
  assert.equal(parseWireId(""), null);
  assert.equal(parseWireId("%E0%A4%A"), null);
});

test("gemini path segment and auth styles", () => {
  assert.equal(geminiModelSegment("/v1beta/models/abc%2Fdef:streamGenerateContent"), "abc%2Fdef");
  assert.equal(geminiModelSegment("/v1/chat/completions"), "");
  assert.equal(authStyleOf("/v1/messages"), "anthropic");
  assert.equal(authStyleOf("/v1/messages/count_tokens"), "anthropic");
  assert.equal(authStyleOf("/v1beta/models/x:generateContent"), "gemini");
  assert.equal(authStyleOf("/v1/chat/completions"), "bearer");
  assert.equal(authStyleOf("/v1/responses"), "bearer");
});
