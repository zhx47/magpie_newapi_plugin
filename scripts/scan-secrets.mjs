// 发布前检查：任何凭据、真实站点、账号细节都不能进仓库。
//
//   npm run scan
//
// 有像密钥或真实站点的东西就以非零退出。它容忍的测试夹具只有
// test/mock-newapi.mjs 里那些明显的假值（`test-access-token-...`、
// `sk-default-key-...`），其余一律必须干净。
//
// 它还会读 `.env`（如果存在），按**值**去全文搜索：文档里写进了真实域名或
// 用户名就会被抓到，而本文件里不需要出现这些值。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".git", ".live", "dist", "coverage"]);
const SKIP_FILES = new Set([".env", ".env.local", "newapi-keys.json", "plugin-auth.json"]);

/** 根目录下的所有文本文件，排除不是源码的那些。 */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (/\.(png|jpe?g|gif|webp|ico|tgz|zip)$/i.test(entry.name)) continue;
      yield { full, rel };
    }
  }
}

/** 文件按行切开、统一换行；读不了就返回 null。 */
function linesOf(full) {
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
  return text.split(/\r?\n/);
}

/** 绝不能出现在被追踪文件里的模式。 */
const RULES = [
  { name: "New API access token", re: /\bnap_[A-Za-z0-9_-]{16,}/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{24,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "literal credential assignment",
    re: /\b(access[_-]?token|api[_-]?key|secret|password)\s*[:=]\s*["'][A-Za-z0-9_\-.]{20,}["']/i,
  },
  // live 脚本模板里被填了真实主机（只认带点的主机名：
  // 文档里的 `https://site` 和 `https://your-site` 是占位）。
  { name: "filled NEWAPI_BASE", re: /NEWAPI_BASE=https?:\/\/(?![a-z-]*site(?:\b|>))[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/ },
  { name: "filled NEWAPI_TOKEN", re: /NEWAPI_TOKEN=[A-Za-z0-9_-]{8,}/ },
  // 文档里写了真实的站点标识或用户名：示例只允许 acme 和 example.com，
  // 反引号里其他形似账号的写法都算可疑。
  { name: "an account example that is not an example", re: /`(?!(?:acme|example))[a-z0-9-]{2,20} \([A-Za-z0-9._-]+\) — [a-z0-9.-]+`/i },
  {
    name: "email address",
    re: /\b[A-Za-z0-9._%+-]+@(?!ai-sdk\.|example\.(com|invalid)|npmjs\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  },
];

/** 已知没问题、但本来会被匹配到的行。 */
const ALLOW = [
  /test-access-token-/,
  /sk-default-key-/,
  /sk-vip-key-/,
  /sk-svip-key-/,
  /sk-pasted-/,
  /sk-created-/,
  /sk-bad-key-/,
  /sk-secret-vip-/,
  /sk-not-a-token/,
  /sk-abcdefghijkl/,
  /your-site/,
  /newapi\.example\.com/,
  /example\.invalid/,
  /alice/,
  /placeholder/,
];

/** .env 里那些绝不能出现在被追踪文件中的值。 */
function readLiveSecrets() {
  const out = [];
  const lines = linesOf(path.join(root, ".env"));
  if (!lines) return out;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!value) continue;
    if (key === "NEWAPI_TOKEN" || key === "NEWAPI_UID") out.push(value);
    if (key === "NEWAPI_BASE") {
      out.push(value);
      try {
        out.push(new URL(value).host);
      } catch {
        // 不是 URL：原值已经列进去了
      }
    }
  }
  return out;
}

const findings = [];
const live = readLiveSecrets();

for (const { full, rel } of walk(root)) {
  const lines = linesOf(full);
  if (!lines) continue;
  const self = rel === "scripts/scan-secrets.mjs";
  lines.forEach((line, i) => {
    if (!ALLOW.some((re) => re.test(line))) {
      for (const rule of RULES) {
        const hit = rule.re.exec(line);
        if (hit) findings.push({ file: rel, line: i + 1, rule: rule.name, sample: hit[0].slice(0, 60) });
      }
    }
    if (self) return; // this file names the shapes, not the values
    for (const secret of live) {
      if (secret.length >= 4 && line.includes(secret)) {
        findings.push({ file: rel, line: i + 1, rule: "the real site's own value", sample: `${secret.slice(0, 4)}…` });
      }
    }
  });
}

// 完全不该被追踪的文件。
for (const name of [".env", ".env.local"]) {
  if (!fs.existsSync(path.join(root, name))) continue;
  const ignored = linesOf(path.join(root, ".gitignore"))?.some((l) => l.trim() === name);
  if (!ignored) findings.push({ file: name, line: 0, rule: "not git-ignored", sample: name });
}

if (findings.length) {
  console.error(`found ${findings.length} thing(s) to remove before publishing:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.sample}`);
  console.error("\nremove them, or add a narrow allowance in scripts/scan-secrets.mjs if it is a fixture");
  process.exit(1);
}

const files = [...walk(root)].length;
const checked = live.length ? `并对照 .env 里的 ${live.length} 个值` : "没有 .env 可比对";
console.log(`干净 · 扫描 ${files} 个文件 · ${checked}`);
