# Magpie × NewAPI 插件：需求调研与实现路径

> 调研对象：`D:\IdeaProjects\magpie`（Magpie）、`D:\IdeaProjects\octopus`（Octopus）、NewAPI（Calcium-Ion/new-api，2026-10-28 的 `main`）。
> 结论先行：**可行，已按 OpenCode v1 provider 插件（Bun/JS）实现，66 项测试通过。**
> 本文件是设计与实现记录；可运行的代码在 `index.mjs` 与 `src/`，使用说明见 `README.md`。

---

## 0. 结论摘要（TL;DR）

1. **形态**：一个 npm 包 / 本地文件夹形式的 OpenCode v1 插件，provider id 用 `newapi`。Magpie 会把它变成供应商，agent 用 `newapi/<model>` 访问。
2. **站点与账号**：一个 NewAPI 站点（baseURL + access token）对应 **一个 Magpie 插件账号**；多个站点就是同一个 `newapi` 供应商下的多个账号。这样余额、签到天然按站点只做一次。
3. **分组**：分组不是独立的 Magpie 账号，而是 **模型命名空间**：`<siteLabel>/<group>/<model>`。因此 `default/gpt-4` 与 `vip/gpt-4` 是两个不同的 Magpie 模型，不会互相覆盖。
4. **多端点**：每个 Magpie 模型独立声明 `api.npm` / `api.url` / `api.id`。同一分组下 Chat、Responses、Anthropic、Gemini 可以并存；同一个模型也可以按需列出多个协议变体。这正是 Octopus 的“一个模型一个渠道”做不到的。
5. **分组 key**：
   - 优先从 `/api/token/` 读取 token 列表，再用 `/api/token/batch/keys` 或 `/api/token/:id/key` 取回完整 key；
   - 取不到（被审计/安全验证拦截、旧版本没有接口）时，登录时用 `group=sk-...` 的提示手动回填；
   - 可选“自动为该分组创建 token”，但 NewAPI 的 `AddToken` **不返回 key**，创建后仍需 reveal，因此手动回填必须保留。
6. **余额**：`/api/status` 拿 `quota_per_unit`、币种显示方式；`/api/user/self` 拿 `quota`、`used_quota`、`request_count`。默认 `500000 quota = $1`。
7. **签到**：新版本 `GET/POST /api/user/self/checkin`，旧版本 fallback `POST /api/user/checkin`；站点开启 Turnstile 时直接返回 `captcha`，绝不尝试破解。
8. **必须接受的两个限制**：
   - Magpie 插件的 `auth.provider` 是静态的，不能“每次登录动态新增一个供应商”。所以采用“一个 `newapi` 供应商 + 每站点一个账号”，而不是“每站点一个供应商”。（替代方案见 §3.2。）
   - 手动回填的 key 在重新登录时会被新账号覆盖；需要一个插件侧的小状态文件做合并（§3.5.6），否则每次重登都要把所有 key 再贴一遍。

---

## 1. 目标与非目标

### 1.1 目标

- 用 **access token（+ 可选 user id）** 登录一个 NewAPI 站点。
- 自动读取并展示该站点的 **余额**、**用户分组**、**可用模型**。
- 正确处理 **不同分组下的重名模型**（同一模型名在多个分组都出现）。
- 正确处理 **同一分组内不同端点的模型**（Chat / Responses / Anthropic / Gemini），以及 **一个模型支持多种端点**。
- 分组 key 支持 **自动发现 + 手动回填**；支持多 key（同组轮换/故障切换）。
- 支持 Magpie 的 **每日签到**（`auth.checkin`）。
- 单站点失败（某个分组 key 失效）不拖垮整个站点账号。

### 1.2 非目标（v1）

- 图片生成、Embeddings、Rerank、Video 模型（只在聊天模型列表里跳过；后续可加）。
- 自动解 Turnstile / CAPTCHA。
- 自动创建 Magpie 路由组、跨站点自动 failover 组（用户可用 Magpie 的 Routing 手动建）。
- 专属 GUI 页面（v1 用登录提示 + 用量卡片表达“缺 key”）。
- NewAPI 管理端功能（渠道管理、用户管理、兑换码等），只用普通用户权限。

---

## 2. 调研结果

### 2.1 Magpie 插件机制（与本次需求相关的关键事实）

来源：`magpie/docs/subsystems/plugin-runtime.md`、`plugin-tools.md`、`provider-plugins.md`、`internal/plugin/providers.go`、`internal/plugin/host.js`、`internal/provider/plugins.go`。

| 事实 | 对设计的影响 |
| --- | --- |
| 插件是 OpenCode v1 形式：模块导出 async 函数，返回 `config`、`auth`、`provider.models`、`chat.headers` 等钩子。 | 用 JS/TS 写，Bun 运行；无需改 Magpie 核心。 |
| `auth` = `{ provider, methods, loader, usage?, refresh?, checkin?, options?, icon?, maxConcurrency? }`。 | 一个插件函数对应一个 provider id。 |
| `provider.models(provider, { auth })` **按账号**调用，返回该账号的模型表；账号的 `Models` 会用于路由过滤（`Account.Lists`）。 | 每个站点账号返回自己的模型；某些模型只由对应账号承接。 |
| 模型字段：`id`（catalog id）、`api: { id, url, npm }`、`limit`、`capabilities`、`cost`、`variants`、`disabled`。 | `api.npm` 决定协议，`api.url` 决定 base，`api.id` 是真正发给上游的 model（可被插件再改写）。 |
| `config` 钩子里的模型可以写 `provider: { npm, api }` 作为便捷写法；但 **`provider.models` 钩子返回的是 OpenCode `Model`，必须写 `api: { id, url, npm }`**。host.js 对 `provider.models` 的返回值只做 `{...m, id: key, providerID}`，不会再从 `provider` 构造 `api`。 | 本插件在 `provider.models` 里返回 `api` 对象；`config` 里不预置模型。 |
| `api.npm` → 协议：`@ai-sdk/openai-compatible` → Chat；`@ai-sdk/openai`/`@ai-sdk/azure` → Responses；`@ai-sdk/anthropic` → Anthropic；`@ai-sdk/google` → CodeAssist（Gemini generateContent 路径）。 | 一个模型只能声明一种协议，但**不同模型可以不同**；同一模型要多种协议就列多个条目。 |
| 网关把请求翻译成模型的协议，再交给插件的 `loader.fetch`。 | 插件不需要自己翻译协议，只负责选 key、改写 model、加认证头、转发。 |
| `loader(getAuth)` 每个账号运行一次，返回 `{ baseURL?, apiKey?, headers?, fetch? }`；`fetch(input, init)` 收到完整 URL + 已构造好的 headers/body。 | 用自定义 fetch 实现按分组选 key、把 `api.id` 还原成上游 model。 |
| `options()` 在 `loader` 没给 `apiKey` 时自动用账号的 `key`。 | 账号 `key` 是 access token，不能让它被默认发到推理接口；fetch 必须删掉默认认证头，或用占位 `apiKey`。 |
| `fetchAs` 的 header 顺序：SDK key 头 → loader headers → 网关头 → `chat.headers`。 | 自定义 fetch 最终覆盖认证头即可。 |
| `auth.usage` 按账号运行，窗口支持 `balance`（预付钱包）、`display`（纯文本）、`amount/limit/unit`。 | 余额用 `balance` 窗口；缺 key、已用额度用 `display` 文本窗口。 |
| `auth.checkin` 每个北京日每账号一次，返回 `{ outcome, credit?, streak?, message?, until? }`；`outcome` ∈ claimed/done/ineligible/inactive/captcha/failed。 | 直接映射 NewAPI 签到结果。 |
| `auth.options` 只支持 **布尔开关**（`key/label/description/default/confirm`）。 | 协议偏好、自动建 key、暴露多协议都做成布尔开关。 |
| 登录 method 的 `prompts` 支持 `text`、`password`、`select`，支持 `when`/`validate`。 | access token 用 `password`；分组 key 回填用 `text`。 |
| `save()` 会把 method 的 `inputs` 合并进账号 `metadata`；API key 方式只保存 `{type, key, metadata}`，**不保存返回对象顶层的 `accountId`**；`whoOf()` 读的是顶层 `accountId` 或 `metadata.email`。`settle()` 按 `whoOf` 或密钥去重。 | 稳定标识要放在 `metadata.email`（同时保留 `metadata.accountId` 供插件自己用）；否则 CLI 重登会生成重复账号。 |
| `client.auth.set({path:{id}, body})` 保存当前作用域账号的完整 auth（不合并）。 | 可以在 `fetch`/`models` 里更新 metadata（如标记坏 key），但要小心并发。 |
| `directory` 是 Magpie 配置目录，插件可以写文件。 | 分组 key 合并缓存可以放这里（§3.5.6）。 |
| `provider.models` 单次有 20s 上限；一个插件供应商的模型表是所有账号的并集，`Account.Models` 负责过滤。 | 分组多时要缓存；模型 ID 必须跨站点唯一（加 `<siteLabel>`）。 |
| Magpie 的 `provider/model` 只用**第一个** `/` 分割，model 里可以继续有 `/`。 | `<site>/<group>/<model>` 这种 ID 安全。 |
| `newapi` 目前不是 Magpie 内置 provider id。 | provider id 可以用 `newapi`；如果被占用，Magpie 会自动变成 `newapi-plugin`。 |
| Magpie 已有 NewAPI 余额支持：`/api/user/self` 的 `quota / 500000`、`New-Api-User` 头、`/api/usage/token`。 | 余额/兼容逻辑可以直接对齐，减少踩坑。 |

**Magpie 多账号行为（重要）**：插件供应商可以有多个账号；`pluginAccounts()` 把第一个账号作为主 Provider，`AlsoOn()` 把其余账号作为额外候选；路由时用 `Account.Lists(model)` 过滤。因此“一个站点一个账号”不会和其他站点冲突，只要模型 ID 带站点前缀。

**为什么不能只用 Magpie 的 custom provider？** Magpie 已经能用 custom provider + “Balance token” 读 NewAPI 的 `/api/user/self`，但 custom provider 只有一个 base、一个 key 池，无法表达：分组、每分组 key、同组内不同端点、重名模型跨分组、签到。插件是必要的。

### 2.2 Octopus 的 NewAPI 实现（可复用与不可取之处）

来源：`octopus/internal/model/site.go`、`internal/sitesync/sync.go`、`sync_fetch.go`、`route_probe.go`、`balance.go`、`create_key.go`、`project.go`。

Octopus 的做法：

1. **平台识别**：`SitePlatformNewAPI`，`SiteCredentialTypeAccessToken`/`UsernamePassword`/`APIKey`。
2. **凭据与余额**：access token 调 `/api/user/self`（可选 `New-Api-User`）；`quota/500000`、`used_quota/500000`；`today_income` 可选。
3. **分组**：`/api/user/self/groups`，fallback `/api/user_group_map`；`default` 为缺省分组。
4. **Token/分组 key**：`/api/token/?p=0&size=100`；返回的 `key` 可能被掩码；Octopus 用 `SiteTokenValueStatusMaskedPending` 标记“需要手动回填”，`NormalizeSiteTokenValueStatus` 通过 `*`/`•` 识别掩码。
5. **模型**：
   - 每个 token 调 `/v1/models`（`helper.FetchModels`）拿到该分组可用模型；
   - 用 `/api/pricing`（或 `/api/available_model`）的 `supported_endpoint_types`、`enable_groups` 推断每个模型的端点/分组；
   - `mapSupportedEndpointType` 把 `openai`/`openai_response`/`anthropic`/`gemini`/`embedding` 等映射成 `SiteModelRouteType`；
   - `gpt-5*` 且没有显式 response 时，启发式补 `/v1/responses`。
