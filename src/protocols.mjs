// Which API a New API model is spoken on, and how that is written for
// Magpie. New API lists endpoint types per model in /api/pricing; a model
// may support several at once, which is normal for an aggregator.
//
// Magpie's `api.npm` is per model, not per provider, so one group can hold
// Chat, Responses, Anthropic and Gemini models together, and one model can
// be listed more than once when the user wants to choose the wire API.

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

/** Whether an endpoint type is a conversation endpoint Magpie can serve. */
export function isChatEndpoint(type) {
  const t = String(type ?? "").toLowerCase().trim();
  if (!t) return false;
  if (NON_CHAT.has(t)) return false;
  if (CHAT_ENDPOINTS.has(t) || RESPONSES_ENDPOINTS.has(t) || ANTHROPIC_ENDPOINTS.has(t) || GEMINI_ENDPOINTS.has(t)) return true;
  // unknown types (a fork's own) are kept when they look like a chat route
  if (t.includes("embedding") || t.includes("image") || t.includes("video") || t.includes("rerank")) return false;
  return t.includes("chat") || t.includes("completion") || t.includes("response") || t.includes("message") || t.includes("gemini");
}

/** The Magpie protocol a New API endpoint type maps to, "" when none. */
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
 * The protocols to list for a model, best first. Without an explicit list
 * of endpoint types New API can't tell us, so Chat is assumed, which every
 * New API site serves for every chat model.
 *
 * `options.preferAnthropic` and `options.preferResponses` are the plugin's
 * switches; `options.exposeAllProtocols` lists every supported protocol
 * instead of the best one.
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

  // A Claude model is best spoken to on Messages: cache_control and
  // thinking survive there, which Chat relays usually drop.
  if (preferAnthropic && has("anthropic") && (claudeLike(model) || !has("chat"))) push("anthropic");
  // GPT-5 class models are Responses-first at their maker and at most relays.
  if (preferResponses && has("responses") && (gpt5Like(model) || !has("chat"))) push("responses");
  // Chat is the most widely served and the most predictable.
  if (has("chat")) push("chat");
  if (has("responses")) push("responses");
  if (has("anthropic")) push("anthropic");
  // A Gemini relay endpoint only speaks generateContent; take it last, since
  // its replies are the most different from the rest.
  if (has("gemini")) push("gemini");

  if (!protos.length) push("chat"); // no endpoint information: the safe default

  // Gemini models on a site that offers both Gemini and chat: prefer Gemini
  // only when the user asked for every protocol, since its envelope is the
  // most fragile across New API versions.
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

/** The suffix every protocol after the first gets in its catalog id. */
export function protocolSuffix(proto) {
  return proto ? `@${proto}` : "";
}

/** The protocol's short label, shown in the model name. */
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

/** api.id: the group and the wire model, safe for a URL path and a JSON body. */
export function wireId(group, model) {
  return encodeURIComponent(JSON.stringify([String(group), String(model)]));
}

/**
 * Decode an api.id back to { group, model }. Tolerates being
 * percent-encoded twice (some clients re-encode a path segment).
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
      // try one more round of decoding
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

/** Whether a URL path is a Gemini generateContent route, and its model segment. */
export function geminiModelSegment(pathname) {
  const m = String(pathname ?? "").match(/\/models\/([^/:]+):(?:streamGenerateContent|generateContent|countTokens)/);
  return m ? m[1] : "";
}

/** The auth style a URL's endpoint needs. */
export function authStyleOf(pathname) {
  const p = String(pathname ?? "");
  if (p.includes("/messages")) return "anthropic";
  if (p.includes("/v1beta/") || p.includes(":streamGenerateContent") || p.includes(":generateContent") || p.includes(":countTokens")) {
    return "gemini";
  }
  return "bearer";
}
