# magpie NewAPI 插件

Magpie 的 New API（NewAPI）聚合渠道插件：一个 access token 登录站点，同步分组与模型，同一分组里 Chat / Responses / Messages / Gemini 并存，余额和每日签到都能用。

**状态：可运行，66 项测试全过（Node 内置 test runner，无第三方依赖）。**

## 安装

插件是一个 npm 包 / 文件夹形式的 OpenCode v1 插件。本地目录直接加载：

```sh
magpie plugin add ./magpie_newapi_plugin
magpie plugin login newapi
```

然后在 Magpie 里选择供应商 `newapi` 的模型，例如 `newapi/example.com/vip/gpt-5`。

## 登录时要填什么

登录是**一问一答**的：前面的答案会被用来查询站点，后面的问题据此生成。

| 顺序 | 字段 | 说明 |
| --- | --- | --- |
| 0 | **哪个账号** | 已经登录过时，第一个问题就是**账号选择器**：列出已保存的站点（`acme (alice) — newapi.example.com`，带分组数和签到状态）外加「Another site」。**选已有的账号不需要再填 access token**——Magpie 已经存着，插件直接读取复用。 |
| 1 | Base URL | 只有选「Another site」才问。`https://newapi.example.com`；`/v1`、`/api`、末尾 `/` 会被归一化掉。 |
| 2 | Access token | 站点「个人设置 → 访问令牌」里的 token。**不是** `sk-...` 推理 key；填了 `sk-` 会被提示改写。**这是唯一一次要求填 token**。 |
| 3 | User id | 只有老版本 New API / AnyRouter 需要；新版本直接回车留空。 |
| 4 | Site label | 模型 ID 的前缀，默认是站点 host。同一站点多个账号时用 `example@alice`。 |
| 5 | Group filter | 只在站点有 **7 个以上分组**时才问；更少就不打扰。 |
| 6 | **让站点创建 key** | 有分组缺 key 时先问：`2 groups without a key (default, svip). Let the site create one for each?`。选 Yes 就由站点建 token 并自动取回，**不用手填**。 |
| 7 | **每个仍然缺 key 的分组一个输入框** | 只有站点建不出来（或第 6 步选了 No）才会问。标题直接写 `API key for group "vip"`，一次填一个；留空跳过。已经能从站点读到、或刚创建的 key 不会再问。 |
| 8 | Daily check-in | `Automatic` / `Off`。有 Cloudflare 质询、只能手动签到的站点选 `Off`。 |

顺序是**先让站点创建，创建不出来才要人填**——站点能给的 key 不该让人手打一遍。

为什么不再用一行文本框拼 `vip=sk-...;default=sk-...`：分组名和 key 都要手写，容易错位，而且不知道到底缺哪个。现在每个分组一个字段，标题就是分组名。

**补 key 不需要重新登录也可以**：再次运行 `magpie plugin login newapi`，已保存的 key 从缓存读回，只会问仍然缺的那些分组。

## 模型 ID 的含义

```
newapi/<siteLabel>/<group>/<model>
```

- `example.com/default/gpt-4o` 和 `example.com/vip/gpt-4o` 是**两个模型**：同一个名字在不同分组里不冲突。
- 模型名是 `model · siteLabel · group · ×倍率 · 协议`，例如：
  `gpt-5 · acme · vip · ×0.8 · Responses`
  站点名来自 `siteLabel`，所以不同站点的同名模型能分清；同一个站点的两个账号共用一个模型 ID 是**有意的**——同站点、同分组、同模型，再列一行只是重复项。协议只在非 chat 时显示。
- 默认每个模型只用一种协议，按模型类型选：
  - Claude 类 → Anthropic Messages（保留 thinking / cache_control）
  - GPT-5 / Codex / o 系 → OpenAI Responses
  - 其余 → Chat Completions
  - 只有 Gemini 端点时 → Gemini generateContent
- 打开 provider 选项 **List every protocol a model supports** 后，一个模型会列出多个变体：`gpt-5`（首选，Responses）、`gpt-5@chat`、`claude-x`（首选，Messages）、`claude-x@chat`、`gemini-x`（首选）、`gemini-x@gemini`。第一个变体总是保留不带后缀的 ID，所以开关不会让已保存的模型选择失效。

## 分组 key

### 账号状态只有一个 `groups`

账号的 metadata 里只有一个字段描述分组：

