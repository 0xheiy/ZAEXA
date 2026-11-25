/* =====================================================================
   worker/badges.js — نشان‌های Portfolio، فقط از رویدادهای Swapped روی زنجیره
   =====================================================================
   قاعده‌ی محصول (از مالک):
   • فقط از رویدادِ Swappedِ اجراکننده‌های خودمان؛ هرگز localStorage یا ادعای کاربر.
   • یک سواپ فقط وقتی شمرده می‌شود که ≥ ۵ دلار باشد و دلار فقط وقتی قابل‌محاسبه است که
     یک طرفش ETH بومی (address(0))، WETH یا استیبلِ همان زنجیره باشد. بقیه «شمرده نمی‌شوند».
   • 🔴 «نامعلوم هرگز نه نیست»: مکان‌نما (cursor) فقط روی بازه‌ای جلو می‌رود که لاگ‌هایش
     کامل خوانده شده و حکمِ شمرده/نشمرده نهایی است. شکستِ RPC یا قیمتِ نامعلوم = توقف
     در آخرین بلاکِ خوب؛ هرگز «هیچ سواپی نبود».
   • حریم: نشانِ هر کیف با آدرسِ کامل در URL دیده می‌شود (داده‌ی عمومیِ زنجیره)، ولی هیچ
     فهرست/جست‌وجو/نقطه‌ای که کیف‌ها را بشمارد وجود ندارد. */

import { keccak256, utf8Bytes, bytesToHex } from "./keccak.js";
import { LANDING_SVG_DEFS } from "./report_page.js";
import { BADGE_SVG, BADGE_SVG_OFF, OG_PNG_PARTS, BADGE_ART_VERSION } from "./badge-art.js";

export const BADGE_IDS = Object.freeze(["first", "base", "rh", "stock", "ten"]);
export const BADGE_TITLES = Object.freeze({
  first: "First swap", base: "Base trader", rh: "Robinhood trader", stock: "Stock buyer", ten: "10 swaps",
});
export const BADGE_MIN_USD = 5;
export const BADGES_CRON = "47 * * * *";

/* سهام توکنیزه‌ی Base (B20) — کپیِ BASE_TOKENS در web/index.html؛ تستِ برابری هر دو را می‌سنجد. */
export const BASE_STOCKS = Object.freeze([
  "0xb200000000000000000000c2e324d24d7eecd1fb", // AAPLc
  "0xb200000000000000000000d9192b6b456483c2e8", // AMZNc
  "0xb20000000000000000000016e38fd364d271ba28", // ANTc
  "0xb2000000000000000000002d0ba3164cc74f58b7", // GOOGLc
  "0xb2000000000000000000008bc8786b856e61707c", // METAc
  "0xb200000000000000000000ab99cfa739e253872b", // MSFTc
  "0xb2000000000000000000004884b426556b92883d", // MSTRc
  "0xb200000000000000000000fd2f87532b90095211", // MUc
  "0xb20000000000000000000078ee7ce2fe4908108c", // NVDAc
  "0xb2000000000000000000007d16372840df4dabbe", // PLTRc
  "0xb200000000000000000000397293cb8cda9a10c5", // SNDKc
  "0xb2000000000000000000007b9fcbd005511acbd5", // SPCXc
  "0xb2000000000000000000001e800a7f5189430cd0", // TSLAc
]);

export const SIG_V6 = "Swapped(address,address,address,uint256,uint256,uint256,address)";
export const SIG_V5 = "Swapped(address,address,address,uint256,uint256,uint256)";
const topicOf = (sig) => "0x" + bytesToHex(keccak256(utf8Bytes(sig)));
export const TOPIC0_V6 = topicOf(SIG_V6);
export const TOPIC0_V5 = topicOf(SIG_V5);

const ZERO = "0x0000000000000000000000000000000000000000";

