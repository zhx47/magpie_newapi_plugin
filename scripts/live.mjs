// End-to-end against a real New API site: sign in with the plugin's own code
// path, list models, read the balance, read the check-in state, and send one
// small request through the loader's fetch.
//
// The check-in is only read, never pressed: this script is for looking at a
// site, and pressing a real account's check-in is the user's call. Set
// NEWAPI_PRESS_CHECKIN=1 to press it anyway.
//
// Usage:
//   cp .env.example .env   # then fill it in; .env is git-ignored
//   npm run live
//
// or with the variables set in the environment directly:
//   NEWAPI_BASE=https://site NEWAPI_TOKEN=... npm run live
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NewAPI } from "../index.mjs";
import { signIn } from "../src/signin.mjs";

/** Read .env beside the package, without a dependency. Never overrides the real environment. */
function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.resolve(here, "..", ".env"));

const base = process.env.NEWAPI_BASE;
const token = process.env.NEWAPI_TOKEN;
const userId = process.env.NEWAPI_UID ?? "";

if (!base || !token) {
  console.error("set NEWAPI_BASE and NEWAPI_TOKEN (in .env, or in the environment)");
  process.exit(2);
}

const dir = process.env.NEWAPI_DIR ?? "./.live";
const signed = await signIn({ baseURL: base, accessToken: token, userId, checkin: "auto" }, { directory: dir });
if (signed.type !== "success") {
  console.error("sign-in failed:", signed.error);
  process.exit(1);
}

const md = signed.metadata;
const mask = (s) => (typeof s === "string" && s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
console.log("site        :", md.baseURL, "|", md.status.systemName, md.status.version);
console.log("account     :", md.accountId);
console.log("groups      :", Object.keys(md.groups).join(", "));
for (const [group, keys] of Object.entries(md.groupKeys)) {
  console.log(`keys ${group.padEnd(8)}: ${keys.length} ·`, keys.map(mask).join(", "));
}
console.log("missing     :", md.pendingGroups.length ? md.pendingGroups.join(", ") : "none");

const instance = await NewAPI({
  directory: dir,
  client: { auth: { set: async () => {} } },
  magpie: { options: () => ({}) },
});
const auth = { type: "api", key: signed.key, metadata: md };

const models = await instance.provider.models({ models: {} }, { auth });
const ids = Object.keys(models);
console.log("models      :", ids.length);
for (const id of ids.slice(0, 12)) {
  const m = models[id];
  console.log(`  ${id.padEnd(46)} ${m.api.npm.replace("@ai-sdk/", "").padEnd(20)} ${m.api.url}`);
}

const usage = await instance.auth.usage(async () => auth);
console.log("usage       :", usage.error ?? "");
for (const w of usage.windows ?? []) {
  console.log(`  ${w.name.padEnd(12)} ${w.balance !== undefined ? `balance=${w.balance} ${w.unit ?? ""}` : ""} ${w.display ?? ""}`);
}

// Read the check-in state; press only when asked.
if (process.env.NEWAPI_PRESS_CHECKIN === "1") {
  const state = await instance.auth.checkin(async () => auth);
  console.log("checkin     :", state.outcome, "|", state.message);
} else {
  const { getCheckinStatus } = await import("../src/api.mjs");
  const s = await getCheckinStatus(md.baseURL, signed.key, md.userId);
  console.log(
    "checkin     :",
    s.enabled ? (s.checkedInToday ? "done" : "ready") : "not enabled",
    "|",
    `${s.path} · site turnstile=${md.status.turnstile} · ${s.records[0]?.checkin_date ?? "no record"}`,
  );
}

// A real request through the loader's fetch, using the smallest model.
const loader = instance.auth.loader(async () => auth);
const pick = ids.find((id) => id.endsWith("/deepseek-v4.1-flash")) ?? ids[0];
const chosen = models[pick];
const res = await loader.fetch(chosen.api.url + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer magpie-newapi" },
  body: JSON.stringify({ model: chosen.api.id, messages: [{ role: "user", content: "say hi" }], max_tokens: 8, stream: false }),
});
console.log("relay       :", pick, "->", res.status, (await res.text()).slice(0, 200));