```jsonc
"groups": {
  "default": { "ratio": 1,   "key": "sk-..." },
  "vip":     { "ratio": 0.8, "key": "sk-...", "problem": "refused" },
  "staged":  { "ratio": 1,   "tried": true }
}
```

| 字段 | 含义 |
| --- | --- |
| `ratio` / `desc` | 站点给的分组倍率和描述 |
| `key` | 该分组的 key（站点有多条时取最新一条） |
| `problem` | `refused`（站点拒绝了这个 key）或 `gone`（站点不再提供这个分组） |
| `tried` | 向站点要过 key 但要不到，**不会再建第二个** |

没有分组时就没有这个分组；没有再分开放 key 列表、待办列表、问题表、创建记录——它们本来就是同一个东西的不同视角。也没有 `newapi-keys.json` 这类旁路缓存：账号自己就是唯一状态。

### 闭环：三个钩子各管一件事

| 钩子 | 职责 | 会不会改账号 |
| --- | --- | --- |
| `provider.models` | 只按现有 metadata 列模型 | **不写、不读分组、不校验 key** |
| `auth.usage` | 显示余额 + 顺带同步（10 分钟节流） | 只在有变化时写 |
| `auth.checkin` | 签到 + 强制同步（每天一次） | 只在有变化时写 |

模型列表是唯一被 Magpie 卡 20 秒的钩子，所以它**只读本地状态**，任何时候都快。分组的增删、key 的校验、key 的创建都放在有自己预算的 `usage` / `checkin` 里。

### 分组是会变的

站点的分组不是固定的：管理员会新增、改名、关闭分组，key 也会被吊销。插件因此会在**账号登录之后**继续跟进：

| 时机 | 做什么 |
| --- | --- |
| 每次读用量（用量卡片） | 距上次同步超过 10 分钟才真的去读 |
| 每次签到（每天一次） | 强制同步一遍：读分组、检查 key、必要时建 key |

**列模型（`provider.models`）不做同步**。Magpie 给一个供应商的模型钩子只有 20 秒（`internal/gui/providers.go` 的 `Refetch`），而一个站点可能有几十个分组；在那里读分组和校验 key 会把整个列表拖到超时（`context deadline exceeded`）。模型列表只用账号已有的 metadata，快、稳。分组的新增会在下一次读用量或签到时落地。

同步做四件事：

1. 读 `/api/user/self/groups`，把新分组加进账号、把消失的分组标记出来（key 保留，站点若恢复分组就能用）；
2. 读 `/api/token/`，对仍然缺 key 的分组尝试 `batch/keys` / `:id/key` reveal——站点已经有的 key 不需要你再登一次；
3. 用 `/v1/models` 校验现有的每个 key，被拒的记录成 `refused`；
4. 若打开了 `auto-create-keys`，为仍缺 key 的分组创建 token——**只在站点确实没有该组的 token 时才建**：
   - 站点已有该组的 token → 只 reveal，不新建；
   - 建了但 key 读不出来 → 记进 `createAttempted`，**下次不会再建**，等你自己填；
   - 建过的分组在拿到 key 之后自动从 `createAttempted` 里清掉。

结果写回账号的 metadata，所以**不需要重新登录**就能看到新分组。

### 首次登录或补 key

登录时插件会：

1. 读 `/api/token/` 的 token 列表（站点返回的 key 是掩码）；
2. 用 `/api/token/batch/keys` 或 `/api/token/:id/key` 取回完整 key；
3. 取不到就保留你逐个输入的 key，并用 `<Magpie 配置目录>/newapi-keys.json` 缓存，重登不会丢；
4. 仍缺 key 的分组会出现在用量卡片的 **Missing keys** 里，提示你重新登录补上。

补 key 的流程：`magpie plugin login newapi` → **在账号列表里点那个站点**（不用再输 access token）→ 先问要不要让站点自动建 key → 建不出来的才逐个手填。

**填进去的 key 会当场用 `/v1/models` 校验**：站点拒绝时，同一个分组会再问一次，并在标题里说明原因（`API key for group "vip" — the site refused it`）。留空则跳过该分组。

站点不允许读取 key（403 / 安全验证）时，手动回填是唯一的办法；插件不会尝试绕过。

同一分组可以有多个 key，按顺序轮换，一个被拒（401/403/429）会试下一个。坏 key 只影响该分组，不会把整个站点账号标记为失效。

## 余额与签到