export const BADGE_CHAINS = Object.freeze({
  base: Object.freeze({
    id: "base",
    weth: "0x4200000000000000000000000000000000000006",
    stables: Object.freeze([
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
      "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT
      "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
    ]),
    rpcs: null, // از deps.baseRpcs
    fallbackBlocksPerHour: 18000, // بلاکِ ۲۰۰ms
    execs: Object.freeze([
      Object.freeze({ addr: "0x15e511bf2ea1a0f50f25e973d57dce0d01946b6d", ver: 5, topic: TOPIC0_V5,
        creationTx: "0x5f0798986fd30dd33b28f24264718365ac9667be42b2f955b9e9a3cec6d709e1" }),
      Object.freeze({ addr: "0x5f3fccff3339daa9ea7d2ebc3f77017d65467132", ver: 6, topic: TOPIC0_V6,
        creationTx: "0x0563d0ded9e1ba8e25ec26f8e10092e12e889bdd555c5237f094d6be1163bdda" }),
    ]),
  }),
  rh: Object.freeze({
    id: "rh",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    stables: Object.freeze(["0x5fc5360d0400a0fd4f2af552add042d716f1d168"]), // USDG
    rpcs: Object.freeze(["https://rpc.mainnet.chain.robinhood.com"]),
    fallbackBlocksPerHour: 18000,
    execs: Object.freeze([
      Object.freeze({ addr: "0xc261e57cf5739a8a538884405600e4e45df24802", ver: 6, topic: TOPIC0_V6, creationTx: null }),
    ]),
  }),
});

// سقف‌های ثابتِ هر گذر
export const BADGES_RPC_MAX = 20;      // کلِ تماس‌های RPC (هر تلاشِ failover هم یک تماس)
export const BADGES_RH_RPC_MAX = 8;    // سهمِ Robinhood؛ Base بقیه را می‌گیرد
export const BADGES_GT_MAX = 4;
export const BADGES_USERS_MAX = 200;
export const BADGES_SPAN_START = 50000;
export const BADGES_SPAN_MIN = 500;
export const BADGES_CONF = 10;         // بلاکِ اطمینان (reorg)
const RPC_TIMEOUT_MS = 8000;
const SEEN_CAP = 30;

const KEY_CUR = (c, a) => "badges:cur:" + c + ":" + a;
const KEY_SPAN = (c) => "badges:span:" + c;
const KEY_START = (c, a) => "badges:start:" + c + ":" + a;
const KEY_ETHUSD = (d) => "badges:ethusd:" + d;
const KEY_ETHPOOL = "badges:ethpool";
export const KEY_STATUS = "badges:status";
export const KEY_USER = (a) => "badge:u:" + String(a).toLowerCase();

class Unknown extends Error {}

/* ------------------------------ رمزگشایی ------------------------------ */
const ADDR_TOPIC = /^0x[0-9a-fA-F]{64}$/;
export function decodeSwapped(log, ver) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 4) return null;
  if (!log.topics.slice(1).every((t) => typeof t === "string" && ADDR_TOPIC.test(t))) return null;
  const data = typeof log.data === "string" ? log.data.replace(/^0x/, "") : "";
  const words = ver === 5 ? 3 : 4;
  if (data.length < words * 64 || /[^0-9a-fA-F]/.test(data)) return null;
  const w = (i) => BigInt("0x" + data.slice(i * 64, i * 64 + 64));
  const a = (t) => "0x" + t.slice(-40).toLowerCase();
  const ev = {
    user: a(log.topics[1]), tokenIn: a(log.topics[2]), tokenOut: a(log.topics[3]),
    amountIn: w(0), amountOut: w(1), fee: w(2), feeToken: null,
  };
  if (ver === 6) ev.feeToken = "0x" + data.slice(3 * 64 + 24, 4 * 64).toLowerCase();
  return ev;
}

/* دلارِ یک سواپ. stable اول (بدونِ نیاز به قیمت)، بعد ETH/WETH (قیمتِ روزانه لازم).
   برمی‌گرداند: {kind:"usd",usd} | {kind:"eth",eth} | {kind:"skip"} */
export function classifySwap(ev, chain) {
  const cfg = typeof chain === "string" ? BADGE_CHAINS[chain] : chain;
  const stable = (t) => cfg.stables.includes(t);
  const eth = (t) => t === ZERO || t === cfg.weth;
  if (stable(ev.tokenIn)) return { kind: "usd", usd: Number(ev.amountIn) / 1e6 };
  if (stable(ev.tokenOut)) return { kind: "usd", usd: Number(ev.amountOut) / 1e6 };
  if (eth(ev.tokenIn)) return { kind: "eth", eth: Number(ev.amountIn) / 1e18 };
  if (eth(ev.tokenOut)) return { kind: "eth", eth: Number(ev.amountOut) / 1e18 };
  return { kind: "skip" };
}

/* ------------------------------ رکوردِ کاربر ------------------------------ */
export function emptyUser() {
  return { v: 1, n: 0, first: null, base: null, rh: null, stock: null, ten: null, ts10: [], seen: [], w: {} };
}
const earlier = (a, b) => a.ts < b.ts || (a.ts === b.ts && a.tx < b.tx);

