// 一个 New API 模型走哪种 API，以及怎么把它写成 Magpie 的形式。
// New API 在 /api/pricing 里按模型列出端点类型；一个模型可以同时支持好几种，
// 对聚合站来说这是常态。
//
// Magpie 的 `api.npm` 是**按模型**的，不是按供应商，所以一个分组里能同时有
// Chat、Responses、Anthropic、Gemini 四种模型；同一个模型也可以列多次，
// 让用户自己挑走哪种协议。

const CHAT_ENDPOINTS = new Set(["openai", "chat", "openai_chat"]);
const RESPONSES_ENDPOINTS = new Set(["openai_response", "responses", "response", "openai_response_compact"]);
const ANTHROPIC_ENDPOINTS = new Set(["anthropic", "messages", "claude"]);
const GEMINI_ENDPOINTS = new Set(["gemini", "generatecontent", "streamgeneratecontent", "counttokens"]);

const NON_CHAT = new Set([
  "embeddings",
  "embedding",
  "openai_embedding",
  "image_generation",
  "images",
  "openai_video",
  "video",
  "jina_rerank",
  "rerank",
  "openai_alpha_search",
  "deepseek_tools_search",
  "deepseek_tools_fetch",
]);

/** 这个端点类型是不是 Magpie 能提供的对话端点。 */
export function isChatEndpoint(type) {
  const t = String(type ?? "").toLowerCase().trim();
  if (!t) return false;
  if (NON_CHAT.has(t)) return false;
  if (CHAT_ENDPOINTS.has(t) || RESPONSES_ENDPOINTS.has(t) || ANTHROPIC_ENDPOINTS.has(t) || GEMINI_ENDPOINTS.has(t)) return true;
  // 不认识（某个分支自己加的）类型，只要看起来像聊天路由就保留
  if (t.includes("embedding") || t.includes("image") || t.includes("video") || t.includes("rerank")) return false;
  return t.includes("chat") || t.includes("completion") || t.includes("response") || t.includes("message") || t.includes("gemini");
}

/** New API 的端点类型对应 Magpie 的哪种协议；对不上时返回空串。 */
export function protocolOf(type) {
  const t = String(type ?? "").toLowerCase().trim();
  if (GEMINI_ENDPOINTS.has(t)) return "gemini";
  if (ANTHROPIC_ENDPOINTS.has(t)) return "anthropic";
  if (RESPONSES_ENDPOINTS.has(t)) return "responses";
  if (CHAT_ENDPOINTS.has(t)) return "chat";
  return "";
}

function claudeLike(model) {
  return /^(claude|anthropic)[-_. ]?/i.test(String(model ?? ""));
}

function gpt5Like(model) {
  return /^(gpt-5|codex|o[1-9](\b|[-_.]))/i.test(String(model ?? ""));
}

function geminiLike(model) {
  return /^gemini[-_. ]?/i.test(String(model ?? ""));
}

/**
 * 一个模型要列出的协议，最好的在前。没有明确的端点类型列表时，
 * New API 也无从告知，就假定 Chat——每个 New API 站点都为每个聊天模型提供它。
 *
 * `options.preferAnthropic`、`options.preferResponses` 是插件的开关；
 * `options.exposeAllProtocols` 让每种支持的协议各列一条，而不是只列最好的那个。
 */
export function chooseProtocols(endpoints, model, options = {}) {
  const list = Array.isArray(endpoints) ? endpoints : [];
  const protos = [];
  const push = (p) => {
    if (p && !protos.includes(p)) protos.push(p);
  };

  const mapped = list.map(protocolOf);
  const has = (p) => mapped.includes(p);

  const preferAnthropic = options.preferAnthropic !== false;
  const preferResponses = options.preferResponses !== false;

  // Claude 类模型最好走 Messages：cache_control 和 thinking 在那里能保住，
  // Chat 中转一般会把它们丢掉。
  if (preferAnthropic && has("anthropic") && (claudeLike(model) || !has("chat"))) push("anthropic");
  // GPT-5 类模型在原厂和多数中转站上都是 Responses 优先。
  if (preferResponses && has("responses") && (gpt5Like(model) || !has("chat"))) push("responses");
  // Chat 支持最广，行为也最好预测。
  if (has("chat")) push("chat");
  if (has("responses")) push("responses");
  if (has("anthropic")) push("anthropic");
  // Gemini 中转端点只会 generateContent；放在最后，
  // 因为它的回复格式和其他几种差别最大。
  if (has("gemini")) push("gemini");

  if (!protos.length) push("chat"); // 没有端点信息：用最保险的默认

  // 站点同时提供 Gemini 与 chat 时，Gemini 类模型只有用户要求列出所有协议
  // 才把 Gemini 排前面：它的信封在不同 New API 版本间最容易出问题。
  if (!options.exposeAllProtocols) return protos.slice(0, 1);
  if (geminiLike(model) && has("gemini")) {
    const i = protos.indexOf("gemini");
    if (i > 0) {
      protos.splice(i, 1);
      protos.unshift("gemini");
    }
  }
  return protos;
}

/** 第一个协议之后的每个协议，在 catalog id 里带的后缀。 */
export function protocolSuffix(proto) {
  return proto ? `@${proto}` : "";
}

/** 协议的短标签，显示在模型名里。 */
export function labelOf(proto) {
  switch (proto) {
    case "chat":
      return "";
    case "responses":
      return "Responses";
    case "anthropic":
      return "Messages";
    case "gemini":
      return "Gemini";
    default:
      return "";
  }
}

/** api.id：分组与上游模型名，对 URL 路径和 JSON 正文都安全。 */
export function wireId(group, model) {
  return encodeURIComponent(JSON.stringify([String(group), String(model)]));
}

/**
 * 把 api.id 解回 { group, model }。容忍被 percent-encode 两次
 * （有些客户端会把路径段再编码一遍）。
 */
export function parseWireId(id) {
  let s = String(id ?? "");
  if (!s) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") {
        return { group: v[0], model: v[1] };
      }
    } catch {
      // 再解一轮编码试试
    }
    try {
      const next = decodeURIComponent(s);
      if (next === s) return null;
      s = next;
    } catch {
      return null;
    }
  }
  return null;
}

/** 这个 URL 路径是不是 Gemini 的 generateContent 路由，取它的模型段。 */
export function geminiModelSegment(pathname) {
  const m = String(pathname ?? "").match(/\/models\/([^/:]+):(?:streamGenerateContent|generateContent|countTokens)/);
  return m ? m[1] : "";
}

/** 这个 URL 端点需要哪种认证方式。 */
export function authStyleOf(pathname) {
  const p = String(pathname ?? "");
  if (p.includes("/messages")) return "anthropic";
  if (p.includes("/v1beta/") || p.includes(":streamGenerateContent") || p.includes(":generateContent") || p.includes(":countTokens")) {
    return "gemini";
  }
  return "bearer";
}
