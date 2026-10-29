// 一次登录过程里的中间状态。
//
// 登录是「一问一答」的：Magpie 每问一次就调用一次 ask()，每次拿到的
// inputs 是到目前为止的答案。有些事只能做一次（比如让站点创建 key），
// 用一个带过期时间的内存记录来保证，而不是把结果塞进 inputs——那些键
// 会被 Magpie 的 save() 一字不落地合进账号 metadata，永远留在那里。
//
// 记录按「站点 + 令牌 + 用户 + 站点标识」区分：换一个站点去登录就是另一次
// 登录，不该被上一次的记录挡住。

const TTL_MS = 10 * 60_000;

/** 一次登录的身份：换了站点或令牌就是另一次登录。 */
export function loginKey(inputs, base) {
  return [base || inputs?.baseURL || "", inputs?.accessToken || "", inputs?.userId ?? "", inputs?.siteLabel ?? ""].join("\u0000");
}

/** 每个登录身份上做过的事，只放内存，十分钟后自然过期。 */
const ledger = new Map();

function entryOf(id) {
  const now = Date.now();
  let entry = ledger.get(id);
  if (!entry || now - entry.at > TTL_MS) {
    entry = { at: now, created: new Map(), asked: new Set() };
    ledger.set(id, entry);
  }
  entry.at = now;
  return entry;
}

/** 这个分组在这次登录里已经向站点要过 key 了。 */
export function wasAsked(id, group) {
  return entryOf(id).asked.has(group);
}

/** 记下为某个分组要过 key：要到了记 key，没要到记一个空值。 */
export function markAsked(id, group, key) {
  const entry = entryOf(id);
  entry.asked.add(group);
  if (key) entry.created.set(group, key);
  else entry.created.delete(group);
}

/** 这次登录里已经建出来的 key：分组 → key。 */
export function createdIn(id) {
  return Object.fromEntries(entryOf(id).created);
}

/** 登录成功后清掉这次登录的记录。 */
export function forgetLogin(id) {
  ledger.delete(id);
}