6. **路由探测**：`detectSiteModelRoutes` → `collectPricingRouteDetections` → `pickPreferredDetectedRouteType`（优先级 Anthropic > Responses > Chat > Gemini > Embedding）。
7. **签到**：`POST /api/user/checkin`；404/not found 视为平台不支持；`success` 或“already checked in”视为成功；`data.reward` 作为奖励。
8. **投影到渠道**：`ProjectAccount` 按分组把模型投影成 Octopus Channel；`shouldSplitForAccount` + `partitionSiteModelsByRouteType` 决定是否按 RouteType 拆成多个渠道。每个 `SiteModel` 只有一个 `RouteType`，每个渠道只有一个 outbound 类型。

**结论**：

- 可复用：端点/分组探测、token 掩码识别、quota 换算、签到语义、`New-Api-User` 兼容。
- 不可取：**Octopus 的模型最终被固定到单一 RouteType / 单一渠道**。一个模型即使同时支持 Chat 和 Responses，也会被 `pickPreferredDetectedRouteType` 选成一种；一个分组内不同端点的模型需要拆渠道，渠道再绑定模型。这对自己写 relay 的 Octopus 是合理取舍，但对“聚合器里的模型”表达力不够。
- Magpie 的 `api.npm` 是**模型级**的，正好可以在同一个供应商里同时表达 Chat/Responses/Anthropic/Gemini，不需要渠道拆分。这是本插件相对 Octopus 的核心优势。

### 2.3 NewAPI API 清单（本次实际会用到的）

来源：`router/api-router.go`、`controller/token.go`、`controller/user.go`、`controller/pricing.go`、`controller/checkin.go`、`controller/group.go`、`model/token.go`、`model/pricing.go`、`model/checkin.go`、`controller/misc.go`（2026-10-28 main）。

#### 2.3.1 站点与用户

| 接口 | 鉴权 | 返回/用途 |
| --- | --- | --- |
| `GET /api/status` | 公开 | `version`、`system_name`、`quota_per_unit`（默认 500000）、`display_in_currency`、`quota_display_type`、`custom_currency_symbol`、`usd_exchange_rate`、`checkin_enabled`、`turnstile_check`、`turnstile_site_key`。 |
| `GET /api/user/self` | User | `data.id`、`username`、`group`、`quota`、`used_quota`、`request_count`、`aff_*`。 |
| `GET /api/user/self/groups` | User | `data` = `{ groupName: { ratio, desc } }`。 |
| `GET /api/user/groups` | User（部分版本） | 同上，旧路径。 |
| `GET /api/user_group_map` | User（部分 fork） | 同上，AnyRouter 等 fork。 |
| `GET /api/user/models?group=<g>` | User | `data` = 该分组可用模型名数组；`group` 省略时为所有可用分组；`group=auto` 走自动分组。 |

#### 2.3.2 模型、端点、分组倍率

| 接口 | 鉴权 | 返回/用途 |
| --- | --- | --- |
| `GET /api/pricing` | 公开或 User（取决于站点“模型广场”设置；`HeaderNavModuleAuth("pricing")`） | `data: Pricing[]`；顶层还有 `vendors`、`group_ratio`、`usable_group`、`supported_endpoint`、`auto_groups`。 |
| `Pricing` 字段 | — | `model_name`、`enable_groups: string[]`、`supported_endpoint_types: string[]`、`model_ratio`、`model_price`、`completion_ratio`、`cache_ratio`、`create_cache_ratio`、`quota_type`、`billing_mode` 等。 |
| `supported_endpoint_types` 取值 | — | `openai`、`openai_response`、`openai_response_compact`、`anthropic`、`gemini`、`embeddings`、`image_generation`、`jina_rerank`、`openai_video`、`openai_alpha_search`、DeepSeek tools 等。 |
| `GET /v1/models` | API key | 用分组 key 调用，返回该 key 所在分组的可用模型（OpenAI 格式）；加 `x-api-key`+`anthropic-version` 或 `x-goog-api-key` 会返回对应格式，但我们统一用 OpenAI 格式列表。 |

#### 2.3.3 令牌（分组 key）

| 接口 | 鉴权 | 返回/用途 |
| --- | --- | --- |
| `GET /api/token/?p=0&page_size=100` | User | `data` 是分页对象（`items`/`total`/`page`/`page_size`，不同版本可能是数组）；每项含 `id`、`name`、`key`（**掩码**）、`group`、`status`、`expired_time`、`remain_quota`、`unlimited_quota`、`model_limits_enabled`、`model_limits`、`allow_ips`、`auto_groups`（部分版本）。 |
| `GET /api/token/:id` | User | 单个 token（仍是掩码）。 |
| `POST /api/token/:id/key` | User + `api_key:reveal` scope（可能有审计） | `data.key` = 完整 key。 |
| `POST /api/token/batch/keys` | User + `api_key:reveal` | body `{ids:[...]}`；`data.keys = { "<id>": "sk-..." }`。 |
| `POST /api/token/` | User + `api_key:edit` scope | 创建 token；`AddToken` **只返回 `{success:true,message:""}`**，不返回 id/key。创建后需再 list + reveal。 |

**掩码规则**（`model/token.go`）：`len<=4` 全 `*`；`len<=8` 前 2 + `****` + 后 2；否则前 4 + `**********` + 后 4。所以“分组 key 可能是加密的”在实际上就是**列表接口返回掩码**。

#### 2.3.4 签到（实站验证：两种布局）

| 接口 | 鉴权 | 返回/用途 |
| --- | --- | --- |
| `GET /api/user/self/checkin?month=YYYY-MM` | User | `data.enabled`、`data.min_quota`、`data.max_quota`、`data.stats.checked_in_today`、`data.stats.records`、`total_checkins`、`total_quota`、`checkin_count`。**新版本有，`v1.0.0-rc.46` 没有（404）。** |
| `POST /api/user/self/checkin` | User + `wallet:edit`（部分版本）+ Turnstile（若站点开启） | 成功：`{success:true,message:"Check-in successful",data:{quota_awarded,checkin_date}}`。**同上，旧版本 404。** |
| `GET /api/user/checkin` | User | 旧布局的状态：`data.enabled`、`data.stats.checked_in_today`、`data.stats.records`、`data.stats.checkin_count`。**`v1.0.0-rc.46` 只有这个。** |
| `POST /api/user/checkin` | User + Turnstile（若站点开启） | 旧布局的签到：成功 `data.reward`；Turnstile 开启时 `{success:false,message:"Turnstile token is empty"}`。 |

**实测（一个 `v1.0.0-rc.46` 站点）**：

- `GET /api/user/self/checkin` → **404** `Invalid URL`；
- `GET /api/user/checkin` → **200**，`checked_in_today: true`，`records[0].quota_awarded` 有值；
- `POST /api/user/self/checkin` → **404**；
- `POST /api/user/checkin` → **200** `{success:false, message:"Turnstile token is empty"}`。

所以插件必须**两个布局都支持**，并且把 `turnstile_check` 当作站点开关：开启时直接 `captcha`，不发注定失败的 POST。

**错误信封**：NewAPI 的 `common.ApiError` 默认 **HTTP 200 + `{success:false, message}`**（不是 4xx）。所以不能只看 HTTP 状态码，必须解析 `success`/`message`。401/403 才是 HTTP 状态错误。

**访问令牌（access token）与用户 id**：

- 老版本/部分 fork：`Authorization: Bearer <access token>`，还需要 `New-Api-User: <userId>`。
- 新版本：从 token 解析用户，不需要 `New-Api-User`；但发这个头通常无害。
- 新版本的 access token 可能是 **PAT**，带 scope：`profile:view`、`api_key:view`、`api_key:reveal`、`wallet:view`、`wallet:edit` 等。scope 不足会 403；插件要给出明确错误。
- 这与推理用的 `sk-...` API key 是两种东西：access token 只用于管理接口，绝不能发给推理接口。

---

## 3. 需求设计与关键决策

### 3.1 实体映射

| NewAPI 概念 | Magpie 概念 | 说明 |
| --- | --- | --- |
| 站点（baseURL + access token + 可选 user id） | 插件账号（provider `newapi` 的一个 account） | 一个站点一个账号；余额/签到/模型发现都按账号。 |
| 用户分组（`default`、`vip`、`svip`、`auto`） | 模型 ID 的命名空间 | `<siteLabel>/<group>/<model>`；不建独立账号。 |
| 分组 key（`sk-...`） | 账号 metadata 里的 `groupKeys` | 不进 Magpie 的 key 池；由插件 fetch 按分组选。 |
| 模型 + 支持的端点 | Magpie 模型条目 | 每个条目独立 `api.npm`/`api.url`/`api.id`；显示名 `<model> · <siteLabel> · <group> · ×<ratio> · <proto>`。 |
| access token | 账号的 `key` + `metadata` | `key` 用于账号身份；fetch 不把它发到推理接口。 |
| 余额/已用/请求数 | `auth.usage` 的窗口 | 用 `balance`（钱包）+ `display`（文本）。 |
| 每日签到 | `auth.checkin` | 映射 NewAPI 的 `success`/message。 |

### 3.2 Provider / Account 决策（最重要的架构选择）

**推荐：一个 provider `newapi` + 每站点一个账号。**

原因：

- Magpie 插件的 `auth.provider` 在模块加载时静态确定；不能因为用户登录了一个新站点就动态新增一个 provider。
- 一个账号一个站点，余额/签到天然按站点各一次，不会出现“每个分组账号都显示同一个站点余额”的重复卡片。
- 多站点通过 Magpie 的多账号支持自然扩展；账号名用 `accountId = "<host> (<username>)"` 区分。
- 模型 ID 带 `<siteLabel>`，跨站点不会冲突。

代价：

- 所有站点的模型都挂在同一个 `newapi` 供应商下；Provider 卡片名只能叫 “New API”，站点信息在账号行和模型 ID 里。
- 如果用户确实想要“每站点一个 Provider 卡片”，只能：
  1. 给每个站点装一份插件副本，并在插件加载时读取各自的本地配置来生成不同的 provider id（复杂、不是标准用法）；或
  2. 等 Magpie 未来支持动态 provider；或
  3. 用 Magpie 的 custom provider 手工加站点（但就没有分组/多端点/签到的插件能力）。
  建议 v1 不做，文档里说明。

**账号命名**：

- `metadata.email = metadata.accountId = \`${siteLabel} (${username || userId || "user"})\``
  - `whoOf()` 读 `metadata.email`，`settle()` 用它（或密钥）去重；API key 方式不会保存顶层 `accountId`。
  - `metadata.accountId` 同时保留，供插件自己的逻辑使用。