- 余额：`/api/user/self` 的 `quota`，按 `/api/status` 的 `quota_per_unit` 换算（默认 500000 quota = $1）。站点关闭货币显示时按原始 quota 显示。
- 用量卡片只有**余额**是一条读数；「已用」「Groups」「Missing keys / Refused keys」是纯文本行，不会画进度条，也不会显示 `0%`。
  （Magpie 把带 `used` 的窗口当比例；这些行不发送 `used`，所以不会被误画成 0%。）
- **Group keys** 一行列出两种需要处理的分组：`no key: svip`（完全没有 key）和 `vip (refused)`（key 被站点拒绝）。两者都提示重新登录补上。
- 签到：`/api/user/self/checkin`，旧版本回退 `/api/user/checkin`。

### 签到开关与 Cloudflare

有些站点给签到接口加了 **Cloudflare Turnstile 或托管质询**。access token 过不去，必须浏览器。插件有三层控制：

1. **登录时选 `Off`**：`auth.checkin` 直接返回 `inactive`，不发任何请求。
2. **自动检测**：遇到 `cf-mitigated: challenge`、`Server: cloudflare` + 403、`Just a moment...` 页面、或 `Turnstile token is empty` 时，返回 `captcha` 并把 `checkinBlocked` 写回账号，之后直接短路，不再浪费请求。重新登录选 `Automatic` 会清除标记。
3. **Magpie 自己的开关**：Settings → Usage → Plugins → Daily check-in，关掉后根本不会调用插件。

插件**不会**解验证码、不打开浏览器、不伪造 `cf_clearance`。

## Provider 选项

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `auto-create-keys` | 关 | 对缺 key 的分组在站点上创建 token（写操作）。 |
| `expose-all-protocols` | 关 | 同名模型列出多个协议变体。 |
| `prefer-responses` | 开 | GPT-5 类优先 Responses。 |
| `prefer-anthropic` | 开 | Claude 类优先 Messages。 |

选项 key 必须是 Magpie 允许的 `^[a-z0-9_-]{1,40}$`，驼峰会被 host.js 整条丢弃。

## 在一个真实站点上验证过（2026-10-28）

在一个 `v1.0.0-rc.46`、人民币显示、`turnstile_check: true`、签到只能手动的站点上，插件的完整链路跑通了：登录、分组、令牌 reveal、7 个模型、余额、签到状态、一次真实推理请求。站点与账号信息不在仓库里。

这些实测直接修正了三个假设：

1. **签到有两个布局**。新版本是 `GET/POST /api/user/self/checkin`；`v1.0.0-rc.46` 只有 `GET/POST /api/user/checkin`，新路径返回 404。插件两个都试，并记住该站点用的是哪个。
2. **Turnstile 是站点开关，不是“记住的封锁”**。`/api/status` 里 `turnstile_check: true` 时，插件直接返回 `captcha`，不发送注定失败的 POST，也不把账号标记成永久 blocked（站点可能关掉 Turnstile）。只有真正的 Cloudflare 拦截页才会写 `checkinBlocked`。
3. **CNY 汇率用 `usd_exchange_rate`**。之前只读了 `custom_currency_exchange_rate`（人民币站点上它是 1），余额会少算一个汇率倍数。现在按 New API 自己的规则：USD → 1、CNY → `usd_exchange_rate`、CUSTOM → 自定义汇率、TOKENS → 无货币。签到奖励同样按这个汇率换算。

另外两点：

- `New-Api-User` 在实测站点上**可省**：不带、带对、带错都返回同一个用户。插件仍在知道 user id 时发送，只为兼容老版本。
- 模型名里可以带 `/`（聚合站常见，如“渠道/模型”），catalog id 仍然安全。

## 限制

- **一个 provider**：所有站点都挂在 `newapi` 下，站点体现在账号和模型 ID 里。Magpie 的 `auth.provider` 是静态的，无法每个站点动态生成 Provider 卡片。
- **同一站点的多个账号共用模型 ID 是有意的**。模型 ID 是 `<siteLabel>/<group>/<model>`；Magpie 把各账号的模型表按 ID 合并展示（`host.js` 的 `models[k] ??= m`），两个账号撞 label 时选择器里只出现一份——同站、同组、同模型，多一行只是重复项。
  但**请求不会走错账号**：每个账号的 `accounts[].models` 仍各自记着这个 ID，路由时第二个账号照样是候选（第一个失败会 failover 过去），而且插件在 `fetch` 里把请求固定发往**当前账号自己的站点**（`ownURL`），不会用另一个账号的地址和分组。