/* یک سواپِ شمرده‌شده را روی رکورد می‌نشاند. dedupe با seen. true = تغییر کرد. */
export function applyCounted(rec, chain, tx, logIndex, ts, tokenOut, pos) {
  const key = chain + ":" + String(tx).toLowerCase() + ":" + logIndex;
  if (rec.seen.includes(key)) return false;
  /* واترمارکِ هر اجراکننده (بلاک، logIndex): بازپخشِ یک تکه بعد از شکستِ نوشتنِ cursor هرگز دوبار نمی‌شمارد،
     حتی اگر آن تکه بیشتر از SEEN_CAP سواپِ همین کیف داشته باشد. */
  if (pos) {
    const w = rec.w && rec.w[pos.x];
    if (w && (pos.b < w[0] || (pos.b === w[0] && pos.i <= w[1]))) return false;
    rec.w = { ...(rec.w || {}), [pos.x]: [pos.b, pos.i] };
  }
  const e = { c: chain, tx: String(tx).toLowerCase(), ts };
  rec.n += 1;
  const put = (slot) => { if (!rec[slot] || earlier(e, rec[slot])) rec[slot] = e; };
  put("first");
  put(chain === "rh" ? "rh" : "base");
  if (chain === "base" && BASE_STOCKS.includes(String(tokenOut).toLowerCase())) put("stock");
  rec.ts10.push(e);
  rec.ts10.sort((x, y) => (earlier(x, y) ? -1 : earlier(y, x) ? 1 : 0));
  if (rec.ts10.length > 10) rec.ts10.length = 10;
  rec.ten = rec.ts10.length === 10 ? rec.ts10[9] : null;
  rec.seen.push(key);
  if (rec.seen.length > SEEN_CAP) rec.seen.splice(0, rec.seen.length - SEEN_CAP);
  return true;
}

/* ------------------------------ RPC ------------------------------ */
const RANGE_RE = /range|limit|too many|exceed|size|more than|max/i;
function isRangeError(err) {
  if (!err || typeof err !== "object") return false;
  const code = typeof err.code === "number" ? err.code : null;
  if (code === -32005 || code === -32602) return true;
  return typeof err.message === "string" && !/rate/i.test(err.message) && RANGE_RE.test(err.message);
}

async function rpcCall(ctx, chain, method, params) {
  const list = ctx.rpcs[chain] || [];
  for (const url of list) {
    if (ctx.dead.has(url)) continue;
    if (ctx.rpcLeft <= 0 || ctx.chainLeft <= 0) return { ok: false, budget: true };
    ctx.rpcLeft--; ctx.chainLeft--; ctx.rpcUsed++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
    let res = null;
    try {
      res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ac.signal,
      });
    } catch (e) { res = null; }
    clearTimeout(timer);
    if (!res || res.status !== 200) { ctx.dead.add(url); continue; }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!body || typeof body !== "object") { ctx.dead.add(url); continue; }
    if (body.error) {
      if (isRangeError(body.error)) return { ok: false, range: true };
      ctx.dead.add(url);
      continue;
    }
    return { ok: true, result: body.result };
  }
  return { ok: false };
}

const hex = (n) => "0x" + BigInt(n).toString(16);
const toNum = (h) => (typeof h === "string" && /^0x[0-9a-fA-F]+$/.test(h) ? Number(BigInt(h)) : null);

/* ------------------------------ قیمتِ ETH/USD روزانه ------------------------------ */
const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const todayUtc = (ctx) => new Date(ctx.now()).toISOString().slice(0, 10);