- `settle()` 会按 `whoOf`（这里是 `metadata.email`）或密钥去重：CLI 的 `magpie plugin login newapi` 即使每次都传 `NewAccount`，只要标识相同，也会替换旧账号，不会生成重复账号。**所以标识必须稳定**（站点 + 用户），不能带时间戳。
- 账号 `key` 用 access token；`hint` 会显示 token 尾部。如果不想显示，可以把 `key` 设为 `"newapi:<siteLabel>"`，把 access token 只放 metadata；但这样 `settle()` 的密钥兜底会失效，只剩 `metadata.email` 匹配。两种都可，建议 v1 保留 `key = accessToken`，行为更接近标准 OpenCode 插件。

### 3.3 模型命名与重名模型

**Catalog ID（Magpie 侧模型 ID）**：

```
<siteLabel>/<group>/<model>
```

例如：

```
newapi/example.com/default/gpt-4o
newapi/example.com/vip/gpt-4o
newapi/example.com/vip/gpt-5
```

- 同一个 `gpt-4o` 在 `default` 和 `vip` 下是两个独立模型，agent 看到两个选择，价格/可用性不同。
- `<siteLabel>` 默认是 host（去掉 `https://`、路径、末尾 `/`）；允许用户在登录时覆盖（例如 `example`、`example@alice`）。
- 同一 host 有多个 NewAPI 用户时，默认 host 会冲突；用 `siteLabel=host@username`，或让插件在发现同 host 已有账号时自动加 `@username`。
- 模型 ID 里可以继续有 `/`，Magpie 只按第一个 `/` 拆 provider；已验证（`strings.Cut(model, "/")`）。
- 如果 group/model 里有空格等字符，catalog ID 仍是一个字符串；为可读性可以把空白替换为 `-`，但 `api.id` 保留原始值。v1 建议原样，少做变换。

**显示名**：

```
<model> · <group>
<model> · <group> · ×<ratio>   // ratio 来自 /api/pricing 的 group_ratio
```

**api.id（发给上游的 model 占位）**：

因为一个账号里所有分组共用同一个 base URL，插件 fetch 必须知道“这个请求属于哪个分组”。最稳的做法是把分组编码进 `api.id`，让 Magpie 把它写进请求体（或 Gemini 的路径），插件再解出来并替换成真正的上游 model：

```js
// api.id = encodeURIComponent(JSON.stringify([group, model]))
// 这样即使 group/model 里有 /、:、空格、引号，也不会破坏 Gemini 的 URL 路径
const apiId = encodeURIComponent(JSON.stringify([group, model]));

function splitApiId(id) {
  let s = id;
  // 容忍 URL 客户端把 %5B 再编码成 %255B 的情况
  for (let i = 0; i < 3; i++) {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") {
        return { group: v[0], model: v[1] };
      }
    } catch {}
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  return null;
}
```

- Chat/Responses/Anthropic：Magpie 会把 body 的 `model` 改成 `%5B%22vip%22%2C%22gpt-4o%22%5D` 这个字符串；插件 `decodeURIComponent` + `JSON.parse` 后替换成 `gpt-4o` 再发。
- Gemini CodeAssist：`api.id` 会出现在 URL 路径 `/models/<api.id>:streamGenerateContent`；插件解码路径段、解析、替换。因为整个值已经 percent-encode，路径里不会出现额外的 `/` 或 `:`。
- 用 JSON 数组而不是 `group::model` 是为了避免 group/model 里出现分隔符导致歧义；percent-encode 是为了 Gemini 路径安全。

### 3.4 多端点（Chat / Responses / Anthropic / Gemini）

#### 3.4.1 协议映射

| `supported_endpoint_types` | Magpie `api.npm` | Magpie 协议 | `api.url` |
| --- | --- | --- | --- |
| `openai` | `@ai-sdk/openai-compatible` | Chat | `<base>/v1` |
| `openai_response` | `@ai-sdk/openai` | Responses | `<base>/v1` |
| `anthropic` | `@ai-sdk/anthropic` | Anthropic | `<base>/v1` |
| `gemini` | `@ai-sdk/google` | CodeAssist（Gemini generateContent） | `<base>/v1beta` |
| `embeddings` / `image_generation` / `openai_video` / `jina_rerank` / `*_search` | — | v1 跳过 | — |

注意：Magpie 的 `@ai-sdk/google` 走 `CodeAssist`，`pluginFetch` 会把它转成 `<base>/models/<model>:streamGenerateContent?alt=sse`，与 NewAPI 的原生 Gemini 端点一致。**这是唯一需要实测的协议**；如果某站点返回的 Gemini SSE 与 Magpie 的解析不兼容，fallback 到该模型的 `openai` 端点（NewAPI 通常也提供）。

#### 3.4.2 单模型多端点

一个 Magpie 模型只能声明一种 `api.npm`。分两种情况：

- **默认（`exposeAllProtocols=false`）**：每个模型只列一个条目，按偏好选一种协议。Magpie 会把任何客户端协议翻译成这一种，所以 agent 不需要关心。
- **可选（`exposeAllProtocols=true`）**：对支持多种端点的模型，额外列出变体：

```
newapi/example.com/vip/gpt-5          → Responses（默认，无后缀）
newapi/example.com/vip/gpt-5@chat     → Chat
newapi/example.com/vip/claude-x       → Anthropic（默认，无后缀）
newapi/example.com/vip/claude-x@chat  → Chat
newapi/example.com/vip/gemini-x       → Chat（默认，无后缀）
newapi/example.com/vip/gemini-x@gemini→ Gemini
```

第一个协议永远不带后缀，所以打开 `exposeAllProtocols` 不会让已保存的模型选择失效。

变体的 `api.id` 相同（都是同一个编码后的 `[group, model]`），只是 `api.npm` 不同；fetch 不关心协议，只按 URL 判断认证头。这样喜欢原生协议的用户可以显式选择，默认用户只看到一份。

#### 3.4.3 协议偏好算法

```js
function chooseProtocols(endpoints, model, settings) {
  const has = (x) => endpoints.includes(x);
  const out = [];
  const claude = /^(claude|anthropic)[-/]?/i.test(model);
  const gpt5 = /^(gpt-5|codex|o[1-9])/i.test(model);

  // 1) Claude 且支持 Anthropic：优先原生，保留 cache_control/thinking
  if (settings.preferAnthropic && claude && has("anthropic")) out.push("anthropic");
  // 2) GPT-5/Codex/o 系且支持 Responses：优先 Responses
  if (settings.preferResponses && gpt5 && has("openai_response")) out.push("responses");
  // 3) Chat 最通用
  if (has("openai")) out.push("chat");
  // 4) 其余按 Responses > Anthropic > Gemini
  if (has("openai_response")) out.push("responses");
  if (has("anthropic")) out.push("anthropic");
  if (has("gemini")) out.push("gemini");

  if (out.length === 0) out.push("chat"); // 端点信息缺失时的保守选择
  return settings.exposeAllProtocols ? unique(out) : unique(out).slice(0, 1);
}
```

偏好开关（布尔）：

- `preferAnthropic`（默认 true）：Claude 类模型支持 anthropic 时优先原生。
- `preferResponses`（默认 true）：GPT-5/Codex/o 系支持 responses 时优先 Responses。
- 其余模型优先 Chat，因为 NewAPI 对 OpenAI 格式的兼容最广。

用户也可以在 Magpie 的模型编辑器里改 API，但插件模型的协议以 `api.npm` 为准；如果你想要显式多协议，用 `exposeAllProtocols`。

### 3.5 分组 key 生命周期

> **实现补充：分组会变，所以同步不只在登录时发生。** `src/sync.mjs` 的 `syncAccount()` 在每次读用量（10 分钟节流，8 秒预算）和每次签到（强制）时运行：读站点分组、读 token 列表并为缺 key 的分组 reveal、用 `/v1/models` 校验现有 key、按需创建 token，把结果写回账号 metadata（`client.auth.set`）。已登录的账号因此不需要重登就能跟上新增分组；被吊销的 key 记为 `keyProblems[group]`，在用量卡片上显示为 **Refused keys**。

**为什么列模型不参与**：Magpie 给 `provider.models` 的超时是 20 秒（`internal/gui/providers.go:2033`），而且它和别的供应商共用一个列表请求。在那里做同步会让一个大站点必然超时（`context deadline exceeded`）。同步只放在有自己预算的钩子里：`auth.usage`（8 秒预算，内部再和 8 秒的请求超时竞争）和 `auth.checkin`（每天一次，强制）。

#### 3.5.1 发现

1. `GET /api/token/?p=0&page_size=100` 拿 token 列表。
2. 每个 token 的 `group`：
   - 空 → 用户当前分组（`/api/user/self` 的 `group`）；
   - `auto` → 该 token 的 `auto_groups`（或 `/api/pricing` 的 `auto_groups`）；
   - 其他 → 该分组。
3. 过滤：`status === 1`、`expired_time === -1` 或未过期、`unlimited_quota` 或 `remain_quota > 0`。
4. 每个分组保留多个 key（按优先级排序），用于轮换/故障切换。
5. 如果 `/api/user/self/groups` 不可用（403/旧版本），用 token 列表里的 `group` 和 `/api/pricing` 的 `usable_group` 兜底；再不行就用 `groupKeys` 的 key。

#### 3.5.2 取回完整 key

按顺序尝试：

1. `POST /api/token/batch/keys` body `{ids:[...]}`（一次最多 100）。
2. `POST /api/token/:id/key`（逐个）。
3. 如果返回 403/401：说明没有 `api_key:reveal` scope，或站点要求安全验证；进入手动回填。
4. 如果返回的 key 含 `*`/`•`：仍是掩码，进入手动回填。

#### 3.5.3 手动回填

登录 method 增加一个可选 `text` prompt：

```
groupKeys: "vip=sk-xxx;default=sk-yyy"
```

- 分隔符：换行、英文逗号、分号都接受；每项按第一个 `=` 分割；空行和 `#` 注释忽略。
- 也接受 JSON：`{"vip":"sk-xxx","default":"sk-yyy"}`。
- 回填 key 的 group 标签由用户给出；不强制通过 API 验证（避免登录时 N 个请求），但会在 `provider.models` 里用 `/v1/models` 验证；无效 key 标记为 bad。
- 如果用户回填的 key 与 token 列表里的某个 token 匹配（无法直接匹配，因为列表是掩码），只按用户标签使用。

#### 3.5.4 自动创建（可选）

Provider option `autoCreateKeys`（默认 **false**，`confirm` 明确提示会在站点上创建 token）：

1. 对没有 key 的分组 `POST /api/token/`：
   ```json
   {
     "name": "magpie-<siteLabel>-<group>-<timestamp>",
     "unlimited_quota": true,
     "expired_time": -1,
     "remain_quota": 0,
     "allow_ips": "",
     "model_limits_enabled": false,
     "model_limits": "",
     "group": "<group>"
   }
   ```
2. `AddToken` 不返回 id/key；再 `GET /api/token/` 按 name 找到新 token 的 id。
3. 用 `batch/keys` 或 `:id/key` reveal。
4. reveal 失败 → 仍然进入手动回填，并在用量卡片提示。

