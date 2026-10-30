// runanytime.hxi.me：签到前要先解一道工作量证明的站点。
//
// 站长在 New API 的签到接口前加了一道题，流程是三步：
//
//   1. GET /api/user/pow/challenge?action=checkin
//      → { challenge_id, prefix, difficulty, expires_at }
//   2. 找一个 8 位十六进制 nonce，使 SHA-256(prefix + nonce) 的开头有
//      `difficulty` 个 0 比特
//   3. POST /api/user/checkin?pow_challenge=<id>&pow_nonce=<nonce>
//
// 站点把 nonce 当作**字符串**拼在 prefix 后面再哈希，所以这里也必须哈希
// ASCII 字符，而不是 4 字节整数。8 位正好是 32 位计数器的十六进制写法。
//
// 这不是绕过任何东西：站点要求算，插件就算。算不出来就如实报告。
//
// 这个文件只服务名单里的主机（sites.mjs 按它分派签到）：题目接口只有它有，
// 别的站点每次都问一遍就是白花一个请求。

import { createHash } from "node:crypto";

/** nonce 的位数：4 字节计数器的十六进制写法。 */
export const NONCE_DIGITS = 8;

/** 站点名（主机名）：签到要带 PoW。 */
export const HOSTS = ["runanytime.hxi.me"];

/**
 * 这个站点的签到要不要先解 PoW。
 *
 * 只认名单：多问一次题目就是一个请求。`hosts` 只给测试用，
 * 让本机 mock 冒充名单里的站点（与 sites.mjs 的 `specialHosts` 同一个做法）。
 */
export function isRunAnyTimeSite(base, hosts = HOSTS) {
  try {
    return hosts.includes(new URL(String(base)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// 一次求解最多花多久。签到是后台任务，没有人在等，但也不能真的卡住：
// 题目的难度通常只有十几位，一百万次哈希都不到一秒。
const MAX_SOLVE_MS = 60_000;
// 题目快过期时仍给一个最小预算，否则刚到手的题会因为几毫秒的误差白扔。
const MIN_SOLVE_MS = 3_000;
// 留出提交的时间：解完题到发请求之间还有一次往返。
const EXPIRY_MARGIN_MS = 3_000;

/** 一个字节前 n 位的掩码，用于校验 difficulty 不是 8 的整数倍的部分。 */
const LEADING_BIT_MASKS = [0x00, 0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe, 0xff];

/** 摘要的前 `difficulty` 个比特是否全为 0。 */
export function digestMatches(digest, difficulty) {
  if (difficulty <= 0) return true;
  const full = Math.floor(difficulty / 8);
  if (full > digest.length) return false;
  for (let i = 0; i < full; i++) {
    if (digest[i] !== 0) return false;
  }
  const rest = difficulty % 8;
  if (rest === 0) return true;
  if (full >= digest.length) return false;
  return (digest[full] & LEADING_BIT_MASKS[rest]) === 0;
}

/**
 * 站点给的题目。字段不对就当没有题目——拿半个题目去算，
 * 结果只会是一个被拒的请求。
 */
export function parseChallenge(payload) {
  const data = payload?.data;
  if (!data || typeof data !== "object") return null;
  const challengeId = String(data.challenge_id ?? "").trim();
  const prefix = typeof data.prefix === "string" ? data.prefix : "";
  const difficulty = Number(data.difficulty);
  if (!challengeId || !prefix) return null;
  if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 256) return null;
  return {
    challengeId,
    prefix,
    difficulty: Math.floor(difficulty),
    // 有的站点给毫秒，有的给秒；大得离谱的就是毫秒。
    expiresAt: normalizeExpiry(Number(data.expires_at) || 0),
  };
}

function normalizeExpiry(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

/** 求解失败，带一个机器可读的原因，由调用方翻译成用户能看懂的话。 */
export class PowError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "PowError";
    this.reason = reason;
  }
}

/**
 * 找一个满足难度的 nonce，返回它的 8 位十六进制写法。
 *
 * `now` 与 `budgetMs` 可以覆盖，测试用它把「算不完」变成几毫秒。
 */
export function solveChallenge(challenge, { now = Date.now(), budgetMs = MAX_SOLVE_MS } = {}) {
  let budget = budgetMs;
  if (challenge.expiresAt > 0) {
    const left = challenge.expiresAt * 1000 - now - EXPIRY_MARGIN_MS;
    // 题目快过期时给一个下限，别因为几毫秒的误差白扔一道刚拿到的题。
    if (left < budget) budget = Math.max(left, MIN_SOLVE_MS);
  }

  const startedAt = now;
  const prefix = Buffer.from(challenge.prefix, "utf8");
  // nonce 直接写在同一个缓冲区里，每轮只改尾部 8 个字节。
  const work = Buffer.alloc(prefix.length + NONCE_DIGITS);
  prefix.copy(work);
  const at = prefix.length;

  for (let counter = 0; counter <= 0xffffffff; counter++) {
    // 每 1024 次看一眼表：单次哈希是微秒级，这个频率已经够紧了。
    if ((counter & 0x3ff) === 0 && Date.now() - startedAt > budget) {
      throw new PowError("timeout", `the proof of work did not finish in ${Math.round(budget / 1000)}s`);
    }
    const nonce = counter.toString(16).padStart(NONCE_DIGITS, "0");
    work.write(nonce, at, NONCE_DIGITS, "ascii");
    if (digestMatches(createHash("sha256").update(work).digest(), challenge.difficulty)) {
      return nonce;
    }
  }
  throw new PowError("exhausted", "no nonce satisfied the difficulty");
}