async function gtJson(ctx, rest) {
  if (ctx.gtLeft <= 0 || typeof ctx.deps.gt !== "function") return null;
  ctx.gtLeft--;
  try {
    const r = await ctx.deps.gt(rest);
    if (!r || r.status !== 200) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function ethPool(ctx) {
  try {
    const raw = await ctx.kv.get(KEY_ETHPOOL);
    if (raw) { const j = JSON.parse(raw); if (j && /^0x[0-9a-f]{40}$/.test(j.pool) && (j.token === "base" || j.token === "quote")) return j; }
  } catch (e) { /* دوباره پیدا می‌شود */ }
  const weth = BADGE_CHAINS.base.weth, usdc = BADGE_CHAINS.base.stables[0];
  const j = await gtJson(ctx, "networks/base/tokens/" + weth + "/pools?page=1");
  const rows = j && Array.isArray(j.data) ? j.data : [];
  let best = null;
  for (const r of rows) {
    const a = r && r.attributes, rel = r && r.relationships;
    const b = rel && rel.base_token && rel.base_token.data && String(rel.base_token.data.id || "").toLowerCase();
    const q = rel && rel.quote_token && rel.quote_token.data && String(rel.quote_token.data.id || "").toLowerCase();
    const addr = a && String(a.address || "").toLowerCase();
    const res = a ? Number(a.reserve_in_usd) : NaN;
    if (!addr || !/^0x[0-9a-f]{40}$/.test(addr) || !(res > 0)) continue;
    let token = null;
    if (b === "base_" + weth && q === "base_" + usdc) token = "base";
    else if (q === "base_" + weth && b === "base_" + usdc) token = "quote";
    if (token && (!best || res > best.res)) best = { pool: addr, token, res };
  }
  if (!best) return null;
  const out = { pool: best.pool, token: best.token };
  try { await ctx.kv.put(KEY_ETHPOOL, JSON.stringify(out)); } catch (e) { /* بعداً دوباره */ }
  return out;
}

async function loadOhlcv(ctx) {
  if (ctx.ohlcv !== undefined) return ctx.ohlcv;
  ctx.ohlcv = null;
  const p = await ethPool(ctx);
  if (!p) return null;
  const j = await gtJson(ctx, "networks/base/pools/" + p.pool + "/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=" + p.token);
  const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
  if (!Array.isArray(list)) return null;
  const m = new Map();
  for (const r of list) {
    if (!Array.isArray(r)) continue;
    const t = Number(r[0]), c = Number(r[4]);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) m.set(dayOf(t), c);
  }
  ctx.ohlcv = m;
  return m;
}

/* بستهٔ ETH/USD آن روزِ UTC؛ روزِ ناتمام یا ناخوانا = null (نامعلوم). */
async function ethUsdForDay(ctx, day) {
  if (ctx.prices.has(day)) return ctx.prices.get(day);
  let v = null;
  if (day >= todayUtc(ctx)) { ctx.prices.set(day, null); return null; }
  let raw = null;
  try { raw = await ctx.kv.get(KEY_ETHUSD(day)); } catch (e) { raw = null; }
  const cached = raw === null || raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(cached) && cached > 0) v = cached;
  else {
    const m = await loadOhlcv(ctx);
    const c = m ? m.get(day) : undefined;
    if (c !== undefined) {
      v = c;
      try { await ctx.kv.put(KEY_ETHUSD(day), String(c)); } catch (e) { /* فقط کش */ }
    }
  }
  ctx.prices.set(day, v);
  return v;
}

/* ۲۴ نوامبر — سواپِ اتریِ امروز منتظرِ بسته‌ی روز نمی‌ماند (متنِ نشان‌ها «تا یک ساعت» می‌گوید):
   بسته‌ی همان ساعتِ تمام‌شده از OHLCVِ ساعتی (۴۸ ساعتِ اخیر، یک تماس در هر گذر). ساعتِ ناتمام یا ناخوانا = null (نامعلوم). */
async function loadHourly(ctx) {
  if (ctx.hourly !== undefined) return ctx.hourly;
  ctx.hourly = null;
  const p = await ethPool(ctx);
  if (!p) return null;
  const j = await gtJson(ctx, "networks/base/pools/" + p.pool + "/ohlcv/hour?aggregate=1&limit=48&currency=usd&token=" + p.token);
  const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
  if (!Array.isArray(list)) return null;
  const m = new Map();
  for (const r of list) {
    if (!Array.isArray(r)) continue;
    const t = Number(r[0]), c = Number(r[4]);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) m.set(t, c);
  }
  ctx.hourly = m;
  return m;
}
async function ethUsdAt(ctx, ts) {
  const day = dayOf(ts);
  if (day < todayUtc(ctx)) return ethUsdForDay(ctx, day);
  const hour = Math.floor(ts / 3600) * 3600;
  if ((hour + 3600) * 1000 > ctx.now()) return null;        // ساعتِ جاری هنوز بسته نشده
  const m = await loadHourly(ctx);
  const c = m ? m.get(hour) : undefined;
  return c === undefined ? null : c;
}

async function blockTs(ctx, chain, log) {
  const inline = toNum(log.blockTimestamp);
  if (inline !== null) return inline;
  const bn = toNum(log.blockNumber);
  if (bn === null) throw new Unknown("block");
  const k = chain + ":" + bn;
  if (ctx.ts.has(k)) return ctx.ts.get(k);
  const r = await rpcCall(ctx, chain, "eth_getBlockByNumber", [hex(bn), false]);
  const ts = r.ok && r.result ? toNum(r.result.timestamp) : null;
  if (ts === null) throw new Unknown("ts");
  ctx.ts.set(k, ts);
  return ts;
}