注意：自动创建是**写操作**，可能受 token 数量上限、站点策略、scope 限制；失败不能阻塞登录。

#### 3.5.5 校验

- 每个 key 用 `GET /v1/models`（Authorization: Bearer key）验证：
  - 200 → 有效，顺便拿到该分组的模型列表；
  - 401/403 → 标记 `badKeys`，跳过该 key；
  - 429/5xx → 暂时跳过，不标记坏 key（下次再试）。
- 不发送会扣费的推理请求。

#### 3.5.6 存储与重登合并

- **主存储**：账号 `metadata.groupKeys = { "<group>": ["sk-...", ...] }`。`client.auth.set` 可更新。
- **合并缓存**：`<directory>/newapi-keys.json`，key 为 `<baseURL>|<userId||username>`，内容 `{ groupKeys, updatedAt }`，文件权限 0600。
  - `authorize` 时先读缓存，和本次发现/回填的 key 合并；
  - 合并结果写回 metadata 和缓存；
  - 重登时即使 Magpie 替换了账号 auth，缓存里的旧 key 不会丢。
  - 缓存不是 source of truth；丢了只会导致需要重新回填，不影响已保存的 metadata。
- 不要把 key 写进日志、错误消息或用量 `display`。

### 3.6 请求转发（fetch）

`loader.getAuth()` 拿当前账号 metadata；每个请求：

1. **判断目标**：
   - URL 路径含 `/models/<seg>:streamGenerateContent` / `:generateContent` / `:countTokens` → Gemini；`<seg>` URL 解码后是 `api.id`。
   - 否则读 body JSON 的 `model` 字段 → `api.id`。
   - 如果都不是（例如 `/v1/models`），用默认分组/第一个 key，不改写。
2. **拆 `api.id`** → `{group, model}`；找不到 group 则用账号的默认分组（`self.group`）或第一个有 key 的分组。
3. **选 key**：
   - 该分组有多个 key 时，优先未标记 bad、未过期、有余额、`model_limits` 允许该 model 的；
   - 轮询索引（模块级 Map，按 group 记录）。
4. **改请求**：
   - body 协议：`JSON.parse` → `model = <bare model>` → `JSON.stringify`；
   - Gemini：替换 URL 路径里的 `<seg>` 为 `encodeURIComponent(model)`；
   - 删除 `content-length`、`content-encoding`（body 长度变了）。
5. **认证头**：
   - 删除 `authorization`、`x-api-key`、`x-goog-api-key`（Magpie 默认会塞 access token 或占位符）；
   - Chat/Responses：`Authorization: Bearer <group key>`；
   - Anthropic（路径 `/messages` 或 `/messages/count_tokens`）：`x-api-key: <group key>`；
   - Gemini（`/v1beta/` 或 `:streamGenerateContent`）：`x-goog-api-key: <group key>`；
   - 如果 metadata 有 `userId`，加 `New-Api-User: <userId>`（标准 NewAPI 忽略，fork 需要）。
6. **发送**：`return fetch(url, {...init, headers, body})`；**成功响应不要读 body**，直接返回，保持流式。
7. **失败**：
   - 401/403：该 key 可能失效；尝试同组下一个 key；如果全部失败，返回最后一个响应，并加 `X-Magpie-Sign-In: kept`，避免 Magpie 把整个站点账号标记为失效（分组 key 失效 ≠ access token 失效）。
   - 429：尝试下一个 key；全失败则返回 429，让 Magpie 走路由 failover。
   - 5xx：可尝试一次下一个 key；仍失败则原样返回。
   - 读错误 body 后再重试（`await res.arrayBuffer()`），避免连接泄漏。
8. **无 key**：返回 400/503 JSON 错误，消息里写清“group X 没有 key，请在登录时回填”，并加 `X-Magpie-Sign-In: kept`。

`loader` 返回 `apiKey: "magpie-newapi"` 占位，防止 `options()` 把 access token 作为默认 `Authorization` 发出去；fetch 会覆盖。`baseURL` 不设置（让模型的 `api.url` 生效）。

### 3.7 余额与用量

#### 3.7.1 数据

- `GET /api/status`（登录时缓存）：
  - `quota_per_unit`（默认 500000；不是所有版本都有，缺失用 500000）
  - `display_in_currency` / `quota_display_type`
  - `custom_currency_symbol` / `usd_exchange_rate`
  - `checkin_enabled`、`turnstile_check`
- `GET /api/user/self`：
  - `data.quota`（剩余 quota）
  - `data.used_quota`（已用）
  - `data.request_count`
  - `data.group`（用户默认分组）
  - `data.username`

换算：

```
balance = quota / quota_per_unit
used    = used_quota / quota_per_unit
```

如果 `display_in_currency=false`，直接显示 quota 数字，单位用 `quota`（或站点自定义“积分”）。

#### 3.7.2 usage 窗口

```js
windows = [
  {
    name: "Balance",
    balance: 12.34,
    unit: "$",
    display: "$12.34 left",
  },
  {
    // 不带 used：带 used 的窗口会被 Magpie 当成比例，0 会画成 0% 进度条
    name: "Used",
    display: "$2.00 used · 1,234 requests",
  },
  {
    name: "Groups",
    display: "default ×1, vip ×0.8, svip ×0.6",
  },
  // 仅在有关键缺失时出现
  {
    name: "Missing keys",
    display: "svip — sign in again to add them",
  },
];
```

- `balance` 窗口让 Magpie 把账号当作预付钱包，路由时按余额排序（同单位）。
- `display` 文本窗口用于“已用/请求数/分组/缺 key”。
- `plan` 用 `data.group`；`user` 用 `data.username`。
- 如果 `display_in_currency=false`，`balance` 用 raw quota，`unit="quota"`，`display="12,345,678 quota left"`。
- 缓存 30–60 秒，避免 Usage 页/托盘频繁请求。
- access token 401/403：返回 `{ error: "...", signIn: "kept" }`，不要因为余额查询失败就把整个站点账号标记失效（分组 key 仍可用于推理）。如果模型列表也拿不到，再考虑标记。

### 3.8 签到

#### 3.8.0 每账号签到开关（重要）

有些 NewAPI 站点在签到接口上加了 **Cloudflare Turnstile 或托管质询**。这种站点即使 access token 有效，也无法自动签到：质询需要浏览器里完成，插件不能也不应该绕过。

因此签到有三层开关：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 插件登录选项 | 登录时 `checkin` 选择 `Auto` / `Off` | 站点级默认；`Off` 时 `auth.checkin` 直接返回 `inactive`，不发起任何请求。 |
| 自动检测 | `metadata.checkinBlocked = "cf"` / `"turnstile"` | 遇到 Cloudflare 质询或 Turnstile 时自动标记；之后 `auth.checkin` 直接返回 `captcha`，不再浪费请求。重新登录选 `Auto` 会清除标记。 |
| Magpie 自己的开关 | Settings → Usage → Plugins → 每账号 Daily check-in | Magpie 的最终闸门（`settings.PluginCheckins` / `settings.CheckinOff`）；关掉后根本不会调用插件的 `auth.checkin`。 |

三者的关系：Magpie 开关关 → 不调用；插件 `checkin=off` → 调用但立即 `inactive`；自动检测到 CF → 调用但立即 `captcha`。用户可按站点、按账号任意组合。

`auth.checkin` 的返回：

| 情况 | outcome | message |
| --- | --- | --- |
| `checkin=off` | `inactive` | "Auto check-in is off for this site. Check in on the site itself." |
| 已标记 CF | `captcha` | "This site requires a Cloudflare challenge. Check in on its website." |
| 已标记 Turnstile | `captcha` | "This site asks for a captcha. Check in on its website." |
| 站点 `turnstile_check=true` | `captcha` + 标记 | "This site asks for a captcha. Check in on its website." |
| 站点未开启签到 | `inactive` | "Check-in is not enabled on this site" |
| 今天已签 | `done` | "Already checked in today" + credit |
| 签到成功 | `claimed` | "Checked in: +$0.004" + credit |
| 其他失败 | `failed` | 站点原话（截断） |

**Cloudflare 检测**（只用于签到，不影响推理）：

- 响应头 `cf-mitigated: challenge`；
- HTTP 403 + `Server: cloudflare`；
- `Content-Type: text/html` 且正文包含 `Just a moment...`、`cf-challenge`、`cdn-cgi/challenge-platform`、`Attention Required`、`__cf_chl_`；
- NewAPI 的 JSON `{success:false, message}` 里包含 `Turnstile token is empty`、`Turnstile verification failed`、`captcha`。

检测到后：
1. 返回 `captcha`（Magpie 会显示“在供应商自己的应用里签到”，当天不再重试）；
2. best-effort 把 `metadata.checkinBlocked` 写回账号（`client.auth.set`），下次直接短路；
3. 在用量卡片里显示 "Auto check-in blocked by Cloudflare; check in on the site"；
4. 重新登录时 `checkin=Auto` 清除标记；或用户在 Magpie 的设置里直接关掉这个账号的签到。

**不要**尝试：
- 解析/绕过 Turnstile；
- 自动打开浏览器；
- 用 headless browser 过 CF；
- 伪造 `cf_clearance`。

#### 3.8.1 实现

```js
async checkin(getAuth) {
  const auth = await getAuth();
  const md = auth?.metadata ?? {};
  if (md.checkin === "off") {
    return { outcome: "inactive", message: "Auto check-in is off for this site. Check in on the site itself." };
  }
  if (md.checkinBlocked === "cf" || md.checkinBlocked === "turnstile") {
    return { outcome: "captcha", message: "This site requires a captcha. Check in on its website." };
  }
  if (md.status?.turnstile) {
    await markBlocked(client, auth, md, "turnstile");
    return { outcome: "captcha", message: "This site asks for a captcha. Check in on its website." };
  }
  // GET status → enabled / checked_in_today
  // POST → success / already / not enabled / captcha / cf
}
```

```js
async function markBlocked(client, auth, md, kind) {
  if (md.checkinBlocked === kind) return;
  const next = {
    ...auth,
    metadata: { ...md, checkinBlocked: kind, checkinBlockedAt: new Date().toISOString() },
  };
  try {
    await client?.auth?.set?.({ path: { id: PROVIDER }, body: next });
  } catch {
    // 写不回也不影响本次结果；下次还会重新检测
  }
}
```

`auth.checkin(getAuth)` 在账号作用域内运行，`client.auth.set({path:{id}})` 会写到当前账号，不会影响其他站点。

#### 3.8.2 签到流程

- `convert(q)`：货币显示时 `q / quota_per_unit`，否则 raw quota；`credit` 是数字，消息里带单位。
- 旧版本 fallback：`GET /api/user/self/checkin` 404 → `POST /api/user/checkin`；成功字段可能是 `data.reward`。
- 站点签到日按**服务器本地时间**，Magpie 按北京日调度。v1 不返回 `until`（无法可靠知道站点时区），依赖 Magpie 的“中午前 done 视为 provisional，30 分钟后再问”的逻辑。文档里说明这个偏差。
- 签到失败不会重置账号/额度；Magpie 会在 30 分钟后重试。

### 3.9 登录提示与 Provider 选项

**登录 method**（`type: "api"`）：

