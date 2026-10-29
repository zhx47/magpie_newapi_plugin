// The plugin's fetch: one request from Magpie's gateway to a New API site.
//
// Magpie already translated the request into the model's protocol. What is
// left is New API's own shape:
//   - which group's key signs it (the group is in `api.id`, put there by
//     models.mjs, and shows up as the body's model or the Gemini path);
//   - the bare model name the site expects;
//   - the auth header that endpoint reads.
//
// Access tokens are for the management API and must never reach a relay
// endpoint, so every header Magpie may have set from the account key is
// removed first.

import { ChallengeError, isAuthError } from "./api.mjs";
import { authStyleOf, geminiModelSegment, parseWireId } from "./protocols.mjs";
import { keysToTry } from "./state.mjs";

/** Read the group and model a request is for. Null when it names neither. */
export function readTarget(pathname, bodyText) {
  const segment = geminiModelSegment(pathname);
  if (segment) {
    const parsed = parseWireId(segment);
    if (parsed) return parsed;
    // A model id that isn't ours: the bare model is what the segment says.
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
      // not JSON: nothing to read
    }
  }
  return null;
}

/** Replace the body's model with the bare one, keeping everything else. */
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

/** Replace the model segment of a Gemini path with the bare model. */
export function rewriteGeminiPath(href, model) {
  if (!model) return href;
  const segment = geminiModelSegment(new URL(href).pathname);
  if (!segment) return href;
  return href.replace(segment, encodeURIComponent(model));
}

/**
 * The fetch a plugin's loader gives Magpie. `getAuth` reads the account's
 * current sign-in, so a key the user pasted after signing in is used
 * without a restart.
 */
export function makeFetch(getAuth, { fetchImpl = globalThis.fetch } = {}) {
  return async function newapiFetch(input, init = {}) {
    const auth = await getAuth();
    const md = auth?.metadata ?? {};
    const groupKeys = nonEmptyKeys(md.groupKeys);
    const base = String(md.baseURL ?? "");

    const href = typeof input === "string" ? input : input?.url ?? String(input);
    let url;
    try {
      url = new URL(href);
    } catch {
      return jsonError(400, "New API: the request URL is not valid");
    }

    const bodyText = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    const target = readTarget(url.pathname, bodyText);
    const group = target?.group || defaultGroup(md, groupKeys);
    const model = target?.model ?? "";

    const keys = keysToTry(groupKeys, group, model, {}, 2);
    if (!keys.length) {
      return jsonError(
        503,
        `New API: no API key for group "${group}". Sign in again and paste ${group}=sk-... (or turn on "Create missing group keys").`,
      );
    }

    const style = authStyleOf(url.pathname);
    let lastResponse = null;
    let lastError = null;

    for (const key of keys) {
      const headers = new Headers(init.headers ?? {});
      // Magpie set these from the account's key (an access token) or its
      // placeholder: none belongs on a relay request.
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.delete("x-goog-api-key");
      headers.delete("content-length");
      headers.delete("content-encoding");
      if (md.userId) headers.set("New-Api-User", String(md.userId));
      if (style === "anthropic") headers.set("x-api-key", key);
      else if (style === "gemini") headers.set("x-goog-api-key", key);
      else headers.set("authorization", `Bearer ${key}`);

      let nextHref = href;
      let nextBody = init.body;
      if (target) {
        if (style === "gemini") nextHref = rewriteGeminiPath(href, model);
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
        // A group key refused is not the account's access token refused:
        // try the group's next key, and tell Magpie to keep the account.
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
      // A refusal from every key must not mark the site's account lapsed:
      // the access token may still be fine.
      if (lastResponse.status === 401 || lastResponse.status === 403) return kept(lastResponse);
      return lastResponse;
    }
    return jsonError(502, `New API: ${lastError?.message ?? "the request failed"}`);
  };
}

function nonEmptyKeys(groupKeys) {
  const out = {};
  for (const [group, value] of Object.entries(groupKeys ?? {})) {
    const list = (Array.isArray(value) ? value : [value]).filter((k) => typeof k === "string" && k.trim());
    if (list.length) out[group] = list;
  }
  return out;
}

/** The group a request without one belongs to: the site's default, else the first keyed group. */
export function defaultGroup(md, groupKeys = nonEmptyKeys(md?.groupKeys)) {
  const names = Object.keys(groupKeys);
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
    // nothing to drain
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