/* ------------------------------ پردازشِ یک تکه از لاگ‌ها ------------------------------ */
async function getUser(ctx, addr) {
  if (ctx.users.has(addr)) return ctx.users.get(addr);
  if (ctx.users.size >= BADGES_USERS_MAX) throw new Unknown("users");
  const raw = await ctx.kv.get(KEY_USER(addr));
  let rec = emptyUser();
  if (raw) {
    try { const j = JSON.parse(raw); if (j && j.v === 1) rec = { ...emptyUser(), ...j }; }
    catch (e) { throw new Unknown("user-json"); }
  }
  const entry = { rec, before: JSON.stringify(rec) };
  ctx.users.set(addr, entry);
  return entry;
}

async function flushUsers(ctx) {
  for (const [addr, e] of ctx.users) {
    const now = JSON.stringify(e.rec);
    if (now !== e.before) { await ctx.kv.put(KEY_USER(addr), now); e.before = now; }
  }
}

/* برمی‌گرداند آخرین بلاکی که کامل و نهایی پردازش شد (≥ from-1). */
async function applyLogs(ctx, cfg, exec, logs, from, to) {
  const sorted = logs.slice().sort((a, b) => (toNum(a.blockNumber) - toNum(b.blockNumber)) || (toNum(a.logIndex) - toNum(b.logIndex)));
  let done = from - 1;
  let cur = from; // بلاکی که الان در دست است
  let i = 0;
  try {
    while (i < sorted.length) {
      const bn = toNum(sorted[i].blockNumber);
      cur = bn === null ? from : bn;
      if (bn === null || bn < from || bn > to) throw new Unknown("block-range");
      while (i < sorted.length && toNum(sorted[i].blockNumber) === bn) {
        const log = sorted[i];
        if (log.removed) throw new Unknown("removed");
        const ev = decodeSwapped(log, exec.ver);
        if (!ev) throw new Unknown("decode");
        const c = classifySwap(ev, cfg);
        if (c.kind !== "skip") {
          let usd = c.kind === "usd" ? c.usd : null;
          let ts = null;
          if (c.kind === "eth") {
            ts = await blockTs(ctx, cfg.id, log);
            const px = await ethUsdAt(ctx, ts);
            if (px === null) throw new Unknown("price");
            usd = c.eth * px;
          }
          if (usd >= BADGE_MIN_USD) {
            if (ts === null) ts = await blockTs(ctx, cfg.id, log);
            const u = await getUser(ctx, ev.user);
            if (applyCounted(u.rec, cfg.id, log.transactionHash, toNum(log.logIndex), ts, ev.tokenOut, { x: exec.addr, b: bn, i: toNum(log.logIndex) })) ctx.counted++;
          }
        }
        i++;
      }
      done = bn;
    }
    done = to;
    return done;
  } catch (e) {
    if (!(e instanceof Unknown)) throw e; // خطای KV و مانند آن: بالاتر مکان‌نما را جلو نمی‌برد
    return Math.max(done, cur - 1); // همه‌ی بلاک‌های پیش از بلاکِ شکست‌خورده نهایی‌اند؛ خودِ آن دوباره خوانده می‌شود (dedupe با seen/w)
  }
}

/* ------------------------------ شروعِ هر اجراکننده ------------------------------ */
async function startBlock(ctx, cfg, exec, safeHead) {
  const key = KEY_START(cfg.id, exec.addr);
  let raw = null;
  try { raw = await ctx.kv.get(key); } catch (e) { return null; }
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  if (cfg.id === "base") {
    const r = await rpcCall(ctx, "base", "eth_getTransactionReceipt", [exec.creationTx]);
    const rc = r.ok ? r.result : null;
    const bn = rc ? toNum(rc.blockNumber) : null;
    if (bn === null) return null;
    if (rc.contractAddress && String(rc.contractAddress).toLowerCase() !== exec.addr) return null;
    await ctx.kv.put(key, String(bn));
    return bn;
  }
  // Robinhood: جست‌وجوی دودویی روی eth_getCode، قابلِ ادامه بین گذرها
  let st = null;
  if (raw) { try { st = JSON.parse(raw); } catch (e) { st = null; } }
  if (!st || !Number.isFinite(st.lo) || !Number.isFinite(st.hi)) {
    const r = await rpcCall(ctx, cfg.id, "eth_getCode", [exec.addr, hex(safeHead)]);
    if (!r.ok || typeof r.result !== "string") return null;
    if (r.result === "0x") return null; // هنوز کدی نیست یا نامعلوم؛ هرگز حدس نمی‌زنیم
    st = { lo: 0, hi: safeHead };
  }
  while (st.hi - st.lo > 1) {
    const mid = Math.floor((st.lo + st.hi) / 2);
    const r = await rpcCall(ctx, cfg.id, "eth_getCode", [exec.addr, hex(mid)]);
    if (!r.ok || typeof r.result !== "string") break;
    if (r.result === "0x") st.lo = mid; else st.hi = mid;
  }
  if (st.hi - st.lo <= 1) {
    await ctx.kv.put(key, String(st.hi));
    return st.hi;
  }
  await ctx.kv.put(key, JSON.stringify(st));
  return null;
}

