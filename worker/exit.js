/* =====================================================================
   Exit value سمتِ سرور — خلاصه‌ی یک کیف برای کارت پیش‌نمایش (/og/exit/<آدرس>.png و تگ‌های /exit/<آدرس>)
   =====================================================================
   مسئله: وقتی کسی لینکِ /exit/<آدرس> را در ایکس/تلگرام می‌گذارد، ربات جاوااسکریپت اجرا نمی‌کند؛ پس عددِ آن کیف باید
   سمتِ سرور حساب شود — با *همان قواعدِ* صفحه (web/index.html، بخش «Exit value»).

   این ماژول **خالص** است (بدون fetch، بدون Cache API): قواعد، رمزگذاریِ Multicall3، جمع‌ها و متنِ تگ‌ها. سیم‌کشیِ شبکه
   (هلدینگ، قیمت، کوت) در worker/index.js است و همین توابع را صدا می‌زند — تا تست بتواند قواعد را بدونِ شبکه بسنجد.

   🔴 قواعدِ شمارش (عیناً قواعدِ کلاینت؛ ثابت‌ها از یک منبع):
   • توکن فقط وقتی «شمرده» می‌شود که قیمتش از استخری باشد با ذخیره‌ی ≥ EXIT_MIN_RESERVE_USD (= REPORT_MIN_RESERVE_USD،
     همان import، نه کپیِ عدد) و موجودی × قیمت ≥ EXIT_MIN_VALUE_USD.
   • ETH همیشه می‌آید (کاغذی = خروج).
   • «نمی‌دانم» هرگز صفر نیست: کوتِ ناموفق، سقفِ بودجه‌ی ساب‌ریکوئست، سقفِ تعدادِ توکن = Unknown؛ از جمعِ خروج بیرون و در
     unknownCount شمرده می‌شود.
   • lostPct فقط روی توکن‌هایی است که *هر دو* عدد را دارند (quotedPaper در برابرِ exit).
   • کارمزدِ اجراکننده (feeBps) از خودِ قرارداد خوانده می‌شود؛ ناخواندنی = سقفِ قرارداد (۱٪)، نه صفر — کفِ محافظه‌کارانه.
   ===================================================================== */

import { REPORT_MIN_RESERVE_USD } from "./report.js";
import { VD_VENUES, WETH_ADDR, buildProbeFor, decodeQuote } from "./verdict.js";
import { OG_IMAGE_PATH, ogEscape } from "./og.js";

// ---- ثابت‌ها (آینه‌ی web/index.html؛ تستِ [exit og] یکی‌بودنشان را می‌سنجد) ----
export const EXIT_MIN_RESERVE_USD = REPORT_MIN_RESERVE_USD;
export const EXIT_MIN_VALUE_USD = 1;
export const EXIT_BATCH = 25;
export const EXIT_GAP_MED = 5;
export const EXIT_GAP_BIG = 20;
export const EXIT_EXECUTOR = "0x5f3FCcfF3339DAa9eA7D2EBC3f77017D65467132";
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// سقفِ feeBps در قرارداد (SwapExecutor.MAX_FEE_BPS)
export const EXIT_FEE_BPS_MAX = 100;
export const SEL_FEE_BPS = "0x24a9d853";       // feeBps()
export const SEL_AGGREGATE3 = "0x82ad56cb";    // aggregate3((address,bool,bytes)[])

// ---- بودجه‌ی خودِ خلاصه ----
// ساب‌ریکوئستِ صریحِ یک محاسبه (سقفِ پلتفرم ~۵۰). معمولی: هلدینگ ۱ + قیمت ⌈n/25⌉ + کوت ۱ = ۳ تا ۶.
export const EXIT_SUBREQ_BUDGET = 16;
// بیش از این تعداد توکنِ شمرده‌شده کوت نمی‌گیرد → Unknown (نه صفر)
export const EXIT_QUOTE_MAX_TOKENS = 30;
// تعدادِ زیرتماسِ هر aggregate3 (مرزِ تکه‌ها روی توکن است، پس یک تکه‌ی خراب فقط توکن‌های خودش را Unknown می‌کند)
export const EXIT_MC_CHUNK = 60;
export const EXIT_TTL_S = 600;
export const EXIT_BUCKET_MS = EXIT_TTL_S * 1000;
// نسخه‌ی تصویرِ /og/exit — اگر چیدمان عوض شد جلو ببر
export const OG_EXIT_IMAGE_V = "2";

