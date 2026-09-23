/* =====================================================================
   گزارش روزانه — «یک انبار، دو نما»
   =====================================================================
   هر ساعت، scheduled() در worker/index.js یک صفحه از new_pools تازه‌ی Base
   می‌گیرد، هر توکنِ تازه را از همان چکِ sell-quote موجود (worker/verdict.js)
   رد می‌کند و دو چیز در KV می‌نویسد:
     pairs:base:latest   — حلقه‌ی غلتان همان چیزی که «تازه‌ها» را نشان می‌دهد
     report:<YYYY-MM-DD> — بایگانیِ همان روز
   این ماژول **خالص** است، دقیقاً به همان دلیلِ worker/verdict.js: بدون
   تزریق (kv/fetchPools/metaOf/verdictOf/now/sleep) هیچ تستی نمی‌تواند این
   رفتار را بدون شبکه‌ی واقعی بسنجد.

   🔴 روی Base رفت‌وبرگشت نداریم. worker/verdict.js فقط یک SELL QUOTE از
   هفت صرافی می‌گیرد. گزارش هرگز نباید درباره‌ی یک نتیجه‌ی Base بگوید
   «round trip» — و این با نوشتنِ دستیِ متن تضمین نمی‌شود، با ساختار
   تضمین می‌شود: CHECK_KIND_BY_CHAIN زیر، و اینکه reportRow اصلاً پارامتری
   برای checkKind نمی‌پذیرد. */

import { isBaseWhy } from "./verdict.js";
import { SOL_MINT } from "./chains.js";

export const REPORT_MIN_RESERVE_USD = 5000;
export const REPORT_MAX_TOKENS_PER_RUN = 30;
export const REPORT_PAIRS_CAP = 200;
export const REPORT_PACE_MS = 500;

/* سهمِ پایِ Base در یک گذرِ زمان‌بندی‌شده — از رویِ لاگِ گذرِ زنده‌ی ساعت
   ۱۹:۱۷ UTC تنظیم شده: هفت توکنِ Base تلاش شد، شمارشِ عملیات به‌ازای توکن
   [۶،۸،۶،۹،۸،۹،۲] بود، اولین ردیفِ نامعلوم از اندیسِ ۳ به بعد ظاهر شد،
   capProbe نتیجه‌اش "cap" بود، و از ۴۱ فچِ کل ۲۴تا به api.coingecko.com
   رفت. یعنی همان گذر پیش از توکنِ چهارم به سقفِ ساب‌ریکوئستِ Worker خورد —
   این سقف را عمداً پایین‌تر از آن نقطه نگه می‌دارد تا هیچ ردیفی وسطِ
   کارش نیمه‌کاره نماند. فقط پایِ زمان‌بندی‌شده را محدود می‌کند؛ /report/run
   سقفِ کوچک‌ترِ خودش (REPORT_RUN_MAX_TOKENS در index.js) را جدا نگه می‌دارد. */
export const REPORT_PASS_BASE_CAP = 5;

// نگاشتِ بسته — تنها جایی که checkKind از آن می‌آید. هیچ پارامتری برای
// checkKind وجود ندارد، دقیقاً برای اینکه نوشتنِ «round trip» روی یک نتیجه‌ی
// sell-quote از نظرِ ساختاری غیرممکن باشد، نه فقط دلسردکننده.
export const CHECK_KIND_BY_CHAIN = Object.freeze({ base: "sell-quote", solana: "roundtrip" });

export const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PAIRS_KEY_BASE = "pairs:base:latest";
// حلقه‌ی لاگِ گذر — فقط اندازه‌گیری (کجا گذر ایستاد)، هیچ آدرس/symbol/why.
export const PASS_LOG_KEY = "report:passlog";
export const REPORT_PASS_LOG_CAP = 48;

export function reportKey(dateStr) {
  return "report:" + dateStr;
}

// UTC، همیشه ده نویسه — toISOString() همیشه UTC است، پس فقط بریدنِ تاریخ کافی است.
export function utcDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyReportDoc(dateStr) {
  return { date: dateStr, generatedAt: null, chains: ["base"], checked: 0, rows: [] };
}

/* یک ردیفِ new_pools → توکنِ بررسی‌شدنی، یا null. کپیِ همان قاعده‌ی
   sitemapTokenFromPool در worker/index.js: هر فیلد از بالادست می‌آید که
   کنترلش دستِ ما نیست، پس یک ردیفِ عجیب فقط خودش را رد می‌کند.
   نسخه‌ی زنجیره‌آگاه: فقط بخشِ شناساییِ id بسته به chain فرق می‌کند — بقیه‌ی
   قاعده‌ها (آستانه‌ی رزرو، قیمت، poolCreatedAt، dex، حجم، FDV) مشترک و
   دست‌نخورده می‌مانند.
   ⚠️ mint سولانا حساسِ به حروف است (base58، برخلافِ چک‌سامِ اختیاریِ Base) —
   اینجا هیچ toLowerCase‌ای روی آن اعمال نمی‌شود، وگرنه یک mint واقعی
   بی‌صدا خراب می‌شد. */
