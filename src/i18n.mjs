// 界面文案与语言。
//
// Magpie 把用户选的语言写在配置目录的 settings.json 里，字段 `lang`，
// 取值是 system、en、zh、zh-TW、ja、de（internal/settings/settings.go 的 Langs）。
// 插件的 input.directory 就是那个目录，所以这里直接读它。
//
// "system" 由 Magpie 的窗口按系统语言解析，插件拿不到浏览器语言，于是
// 退回英文——和 Magpie 在系统语言无法识别时一样。
//
// 所有给用户看的字符串都要经过 t()：登录提问、用量卡片、错误消息。
// 内部日志和代码注释不在此列。

import fs from "node:fs";
import path from "node:path";

/** Magpie 支持的语言，按它的顺序。 */
export const LANGS = ["en", "zh", "zh-TW", "ja", "de"];

/** 一句话的五个版本。键是英文原文，值按 LANGS 排列。 */
const STRINGS = {
  // ---- 登录提问 ----
  "Which account? Picking one reuses the access token Magpie already has.": {
    zh: "哪个账号？选中一个会复用 Magpie 已保存的访问令牌。",
    "zh-TW": "哪個帳號？選中一個會沿用 Magpie 已儲存的存取權杖。",
    ja: "どのアカウントですか？選ぶと Magpie が保存しているアクセストークンを使います。",
    de: "Welches Konto? Eine Auswahl nutzt das Zugriffstoken, das Magpie bereits hat.",
  },
  "Another site (paste its access token)": {
    zh: "另一个站点（粘贴它的访问令牌）",
    "zh-TW": "另一個站點（貼上它的存取權杖）",
    ja: "別のサイト（アクセストークンを貼り付け）",
    de: "Andere Seite (Zugriffstoken einfügen)",
  },
  "New API base URL": {
    zh: "New API 站点地址",
    "zh-TW": "New API 站點位址",
    ja: "New API のベース URL",
    de: "New API Basis-URL",
  },
  "Access token": {
    zh: "访问令牌",
    "zh-TW": "存取權杖",
    ja: "アクセストークン",
    de: "Zugriffstoken",
  },
  "User id (old New API only; leave empty)": {
    zh: "用户 ID（仅旧版 New API 需要，可留空）",
    "zh-TW": "使用者 ID（僅舊版 New API 需要，可留空）",
    ja: "ユーザー ID（旧 New API のみ。空欄可）",
    de: "Benutzer-ID (nur altes New API; leer lassen)",
  },
  "Site label (the model prefix; empty uses the host)": {
    zh: "站点标识（模型前缀，留空则用域名）",
    "zh-TW": "站點標識（模型前綴，留空則用網域）",
    ja: "サイト名（モデルの接頭辞。空欄ならホスト名）",
    de: "Seitenname (Präfix der Modelle; leer = Hostname)",
  },
  "{n} group without a key ({names}). Let the site create one for each?": {
    zh: "{n} 个分组没有 key（{names}）。让站点为每个分组各创建一个吗？",
    "zh-TW": "{n} 個分組沒有 key（{names}）。讓站點為每個分組各建立一個嗎？",
    ja: "key のないグループが {n} 個あります（{names}）。サイトにそれぞれ作成させますか？",
    de: "{n} Gruppe ohne Schlüssel ({names}). Soll die Seite für jede einen erstellen?",
  },
  "{n} groups without a key ({names}). Let the site create one for each?": {
    zh: "{n} 个分组没有 key（{names}）。让站点为每个分组各创建一个吗？",
    "zh-TW": "{n} 個分組沒有 key（{names}）。讓站點為每個分組各建立一個嗎？",
    ja: "key のないグループが {n} 個あります（{names}）。サイトにそれぞれ作成させますか？",
    de: "{n} Gruppen ohne Schlüssel ({names}). Soll die Seite für jede einen erstellen?",
  },
  "Yes, create a token for each": {
    zh: "是，每组各建一个",
    "zh-TW": "是，每組各建一個",
    ja: "はい、それぞれ作成する",
    de: "Ja, für jede einen erstellen",
  },
  "No, I will paste them": {
    zh: "不，我自己填",
    "zh-TW": "不，我自己填",
    ja: "いいえ、自分で入力します",
    de: "Nein, ich füge sie selbst ein",
  },
  'API key for group "{group}"': {
    zh: "分组「{group}」的 API key",
    "zh-TW": "分組「{group}」的 API key",
    ja: "グループ「{group}」の API key",
    de: "API-Schlüssel für Gruppe „{group}“",
  },
  'API key for group "{group}" — the site refused it': {
    zh: "分组「{group}」的 API key —— 站点拒绝了它",
    "zh-TW": "分組「{group}」的 API key —— 站點拒絕了它",
    ja: "グループ「{group}」の API key — サイトが拒否しました",
    de: "API-Schlüssel für Gruppe „{group}“ – die Seite hat ihn abgelehnt",
  },
  "sk-... (leave empty to skip this group)": {
    zh: "sk-...（留空则跳过这个分组）",
    "zh-TW": "sk-...（留空則跳過這個分組）",
    ja: "sk-...（空欄ならこのグループを飛ばす）",
    de: "sk-... (leer lassen, um die Gruppe zu überspringen)",
  },
  "paste another key, or leave empty to skip this group": {
    zh: "换一个 key，或留空跳过这个分组",
    "zh-TW": "換一個 key，或留空跳過這個分組",
    ja: "別の key を入力、または空欄でこのグループを飛ばす",
    de: "Anderen Schlüssel einfügen oder leer lassen, um die Gruppe zu überspringen",
  },
  "Daily check-in": {
    zh: "每日签到",
    "zh-TW": "每日簽到",
    ja: "毎日のチェックイン",
    de: "Täglicher Check-in",
  },
  "Off (check in on the site yourself)": {
    zh: "关闭（自己在站点签到）",
    "zh-TW": "關閉（自己在站點簽到）",
    ja: "オフ（サイトで自分でチェックイン）",
    de: "Aus (selbst auf der Seite einchecken)",
  },
  "Automatic": {
    zh: "自动",
    "zh-TW": "自動",
    ja: "自動",
    de: "Automatisch",
  },

  // ---- 登录校验 ----
  "Enter an http(s) URL, e.g. https://newapi.example.com": {
    zh: "请输入 http(s) 地址，例如 https://newapi.example.com",
    "zh-TW": "請輸入 http(s) 位址，例如 https://newapi.example.com",
    ja: "http(s) の URL を入力してください（例: https://newapi.example.com）",
    de: "Eine http(s)-URL eingeben, z. B. https://newapi.example.com",
  },
  "Enter the site's access token (not an sk- API key)": {
    zh: "请输入站点的访问令牌（不是 sk- 开头的推理 key）",
    "zh-TW": "請輸入站點的存取權杖（不是 sk- 開頭的推理 key）",
    ja: "サイトのアクセストークンを入力してください（sk- で始まる key ではありません）",
    de: "Zugriffstoken der Seite eingeben (kein sk--API-Schlüssel)",
  },
  "That is a relay API key. Use the access token from the site's account settings.": {
    zh: "这是推理用的 API key。请使用站点账号设置里的访问令牌。",
    "zh-TW": "這是推理用的 API key。請使用站點帳號設定裡的存取權杖。",
    ja: "これは推論用の API key です。サイトのアカウント設定にあるアクセストークンを使ってください。",
    de: "Das ist ein Relay-API-Schlüssel. Bitte das Zugriffstoken aus den Kontoeinstellungen der Seite verwenden.",
  },
  "The site refused the access token ({why}). Check the token, and the user id.": {
    zh: "站点拒绝了访问令牌（{why}）。请检查令牌和用户 ID。",
    "zh-TW": "站點拒絕了存取權杖（{why}）。請檢查權杖和使用者 ID。",
    ja: "サイトがアクセストークンを拒否しました（{why}）。トークンとユーザー ID を確認してください。",
    de: "Die Seite hat das Zugriffstoken abgelehnt ({why}). Token und Benutzer-ID prüfen.",
  },
  "The site refused the access token ({why}). Older New API needs your user id — fill the User id field.": {
    zh: "站点拒绝了访问令牌（{why}）。旧版 New API 需要用户 ID —— 请填写 User id。",
    "zh-TW": "站點拒絕了存取權杖（{why}）。舊版 New API 需要使用者 ID —— 請填寫 User id。",
    ja: "サイトがアクセストークンを拒否しました（{why}）。旧 New API はユーザー ID が必要です — User id を入力してください。",
    de: "Die Seite hat das Zugriffstoken abgelehnt ({why}). Altes New API braucht die Benutzer-ID – das Feld User id ausfüllen.",
  },
  "Could not reach {base}. Check the URL and the network, then sign in again.": {
    zh: "无法连接 {base}。请检查地址和网络后重新登录。",
    "zh-TW": "無法連線 {base}。請檢查位址和網路後重新登入。",
    ja: "{base} に接続できません。URL とネットワークを確認して、もう一度サインインしてください。",
    de: "{base} ist nicht erreichbar. URL und Netzwerk prüfen und erneut anmelden.",
  },

  // ---- 用量卡片 ----
  "Balance": {
    zh: "余额",
    "zh-TW": "餘額",
    ja: "残高",
    de: "Guthaben",
  },
  "Group keys": {
    zh: "分组 key",
    "zh-TW": "分組 key",
    ja: "グループの key",
    de: "Gruppenschlüssel",
  },
  "Auto check-in off · check in on the site": {
    zh: "自动签到已关闭 · 请到站点签到",
    "zh-TW": "自動簽到已關閉 · 請到站點簽到",
    ja: "自動チェックインはオフ · サイトでチェックインしてください",
    de: "Auto-Check-in aus · bitte auf der Seite einchecken",
  },
  "{left} left": {
    zh: "剩余 {left}",
    "zh-TW": "剩餘 {left}",
    ja: "残り {left}",
    de: "{left} übrig",
  },
  "no key: {groups}": {
    zh: "没有 key：{groups}",
    "zh-TW": "沒有 key：{groups}",
    ja: "key なし: {groups}",
    de: "kein Schlüssel: {groups}",
  },
  "refused: {groups}": {
    zh: "被拒绝：{groups}",
    "zh-TW": "被拒絕：{groups}",
    ja: "拒否: {groups}",
    de: "abgelehnt: {groups}",
  },
  "gone: {groups}": {
    zh: "已移除：{groups}",
    "zh-TW": "已移除：{groups}",
    ja: "提供終了: {groups}",
    de: "entfernt: {groups}",
  },
  "— sign in again to fix": {
    zh: "—— 重新登录以修复",
    "zh-TW": "—— 重新登入以修復",
    ja: "— サインインし直して修正",
    de: "– erneut anmelden, um es zu beheben",
  },

  // ---- 签到 ----
  "The site's proof of work did not finish in time. Check in on its website.": {
    zh: "站点的计算题没能在限定时间内算完。请到它的网站签到。",
    "zh-TW": "站點的計算題沒能在限定時間內算完。請到它的網站簽到。",
    ja: "サイトの計算問題が制限時間内に解けませんでした。サイト上でチェックインしてください。",
    de: "Die Rechenaufgabe der Seite war nicht rechtzeitig zu lösen. Bitte auf ihrer Website einchecken.",
  },
  "The site's proof of work could not be solved. Check in on its website.": {
    zh: "站点的计算题算不出来。请到它的网站签到。",
    "zh-TW": "站點的計算題算不出來。請到它的網站簽到。",
    ja: "サイトの計算問題を解けませんでした。サイト上でチェックインしてください。",
    de: "Die Rechenaufgabe der Seite war nicht zu lösen. Bitte auf ihrer Website einchecken.",
  },
  "Auto check-in is off for this site. Check in on the site itself.": {
    zh: "这个站点关闭了自动签到。请到站点自己签到。",
    "zh-TW": "這個站點關閉了自動簽到。請到站點自己簽到。",
    ja: "このサイトでは自動チェックインをオフにしています。サイトで直接チェックインしてください。",
    de: "Auto-Check-in ist für diese Seite aus. Bitte direkt auf der Seite einchecken.",
  },
  "This site asks for a Cloudflare challenge. Check in on its website.": {
    zh: "这个站点有 Cloudflare 质询。请到它的网站签到。",
    "zh-TW": "這個站點有 Cloudflare 質詢。請到它的網站簽到。",
    ja: "このサイトは Cloudflare のチャレンジを要求します。サイト上でチェックインしてください。",
    de: "Diese Seite verlangt eine Cloudflare-Prüfung. Bitte auf ihrer Website einchecken.",
  },
  "This site asks for a captcha. Check in on its website.": {
    zh: "这个站点要求验证码。请到它的网站签到。",
    "zh-TW": "這個站點要求驗證碼。請到它的網站簽到。",
    ja: "このサイトはキャプチャを要求します。サイト上でチェックインしてください。",
    de: "Diese Seite verlangt ein Captcha. Bitte auf ihrer Website einchecken.",
  },
  "Check-in is not enabled on this site": {
    zh: "这个站点没有开启签到",
    "zh-TW": "這個站點沒有開啟簽到",
    ja: "このサイトではチェックインが有効になっていません",
    de: "Check-in ist auf dieser Seite nicht aktiviert",
  },
  "Already checked in today": {
    zh: "今天已经签到过了",
    "zh-TW": "今天已經簽到過了",
    ja: "本日はチェックイン済みです",
    de: "Heute wurde bereits eingecheckt",
  },
  "Already checked in today · +{credit}": {
    zh: "今天已经签到过了 · +{credit}",
    "zh-TW": "今天已經簽到過了 · +{credit}",
    ja: "本日はチェックイン済みです · +{credit}",
    de: "Heute bereits eingecheckt · +{credit}",
  },
  "Checked in · +{credit}": {
    zh: "已签到 · +{credit}",
    "zh-TW": "已簽到 · +{credit}",
    ja: "チェックインしました · +{credit}",
    de: "Eingecheckt · +{credit}",
  },
  "Checked in": {
    zh: "已签到",
    "zh-TW": "已簽到",
    ja: "チェックインしました",
    de: "Eingecheckt",
  },
  "check-in failed": {
    zh: "签到失败",
    "zh-TW": "簽到失敗",
    ja: "チェックインに失敗しました",
    de: "Check-in fehlgeschlagen",
  },
  "not signed in": {
    zh: "未登录",
    "zh-TW": "未登入",
    ja: "サインインしていません",
    de: "Nicht angemeldet",
  },

  // ---- 供应商选项 ----
  "Create missing group keys": {
    zh: "为缺失的分组自动创建 key",
    "zh-TW": "為缺失的分組自動建立 key",
    ja: "不足しているグループの key を自動作成",
    de: "Fehlende Gruppenschlüssel erstellen",
  },
  "Ask the site to create an API token for each group Magpie has no key for.": {
    zh: "让站点为 Magpie 没有 key 的分组各创建一个 API 令牌。",
    "zh-TW": "讓站點為 Magpie 沒有 key 的分組各建立一個 API 權杖。",
    ja: "Magpie が key を持っていないグループごとに、サイトに API トークンを作らせます。",
    de: "Die Seite bitten, für jede Gruppe ohne Schlüssel ein API-Token zu erstellen.",
  },
  "This creates API tokens named magpie-... on your New API site.": {
    zh: "这会在你的 New API 站点上创建名为 magpie-... 的 API 令牌。",
    "zh-TW": "這會在您的 New API 站點上建立名為 magpie-... 的 API 權杖。",
    ja: "New API サイトに magpie-... という名前の API トークンを作成します。",
    de: "Dies erstellt API-Token namens magpie-... auf Ihrer New API-Seite.",
  },
  "List every protocol a model supports": {
    zh: "列出模型支持的每种协议",
    "zh-TW": "列出模型支援的每種協定",
    ja: "モデルが対応するすべてのプロトコルを一覧表示",
    de: "Jedes unterstützte Protokoll eines Modells auflisten",
  },
  "Show a separate model for chat, Responses, Messages and Gemini when the site supports more than one.": {
    zh: "站点支持多种协议时，为 chat、Responses、Messages、Gemini 各列一个模型。",
    "zh-TW": "站點支援多種協定時，為 chat、Responses、Messages、Gemini 各列一個模型。",
    ja: "サイトが複数のプロトコルに対応しているとき、chat・Responses・Messages・Gemini をそれぞれ別のモデルとして表示します。",
    de: "Für Chat, Responses, Messages und Gemini je ein eigenes Modell anzeigen, wenn die Seite mehr als eines unterstützt.",
  },
  "Prefer Responses for GPT-5 and Codex models": {
    zh: "GPT-5 与 Codex 类模型优先用 Responses",
    "zh-TW": "GPT-5 與 Codex 類模型優先使用 Responses",
    ja: "GPT-5 と Codex 系モデルは Responses を優先",
    de: "Für GPT-5- und Codex-Modelle Responses bevorzugen",
  },
  "Send GPT-5 class models on OpenAI's Responses API when the site offers it.": {
    zh: "站点提供 Responses 时，GPT-5 类模型走 OpenAI Responses API。",
    "zh-TW": "站點提供 Responses 時，GPT-5 類模型走 OpenAI Responses API。",
    ja: "サイトが提供していれば、GPT-5 系モデルを OpenAI の Responses API で送ります。",
    de: "GPT-5-Klasse über OpenAIs Responses-API senden, wenn die Seite sie anbietet.",
  },
  "Prefer Messages for Claude models": {
    zh: "Claude 类模型优先用 Messages",
    "zh-TW": "Claude 類模型優先使用 Messages",
    ja: "Claude 系モデルは Messages を優先",
    de: "Für Claude-Modelle Messages bevorzugen",
  },
  "Send Claude models on Anthropic's Messages API when the site offers it, keeping thinking and cache control.": {
    zh: "站点提供 Anthropic Messages 时，Claude 类模型走它，保留 thinking 与 cache_control。",
    "zh-TW": "站點提供 Anthropic Messages 時，Claude 類模型走它，保留 thinking 與 cache_control。",
    ja: "サイトが提供していれば、Claude 系モデルを Anthropic の Messages API で送り、thinking と cache_control を保ちます。",
    de: "Claude-Modelle über Anthropics Messages-API senden, wenn die Seite sie anbietet – Thinking und Cache-Control bleiben erhalten.",
  },

  "the request was cancelled": {
    zh: "请求已取消",
    "zh-TW": "請求已取消",
    ja: "リクエストは取り消されました",
    de: "Die Anfrage wurde abgebrochen",
  },
  "could not reach {url}: {why}": {
    zh: "无法连接 {url}：{why}",
    "zh-TW": "無法連線 {url}：{why}",
    ja: "{url} に接続できません: {why}",
    de: "{url} ist nicht erreichbar: {why}",
  },
  "New API refused the request": {
    zh: "New API 拒绝了请求",
    "zh-TW": "New API 拒絕了請求",
    ja: "New API がリクエストを拒否しました",
    de: "New API hat die Anfrage abgelehnt",
  },
  "the site has no check-in endpoint": {
    zh: "站点没有签到接口",
    "zh-TW": "站點沒有簽到介面",
    ja: "サイトにチェックインのエンドポイントがありません",
    de: "Die Seite hat keinen Check-in-Endpunkt",
  },
  "the site's groups could not be read": {
    zh: "读不到站点的分组",
    "zh-TW": "讀不到站點的分組",
    ja: "サイトのグループを読み取れません",
    de: "Die Gruppen der Seite konnten nicht gelesen werden",
  },

  // ---- 请求转发 ----
  "New API: the request URL is not valid": {
    zh: "New API：请求地址无效",
    "zh-TW": "New API：請求位址無效",
    ja: "New API: リクエスト URL が無効です",
    de: "New API: Die Anforderungs-URL ist ungültig",
  },
  "New API: no usable key for group \"{group}\". Sign in again to add or replace it.": {
    zh: "New API：分组「{group}」没有可用的 key。请重新登录以补上或替换。",
    "zh-TW": "New API：分組「{group}」沒有可用的 key。請重新登入以補上或替換。",
    ja: "New API: グループ「{group}」に有効な key がありません。サインインし直して追加または入れ替えてください。",
    de: "New API: Kein verwendbarer Schlüssel für Gruppe „{group}“. Erneut anmelden, um ihn zu ergänzen oder zu ersetzen.",
  },
  "New API: the request failed": {
    zh: "New API：请求失败",
    "zh-TW": "New API：請求失敗",
    ja: "New API: リクエストに失敗しました",
    de: "New API: Die Anfrage ist fehlgeschlagen",
  },
  "New API: no models listed for {site}. Check the group keys and that the site's /v1/models answers.": {
    zh: "New API：{site} 没有列出任何模型。请检查分组 key，以及站点的 /v1/models 是否正常。",
    "zh-TW": "New API：{site} 沒有列出任何模型。請檢查分組 key，以及站點的 /v1/models 是否正常。",
    ja: "New API: {site} にモデルがありません。グループの key と、サイトの /v1/models が応答するかを確認してください。",
    de: "New API: Für {site} sind keine Modelle gelistet. Gruppenschlüssel prüfen und ob /v1/models der Seite antwortet.",
  },
};

