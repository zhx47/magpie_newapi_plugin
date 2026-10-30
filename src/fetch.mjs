// 插件的 fetch：把 Magpie 网关的一个请求发到 New API 站点。
//
// Magpie 已经把请求翻译成模型该用的协议了，剩下的是 New API 自己的规矩：
//   - 用哪个分组的 key 签名（分组在 `api.id` 里，由 models.mjs 写进去，
//     表现为请求体里的 model，或 Gemini 的路径段）；
//   - 站点期望的裸模型名；
//   - 那个端点读哪个认证头。
//
// 访问令牌是给管理接口用的，绝不能出现在推理请求上，
// 所以先删掉 Magpie 用账号 key 设过的每一个头。

import { ChallengeError, isAuthError } from "./api.mjs";
import { authStyleOf, geminiModelSegment, parseWireId } from "./protocols.mjs";
import { groupsOf, keysToTry } from "./state.mjs";
import { USER_AGENT } from "./util.mjs";
import { t } from "./i18n.mjs";

/** 读出请求指向的分组与模型；两者都没有时返回 null。 */
export function readTarget(pathname, bodyText) {
  const segment = geminiModelSegment(pathname);
  if (segment) {
    const parsed = parseWireId(segment);
    if (parsed) return parsed;
    // 不是我们的模型 ID：这个路径段本身就是裸模型名。
    try {
      return { group: "", model: decodeURIComponent(segment) };
    } catch {
      return { group: "", model: segment };
    }
  }
  if (typeof bodyText === "string" && bodyText.trim()) {
    try {
      const json = JSON.parse(bodyText);
      const model = typeof json?.model === "string" ? json.model : "";
      if (model) {
        const parsed = parseWireId(model);
        return parsed ?? { group: "", model };
      }
    } catch {
      // 不是 JSON：没有可读的
    }
  }
  return null;
}

/**
 * 把请求路径固定到**当前账号自己的站点**上。
 *
 * Magpie 用模型列表拼 URL，而那张列表是按模型 ID 跨账号合并的
 * （`host.js`：`models[k] ??= m`）。同一站点、同名的两个账号合并成一条，
 * 它的 `api.url` 和 `api.id` 来自先列出它的那个账号。
 * 如果拿第二个账号的 key 签名、却发到第一个账号的地址上，
 * 就是把错误的账号花在错误的主机上。所以这里让账号自己的 base
 * 和自己的默认分组说了算。
 *
 * 已经在本账号站点上的 URL 原样保留 Magpie 拼出的路径
 * （它的 `/v1/chat/completions`、它的
 * `/v1beta/models/<id>:streamGenerateContent`）；
 * 指向别的站点的，用本账号的 base 加上路径里的协议部分重建。
 */
export function ownURL(href, md) {
  const base = String(md?.baseURL ?? "").replace(/\/+$/, "");
  let url;
  try {
    url = new URL(href);
  } catch {
    return { href, sameSite: true };
  }
  const mine = base ? new URL(base) : null;
  const sameSite = !!mine && url.origin === mine.origin && url.pathname.startsWith(`${mine.pathname.replace(/\/+$/, "")}/`);
  if (sameSite || !base) return { href, sameSite: true };

  // 路径里属于 New API 接口的那一段，而不是对方站点代理碰巧带的前缀：
  // 从 `/v1beta/` 或 `/v1/` 开始往后。
  const at = url.pathname.search(/\/(v1beta|v1)\//);
  const path = at >= 0 ? url.pathname.slice(at) : url.pathname;
  const qs = url.search || "";
  return { href: `${base}${path}${qs}`, sameSite: false };
}

/** 把请求体里的 model 换成裸模型名，其他字段原样保留。 */
export function rewriteBodyModel(bodyText, model) {
  if (!model || typeof bodyText !== "string") return bodyText;
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!json || typeof json !== "object" || !("model" in json)) return bodyText;
  if (json.model === model) return bodyText;
  json.model = model;
  return JSON.stringify(json);
}

/** 把 Gemini 路径里的模型段换成裸模型名。 */
export function rewriteGeminiPath(href, model) {
  if (!model) return href;
  const segment = geminiModelSegment(new URL(href).pathname);
  if (!segment) return href;
  return href.replace(segment, encodeURIComponent(model));
}

/**
 * 插件的 loader 交给 Magpie 的 fetch。`getAuth` 读账号当前的登录信息，
 * 所以用户登录之后才贴上的 key 不需要重启就会生效。
 */
