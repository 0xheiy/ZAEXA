/* کاوشگرهای نشان‌ها (worker/badges.js) — از worker/test.mjs صدا زده می‌شود (runBadgesCases(ok, worker)).
   بدونِ شبکه: fetch و KV جعلی. هر رفتار یک کاوشگر دارد؛ شکستنِ عمدی با ZX_BADGES_BREAK=<نام> (فقط برای دیدنِ قرمزشدن). */
import fs from "node:fs";
import {
  TOPIC0_V5, TOPIC0_V6, SIG_V5, SIG_V6, BASE_STOCKS, BADGE_IDS, BADGE_TITLES, BADGE_CHAINS, BADGES_RPC_MAX,
  decodeSwapped, classifySwap, applyCounted, emptyUser, runBadgesPass, badgesDoc, badgesRoute, badgePageHtml, baseRpcList,
} from "./badges.js";
import { keccak256, utf8Bytes, bytesToHex } from "./keccak.js";
import { BADGE_SVG, BADGE_SVG_OFF, OG_PNG_PARTS, BADGE_ART_VERSION } from "./badge-art.js";
import { scheduledBadgesPass, sitemapResponse } from "./index.js";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const BAN = /\b(points?|rewards?|eligible|airdrops?|seasons?|earn(?:s|ed|ing)?)\b/i;

const B = BADGE_CHAINS.base, R = BADGE_CHAINS.rh;
const USDC = B.stables[0], WETH = B.weth, ZERO = "0x" + "0".repeat(40);
const TSLA = BASE_STOCKS[12], OTHER = "0x" + "ab".repeat(20), OTHER2 = "0x" + "cd".repeat(20);
const V5 = B.execs[0], V6 = B.execs[1], RHX = R.execs[0];
const pad = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "").toLowerCase();
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const u = (n) => "0x" + n.toString(16).padStart(40, "0");   // کیف جعلیِ شماره n
const hex = (n) => "0x" + n.toString(16);
let txn = 0;
function mkLog(ex, user, tin, tout, ain, aout, block, idx, ts) {
  txn++;
  const data = "0x" + w(ain) + w(aout) + w(0) + (ex.ver === 6 ? "0".repeat(24) + tin.replace(/^0x/, "").slice(0) .padStart(40, "0") : "");
  return { address: ex.addr, topics: [ex.topic, pad(user), pad(tin), pad(tout)], data, blockNumber: hex(block), logIndex: hex(idx),
    transactionHash: "0x" + txn.toString(16).padStart(64, "0"), ...(ts ? { blockTimestamp: hex(ts) } : {}) };
}
const T = (d) => Math.floor(Date.parse(d + "T12:00:00Z") / 1000);
const NOW = Date.parse("2026-11-24T12:00:00Z");

function makeKv() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); },
    list: async () => { throw new Error("list must never be used by badges"); } };
}

/* دنیای جعلی: بلاک‌ها، لاگ‌ها، رفتارِ RPC. */
function world(over) {
  const W = {
    head: 1000100, rhHead: 600, rhDeploy: 337, startV5: 1000000, startV6: 1000040,
    logs: [], failLogs: false, maxSpan: Infinity, gtDays: { "2026-11-09": 3000, "2026-11-10": 3000, "2026-11-23": 2000 },
    gtOk: true, calls: [], gtCalls: [], blockTs: {}, rhLogs: [], ...(over || {}),
  };
  W.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.geckoterminal.com/api/v2/")) {
      W.gtCalls.push(s);
      if (!W.gtOk) return new Response("x", { status: 500 });
      if (/\/tokens\/.*\/pools/.test(s)) {
        const row = (a, b, q, res) => ({ attributes: { address: a, reserve_in_usd: String(res) },
          relationships: { base_token: { data: { id: "base_" + b } }, quote_token: { data: { id: "base_" + q } } } });
        return Response.json({ data: [row("0x" + "11".repeat(20), WETH, "0x" + "ee".repeat(20), 9e9), row("0x" + "22".repeat(20), WETH, USDC, 5e6), row("0x" + "33".repeat(20), WETH, USDC, 1e6)] });
      }
      if (/\/ohlcv\/hour/.test(s)) {
        return Response.json({ data: { attributes: { ohlcv_list: Object.entries(W.gtHours || {}).map(([h, c]) => [Number(h), c, c, c, c, 1]) } } });
      }
      if (/\/ohlcv\/day/.test(s)) {
        W.ohlcvPool = s;
        return Response.json({ data: { attributes: { ohlcv_list: Object.entries(W.gtDays).map(([d, c]) => [Date.parse(d + "T00:00:00Z") / 1000, c, c, c, c, 1]) } } });
      }
      return new Response("{}", { status: 404 });
    }
    const body = JSON.parse(init.body);
    const isRh = s.includes("robinhood");
    W.calls.push({ url: s, m: body.method, rh: isRh });
    const ok = (r) => Response.json({ jsonrpc: "2.0", id: 1, result: r });
    const err = (code, message) => Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } });
    const p = body.params;
    if (body.method === "eth_blockNumber") return ok(hex(isRh ? W.rhHead : W.head));
    if (body.method === "eth_getTransactionReceipt") {
      if (W.failReceipt) return new Response("x", { status: 503 });
      const ex = [V5, V6].find((e) => e.creationTx === p[0]);
      return ok({ blockNumber: hex(ex === V5 ? W.startV5 : W.startV6), contractAddress: ex.addr, status: "0x1" });
    }
    if (body.method === "eth_getCode") return ok(parseInt(p[1], 16) >= W.rhDeploy ? "0x6080" : "0x");
    if (body.method === "eth_getBlockByNumber") {
      const bn = parseInt(p[0], 16);
      return W.blockTs[bn] ? ok({ timestamp: hex(W.blockTs[bn]) }) : new Response("x", { status: 500 });
    }
    if (body.method === "eth_getLogs") {
      if (W.failLogs) return new Response("x", { status: 503 });
      const f = parseInt(p[0].fromBlock, 16), t = parseInt(p[0].toBlock, 16);
      if (t - f + 1 > W.maxSpan) return err(-32005, "query exceeds max block range");
      const src = isRh ? W.rhLogs : W.logs;
      return ok(src.filter((l) => l.address === p[0].address && parseInt(l.blockNumber, 16) >= f && parseInt(l.blockNumber, 16) <= t));
    }
    return err(-32601, "no method");
  };
  return W;
}

