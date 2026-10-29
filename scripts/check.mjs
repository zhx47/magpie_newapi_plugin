// 按 Magpie 的 host.js 加载方式检查一遍模块：只有一个插件函数、
// Magpie 会调的那些钩子、以及它接受的选项键。
import plugin from "../index.mjs";

const problems = [];
if (typeof plugin?.server !== "function") problems.push("default 导出里没有 server 函数");

const instance = await plugin.server({
  directory: process.cwd(),
  client: { auth: { set: async () => {} } },
  magpie: { options: () => ({}) },
});
for (const hook of ["config"]) if (typeof instance[hook] !== "function") problems.push(`缺少 ${hook}`);
for (const hook of ["provider", "methods", "loader", "usage", "checkin"]) {
  if (!instance.auth?.[hook]) problems.push(`缺少 auth.${hook}`);
}
if (instance.provider?.id !== "newapi") problems.push("provider id 不是 newapi");
if (typeof instance.provider?.models !== "function") problems.push("缺少 provider.models");

const OPTION_KEY = /^[a-z0-9_-]{1,40}$/;
for (const o of instance.auth.options ?? []) {
  if (!OPTION_KEY.test(o.key)) problems.push(`host.js 会拒绝这个选项键：${o.key}`);
  if (!o.label) problems.push(`选项 ${o.key} 没有 label`);
  if (o.description && o.description.length > 300) problems.push(`选项 ${o.key} 的 description 超过 300 字`);
}
if ((instance.auth.options ?? []).length > 16) problems.push("选项超过 16 个");

for (const m of instance.auth.methods ?? []) {
  if (m.type !== "api" && m.type !== "oauth") problems.push(`方式类型 ${m.type}`);
  if (m.placeholder && m.placeholder.length > 200) problems.push("placeholder 超过 200 字");
  // 自己提问的 "api" 方式必须声明 keyless，否则 Magpie 会在问题之后再弹
  // 自己的 API key 框，同一个密钥被问两遍。
  if (m.type === "api" && typeof m.ask === "function" && m.keyless !== true) {
    problems.push("用 ask() 的 api 方式必须 keyless，否则 key 会被问两遍");
  }
  if (typeof m.ask === "function" && m.prompts) problems.push("有 ask() 的方式不应再列 prompts");
  for (const p of m.prompts ?? []) {
    checkPrompt(p, "prompt");
  }
}

// ask() 方式给出的每个问题都必须是 Magpie 画得出来的。
function checkPrompt(p, what) {
  if (!p) return;
  if (!p.key) problems.push(`${what} 没有 key`);
  if (!p.message) problems.push(`${what} ${p.key} 没有 message`);
  if (!["text", "password", "select"].includes(p.type)) problems.push(`${what} ${p.key} 的类型是 ${p.type}`);
  if (p.type === "select" && !(p.options?.length)) problems.push(`${what} ${p.key} 是 select 却没有 options`);
  if (p.type !== "select" && p.options) problems.push(`${what} ${p.key} 有 options 但类型是 ${p.type}`);
  if (p.placeholder && p.placeholder.length > 200) problems.push(`${what} ${p.key} 的 placeholder 超过 200 字`);
}

// 像 Magpie 那样走一遍 ask() 方式：把前几个答案填上，
// 逐个检查它交回来的问题。
const method = (instance.auth.methods ?? []).find((m) => typeof m.ask === "function");
if (method) {
  const inputs = { baseURL: "https://newapi.example.com", accessToken: "not-a-real-token" };
  for (let i = 0; i < 12; i++) {
    let q;
    try {
      q = await method.ask({ ...inputs });
    } catch (e) {
      problems.push(`ask() 抛错：${e?.message ?? e}`);
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
console.log("插件形状 ok：", instance.provider.id, "| 选项：", instance.auth.options.map((o) => o.key).join(", "));
