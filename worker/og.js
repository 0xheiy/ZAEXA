/* =====================================================================
   کارت پیش‌نمایش (Open Graph) برای لینک توکن — /t/<آدرس>
   =====================================================================
   مسئله: ربات‌های پیش‌نمایش تلگرام و ایکس **جاوااسکریپت اجرا نمی‌کنند**.
   هرچه صفحه در مرورگر می‌سازد را نمی‌بینند؛ فقط همان HTML اولیه‌ای را
   می‌خوانند که سرور فرستاده. پس تگ‌های og باید *سمت سرور* داخل HTML بنشینند.

   ⚠️ دلیلِ اینکه صفحه‌ی توکن از اول «مسیر» شد و نه «هش»، دقیقاً همین بود:
   هش هیچ‌وقت به سرور نمی‌رسد، پس با هش هرگز نمی‌شد کارت ساخت.

   ⚠️ **چه چیزی روی کارت نمی‌آید و چرا.** امتیاز ریسک و هزینه‌ی رفت‌وبرگشت
   هر دو `eth_call` روی Base لازم دارند. این Worker هیچ RPC ندارد، و اگر
   می‌داشت هم عددی که سمت سرور حساب می‌شود می‌توانست با عددی که صفحه چند
   ثانیه بعد نشان می‌دهد یکی نباشد. کارتی که «۰٫۱۰٪» بگوید و صفحه چیز
   دیگری، از نبودنِ کارت بدتر است — پس کارت فقط چیزی می‌گوید که از همان
   منبعِ خودِ صفحه می‌آید: هویت توکن و دو عدد بازار.
   ===================================================================== */

import { renderable } from "./og-token.js";

/* گریز برای *مقدار یک ویژگی* در HTML.
   نام و نماد توکن از یک منبع بیرونی می‌آید و ما آن را داخل HTML تزریق
   می‌کنیم — یعنی دقیقاً همان جایی که XSS متولد می‌شود. صفحه‌ی سواپ همین
   کلاس باگ را یک بار خورده بود. هر پنج نویسه گریز می‌خورد، نه فقط `<`. */
export function ogEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* رشته‌ی بیرونی → رشته‌ای که می‌شود در یک خط نشانش داد، یا null.
   نویسه‌های کنترلی و خط تازه حذف می‌شوند (یک نام چندخطی کل تگ را به‌هم
   می‌ریزد) و طول سقف دارد؛ نماد ۲۰۰ نویسه‌ای یعنی عنوانی که هیچ‌جا جا
   نمی‌شود. خالی → null، چون «نمی‌دانم» نباید مثل رشته‌ی خالی رفتار کند. */
