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

export const REPORT_MIN_RESERVE_USD = 5000;
export const REPORT_MAX_TOKENS_PER_RUN = 30;
export const REPORT_PAIRS_CAP = 200;
export const REPORT_PACE_MS = 500;

// نگاشتِ بسته — تنها جایی که checkKind از آن می‌آید. هیچ پارامتری برای
// checkKind وجود ندارد، دقیقاً برای اینکه نوشتنِ «round trip» روی یک نتیجه‌ی
// sell-quote از نظرِ ساختاری غیرممکن باشد، نه فقط دلسردکننده.
export const CHECK_KIND_BY_CHAIN = Object.freeze({ base: "sell-quote", solana: "roundtrip" });

export const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PAIRS_KEY_BASE = "pairs:base:latest";

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
   کنترلش دستِ ما نیست، پس یک ردیفِ عجیب فقط خودش را رد می‌کند. */
export function newPoolRowToToken(row) {
  try {
    const rawId = row && row.relationships && row.relationships.base_token &&
      row.relationships.base_token.data && row.relationships.base_token.data.id;
    if (typeof rawId !== "string") return null;

    const rest = rawId.replace(/^base_/, "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(rest)) return null;
    const address = rest.toLowerCase();
    // 🔴 یک سایت‌مپ واقعی همین آدرس را یک بار لیست کرد. نگذار به گزارش برسد.
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

// یک عددِ ذخیره‌شدنی، یا null. هرگز رشته، هرگز NaN، هرگز صفر-به‌جای-نامعلوم —
// صفرِ واقعی (مثلاً حجمِ صفر) باید صفر بماند، پس شرط Number.isFinite است، نه truthy.
function storedNumber(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/* یک ردیفِ گزارش، یا null. شکل برای v۱ قفل است — کلیدها به همین ترتیب.
   🔴 انبار همیشه عددِ خام نگه می‌دارد، هرگز رشته‌ی نمایشی. ogBig() در
   worker/og.js چیزی مثل "$1.2M" برمی‌گرداند — آن یک رندر است، نه داده؛ چیزی
   که رندر شده دیگر نمی‌شود مرتب کرد یا دوباره فرمت داد. priceUsd/vol24hUsd/
   fdvUsd/reserveUsd همیشه باید از attributes خامِ همان ردیفِ pool بیایند
   (newPoolRowToToken)، نه از meta.liquidity/meta.vol24 که از قبل ogBig
   شده‌اند — کسی این را به‌بهانه‌ی «ساده‌سازی» به meta برنگرداند. */
export function reportRow({
  chain, address, symbol, name, verdict, checkedAt, poolCreatedAt, priceUsd, reserveUsd, vol24hUsd, fdvUsd, dex,
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

    return {
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
    };
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
    return {
      date: dateStr,
      generatedAt: generatedAt || null,
      chains: ["base"],
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

/* سقفِ توکن‌های یک گذر. اجرای دستی (سنجش) عددِ کوچک‌تری می‌دهد تا پاسخ در
   چند ثانیه برگردد، ولی هیچ کالری نمی‌تواند سقف را از REPORT_MAX_TOKENS_PER_RUN
   بالاتر ببرد — وگرنه همان اندپوینتِ سنجش راهی می‌شد برای سوزاندنِ سهمیه. */
function tokenCap(maxTokens) {
  return Number.isInteger(maxTokens) && maxTokens > 0
    ? Math.min(maxTokens, REPORT_MAX_TOKENS_PER_RUN)
    : REPORT_MAX_TOKENS_PER_RUN;
}

/* گذرِ گزارش‌گیریِ ساعتی. همه‌چیز تزریق می‌شود؛ خودِ این تابع نه I/O دارد نه
   fetch مستقیم. */
export async function runReportPass({ kv, fetchPools, metaOf, verdictOf, now, sleep, maxTokens }) {
  try {
    // 🔴 بدون انباری برای نوشتن، هیچ تماسِ بالادستی مجاز نیست — قبل از هر
    // چیز دیگری، حتی قبل از fetchPools.
    if (!kv) return { checked: 0, added: 0 };

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

    const builtRows = [];
    let checked = 0;
    for (const t of tokens) {
      // پیش از هر توکن، هرگز موازی — یک نودِ حساس به نرخ زیرِ فشارِ چند
      // تماسِ هم‌زمان قرار نگیرد.
      await sleep(REPORT_PACE_MS);
      checked++;

      let meta = null;
      try { meta = await metaOf(t.address); } catch (e) { meta = null; }

      // ⚠️ metaOf که null می‌دهد به‌معنای «حکم نه» نیست — «نمی‌دانم» یک
      // نتیجه است، پس verdictOf همچنان صدا زده می‌شود؛ نتیجه‌اش هرچه شد
      // (احتمالاً باز هم null) همان چیزی است که در v می‌نشیند.
      let verdict = null;
      try { verdict = await verdictOf(t.address, meta); } catch (e) { verdict = null; }

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
      });
      if (row) builtRows.push(row);
    }

    const nowMs = now();
    const dateStr = utcDateOf(nowMs);
    const generatedAt = new Date(nowMs).toISOString();

    const prevDoc = await safeKvGetJson(kv, reportKey(dateStr));
    const newDoc = mergeReportDoc(prevDoc, dateStr, builtRows, checked, generatedAt);
    const newPairs = mergePairsRing(prevPairsArr, builtRows, REPORT_PAIRS_CAP);

    await safeKvPutJson(kv, reportKey(dateStr), newDoc);
    await safeKvPutJson(kv, PAIRS_KEY_BASE, newPairs);

    return { checked, added: builtRows.length };
  } catch (e) {
    return { checked: 0, added: 0 }; // این تابع هرگز نباید پرتاب کند
  }
}