登录用 **`ask(inputs)` 动态提问**（Magpie 自己的钩子），不是静态 `prompts` 列表：前面的答案用于查询站点，后面的问题据此生成。

| 顺序 | key | 类型 | 说明 |
| --- | --- | --- | --- |
| 0 | `pick` | select | 已有账号时先问：列出 `plugin-auth.json` 里本插件的账号（`<accountId> — <host>`，带分组数与签到状态），末项 `__new__` 表示新站点。选中即由 `resolvePick()` 填出 base/token/userId/label，**不需要重新输入 access token**（Magpie 的 `input.directory` 就是 `settings.Dir()`，`plugin-auth.json` 就在那里）。 |
| 1 | `baseURL` | text | 只有 `pick=__new__` 时问。`https://example.com`、`.../v1` 都可以；插件归一化。 |
| 2 | `accessToken` | password | NewAPI 的“系统访问令牌”/PAT；不是 `sk-...` 推理 key。**只问这一次**（方法声明 `keyless: true`，否则 Magpie 会在问题之后再弹一个 API key 框）。 |
| 3 | `userId` | text | 老版本/AnyRouter 需要；新版本留空。 |
| 4 | `siteLabel` | text | 模型命名空间前缀；默认 host。 |
| 5 | `groupFilter` | text | **仅在站点有 7 个以上分组时**才问。 |
| 6 | `autoCreate` | select | 有分组缺 key 时先问是否让站点创建。选 Yes 就建 token 并自动 reveal。 |
| 7 | `createdKeys` | select | 创建步骤的结果（JSON），一次问完；选它即继续。 |
| 8… | `groupkey:<group>` | password | 只有创建不出来（或第 6 步选 No）才问，每个分组一个输入框。已读到或刚建好的 key 不再问。 |
| 9 | `checkin` | select | `Auto`（默认）/ `Off`。 |

顺序是先创建、后手填：站点能给的 key 不让人手打。

`ask` 每问一次都会重新判断，所以“已回答”的分组不会重复问。中间结果用 60 秒的 `survey` 缓存，避免每问一次都重读六个端点。

**Provider options**（布尔）：

| key | 默认 | 说明 |
| --- | --- | --- |
| `auto-create-keys` | false | 缺 key 时自动在站点创建 token；`confirm` 提示写操作。 |
| `expose-all-protocols` | false | 对多端点模型列出所有协议变体。 |
| `prefer-responses` | true | GPT-5/Codex/o 系优先 Responses。 |
| `prefer-anthropic` | true | Claude 类模型优先 Anthropic。 |

> 选项 key 必须匹配 host.js 的 `^[a-z0-9_-]{1,40}$`；驼峰 key 会被 `optionsOf` 静默丢弃。

**其他**：

- `auth.icon`：可留空，或用通用 NewAPI logo 的 data URI；站点自己的 logo 在 `/api/status` 的 `logo` 字段，但 provider icon 是静态的，不能按账号变。
- `auth.maxConcurrency`：建议 8（可被用户在 Magpie 里覆盖）。
- `auth.single`：不设置（允许多站点账号）。
- `auth.refresh`：不需要；NewAPI access token 长期有效。如果未来支持 PAT 过期，可加。

---

## 4. 插件接口契约（代码骨架）

### 4.1 package.json

```json
{
  "name": "opencode-newapi-auth",
  "version": "0.1.0",
  "description": "OpenCode provider plugin for New API (NewAPI) aggregators",
  "type": "module",
  "main": "./index.mjs",
  "files": ["index.mjs", "README.md"],
  "keywords": ["opencode", "opencode-plugin", "newapi", "new-api", "magpie"],
  "license": "MIT",
  "magpie": { "maxConcurrency": 8 }
}
```

如果要进 magpie-community：包名改为 `@magpie-community/opencode-newapi-auth`，放在 `packages/newapi`。

### 4.2 config 钩子

```js
const PROVIDER = "newapi";

config: async (cfg) => {
  cfg.provider ??= {};
  cfg.provider[PROVIDER] ??= {
    name: "New API",
    npm: "@ai-sdk/openai-compatible",
    api: "",
    models: {}, // 模型由 provider.models 动态给出
  };
},
```

### 4.3 auth 钩子（骨架）

```js
auth: {
  provider: PROVIDER,
  methods: [
    {
      type: "api",
      label: "New API access token",
      placeholder: "系统访问令牌，不是 sk-...",
      prompts: [
        { type: "text", key: "baseURL", message: "New API base URL", placeholder: "https://newapi.example.com", validate: validateURL },
        { type: "password", key: "accessToken", message: "Access token", placeholder: "系统访问令牌" },
        { type: "text", key: "userId", message: "User id (old NewAPI; optional)", placeholder: "1" },
        { type: "text", key: "siteLabel", message: "Site label (model prefix; optional)", placeholder: "example.com" },
        { type: "text", key: "groupFilter", message: "Only these groups (comma separated; empty = all)", placeholder: "default,vip" },
        { type: "text", key: "groupKeys", message: "Group keys (optional; group=sk-...; ...)", placeholder: "vip=sk-...;default=sk-..." },
        {
          type: "select",
          key: "checkin",
          message: "Daily check-in",
          options: [
            { label: "Auto", value: "auto" },
            { label: "Off (manual check-in on the site)", value: "off" },
          ],
        },
        {
          type: "select",
          key: "autoCreate",
          message: "Create missing group keys on this site?",
          options: [
            { label: "No, I'll paste keys", value: "no" },
            { label: "Yes, create tokens for missing groups", value: "yes" },
          ],
        },
      ],
      async authorize(inputs) {
        return signIn(inputs); // 见 §4.4
      },
    },
  ],
  options: [
    { key: "auto-create-keys", label: "Create missing group keys", description: "Create an API token on the New API site for each group Magpie uses.", default: false, confirm: "This creates API tokens on your New API site." },
    { key: "expose-all-protocols", label: "Expose every supported protocol", description: "List a chat/responses/messages/gemini variant for each model that supports it.", default: false },
    { key: "prefer-responses", label: "Prefer Responses for GPT-5/Codex", default: true },
    { key: "prefer-anthropic", label: "Prefer Messages for Claude models", default: true },
  ],
  loader: makeLoader,
  usage: readUsage,
  checkin: doCheckin,
},
provider: {
  id: PROVIDER,
  async models(provider, { auth }) {
    // provider 是 host 传进来的 provider info（含它已有的 models）；
    // 返回 OpenCode Model，必须带 api: { id, url, npm }
    return listModels(provider, auth);
  },
},
```

### 4.4 authorize 骨架

```js
async function signIn(inputs) {
  const base = normalizeBase(inputs.baseURL);
  const token = String(inputs.accessToken ?? "").trim();
  const userId = String(inputs.userId ?? "").trim();
  if (!base || !token) return { type: "failed", error: "Base URL and access token are required." };

  let status;
  try {
    status = await getStatus(base);
  } catch {
    // 站点状态拿不到不阻塞：余额/货币显示会退化，推理仍可工作
  }
  let self;
  try {
    self = await getUserSelf(base, token, userId || undefined);
  } catch (e) {
    if (e?.status === 401) return { type: "failed", error: loginError(e) }; // token 无效/需要 New-Api-User
    // 403（PAT 缺 profile:view）或网络错误：降级，只要分组 key 能推理就允许登录
    self = { id: userId || undefined, username: "", group: "" };
  }

  const siteLabel = cleanLabel(inputs.siteLabel) || hostOf(base);
  const accountId = `${siteLabel} (${self.username || self.id || "user"})`;

  // 管理接口失败不阻塞：能拿到 key 就能推理
  const groups = await safeGetGroups(base, token, userId || undefined);
  const pricing = await safeGetPricing(base, token, userId || undefined);
  const tokens = await safeListTokens(base, token, userId || undefined);
  const revealed = await safeRevealKeys(base, tokens, token, userId || undefined);

  const manual = parseGroupKeys(inputs.groupKeys);
  const cached = readKeyCache(base, self.id || self.username);
  const groupKeys = mergeKeys(cached, revealed, manual); // 数组值
  const pending = diffGroups(groups, groupKeys);

  // 可选自动创建（首次登录用 prompt 选择；后续刷新用 provider 选项）
  const autoCreate = inputs.autoCreate === "yes" || optionOn("autoCreateKeys");
  if (autoCreate && pending.length) {
    for (const g of pending) {
      const k = await tryCreateAndReveal(base, token, userId, siteLabel, g);
      if (k) groupKeys[g] = [k];
    }
  }

  if (!Object.keys(groupKeys).length) {
    return {
      type: "failed",
      error:
        "No group keys. Paste them as group=sk-... in the Group keys field, or enable 'Create missing group keys' and sign in again.",
    };
  }

  writeKeyCache(base, self.id || self.username, groupKeys);
  return {
    type: "success",
    key: token,
    metadata: {
      accountId,
      email: accountId, // whoOf()/settle() 读的是 metadata.email；用它做稳定账号标识
      baseURL: base,
      userId: self.id || userId || undefined,
      username: self.username || "",
      siteLabel,
      groupFilter: String(inputs.groupFilter ?? "").trim(), // 只列这些分组
      checkin: inputs.checkin === "off" ? "off" : "auto",
      checkinBlocked: "", // 签到被 CF/Turnstile 拦截时写 "cf"/"turnstile"
      groups,       // { name: {ratio, desc} }
      groupKeys,    // { name: ["sk-..."] }
      pendingGroups: pending,
      status: {
        quotaPerUnit: Number(status?.quota_per_unit) || 500000,
        currency: !!status?.display_in_currency,
        quotaDisplayType: status?.quota_display_type || "",
        currencySymbol: status?.custom_currency_symbol || "",
        checkin: !!status?.checkin_enabled,
        turnstile: !!status?.turnstile_check,
        systemName: status?.system_name || "",
      },
      updatedAt: new Date().toISOString(),
    },
  };
}
```

**注意**：

- 账号稳定标识放在 `metadata.email`（同时放 `metadata.accountId` 供插件自己用）。API key 的 `save()` 只把 `key` 和 `metadata` 写进 auth，返回对象顶层的 `accountId` 不会保存；`whoOf()` 读 `metadata.email`。
- `inputs` 会被自动合并进 metadata，`metadata.groupKeys` 会覆盖原始字符串。
- 管理请求（`/api/user/self`、`/api/token/`、签到）用 `auth.key` 作为 access token；它和 `metadata.accessToken` 通常相同，但 `key` 是权威值。
- `authorize` 的错误最多显示 500 字符，写短、可操作。

### 4.5 provider.models 骨架

