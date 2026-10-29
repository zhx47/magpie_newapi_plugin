import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanLabel,
  formatQuota,
  hashKey,
  hostOf,
  isMaskedKey,
  joinURL,
  maskSecret,
  normalizeBase,
  quotaAsNumber,
  quotaInfo,
  scrubSecrets,
  sortGroups,
} from "../src/util.mjs";

test("normalizeBase strips API roots and trailing slashes", () => {
  assert.equal(normalizeBase("https://example.com/"), "https://example.com");
  assert.equal(normalizeBase("example.com"), "https://example.com");
  assert.equal(normalizeBase("https://example.com/v1"), "https://example.com");
  assert.equal(normalizeBase("https://example.com/api/"), "https://example.com");
  assert.equal(normalizeBase("https://example.com/newapi/v1"), "https://example.com/newapi");
  assert.equal(normalizeBase("ftp://example.com"), "");
  assert.equal(normalizeBase(""), "");
});

test("hostOf and cleanLabel", () => {
  assert.equal(hostOf("https://example.com:8443"), "example.com:8443");
  assert.equal(cleanLabel("", "fallback"), "fallback");
  assert.equal(cleanLabel("hello world", "x"), "hello-world");
  assert.equal(cleanLabel("a/b", "x"), "a-b");
});

test("joinURL never doubles a slash", () => {
  assert.equal(joinURL("https://x/", "/api/status"), "https://x/api/status");
  assert.equal(joinURL("https://x", "api/status"), "https://x/api/status");
});

test("maskSecret and scrubSecrets keep neighbours readable", () => {
  assert.equal(maskSecret("sk-abcdefghijkl"), "sk-a**********ijkl");
  const scrubbed = scrubSecrets("failed with sk-abcdefghijkl for alice", ["sk-abcdefghijkl"]);
  assert.ok(!scrubbed.includes("sk-abcdefghijkl"));
  assert.ok(scrubbed.includes("alice"));
});

test("isMaskedKey", () => {
  assert.equal(isMaskedKey("sk-v***0002"), true);
  assert.equal(isMaskedKey("sk-v•••0002"), true);
  assert.equal(isMaskedKey("sk-vip-key-0002"), false);
  assert.equal(isMaskedKey(""), false);
});

test("sortGroups puts default first", () => {
  assert.deepEqual(sortGroups(["vip", "default", "svip", "vip"]), ["default", "svip", "vip"]);
});

test("quotaInfo and formatQuota follow the site's display", () => {
  const usd = quotaInfo({ quota_per_unit: 500000, display_in_currency: true, quota_display_type: "USD" });
  assert.equal(usd.currency, true);
  assert.equal(usd.symbol, "$");
  assert.equal(formatQuota(500000, usd), "$1.00");
  assert.equal(quotaAsNumber(250000, usd), 0.5);

  const tokens = quotaInfo({ quota_per_unit: 500000, display_in_currency: false, quota_display_type: "TOKENS" });
  assert.equal(tokens.currency, false);
  assert.equal(formatQuota(12345, tokens), "12,345 quota");
  assert.equal(quotaAsNumber(12345, tokens), 12345);

  const cny = quotaInfo({ quota_per_unit: 500000, display_in_currency: true, quota_display_type: "CNY" });
  assert.equal(cny.symbol, "¥");

  const custom = quotaInfo({ quota_per_unit: 500000, display_in_currency: true, quota_display_type: "CUSTOM", custom_currency_symbol: "¤", custom_currency_exchange_rate: 2 });
  assert.equal(custom.symbol, "¤");
  assert.equal(formatQuota(500000, custom), "¤2.00");

  // 人民币用 usd_exchange_rate 换算，不用自定义汇率；美元从不换算。
  const cnyRate = quotaInfo({ quota_per_unit: 500000, display_in_currency: true, quota_display_type: "CNY", usd_exchange_rate: 7.3, custom_currency_exchange_rate: 1 });
  assert.equal(cnyRate.rate, 7.3);
  const usdWithRate = quotaInfo({ quota_per_unit: 500000, display_in_currency: true, quota_display_type: "USD", usd_exchange_rate: 7.3 });
  assert.equal(usdWithRate.rate, 1);
});

test("quotaInfo defaults to 500000 and dollars", () => {
  const info = quotaInfo({});
  assert.equal(info.perUnit, 500000);
  assert.equal(info.currency, true);
  assert.equal(info.symbol, "$");
});

test("hashKey is stable and short", () => {
  assert.equal(hashKey("sk-a"), hashKey("sk-a"));
  assert.notEqual(hashKey("sk-a"), hashKey("sk-b"));
});