export function newPoolRowToTokenFor(chain, row) {
  try {
    const rawId = row && row.relationships && row.relationships.base_token &&
      row.relationships.base_token.data && row.relationships.base_token.data.id;
    if (typeof rawId !== "string") return null;

    let address;
    if (chain === "base") {
      const rest = rawId.replace(/^base_/, "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(rest)) return null;
      address = rest.toLowerCase();
    } else if (chain === "solana") {
      const rest = rawId.replace(/^solana_/, "");
      // ⚠️ اینجا toLowerCase نمی‌شود — mint سولانا حساسِ به حروف است.
      if (!SOL_MINT.test(rest)) return null;
      address = rest;
    } else {
      return null; // زنجیره‌ای که نمی‌شناسیم
    }
    // 🔴 یک سایت‌مپ واقعی همین آدرس را یک بار لیست کرد. نگذار به گزارش برسد.
    // (این الگو فقط شکلِ Base را می‌گیرد؛ روی یک mint سولانا هرگز true نمی‌شود.)
    if (/^0x0{40}$/.test(address)) return null;

    const attrs = row.attributes || {};
    // هر عدد از بالادست به‌صورتِ رشته می‌آید، نه عدد — Number() آن را تبدیل
    // می‌کند؛ یک فیکسچر با literal عددی چیزی از این تبدیل را نمی‌سنجد.
    const reserveUsd = Number(attrs.reserve_in_usd);
    if (!Number.isFinite(reserveUsd) || reserveUsd < REPORT_MIN_RESERVE_USD) return null;

    const priceUsd = Number(attrs.base_token_price_usd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

    const poolCreatedAt = typeof attrs.pool_created_at === "string" ? attrs.pool_created_at : null;
    const dexId = row.relationships && row.relationships.dex && row.relationships.dex.data &&
      row.relationships.dex.data.id;
    const dex = typeof dexId === "string" ? dexId : null;

    // volume_usd ممکن است کلاً نباشد (یک استخرِ تازه‌تر از اولین شمعِ ۲۴ساعته) —
    // نبودنش نباید کل ردیف را رد کند، فقط این یک عدد null می‌شود.
    const vol24hRaw = attrs.volume_usd && attrs.volume_usd.h24;
    const vol24hNum = Number(vol24hRaw);
    const vol24hUsd = Number.isFinite(vol24hNum) && vol24hNum >= 0 ? vol24hNum : null;

    // ⚠️ market_cap_usd در پاسخِ واقعی اغلب null است (توکن‌های تازه هنوز
    // عرضه‌ی گردشیِ گزارش‌شده ندارند) — fallback به آن یعنی گاهی FDV واقعی و
    // گاهی مارکت‌کپ را زیرِ یک نامِ یکسان قاطی کردن؛ عمداً نادیده گرفته می‌شود.
    const fdvNum = Number(attrs.fdv_usd);
    const fdvUsd = Number.isFinite(fdvNum) && fdvNum > 0 ? fdvNum : null;

    return { address, priceUsd, reserveUsd, poolCreatedAt, dex, vol24hUsd, fdvUsd };
  } catch (e) {
    return null;
  }
}

// پوششِ نازک — کالرها و پروب‌های امروز دست‌نخورده می‌مانند، بایت‌به‌بایت.
export function newPoolRowToToken(row) {
  return newPoolRowToTokenFor("base", row);
}

// یک عددِ ذخیره‌شدنی، یا null. هرگز رشته، هرگز NaN، هرگز صفر-به‌جای-نامعلوم —
// صفرِ واقعی (مثلاً حجمِ صفر) باید صفر بماند، پس شرط Number.isFinite است، نه truthy.
function storedNumber(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/* حکمِ null «نمی‌دانم» است، ولی نمی‌گوید *کجا* ایستاد — این تابع همان
   واژه‌نامه‌ی بسته را روی مرزِ ذخیره‌سازی هم می‌بندد، دقیقاً مثلِ checkKind
   بالاتر: یک why ساختگی/دست‌ساز هرگز نباید در انبار بنشیند.
   ⚠️ v «sell»/«nosell» → why همیشه null، صرف‌نظر از هرچه پاس داده شده —
   یک why روی یک حکمِ مثبت/منفی خودش یک ادعای ساختگی است (چرا باید دلیلِ
   نامعلوم‌بودن را برای چیزی که نامعلوم نیست نگه داریم؟).
   v null → روی Base فقط عضوِ VD_BASE_WHY/isBaseWhy پذیرفته می‌شود؛ روی
   سولانا (که واژه‌نامه‌ی خودش را در worker/verdict_sol.js دارد، نه اینجا)
   فقط شکلِ عمومیِ safe-string. هر چیزِ دیگر → "internal". */
function whyForRow(chain, verdict, why) {
  if (verdict === "sell" || verdict === "nosell") return null;
  if (chain === "base") return isBaseWhy(why) ? why : "internal";
  if (chain === "solana") return typeof why === "string" && /^[a-z0-9:-]{1,40}$/.test(why) ? why : "internal";
  return "internal";
}

// واژه‌نامه‌ی بسته‌ی cause — دقیقاً هم‌رده‌ی همان انضباطِ whyForRow. امروز
// فقط یک عضو دارد، ولی فهرست است نه یک رشته‌ی تکی، برای همان روزی که عضوِ
// دوم لازم شود.
export const REPORT_CAUSES = Object.freeze(["empty-pool"]);

/* یک cause ساختگی/دست‌ساز هرگز نباید در انبار بنشیند — فقط وقتی verdict
   واقعاً "nosell" است و خودِ رشته عضوِ همین واژه‌نامه‌ی بسته است، وگرنه
   undefined. هر cause‌ای که از انبار خوانده می‌شود یا کالر می‌دهد باید از
   همینجا رد شود، هیچ مسیرِ دیگری به یک ردیف نمی‌رسد. */
/* ۲۳ سپتامبر — گاردِ زمانِ انتشار برای ردیف‌هایی که *پیش از* قاعده‌ی تازه‌ی
   finalizeBaseNosell (worker/index.js) ذخیره شده‌اند، از جمله $SPIKE در
   report:2026-09-23: یک nosellِ Base روی استخرِ v4 که cause="empty-pool" ندارد
   اثبات‌نشده است و «نامعلوم» (v4:unproven) نشان داده می‌شود. خودِ انبار دست
   نمی‌خورد؛ فقط نمای بیرونی (JSON، متن، /pairs.json). recheckِ منفی با همان
   شرط هم کنار گذاشته می‌شود. */
export function publishGuardRow(row, chainDefault) {
  if (!row || typeof row !== "object") return row;
  const chain = typeof row.chain === "string" ? row.chain : chainDefault;
  const v4 = typeof row.dex === "string" && row.dex.startsWith("uniswap-v4");
  if (chain !== "base" || !v4) return row;
  let out = row;
  if (row.v === "nosell" && row.cause !== "empty-pool") {
    out = { ...out, v: null, why: "v4:unproven" };
    delete out.cause;
    delete out.ret;
  }
  if (row.recheck === "nosell" && row.recheckCause !== "empty-pool") {
    out = { ...out };
    delete out.recheck; delete out.recheckAt; delete out.recheckCause;
  }
  return out;
}

export function causeForRow(verdict, cause) {
  if (verdict !== "nosell") return undefined;
  return typeof cause === "string" && REPORT_CAUSES.includes(cause) ? cause : undefined;
}

/* هم‌انضباطِ causeForRow/followForRow، ولی به‌جای یک واژه‌نامه‌ی بسته یک بازه‌ی
   بسته: فقط وقتی verdict واقعاً "sell" است و ret عددی متناهی و در بازه‌ی
   (۰, ۱۰۰۰] است زنده می‌ماند، وگرنه undefined — یک ret ساختگی/دست‌ساز هم
   نباید در انبار بنشیند. عددِ برگشتی همیشه با یک رقمِ اعشار گرد شده است؛
   verdict.js خودش هم دقیقاً همین گرد‌کردن را قبل از فرستادن انجام می‌دهد،
   این‌جا فقط دوباره‌ سنجیده می‌شود، به آن اعتماد کورکورانه نمی‌شود. */
export function retForRow(verdict, ret) {
  if (verdict !== "sell") return undefined;
  if (typeof ret !== "number" || !Number.isFinite(ret) || ret <= 0 || ret > 1000) return undefined;
  return Math.round(ret * 10) / 10;
}

/* واژه‌نامه‌ی بسته‌ی follow — دقیقاً هم‌رده‌ی REPORT_CAUSES: امروز فقط دو
   عضو دارد، ولی فهرست است نه یک رشته‌ی تکی. */
export const REPORT_FOLLOWS = Object.freeze(["pool-empty", "pool-there"]);

/* هم‌انضباطِ causeForRow: یک follow ساختگی/دست‌ساز هرگز نباید در انبار
   بنشیند — فقط وقتی verdict واقعاً "sell" است و خودِ رشته عضوِ همین
   واژه‌نامه‌ی بسته است، وگرنه undefined. */
export function followForRow(verdict, follow) {
  if (verdict !== "sell") return undefined;
  return typeof follow === "string" && REPORT_FOLLOWS.includes(follow) ? follow : undefined;
}

/* واژه‌نامه‌ی بسته‌ی recheck — هم‌رده‌ی REPORT_FOLLOWS، ولی برای مسیرِ
   دیگر: پیگیریِ فالوآپ روی یک sell کار می‌کند، این یکی روی یک حکمِ
   nullِ (نامعلوم) کار می‌کند — «نمی‌دانم» یک نتیجه‌ی موقتی بود، شاید
   بعداً واقعاً sell/nosell دربیاید. */
export const REPORT_RECHECKS = Object.freeze(["sell", "nosell"]);

/* هم‌انضباطِ followForRow: یک recheck ساختگی/دست‌ساز هرگز نباید در انبار
   بنشیند — فقط وقتی verdictِ اصلیِ ردیف (نه recheck) واقعاً null است و
   خودِ رشته عضوِ همین واژه‌نامه‌ی بسته است، وگرنه undefined. */
export function recheckForRow(verdict, recheck) {
  if (verdict !== null) return undefined;
  return typeof recheck === "string" && REPORT_RECHECKS.includes(recheck) ? recheck : undefined;
}

/* یک ردیفِ ذخیره‌شده معمولاً هرگز بعد از نوشته‌شدن عوض نمی‌شود (mergeReportDoc
   بالاتر اول‌دیده‌شده‌می‌برد است و هرگز بازنویسی نمی‌کند) — این تابع تنها
   استثنای افزایشی/additive-only همان قاعده است، و **تنها جایی که یک ردیفِ
   ذخیره‌شده بعد از نوشته‌شدن ویرایش می‌شود**، همین‌جاست، هیچ‌کجای دیگر.
   خالص است، هرگز پرتاب نمی‌کند، همیشه یک سندِ تازه برمی‌گرداند (هرگز ورودی
   را جهش نمی‌دهد). برای هر {address, follow} در updates: اگر ردیفی با
   همان آدرس پیدا شود و v==="sell" باشد، هنوز کلیدِ follow نداشته باشد، و
   followForRow آن را معتبر بداند، یک کپی از همان ردیف با دقیقاً دو کلیدِ
   افزوده (follow و followAt) جایگزینِ ردیفِ قبلی می‌شود.
   🔴 هیچ کلیدِ دیگری از هیچ ردیفی عوض نمی‌شود، هیچ ردیفی افزوده/حذف/
   جابه‌جا نمی‌شود، و date/chains/checked/generatedAt همان می‌مانند که
   بودند. atIso باید یک رشته‌ی ISOِ خواندنی باشد؛ وگرنه کل فراخوانی سند را
   دست‌نخورده برمی‌گرداند. */
export function applyFollowUps(doc, updates, atIso) {
  try {
    if (typeof atIso !== "string" || Number.isNaN(Date.parse(atIso))) return doc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.rows)) return doc;
    if (!Array.isArray(updates)) return doc;

    // نقشه‌ی آدرس → follow پیشنهادی — فقط یک بار به‌ازای هر آدرس (اولین‌بار می‌برد).
    const followByAddr = new Map();
    for (const u of updates) {
      if (u && typeof u.address === "string" && typeof u.follow === "string" && !followByAddr.has(u.address)) {
        followByAddr.set(u.address, u.follow);
      }
    }
    if (followByAddr.size === 0) return doc;

    const rows = doc.rows.map((row) => {
      if (!row || typeof row.address !== "string" || !followByAddr.has(row.address)) return row;
      if (row.v !== "sell") return row; // نوسل/نامعلوم هرگز follow نمی‌گیرد
      if (Object.prototype.hasOwnProperty.call(row, "follow")) return row; // یک‌بار فالو، همیشه فالو
      const follow = followForRow(row.v, followByAddr.get(row.address));
      if (follow === undefined) return row; // رشته‌ی نامعتبر → بی‌اثر
      return { ...row, follow, followAt: atIso };
    });

    return { ...doc, rows };
  } catch (e) {
    return doc; // هرگز پرتاب نمی‌کند
  }
}

/* دومین استثنایِ additive-only بر همان قاعده‌ی mergeReportDoc — هم‌رده‌ی
   applyFollowUps، ولی روی حکمِ null: v و why اصلیِ ردیف *هرگز* بازنویسی
   نمی‌شوند؛ این یک مشاهده‌ی دومِ کنارِ اولی است، نه جایگزینِ آن. خالص است،
   هرگز پرتاب نمی‌کند، همیشه یک سندِ تازه برمی‌گرداند (هرگز ورودی را جهش
   نمی‌دهد). برای هر {address, recheck, cause} در updates: اگر ردیفی با
   همان آدرس پیدا شود و v===null باشد، هنوز کلیدِ recheck نداشته باشد، و
   recheckForRow آن را معتبر بداند، یک کپی از همان ردیف با کلیدهای recheck
   و recheckAt (و فقط برای recheck==="nosell"، اگر causeForRow آن را معتبر
   بداند، recheckCause هم) جایگزینِ ردیفِ قبلی می‌شود.
   🔴 هیچ کلیدِ دیگری از هیچ ردیفی عوض نمی‌شود، هیچ ردیفی افزوده/حذف/
   جابه‌جا نمی‌شود، و date/chains/checked/generatedAt همان می‌مانند که
   بودند. atIso باید یک رشته‌ی ISOِ خواندنی باشد؛ وگرنه کل فراخوانی سند را
   دست‌نخورده برمی‌گرداند. */
export function applyRechecks(doc, updates, atIso) {
  try {
    if (typeof atIso !== "string" || Number.isNaN(Date.parse(atIso))) return doc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.rows)) return doc;
    if (!Array.isArray(updates)) return doc;

    // نقشه‌ی آدرس → recheckِ پیشنهادی (+cause) — فقط یک بار به‌ازای هر آدرس.
    const recheckByAddr = new Map();
    for (const u of updates) {
      if (u && typeof u.address === "string" && typeof u.recheck === "string" && !recheckByAddr.has(u.address)) {
        recheckByAddr.set(u.address, { recheck: u.recheck, cause: u.cause });
      }
    }
    if (recheckByAddr.size === 0) return doc;

    const rows = doc.rows.map((row) => {
      if (!row || typeof row.address !== "string" || !recheckByAddr.has(row.address)) return row;
      if (row.v !== null) return row; // فقط ردیفِ حکمِ نامعلوم دوباره چک می‌شود
      if (Object.prototype.hasOwnProperty.call(row, "recheck")) return row; // یک‌بار recheck، همیشه recheck
      const proposed = recheckByAddr.get(row.address);
      const recheck = recheckForRow(row.v, proposed.recheck);
      if (recheck === undefined) return row; // رشته‌ی نامعتبر → بی‌اثر
      const next = { ...row, recheck, recheckAt: atIso };
      if (recheck === "nosell") {
        const recheckCause = causeForRow("nosell", proposed.cause);
        if (recheckCause !== undefined) next.recheckCause = recheckCause;
      }
      return next;
    });

    return { ...doc, rows };
  } catch (e) {
    return doc; // هرگز پرتاب نمی‌کند
  }
}

