/* =====================================================================
   «Token facts» برای /t/<آدرس> — ایندکسِ هم‌نام و خواندنِ ردیف‌های گزارش
   =====================================================================
   دو کار، هر دو فقط روی داده‌ای که خودمان از قبل در KV داریم (report:<تاریخ>):
   ۱) ایندکس: هر روزِ گزارش یک بار در ایندکسِ نام/نماد و ایندکسِ توکن ادغام
      می‌شود (گذرِ ساعتیِ دقیقه‌ی ۱۷، یک روز در هر گذر، هیچ تماسِ بالادستی).
   ۲) tokFacts: برای صفحه‌ی یک توکن — ردیف‌های همان توکن در روزهای گزارش،
      و «چند توکنِ دیگر همین نام/نماد را داشتند». همه چیز زیرِ مهلتِ
      OG_BUDGET_MS؛ هر خطا/تایم‌اوت → null و صفحه دقیقاً مثلِ قبل رندر می‌شود.

   قاعده‌های ثابت:
   • هر ردیفِ گزارش پیش از استفاده از publishGuardRow رد می‌شود — همان گاردِ
     مسیرِ /report/<تاریخ>.json (nosellِ بی‌علت «تأییدنشده»، سولانا هرگز nosell).
   • ادغام idempotent است: دوباره ادغام‌کردنِ یک روز شمارش‌ها را عوض نمی‌کند.
   • شمارشِ «توکنِ متمایز» از روی هشِ آدرس (۱۲ نویسه‌ی آخر) است، نه تعدادِ ردیف. */

import { publishGuardRow, REPORT_TEXT_FIRST_DATE, reportKey, utcDateOf } from "./report.js";
import { EVM_ADDR, SOL_MINT } from "./chains.js";
import { ogClean } from "./og.js";

export const IDX_SHARDS = 16;          // ایندکسِ توکن (tidx:v1)
export const NIDX_SHARDS = 64;         // ایندکسِ نام/نماد (nidx:v2) — برای سقفِ CPUِ پارسِ هر شارد
export const IDX_STATE_KEY = "idx:v1:state";
export const IDX_NAME_MAX = 64;
export const IDX_SYMBOL_MAX = 32;
export const IDX_SAMPLES_MAX = 5;
export const IDX_TOKEN_DATES_MAX = 5;
/* اولین روزی که ایندکس می‌خواند — همان روزِ اولِ گزارشِ عمومی (report.js):
   روزهای پیش از آن ردیف‌های nosellِ نادرست دارند و هیچ مسیرِ عمومی نمی‌خواندشان. */
export const IDX_FIRST_DATE = REPORT_TEXT_FIRST_DATE;
export const TOKFACTS_MAX_KV_READS = 6;
export const TOKFACTS_MAX_DOCS = 3;

const nameShardKey = (i) => "nidx:v2:" + i;
const tokenShardKey = (i) => "tidx:v1:" + i;

/* ---------- ابزارهای خالص ---------- */

/* نویسه‌های کنترلی و bidi — همان کلاسی که اپ پاک می‌کند (web/index.html label())،
   به‌علاوه‌ی نشانه‌های جهت (LRM/RLM/ALM) */
const STRIP_RE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/* نرمال‌سازیِ نام/نماد برای مقایسه: NFKC، حذفِ کنترل/bidi، یک‌فاصله، trim، lowercase؛
   سقفِ طول بر حسبِ نقطه‌کد. خالی → null. */