```js
async function listModels(provider, auth) {
  const md = auth?.metadata ?? {};
  const base = md.baseURL;
  if (!base) return {};

  const settings = {
    exposeAllProtocols: optionOn("exposeAllProtocols"),
    preferResponses: optionOn("preferResponses"),
    preferAnthropic: optionOn("preferAnthropic"),
  };

  const pricing = await cachedPricing(base, md); // Map<model, {groups:Set, endpoints:[]}>
  const groupRatio = pricing?.groupRatio ?? {};
  const groupKeys = md.groupKeys ?? {};
  const wantedGroups = parseGroupFilter(md.groupFilter); // 登录时的 groupFilter prompt
  const out = {};

  await Promise.allSettled(
    Object.entries(groupKeys).map(async ([group, keys]) => {
      if (wantedGroups.length && !wantedGroups.includes(group)) return;
      // 同组多 key：依次尝试，第一个能列出模型的 key 为准
      let names = [];
      for (const key of keys) {
        try {
          names = await listModelsForKey(base, key, md); // GET /v1/models
          if (names.length) break;
        } catch {
          // key 失效：试下一个；全部失败则该分组本轮跳过
        }
      }
      if (!names.length) return;

      for (const model of names) {
        const info = pricing?.models.get(model);
        // /v1/models 是该 key 的权威列表，不再按 pricing 的 enable_groups 过滤；
        // 只有用 pricing/user/models 推导分组时才需要 enable_groups。
        // 跳过非聊天端点（纯 embeddings/image/video/rerank）
        if (info && info.endpoints.length && !info.endpoints.some(isChatEndpoint)) continue;

        const endpoints = info?.endpoints?.length ? info.endpoints : ["openai"];
        const protos = chooseProtocols(endpoints, model, settings);
        for (const proto of protos) {
          const catalogId = `${md.siteLabel}/${group}/${model}${protoSuffix(proto, protos.length, settings)}`;
          out[catalogId] = modelEntry({
            catalogId, md, group, model, proto, ratio: groupRatio[group],
            baseModel: provider?.models?.[model], // 可选：展开 host 给的默认值
          });
        }
      }
    }),
  );

  return out;
}

function modelEntry({ catalogId, md, group, model, proto, ratio, baseModel }) {
  const apiId = encodeURIComponent(JSON.stringify([group, model]));
  const npm = { chat: "@ai-sdk/openai-compatible", responses: "@ai-sdk/openai", anthropic: "@ai-sdk/anthropic", gemini: "@ai-sdk/google" }[proto];
  const url = proto === "gemini" ? `${md.baseURL}/v1beta` : `${md.baseURL}/v1`;
  return {
    // provider.models 的返回值是 OpenCode Model：用 api，不是 provider
    ...(baseModel ?? {}),
    id: catalogId, // host 随后会用对象 key 覆盖 id；这里写对便于调试
    name: `${model} · ${group}${ratio ? ` · ×${ratio}` : ""}${labelOf(proto)}`,
    api: { id: apiId, url, npm }, // 真正发给上游前会被插件还原成 model
    limit: baseModel?.limit ?? { context: 0, output: 0 },
    capabilities: baseModel?.capabilities ?? {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true },
    },
    cost: baseModel?.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: baseModel?.variants ?? {},
  };
}
```

**模型列表来源优先级**：

1. `/v1/models`（每个分组 key）——权威：这个 key 能调用什么。
2. `/api/pricing`——补充：`enable_groups`（哪些分组可用）、`supported_endpoint_types`（协议）、`group_ratio`（倍率）。
3. `/api/user/models?group=`——当 `/api/pricing` 不可用时，作为分组→模型的来源。
4. 如果都失败：抛出错误（Magpie 保留上次列表并显示 `listError`），而不是返回空列表把模型清空。

**过滤**：

- 只保留至少有一个聊天端点（`openai`/`openai_response`/`anthropic`/`gemini`）的模型；纯 `embeddings`/`image_generation`/`video`/`rerank` 跳过。
- 跳过 `status: deprecated` 的模型（`/api/pricing` 已过滤；`/v1/models` 不会给）。
- 如果 `groupFilter` 登录提示给了过滤列表，只列这些分组。

**性能**：

- 缓存 `/api/pricing` 60 秒；缓存每个 key 的 `/v1/models` 60 秒（key 用 hash 做缓存键，不写日志）。
- 分组多时 `Promise.allSettled` 并发；单次 `provider.models` 控制在 20 秒内。
- 一个模型 × 一个分组 = 一个条目；1000 模型 × 5 分组 = 5000 条，Magpie 能处理但模型选择器会很重；用 `groups` 提示让用户裁剪。

### 4.6 loader / fetch 骨架

```js
function makeLoader(getAuth) {
  return {
    apiKey: "magpie-newapi", // 占位，防止 access token 被默认发送；fetch 会覆盖
    async fetch(input, init) {
      const auth = await getAuth();
      const md = auth?.metadata ?? {};
      const url = new URL(String(input));
      const target = readTarget(url, init?.body); // { group, model } | null

      const group = target?.group || defaultGroup(md);
      const model = target?.model || "";
      const keys = keysFor(md, group, model);
      if (!keys.length) return errorResponse(503, `No API key for group "${group}". Sign in again and paste group=sk-...`);

      let last = null;
      for (const key of keys.slice(0, 2)) {
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        headers.delete("x-api-key");
        headers.delete("x-goog-api-key");
        headers.delete("content-length");
        if (md.userId) headers.set("New-Api-User", String(md.userId));
        applyAuth(headers, url, key);

        let body = init?.body;
        let nextURL = String(input);
        if (target) {
          if (isGeminiPath(url)) {
            nextURL = replaceGeminiModel(nextURL, model);
          } else {
            body = rewriteModel(body, model);
          }
        }

        const res = await fetch(nextURL, { ...init, headers, body });
        if (res.status === 401 || res.status === 403) {
          // 分组 key 失效 ≠ access token 失效：换同组下一个 key，
          // 最后仍失败时给 Magpie 一个 kept，避免整个站点账号被标记失效
          last = res.clone();
          await res.arrayBuffer().catch(() => {});
          markBad(md, group, key);
          continue;
        }
        if (res.status === 429) {
          last = res.clone();
          await res.arrayBuffer().catch(() => {});
          continue;
        }
        return res;
      }

      if (last?.status === 401) return withKept(last);
      return last ?? errorResponse(502, "New API request failed");
    },
  };
}

function readTarget(url, body) {
  const gem = url.pathname.match(/\/models\/([^/:]+):(?:streamGenerateContent|generateContent|countTokens)/);
  if (gem) return splitApiId(gem[1]); // splitApiId 内部 decodeURIComponent
  if (typeof body === "string") {
    try {
      const j = JSON.parse(body);
      if (typeof j?.model === "string") return splitApiId(j.model);
    } catch {}
  }
  return null;
}

function rewriteModel(body, model) {
  if (typeof body !== "string") return body;
  try {
    const j = JSON.parse(body);
    if (j && typeof j === "object" && "model" in j) {
      j.model = model;
      return JSON.stringify(j);
    }
  } catch {}
  return body;
}

function applyAuth(headers, url, key) {
  if (url.pathname.includes("/messages")) headers.set("x-api-key", key);
  else if (url.pathname.includes("/v1beta/") || url.pathname.includes(":streamGenerateContent")) headers.set("x-goog-api-key", key);
  else headers.set("authorization", `Bearer ${key}`);
}

function withKept(res) {
  const headers = new Headers(res.headers);
  headers.set("X-Magpie-Sign-In", "kept");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
```

**注意**：

- 成功响应直接返回，**不要 `await res.text()`**，否则会破坏流式。
- 401 的 `X-Magpie-Sign-In: kept` 只对“分组 key 失效”使用；如果 access token 失效，`usage` 里再决定是否标记。
- `markBad` 更新内存和 metadata；不要每次请求都写文件，可以 30 秒节流。
- `keysFor` 要考虑 `model_limits`：如果 key 的 `model_limits_enabled` 为 true 且 model 不在列表，跳过该 key。
- `api.id` 是 percent-encoded 的 JSON 数组字符串；`splitApiId` 解析失败时按“无分组”处理，用默认分组。
- 对 `/v1/models` 这类无 body 的请求，用默认分组 key；本插件自己的模型发现不走 fetch，所以很少遇到。

### 4.7 usage 骨架

```js
async function readUsage(getAuth) {
  const auth = await getAuth();
  const md = auth?.metadata ?? {};
  const token = auth?.key ?? md.accessToken;
  if (!md.baseURL || !token) return { error: "not signed in" };

  const self = await getUserSelf(md.baseURL, token, md.userId);
  const qpu = md.status?.quotaPerUnit || 500000;
  const currency = !!md.status?.currency;
  const unit = currency ? (md.status?.currencySymbol || "$") : "quota";
  const fmt = (q) => (currency ? `${unit}${(q / qpu).toFixed(2)}` : `${Math.round(q).toLocaleString()} quota`);

  const windows = [
    {
      name: "Balance",
      balance: currency ? self.quota / qpu : self.quota,
      unit,
      display: `${fmt(self.quota)} left`,
    },
    {
      name: "Used",
      used: 0,
      display: `${fmt(self.used_quota)} used · ${Number(self.request_count || 0).toLocaleString()} requests`,
    },
    {
      name: "Groups",
      used: 0,
      display: Object.keys(md.groups ?? {}).join(", ") || Object.keys(md.groupKeys ?? {}).join(", "),
    },
  ];

  if (md.pendingGroups?.length) {
    windows.push({
      name: "Missing keys",
      used: 0,
      display: `${md.pendingGroups.join(", ")} — sign in again with group keys`,
    });
  }

  if (md.checkin === "off") {
    windows.push({ name: "Check-in", used: 0, display: "Auto check-in off · check in on the site" });
  } else if (md.checkinBlocked) {
    windows.push({ name: "Check-in", used: 0, display: "Blocked by Cloudflare · check in on the site" });
  }

  return { plan: self.group || "", user: self.username || "", windows };
}
```

- `balance` 窗口不要写 `used`/`limit`。
- **文本窗口一定不能带 `used`**（包括 `used: 0`）。`quotaOfPlugin` 只在 `used` 缺失时才把它当纯文本；带了 `used: 0` 就是一个真实的 0%，会画进度条、画趋势线，并附上 “Whole: not enough data”。
- 如果 `display_in_currency=false`，`unit="quota"`；`balance` 用 raw quota。
- 对于 access token 401/403：`return { error: "...", signIn: "kept" }`，并让 `provider.models` 走 `/v1/models` fallback。

### 4.8 checkin 骨架

见 §3.8。补充：

- `GET /api/user/self/checkin` 在没有 key 时也能用（只要有 access token）。
- `POST` 的错误是 HTTP 200 + `success:false`，所以 `postCheckin` 要返回 `{success,message,data}`，不要只看 `res.ok`。
- Turnstile 开启时直接 `captcha`，不要 POST。
- Cloudflare 质询/QTurnstile 检测到后，把 `metadata.checkinBlocked` 写回账号，下次直接短路。
- 旧版本 404 → `POST /api/user/checkin`；解析 `data.reward` 或 `message`。
- `checkin=off` 时直接 `inactive`，不发任何请求。

---

## 5. 关键时序

### 5.1 登录（authorize）

```
用户填 baseURL/accessToken/userId/siteLabel/groupFilter/groupKeys
  → GET /api/status                      （缓存，拿 quota_per_unit/checkin/turnstile）
  → GET /api/user/self                   （校验 token；拿 id/username/group/quota）
  → GET /api/user/self/groups            （分组 + ratio/desc；失败不阻塞）
  → GET /api/pricing                     （模型 + enable_groups + endpoints；失败不阻塞）
  → GET /api/token/?p=0&page_size=100    （token 列表，key 掩码）
  → POST /api/token/batch/keys / :id/key （取完整 key；失败不阻塞）
  → 合并：缓存旧 key + reveal key + 手动 groupKeys
  → 可选：autoCreateKeys 对缺失分组创建 token + reveal
  → 至少有一个可用 key？否 → failed（提示回填/自动创建）
  → 写缓存；返回 success + metadata
```