/* آدرس‌های ردیف‌هایی که کاندیدِ فالوآپِ ساعتی‌اند: chain==="base"،
   v==="sell"، هنوز follow ندارند، و checkedAt‌شان بینِ ۵۵ تا ۱۸۰ دقیقه
   پیش از nowMs است (هر دو مرز شاملند). قدیمی‌ترین اول، حداکثر cap تا —
   یک هزینه‌ی محدود در هر گذر، هرگز جاروبِ کلِ روز. */
export function pickFollowUpTargets(doc, nowMs, cap = 12) {
  try {
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.rows)) return [];
    if (!Number.isFinite(nowMs)) return [];
    const capNum = Number.isInteger(cap) && cap > 0 ? cap : 12;

    const candidates = [];
    for (const row of doc.rows) {
      if (!row || typeof row !== "object") continue;
      // 🔴 عمداً فقط Base: شاهدِ این فالوآپ (v4PoolsEmpty) یک قراردادِ Base
      // است، نه یک جاماندگی — سولانا هنوز شاهدِ خودش را ندارد.
      if (row.chain !== "base" || row.v !== "sell") continue;
      if (Object.prototype.hasOwnProperty.call(row, "follow")) continue;
      if (typeof row.checkedAt !== "string") continue;
      const checkedMs = Date.parse(row.checkedAt);
      if (Number.isNaN(checkedMs)) continue; // checkedAt ناخواندنی → کاندید نیست
      const ageMin = (nowMs - checkedMs) / 60000;
      if (ageMin < 55 || ageMin > 180) continue;
      candidates.push({ address: row.address, checkedMs });
    }
    candidates.sort((a, b) => a.checkedMs - b.checkedMs); // قدیمی‌ترین اول
    return candidates.slice(0, capNum).map((c) => c.address);
  } catch (e) {
    return [];
  }
}

/* آدرس‌های ردیف‌هایی که کاندیدِ رِی‌چکِ ساعتی‌اند: chain==="base"،
   v===null (نامعلوم — نه sell، نه nosell)، هنوز recheck ندارند، و
   checkedAt‌شان بینِ ۵۵ تا ۱۸۰ دقیقه پیش از nowMs است (هر دو مرز شاملند).
   قدیمی‌ترین اول، حداکثر cap تا — هم‌رده‌ی pickFollowUpTargets، همان بازه،
   همان ترتیب.
   🔴 برخلافِ pickFollowUpTargets که فقط آدرس برمی‌گرداند، اینجا dex هم
   لازم است: verdictOf برای ایندکسِ کلیدهای v4 به dex نیاز دارد (همان
   dexِ خودِ ردیف، نه یک حدس). یک recheck که خودش هم نامعلوم برگردد هیچ
   کلیدی ذخیره نمی‌کند (applyRechecks چیزی برایش نمی‌سازد)، پس ردیف همچنان
   کاندید می‌ماند تا سنش از ۱۸۰ دقیقه بگذرد — یعنی حداکثر سه تلاش (سه گذرِ
   ساعتی)؛ این محدودیت عمدی است، عضوِ سومی برای REPORT_RECHECKS اضافه
   نمی‌شود. */
export function pickRecheckTargets(doc, nowMs, cap = 4) {
  try {
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.rows)) return [];
    if (!Number.isFinite(nowMs)) return [];
    const capNum = Number.isInteger(cap) && cap > 0 ? cap : 4;

    const candidates = [];
    for (const row of doc.rows) {
      if (!row || typeof row !== "object") continue;
      // 🔴 عمداً فقط Base، هم‌رده‌ی pickFollowUpTargets.
      if (row.chain !== "base" || row.v !== null) continue;
      if (Object.prototype.hasOwnProperty.call(row, "recheck")) continue;
      if (typeof row.checkedAt !== "string") continue;
      const checkedMs = Date.parse(row.checkedAt);
      if (Number.isNaN(checkedMs)) continue; // checkedAt ناخواندنی → کاندید نیست
      const ageMin = (nowMs - checkedMs) / 60000;
      if (ageMin < 55 || ageMin > 180) continue;
      candidates.push({
        address: row.address,
        dex: typeof row.dex === "string" ? row.dex : null,
        checkedMs,
      });
    }
    candidates.sort((a, b) => a.checkedMs - b.checkedMs); // قدیمی‌ترین اول
    return candidates.slice(0, capNum).map((c) => ({ address: c.address, dex: c.dex }));
  } catch (e) {
    return [];
  }
}

/* یک ردیفِ گزارش، یا null. شکل برای v۱ قفل است — کلیدها به همین ترتیب.
   🔴 انبار همیشه عددِ خام نگه می‌دارد، هرگز رشته‌ی نمایشی. ogBig() در
   worker/og.js چیزی مثل "$1.2M" برمی‌گرداند — آن یک رندر است، نه داده؛ چیزی
   که رندر شده دیگر نمی‌شود مرتب کرد یا دوباره فرمت داد. priceUsd/vol24hUsd/
   fdvUsd/reserveUsd همیشه باید از attributes خامِ همان ردیفِ pool بیایند
   (newPoolRowToToken)، نه از meta.liquidity/meta.vol24 که از قبل ogBig
   شده‌اند — کسی این را به‌بهانه‌ی «ساده‌سازی» به meta برنگرداند.
   🔴 why (کلیدِ آخر، v۲): چرا یک verdictِ null به null رسید — فقط برای
   اندازه‌گیری (زیرِ ۲۷ب worker/test.mjs)، هیچ خواننده‌ی دیگری (reportText
   ازجمله) رفتارش را از رویِ آن عوض نمی‌کند. */
export function reportRow({
  chain, address, symbol, name, verdict, checkedAt, poolCreatedAt, priceUsd, reserveUsd, vol24hUsd, fdvUsd, dex,
  why, cause, ret,
}) {
  try {
    if (verdict !== "sell" && verdict !== "nosell" && verdict !== null) return null; // هرگز یک حکم ساختگی

    // ⚠️ checkKind فقط از این جدول خوانده می‌شود — هیچ پارامترِ ورودی‌ای برای
    // آن نیست، پس هر «checkKind» که در آرگومان تابع نشسته باشد اصلاً
    // destructure نمی‌شود و بی‌صدا دورریخته می‌شود. این خودِ نکته‌ی این فیلد است.
    const checkKind = Object.prototype.hasOwnProperty.call(CHECK_KIND_BY_CHAIN, chain)
      ? CHECK_KIND_BY_CHAIN[chain]
      : null;
    if (!checkKind) return null; // زنجیره‌ای که در جدول نیست → کلاً رد، نه یک checkKind حدسی

    if (typeof checkedAt !== "string" || checkedAt.length === 0 || Number.isNaN(Date.parse(checkedAt)))
      return null;

    const row = {
      chain,
      address,
      symbol: typeof symbol === "string" ? symbol : null,
      name: typeof name === "string" ? name : null,
      v: verdict,
      checkKind,
      checkedAt,
      poolCreatedAt: poolCreatedAt == null ? null : poolCreatedAt,
      priceUsd: storedNumber(priceUsd),
      reserveUsd: storedNumber(reserveUsd),
      vol24hUsd: storedNumber(vol24hUsd),
      fdvUsd: storedNumber(fdvUsd),
      dex: dex == null ? null : dex,
      why: whyForRow(chain, verdict, why),
    };
    // 🔴 cause فقط وقتی روی شیء می‌نشیند که واقعاً معنا داشته باشد — برخلافِ
    // why (که همیشه null یا یک رشته است)، undefined هرگز نباید یک کلید
    // بسازد، وگرنه سندهای امروز که اصلاً cause ندارند دیگر با سندهای تازه
    // قابلِ‌مقایسه نمی‌مانند.
    const rowCause = causeForRow(verdict, cause);
    if (rowCause !== undefined) row.cause = rowCause;
    // 🔴 هم‌انضباطِ cause: ret فقط وقتی کلید می‌سازد که واقعاً معنا داشته
    // باشد — undefined هرگز کلید نمی‌شود، وگرنه سندهای امروز که اصلاً ret
    // ندارند دیگر با سندهای تازه قابلِ‌مقایسه نمی‌مانند.
    const rowRet = retForRow(verdict, ret);
    if (rowRet !== undefined) row.ret = rowRet;
    return row;
  } catch (e) {
    return null;
  }
}

/* سند یک روز را با ردیف‌های تازه ادغام می‌کند. اول‌دیده‌شده می‌برد: توکنی که
   ساعت ۹ چک شده حکمِ همان ساعت را نگه می‌دارد، ساعت ۱۰ آن را بازنویسی
   نمی‌کند. سندِ ناقص یا غایب یعنی روزِ خالی، نه خطا. */
