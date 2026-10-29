// A pre-publish check: no credential, no real site, no account detail may
// reach the repository.
//
//   npm run scan
//
// Exits non-zero when something looks like a secret or a real site. The test
// fixtures it tolerates are the obvious fakes in test/mock-newapi.mjs
// (`test-access-token-...`, `sk-default-key-...`); everything else has to be
// clean.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".git", ".live", "dist", "coverage"]);
const SKIP_FILES = new Set([".env", ".env.local", "newapi-keys.json", "plugin-auth.json"]);

/** Patterns that must never appear in a tracked file. */
const RULES = [
  // Credentials with a recognizable shape.
  { name: "New API access token", re: /\bnap_[A-Za-z0-9_-]{16,}/g },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{24,}/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // A token assigned a literal value (env files are skipped; examples are not).
  {
    name: "literal credential assignment",
    re: /\b(access[_-]?token|api[_-]?key|secret|password)\s*[:=]\s*["'][A-Za-z0-9_\-.]{20,}["']/gi,
  },
  // A real host filled into the live-script template (a dotted host only:
  // the docs' `https://site` and `https://your-site` are placeholders).
  {
    name: "filled NEWAPI_BASE",
    re: /NEWAPI_BASE=https?:\/\/(?![a-z-]*site(?:\b|>))[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  },
  { name: "filled NEWAPI_TOKEN", re: /NEWAPI_TOKEN=[A-Za-z0-9_-]{8,}/g },
  // Emails and phone numbers, outside the fixtures.
  { name: "email address", re: /\b[A-Za-z0-9._%+-]+@(?!ai-sdk\.|example\.(com|invalid)|npmjs\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** Lines that are known-good and would otherwise match. */
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

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (entry.name.endsWith(".png") || entry.name.endsWith(".jpg") || entry.name.endsWith(".tgz")) continue;
      yield { full, rel };
    }
  }
}

const findings = [];
for (const { full, rel } of walk(root)) {
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (ALLOW.some((re) => re.test(line))) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      const hit = rule.re.exec(line);
      if (!hit) continue;
      findings.push({ file: rel, line: i + 1, rule: rule.name, sample: hit[0].slice(0, 60) });
    }
  });
}

// The two files that must not be tracked at all.
for (const name of [".env", ".env.local"]) {
  if (fs.existsSync(path.join(root, name))) {
    const ignored = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).some((l) => l.trim() === name);
    if (!ignored) findings.push({ file: name, line: 0, rule: "not git-ignored", sample: name });
  }
}

if (findings.length) {
  console.error(`found ${findings.length} thing(s) to remove before publishing:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.sample}`);
  console.error("\nremove them, or add a narrow allowance in scripts/scan-secrets.mjs if it is a fixture");
  process.exit(1);
}

const scanned = [...walk(root)].length;
console.log(`clean · ${scanned} files scanned`);
