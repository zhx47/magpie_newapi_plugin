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
| 1 | Base URL | `https://newapi.example.com`；`/v1`、`/api`、末尾 `/` 会被归一化掉。 |
| 2 | Access token | 站点「个人设置 → 访问令牌」里的 token。**不是** `sk-...` 推理 key；填了 `sk-` 会被提示改写。**这是唯一一次要求填 token**。 |
| 3 | User id | 只有老版本 New API / AnyRouter 需要；新版本直接回车留空。 |
| 4 | Site label | 模型 ID 的前缀，默认是站点 host。同一站点多个账号时用 `example@alice`。 |
| 5 | Group filter | 只在站点有 **7 个以上分组**时才问；更少就不打扰。 |
| 6… | **每个缺 key 的分组一个输入框** | 标题直接写 `API key for group "vip"`，一次填一个；留空表示跳过这个分组。已经能从站点读到的 key 不会再问。 |
| 7 | Daily check-in | `Automatic` / `Off`。有 Cloudflare 质询、只能手动签到的站点选 `Off`。 |
| 8 | Create tokens | 是否允许插件在站点上为仍缺 key 的分组自动创建 token（需要 `api_key:edit` 权限）。 |

为什么不再用一行文本框拼 `vip=sk-...;default=sk-...`：分组名和 key 都要手写，容易错位，而且不知道到底缺哪个。现在每个分组一个字段，标题就是分组名。

**补 key 不需要重新登录也可以**：再次运行 `magpie plugin login newapi`，已保存的 key 从缓存读回，只会问仍然缺的那些分组。

## 模型 ID 的含义

```
newapi/<siteLabel>/<group>/<model>
```

- `example.com/default/gpt-4o` 和 `example.com/vip/gpt-4o` 是**两个模型**：同一个名字在不同分组里不冲突。
- 模型名以**账号**开头，因为多个站点共用一个 `newapi` 供应商：
  `alice · gpt-5 · vip · ×0.8 · Responses`
  依次是：账号（用户名，没有则站点名）、模型、分组、分组倍率、协议（chat 不显示）。
- 默认每个模型只用一种协议，按模型类型选：
  - Claude 类 → Anthropic Messages（保留 thinking / cache_control）
  - GPT-5 / Codex / o 系 → OpenAI Responses
  - 其余 → Chat Completions
  - 只有 Gemini 端点时 → Gemini generateContent
- 打开 provider 选项 **List every protocol a model supports** 后，一个模型会列出多个变体：`gpt-5`（首选，Responses）、`gpt-5@chat`、`claude-x`（首选，Messages）、`claude-x@chat`、`gemini-x`（首选）、`gemini-x@gemini`。第一个变体总是保留不带后缀的 ID，所以开关不会让已保存的模型选择失效。

## 分组 key

登录时插件会：

1. 读 `/api/token/` 的 token 列表（站点返回的 key 是掩码）；
2. 用 `/api/token/batch/keys` 或 `/api/token/:id/key` 取回完整 key；
3. 取不到就保留你逐个输入的 key，并用 `<Magpie 配置目录>/newapi-keys.json` 缓存，重登不会丢；
4. 仍缺 key 的分组会出现在用量卡片的 **Missing keys** 里，提示你重新登录补上。

补 key 的流程：`magpie plugin login newapi` → 填 base URL 和 access token（或直接回车用缓存）→ 插件只问仍然缺的那些分组，一个分组一个输入框。

站点不允许读取 key（403 / 安全验证）时，手动回填是唯一的办法；插件不会尝试绕过。

同一分组可以有多个 key，按顺序轮换，一个被拒（401/403/429）会试下一个。坏 key 只影响该分组，不会把整个站点账号标记为失效。

## 余额与签到

- 余额：`/api/user/self` 的 `quota`，按 `/api/status` 的 `quota_per_unit` 换算（默认 500000 quota = $1）。站点关闭货币显示时按原始 quota 显示。
- 用量卡片只有**余额**是一条读数；「已用」「Groups」「Missing keys」是纯文本行，不会画进度条，也不会显示 `0%`。
  （Magpie 把带 `used` 的窗口当比例；这些行不发送 `used`，所以不会被误画成 0%。）
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
- **`siteLabel` 必须区分同一站点的多个账号**。模型 ID 是 `<siteLabel>/<group>/<model>`，同一站点第二个账号若沿用同一个 `siteLabel`，两者的模型 ID 会完全相同，Magpie 按 ID 合并账号的模型表时后一个会被前一个盖住。登录同一站点的第二个账号时，把 `siteLabel` 填成能区分的值，例如 `example.com` 和 `example.com-bob`（不填也不会撞，因为默认 label 是 host，但两个账号配同一个显式 label 就会）。
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