/* ------------------------------ گذرِ یک زنجیره ------------------------------ */
async function runChain(ctx, cfg, prev) {
  const out = { cursor: null, head: null, complete: false, at: ctx.now() };
  const h = await rpcCall(ctx, cfg.id, "eth_blockNumber", []);
  const head = h.ok ? toNum(h.result) : null;
  if (head === null) { out.stale = true; out.head = prev ? prev.head : null; out.cursor = prev ? prev.cursor : null; return out; }
  const safeHead = head - BADGES_CONF;
  out.head = head;
  let bph = cfg.fallbackBlocksPerHour;
  if (prev && Number.isFinite(prev.head) && Number.isFinite(prev.at) && ctx.now() > prev.at + 60000 && head > prev.head) {
    const r = (head - prev.head) / ((ctx.now() - prev.at) / 1000);
    if (r > 0.05 && r < 50) bph = Math.ceil(r * 3600);
  }
  let spanRaw = null;
  try { spanRaw = await ctx.kv.get(KEY_SPAN(cfg.id)); } catch (e) { spanRaw = null; }
  let span = /^\d+$/.test(spanRaw || "") ? Math.max(BADGES_SPAN_MIN, Math.min(BADGES_SPAN_START, Number(spanRaw))) : BADGES_SPAN_START;
  const span0 = span;
  const cursors = [];
  let allDone = true;
  for (const exec of cfg.execs) {
    let cursor = null;
    const start = await startBlock(ctx, cfg, exec, safeHead);
    if (start === null) { allDone = false; cursors.push(null); break; }
    let raw = null;
    try { raw = await ctx.kv.get(KEY_CUR(cfg.id, exec.addr)); } catch (e) { allDone = false; cursors.push(null); break; }
    cursor = /^\d+$/.test(raw || "") ? Number(raw) : start - 1;
    let stopped = false;
    while (cursor < safeHead && !stopped) {
      const from = cursor + 1, to = Math.min(from + span - 1, safeHead);
      const r = await rpcCall(ctx, cfg.id, "eth_getLogs", [{ address: exec.addr, topics: [exec.topic], fromBlock: hex(from), toBlock: hex(to) }]);
      if (!r.ok) {
        if (r.range && span > BADGES_SPAN_MIN) { span = Math.max(BADGES_SPAN_MIN, span >> 1); continue; }
        stopped = true; break;
      }
      if (!Array.isArray(r.result)) { stopped = true; break; }
      let done = from - 1;
      try {
        done = await applyLogs(ctx, cfg, exec, r.result, from, to);
        await flushUsers(ctx);
        ctx.users.clear();
      } catch (e) { stopped = true; break; }
      if (done >= from) {
        cursor = done;
        try { await ctx.kv.put(KEY_CUR(cfg.id, exec.addr), String(cursor)); } catch (e) { stopped = true; }
      }
      if (done < to) stopped = true;
    }
    cursors.push(cursor);
    // ترتیبِ زمانی: v6 فقط بعد از اینکه v5 تا سرِ زنجیره خوانده شد
    if (cursor === null || cursor < safeHead) { allDone = false; break; }
  }
  if (span !== span0) { try { await ctx.kv.put(KEY_SPAN(cfg.id), String(span)); } catch (e) { /* خوب */ } }
  const got = cursors.filter((c) => c !== null);
  out.cursor = got.length === cfg.execs.length ? Math.min(...got) : (prev ? prev.cursor : null);
  out.complete = got.length === cfg.execs.length && got.every((c) => c >= head - bph);
  out.bph = bph;
  return out;
}