/** 当前语言：读 settings.json 的 lang，system 或无法识别时用英文。 */
let current = "en";
let loaded = false;

/** 读一次 Magpie 的设置，取语言。插件目录就是 Magpie 的配置目录。 */
export function languageOf(directory) {
  if (loaded || !directory) return current;
  loaded = true;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"));
    current = normalizeLang(s?.lang);
  } catch {
    current = "en";
  }
  return current;
}

/** 把 Magpie 的 lang 值折成插件支持的几种。 */
export function normalizeLang(lang) {
  const l = String(lang ?? "").trim();
  if (!l || l === "system") return "en";
  if (LANGS.includes(l)) return l;
  if (/^zh-(tw|hk|mo|hant)/i.test(l)) return "zh-TW";
  if (/^zh/i.test(l)) return "zh";
  if (/^ja/i.test(l)) return "ja";
  if (/^de/i.test(l)) return "de";
  return "en";
}

/** 当前语言，供测试与诊断。 */
export function locale() {
  return current;
}

/** 测试用：直接指定语言，跳过 settings.json。 */
export function setLocale(lang) {
  current = normalizeLang(lang);
  loaded = true;
}

/**
 * 一条文案。`vars` 里的值填进 {name}。
 * 没有译文的句子按英文原样返回，绝不返回 undefined。
 */
export function t(s, vars) {
  const row = STRINGS[s];
  let out = row?.[current] ?? s;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

/** 所有译文句子的英文键，测试用：确认每种语言都有每一条。 */
export function stringKeys() {
  return Object.keys(STRINGS);
}

/** 某种语言的整张表，测试用。 */
export function stringsOf(lang) {
  const l = normalizeLang(lang);
  const out = {};
  for (const [en, row] of Object.entries(STRINGS)) out[en] = row[l] ?? en;
  return out;
}