export function norm(s, max) {
  if (typeof s !== "string") return null;
  let t;
  try { t = s.normalize("NFKC"); } catch (e) { return null; }
  t = t.replace(STRIP_RE, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return null;
  const cap = Number.isInteger(max) && max > 0 ? max : IDX_NAME_MAX;
  const cps = Array.from(t);
  if (cps.length > cap) t = cps.slice(0, cap).join("").trim();
  return t || null;
}
export const normName = (s) => norm(s, IDX_NAME_MAX);
export const normSymbol = (s) => norm(s, IDX_SYMBOL_MAX);

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/* ⚠️ بیتِ پایینِ FNV-1a فقط به نیمه‌بایتِ پایینِ هر نویسه بستگی دارد (ضربِ فرد پیمانه‌ی ۱۶ دوسویه است) —
   «n|x» و «s|x» هرگز در یک شارد نمی‌نشستند و نویسه‌های هم‌نیم‌بایت همیشه برخورد می‌کردند. پس ۱۶ بیتِ بالا
   روی ۱۶ بیتِ پایین تا می‌شود، بعد پیمانه‌ی ۱۶. */
const foldHash = (key) => { const h = fnv1a32(key); return (h ^ (h >>> 16)) >>> 0; };
export const shardOf = (key) => foldHash(key) % IDX_SHARDS;
export const nameShardOf = (key) => foldHash(key) % NIDX_SHARDS;

/* کلیدِ توکن: Base با حروفِ کوچک، سولانا همان‌طور که هست */
export function tokenKeyOf(chain, addr) {
  return chain + ":" + (chain === "base" ? String(addr).toLowerCase() : String(addr));
}
/* هشِ آدرس برای شمارشِ متمایز: "b"/"s" + ۱۲ نویسه‌ی آخر */
export function addrHash(chain, addr) {
  const a = chain === "base" ? String(addr).toLowerCase() : String(addr);
  return (chain === "base" ? "b" : "s") + a.slice(-12);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => (n < 10 ? "0" : "") + n;
export function addDays(d, n) {
  return new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
export function dateOk(d) {
  return typeof d === "string" && DATE_OK.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z")) && addDays(d, 0) === d;
}
/* "5 Nov" از "2026-11-05" */
export function fmtDay(d) {
  return dateOk(d) ? (+d.slice(8, 10)) + " " + MON[+d.slice(5, 7) - 1] : null;
}
export function fmtDayYear(d) {
  const s = fmtDay(d);
  return s ? s + " " + d.slice(0, 4) : null;
}
function parts(iso) {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const x = new Date(ms);
  return { d: x.getUTCDate(), m: MON[x.getUTCMonth()], y: x.getUTCFullYear(), hm: pad2(x.getUTCHours()) + ":" + pad2(x.getUTCMinutes()) };
}
/* "5 Nov 14:05 UTC" — خطوطِ exit check */
export function fmtStamp(iso) { const p = parts(iso); return p ? p.d + " " + p.m + " " + p.hm + " UTC" : null; }
/* "5 Nov, 14:05 UTC" — داخلِ پرانتزِ «first check» */
export function fmtDayTime(iso) { const p = parts(iso); return p ? p.d + " " + p.m + ", " + p.hm + " UTC" : null; }
/* "5 Nov 2026, 14:05 UTC" — زمانِ ساختِ استخر */
export function fmtLong(iso) { const p = parts(iso); return p ? p.d + " " + p.m + " " + p.y + ", " + p.hm + " UTC" : null; }

export function shortAddress(a) {
  const s = typeof a === "string" ? a : "";
  return s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
}

/* برچسبِ صرافی — فقط idهای واقعیِ GeckoTerminal که در کد/فیکسچرها دیده شده
   (GT_DEX_TO_VENUE، تست‌های گزارش) به‌علاوه‌ی idهای سولانا. ناشناخته → خودِ id. */
export const DEX_LABELS = Object.freeze({
  "uniswap-v2-base": "Uniswap V2",
  "uniswap-v3-base": "Uniswap V3",
  "uniswap-v4-base": "Uniswap V4",
  "aerodrome-base": "Aerodrome",
  "aerodrome-slipstream": "Aerodrome Slipstream",
  "aerodrome-slipstream-2": "Aerodrome Slipstream",
  "aerodrome-slipstream-3": "Aerodrome Slipstream",
  "aero-slipstream-base": "Aerodrome Slipstream",
  "pancakeswap-v3-base": "PancakeSwap V3",
  "baseswap": "BaseSwap",
  "sushiswap-v2-base": "SushiSwap V2",
  "alien-base": "Alien Base",
  "raydium": "Raydium",
  "raydium-clmm": "Raydium CLMM",
  "pump-fun": "Pump.fun",
  "pumpswap": "PumpSwap",
  "meteora": "Meteora",
  "meteora-dbc": "Meteora DBC",
  "orca": "Orca",
});
export function dexLabel(id) {
  if (typeof id !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(DEX_LABELS, id)) return DEX_LABELS[id];
  return ogClean(id, 40);
}

/* ---------- آیکونِ چیپِ سولانا ----------
   عیناً همان SVGی که کلاینت در #tk-chip می‌نشاند (paintReportNetwork در web/index.html:
   کپیِ آیکونِ #srcOptSolana، با id گرادیان + «Report» و ارجاع‌های url(#…) هم‌نام). */
export const SOL_CHIP_SVG =
  '<svg width="18" height="18" aria-hidden="true" viewBox="0 0 101 88" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M100.48 69.3817L83.8068 86.8015C83.4444 87.1799 83.0058 87.4816 82.5185 87.6878C82.0312 87.894 81.5055 88.0003 80.9743 88H1.93563C1.55849 88 1.18957 87.8926 0.874202 87.6912C0.558829 87.4897 0.31074 87.2029 0.160416 86.8659C0.0100923 86.529 -0.0359181 86.1566 0.0280382 85.7945C0.0919944 85.4324 0.263131 85.0964 0.520422 84.8278L17.2061 67.408C17.5676 67.0306 18.0047 66.7295 18.4904 66.5234C18.9762 66.3172 19.5002 66.2104 20.0301 66.2095H99.0644C99.4415 66.2095 99.8104 66.3169 100.126 66.5183C100.441 66.7198 100.689 67.0067 100.84 67.3436C100.99 67.6806 101.036 68.0529 100.972 68.415C100.908 68.7771 100.737 69.1131 100.48 69.3817ZM83.8068 34.3032C83.4444 33.9248 83.0058 33.6231 82.5185 33.4169C82.0312 33.2108 81.5055 33.1045 80.9743 33.1048H1.93563C1.55849 33.1048 1.18957 33.2121 0.874202 33.4136C0.558829 33.6151 0.31074 33.9019 0.160416 34.2388C0.0100923 34.5758 -0.0359181 34.9482 0.0280382 35.3103C0.0919944 35.6723 0.263131 36.0083 0.520422 36.277L17.2061 53.6968C17.5676 54.0742 18.0047 54.3752 18.4904 54.5814C18.9762 54.7875 19.5002 54.8944 20.0301 54.8952H99.0644C99.4415 54.8952 99.8104 54.7879 100.126 54.5864C100.441 54.3849 100.689 54.0981 100.84 53.7612C100.99 53.4242 101.036 53.0518 100.972 52.6897C100.908 52.3277 100.737 51.9917 100.48 51.723L83.8068 34.3032ZM1.93563 21.7905H80.9743C81.5055 21.7907 82.0312 21.6845 82.5185 21.4783C83.0058 21.2721 83.4444 20.9704 83.8068 20.592L100.48 3.17219C100.737 2.90357 100.908 2.56758 100.972 2.2055C101.036 1.84342 100.99 1.47103 100.84 1.13408C100.689 0.79713 100.441 0.510296 100.126 0.308823C99.8104 0.107349 99.4415 1.24074e-05 99.0644 0L20.0301 0C19.5002 0.000878397 18.9762 0.107699 18.4904 0.313848C18.0047 0.519998 17.5676 0.821087 17.2061 1.19848L0.524723 18.6183C0.267681 18.8866 0.0966198 19.2223 0.0325185 19.5839C-0.0315829 19.9456 0.0140624 20.3177 0.163856 20.6545C0.31365 20.9913 0.561081 21.2781 0.875804 21.4799C1.19053 21.6817 1.55886 21.7896 1.93563 21.7905Z" fill="url(#paint0_linear_174_4403Report)"/>' +
  '<defs><linearGradient id="paint0_linear_174_4403Report" x1="8.52558" y1="90.0973" x2="88.9933" y2="-3.01622" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0.08" stop-color="#9945FF"/><stop offset="0.3" stop-color="#8752F3"/><stop offset="0.5" stop-color="#5497D5"/>' +
  '<stop offset="0.6" stop-color="#43B4CA"/><stop offset="0.72" stop-color="#28E0B9"/><stop offset="0.97" stop-color="#19FB9B"/>' +
  "</linearGradient></defs></svg>";
export const SOL_CHIP_INNER = SOL_CHIP_SVG + "<span>Solana</span>";

/* ---------- ایندکس: ادغام ---------- */

/* YYYY-MM-DD ↔ YYYYMMDD (عددِ صحیح، برای کوچک‌ماندنِ شارد) */
const dateInt = (d) => +d.replace(/-/g, "");
const dateStr = (n) => { const t = String(n); return t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8); };

function emptyShard() { return { v: 1, e: {} }; }

async function readShard(kv, key) {
  const raw = await kv.get(key);
  if (raw == null) return emptyShard();
  if (typeof raw !== "string") throw new Error("idx:shape");
  const p = JSON.parse(raw);
  if (!p || p.v !== 1 || !p.e || typeof p.e !== "object" || Array.isArray(p.e)) throw new Error("idx:shape");
  return p;
}

export async function readState(kv) {
  const raw = await kv.get(IDX_STATE_KEY);
  if (raw == null) return { next: IDX_FIRST_DATE };
  if (typeof raw !== "string") throw new Error("idx:state");
  const p = JSON.parse(raw);
  if (!p || !dateOk(p.next)) throw new Error("idx:state");
  return { next: p.next < IDX_FIRST_DATE ? IDX_FIRST_DATE : p.next };
}

/* نمونه‌ی آخرین‌ها: upsert بر اساس آدرس، تازه‌ترین تاریخ می‌ماند، سقف ۶، تازه‌ترین اول.
   مرتب‌سازی پایدار است و ردیفِ تازه جلوی هم‌تاریخ‌هایش می‌نشیند. */
function upsertSample(samples, s) {
  const i = samples.findIndex((x) => Array.isArray(x) && x[0] === s[0] && x[1] === s[1]);
  if (i >= 0) {
    if (s[2] > samples[i][2]) samples[i] = s;
  } else {
    samples.unshift(s);
  }
  samples.sort((x, y) => (x[2] < y[2] ? 1 : x[2] > y[2] ? -1 : 0));
  if (samples.length > IDX_SAMPLES_MAX) samples.length = IDX_SAMPLES_MAX;
}

function addToNameIndex(shard, key, hash, sample) {
  let ent = shard.e[key];
  if (!Array.isArray(ent) || !Array.isArray(ent[0]) || !Array.isArray(ent[1])) { ent = [[], []]; shard.e[key] = ent; }
  if (!ent[0].includes(hash)) ent[0].push(hash);
  upsertSample(ent[1], sample);
}

/* تاریخ‌های یک توکن: صعودی، بی‌تکرار، ≤۵. اگر بیشتر شد اولین تاریخ (برای «first seen») و
   ۴ تاریخِ تازه‌تر می‌مانند. */
function addToTokenIndex(shard, key, date) {
  let arr = shard.e[key];
  if (!Array.isArray(arr)) arr = [];
  if (!arr.includes(date)) arr.push(date);
  arr = Array.from(new Set(arr.filter(dateOk))).sort();
  if (arr.length > IDX_TOKEN_DATES_MAX) arr = [arr[0]].concat(arr.slice(arr.length - (IDX_TOKEN_DATES_MAX - 1)));
  shard.e[key] = arr;
}

/* ردیفِ خامِ گزارش → ردیفِ قابل‌استفاده یا null. گاردِ عمومی *پیش از* هر فیلد. */
export function guardedRowOf(r) {
  if (!r || typeof r !== "object") return null;
  const g = publishGuardRow(r, undefined);
  if (!g || typeof g !== "object") return null;
  const chain = g.chain, a = g.address;
  if (typeof a !== "string") return null;
  if (chain === "base") { if (!/^0x[0-9a-f]{40}$/.test(a)) return null; }
  else if (chain === "solana") { if (!SOL_MINT.test(a)) return null; }
  else return null;
  return g;
}

/* یک روز را در ایندکس‌ها ادغام می‌کند: فقط شاردهای لمس‌شده خوانده/نوشته می‌شوند، و
   state آخر از همه (خطا در میانه → state دست‌نخورده، ادغامِ دوباره بی‌خطر).
   سندِ غایب یا ناخوانا = روزِ خالی (همان رفتارِ reportDocFor): تاریخ رد می‌شود.
   خطای KV پرتاب می‌شود (کالر می‌ایستد). خروجی: { date, rows, writes }. */
export async function mergeDay(kv, date) {
  if (!dateOk(date)) throw new Error("idx:date");
  const raw = await kv.get(reportKey(date));
  let rows = [];
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.rows)) rows = p.rows;
    } catch (e) { rows = []; }
  }
  const items = [];
  for (const r of rows) {
    const g = guardedRowOf(r);
    if (!g) continue;
    const nn = normName(g.name), ns = normSymbol(g.symbol);
    items.push({
      chain: g.chain, addr: g.address, hash: addrHash(g.chain, g.address), nn, ns,
      y: ogClean(g.symbol, 16) || null,
    });
  }

  const touched = new Map(); // کلیدِ KV → shard (بارگذاری‌شده)
  const need = [];
  const want = (key) => { if (!touched.has(key)) { touched.set(key, null); need.push(key); } };
  for (const it of items) {
    want(tokenShardKey(shardOf(tokenKeyOf(it.chain, it.addr))));
    if (it.nn) want(nameShardKey(nameShardOf("n|" + it.nn)));
    if (it.ns) want(nameShardKey(nameShardOf("s|" + it.ns)));
  }
  const loaded = await Promise.all(need.map((k) => readShard(kv, k)));
  need.forEach((k, i) => touched.set(k, loaded[i]));

  for (const it of items) {
    const sample = [it.chain === "base" ? "b" : "s", it.addr, dateInt(date), it.y];
    addToTokenIndex(touched.get(tokenShardKey(shardOf(tokenKeyOf(it.chain, it.addr)))), tokenKeyOf(it.chain, it.addr), date);
    if (it.nn) addToNameIndex(touched.get(nameShardKey(nameShardOf("n|" + it.nn))), "n|" + it.nn, it.hash, sample);
    if (it.ns) addToNameIndex(touched.get(nameShardKey(nameShardOf("s|" + it.ns))), "s|" + it.ns, it.hash, sample);
  }

  let writes = 0;
  for (const [k, shard] of touched) {
    await kv.put(k, JSON.stringify(shard));
    writes++;
  }
  await kv.put(IDX_STATE_KEY, JSON.stringify({ next: addDays(date, 1) }));
  writes++;
  return { date, rows: items.length, writes };
}

