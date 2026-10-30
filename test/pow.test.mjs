import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { NONCE_DIGITS, digestMatches, isPowSite, parsePowChallenge, solvePow, PowError } from "../src/pow.mjs";

test("digestMatches 数的是开头的 0 比特", () => {
  const zeros = (n) => Buffer.from([...Array(32)].map((_, i) => (i < n ? 0 : 0xff)));
  assert.equal(digestMatches(zeros(0), 0), true, "难度 0 什么都行");
  assert.equal(digestMatches(Buffer.from([0x7f]), 1), true);
  assert.equal(digestMatches(Buffer.from([0x80]), 1), false);
  assert.equal(digestMatches(Buffer.from([0x00, 0x00, 0x10]), 16), true);
  assert.equal(digestMatches(Buffer.from([0x00, 0x01]), 16), false);
  // 不满一个字节的部分：0x1f 的前 3 位是 0
  assert.equal(digestMatches(Buffer.from([0x00, 0x1f]), 11), true);
  assert.equal(digestMatches(Buffer.from([0x00, 0x20]), 11), false);
  // 超过 256 位是不可能的
  assert.equal(digestMatches(Buffer.alloc(32), 300), false);
});

test("handle 参考解：octopus 记下的那个 nonce 仍然满足难度 14", () => {
  // 这是站点真的接受过的解，拿它做回归：算法一改这里就会挂。
  const digest = createHash("sha256").update("checkin:1792565712:6573:57c20d569dc58d08:00004851").digest();
  assert.equal(digestMatches(digest, 14), true);
});

test("solvePow 找得到满足难度的 nonce", () => {
  const challenge = { challengeId: "c1", prefix: "checkin:1792565712:6573:57c20d569dc58d08:", difficulty: 12, expiresAt: 0 };
  const nonce = solvePow(challenge);
  assert.equal(nonce.length, NONCE_DIGITS);
  assert.match(nonce, /^[0-9a-f]{8}$/, "nonce 是十六进制");
  const digest = createHash("sha256").update(challenge.prefix + nonce).digest();
  assert.equal(digestMatches(digest, challenge.difficulty), true);
});

test("solvePow 难度 0 立刻返回", () => {
  const nonce = solvePow({ challengeId: "c", prefix: "p:", difficulty: 0, expiresAt: 0 });
  assert.equal(nonce, "00000000");
});

test("solvePow 算不完就报 timeout，而不是一直转", () => {
  // 256 位不可能在预算内解出来
  assert.throws(
    () => solvePow({ challengeId: "c", prefix: "p:", difficulty: 256, expiresAt: 0 }, { budgetMs: 30 }),
    (e) => e instanceof PowError && e.reason === "timeout",
  );
});

test("parsePowChallenge 只收完整的题目", () => {
  const ok = parsePowChallenge({ success: true, data: { challenge_id: "abc", prefix: "checkin:1:", difficulty: 14, expires_at: 1792565732 } });
  assert.deepEqual(ok, { challengeId: "abc", prefix: "checkin:1:", difficulty: 14, expiresAt: 1792565732 });
  // 毫秒要给折成秒
  assert.equal(parsePowChallenge({ data: { challenge_id: "a", prefix: "p:", difficulty: 1, expires_at: 1792565732000 } }).expiresAt, 1792565732);
  // 缺 id 或缺 prefix 就不是题目
  assert.equal(parsePowChallenge({ data: { challenge_id: "", prefix: "p:", difficulty: 1 } }), null);
  assert.equal(parsePowChallenge({ data: { challenge_id: "a", prefix: "", difficulty: 1 } }), null);
  assert.equal(parsePowChallenge({ data: { challenge_id: "a", prefix: "p:", difficulty: -1 } }), null);
  assert.equal(parsePowChallenge({ data: { challenge_id: "a", prefix: "p:", difficulty: 999 } }), null);
  assert.equal(parsePowChallenge({}), null);
  assert.equal(parsePowChallenge(null), null);
});

test("isPowSite 只认名单里的站点", () => {
  assert.equal(isPowSite("https://runanytime.hxi.me"), true);
  assert.equal(isPowSite("https://RUNANYTIME.HXI.ME/"), true);
  assert.equal(isPowSite("https://runanytime.hxi.me:8443"), true);
  assert.equal(isPowSite("https://other.example.com"), false);
  assert.equal(isPowSite("not a url"), false);
  assert.equal(isPowSite(""), false);
});
