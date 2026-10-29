// Sanity-check the module as Magpie's host.js loads it: one plugin function,
// the hooks Magpie calls, and the option keys it accepts.
import plugin from "../index.mjs";

const problems = [];
if (typeof plugin?.server !== "function") problems.push("default export has no server function");

const instance = await plugin.server({
  directory: process.cwd(),
  client: { auth: { set: async () => {} } },
  magpie: { options: () => ({}) },
});
for (const hook of ["config"]) if (typeof instance[hook] !== "function") problems.push(`missing ${hook}`);
for (const hook of ["provider", "methods", "loader", "usage", "checkin"]) {
  if (!instance.auth?.[hook]) problems.push(`missing auth.${hook}`);
}
if (instance.provider?.id !== "newapi") problems.push("provider id is not newapi");
if (typeof instance.provider?.models !== "function") problems.push("missing provider.models");

const OPTION_KEY = /^[a-z0-9_-]{1,40}$/;
for (const o of instance.auth.options ?? []) {
  if (!OPTION_KEY.test(o.key)) problems.push(`option key rejected by host.js: ${o.key}`);
  if (!o.label) problems.push(`option ${o.key} has no label`);
  if (o.description && o.description.length > 300) problems.push(`option ${o.key} description > 300`);
}
if ((instance.auth.options ?? []).length > 16) problems.push("more than 16 options");

for (const m of instance.auth.methods ?? []) {
  if (m.type !== "api" && m.type !== "oauth") problems.push(`method type ${m.type}`);
  if (m.placeholder && m.placeholder.length > 200) problems.push("placeholder > 200");
  // An "api" method that asks its own questions should say keyless, or
  // Magpie shows its own API-key box after them and the same secret is
  // asked for twice.
  if (m.type === "api" && typeof m.ask === "function" && m.keyless !== true) {
    problems.push("an ask-based api method must be keyless, or the key is asked twice");
  }
  if (typeof m.ask === "function" && m.prompts) problems.push("a method with ask() should not also list prompts");
  for (const p of m.prompts ?? []) {
    checkPrompt(p, "prompt");
  }
}

// Every question an ask() method hands out has to be one Magpie can draw.
function checkPrompt(p, what) {
  if (!p) return;
  if (!p.key) problems.push(`${what} without a key`);
  if (!p.message) problems.push(`${what} ${p.key} has no message`);
  if (!["text", "password", "select"].includes(p.type)) problems.push(`${what} ${p.key} has type ${p.type}`);
  if (p.type === "select" && !(p.options?.length)) problems.push(`${what} ${p.key} is a select without options`);
  if (p.type !== "select" && p.options) problems.push(`${what} ${p.key} has options but is ${p.type}`);
  if (p.placeholder && p.placeholder.length > 200) problems.push(`${what} ${p.key} placeholder > 200`);
}

// Walk the ask() method the way Magpie does, with the first answers filled
// in, and check each question it hands back.
const method = (instance.auth.methods ?? []).find((m) => typeof m.ask === "function");
if (method) {
  const inputs = { baseURL: "https://newapi.example.com", accessToken: "not-a-real-token" };
  for (let i = 0; i < 12; i++) {
    let q;
    try {
      q = await method.ask({ ...inputs });
    } catch (e) {
      problems.push(`ask() threw: ${e?.message ?? e}`);
      break;
    }
    if (!q) break;
    checkPrompt(q, "ask()");
    const answer = q.type === "select" ? q.options?.[0]?.value ?? "" : "";
    inputs[q.key] = answer;
  }
}

const cfg = {};
await instance.config(cfg);
if (cfg.provider?.newapi?.name !== "New API") problems.push("config did not declare the provider");
if ("models" in (cfg.provider?.newapi ?? {})) problems.push("config pre-declares models, which would fight provider.models");

if (problems.length) {
  console.error("problems:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("plugin shape ok:", instance.provider.id, "| options:", instance.auth.options.map((o) => o.key).join(", "));