/* قلابِ گذرِ ساعتی (فقط دقیقه‌ی ۱۷): اگر state.next پیش از امروزِ UTC است و
   (state.next دیروز است یا ساعتِ UTC مضربِ ۶ است) دقیقاً یک روز ادغام می‌کند.
   hasRoom() همان انضباطِ بودجه/زمانِ گذر است (آخرِ گذر، پس از همه‌چیز).
   هرگز پرتاب نمی‌کند؛ هر خطا → ایست، state دست‌نخورده. هیچ تماسِ بالادستی. */
export async function idxPassStep(kv, nowMs, hasRoom) {
  try {
    if (!kv) return { ran: false, why: "no-kv" };
    const today = utcDateOf(nowMs);
    const state = await readState(kv);
    if (!(state.next < today)) return { ran: false, why: "caught-up" };
    const yesterday = addDays(today, -1);
    const slotHour = new Date(nowMs).getUTCHours() % 6 === 0;
    if (!(state.next === yesterday || slotHour)) return { ran: false, why: "off-hour" };
    if (typeof hasRoom === "function" && !hasRoom()) return { ran: false, why: "budget" };
    const r = await mergeDay(kv, state.next);
    return { ran: true, date: r.date, writes: r.writes };
  } catch (e) {
    return { ran: false, why: "error" };
  }
}