- **一个分组一条 key**。站点的分组可以有好几条 token，插件取最新的那条；旧的那种“同组多 key 轮换”不再有，因为同一分组的多条 token 通常是同一权限的重复。
- **手动回填的 key** 存账号 metadata，同时写一份 `newapi-keys.json` 缓存；缓存丢了需要重新贴。
- **Gemini 端点**：Magpie 走 CodeAssist 信封（`/v1beta/models/<model>:streamGenerateContent`）。多数 New API 版本接受；如果某站点不兼容，把该模型的协议切到 chat（默认通常已经是 chat，除非该模型只有 Gemini 端点）。
- **定价**：`/api/pricing` 只在部分站点公开；关闭时模型仍从每个分组的 `/v1/models` 得到，但协议只能保守地按 Chat 处理（或按模型名猜测 Claude / GPT-5）。

## 开发

```sh
npm test            # 73 项：工具函数、协议选择、请求改写、登录/模型/fetch/usage/checkin
npm run check       # 按 Magpie host.js 的规则检查插件形状（导出、钩子、选项 key、prompt）
npm run scan        # 扫描凭据与真实站点信息，发布前必须干净
npm run live        # 对一个真实站点跑一遍（只读；见下）
```

`npm run live` 会用插件的真实代码路径登录、列模型、读余额、读签到状态，并发送一个很小的推理请求。环境变量：

```sh
cp .env.example .env      # 填好，.env 已被 git 忽略
npm run live
```

也可以直接用环境变量：`NEWAPI_BASE=... NEWAPI_TOKEN=... npm run live`。

默认**只读**：不会按下签到。要真的签到，加 `NEWAPI_PRESS_CHECKIN=1`。

- `index.mjs`：插件入口（`config`、`auth`、`provider` 钩子）。
- `src/api.mjs`：New API 的 HTTP 接口与错误信封。
- `src/signin.mjs`：登录、分组/key 发现与回填。
- `src/models.mjs`：模型列表与 `api.id` 编码。
- `src/protocols.mjs`：端点类型 → Magpie 协议。
- `src/fetch.mjs`：按分组选 key、还原 model、认证头。
- `src/usage.mjs`：余额与用量窗口。
- `src/checkin.mjs`：签到、开关、CF/Turnstile 检测。
- `src/state.mjs`：缓存、key 轮换、`newapi-keys.json`。
- `test/mock-newapi.mjs`：本地假站点，覆盖掩码 key、拒绝 reveal、Turnstile、CF 页面、签到旧路径等。

## 安全与发布

**凭据在哪**：插件本身不读任何配置文件。凭据只在你登录时输入，由 Magpie 存在自己的 `plugin-auth.json` 里。

**仓库里不出现的东西**：

- `.env`、`.env.*`（只保留 `.env.example` 模板）
- `.live/`（`npm run live` 的本地缓存）
- `newapi-keys.json`、`plugin-auth.json`
- 真实站点地址、账号名、令牌（含掩码片段）、余额与签到额度

`npm run scan` 会检查这些：access token（`nap_...`）、`sk-...`、GitHub/AWS/Slack token、私钥块、`NEWAPI_*` 被填了真实值、以及非示例邮箱。它还会读本地 `.env`，把里面的 token、站点 host、user id 按**值**在全部文件里搜一遍——所以真实域名或用户名不会出现在仓库里，却也拦得住。测试夹具（`test-access-token-...`、`sk-default-key-...` 等）有明确的允许列表。CI 也会跑它，泄漏会直接让构建失败。

发布前：

1. `npm run scan` → `clean · N files scanned`
2. `npm test` → 全绿
3. `npm run check` → `plugin shape ok`
4. 确认 `.env` 没被暂存：`git status --porcelain | grep -E '^(.A|.M|\?\?) \.env$'`（应无输出）
5. 如果是第一次提交：`git log --all --oneline -- .env` 应为空

**如果已经不小心提交过**：删掉文件再提交是不够的，历史里还在。要撤销凭据（在 New API 站点上重新生成 access token、删除旧令牌），再用 `git filter-repo` 或 BFG 重写历史；只在当前提交删除并**不能**让泄漏消失。

`npm run live` 默认只读，不会按签到；`NEWAPI_PRESS_CHECKIN=1` 才会真的签到。它使用 `.env`（或环境变量），从不把凭据写进代码。

## 设计文档

更完整的调研与决策见 [NEWAPI_PLUGIN_DESIGN.md](./NEWAPI_PLUGIN_DESIGN.md)。