export function baseRpcList(env, v4LogRpcs) {
  const l = Array.isArray(v4LogRpcs) ? v4LogRpcs.slice() : [];
  const own = env && typeof env.BASE_RPC === "string" && env.BASE_RPC;
  if (own && !l.includes(own)) l.push(own);
  return l;
}

/* گذرِ ساعتیِ نشان‌ها. هرگز پرتاب نمی‌کند. deps: {gt(rest)→Response, baseRpcs:[url], now?} */
export async function runBadgesPass(env, deps) {
  const d = deps || {};
  const kv = env && env.ZX_KV;
  if (!kv) return { skipped: "no-kv" };
  try {
    const ctx = {
      env, kv, deps: d, now: d.now || (() => Date.now()),
      rpcs: { base: d.baseRpcs || [], rh: BADGE_CHAINS.rh.rpcs },
      rpcLeft: BADGES_RPC_MAX, chainLeft: 0, rpcUsed: 0, gtLeft: BADGES_GT_MAX,
      dead: new Set(), ts: new Map(), prices: new Map(), users: new Map(), counted: 0,
    };
    let prev = null;
    try { prev = JSON.parse((await kv.get(KEY_STATUS)) || "null"); } catch (e) { prev = null; }
    const status = { base: prev && prev.base ? prev.base : null, rh: prev && prev.rh ? prev.rh : null };
    for (const id of ["rh", "base"]) {
      ctx.chainLeft = id === "rh" ? Math.min(BADGES_RH_RPC_MAX, ctx.rpcLeft) : ctx.rpcLeft;
      ctx.users = new Map();
      try { status[id] = await runChain(ctx, BADGE_CHAINS[id], status[id]); }
      catch (e) { status[id] = { ...(status[id] || {}), complete: false, stale: true }; }
    }
    try { await kv.put(KEY_STATUS, JSON.stringify(status)); } catch (e) { /* بعدی */ }
    return { rpc: ctx.rpcUsed, counted: ctx.counted, status };
  } catch (e) {
    return { error: true };
  }
}

/* ------------------------------ خروجی برای مسیرها ------------------------------ */
async function readStatus(kv) {
  try { return JSON.parse((await kv.get(KEY_STATUS)) || "null") || {}; } catch (e) { return {}; }
}

/* ساختِ JSON: state = got | pending | none (نامعلوم هرگز «none» نیست). */
export function badgesDoc(addr, rec, status) {
  const r = rec || emptyUser();
  const cb = !!(status && status.base && status.base.complete);
  const cr = !!(status && status.rh && status.rh.complete);
  const need = { first: cb && cr, base: cb, rh: cr, stock: cb, ten: cb && cr };
  const badges = BADGE_IDS.map((id) => {
    const g = r[id];
    if (g) return { id, got: true, state: "got", ts: g.ts, tx: g.tx, chain: g.c };
    return { id, got: false, state: need[id] ? "none" : "pending" };
  });
  return { address: String(addr).toLowerCase(), complete: { base: cb, rh: cr }, n: r.n || 0, badges, progress: { ten: Math.min(r.n || 0, 10) } };
}

const NOINDEX = { "x-robots-tag": "noindex" };
const ADDR_PATH = /^\/badges\/(0x[0-9a-fA-F]{40})(\.json)?$/;

function notFound() {
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...NOINDEX } });
}

const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PAGE_CSS = ":root{--bg:#0a0810;--card:#131020;--line:#221d33;--tx:#f0eef7;--tx2:#a49fb8;--tx3:#736d8a;--g1:#22EFF6;--g2:#C56CF5}" +
  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  "a{color:inherit;text-decoration:none}header{padding:18px 26px;border-bottom:1px solid var(--line)}" +
  ".brand{display:inline-flex;align-items:center;gap:12px}.mark{height:26.5px;width:auto;display:block}.word{height:12.7px;width:auto;display:block;color:var(--tx)}" +
  "main{max-width:980px;margin:0 auto;padding:34px 20px 60px}h1{margin:0 0 4px;font-size:28px;letter-spacing:-.01em}" +
  ".sub{margin:0 0 26px;color:var(--tx2);font-size:14px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}" +
  ".grid{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}" +
  ".medal{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 10px;text-align:center}" +
  ".medal img{width:100%;max-width:140px;height:auto;display:block;margin:0 auto 10px}" +
  ".medal b{display:block;font-size:14px}.medal span{display:block;font-size:12.5px;color:var(--tx3);margin-top:2px}" +
  ".cta{display:inline-block;margin-top:30px;padding:14px 22px;border-radius:999px;font-weight:700;font-size:13px;color:#05121a;background:linear-gradient(105deg,var(--g1),#50c8f6 42%,var(--g2))}" +
  "@media(max-width:720px){.grid{grid-template-columns:repeat(2,1fr)}h1{font-size:23px}}";