/* ---------- صفحه: tokFacts ---------- */

function validSample(s) {
  if (!Array.isArray(s)) return null;
  const chain = s[0] === "b" ? "base" : s[0] === "s" ? "solana" : null, a = s[1];
  if (!chain || typeof a !== "string") return null;
  if (chain === "base" ? !EVM_ADDR.test(a) : !SOL_MINT.test(a)) return null;
  if (!Number.isInteger(s[2])) return null;
  const d = dateStr(s[2]);
  if (!dateOk(d)) return null;
  return { c: chain, a, d, y: typeof s[3] === "string" ? s[3] : null };
}

function sameBlock(ent, selfHash, normText) {
  if (!Array.isArray(ent) || !Array.isArray(ent[0]) || !Array.isArray(ent[1])) return null;
  const hashes = ent[0].filter((h) => typeof h === "string" && h !== selfHash);
  const count = hashes.length;
  if (count < 1) return null;
  const samples = [];
  for (const s of ent[1]) {
    const v = validSample(s);
    if (v && addrHash(v.c, v.a) !== selfHash) samples.push(v);
  }
  return { count, samples: samples.slice(0, IDX_SAMPLES_MAX), norm: normText, set: hashes.slice().sort().join(",") };
}

/* tokFacts(addr, chain, env, deadlineAt[, metaPromise]) → {rows, same, range, dates} | null
   • سقفِ KV: ≤۶ خواندن (tidx، state، ۱–۲ شارد، و باقیِ سقف ردیف‌های سند، حداکثر ۳).
   • مهلتِ سخت: race با deadlineAt؛ تایم‌اوت/خطا → null.
   • هیچ تماسِ بالادستی. */