export function mergeReportDoc(prevDoc, dateStr, newRows, checkedDelta, generatedAt) {
  try {
    const prev = (prevDoc && typeof prevDoc === "object" && Array.isArray(prevDoc.rows)) ? prevDoc : null;
    const seen = new Set();
    const rows = [];
    for (const r of (prev ? prev.rows : [])) {
      if (r && typeof r.address === "string" && !seen.has(r.address)) {
        seen.add(r.address);
        rows.push(r);
      }
    }
    for (const r of (Array.isArray(newRows) ? newRows : [])) {
      if (r && typeof r.address === "string" && !seen.has(r.address)) {
        seen.add(r.address);
        rows.push(r);
      }
    }
    const prevChecked = prev && Number.isFinite(prev.checked) ? prev.checked : 0;
    const delta = Number.isFinite(checkedDelta) ? checkedDelta : 0;

    // chains از رویِ خودِ ردیف‌های ادغام‌شده — نه یک ثابتِ Base-فقط، حالا که
    // سولانا هم می‌تواند در همین سند بنشیند. مرتب و بی‌تکرار؛ روزِ بدونِ
    // هیچ ردیفی (هنوز چیزی چک نشده) به همان ["base"] پیش‌فرض برمی‌گردد.
    const chainsSet = new Set();
    for (const r of rows) {
      if (r && typeof r.chain === "string") chainsSet.add(r.chain);
    }
    const chains = chainsSet.size > 0 ? Array.from(chainsSet).sort() : ["base"];

    return {
      date: dateStr,
      generatedAt: generatedAt || null,
      chains,
      checked: prevChecked + delta,
      rows, // 🔴 حتی وقتی هیچ‌چیز پیدا نشد، این [] می‌ماند — یک سندِ نیمه‌ساخته هرگز نباید وجود داشته باشد
    };
  } catch (e) {
    return emptyReportDoc(dateStr);
  }
}

/* حلقه‌ی «تازه‌ها» — نمای زنده، نه بایگانی؛ اینجا برخلافِ mergeReportDoc تازه
   می‌برد، چون این نما دنبالِ «همین الان چه چیزی جدید است» است. */