export function badgePageHtml(addr, doc) {
  const got = doc.badges.filter((b) => b.got).length;
  const cards = doc.badges.map((b) => {
    const when = b.got ? fmtDate(b.ts) : b.state === "pending" ? "Still reading history" : "Not yet";
    return '<div class="medal' + (b.got ? "" : " off") + '"><img src="/badges/art/' + b.id + (b.got ? "" : "-off") + ".svg?v=" + BADGE_ART_VERSION +
      '" alt="" width="140" height="140"><b>' + esc(BADGE_TITLES[b.id]) + "</b><span>" + esc(when) + "</span></div>";
  }).join("");
  const desc = got + " of 5 Zaexa badges";
  return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>Zaexa badges</title>" +
    '<meta name="robots" content="noindex">' +
    '<meta name="description" content="' + esc(desc) + '">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="Zaexa">' +
    '<meta property="og:title" content="Zaexa badges">' +
    '<meta property="og:description" content="' + esc(desc) + '">' +
    '<meta property="og:image" content="https://zaexa.com/badges/og.png">' +
    '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<meta name="twitter:title" content="Zaexa badges"><meta name="twitter:description" content="' + esc(desc) + '">' +
    "<style>" + PAGE_CSS + "</style></head><body>" + LANDING_SVG_DEFS +
    '<header><a class="brand" href="/" aria-label="Zaexa home"><svg class="mark" viewBox="0 0 1000 697.98" aria-hidden="true"><use href="#zxMark"/></svg>' +
    '<svg class="word" viewBox="0 0 2581.74 300" aria-hidden="true"><use href="#zxWord"/></svg></a></header>' +
    "<main><h1>Zaexa badges</h1><p class=\"sub mono\">" + esc(shortAddr(addr)) + " · " + esc(desc) + "</p>" +
    '<div class="grid">' + cards + "</div>" +
    '<a class="cta" href="/app">Open Zaexa</a></main></body></html>\n';
}

const PAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let ogBytes = null;
function ogPng() {
  if (ogBytes) return ogBytes;
  const bin = atob(OG_PNG_PARTS.join(""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  ogBytes = out;
  return out;
}

/* GET /badges/... — هر پاسخ X-Robots-Tag: noindex دارد. هیچ فهرست/ایندکسی نیست. */
export async function badgesRoute(request, url, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: NOINDEX });
  const head = request.method === "HEAD";
  const p = url.pathname;
  const m = ADDR_PATH.exec(p);
  if (m) {
    const addr = m[1].toLowerCase();
    const kv = env && env.ZX_KV;
    let rec = null, status = {};
    try {
      if (!kv) throw new Error("no-kv");
      const raw = await kv.get(KEY_USER(addr));
      rec = raw ? JSON.parse(raw) : null;
      status = await readStatus(kv);
    } catch (e) {
      return new Response(head ? null : JSON.stringify({ error: "unavailable" }), {
        status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...NOINDEX } });
    }
    const doc = badgesDoc(addr, rec, status);
    if (m[2]) {
      return new Response(head ? null : JSON.stringify(doc), { status: 200, headers: {
        "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*", ...NOINDEX } });
    }
    return new Response(head ? null : badgePageHtml(addr, doc), { status: 200, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60",
      "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...NOINDEX } });
  }
  const art = /^\/badges\/art\/([a-z]+)(-off)?\.svg$/.exec(p);
  const artMap = art && art[2] ? BADGE_SVG_OFF : BADGE_SVG; // «-off» = هنرِ قفل
  if (art && Object.prototype.hasOwnProperty.call(artMap, art[1]) && BADGE_IDS.includes(art[1])) {
    const versioned = url.searchParams.get("v") === BADGE_ART_VERSION;
    return new Response(head ? null : artMap[art[1]], { status: 200, headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff", ...NOINDEX } });
  }
  if (p === "/badges/og.png") {
    const b = ogPng();
    return new Response(head ? null : b, { status: 200, headers: {
      "content-type": "image/png", "content-length": String(b.length),
      "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", ...NOINDEX } });
  }
  return notFound();
}