export const EXIT_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ---- عددها ----
// Number(ethers.formatUnits(bal, dec)) بدونِ ethers: رشته‌ی دهدهیِ دقیق، بعد Number
export function unitsToNumber(bal, dec) {
  const b = BigInt(bal);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) return NaN;
  const s = b.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec), frac = dec ? s.slice(s.length - dec) : "";
  return Number(frac ? whole + "." + frac : whole);
}
export function exitNum(v) {
  if (v == null || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// همان قالبِ کارتِ کلاینت (exitDrawCard.money)
export function exitMoney(n) {
  const d = n < 100 ? 2 : 0;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
// آستانهٔ «تقریباً هیچ»: واحدش درصد است (۰٫۰۵ یعنی ۰٫۰۵٪ نه ۵٪)؛ متن و خطِ رویِ «On paper» هر دو از همین یک عدد می‌آیند
export const EXIT_LOST_NONE = 0.05;
// خطِ قرمز فقط وقتی که واقعاً چیزی از دست می‌رود؛ lostPct نامعلوم (null) هم خط نمی‌خورد
export function exitLostSome(lp) {
  return lp != null && isFinite(lp) && !(Math.max(0, lp) < EXIT_LOST_NONE);
}
export function exitPct(p) {
  return p == null || !isFinite(p) ? null : (Math.abs(p) < EXIT_LOST_NONE ? "0" : p.toFixed(1)) + "%";
}
export function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
export function utcClock(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + " UTC";
}
export const exitBucket = (now) => Math.floor(now / EXIT_BUCKET_MS);

// ---- قیمت: پاسخِ tokens/multi?include=top_pools → Map (همان پارسِ exitLoadPrices در کلاینت) ----
export function exitParsePrices(j, info) {
  if (!j || !Array.isArray(j.data)) throw new Error("shape");
  const pools = new Map();
  for (const x of (Array.isArray(j.included) ? j.included : [])) if (x && typeof x.id === "string") pools.set(x.id, x);
  for (const d of j.data) {
    const a = d && d.attributes;
    if (!a || typeof a.address !== "string") continue;
    const tp = d.relationships && d.relationships.top_pools && d.relationships.top_pools.data;
    const pool = Array.isArray(tp) && tp[0] && typeof tp[0].id === "string" ? pools.get(tp[0].id) : null;
    info.set(a.address.toLowerCase(), {
      price: exitNum(a.price_usd),
      dec: Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 36 ? a.decimals : null,
      reserve: pool && pool.attributes ? exitNum(pool.attributes.reserve_in_usd) : null,
    });
  }
}

// ---- یک موجودی → سطر (همان exitMakeRow کلاینت) ----
export function exitMakeRow(t, info, failed) {
  const base = { addr: t.address, bal: BigInt(t.balance), dec: null, price: null, reserve: null, paper: null, exit: null,
    quote: "none", state: "small", why: "noprice" };
  const m = info.get(t.address);
  if (!m) { base.why = failed.has(t.address) ? "unread" : "noprice"; return base; }
  Object.assign(base, { dec: m.dec, price: m.price, reserve: m.reserve });
  if (m.dec == null || m.price == null || !(m.price > 0)) { base.why = "noprice"; return base; }
  const amt = unitsToNumber(base.bal, m.dec), paper = amt * m.price;
  base.amt = amt;
  if (!Number.isFinite(paper)) { base.why = "noprice"; return base; }
  base.paper = paper;
  if (m.reserve == null || m.reserve < EXIT_MIN_RESERVE_USD) { base.why = "thin"; return base; }
  if (paper < EXIT_MIN_VALUE_USD) { base.why = "dust"; return base; }
  base.state = "counted"; base.why = ""; base.quote = "pending";
  return base;
}

// ---- جمع‌ها (همان exitTotals کلاینت) ----
export function exitTotals(rows) {
  const counted = rows.filter((r) => r.state === "counted");
  const both = counted.filter((r) => r.paper != null && r.exit != null);
  const paper = counted.reduce((s, r) => s + (r.paper || 0), 0);
  const exit = counted.reduce((s, r) => s + (r.exit || 0), 0);
  const paperBoth = both.reduce((s, r) => s + r.paper, 0);
  const pending = counted.filter((r) => r.quote === "pending").length;
  const unknown = counted.filter((r) => !r.native && r.quote !== "pending" && r.exit == null).length;
  const known = counted.some((r) => r.exit != null), paperKnown = counted.some((r) => r.paper != null);
  const lost = known && paperBoth > 0 ? (1 - exit / paperBoth) * 100 : null;
  return { counted: counted.filter((r) => !r.native).length, paperKnown, paper, exit, paperBoth, pending, unknown, known, lost };
}

/* خروجیِ نهایی. null = «چیزی برای نشان‌دادن نیست» (هیچ توکنی کوت/قیمت نگرفت، یا کیف خالی): کارتِ عمومی، هرگز «$0».
   unreadable: توکن‌هایی که هلدینگ نتوانست بخواندشان — Unknown‌اند و به unknownCount اضافه می‌شوند.
   more: کیف بیش از سقفِ فهرست توکن دارد → partial. */
export function exitSummaryFrom(rows, h, at) {
  const T = exitTotals(rows);
  if (!T.known || !(T.exit >= 0.01)) return null;
  const unread = h && Number.isInteger(h.unread) && h.unread > 0 ? h.unread : 0;
  return {
    paper: T.paper,
    exit: T.exit,
    lostPct: T.lost == null ? null : Math.max(0, T.lost),
    quotedPaper: T.paperBoth,
    unknownCount: T.unknown + unread,
    counted: T.counted,
    at,
    partial: !!(h && h.more === true),
  };
}

// شکلِ یک خلاصه‌ی کش‌شده را دوباره اعتبارسنجی می‌کند (کشِ خراب = بی‌کش)
export function exitSummaryValid(s) {
  return !!s && typeof s === "object"
    && Number.isFinite(s.paper) && Number.isFinite(s.exit) && s.exit >= 0
    && Number.isFinite(s.quotedPaper) && Number.isInteger(s.unknownCount) && s.unknownCount >= 0
    && Number.isInteger(s.counted) && Number.isFinite(s.at)
    && (s.lostPct === null || Number.isFinite(s.lostPct));
}

// ---- Multicall3 ----
const W = (h) => String(h).padStart(64, "0");
const wAddr = (a) => W(String(a).toLowerCase().replace(/^0x/, ""));
const wNum = (n) => W(BigInt(n).toString(16));
const padData = (hex) => hex + "0".repeat((64 - (hex.length % 64)) % 64);

// calls: [{ to, data }] → کالدیتای aggregate3 با allowFailure=true برای همه
export function encodeAggregate3(calls) {
  const n = calls.length;
  const tuples = calls.map((c) => {
    const d = String(c.data).replace(/^0x/, "");
    return wAddr(c.to) + wNum(1) + wNum(0x60) + wNum(d.length / 2) + padData(d);
  });
  let off = n * 32;
  const offs = tuples.map((t) => { const o = off; off += t.length / 2; return wNum(o); });
  return SEL_AGGREGATE3 + wNum(0x20) + wNum(n) + offs.join("") + tuples.join("");
}

// خروجیِ aggregate3 → [{ ok, data }] یا null (هر ناجوری = null، نه آرایه‌ی نصفه)
export function decodeAggregate3(hex, expectN) {
  try {
    if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
    const body = hex.slice(2);
    const total = body.length / 2;
    const u = (o) => {
      if (o < 0 || o + 32 > total) throw new Error("oob");
      const v = BigInt("0x" + body.slice(o * 2, o * 2 + 64));
      if (v > 0xffffffffn) throw new Error("big");
      return Number(v);
    };
    const arr = u(0);
    const n = u(arr);
    if (n > 5000 || (expectN != null && n !== expectN)) return null;
    const base = arr + 32;
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = base + u(base + 32 * i);
      const ok = u(t) === 1;
      const b = t + u(t + 32);
      const len = u(b);
      if (b + 32 + len > total) return null;
      out.push({ ok, data: "0x" + body.slice((b + 32) * 2, (b + 32 + len) * 2) });
    }
    return out;
  } catch (e) {
    return null;
  }
}

// ---- پروبِ فروشِ «کلِ موجودی → WETH» روی همه‌ی صرافی‌هایی که سرور بلد است (همان encoderهای verdict.js) ----
const KIND_BY_ID = new Map(VD_VENUES.map((v) => [v.id, v.kind]));
const ALL_IDS = VD_VENUES.map((v) => v.id);
export function exitProbesFor(tokenAddr, bal) {
  return buildProbeFor(tokenAddr, WETH_ADDR, bal, ALL_IDS).map((p) => ({ to: p.to, data: p.data, kind: KIND_BY_ID.get(p.id) }));
}

// نتیجه‌ی زیرتماس‌های یک توکن → بیشترین خروجیِ مثبتِ WETH (BigInt) یا null. صفر/ریورت/نامفهوم = کوتِ ندادن، نه «صفر ارزش».
export function bestWethOut(probes, results) {
  let best = null;
  for (let i = 0; i < probes.length; i++) {
    const r = results[i];
    if (!r || !r.ok) continue;
    const v = decodeQuote(probes[i].kind, r.data);
    if (v != null && v > 0n && (best == null || v > best)) best = v;
  }
  return best;
}

// feeBps از نتیجه‌ی aggregate3ِ تک‌تماس؛ ناخواندنی/خارج از بازه = سقفِ قرارداد
export function feeBpsFrom(res) {
  const r = res && res[0];
  if (!r || !r.ok || !/^0x[0-9a-fA-F]{64}$/.test(r.data)) return EXIT_FEE_BPS_MAX;
  const v = BigInt(r.data);
  return v <= BigInt(EXIT_FEE_BPS_MAX) ? Number(v) : EXIT_FEE_BPS_MAX;
}

/* ---- تگ‌های پیش‌نمایش ----
   title/description/image از یک تابع می‌آیند تا تست و HTMLRewriter یک متن ببینند.
   s = خلاصه‌ی کش‌شده یا null (نمی‌دانیم → متنِ بی‌عدد؛ تصویر همچنان به /og/exit اشاره می‌کند و خودش تصمیم می‌گیرد).
   ⚠️ وقتی توکنِ بی‌کوت هست، exit یک کف است («at least») و «On paper» همان quotedPaper است (هم‌پایه‌ی کارتِ کلاینت). */
export function exitOgFields(wallet, origin, s, now) {
  if (!wallet) {
    return {
      title: "Exit value — what a wallet would really get if it sold now — Zaexa",
      description: "Paste any Base wallet to see what it would fetch if everything were sold now, from live quotes, and how much of the on-paper value would be lost.",
      image: origin + OG_IMAGE_PATH + "?v=5",
      alt: "Zaexa",
      url: origin + "/exit",
    };
  }
  const sa = shortAddr(wallet);
  const image = origin + "/og/exit/" + wallet + ".png?v=" + OG_EXIT_IMAGE_V + "&r=" + exitBucket(now);
  const url = origin + "/exit/" + wallet;
  if (!exitSummaryValid(s)) {
    return {
      title: "Exit value of " + sa + " — Zaexa",
      description: "What this Base wallet would get if it sold everything now, from live quotes.",
      image, alt: "Exit value of " + sa + " — Zaexa", url,
    };
  }
  const unk = s.unknownCount > 0 || s.partial;
  const base = unk ? s.quotedPaper : s.paper;
  const lp = s.lostPct == null ? null : s.lostPct;
  const bits = ["On paper " + exitMoney(base) + "."];
  if (lp != null) bits.push((lp < EXIT_LOST_NONE ? "Almost nothing" : exitPct(lp)) + " would be lost on exit.");
  bits.push("Floor from live quotes at " + utcClock(s.at) + ".");
  if (s.unknownCount > 0) bits.push("Excludes " + s.unknownCount + (s.partial ? "+" : "") + " token" + (s.unknownCount === 1 && !s.partial ? "" : "s") + " without a quote.");
  else if (s.partial) bits.push("Excludes some tokens without a quote.");
  return {
    title: "Exit value of " + sa + ": " + (unk ? "at least " : "") + exitMoney(s.exit) + " if sold now",
    description: bits.join(" "),
    image, alt: "Exit value of " + sa + " — " + exitMoney(s.exit) + " if sold now", url,
  };
}

export function exitOgTags(f) {
  const m = (attr, k, v) => "<meta " + attr + '="' + k + '" content="' + ogEscape(v) + '">';
  return [
    m("property", "og:type", "website"),
    m("property", "og:site_name", "Zaexa"),
    m("property", "og:title", f.title),
    m("property", "og:description", f.description),
    m("property", "og:url", f.url),
    m("property", "og:image", f.image),
    m("property", "og:image:width", "1200"),
    m("property", "og:image:height", "630"),
    m("property", "og:image:alt", f.alt),
    m("name", "twitter:card", "summary_large_image"),
    m("name", "twitter:site", "@zaexadex"),
    m("name", "twitter:title", f.title),
    m("name", "twitter:description", f.description),
    m("name", "twitter:image", f.image),
    m("name", "description", f.description),
    '<link rel="canonical" href="' + ogEscape(f.url) + '">',
  ].join("");
}

// رباتِ پیش‌نمایش؟ فقط برای تصمیمِ «صفحه منتظرِ محاسبه بماند یا نه» — هرگز برای محتوا. ناشناخته = غیرِ ربات (صفحه بی‌عدد، تصویر همچنان درست).
export const EXIT_BOT_UA = /(telegrambot|twitterbot|facebookexternalhit|slackbot|discordbot|whatsapp|linkedinbot|skypeuripreview|mastodon|redditbot|applebot|pinterestbot|googlebot|bingbot|embedly|vkshare|bluesky|cardyb)/i;