async function withWorld(W, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = W.fetch;
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

const DEPS = (extra) => ({ now: () => NOW, baseRpcs: ["https://base.test/rpc"],
  gt: (rest) => globalThis.fetch("https://api.geckoterminal.com/api/v2/" + rest), ...(extra || {}) });
const userOf = (kv, n) => { const r = kv.m.get("badge:u:" + u(n)); return r ? JSON.parse(r) : null; };
const curOf = (kv, ex) => kv.m.get("badges:cur:" + (ex === RHX ? "rh" : "base") + ":" + ex.addr);

export async function runBadgesCases(ok, worker) {
  const brk = process.env.ZX_BADGES_BREAK || "";
  // ---------- topic0: از امضا دوباره حساب می‌شود، و امضا با خودِ SwapExecutor.sol می‌خواند ----------
  {
    const h = (sig) => "0x" + bytesToHex(keccak256(utf8Bytes(sig)));
    ok(TOPIC0_V6 === h("Swapped(address,address,address,uint256,uint256,uint256,address)") && TOPIC0_V5 === h("Swapped(address,address,address,uint256,uint256,uint256)"),
      "[badges topic0] both topic0 values are recomputed from the event signatures");
    ok(/^0x[0-9a-f]{64}$/.test(TOPIC0_V6) && TOPIC0_V6 !== TOPIC0_V5, "[badges topic0] v5 and v6 differ and are 32-byte hex");
    const sol = read("../contracts/src/SwapExecutor.sol");
    const m = /event Swapped\(([^)]*)\);/.exec(sol);
    const sig = "Swapped(" + m[1].split(",").map((x) => x.trim().split(/\s+/)[0]).join(",") + ")";
    ok(sig === SIG_V6, "[badges topic0] the v6 signature in contracts/src/SwapExecutor.sol is " + sig + ", worker uses " + SIG_V6);
    ok(h("") === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "[badges topic0] keccak vector (empty string) holds");
  }
  // ---------- رمزگشایی هر دو نسخه ----------
  {
    const l6 = mkLog(V6, u(1), USDC, TSLA, 12_345_678, 5, 7, 3, 100);
    const e6 = decodeSwapped(l6, 6);
    ok(e6 && e6.user === u(1) && e6.tokenIn === USDC && e6.tokenOut === TSLA && e6.amountIn === 12345678n && e6.amountOut === 5n && e6.fee === 0n && e6.feeToken === USDC,
      "[badges decode] v6 event: user/tokenIn/tokenOut indexed, amounts and feeToken from data: " + JSON.stringify(e6, (k, v) => typeof v === "bigint" ? v.toString() : v));
    const l5 = mkLog(V5, u(2), ZERO, OTHER, 10n ** 16n, 99, 7, 4, 100);
    const e5 = decodeSwapped(l5, 5);
    ok(e5 && e5.tokenIn === ZERO && e5.amountIn === 10n ** 16n && e5.feeToken === null, "[badges decode] v5 event (3 data words, no feeToken)");
    ok(decodeSwapped({ ...l6, data: l6.data.slice(0, 100) }, 6) === null && decodeSwapped({ ...l6, topics: l6.topics.slice(0, 3) }, 6) === null,
      "[badges decode] a short data or missing topics decodes to null (never to a guess)");
  }
  // ---------- قاعده‌ی دلار ----------
  {
    const ev = (tin, tout, ain, aout) => ({ tokenIn: tin, tokenOut: tout, amountIn: BigInt(ain), amountOut: BigInt(aout) });
    const c1 = classifySwap(ev(USDC, OTHER, 5_000_000, 1), "base");
    ok(c1.kind === "usd" && c1.usd === 5, "[badges usd] stable side: amount / 1e6 (6 decimals) = $5, got " + JSON.stringify(c1));
    const c2 = classifySwap(ev(OTHER, B.stables[1], 1, 7_250_000), "base");
    ok(c2.kind === "usd" && c2.usd === 7.25, "[badges usd] stable on the output side (USDT): " + JSON.stringify(c2));
    const c3 = classifySwap(ev(ZERO, OTHER, 2n * 10n ** 15n, 1), "base");
    ok(c3.kind === "eth" && Math.abs(c3.eth - 0.002) < 1e-12, "[badges usd] native ETH (address(0)) in: ETH amount, price comes from the daily table: " + JSON.stringify(c3));
    const c4 = classifySwap(ev(OTHER, WETH, 1, 3n * 10n ** 18n), "base");
    ok(c4.kind === "eth" && c4.eth === 3, "[badges usd] WETH out counts as ETH side");
    const c5 = classifySwap(ev(OTHER, OTHER2, 10n ** 30n, 10n ** 30n), "base");
    ok(c5.kind === "skip", "[badges usd] neither side ETH/stable: not counted (skip), however large the amounts");
    const c6 = classifySwap(ev("0x5fc5360d0400a0fd4f2af552add042d716f1d168", OTHER, 9_000_000, 1), "rh");
    ok(c6.kind === "usd" && c6.usd === 9, "[badges usd] Robinhood USDG is a 6-decimal stable");
    const c7 = classifySwap(ev(R.weth, OTHER, 10n ** 18n, 1), "rh");
    ok(c7.kind === "eth", "[badges usd] Robinhood WETH is the ETH side there");
    ok(classifySwap(ev(USDC, OTHER, 1, 1), "rh").kind === "skip", "[badges usd] a Base stable address means nothing on Robinhood (per-chain lists)");
  }
  // ---------- اشتقاقِ نشان‌ها، dedupe، ten، stock ----------
  {
    const r = emptyUser();
    ok(applyCounted(r, "base", "0xaa", 1, 1000, OTHER) && r.n === 1 && r.first && r.base && !r.rh && !r.stock && !r.ten, "[badges derive] one Base swap -> first + base only");
    ok(!applyCounted(r, "base", "0xaa", 1, 1000, OTHER) && r.n === 1, "[badges derive] the same chain:tx:logIndex is never counted twice (dedupe)");
    applyCounted(r, "rh", "0xbb", 0, 2000, OTHER);
    ok(r.rh && r.rh.c === "rh" && r.first.ts === 1000, "[badges derive] a Robinhood swap gives rh; first stays the earliest");
    applyCounted(r, "base", "0xcc", 0, 3000, TSLA.toUpperCase().replace("0X", "0x"));
    ok(r.stock && r.stock.tx === "0xcc", "[badges derive] stock = Base swap whose tokenOut is in the B20 list (case-insensitive)");
    const r2 = emptyUser();
    applyCounted(r2, "rh", "0xdd", 0, 10, TSLA);
    ok(!r2.stock, "[badges derive] a stock address on Robinhood is not a stock badge (Base list only)");
    for (let i = 0; i < 8; i++) applyCounted(r, "base", "0xe" + i, 0, 4000 + i, OTHER);
    ok(r.n === 11 && r.ten, "[badges derive] ten appears at the tenth counted swap");
    ok(r.ten && r.ten.ts === [1000, 2000, 3000, 4000, 4001, 4002, 4003, 4004, 4005, 4006][9], "[badges derive] ten carries the timestamp of the 10th swap in time, not in processing order: " + JSON.stringify(r.ten));
    const r3 = emptyUser();
    for (let i = 0; i < 9; i++) applyCounted(r3, "base", "0xf" + i, 0, 100 + i, OTHER);
    ok(!r3.ten && badgesDoc(u(9), r3, { base: { complete: true }, rh: { complete: true } }).progress.ten === 9, "[badges derive] nine swaps: no ten, progress 9");
    const r4 = emptyUser();
    applyCounted(r4, "base", "0x01", 5, 50, OTHER, { x: "ex", b: 10, i: 5 });
    ok(!applyCounted(r4, "base", "0x02", 4, 50, OTHER, { x: "ex", b: 10, i: 4 }) && !applyCounted(r4, "base", "0x03", 9, 50, OTHER, { x: "ex", b: 9, i: 9 }) && r4.n === 1,
      "[badges derive] the per-executor watermark skips a replayed earlier position even when seen[] has rolled over");
    ok(JSON.stringify(Object.keys(emptyUser()).sort()) === JSON.stringify(["base", "first", "n", "rh", "seen", "stock", "ten", "ts10", "v", "w"]), "[badges derive] user record shape {v,n,first,base,rh,stock,ten,seen}+ts10,w");
  }
  // ---------- گذر: شمارش، cursor، شکست ----------
  {
    const W = world({ blockTs: {} });
    const tsA = T("2026-11-09");
    W.logs = [
      mkLog(V5, u(1), USDC, OTHER, 20_000_000, 1, 1000010, 0, tsA),                // $20 شمرده
      mkLog(V5, u(2), ZERO, OTHER, 10n ** 16n, 1, 1000020, 0, tsA),                 // 0.01 ETH × 3000 = $30 شمرده
      mkLog(V5, u(2), ZERO, OTHER, 10n ** 15n, 1, 1000021, 0, tsA),                 // 0.001 ETH = $3 نه
      mkLog(V5, u(3), OTHER, OTHER2, 10n ** 30n, 10n ** 30n, 1000022, 0, tsA),         // هیچ‌کدام: نه
      mkLog(V6, u(1), USDC, TSLA, 10_000_000, 5, 1000060, 0, T("2026-11-10")),      // سهام
      mkLog(V6, u(4), USDC, OTHER, 4_990_000, 5, 1000061, 0, T("2026-11-10")),      // $4.99 نه
    ];
    for (let i = 0; i < 10; i++) W.logs.push(mkLog(i < 5 ? V5 : V6, u(5), USDC, OTHER, 6_000_000, 1, i < 5 ? 1000030 + i : 1000070 + i, 0, i < 5 ? tsA : T("2026-11-10")));
    const kv = makeKv();
    const res = await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(res && res.rpc <= BADGES_RPC_MAX, "[badges budget] one pass uses at most " + BADGES_RPC_MAX + " RPC calls, used " + (res && res.rpc));
    ok(curOf(kv, V5) === String(1000090) && curOf(kv, V6) === String(1000090), "[badges cursor] after a clean pass both Base cursors sit at head-10: " + curOf(kv, V5) + "/" + curOf(kv, V6));
    ok(kv.m.get("badges:start:base:" + V5.addr) === "1000000" && kv.m.get("badges:start:base:" + V6.addr) === "1000040", "[badges start] Base start blocks come from the creation receipts and are cached in KV");
    const a1 = userOf(kv, 1), a2 = userOf(kv, 2), a3 = userOf(kv, 3), a4 = userOf(kv, 4), a5 = userOf(kv, 5);
    ok(a1 && a1.n === 2 && a1.first && a1.base && a1.stock && !a1.ten && !a1.rh, "[badges pass] a USDC swap and a USDC->TSLAc swap: first, base, stock; no ten");
    ok(a2 && a2.n === 1, "[badges pass] ETH swap: 0.01 ETH x the day's close = $30 counted, 0.001 ETH = $3 not counted");
    ok(a3 === null && a4 === null, "[badges pass] a swap with neither side ETH/stable, and a $4.99 swap, write no record at all");
    ok(a5 && a5.n === 10 && a5.ten && a5.ten.ts === T("2026-11-10") && a5.ten.c === "base", "[badges pass] ten across v5 then v6: the 10th swap's own timestamp");
    ok(W.calls.some((c) => c.m === "eth_getLogs" && c.url === "https://base.test/rpc"), "[badges pass] Base logs go through the injected Base RPC list");
    ok(!W.calls.some((c) => c.m === "eth_getLogs" && c.rh && c.url.includes("base")), "[badges pass] chains never mix endpoints");
    ok(W.gtCalls.length === 2 && /ohlcv\/day/.test(W.gtCalls[1]) && W.ohlcvPool.includes("0x" + "22".repeat(20)), "[badges eth] the ETH-USD table comes from one pool lookup + one daily OHLCV call (the deepest WETH/USDC pool): " + W.gtCalls.length);
    ok(kv.m.get("badges:ethusd:2026-11-09") === "3000", "[badges eth] a finished day's close is cached under badges:ethusd:<date>");
    const st = JSON.parse(kv.m.get("badges:status"));
    ok(st.base && st.base.cursor === 1000090 && st.base.head === 1000100 && st.base.complete === true, "[badges status] Base status is complete when the cursor is within an hour of head: " + JSON.stringify(st.base));
    ok(st.rh && st.rh.complete === false, "[badges status] Robinhood is not complete before its start block is resolved");
    // بازپخشِ همان گذر با cursor پاک‌شده: هیچ سواپی دوبار شمرده نمی‌شود
    const before = JSON.stringify([...kv.m.entries()].filter(([k]) => k.startsWith("badge:u:")));
    kv.m.delete("badges:cur:base:" + V5.addr); kv.m.delete("badges:cur:base:" + V6.addr);
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    const after = JSON.stringify([...kv.m.entries()].filter(([k]) => k.startsWith("badge:u:")));
    ok(before === after, "[badges dedupe] re-reading the whole history (cursor lost) changes no user record");
    // کارتِ دوم: دومین گذر فقط همان یک ohlcv را از KV می‌گیرد
    const gt0 = W.gtCalls.length;
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(W.gtCalls.length === gt0, "[badges eth] cached days need no GeckoTerminal call");
  }
  {
    // شکستِ RPC: cursor جلو نمی‌رود، رکوردی نوشته نمی‌شود
    const W = world({ failLogs: true });
    W.logs = [mkLog(V5, u(1), USDC, OTHER, 20_000_000, 1, 1000010, 0, T("2026-11-09"))];
    const kv = makeKv();
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(curOf(kv, V5) === undefined && curOf(kv, V5) !== "1000090" && !userOf(kv, 1), "[badges unknown] a failed getLogs advances no cursor and writes no record (a failed read is never 'no swaps'): " + curOf(kv, V5));
    const st = JSON.parse(kv.m.get("badges:status"));
    ok(st.base.complete === false, "[badges unknown] and the chain is reported incomplete (pending), not complete");
    W.failLogs = false;
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(userOf(kv, 1) && userOf(kv, 1).n === 1, "[badges unknown] the next healthy pass reads the same range and counts the swap");
  }
  {
    // ۲۴ نوامبر — قاعده عوض شد (قبلاً این آزمون «تا بسته‌ی روز صبر کن» را پین می‌کرد): سواپِ اتریِ امروز با بسته‌ی ساعتِ تمام‌شده‌اش شمرده می‌شود؛
    // سواپِ داخلِ ساعتِ جاری (هنوز بسته نشده) نامعلوم است و cursor پیش از آن بلاک می‌ایستد
    const W = world();
    W.gtDays["2026-11-24"] = 2500;
    const today = Math.floor(NOW / 1000) - 60;   // داخلِ ساعتِ جاری
    const doneHour = Math.floor((Math.floor(NOW / 1000) - 7200) / 3600) * 3600;
    W.gtHours = { [doneHour]: 2600 };
    W.logs = [
      mkLog(V5, u(1), USDC, OTHER, 20_000_000, 1, 1000010, 0, T("2026-11-09")),
      mkLog(V5, u(2), ZERO, OTHER, 10n ** 17n, 1, 1000020, 0, today),                // ساعتِ جاری: هنوز بسته‌ای نیست
      mkLog(V5, u(3), USDC, OTHER, 30_000_000, 1, 1000030, 0, T("2026-11-09")),
    ];
    const kv = makeKv();
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(curOf(kv, V5) === "1000019", "[badges unknown] an ETH swap inside the still-open hour has no close yet: the cursor stops one block before it, got " + curOf(kv, V5));
    ok(userOf(kv, 1) && !userOf(kv, 2) && !userOf(kv, 3), "[badges unknown] earlier swaps are recorded, the unpriced one and everything after it wait");
    ok(curOf(kv, V6) === undefined, "[badges unknown] v6 is not read until v5 is fully read (time order)");
    const later = { ...DEPS(), now: () => NOW + 86400_000 };
    {
      // همان روز، ساعتِ تمام‌شده: با بسته‌ی ساعتی ($2600 × 0.1 = $260) بی‌انتظار شمرده می‌شود
      const W3 = world(); W3.gtHours = { [doneHour]: 2600 };
      W3.logs = [mkLog(V5, u(4), ZERO, OTHER, 10n ** 17n, 1, 1000020, 0, doneHour + 120)];
      const kv3 = makeKv();
      await withWorld(W3, () => runBadgesPass({ ZX_KV: kv3 }, DEPS()));
      ok(userOf(kv3, 4) && userOf(kv3, 4).n === 1 && W3.gtCalls.some((c) => /ohlcv\/hour/.test(c)), "[badges hour] today's ETH swap in a finished hour counts from that hour's close, without waiting for the day");
      const W4 = world(); W4.gtHours = {};
      W4.logs = [mkLog(V5, u(4), ZERO, OTHER, 10n ** 17n, 1, 1000020, 0, doneHour + 120)];
      const kv4 = makeKv();
      await withWorld(W4, () => runBadgesPass({ ZX_KV: kv4 }, DEPS()));
      ok(!userOf(kv4, 4) && curOf(kv4, V5) === "1000019", "[badges hour] a missing hourly close is unknown, never zero: the cursor waits");
    }
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, later));
    ok(userOf(kv, 2) && userOf(kv, 2).n === 1 && userOf(kv, 3) && curOf(kv, V5) === "1000090", "[badges unknown] once the day is over and its close is known, the ETH swap counts ($250) and the cursor moves on");
    // GT خراب برای روزِ تمام‌شده هم نامعلوم است
    const W2 = world({ gtOk: false });
    W2.logs = [mkLog(V5, u(2), ZERO, OTHER, 10n ** 17n, 1, 1000020, 0, T("2026-11-09"))];
    const kv2 = makeKv();
    await withWorld(W2, () => runBadgesPass({ ZX_KV: kv2 }, DEPS()));
    ok(curOf(kv2, V5) === "1000019" && !userOf(kv2, 2), "[badges unknown] a price source that fails is unknown, never zero: no record, cursor before the swap");
  }
  {
    // بلاک‌زمان از eth_getBlockByNumber وقتی لاگ زمان ندارد؛ شکستش هم «نامعلوم» است
    const W = world();
    W.logs = [mkLog(V5, u(1), USDC, OTHER, 20_000_000, 1, 1000010, 0, null)];
    const kv = makeKv();
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(!userOf(kv, 1) && curOf(kv, V5) === "1000009", "[badges unknown] no blockTimestamp and the block lookup fails: stop before that block");
    W.blockTs[1000010] = T("2026-11-09");
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(userOf(kv, 1) && userOf(kv, 1).first.ts === T("2026-11-09"), "[badges ts] the timestamp comes from eth_getBlockByNumber when the log has none");
  }
  {
    // خطای بازه: span نصف می‌شود، در KV می‌ماند، cursor جلو می‌رود
    const W = world({ maxSpan: 30000, head: 1060100 });
    W.logs = [mkLog(V5, u(1), USDC, OTHER, 20_000_000, 1, 1000010, 0, T("2026-11-09"))];
    const kv = makeKv();
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(kv.m.get("badges:span:base") === "25000", "[badges span] a range error halves 50000 -> 25000 and the working span is remembered in KV: " + kv.m.get("badges:span:base"));
    ok(curOf(kv, V5) === "1060090" && userOf(kv, 1), "[badges span] and the pass still reads everything: " + curOf(kv, V5));
    const W2 = world({ maxSpan: 100, head: 1060100 });
    W2.logs = [];
    const kv2 = makeKv();
    await withWorld(W2, () => runBadgesPass({ ZX_KV: kv2 }, DEPS()));
    ok(curOf(kv2, V5) === undefined && Number(kv2.m.get("badges:span:base")) >= 500, "[badges span] the span never goes below 500 and a hopeless range moves no cursor");
  }
  {
    // بودجه: تاریخچه‌ی بلند با span کوچک — سقفِ ۲۰ تماس ثابت می‌ماند و cursor تا همان‌جا می‌رود
    const W = world({ head: 1500000 });
    const kv = makeKv();
    kv.m.set("badges:span:base", "500");
    const res = await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    ok(res.rpc <= BADGES_RPC_MAX && W.calls.filter((c) => !c.rh).length + W.calls.filter((c) => c.rh).length <= BADGES_RPC_MAX, "[badges budget] a long backlog still stops at " + BADGES_RPC_MAX + " RPC calls (" + W.calls.length + ")");
    const cur = Number(curOf(kv, V5));
    ok(cur > 1000000 && cur < 1499990, "[badges budget] and the cursor moved only over what was read: " + cur);
    ok(JSON.parse(kv.m.get("badges:status")).base.complete === false, "[badges budget] with a backlog the chain is not complete");
  }
  // ---------- Robinhood: شروعِ بلاک با جست‌وجوی دودویی، قابلِ ادامه ----------
  {
    const W = world({ rhHead: 700, rhDeploy: 337 });
    W.rhLogs = [mkLog(RHX, u(7), R.stables[0], OTHER, 8_000_000, 1, 400, 0, T("2026-11-09"))];
    const kv = makeKv();
    await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    const rhCalls1 = W.calls.filter((c) => c.rh).length;
    ok(rhCalls1 <= 8, "[badges rh] Robinhood gets its own cap of 8 calls per pass, used " + rhCalls1);
    for (let i = 0; i < 3; i++) await withWorld(W, () => runBadgesPass({ ZX_KV: kv }, DEPS()));
    const raw = kv.m.get("badges:start:rh:" + RHX.addr);
    ok(raw && /^\d+$/.test(raw) && Number(raw) === 337, "[badges rh] the first block with code is found by binary search on eth_getCode (337): " + raw);
    ok(userOf(kv, 7) && userOf(kv, 7).rh && userOf(kv, 7).first && !userOf(kv, 7).base, "[badges rh] USDG swap on Robinhood: rh + first, never base");
    const W2 = world({ rhHead: 20000, rhDeploy: 9001 });
    const kv2 = makeKv();
    await withWorld(W2, () => runBadgesPass({ ZX_KV: kv2 }, DEPS()));
    const st = kv2.m.get("badges:start:rh:" + RHX.addr);
    ok(st && st.startsWith("{") && JSON.parse(st).hi > JSON.parse(st).lo + 1, "[badges rh] a search that runs out of budget saves {lo,hi} and resumes (no guess): " + st);
    for (let i = 0; i < 4; i++) await withWorld(W2, () => runBadgesPass({ ZX_KV: kv2 }, DEPS()));
    ok(kv2.m.get("badges:start:rh:" + RHX.addr) === "9001", "[badges rh] resumed passes converge on the exact first block with code: " + kv2.m.get("badges:start:rh:" + RHX.addr));
  }
  // ---------- نقطه‌های پایانی ----------
  {
    const kv = makeKv();
    const A = u(0xabc1);
    const rec = emptyUser();
    applyCounted(rec, "base", "0xaa", 0, T("2026-11-10"), OTHER);
    kv.m.set("badge:u:" + A, JSON.stringify(rec));
    kv.m.set("badges:status", JSON.stringify({ base: { cursor: 1, head: 1, complete: true }, rh: { cursor: null, head: null, complete: false } }));
    const env = { ZX_KV: kv };
    const get = (p, init) => worker.fetch(new Request("https://zaexa.com" + p, init), env, { waitUntil() {} });
    const r = await get("/badges/" + A + ".json");
    const j = await r.json();
    ok(r.status === 200 && r.headers.get("x-robots-tag") === "noindex" && /public/.test(r.headers.get("cache-control")) && /max-age=60/.test(r.headers.get("cache-control")), "[badges json] 200, Cache-Control public 60s, X-Robots-Tag noindex: " + r.headers.get("cache-control"));
    ok(j.address === A && j.n === 1 && j.complete.base === true && j.complete.rh === false && j.badges.length === 5 && j.progress.ten === 1, "[badges json] shape {address,complete,n,badges,progress}: " + JSON.stringify(j).slice(0, 200));
    const by = Object.fromEntries(j.badges.map((b) => [b.id, b]));
    ok(JSON.stringify(j.badges.map((b) => b.id)) === JSON.stringify(BADGE_IDS), "[badges json] the five ids in order");
    ok(by.base.state === "got" && by.base.got === true && by.base.chain === "base" && by.base.tx === "0xaa" && by.base.ts === T("2026-11-10"), "[badges json] a got badge carries ts/tx/chain");
    ok(by.first.state === "got", "[badges json] first is got");
    ok(by.stock.state === "none" && by.stock.got === false, "[badges json] stock on a complete Base: state none");
    ok(by.rh.state === "pending" && by.ten.state === "pending", "[badges json] an incomplete chain makes a not-got badge 'pending', never 'none' (rh, and ten which needs both chains)");
    for (const bad of ["/badges/0x123.json", "/badges/" + A.slice(0, 41) + ".json", "/badges/" + A + "0.json", "/badges/0x" + "g".repeat(40) + ".json", "/badges/" + A + "/", "/badges/" + A + ".json/x", "/badges", "/badges/", "/badges/index", "/badges/list", "/badges/art/nope.svg", "/badges/art/__proto__.svg", "/badges/art/first.png", "/badges/art/nope-off.svg", "/badges/art/first-off-off.svg", "/badges/art/__proto__-off.svg", "/badges/art/first-OFF.svg"]) {
      const x = await get(bad);
      ok(x.status === 404 && x.headers.get("x-robots-tag") === "noindex", "[badges json] strict validation / no index: " + bad + " -> " + x.status);
    }
    const post = await get("/badges/" + A + ".json", { method: "POST" });
    ok(post.status === 405, "[badges json] POST is refused");
    const none = await (await get("/badges/" + u(0xdead) + ".json")).json();
    ok(none.n === 0 && none.badges.find((b) => b.id === "base").state === "none" && none.badges.find((b) => b.id === "rh").state === "pending", "[badges json] an unknown wallet on a complete Base: base none, rh pending (rh is still being read)");
    const e503 = await worker.fetch(new Request("https://zaexa.com/badges/" + A + ".json"), { ZX_KV: { get: async () => { throw new Error("kv down"); } } }, { waitUntil() {} });
    ok(e503.status === 503 && !/public/.test(e503.headers.get("cache-control") || ""), "[badges json] a KV failure is a 503 that is not cached, never an all-'none' answer");
    // صفحه
    const pr = await get("/badges/" + A);
    const html = await pr.text();
    ok(pr.status === 200 && /text\/html/.test(pr.headers.get("content-type")) && pr.headers.get("x-robots-tag") === "noindex", "[badges page] 200 html with X-Robots-Tag noindex");
    ok(/<meta name="robots" content="noindex">/.test(html), "[badges page] <meta name=robots content=noindex>");
    ok(/<meta property="og:title" content="Zaexa badges">/.test(html) && /<meta property="og:description" content="2 of 5 Zaexa badges">/.test(html) && /<meta property="og:image" content="https:\/\/zaexa\.com\/badges\/og\.png">/.test(html) && /<meta name="twitter:card" content="summary_large_image">/.test(html), "[badges page] og:title, og:description '<n> of 5 Zaexa badges', og:image, twitter:card");
    ok(html.includes(A.slice(0, 6) + "…" + A.slice(-4)) && !html.includes(A), "[badges page] the short address on screen, the full address nowhere in the page");
    ok((html.match(/0x[0-9a-fA-F]{40}/g) || []).length === 0 && !/href="\/badges/.test(html), "[badges page] no wallet address and no link to other wallets or badge pages");
    ok(BADGE_IDS.every((id) => /\/badges\/art\/[a-z]+(-off)?\.svg/.test(html) && html.includes("/badges/art/" + id) && html.includes(BADGE_TITLES[id])) && html.includes("Not yet") && html.includes("Still reading history") && html.includes("Nov 10, 2026"), "[badges page] five medals with titles, 'Not yet' / 'Still reading history' / date");
    ok(/href="\/app"[^>]*>Open Zaexa</.test(html) && html.includes("Zaexa badges"), "[badges page] 'Open Zaexa' goes to /app");
    ok((html.match(/class="medal off"/g) || []).length === 3, "[badges page] the three not-got medals are dimmed");
    ok(html.includes("#0a0810"), "[badges page] dark palette");
    ok((html.match(/\/badges\/art\/[a-z]+-off\.svg/g) || []).length === 3 && (html.match(/\/badges\/art\/[a-z]+\.svg/g) || []).length === 2 && !/grayscale/i.test(html), "[badges page] the three not-got medals use the -off art file, the two got ones the earned art, and the page CSS has no grayscale");
    // هنر
    const art = await get("/badges/art/first.svg?v=" + BADGE_ART_VERSION);
    ok(art.status === 200 && art.headers.get("content-type").startsWith("image/svg+xml") && /immutable/.test(art.headers.get("cache-control")) && art.headers.get("x-robots-tag") === "noindex" && (await art.text()) === BADGE_SVG.first, "[badges art] svg served from badge-art.js with a long cache for the versioned URL");
    const off = await get("/badges/art/first-off.svg?v=" + BADGE_ART_VERSION);
    ok(off.status === 200 && off.headers.get("content-type").startsWith("image/svg+xml") && (await off.text()) === BADGE_SVG_OFF.first, "[badges art off] first-off.svg serves the locked art from BADGE_SVG_OFF");
    {
      const bad = [];
      for (const [mapName, map] of [["BADGE_SVG", BADGE_SVG], ["BADGE_SVG_OFF", BADGE_SVG_OFF]]) {
        for (const [id, svg] of Object.entries(map)) {
          const tag = mapName + "." + id;
          if (!svg.startsWith("<svg")) bad.push(tag + " start");
          if (!svg.includes('viewBox="0 0 200 200"')) bad.push(tag + " viewBox");
          if (/<text/i.test(svg) || /font-family/i.test(svg) || /<script/i.test(svg) || /\son[a-z]+=/i.test(svg)) bad.push(tag + " forbidden markup");
          if (/http/i.test(svg.split("http://www.w3.org/2000/svg").join(""))) bad.push(tag + " external url");
          if (mapName === "BADGE_SVG" && !svg.includes('class="lt" pathLength="1"')) bad.push(tag + " no light line");
          if (mapName === "BADGE_SVG_OFF" && svg.includes('class="lt"')) bad.push(tag + " has light line");
        }
      }
      ok(bad.length === 0 && Object.keys(BADGE_SVG).length === 5 && Object.keys(BADGE_SVG_OFF).length === 5, "[badges art shape] all 10 svgs: 200x200 viewBox, no text/fonts/script/handlers/external urls; earned have class lt pathLength 1, locked have none " + bad.join(","));
    }
    const og = await get("/badges/og.png");
    const bytes = new Uint8Array(await og.arrayBuffer());
    ok(og.status === 200 && og.headers.get("content-type") === "image/png" && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length === Buffer.from(OG_PNG_PARTS.join(""), "base64").length, "[badges art] og.png decodes from the base64 parts in badge-art.js");
    ok(read("./badge-art.js").includes("OG_PNG_PARTS") && !/"\s*\+\s*"/.test(read("./badge-art.js").slice(0, 100000)), "[badges art] the og.png base64 is an array joined with '', not a '+' chain");
    // سایت‌مپ
    const savedSm = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    let smx = "";
    try { smx = await (await sitemapResponse(new URL("https://zaexa.com/sitemap.xml"), { ZX_KV: kv }, { waitUntil() {} })).text(); } finally { globalThis.fetch = savedSm; }
    ok(smx.includes("<loc>https://zaexa.com/app</loc>"), "[badges sitemap] the sitemap itself was built (so the absence below means something)");
    ok(!/badges/i.test(smx), "[badges sitemap] /badges never appears in the sitemap");
    const rb = await get("/robots.txt");
    ok(!/badges/i.test(await rb.text()), "[badges robots] robots.txt does not block /badges (the crawler must be able to read noindex)");
  }
  // ---------- واژه‌های ممنوع ----------
  {
    const bj = read("./badges.js");
    ok(!BAN.test(bj), "[badges words] worker/badges.js has none of: points, reward(s), eligible, airdrop, season, earn(ed): " + (BAN.exec(bj) || [""])[0]);
    const html = badgePageHtml(u(1), badgesDoc(u(1), emptyUser(), {}));
    ok(!BAN.test(html), "[badges words] the badge page HTML has none of the banned words");
    ok(!BAN.test(Object.values(BADGE_TITLES).join(" ")), "[badges words] the badge titles have none of the banned words");
    ok(BAN.test("Earned 5 points") && BAN.test("airdrop") && !BAN.test("endpoint") && !BAN.test("earlier"), "[badges words] the scan itself catches the words and does not trip on endpoint/earlier");
  }
  // ---------- برابریِ فهرستِ سهام با web/index.html ----------
  {
    const idx = read("../web/index.html");
    const found = [...idx.matchAll(/\{symbol:"([A-Z]+c)",name:"[^"]*",address:"(0x[0-9a-fA-F]{40})",decimals:8\}/g)].map((m) => m[2].toLowerCase());
    const mine = [...BASE_STOCKS].sort(), theirs = [...found].sort();
    ok(found.length === 13 && JSON.stringify(mine) === JSON.stringify(theirs), "[badges stocks] the worker's B20 list equals the BASE_TOKENS stock rows of web/index.html (" + found.length + " vs " + BASE_STOCKS.length + ")");
    ok(BASE_STOCKS.includes("0xb20000000000000000000016e38fd364d271ba28") && new Set(BASE_STOCKS).size === 13, "[badges stocks] 13 distinct addresses incl. ANTc");
    const apptitles = /BADGE_DEF=\[([\s\S]*?)\];/.exec(idx);
    ok(!!apptitles && BADGE_IDS.every((id) => apptitles[1].includes('"' + BADGE_TITLES[id] + '"')), "[badges stocks] the app's badge titles equal the worker's");
  }
  // ---------- scheduled(): دو کرون ----------
  {
    const kv = makeKv();
    const W = world();
    W.logs = [mkLog(V5, u(1), USDC, OTHER, 20_000_000, 1, 1000010, 0, T("2026-11-09"))];
    const saved = globalThis.fetch;
    globalThis.fetch = (url, init) => W.fetch(url, init);
    const waited = [];
    try {
      await worker.scheduled({ cron: "47 * * * *" }, { ZX_KV: kv, BASE_RPC: "https://base.test/rpc" }, { waitUntil: (p) => waited.push(p) });
    } finally { globalThis.fetch = saved; }
    ok(kv.m.has("badges:status") && !kv.m.has("report:passlog"), "[badges cron] the 47-minute cron runs the badges pass and nothing of the report pass");
    const kv2 = makeKv();
    const saved2 = globalThis.fetch;
    globalThis.fetch = async (url) => (String(url).includes("/new_pools") ? Response.json({ data: [] }) : new Response("{}", { status: 200 }));
    try { await worker.scheduled({ cron: "17 * * * *" }, { ZX_KV: kv2 }, { waitUntil() {} }); } finally { globalThis.fetch = saved2; }
    ok(kv2.m.has("report:passlog") && !kv2.m.has("badges:status"), "[badges cron] the 17-minute cron is the unchanged report pass and writes no badges key");
    const tml = read("../wrangler.toml");
    ok(/crons = \["17 \* \* \* \*", "47 \* \* \* \*"\]/.test(tml), "[badges cron] wrangler.toml lists both crons");
  }
  // ---------- هیچ فهرستی از کیف‌ها ----------
  {
    const bj = read("./badges.js");
    ok(!/\.list\(/.test(bj), "[badges privacy] worker/badges.js never calls KV list (no enumeration of wallets)");
    ok(!/(?:\/ev|"ev")/.test(bj) && !/Solana|solana/.test(bj.replace(/\/\*[\s\S]*?\*\//g, "")), "[badges privacy] no new /ev event name and no Solana badge");
  }
  void scheduledBadgesPass; void baseRpcList; void brk;
  console.log("[badges] topic0 from signatures (and from SwapExecutor.sol), v5/v6 decode, usd rule (stable 6dp, ETH x daily close, >= $5, neither side not counted), derivation (first/base/rh/stock/ten, dedupe, watermark), unknown is never no (RPC failure, unknown price, missing timestamp, range errors), 20-call budget, Robinhood resumable start search, /badges json+page+art+og (noindex, validation, pending, no enumeration), sitemap/robots, banned words, B20 parity, two-cron dispatch");
}