export function makeFetch(getAuth, { fetchImpl = globalThis.fetch } = {}) {
  return async function newapiFetch(input, init = {}) {
    const auth = await getAuth();
    const md = auth?.metadata ?? {};
    const groups = groupsOf(md);

    const href = typeof input === "string" ? input : input?.url ?? String(input);
    let url;
    try {
      url = new URL(href);
    } catch {
      return jsonError(400, t("New API: the request URL is not valid"));
    }

    const bodyText = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    const target = readTarget(url.pathname, bodyText);

    // Magpie 拼这个 URL 用的模型列表是按模型 ID 跨账号合并的，
    // 所以其中的 `api.url` 和 `api.id` 里的分组可能来自另一个账号。
    // 发到本账号自己的站点，并且只用本账号真的持有的分组签名。
    const own = ownURL(href, md);
    const ownPath = new URL(own.href).pathname;
    const fallbackGroup = defaultGroup(md, groups);
    const named = target?.group ?? "";
    // 本账号认识、但没有 key 的分组，要等用户补：拿别的分组的 key 去应答，
    // 花的就是错的分组。本账号从没见过的分组，是别的账号的模型带来的，
    // 那个请求在这里的意思就是本账号的默认分组。
    const known = Object.prototype.hasOwnProperty.call(md.groups ?? {}, named);
    const group = !named || groups[named]?.key ? named || fallbackGroup : known ? named : fallbackGroup;
    const model = target?.model ?? "";

    const keys = keysToTry(groups, group);
    if (!keys.length) {
      return jsonError(503, t("New API: no usable key for group \"{group}\". Sign in again to add or replace it.", { group }));
    }

    const style = authStyleOf(ownPath);
    let lastResponse = null;
    let lastError = null;

    for (const key of keys) {
      const headers = new Headers(init.headers ?? {});
      // Magpie 用账号的 key（访问令牌）或占位符设过这些头，
      // 它们都不该出现在推理请求上。
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.delete("x-goog-api-key");
      headers.delete("content-length");
      headers.delete("content-encoding");
      // 有的站点只认 Codex CLI 的 UA，其他一律当机器人。
      headers.set("user-agent", USER_AGENT);
      if (md.userId) headers.set("New-Api-User", String(md.userId));
      if (style === "anthropic") headers.set("x-api-key", key);
      else if (style === "gemini") headers.set("x-goog-api-key", key);
      else headers.set("authorization", `Bearer ${key}`);

      let nextHref = own.href;
      let nextBody = init.body;
      if (target) {
        if (style === "gemini") nextHref = rewriteGeminiPath(own.href, model);
        else if (typeof bodyText === "string" && bodyText) nextBody = rewriteBodyModel(bodyText, model);
      }

      let res;
      try {
        res = await fetchImpl(nextHref, { ...init, headers, body: nextBody });
      } catch (e) {
        lastError = e;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        // 分组 key 被拒不等于账号的访问令牌被拒：先试这一组的另一条 key，
        // 并告诉 Magpie 保住这个账号。
        lastResponse = await keepBody(res);
        continue;
      }
      if (res.status === 429) {
        lastResponse = await keepBody(res);
        continue;
      }
      return res;
    }

    if (lastResponse) {
      // 所有 key 都被拒也不能把站点账号标成失效：访问令牌可能还是好的。
      if (lastResponse.status === 401 || lastResponse.status === 403) return kept(lastResponse);
      return lastResponse;
    }
    return jsonError(502, `New API: ${lastError?.message ?? t("New API: the request failed").replace(/^New API: /, "")}`);
  };
}

/** 没指明分组的请求归哪个分组：站点默认分组，否则第一个有 key 的分组。 */
export function defaultGroup(md, groups = groupsOf(md)) {
  const names = Object.keys(groups).filter((g) => groups[g]?.key && !groups[g]?.problem);
  const wanted = String(md?.defaultGroup ?? "").trim();
  if (wanted && names.includes(wanted)) return wanted;
  if (names.includes("default")) return "default";
  return names[0] ?? wanted ?? "default";
}

async function keepBody(res) {
  try {
    const copy = res.clone();
    await copy.arrayBuffer();
  } catch {
    // 没有要排空的内容
  }
  return res;
}

function kept(res) {
  const headers = new Headers(res.headers);
  headers.set("X-Magpie-Sign-In", "kept");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function jsonError(status, message) {
  const body = JSON.stringify({ error: { message, type: "newapi_plugin" } });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" },
  });
}

export { ChallengeError, isAuthError };