export function mergePairsRing(prevRows, newRows, cap = REPORT_PAIRS_CAP) {
  try {
    const combined = [].concat(
      Array.isArray(newRows) ? newRows : [],
      Array.isArray(prevRows) ? prevRows : [],
    );
    const seen = new Set();
    const out = [];
    for (const r of combined) {
      if (!r || typeof r.address !== "string" || seen.has(r.address)) continue;
      seen.add(r.address);
      out.push(r);
      if (out.length >= cap) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function safeKvGetJson(kv, key) {
  try {
    const raw = await kv.get(key);
    if (typeof raw !== "string") return null;
    return JSON.parse(raw);
  } catch (e) {
    return null; // بایندینگ نبود، خواندن پرتاب کرد، یا JSON خراب بود — هر سه یعنی «چیزی نداریم»
  }
}

async function safeKvPutJson(kv, key, value) {
  try {
    await kv.put(key, JSON.stringify(value));
  } catch (e) {
    /* نوشتنِ ناموفق نباید کل اجرا را بشکند — این تابع هرگز پرتاب نمی‌کند */
  }
}

// خواندنِ حلقه‌ی لاگِ گذر — کالرِ /vd/passes همین را صدا می‌زند، نه kv.get
// مستقیم، تا شکلِ «آرایه یا []» یک‌جا تضمین شود.
export async function readPassLog(kv) {
  const arr = await safeKvGetJson(kv, PASS_LOG_KEY);
  return Array.isArray(arr) ? arr : [];
}

/* واژه‌نامه‌ی بسته‌ی پروبِ سقفِ ساب‌ریکوئست — فقط برای اندازه‌گیریِ اینکه
   گذرِ ساعتی به سقفِ ساب‌ریکوئستِ Worker می‌خورد یا نه، هیچ رفتاری از خودِ
   گذر را عوض نمی‌کند. */
export const REPORT_CAP_PROBE = Object.freeze(["ok", "cap", "timeout", "threw"]);

/* واژه‌نامه‌ی بسته‌ی نامِ مرحله برای متر ساب‌ریکوئست (worker/index.js →
   makeSubMeter) — فقط اندازه‌گیریِ اینکه هر مرحله‌ی گذر چند ساب‌ریکوئست
   می‌خورد، هیچ رفتاری از خودِ گذر را عوض نمی‌کند. runReportPass زیرِ همین
   فایل دقیقاً همین هشت نام را به meter.stage() می‌دهد، هیچ نامِ دیگری هرگز —
   یک نامِ دست‌ساز/اشتباه‌تایپ‌شده فقط یعنی آن ساب‌ریکوئست‌ها زیرِ نامِ قبلی
   می‌مانند، نه یک شکستِ خاموش. */
export const REPORT_METER_STAGES = Object.freeze([
  "pools", "base-token", "follow", "recheck", "sol-pools", "sol-token", "probe", "kv-write",
]);

/* probeFetch یک تزریق است (کالر در worker/index.js یک fetch با HEAD/AbortController
   می‌سازد) — این تابع فقط نتیجه‌اش را به یکی از چهار برچسبِ بالا می‌بندد:
     - هر Response (با هر status) یعنی درخواست واقعاً رفت‌وبرگشت کرد → "ok"
     - AbortError یعنی به مهلتِ ۱۵۰۰ میلی‌ثانیه‌ای خورد، نه به سقفِ پلتفرم → "timeout"
     - پیامی که با /too many subrequests/i جور دربیاید → "cap"؛ 🔴 این یک کلاس
       تنها از رویِ متنِ پیام سنجیده می‌شود چون خودِ پلتفرم برایش هیچ کدِ
       جداگانه‌ای نمی‌دهد — کنترلِ مثبتِ زیرِ تست‌ها (یک ۴۲۹ی واقعی → "ok"،
       یک AbortError واقعی → "timeout") همان چیزی است که این کلاس را
       قابل‌اعتماد می‌کند، نه حدس.
     - هر چیزِ دیگر (شکلِ غیرِمنتظره، خطای دیگر) → "threw"
   هرگز پرتاب نمی‌کند. */
export async function classifyCapProbe(probeFetch) {
  try {
    const res = await probeFetch();
    return res instanceof Response ? "ok" : "threw";
  } catch (e) {
    if (e && e.name === "AbortError") return "timeout";
    if (e && typeof e.message === "string" && /too many subrequests/i.test(e.message)) return "cap";
    return "threw";
  }
}

// n/nulls/firstNullIdx ردیف‌های یک زنجیره‌ی *همین گذر*، به همان ترتیبِ چکیده‌شدن
// (builtRows/builtRowsSol خودشان همان ترتیب را دارند، چون هر توکن پشتِ سرِ هم
// push می‌شود). فقط عدد؛ هیچ آدرس/symbol/why اینجا وارد نمی‌شود.
function passChainStats(builtRowsChain) {
  const n = builtRowsChain.length;
  let nulls = 0;
  let firstNullIdx = -1;
  for (let i = 0; i < n; i++) {
    if (builtRowsChain[i].v === null) {
      nulls++;
      if (firstNullIdx === -1) firstNullIdx = i;
    }
  }
  return { n, nulls, firstNullIdx };
}

/* سقفِ توکن‌های یک گذر. اجرای دستی (سنجش) عددِ کوچک‌تری می‌دهد تا پاسخ در
   چند ثانیه برگردد، ولی هیچ کالری نمی‌تواند سقف را از REPORT_MAX_TOKENS_PER_RUN
   بالاتر ببرد — وگرنه همان اندپوینتِ سنجش راهی می‌شد برای سوزاندنِ سهمیه. */
function tokenCap(maxTokens) {
  return Number.isInteger(maxTokens) && maxTokens > 0
    ? Math.min(maxTokens, REPORT_MAX_TOKENS_PER_RUN)
    : REPORT_MAX_TOKENS_PER_RUN;
}

/* همان انضباطِ tokenCap، ولی برای پایِ سولانا: سقفِ پیش‌فرض و سقفِ سخت هر
   دو ۶‌اند — هزینه‌ی این پا باید محدود بماند، هرچه بالادست بدهد. */
export const REPORT_SOL_MAX_TOKENS = 6;
function solTokenCap(maxTokens) {
  return Number.isInteger(maxTokens) && maxTokens > 0
    ? Math.min(maxTokens, REPORT_SOL_MAX_TOKENS)
    : REPORT_SOL_MAX_TOKENS;
}

/* گذرِ گزارش‌گیریِ ساعتی. همه‌چیز تزریق می‌شود؛ خودِ این تابع نه I/O دارد نه
   fetch مستقیم.
   🔴 ترتیبِ مراحل: Base → نوشتنِ اول (فقط ردیف‌های Base) → فالوآپ → رِی‌چک
   → سولانا → نوشتنِ دوم (اگر سولانا چیزی داشت) → پروب → لاگِ گذر. سولانا
   دیگر بلافاصله بعدِ Base نمی‌آید — هر توکنِ سولانا ۶ تا ۱۲ ساب‌ریکوئست
   می‌خورد و وقتی زودتر می‌آمد بودجه را می‌بلعید، پس فالوآپ/رِی‌چک در
   گذرهای زنده همیشه صفر ثبت می‌شدند. حالا آن دو مرحله‌ی ارزان‌تر همیشه
   فرصتِ اجرا دارند و سولانا (گران‌ترین پا) اولین چیزی است که سقف کنارش
   می‌گذارد.
   fetchPoolsSol/solMaxTokens اختیاری‌اند: fetchPoolsSol غایب یا پرتاب‌کننده
   یعنی «این گذر سولانایی ندارد»، هرگز یعنی شکستِ کل گذر.
   🔴 capHit اختیاری است: تابعی که هر بار صدا زده می‌شود می‌گوید «همین الان
   به سقفِ ساب‌ریکوئستِ Worker خورده‌ایم یا نه» (کالر — scheduledReportPassInner
   در index.js — () => meter.isCapHit() را پاس می‌دهد). غایب → همیشه false،
   یعنی گذرِ بدونِ این تزریق بایت‌به‌بایت همان چیزی می‌ماند که امروز است.
   پیش از شروعِ هر توکنِ Base، هر توکنِ سولانا، هر هدفِ فالوآپ و هر هدفِ
   رِی‌چک سنجیده می‌شود: true یعنی همان مرحله همین‌جا متوقف می‌شود و هر
   مرحله‌ی بعدی هم کلاً شروع نمی‌شود (stoppedAt نامِ همان مرحله را نگه
   می‌دارد). اگر سقف *در میانه‌ی* کارِ یک توکن/هدف زده شود، آن یکی هم
   دور ریخته می‌شود (نه در سند نه در حلقه‌ی pairs) — یک ردیفِ نامعلومِ
   ساختگی، فقط به‌خاطرِ بودجه‌ی خودمان، هرگز نباید ذخیره شود؛ discarded
   شمارشِ همین ردیف‌های دورریخته است. metaMany اختیاری است: یک تماسِ
   دسته‌ای پیش از حلقه‌ی Base که به‌جای N تماسِ metaOf یکی می‌شود؛ غایب یا
   ناموفق (null) یعنی بایت‌به‌بایت همان مسیرِ metaOf تک‌آدرسه‌ی امروز. */
export async function runReportPass({
  kv, fetchPools, metaOf, verdictOf, now, sleep, maxTokens, poolEmptyOf, fetchPoolsSol, solMaxTokens,
  probeFetch, meter, capHit, metaMany,
}) {
  try {
    // 🔴 بدون انباری برای نوشتن، هیچ تماسِ بالادستی مجاز نیست — قبل از هر
    // چیز دیگری، حتی قبل از fetchPools.
    if (!kv) return { checked: 0, added: 0 };

    /* meter یک تزریقِ اختیاریِ محض است (هم‌رده‌ی out در cachedVerdict/
       whyOut در fetchVerdict): غایب یا بدشکل یعنی سه تابعِ زیر کاملاً
       بی‌اثرند، پس گذرِ بدونِ meter بایت‌به‌بایت همان چیزی می‌ماند که امروز
       است — نه یک fetch/cache واقعی اینجا شمرده می‌شود (آن‌ها بیرون از این
       تابعِ خالص، در worker/index.js، با جایگزینیِ موقتِ globalThis.fetch/
       caches.default رخ می‌دهند)، فقط برچسبِ «الان کدام مرحله‌ایم» و
       شروع/پایانِ شمارشِ هر توکن. */
    const m = meter && typeof meter === "object" ? meter : null;
    function mStage(name) { if (m && typeof m.stage === "function") m.stage(name); }
    function mTokenStart() { if (m && typeof m.tokenStart === "function") m.tokenStart(); }
    function mTokenEnd() { if (m && typeof m.tokenEnd === "function") m.tokenEnd(); }

    // capHit غایب → همیشه false؛ یک capHit که خودش پرتاب کند هم یعنی false
    // (هرگز حدسی به‌جای «نمی‌دانم» ساخته نمی‌شود).
    function isCapped() {
      if (typeof capHit !== "function") return false;
      try { return !!capHit(); } catch (e) { return false; }
    }
    // کجا گذر ایستاد (نامِ یکی از REPORT_METER_STAGES) — null یعنی هرگز
    // نایستاد. یک‌بار نوشته می‌شود، اولین مرحله‌ای که سقف را دید می‌برد.
    let stoppedAt = null;
    // چند ردیف/به‌روزرسانی به‌خاطرِ زدن به سقف در میانه‌ی کارش دور ریخته شد —
    // نه در سند نه در حلقه‌ی pairs، تا گذرِ ساعتیِ بعدی دوباره سراغش برود.
    let discarded = 0;

    mStage("pools");
    let rawRows;
    try {
      rawRows = await fetchPools();
    } catch (e) {
      return { checked: 0, added: 0 };
    }
    if (!Array.isArray(rawRows)) return { checked: 0, added: 0 };

    const seenAddr = new Set();
    const candidates = [];
    for (const row of rawRows) {
      const t = newPoolRowToToken(row);
      if (!t || seenAddr.has(t.address)) continue;
      seenAddr.add(t.address);
      candidates.push(t);
    }

    const prevPairsRows = (await safeKvGetJson(kv, PAIRS_KEY_BASE)) || [];
    const prevPairsArr = Array.isArray(prevPairsRows) ? prevPairsRows : [];
    const knownAddr = new Set(
      prevPairsArr.filter((r) => r && typeof r.address === "string").map((r) => r.address),
    );

    const tokens = candidates
      .filter((t) => !knownAddr.has(t.address))
      .slice(0, tokenCap(maxTokens));

    /* متادیتای دسته‌ایِ Base — پیش از حلقه، فقط وقتی metaMany تزریق شده،
       دقیقاً یک بار با همان آدرس‌هایی که همین گذر می‌خواهد چک کند.
       متاBatch فقط برای اندازه‌گیری است ("absent" وقتی اصلاً تزریق نشده،
       "failed" وقتی تماس null داد، "ok" وقتی یک Map برگشت — هر سه فقط در
       رکوردِ لاگ می‌نشینند، هیچ رفتاری از رویشان تغییر نمی‌کند این‌جا،
       تصمیم زیرِ همان `if (metaMap)` است). batch ناموفق → metaMap همان
       null می‌ماند و هر توکن دقیقاً مسیرِ metaOf تک‌آدرسه‌ی امروز را طی
       می‌کند؛ batch موفق → هیچ توکنی دیگر metaOf را صدا نمی‌زند. */
    let metaMap = null;
    let metaBatch = "absent";
    if (typeof metaMany === "function") {
      mStage("base-token");
      try {
        metaMap = await metaMany(tokens.map((t) => t.address));
      } catch (e) {
        metaMap = null;
      }
      metaBatch = metaMap ? "ok" : "failed";
    }

    const builtRows = [];
    // شمارشِ پا جدا از هم: checkedBase در همین حلقه، checkedSol در حلقه‌ی
    // سولانا (پایین‌تر، بعد از فالوآپ/رِی‌چک) — checked نهایی جمعِ این دو است.
    let checkedBase = 0;
    for (const t of tokens) {
      if (stoppedAt === null && isCapped()) stoppedAt = "base-token";
      if (stoppedAt !== null) break; // سقف پیش از شروعِ این توکن دیده شد — نه این یکی نه هیچ‌کدامِ بعدی

      // پیش از هر توکن، هرگز موازی — یک نودِ حساس به نرخ زیرِ فشارِ چند
      // تماسِ هم‌زمان قرار نگیرد.
      await sleep(REPORT_PACE_MS);
      checkedBase++;
      mStage("base-token");
      mTokenStart();

      // metaOf باید { meta, why } بدهد — شکلِ دیگر (پرتاب، غیرِشیء، بدونِ
      // کلیدِ meta) یعنی metaOf خودش قابلِ‌اعتماد نبود: meta می‌شود null و
      // metaWhy می‌شود "internal"، نه یک حدس از رویِ چیزی که نیامد.
      // ⚠️ metaMap فقط وقتی صدا زده می‌شود که batch واقعاً موفق بود
      // (metaMap !== null) — یک batchِ ناموفق یعنی این توکن هم دقیقاً
      // همان metaOf تک‌آدرسه‌ی امروز را صدا می‌زند، بدونِ هیچ افتی.
      let metaResult;
      if (metaMap) {
        metaResult = metaMap.get(t.address) || { meta: null, why: "meta:404" };
      } else {
        try { metaResult = await metaOf(t.address); } catch (e) { metaResult = null; }
      }
      const metaOk = !!metaResult && typeof metaResult === "object" &&
        Object.prototype.hasOwnProperty.call(metaResult, "meta");
      const meta = metaOk && metaResult.meta && typeof metaResult.meta === "object" ? metaResult.meta : null;
      const metaWhy = metaOk ? metaResult.why : "internal";

      // ⚠️ metaOf که meta:null می‌دهد به‌معنای «حکم نه» نیست — «نمی‌دانم» یک
      // نتیجه است، پس verdictOf همچنان صدا زده می‌شود، با metaWhy همراهش تا
      // خودش تصمیم بگیرد «هیچ تلاشی نکردم» را چه بنامد.
      // verdictOf هم همان قاعده‌ی متاOf را دارد: شکلِ دیگر → v:null، why:"internal".
      let verdictResult;
      // dex هم پاس داده می‌شود: کالر (worker/index.js) برای دکسِ v4 پیش از
      // حکم کلیدِ واقعی را ایندکس می‌کند. این تابع خودش هیچ تصمیمی از رویش
      // نمی‌گیرد — فقط همان چیزی را که از newPoolRowToToken آمده رد می‌کند.
      try { verdictResult = await verdictOf(t.address, meta, metaWhy, t.dex); } catch (e) { verdictResult = null; }
      const verdictOk = !!verdictResult && typeof verdictResult === "object" &&
        Object.prototype.hasOwnProperty.call(verdictResult, "v");
      const verdict = verdictOk ? verdictResult.v : null;
      const why = verdictOk ? verdictResult.why : "internal";
      // همان انضباطِ شکلِ why: یک verdictResult ناسالم (غیرِشیء) یعنی هیچ
      // cause‌ای هم نداریم — undefined، نه یک حدس.
      const cause = verdictOk ? verdictResult.cause : undefined;
      // همان انضباط برای ret — فقط وقتی verdictResult واقعاً شیء است چیزی
      // غیرِundefined می‌شود؛ reportRow/retForRow خودشان باز هم می‌سنجندش.
      const ret = verdictOk ? verdictResult.ret : undefined;

      const checkedAt = new Date(now()).toISOString();
      // ⚠️ priceUsd/vol24hUsd/fdvUsd همیشه از t (همان ردیفِ pool که
      // newPoolRowToToken برگرداند) می‌آیند، هرگز از meta — metaOf که null
      // برگرداند فقط name/symbol را می‌گیرد، نه این سه عدد را؛ توکنی که
      // متادیتایش نیامده نباید قیمت/حجم/FDVاش را هم از دست بدهد.
      const row = reportRow({
        chain: "base",
        address: t.address,
        symbol: meta && typeof meta.symbol === "string" ? meta.symbol : null,
        name: meta && typeof meta.name === "string" ? meta.name : null,
        verdict,
        checkedAt,
        poolCreatedAt: t.poolCreatedAt,
        priceUsd: t.priceUsd,
        reserveUsd: t.reserveUsd,
        vol24hUsd: t.vol24hUsd,
        fdvUsd: t.fdvUsd,
        dex: t.dex,
        why,
        cause,
        ret,
      });
      mTokenEnd();

      // سقف در میانه‌ی همین توکن دیده شد → این یکی هم دور ریخته می‌شود
      // (نه در سند نه در حلقه‌ی pairs) و هیچ توکنِ بعدی هم شروع نمی‌شود —
      // یک «نامعلوم»ِ ساختگیِ برخاسته از بودجه‌ی خودمان، نه از خودِ توکن.
      if (isCapped()) {
        discarded++;
        if (stoppedAt === null) stoppedAt = "base-token";
        break;
      }
      if (row) builtRows.push(row);
    }

    const nowMs = now();
    const dateStr = utcDateOf(nowMs);
    const generatedAt = new Date(nowMs).toISOString();

    /* نوشتنِ اول: فقط ردیف‌های Base، فقط checkedBase. ترتیبِ تازه‌ی گذر
       Base → نوشتن → فالوآپ → رِی‌چک → سولانا است (پایِ سولانا پایین‌تر،
       بعد از رِی‌چک می‌آید — دلیلش کنارِ همان بلوک توضیح داده شده)، پس تا
       همین‌جا فقط همین چیزی است که داریم. */
    const prevDoc = await safeKvGetJson(kv, reportKey(dateStr));
    const newDoc = mergeReportDoc(prevDoc, dateStr, builtRows, checkedBase, generatedAt);
    // 🔴 حلقه‌ی «تازه‌ها» فقط Base است — سولانا هرگز وارد pairs:base:latest
    // نمی‌شود، حتی وقتی همین گذر ردیفِ سولانایی هم اضافه کرده باشد.
    const newPairs = mergePairsRing(prevPairsArr, builtRows, REPORT_PAIRS_CAP);

    mStage("kv-write");
    await safeKvPutJson(kv, reportKey(dateStr), newDoc);
    await safeKvPutJson(kv, PAIRS_KEY_BASE, newPairs);

    /* فالوآپِ «یک ساعت بعد»: سندِ همین گذر که تازه نوشته شد، نه بایگانیِ
       روزهای پیش — پس ردیفِ تازه‌نوشته‌ی همین گذر هم می‌تواند خودش کاندید
       باشد (اگر checkedAt‌اش به‌اندازه‌ی کافی قدیمی باشد، که در یک گذرِ
       تک نیست، ولی قاعده یکی است). 🔴 این گام هرگز نباید خودِ گذر را
       بشکند: بدونِ poolEmptyOf کلاً رد می‌شود، و هر شکستی داخلش فقط یعنی
       followed:0 — سندی که همین بالا نوشته شد دست‌نخورده می‌ماند. */
    // 🔴 latestDoc همیشه آخرین سندی است که واقعاً در KV نوشته شده — فالوآپ
    // اگر چیزی نوشت آن را جلو می‌برد، وگرنه همان newDoc می‌ماند. گامِ
    // رِی‌چکِ زیر روی همین latestDoc کار می‌کند تا کارِ فالوآپ را دوباره‌نویسی
    // نکند (clobber نکند).
    let latestDoc = newDoc;
    let followed = 0;
    // stoppedAt !== null یعنی سقف قبلاً دیده شده (پایِ Base یا سولانا) —
    // این مرحله اصلاً شروع نمی‌شود.
    if (typeof poolEmptyOf === "function" && stoppedAt === null) {
      try {
        mStage("follow");
        const targets = pickFollowUpTargets(newDoc, nowMs, 3);
        const updates = [];
        for (const address of targets) {
          if (stoppedAt === null && isCapped()) stoppedAt = "follow";
          if (stoppedAt !== null) break; // سقف پیش از این هدف دیده شد

          // هر آدرس تویِ try/catچِ خودش — یک پرتاب یعنی این یکی آدرس رد
          // می‌شود، هرگز یک حدس.
          let empty;
          try {
            empty = await poolEmptyOf(address);
          } catch (e) {
            empty = null;
          }

          // سقف در میانه‌ی همین هدف دیده شد → به‌روزرسانی‌اش اعمال
          // نمی‌شود، و مرحله همین‌جا متوقف می‌شود.
          if (isCapped()) {
            discarded++;
            if (stoppedAt === null) stoppedAt = "follow";
            break;
          }
          if (empty === true) updates.push({ address, follow: "pool-empty" });
          else if (empty === false) updates.push({ address, follow: "pool-there" });
          // null/undefined/هرچیزِ دیگر → اصلاً آپدیتی برای این آدرس نیست
        }
        if (updates.length > 0) {
          const followedDoc = applyFollowUps(newDoc, updates, generatedAt);
          mStage("kv-write");
          await safeKvPutJson(kv, reportKey(dateStr), followedDoc);
          latestDoc = followedDoc;
          // شمارشِ واقعی: فقط ردیف‌هایی که واقعاً follow گرفتند، نه صرفاً
          // طولِ updates (که در تئوری می‌تواند بیشتر از ردیف‌های واقعاً
          // تغییریافته باشد).
          for (const u of updates) {
            const row = followedDoc.rows.find((r) => r && r.address === u.address);
            if (row && row.follow === u.follow) followed++;
          }
        }
      } catch (e) {
        followed = 0;
      }
    }

    /* رِی‌چکِ «یک ساعت بعد» برای ردیف‌هایی که حکمشان null ماند — دقیقاً
       هم‌رده‌ی گامِ فالوآپِ بالا، ولی روی latestDoc (نه newDoc خام) تا
       چیزی که فالوآپ همین بالا نوشت پاک نشود. هیچ تزریقِ تازه‌ای لازم
       نیست: همان metaOf/verdictOfِ حلقه‌ی اصلی دوباره صدا زده می‌شوند،
       دقیقاً با همان قاعده‌ی شکل‌سنجی. 🔴 این گام هم هرگز نباید خودِ گذر
       یا فالوآپِ بالا را بشکند — هر شکستی فقط یعنی rechecked:0. */
    let rechecked = 0;
    let recheckTried = 0;
    // stoppedAt !== null یعنی سقف قبلاً دیده شده — این مرحله اصلاً شروع نمی‌شود.
    if (stoppedAt === null) try {
      mStage("recheck");
      const targets = pickRecheckTargets(latestDoc, nowMs, 2);
      const updates = [];
      for (const t of targets) {
        if (stoppedAt === null && isCapped()) stoppedAt = "recheck";
        if (stoppedAt !== null) break; // سقف پیش از این هدف دیده شد

        recheckTried++;
        // هر هدف تویِ try/catچِ خودش — یک پرتاب یعنی این یکی هدف رد
        // می‌شود، هرگز کل حلقه را نمی‌شکند.
        try {
          await sleep(REPORT_PACE_MS);

          let metaResult;
          try { metaResult = await metaOf(t.address); } catch (e) { metaResult = null; }
          const metaOk = !!metaResult && typeof metaResult === "object" &&
            Object.prototype.hasOwnProperty.call(metaResult, "meta");
          const meta = metaOk && metaResult.meta && typeof metaResult.meta === "object" ? metaResult.meta : null;
          const metaWhy = metaOk ? metaResult.why : "internal";

          let verdictResult;
          try { verdictResult = await verdictOf(t.address, meta, metaWhy, t.dex); } catch (e) { verdictResult = null; }
          const verdictOk = !!verdictResult && typeof verdictResult === "object" &&
            Object.prototype.hasOwnProperty.call(verdictResult, "v");
          const v = verdictOk ? verdictResult.v : null;
          const cause = verdictOk ? verdictResult.cause : undefined;

          // سقف در میانه‌ی همین هدف دیده شد → به‌روزرسانی‌اش اعمال نمی‌شود؛
          // حلقه با گاردِ سرِ همین for (بالاتر) پیش از هدفِ بعدی متوقف می‌شود.
          if (isCapped()) {
            discarded++;
            if (stoppedAt === null) stoppedAt = "recheck";
          } else if (v === "sell" || v === "nosell") {
            updates.push({ address: t.address, recheck: v, cause });
          }
          // null/هرچیزِ دیگر → همچنان نامعلوم، اصلاً آپدیتی برای این آدرس نیست
          // (و ردیف کاندید می‌ماند تا سنش از ۱۸۰ دقیقه بگذرد)
        } catch (e) {
          /* این یک هدف رد می‌شود، هرگز یک حدس */
        }
      }
      if (updates.length > 0) {
        const rechDoc = applyRechecks(latestDoc, updates, generatedAt);
        mStage("kv-write");
        await safeKvPutJson(kv, reportKey(dateStr), rechDoc);
        latestDoc = rechDoc;
        for (const u of updates) {
          const row = rechDoc.rows.find((r) => r && r.address === u.address);
          if (row && row.recheck === u.recheck) rechecked++;
        }
      }
    } catch (e) {
      rechecked = 0;
    }

    /* پایِ سولانا — حالا اینجا، بعد از فالوآپ و رِی‌چک، نه بلافاصله بعدِ
       Base. دلیل: هر توکنِ سولانا ۶ تا ۱۲ ساب‌ریکوئست می‌خورد (metaOf +
       verdictOf با چند تلاشِ RPC/دکس)، و وقتی این پا بلافاصله بعدِ Base
       می‌آمد بودجه را می‌بلعید — در گذرهای زنده followed/rechecked همیشه
       صفر ثبت می‌شد چون سقف پیش از رسیدنِ نوبتِ آن‌ها می‌خورد. ترتیبِ
       Base → نوشتن → فالوآپ → رِی‌چک → سولانا یعنی آن دو مرحله‌ی ارزان‌تر
       همیشه فرصتِ اجرا دارند، و اگر سقف بخورد اول سولانا (گران‌ترین پا)
       کنار می‌رود، نه فالوآپ/رِی‌چک.
       همان پیس/همان sleep/همان REPORT_PACE_MS. fetchPoolsSol که نباشد یا
       پرتاب کند یعنی «این گذر سولانایی ندارد»، نه شکستِ گذر — همان قاعده‌ای
       که fetchPools در بالا (وقتی خودِ Base شکست بخورد) کلِ گذر را متوقف
       می‌کند اینجا برعکس است: فقط این یک پا را خالی می‌گذارد.
       🔴 stoppedAt !== null یعنی سقف قبلاً (تویِ Base، فالوآپ یا رِی‌چک)
       دیده شده — این پا اصلاً شروع نمی‌شود، حتی fetchPoolsSol هم صدا زده
       نمی‌شود؛ رِی‌چک هم مثلِ فالوآپ می‌تواند stoppedAt را ست کند، پس یک
       سقف در رِی‌چک یعنی سولانا هرگز شروع نمی‌شود و fetchPoolsSol هرگز
       صدا زده نمی‌شود. */
    const builtRowsSol = [];
    let checkedSol = 0;
    if (typeof fetchPoolsSol === "function" && stoppedAt === null) {
      mStage("sol-pools");
      let rawRowsSol;
      try {
        rawRowsSol = await fetchPoolsSol();
      } catch (e) {
        rawRowsSol = null;
      }
      if (Array.isArray(rawRowsSol)) {
        const seenAddrSol = new Set();
        const candidatesSol = [];
        for (const row of rawRowsSol) {
          const t = newPoolRowToTokenFor("solana", row);
          if (!t || seenAddrSol.has(t.address)) continue;
          seenAddrSol.add(t.address);
          candidatesSol.push(t);
        }

        const tokensSol = candidatesSol.slice(0, solTokenCap(solMaxTokens));

        for (const t of tokensSol) {
          if (stoppedAt === null && isCapped()) stoppedAt = "sol-token";
          if (stoppedAt !== null) break;

          await sleep(REPORT_PACE_MS);
          checkedSol++;
          mStage("sol-token");
          mTokenStart();

          // همان انضباطِ متاOf/verdictOf که پایِ Base بالاتر دارد — این دو
          // تابع خودشان زنجیره‌آگاه‌اند (از رویِ chainOf(addr))، پس همان
          // تزریق‌شده‌ی کالر برای هر دو پا کافی است.
          let metaResult;
          try { metaResult = await metaOf(t.address); } catch (e) { metaResult = null; }
          const metaOk = !!metaResult && typeof metaResult === "object" &&
            Object.prototype.hasOwnProperty.call(metaResult, "meta");
          const meta = metaOk && metaResult.meta && typeof metaResult.meta === "object" ? metaResult.meta : null;
          const metaWhy = metaOk ? metaResult.why : "internal";

          let verdictResult;
          try { verdictResult = await verdictOf(t.address, meta, metaWhy, t.dex); } catch (e) { verdictResult = null; }
          const verdictOk = !!verdictResult && typeof verdictResult === "object" &&
            Object.prototype.hasOwnProperty.call(verdictResult, "v");
          const verdict = verdictOk ? verdictResult.v : null;
          const why = verdictOk ? verdictResult.why : "internal";
          const cause = verdictOk ? verdictResult.cause : undefined;
          const ret = verdictOk ? verdictResult.ret : undefined;

          const checkedAt = new Date(now()).toISOString();
          const row = reportRow({
            chain: "solana",
            address: t.address,
            symbol: meta && typeof meta.symbol === "string" ? meta.symbol : null,
            name: meta && typeof meta.name === "string" ? meta.name : null,
            verdict,
            checkedAt,
            poolCreatedAt: t.poolCreatedAt,
            priceUsd: t.priceUsd,
            reserveUsd: t.reserveUsd,
            vol24hUsd: t.vol24hUsd,
            fdvUsd: t.fdvUsd,
            dex: t.dex,
            why,
            cause,
            ret,
          });
          mTokenEnd();

          if (isCapped()) {
            discarded++;
            if (stoppedAt === null) stoppedAt = "sol-token";
            break;
          }
          if (row) builtRowsSol.push(row);
        }
      }
    }

    /* نوشتنِ دوم، فقط وقتی سولانا واقعاً چیزی داشت (ردیف یا حتی فقط یک
       تلاشِ چک‌شده): رویِ latestDoc ادغام می‌شود، نه newDoc و نه یک
       خواندنِ تازه — تا کلیدهای follow/recheck که بالاتر نوشته شدند پاک
       نشوند (clobber نکند). */
    if (builtRowsSol.length > 0 || checkedSol > 0) {
      const solDoc = mergeReportDoc(latestDoc, dateStr, builtRowsSol, checkedSol, generatedAt);
      mStage("kv-write");
      await safeKvPutJson(kv, reportKey(dateStr), solDoc);
      latestDoc = solDoc;
    }

    // checked نهایی: جمعِ دو پا — همان چیزی که در result/passRecord می‌نشیند.
    const checked = checkedBase + checkedSol;

    /* پروبِ سقفِ ساب‌ریکوئست — دقیقاً همین‌جا، بعدِ پایِ سولانا (آخرین
       مرحله‌ی گذر)، تا اندازه‌گیری واقعاً *انتهای* همان گذری باشد که
       می‌خواهیم درباره‌اش بدانیم. صرفاً اندازه‌گیری است: هیچ رفتاری از
       بالاتر عوض نمی‌شود، و نبودِ probeFetch یعنی این فیلد کلاً غایب
       می‌ماند، نه یک حدس. */
    let capProbe;
    if (typeof probeFetch === "function") {
      mStage("probe");
      capProbe = await classifyCapProbe(probeFetch);
    }

    /* لاگِ گذر — تویِ try/catچِ خودش، هرگز نباید خودِ گذر را بشکند. فقط عدد و
       رشته‌ی بسته‌ی capProbe؛ هیچ آدرس/symbol/why اینجا نمی‌نشیند.
       🔴 sub (وقتی meter تزریق شده) هم فقط عدد و نامِ hostname/مرحله است —
       همان انضباط، تضمین‌شده توسطِ خودِ makeSubMeter در worker/index.js
       (هرگز مسیر/کوئری، هرگز خودِ URL). snapshot() دقیقاً همین‌جا گرفته
       می‌شود، پیش از نوشتنِ خودِ PASS_LOG_KEY — یعنی هزینه‌ی همین یک put
       آخر در sub این گذر نمی‌نشیند (اندازه‌گیریِ خودِ اندازه‌گیری ممکن
       نیست)، محدودیتی عمدی و بی‌ضرر. */
    try {
      const passRecord = {
        at: generatedAt, checked, added: builtRows.length + builtRowsSol.length,
        addedSol: builtRowsSol.length, followed, rechecked, recheckTried,
        base: passChainStats(builtRows), sol: passChainStats(builtRowsSol),
        // 🔴 چهار فیلدِ زیر همیشه می‌نشینند (نه شرطی مثلِ capProbe/sub) —
        // discarded/stoppedAt نتیجه‌ی مستقیمِ همین گذرند، metaBatch فقط سه
        // رشته‌ی بسته است، و capAt هم یا null است یا فقط عدد (m.capAt خودش
        // هرگز چیزی بیش از {ops,fetches,cache} نمی‌سازد — makeSubMeter در
        // worker/index.js تضمینش می‌کند). هیچ‌کدام آدرس/symbol/URL ندارند.
        discarded,
        stoppedAt,
        metaBatch,
        capAt: m && m.capAt ? m.capAt : null,
      };
      if (capProbe !== undefined) passRecord.capProbe = capProbe;
      if (m && typeof m.snapshot === "function") passRecord.sub = m.snapshot();
      const prevLog = await readPassLog(kv);
      const nextLog = [passRecord, ...prevLog].slice(0, REPORT_PASS_LOG_CAP);
      mStage("kv-write");
      await safeKvPutJson(kv, PASS_LOG_KEY, nextLog);
    } catch (e) {
      /* اندازه‌گیری هرگز نباید خودِ گذر را بشکند */
    }

    const result = {
      checked, added: builtRows.length + builtRowsSol.length, addedSol: builtRowsSol.length, followed,
      rechecked, recheckTried,
    };
    if (capProbe !== undefined) result.capProbe = capProbe;
    // 🔴 غایب‌بودنِ meter یعنی این کلید کلاً روی result هم نمی‌نشیند — نتیجه‌ی
    // یک گذرِ بدونِ meter بایت‌به‌بایت همان چیزی می‌ماند که امروز برمی‌گشت.
    if (m && typeof m.snapshot === "function") result.sub = m.snapshot();
    return result;
  } catch (e) {
    return { checked: 0, added: 0 }; // این تابع هرگز نباید پرتاب کند
  }
}

/* =====================================================================
   متنِ ساده‌ی گزارش — همان بایگانی، نمای سومی برای پُست‌های عمومی
   =====================================================================
   🔴 report:2026-09-07 هنوز ردیف‌های nosellِ نادرستِ شناخته‌شده را در KV
   نگه می‌دارد (رفعش همان شب دیپلوی شد) — پس هیچ متنی برای تاریخِ پیش از
   REPORT_TEXT_FIRST_DATE ساخته نمی‌شود.
   🔴 symbol از بالادست می‌آید و کنترلش دستِ ما نیست و مستقیم در یک پُستِ
   عمومی می‌نشیند — پس whitelist می‌شود، نه escape؛ هر چیزِ خارج از این
   الگو با نمایشِ آدرس جایگزین می‌شود. */
export const REPORT_TEXT_FIRST_DATE = "2026-09-08";
export const REPORT_TEXT_MAX_LISTED = 10;

const REPORT_TEXT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const REPORT_TEXT_SYMBOL_OK = /^[A-Za-z0-9_-]{1,16}$/;
const REPORT_TEXT_ADDR_OK = /^0x[0-9a-f]{40}$/;

// برچسبِ یک ردیفِ پرچم‌خورده: symbolِ سفید-فهرست‌شده، وگرنه آدرسِ کوتاه‌شده —
// هیچ تبدیلِ دیگری روی هیچ‌کدام اعمال نمی‌شود.
function reportTextSymbolLabel(row) {
  if (typeof row.symbol === "string" && REPORT_TEXT_SYMBOL_OK.test(row.symbol))
    return "$" + row.symbol;
  return row.address.slice(0, 6) + "…" + row.address.slice(-4);
}

/* سندِ یک روز → متنِ ساده برای پُست، یا null. خالص، بدونِ I/O، هرگز پرتاب
   نمی‌کند.
   🔴 بلوکِ سولانا از ۲۱ سپتامبرِ ۲۰۲۶ تا ۲۲ سپتامبر پشتِ opts.solana===true
   مخفی بود: اندازه‌گیریِ ۲۱ سپتامبر نشان داد ۴۳ از ۴۴ ردیفِ سولانا «نمی‌توان
   چک کرد» می‌شدند، چون آن پا آخرِ گذر اجرا می‌شد و گذر پیش از رسیدنش به
   سهمیه‌ی ساب‌ریکوئستِ Worker می‌خورد. ۲۲ سپتامبر همان سقف رفع شد (کشِ
   scheduledReportPass خاموش، و ترتیبِ Base→فالوآپ→رِی‌چک→سولانا) و نُه گذرِ
   زنده‌ی پیاپی نه یک بار به سقف خوردند نه یک ردیف دورریختند — پس مسیرِ
   /report/<تاریخ>.txt دوباره {solana:true} پاس می‌دهد (worker/index.js).
   خودِ گیتِ opts.solana اینجا دست‌نخورده می‌ماند: پیش‌فرض (بدونِ opts، یا
   {solana:false}) همچنان بایت‌به‌بایت همان چیزی است که یک سندِ بدونِ
   ردیف‌های سولانا تولید می‌کرد — فقط کالرِ صریح می‌تواند بلوک را روشن کند. */
export function reportText(doc, opts) {
  try {
    if (!doc || typeof doc !== "object" || typeof doc.date !== "string" ||
        !REPORT_DATE_RE.test(doc.date) || !Array.isArray(doc.rows))
      return null;
    if (doc.date < REPORT_TEXT_FIRST_DATE) return null;

    // فقط ردیف‌های Base با checkKindِ همان‌جدول و آدرسِ درست‌شکل — هر ردیفِ
    // دیگر در هیچ شمارشِ Base حساب نمی‌شود.
    const rows = doc.rows.filter((r) =>
      r && typeof r === "object" && r.chain === "base" &&
      r.checkKind === CHECK_KIND_BY_CHAIN.base &&
      typeof r.address === "string" && REPORT_TEXT_ADDR_OK.test(r.address));

    const flaggedRows = rows.filter((r) => r.v === "nosell");
    let quoted = 0;
    let unchecked = 0;
    for (const r of rows) {
      if (r.v === "sell") quoted++;
      else if (r.v !== "nosell") unchecked++;
    }
    const total = rows.length;
    const flagged = flaggedRows.length;

    // 🔴 ردیف‌های سولانا — همان انضباط: فقط chain==="solana"، checkKindِ
    // همان‌جدول (roundtrip)، و mintِ base58 درست‌شکل. صفر ردیفِ شمرده‌شده
    // یعنی خروجیِ زیر باید بایت‌به‌بایت همان چیزی بماند که پیش از این تغییر
    // بود — solTotal===0 هیچ خطی به متن اضافه نمی‌کند، هیچ‌کجا.
    const solRows = (opts && opts.solana === true) ? doc.rows.filter((r) =>
      r && typeof r === "object" && r.chain === "solana" &&
      r.checkKind === CHECK_KIND_BY_CHAIN.solana &&
      typeof r.address === "string" && SOL_MINT.test(r.address)) : [];
    const solNosellRows = solRows.filter((r) => r.v === "nosell");
    const solSellCount = solRows.filter((r) => r.v === "sell").length;
    const solUnchecked = solRows.length - solNosellRows.length - solSellCount;
    const solTotal = solRows.length;

    const [y, m, d] = doc.date.split("-");
    const dateLabel = String(Number(d)) + " " + REPORT_TEXT_MONTHS[Number(m) - 1];

    // بلوکِ سولانا — یک‌بار ساخته می‌شود تا هم مسیرِ total===0 (پایین‌تر) هم
    // مسیرِ total>0 (پایین‌ترِ همین تابع) دقیقاً همان خط‌ها را چاپ کنند، نه
    // دو کپیِ جدا که می‌توانند از هم جدا بیفتند. فقط وقتی صدا زده می‌شود که
    // solTotal>0 (کالر خودش این شرط را می‌سنجد)؛ همیشه با یک خطِ خالی تمام
    // می‌شود تا هرچه بعدش می‌آید به فهرست نچسبد.
    function solanaBlockLines() {
      const out = [
        solTotal + " new Solana token" + (solTotal === 1 ? "" : "s") + " checked.",
        solNosellRows.length + " failed a simulated buy and sell.",
        solSellCount + " passed a simulated buy and sell.",
        solUnchecked + " could not be checked.",
      ];
      if (solNosellRows.length > 0) {
        out.push("");
        const listedSol = solNosellRows.slice(0, REPORT_TEXT_MAX_LISTED);
        listedSol.forEach((r, i) => {
          if (i > 0) out.push("");
          out.push(reportTextSymbolLabel(r) + " — failed the simulated buy and sell");
          out.push("zaexa.com/t/" + r.address);
        });
        if (solNosellRows.length > REPORT_TEXT_MAX_LISTED) {
          out.push("");
          out.push("+" + (solNosellRows.length - REPORT_TEXT_MAX_LISTED) + " more: zaexa.com/report/" +
            doc.date + ".json");
        }
      }
      out.push("");
      return out;
    }

    const lines = ["Exit Report · " + dateLabel, ""];

    if (total === 0) {
      lines.push("No new Base tokens were checked.");
      if (solTotal === 0) return lines.join("\n") + "\n";

      /* ۲۲ سپتامبر: یک روز بدونِ هیچ توکنِ تازه‌ی Base هنوز می‌تواند
         ردیف‌های سولانا داشته باشد — آن گذر نباید بی‌صدا گم شود. بلوکِ
         سولانا همان شکلِ همیشگی را می‌گیرد (خودِ solanaBlockLines بالا)،
         ولی پانویسِ Base («Sell quotes on Base DEXes…») چاپ نمی‌شود — این
         روز هیچ ردیفِ Baseای ندارد که آن جمله توضیحش بدهد. */
      lines.push("");
      lines.push(...solanaBlockLines());
      lines.push("On Solana, the buy and the sell are simulated together.");
      if (typeof doc.generatedAt === "string" && Number.isFinite(Date.parse(doc.generatedAt))) {
        const gd = new Date(doc.generatedAt);
        const hh = String(gd.getUTCHours()).padStart(2, "0");
        const mm = String(gd.getUTCMinutes()).padStart(2, "0");
        lines.push("Last check " + hh + ":" + mm + " UTC.");
      }
      return lines.join("\n") + "\n";
    }

    lines.push(total + " new Base token" + (total === 1 ? "" : "s") + " checked.");
    lines.push(flagged + " had no sell route quoted.");
    lines.push(quoted + " had a sell route quoted.");

    // میانه‌ی درصدِ برگشت — فقط وقتی حداقل ۵ ردیفِ همین مجموعه‌ی فیلترشده
    // ret عددی دارند؛ کمتر از ۵ یعنی متن بایت‌به‌بایت همان چیزی می‌ماند که
    // پیش از این تغییر بود. برای تعدادِ زوج، عضوِ پایین‌ترِ دو وسطی انتخاب
    // می‌شود — بدونِ میانگین‌گیری، تا نتیجه همیشه یکی از همان اعدادِ واقعی باشد.
    const retValues = rows
      .filter((r) => r.v === "sell" && typeof r.ret === "number" && Number.isFinite(r.ret))
      .map((r) => r.ret)
      .sort((a, b) => a - b);
    if (retValues.length >= 5) {
      const median = retValues[Math.floor((retValues.length - 1) / 2)];
      lines.push("A $100 sell quote came back at " + Math.round(median) + "% for the median of them.");
    }

    lines.push(unchecked + " could not be checked.");

    // پیگیریِ یک‌ساعته: فقط وقتی حداقل یک ردیفِ sell در همین مجموعه‌ی
    // فیلترشده follow="pool-empty" دارد، درست بعدِ خطِ «could not be
    // checked» — با شمارشِ صفر، این خط اصلاً اضافه نمی‌شود و متن بایت‌به‌بایت
    // همان چیزی می‌ماند که پیش از این تغییر بود.
    const followEmptyCount = rows.filter((r) => r.v === "sell" && r.follow === "pool-empty").length;
    if (followEmptyCount > 0) {
      lines.push(followEmptyCount + " of the quoted tokens had an empty pool an hour later.");
    }

    // خطِ خالی همیشه — وگرنه وقتی هیچ توکنی پرچم نخورده، پانویس به شمارش‌ها می‌چسبد.
    lines.push("");
    if (flagged > 0) {
      const listed = flaggedRows.slice(0, REPORT_TEXT_MAX_LISTED);
      listed.forEach((r, i) => {
        if (i > 0) lines.push("");
        // پسوندِ « · pool is empty» فقط وقتی خودِ ردیف cause="empty-pool"
        // دارد — ردیف‌های بدونِ آن بایت‌به‌بایت همان خطِ امروز می‌مانند.
        lines.push(reportTextSymbolLabel(r) + " — no sell route quoted" +
          (r.cause === "empty-pool" ? " · pool is empty" : ""));
        lines.push("zaexa.com/t/" + r.address);
      });
      if (flagged > REPORT_TEXT_MAX_LISTED) {
        lines.push("");
        lines.push("+" + (flagged - REPORT_TEXT_MAX_LISTED) + " more: zaexa.com/report/" +
          doc.date + ".json");
      }
      lines.push("");
    }

    // 🔴 بلوکِ سولانا — فقط وقتی حداقل یک ردیفِ سولانا شمرده شده؛ بعدِ کلِ
    // بلوکِ Base (شمارش‌ها، خطِ اختیاریِ follow/ret، و فهرستِ پرچم‌خورده‌ها) و
    // پیش از خط‌های پانویس. solTotal===0 هیچ خطی اینجا اضافه نمی‌کند. خودِ
    // خط‌ها از solanaBlockLines بالاتر می‌آیند — همان تابعی که مسیرِ
    // total===0 هم استفاده می‌کند.
    if (solTotal > 0) lines.push(...solanaBlockLines());

    lines.push("Sell quotes on Base DEXes, not a simulated round trip.");
    // 🔴 فقط وقتی بلوکِ سولانا واقعاً چاپ شده این خط هم می‌آید — هم‌رده‌ی
    // همان قاعده‌ی solTotal===0 بالاتر.
    if (solTotal > 0) lines.push("On Solana, the buy and the sell are simulated together.");

    if (typeof doc.generatedAt === "string" && Number.isFinite(Date.parse(doc.generatedAt))) {
      const gd = new Date(doc.generatedAt);
      const hh = String(gd.getUTCHours()).padStart(2, "0");
      const mm = String(gd.getUTCMinutes()).padStart(2, "0");
      lines.push("Last check " + hh + ":" + mm + " UTC.");
    }

    return lines.join("\n") + "\n";
  } catch (e) {
    return null; // این تابع هرگز نباید پرتاب کند
  }
}