export function ogClean(v, max) {
  if (v == null) return null;
  const s = String(v)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/* همان قالبی که `fmtBig` در index.html دارد — عمداً کپیِ خط‌به‌خط، چون کارت
   و صفحه باید یک عدد را یک‌شکل بگویند.
   یک فرق: آنجا وقتی عدد نامعلوم است «—» چاپ می‌شود چون یک ردیف جدول است و
   جای خالی بدتر از خط تیره است. اینجا `null` برمی‌گردد و آن تکه **اصلاً
   نمی‌آید** — «Liquidity —» در توضیح کارت هیچ چیزی به کسی نمی‌گوید. */
export function ogBig(v) {
  const n = v == null || v === "" ? NaN : Number(v);
  if (!isFinite(n) || n <= 0) return null;
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

/* پاسخ GeckoTerminal → فقط چیزهایی که لازم داریم.
   هر شکل دیگری (خطا، بدنه‌ی خالی، آرایه به‌جای شیء) → null، نه شیء نصفه.

   ⚠️ GeckoTerminal عددها را به‌صورت رشته می‌فرستد — total_reserve_in_usd و
   volume_usd.h24 همین‌طورند و ogBig از قبل رشته را قبول می‌کند؛ price_usd
   هم فرقی ندارد (مثلاً "0.001096077838"). اگر priceUsd فقط typeof number
   را قبول کند، روی داده‌ی واقعی همیشه null درمی‌آید، sellAmountFrom هم
   همیشه null می‌دهد، و fetchVerdict حتی یک تلاش هم نمی‌کند — دقیقاً همان
   باگی که یک‌بار روی سایتِ زنده کارت را ساکت خراب کرد. پس اینجا Number()
   می‌کنیم، مثل ogBig؛ فقط رشته‌ی خالی/فاصله، غیرعددی، صفر و منفی رد
   می‌شوند. decimals فرق دارد: آن یکی همیشه عدد است، نه رشته، پس همان
   سخت‌گیریِ typeof می‌ماند. */
export function pickTokenMeta(body) {
  const a = body && body.data && !Array.isArray(body.data) && body.data.attributes;
  if (!a || typeof a !== "object") return null;
  const decimals =
    Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 36 ? a.decimals : null;
  const n = Number(a.price_usd);
  const priceUsd = Number.isFinite(n) && n > 0 ? n : null;
  // نشانی لوگو: فقط https، حداکثر ۵۱۲ نویسه، و نه جایگزینِ «missing.png» ی GT
  const iu = a.image_url;
  const imageUrl =
    typeof iu === "string" && iu.startsWith("https://") && iu.length <= 512 && !iu.includes("missing.png")
      ? iu
      : null;
  return {
    name: ogClean(a.name, 48),
    symbol: ogClean(a.symbol, 16),
    liquidity: ogBig(a.total_reserve_in_usd),
    vol24: ogBig(a.volume_usd && a.volume_usd.h24),
    decimals,
    priceUsd,
    imageUrl,
  };
}

/* پاسخ DexScreener (token-pairs/v1/<chain>/<addr>: آرایه‌ی جفت‌ها) → متای
   کارت، فقط هویت. اعدادِ نقدینگی و حجمِ DexScreener با عددِ صفحه
   (total_reserve_in_usd در GeckoTerminal) نمی‌خواند (۹۹۶k در برابر ۷۲۲k
   اندازه‌گیری شد)، پس هرگز به‌جای آن عدد نشان داده نمی‌شود: liquidity/vol24/
   decimals/priceUsd/imageUrl همه null. با priceUsd و decimals برابرِ null حکمِ
   Base صادقانه «نامعلوم» می‌شود؛ حکمِ سولانا هیچ‌کدام را لازم ندارد.
   فقط جفت‌هایی که chainId و baseToken.address می‌خوانند (Base بدونِ حساسیتِ
   حروف، سولانا دقیقاً)؛ از بین‌شان بیشترین liquidity.usd. */
export function pickDsMeta(pairs, addr, chain) {
  if (!Array.isArray(pairs) || typeof addr !== "string" || (chain !== "base" && chain !== "solana")) return null;
  const same = (a) => typeof a === "string" &&
    (chain === "base" ? a.toLowerCase() === addr.toLowerCase() : a === addr);
  let best = null, bestLiq = -1;
  for (const p of pairs) {
    if (!p || p.chainId !== chain || !p.baseToken || !same(p.baseToken.address)) continue;
    const l = p.liquidity && typeof p.liquidity.usd === "number" && Number.isFinite(p.liquidity.usd)
      ? p.liquidity.usd : 0;
    if (l > bestLiq) { best = p; bestLiq = l; }
  }
  if (!best) return null;
  const name = ogClean(best.baseToken.name, 48);
  const symbol = ogClean(best.baseToken.symbol, 16);
  if (!name && !symbol) return null;
  return { name, symbol, liquidity: null, vol24: null, decimals: null, priceUsd: null, imageUrl: null, src: "ds" };
}

/* ۱۴ اکتبر: متادیتای CoinMarketCap (v1/dex/token) — فقط برای گذرِ ساعتی، وقتی
   متای دیگر مبلغِ فروش نمی‌دهد. error_code رشته‌ی "0" است، p رشته‌ی اعشاری،
   dec عددِ صحیح. بدونِ قیمت یا decimals به درد گذر نمی‌خورد → null.
   liquidity/vol24/imageUrl عمداً null (مثلِ pickDsMeta: عددِ منبعِ دیگر با
   صفحه نمی‌خواند). */
export function pickCmcMeta(body, addr) {
  if (!body || typeof body !== "object" || typeof addr !== "string") return null;
  if (String(body.status && body.status.error_code) !== "0") return null;
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (!(typeof data.addr === "string" && data.addr.toLowerCase() === addr.toLowerCase())) return null;
  const decimals = Number.isInteger(data.dec) && data.dec >= 0 && data.dec <= 36 ? data.dec : null;
  const n = Number(data.p);
  const priceUsd = Number.isFinite(n) && n > 0 ? n : null;
  if (decimals === null || priceUsd === null) return null;
  return { name: ogClean(data.n, 48), symbol: ogClean(data.sym, 16), liquidity: null, vol24: null,
    decimals, priceUsd, imageUrl: null, src: "cmc" };
}

const PITCH =
  "Check whether you can sell it back before you buy — exit simulation and " +
  "risk flags, no wallet needed.";

/* عنوان و توضیح.
   وقتی داده نداریم (بالادست نداد، یا دیر کرد) کارت **عمومی** می‌شود، نه
   غلط. یک کارت عمومی از یک کارت با نام اشتباه خیلی بهتر است. */
export function ogTitle(meta) {
  const sym = meta && meta.symbol;
  const name = meta && meta.name;
  if (!sym && !name) return "Token on Base — Zaexa";
  if (!sym) return name + " — Zaexa";
  if (!name || name.toLowerCase() === sym.toLowerCase()) return sym + " — Zaexa";
  return sym + " · " + name + " — Zaexa";
}

/* ⚠️ جمله‌ی verdict همیشه *اول* می‌آید، نه آخر — تلگرام توضیح را در طول
   مشخصی قطع می‌کند، و کل نکته‌ی این ستون همان یک سؤالی است که کاربر قبل از
   کلیک می‌پرسد: «آیا این یک اسکم است؟». اگر آن جمله جایی ته صف بنشیند، دقیقاً
   همان چیزی که این کار قرار بود حل کند تلگرام قطعش می‌کند.

   واژه‌ها عمدی‌اند و بحث ندارند: «quoted»، نه «simulated» و نه «safe» — یک
   کوت فقط یک کوت است، نه شبیه‌سازی و نه ضمانتِ امنیت. عوض‌کردنِ این واژه‌ها
   یعنی ادعا کردنِ چیزی که این مدرک اثبات نمی‌کند.

   ⚠️ برچسبِ زنجیره پارامتر است، نه حدسی که اینجا زده شود — کالر (worker/
   index.js) همان chainOf(addr) را که برای انتخابِ verdictِ درست هم به کار
   می‌برد پاس می‌دهد، تا این فایل هیچ تشخیصِ دومی نسازد که بتواند از تشخیصِ
   اصلی جدا بیفتد. غیابش («Base» پیش‌فرض) یعنی رفتارِ همیشگی: کارتِ توکنِ
   سولانا تا امروز اصلاً وجود نداشت (/t/<mint سولانا> ۴۰۴ می‌گرفت)، پس هر
   کارتی که واقعاً ساخته شده همیشه Base بوده — این پیش‌فرض همان را عوض
   نمی‌کند، فقط اسمش را صریح می‌کند. */
export function ogDescription(meta, verdict, chain, cause) {
  const bits = [chain || "Base"];
  if (meta && meta.liquidity) bits.push("Liquidity " + meta.liquidity);
  if (meta && meta.vol24) bits.push("Vol 24h " + meta.vol24);
  const base = bits.join(" · ") + ". " + PITCH;
  // سولانا: nosell هرگز در کارت نمی‌آید (تصمیمِ مالک ۴ اکتبر) — حتی اگر کالری بدهدش
  if (verdict === "nosell" && chain !== "Solana") {
    // ۲۶ اکتبر: علتِ اثبات‌شده، با همان واژه‌های کارت و ربات
    const why = cause === "empty-pool" ? " The pool is empty." : cause === "sell-reverts" ? " The sell reverts."
      : cause === "one-way-pool" ? " A $100 buy fills, but selling it back does not." : "";
    return "No sell route quoted — you may not be able to exit." + why + " " + base;
  }
  if (verdict === "sell") return "A sell route was quoted. " + base;
  // هر چیزِ دیگری — از جمله نبودِ همین آرگومان — یعنی «نمی‌دانم»، و
  // «نمی‌دانم» نباید مثلِ «نه» رفتار کند: بدون جمله‌ی verdict، رشته‌ی قدیمی
  // بایت‌به‌بایت.
  return base;
}

/* رشته‌ی تگ‌ها. `origin` باید مطلق باشد: ربات پیش‌نمایش صفحه را از جای
   دیگری می‌خواند و مسیر نسبی برایش معنایی ندارد.
   `v` در آدرس تصویر برای شکستن کش ربات‌هاست؛ اگر روزی تصویر عوض شد، همین
   عدد را جلو ببر — وگرنه تلگرام ماه‌ها تصویر قدیمی را نشان می‌دهد. */
export const OG_IMAGE_PATH = "/og.png";
export const OG_IMAGE_V = "5";
/* نسخه‌ی تصویرِ مخصوصِ توکن (/og/t/<آدرس>.png) — اگر چیدمان یا فونتِ آن عوض
   شد، همین را جلو ببر؛ بخشِ h= در آدرس فقط به داده‌ی همان توکن حساس است. */
export const OG_TOKEN_IMAGE_V = "1";

// هش FNV-1a ۳۲بیتی، ۸ رقمِ هگز — فقط برای شکستنِ کشِ ربات وقتی داده‌ی کارت عوض شد
function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function ogTags(meta, addr, origin, verdict, chain, cause) {
  const title = ogTitle(meta);
  const desc = ogDescription(meta, verdict, chain, cause);
  let img = origin + OG_IMAGE_PATH + "?v=" + OG_IMAGE_V;
  let alt = "Zaexa";
  // نمادِ قابل‌رندر → کارتِ مخصوصِ توکن؛ وگرنه دقیقاً همان تگ‌های قدیمیِ عمومی
  if (meta && meta.symbol && renderable(meta.symbol)) {
    const ch = chain || "Base";
    // علت فقط وقتی هست وارد هش می‌شود — هشِ کارت‌های بی‌علت عیناً همان قبلی می‌ماند
    const parts = [meta.symbol, meta.name || "", meta.liquidity || "", meta.vol24 || "", verdict || "", ch];
    if (verdict === "nosell" && ch !== "Solana" && (cause === "empty-pool" || cause === "sell-reverts" || cause === "one-way-pool")) parts.push(cause);
    const h = fnv1aHex(parts.join("|"));
    img = origin + "/og/t/" + addr + ".png?v=" + OG_TOKEN_IMAGE_V + "&h=" + h;
    alt = meta.symbol + " on " + ch + " — Zaexa";
  }
  const canonical = origin + "/t/" + addr;
  const m = (attr, k, v) =>
    "<meta " + attr + '="' + k + '" content="' + ogEscape(v) + '">';
  return [
    m("property", "og:type", "website"),
    m("property", "og:site_name", "Zaexa"),
    m("property", "og:title", title),
    m("property", "og:description", desc),
    m("property", "og:url", canonical),
    m("property", "og:image", img),
    m("property", "og:image:width", "1200"),
    m("property", "og:image:height", "630"),
    m("property", "og:image:alt", alt),
    m("name", "twitter:card", "summary_large_image"),
    m("name", "twitter:site", "@zaexadex"),
    m("name", "twitter:title", title),
    m("name", "twitter:description", desc),
    m("name", "twitter:image", img),
    m("name", "description", desc),
    '<link rel="canonical" href="' + ogEscape(canonical) + '">',
  ].join("");
}