- 这些请求里，`status`、`self`、`groups`、`pricing`、`tokens` 相互独立，可以 `Promise.allSettled` 并行；每个请求加 5–8 秒超时，避免登录卡住。
- key 校验（`/v1/models`）不要放在 `authorize` 里逐个做，放到 `provider.models`，登录更快。

### 5.2 模型刷新（provider.models）

```
读 metadata（baseURL/siteLabel/groupKeys/groups）
  → /api/pricing（缓存 60s）→ model→{groups,endpoints}
  → 对每个有 key 的分组：GET /v1/models（缓存 60s；该 key 的权威列表）
  → 过滤非聊天端点 / 已禁用
  → 对每个模型选协议（可能多个变体）
  → 输出 catalogId → { id: apiId, provider:{npm,api}, name, ... }
```

### 5.3 推理请求（fetch）

```
agent → Magpie 网关 → 翻译成模型的协议
  → pluginFetch：base = model.api.url，body.model = apiId（JSON [group,model]）
  → 插件 loader.fetch：
       解析 group/model → 选 key → 还原 model → 按协议加认证头 → 转发 NewAPI
  → 流式返回
```

### 5.4 余额 / 签到

```
usage:  GET /api/status（缓存）+ /api/user/self → 窗口
checkin: GET /api/user/self/checkin → 已签？done
         → 未开启？inactive
         → Turnstile？captcha
         → POST /api/user/self/checkin → claimed/failed
```

---

## 6. 兼容性矩阵与 fallback

| 能力 | 新版本 | 旧版本/变体 | 插件策略 |
| --- | --- | --- | --- |
| 用户信息 | `GET /api/user/self` | 同 | 主路径；401 时提示 `New-Api-User`。 |
| 分组 | `/api/user/self/groups` | `/api/user/groups`、`/api/user_group_map` | 依次尝试；都失败则从 `groupKeys` 推断。 |
| 模型 | `/api/pricing` + `/v1/models` | `/api/user/models?group=` | pricing 失败时用 user/models；再失败用每 key `/v1/models`。 |
| Token 列表 | `/api/token/?p=0&page_size=100` | `?page=1&size=100` 等 | 同时接受 `p`/`page`/`size`/`page_size`；解析 `data.items` 或 `data` 数组。 |
| 完整 key | `batch/keys` / `:id/key` | 无 | 失败 → 手动回填。 |
| 创建 token | `POST /api/token/` | 同 | 返回不含 key；创建后 list + reveal；reveal 失败 → 手动。 |
| 签到 | `/api/user/self/checkin` | `/api/user/checkin` | 两个都试，记住该站点用的布局；都 404 → inactive/failed。 |
| 签到开关 | `/api/status.checkin_enabled` | 无字段 | 以 GET checkin 的 `data.enabled` 为准；`checkin=off` 时不请求。 |
| 签到质询 | Turnstile / CF | 无 | 检测到 → `captcha` + 标记 `checkinBlocked`；不绕过。 |
| 余额单位 | `/api/status.quota_per_unit` | 无 | 默认 500000（与 Magpie/Octopus 一致）。 |
| 货币显示 | `display_in_currency`/`quota_display_type` | 无 | 无则按 quota 显示。CNY 用 `usd_exchange_rate`（实站 7.3），CUSTOM 用 `custom_currency_exchange_rate`，USD 恒为 1。 |
| Turnstile | `turnstile_check` | 无 | 无字段时仍 POST；若返回 captcha 关键字则 captcha。 |
| 用户 id | 不需要 | 老版本/AnyRouter 需要 | 可选 prompt；发 `New-Api-User`。 |
| Access token | PAT + scope | 系统访问令牌 | 403 时提示所需 scope；不阻塞推理。 |
| 分组 auto | `auto_groups` | 无 | token.group=`auto` 时用 auto_groups；否则按普通分组。 |

---

## 7. 错误处理与安全

### 7.1 错误语义

- **登录失败**：`authorize` 返回 `{type:"failed", error:"..."}`，消息短、可操作（最多 500 字符）。
- **模型列表失败**：抛异常，Magpie 保留上次列表并在 provider 编辑器显示 `listError`；不要返回空表清空模型。
- **单个分组 key 失效**：只标记该 key bad，跳过该分组；不要让整个账号 lapsed。
- **access token 失效**：`usage` 返回 `signIn:"kept"` + error；推理仍可用 group key。只有当所有分组 key 也不可用时，才考虑 `signIn:"expired"`。
- **429**：同组换 key；全失败返回 429，让 Magpie 走路由 failover。
- **5xx**：原样返回（或同组重试一次），让 Magpie 决定是否 failover。
- **没有 key**：返回 4xx/5xx JSON，消息里写清分组名和“重新登录回填”；`X-Magpie-Sign-In: kept`。

### 7.2 安全

- access token、group key **绝不**写入日志、错误消息、模型名、`display` 文本。
- 错误消息里如果上游回显了 key，用掩码替换（前 4 + `***` + 后 4）。
- 插件 fetch 里删除 Magpie 默认的 `authorization`/`x-api-key`/`x-goog-api-key`，确保 access token 不会被发到推理接口。
- 缓存文件 0600；目录不存在时创建；原子写（temp + rename）。
- `New-Api-User` 只发用户提供的 id；不猜。
- Turnstile/CAPTCHA：只返回 `captcha`，不尝试任何绕过。
- 不把 `accessToken` 放进 `apiKey` 默认值；用占位符。

### 7.3 并发与状态

- 模块级 Map 缓存：pricing、每个 key 的模型列表、key 轮询索引、坏 key 集合。
- `client.auth.set` 更新 metadata 可能并发；用一个 Promise 队列/节流（例如 30 秒最多一次）。
- `provider.models` 和 `fetch` 可能同时运行；metadata 读取用 `getAuth()` 的最新值，写入失败只记日志。

---

## 8. 测试计划

### 8.1 单元测试（bun test）

- `normalizeBase`：`https://x`、`https://x/`、`https://x/v1`、`https://x/api`、子路径。
- `parseGroupKeys`：分号/逗号/换行/JSON/空项/重复项。
- `splitApiId` / `encodeURIComponent(JSON.stringify([group, model]))` 往返；含 `/`、`:`、空格的输入；异常输入。
- `chooseProtocols`：Chat-only、Responses-only、Anthropic+Chat、Gemini+Chat、GPT-5、Claude、未知端点、`exposeAllProtocols`。
- `catalogId`：重名模型跨分组唯一；含 `/` 的 model 仍正确。
- 余额换算：quota_per_unit 500000/自定义、货币/非货币。
- 签到结果映射：success / already / not enabled / 404 / turnstile / cf / 401 / 5xx。
- 签到开关：`checkin=off` 不发请求；`checkinBlocked` 短路；重新登录 `Auto` 清除标记。
- Cloudflare 检测：`cf-mitigated`、`Server: cloudflare` + 403、HTML 里 `Just a moment...`、JSON 里 `Turnstile token is empty`。
- fetch：body 重写、Gemini 路径重写、认证头、`content-length` 删除、401 换 key、`X-Magpie-Sign-In: kept`。

### 8.2 本地 mock NewAPI

实现一个 Bun HTTP server：

- `/api/status`：quota_per_unit=500000、display_in_currency=true、checkin_enabled=true、turnstile_check=false。
- `/api/user/self`：id=1、username=alice、group=default、quota=5000000、used_quota=1000000。
- `/api/user/self/groups`：`{default:{ratio:1,desc:""},vip:{ratio:0.8,desc:"VIP"},svip:{ratio:0.6,desc:"SVIP"}}`。
- `/api/pricing`：模型覆盖：
  - `gpt-4o` groups [default,vip], endpoints [openai]
  - `gpt-5` groups [vip], endpoints [openai,openai_response]
  - `claude-sonnet-4.5` groups [vip], endpoints [anthropic,openai]
  - `gemini-2.5-pro` groups [vip], endpoints [gemini,openai]
  - `text-embedding-3` groups [default], endpoints [embeddings]（应被跳过）
- `/api/token/`：default 的 key 可 reveal，vip 的 key 掩码不可 reveal，svip 无 token → 覆盖三种情况。
- `/v1/models`：按 key 返回对应分组的模型。
- `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1beta/models/...`：回显收到的 `model` 和认证头，断言插件还原正确。
- `/api/user/self/checkin`：GET/POST 各分支；`turnstile_check=true` 的站点；返回 403 + `Server: cloudflare` 的站点；返回 HTML 质询页的站点。

