// A pre-publish check: no credential, no real site, no account detail may
// reach the repository.
//
//   npm run scan
//
// Exits non-zero when something looks like a secret or a real site. The test
// fixtures it tolerates are the obvious fakes in test/mock-newapi.mjs
// (`test-access-token-...`, `sk-default-key-...`); everything else has to be
// clean.
//
// It also reads `.env`, when there is one, and looks for those values by
// value: a real host or username written into a doc is caught without this
// file holding either.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".git", ".live", "dist", "coverage"]);
const SKIP_FILES = new Set([".env", ".env.local", "newapi-keys.json", "plugin-auth.json"]);

/** Every text file under root, minus the ones that are not source. */
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

/** A file's lines with its line endings normalised; null when unreadable. */
function linesOf(full) {
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
  return text.split(/\r?\n/);
}

/** Patterns that must never appear in a tracked file. */
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
  // A real host filled into the live-script template (a dotted host only:
  // the docs' `https://site` and `https://your-site` are placeholders).
  { name: "filled NEWAPI_BASE", re: /NEWAPI_BASE=https?:\/\/(?![a-z-]*site(?:\b|>))[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/ },
  { name: "filled NEWAPI_TOKEN", re: /NEWAPI_TOKEN=[A-Za-z0-9_-]{8,}/ },
  // A real site label or user written into a doc: the examples are acme and
  // example.com, everything else in backticks that looks like one is suspect.
  { name: "an account example that is not an example", re: /`(?!(?:acme|example))[a-z0-9-]{2,20} \([A-Za-z0-9._-]+\) — [a-z0-9.-]+`/i },
  {
    name: "email address",
    re: /\b[A-Za-z0-9._%+-]+@(?!ai-sdk\.|example\.(com|invalid)|npmjs\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  },
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

/** The values in .env that must never appear in a tracked file. */
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
        // not a URL: the raw value is already listed
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

// The files that must not be tracked at all.
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
const checked = live.length ? `checked against ${live.length} value(s) from .env` : "no .env to compare";
console.log(`clean · ${files} files scanned · ${checked}`);