export function tokFacts(addr, chain, env, deadlineAt, metaPromise) {
  const kv = env && env.ZX_KV;
  if (!kv || (chain !== "base" && chain !== "solana") || typeof addr !== "string") return Promise.resolve(null);
  let timer;
  const guard = new Promise((res) => {
    const ms = Math.max(0, (Number.isFinite(deadlineAt) ? deadlineAt : Date.now()) - Date.now());
    timer = setTimeout(() => res(null), ms);
  });
  const work = tokFactsInner(addr, chain, kv, metaPromise).catch(() => null);
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

async function tokFactsInner(addr, chain, kv, metaPromise) {
  let reads = 0;
  const get = (key, ttl) => {
    reads++;
    if (reads > TOKFACTS_MAX_KV_READS) throw new Error("tokfacts:reads");
    return kv.get(key, { cacheTtl: ttl });
  };
  const today = utcDateOf(Date.now());
  const tkey = tokenKeyOf(chain, addr);
  const selfHash = addrHash(chain, addr);

  const [tidxRaw, stateRaw, meta] = await Promise.all([
    get(tokenShardKey(shardOf(tkey)), 3600),
    get(IDX_STATE_KEY, 300),
    Promise.resolve(metaPromise).then((m) => m || null, () => null),
  ]);

  let tdates = [];
  if (typeof tidxRaw === "string") {
    const p = JSON.parse(tidxRaw);
    if (p && p.v === 1 && p.e && Array.isArray(p.e[tkey])) tdates = p.e[tkey].filter((d) => dateOk(d) && d >= IDX_FIRST_DATE);
  }
  let state = { next: IDX_FIRST_DATE };
  if (typeof stateRaw === "string") {
    const p = JSON.parse(stateRaw);
    if (p && dateOk(p.next)) state = { next: p.next < IDX_FIRST_DATE ? IDX_FIRST_DATE : p.next };
  }
  const merged = state.next > IDX_FIRST_DATE;
  const range = merged ? { from: IDX_FIRST_DATE, to: addDays(state.next, -1) } : null;

  /* روزهایی که می‌خوانیم: امروز (هنوز ادغام نشده) + تاریخ‌های ایندکس، تازه‌ترین اول.
     اولین تاریخِ شناخته‌شده همیشه در انتخاب می‌ماند (برای «first check»). */
  const uniq = Array.from(new Set(tdates.concat(today))).sort().reverse();
  const first = tdates.length ? tdates[0] : null;

  const nameOf = (m) => (m && typeof m.name === "string" ? m.name : null);
  const symOf = (m) => (m && typeof m.symbol === "string" ? m.symbol : null);
  let nm = nameOf(meta), sy = symOf(meta);

  const docCache = new Map();
  const readDoc = async (d) => {
    if (docCache.has(d)) return docCache.get(d);
    const raw = await get(reportKey(d), d >= today ? 300 : 3600);
    let row = null;
    if (typeof raw === "string") {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.rows)) {
        for (const r of p.rows) {
          if (!r || typeof r.address !== "string" || r.chain !== chain) continue;
          if (chain === "base" ? r.address.toLowerCase() !== addr.toLowerCase() : r.address !== addr) continue;
          const g = guardedRowOf(r);
          if (g) { row = g; break; }
        }
      }
    }
    docCache.set(d, row);
    return row;
  };
  const pickDates = (list, n) => {
    const sel = list.slice(0, n);
    if (first && list.includes(first) && !sel.includes(first) && n > 0) sel[n - 1] = first;
    return Array.from(new Set(sel)).sort().reverse();
  };

  const shardKeysFor = (n, s) => {
    const ks = [];
    if (merged && n) ks.push(nameShardKey(nameShardOf("n|" + n)));
    if (merged && s) { const k = nameShardKey(nameShardOf("s|" + s)); if (!ks.includes(k)) ks.push(k); }
    return ks;
  };

  let nn = normName(nm), ns = normSymbol(sy);
  let docDates, rowsByDate = new Map();
  if (nm || sy) {
    /* نام از meta معلوم است → شاردها از پیش معلومند؛ سهمِ سند = ۶ − ۲ − شاردها */
    const shardKeys = shardKeysFor(nn, ns);
    const docBudget = Math.min(TOKFACTS_MAX_DOCS, TOKFACTS_MAX_KV_READS - 2 - shardKeys.length);
    docDates = pickDates(uniq, Math.max(0, docBudget));
    const [shardRaws] = await Promise.all([
      Promise.all(shardKeys.map((k) => get(k, 3600))),
      Promise.all(docDates.map(async (d) => { rowsByDate.set(d, await readDoc(d)); })),
    ]);
    return finish(shardKeys, shardRaws);
  }
  /* meta نبود: نام/نماد از تازه‌ترین ردیف می‌آید → اول تازه‌ترین سند */
  const firstDates = uniq.slice(0, 1);
  for (const d of firstDates) rowsByDate.set(d, await readDoc(d));
  const newestRow = firstDates.map((d) => rowsByDate.get(d)).find(Boolean) || null;
  if (newestRow) { nm = typeof newestRow.name === "string" ? newestRow.name : null; sy = typeof newestRow.symbol === "string" ? newestRow.symbol : null; }
  nn = normName(nm); ns = normSymbol(sy);
  const shardKeys2 = shardKeysFor(nn, ns);
  const docBudget2 = Math.min(TOKFACTS_MAX_DOCS - 1, TOKFACTS_MAX_KV_READS - 3 - shardKeys2.length);
  const rest = uniq.slice(1);
  const restDates = pickDates(rest.concat(first && !rest.includes(first) && !firstDates.includes(first) ? [first] : []), Math.max(0, docBudget2));
  const [shardRaws2] = await Promise.all([
    Promise.all(shardKeys2.map((k) => get(k, 3600))),
    Promise.all(restDates.map(async (d) => { rowsByDate.set(d, await readDoc(d)); })),
  ]);
  return finish(shardKeys2, shardRaws2);

  function finish(shardKeys, shardRaws) {
    const rows = [];
    for (const d of Array.from(rowsByDate.keys()).sort().reverse()) {
      const row = rowsByDate.get(d);
      if (row) rows.push({ date: d, row });
    }
    /* تاریخ‌هایی که توکن در گزارش‌شان هست: ایندکس + امروز اگر ردیفِ امروز پیدا شد */
    const seenDates = tdates.slice();
    const todayRow = rowsByDate.get(today);
    if (todayRow && !seenDates.includes(today)) seenDates.push(today);
    seenDates.sort();

    let same = null;
    if (range) {
      const byKey = new Map();
      shardKeys.forEach((k, i) => {
        try {
          const raw = shardRaws[i];
          if (typeof raw !== "string") return;
          const p = JSON.parse(raw);
          if (p && p.v === 1 && p.e) byKey.set(k, p.e);
        } catch (e) { /* شاردِ خراب = بدونِ اطلاعاتِ هم‌نام */ }
      });
      const look = (fam, nt) => {
        if (!nt) return null;
        const e = byKey.get(nameShardKey(nameShardOf(fam + "|" + nt)));
        return e ? sameBlock(e[fam + "|" + nt], selfHash, nt) : null;
      };
      const nb = look("n", nn), sb = look("s", ns);
      same = { name: nb, symbol: sb };
    }
    return { rows, same, range, dates: seenDates, firstDate: first || (rows.length ? rows[rows.length - 1].date : null) };
  }
}