### 8.3 Magpie 沙箱联调

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@" ; }
m plugin add ./newapi-plugin
m plugin --json
m plugin login newapi
m provider test newapi
m provider test newapi example.com/vip/gpt-5
m quota
m accounts checkin
```

### 8.4 验收标准

- 登录后能看到账号、余额、分组。
- 有 key 的分组模型出现；无 key 的分组在用量卡片提示。
- 重登贴 `vip=sk-...` 后 vip 模型出现，旧 key 不丢。
- `default/gpt-4o` 与 `vip/gpt-4o` 是两个模型。
- Chat-only 走 `/v1/chat/completions`；Responses-only 走 `/v1/responses`；Claude 走 `/v1/messages`；Gemini 走 `/v1beta`。
- 签到：claimed / done / inactive / captcha 都能正确显示；`checkin=off` 的站点不自动签到；有 CF 质询的站点返回 captcha 并标记，之后不再请求。
- 坏分组 key 不会让整个站点账号失效。
- 日志里没有 token/key。

---

## 9. 分阶段实现路径

### P0：脚手架与登录（已完成）

- `package.json`、`index.mjs`、`src/`、`test/`。
- `config` + `auth.methods` + prompts + `normalizeBase`。
- `/api/status`、`/api/user/self`、`/api/user/self/groups`。
- `metadata` 结构、`accountId`、缓存文件读写。
- 验收：`magpie plugin login newapi` 能登录，账号名正确，余额可见（usage 先返回简单窗口）。

### P1：分组与模型（已完成）

- `/api/pricing`、`/v1/models`、`/api/user/models` fallback。
- token 列表、reveal、手动回填、合并缓存。
- 模型 ID / `api.id` / 协议映射 / 多协议变体。
- `provider.models` 缓存、错误语义。
- 验收：重名模型、跨分组、Chat/Responses/Anthropic/Gemini 列表正确。

### P2：请求转发（已完成）

- `loader.fetch`：解析、选 key、重写、认证头、流式、重试。
- 坏 key 隔离、`X-Magpie-Sign-In: kept`、无 key 错误。
- 验收：`magpie provider test newapi <model>` 四种协议都能通；流式正常。

### P3：余额与签到（已完成）

- `usage`：quota 换算、货币、已用/请求数、分组、缺 key。
- `checkin`：status/POST、旧路径 fallback、Turnstile、结果映射。
- 验收：`magpie quota`、`magpie accounts checkin`、Usage 卡片正确。

### P4：测试与文档（已完成）

- mock server 集成测试、沙箱联调。
- README：登录、分组 key 回填、模型命名、协议、限制。
- 可选发布 npm / PR 到 magpie-community/plugins（`packages/newapi`）。

### P5：后续增强（未做）

- 自动创建 token 的完整体验（创建后 reveal，失败提示）。
- 每分组余额（`/api/usage/token`）作为额外窗口。
- 成本/倍率展示（`model_ratio`/`completion_ratio`/`group_ratio` → `cost`）。
- 图片/Embeddings 支持（Magpie `Drawers`）。
- 专用 GUI 页面管理站点/分组/key（`magpie.page`）。
- 站点时区感知的签到 `until`。
- 按 key 的 `model_limits` 精细化路由。

---

## 10. 风险与待确认问题

### 10.1 已决定（推荐）

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 插件形态 | OpenCode v1 provider 插件 | Magpie 官方支持的 provider 集成方式；不需要改核心。 |
| Provider 粒度 | 一个 `newapi` + 每站点一个账号 | `auth.provider` 静态；余额/签到按站点。 |
| 分组表达 | 模型 ID 前缀 `<site>/<group>/<model>` | 重名模型不冲突；agent 可显式选择。 |
| 分组 key 存储 | metadata 为主 + 侧文件合并缓存 | 重登不丢手动 key；metadata 是 source of truth。 |
| 多端点 | 每模型一个 `api.npm`；可选多协议变体 | Magpie 模型级协议；默认保持列表简洁。 |
| 自动建 key | 默认关闭，显式开关 | 写操作；且 `AddToken` 不返回 key，仍需 reveal。 |
| 签到 | `auth.checkin`，Turnstile → captcha | 符合 Magpie 约定；不绕过验证。 |

### 10.2 需要实际站点验证

1. **Gemini 原生端点**：Magpie 的 CodeAssist 请求/SSE 是否能被目标 NewAPI 版本正确解析；如果不行，fallback 到该模型的 `openai` 端点。
2. **`/api/pricing` 权限**：部分站点只对 root 开放；插件需要 fallback 到 `/api/user/models` + `/v1/models`。
3. **`batch/keys`/`:id/key`**：部分站点有安全验证/审计，可能 403；手动回填必须可用。
4. **PAT scope**：目标站点用旧 access token 还是 PAT；403 时要给用户明确的 scope 提示。
5. **`New-Api-User`**：目标站点/ fork 是否必须；可选 prompt 是否足够。
6. **签到时区**：站点服务器时区与北京日的偏差；v1 不返回 `until`，可能在北京日边界重复/漏签一次。实站 `v1.0.0-rc.46` 的签到日就是服务器本地日期。
7. **模型规模**：大站点（数千模型 × 多分组）的列表体积/刷新耗时；需要 `groupFilter` 过滤和缓存。
8. **图片/推理能力元数据**：NewAPI 不给 context/vision/reasoning；依赖 models.dev 或用户覆盖。

### 10.3 明确不做

- 不在插件里解 Turnstile/CAPTCHA。
- 不把 access token 发到推理接口。
- 不自动修改站点分组/渠道/用户。
- 不把分组 key 写进模型名或日志。
- 不承诺“一个站点一个 Provider 卡片”（受 Magpie 静态 provider id 限制）。

---

## 11. 参考资料

### Magpie

- `magpie/docs/subsystems/plugin-runtime.md` — 插件运行时、生命周期、扩展点。
- `magpie/docs/subsystems/provider-plugins.md` — provider/plugin 所有权、usage、checkin、options。
- `magpie/docs/subsystems/gateway-routing.md` — 路由/协议。
- `magpie/internal/plugin/providers.go` — `Model`/`Provider`/`UsageWindow`/`Checkin` 类型。
- `magpie/internal/plugin/host.js` — 钩子调用、`info()`、`fetchAs()`、`save()`、`settle()`。
- `magpie/internal/provider/plugins.go` — `pluginProtocol`、`pluginProviderServing`、`pluginFetch`、`modelAPIID`。
- `magpie/internal/provider/account.go` — `APIs`/`ListedAPIs`。
- `magpie/internal/provider/balance.go` — 已有 NewAPI `/api/user/self`、`New-Api-User`、`quota/500000` 处理。
- 官方文档：<https://usemagpie.ai/docs/zh/plugins>

### Octopus

- `octopus/internal/model/site.go` — `Site`、`SiteAccount`、`SiteToken`、`SiteUserGroup`、`SiteModel`、`SiteModelRouteType`。
- `octopus/internal/sitesync/sync.go` — 平台分发、签到。
- `octopus/internal/sitesync/sync_fetch.go` — token/分组/模型同步。
- `octopus/internal/sitesync/route_probe.go` — `supported_endpoint_types`、`enable_groups`、路由优先级。
- `octopus/internal/sitesync/balance.go` — quota/500000、`today_income`。
- `octopus/internal/sitesync/create_key.go` — 创建 token（不返回 key）。
- `octopus/internal/sitesync/project.go` — 分组/路由类型投影到渠道（单模型单 RouteType 的来源）。

### NewAPI

- 文档：<https://docs.newapi.ai/zh/docs/api>
- 源码（2026-10-28 main）：
  - `router/api-router.go`
  - `controller/user.go` — `GetSelf`、`GetUserModels`、`GetUserGroups`
  - `controller/token.go` — `GetAllTokens`、`GetTokenKey`、`GetTokenKeysBatch`、`AddToken`
  - `controller/pricing.go` — `GetPricing`
  - `controller/checkin.go` — `GetCheckinStatus`、`DoCheckin`
  - `controller/group.go` — `GetUserGroups`
  - `model/token.go` — `Token`、`MaskTokenKey`
  - `model/pricing.go` — `Pricing`
  - `model/checkin.go` — 签到记录/统计
  - `controller/misc.go` — `/api/status`
  - `service/access_token_scope.go` — PAT scope
  - `middleware/audit.go` — token key 审计

---

## 12. 实现状态

已完成，代码在 `D:\IdeaProjects\magpie_newapi_plugin`：

```
magpie_newapi_plugin/
  package.json
  index.mjs              # 插件入口：config / auth / provider
  src/
    api.mjs              # New API HTTP 接口、错误信封、challenge 检测
    signin.mjs           # 登录、分组/key 发现与回填、自动建 key
    models.mjs           # 分组→模型、api.id 编码
    protocols.mjs        # endpoint type → Magpie 协议、偏好与变体
    fetch.mjs            # 分组选 key、model 还原、认证头、流式转发
    usage.mjs            # 余额/已用/分组/缺 key/签到状态
    checkin.mjs          # 签到、开关、CF/Turnstile 检测
    state.mjs            # 缓存、key 轮换、newapi-keys.json
  test/
    util.test.mjs
    protocols.test.mjs
    fetch.test.mjs
    integration.test.mjs
    hooks.test.mjs
    mock-newapi.mjs
  README.md
```

验证：

```sh
npm test     # 66 项通过（node:test，无第三方依赖）
node -e "import('./index.mjs').then(m => console.log(Object.keys(m.default)))"
# => [ 'id', 'server' ]
```

已覆盖并测试的行为：

- access token 登录，`New-Api-User` 可选，`profile:view` 缺失时降级；
- 分组通过 `<site>/<group>/<model>` 命名空间表达，重名模型各自独立；
- Chat / Responses / Messages / Gemini 四种协议按模型选择，可选多协议变体；
- `/api/pricing` 关闭时回退 `/v1/models` 与 `/api/user/models`；
- 分组 key：list → batch/keys → 单 key reveal；掩码/拒绝时手动回填；
- `newapi-keys.json` 合并缓存，重登不丢手动 key；
- 同组多 key 轮换，坏 key 只影响该分组，`X-Magpie-Sign-In: kept`；
- 余额（`quota_per_unit`/货币/token 显示）与用量文本窗口；
- 签到：`claimed`/`done`/`inactive`/`captcha`/`failed`、旧路径 fallback；
- 签到开关（登录时 `Auto`/`Off`）、CF/Turnstile 自动检测与 `checkinBlocked` 标记、不绕过验证；
- access token 与分组 key 都不会出现在错误消息、模型名或用例输出里。

仍未做（P5 及以后）：

- 图片/Embeddings 模型；
- 每分组余额（`/api/usage/token`）；
- 成本/倍率映射到 `cost`；
- 专用 GUI 页面；
- 站点时区感知的签到 `until`；
- 用一个真实的 New API 站点做端到端验收（尤其 Gemini 端点与 PAT scope）。

## 13. 实站验收记录（2026-10-28）

在 `v1.0.0-rc.46`、CNY 显示、`turnstile_check: true` 的站点上跑通（站点与账号信息不记录在此）：

| 环节 | 结果 |
| --- | --- |
| `signIn()`（插件自己的代码路径） | 登录成功，单分组，令牌列表与 reveal 均成功 |
| `provider.models()` | 模型全部列出；名字带 `/` 也能作 catalog id 的后半段 |
| `auth.usage()` | 人民币余额按 `quota / 500000 × usd_exchange_rate` 显示，已用额度与请求数正确 |
| `auth.checkin()` | `done`（当天已签），走 `/api/user/checkin` |
| loader 的 `fetch()` | `200`，真实回复；access token 未泄漏到 relay |
| `New-Api-User` | 三个变体（不带 / 正确 / 错误）都返回本人；保留发送只为老版本 |

由此修正的三个假设（已合入代码和测试）：

1. 签到有**两种布局**，`v1.0.0-rc.46` 只有 `/api/user/checkin`；插件两个都试并记住。
2. **Turnstile 是站点开关**：`turnstile_check: true` 时直接 `captcha`，不发 POST、不永久标记；只有 Cloudflare 拦截页才写 `checkinBlocked`。
3. **CNY 汇率是 `usd_exchange_rate`**：之前误用 `custom_currency_exchange_rate`（人民币站点上它是 1），余额会少算一个汇率倍数；签到奖励同样受影响。

可复现的命令：

```sh
cp .env.example .env   # 填好，.env 已被 git 忽略
npm run live
```

脚本默认只读（不按签到）；`NEWAPI_PRESS_CHECKIN=1` 才会真的签到。

## 14. 在其他站点上验收

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@" ; }
m plugin add ./magpie_newapi_plugin
m plugin --json
m plugin login newapi
m provider test newapi
m provider test newapi <site>/<group>/<model>
m quota
m accounts checkin
```

重点确认：

1. `provider test` 对你常用的每种协议各跑一次（chat / responses / messages / gemini）。
2. `magpie quota` 的余额与站点网页一致（注意 `display_in_currency`、`quota_display_type`、`usd_exchange_rate`）。
3. 把某个分组的 key 删掉后重新登录，`Missing keys` 与回填流程符合预期。
4. 在开启 Turnstile 的站点上，`magpie accounts checkin` 显示 captcha，且不会发出注定失败的 POST。
5. 只有 `/api/user/checkin` 的老布局站点（如 `v1.0.0-rc.46`）签到显示 `done`/`claimed`，而不是 404。
