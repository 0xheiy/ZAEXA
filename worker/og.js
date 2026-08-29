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

/* پاسخ GeckoTerminal → فقط چهار چیزی که لازم داریم.
   هر شکل دیگری (خطا، بدنه‌ی خالی، آرایه به‌جای شیء) → null، نه شیء نصفه. */
export function pickTokenMeta(body) {
  const a = body && body.data && !Array.isArray(body.data) && body.data.attributes;
  if (!a || typeof a !== "object") return null;
  return {
    name: ogClean(a.name, 48),
    symbol: ogClean(a.symbol, 16),
    liquidity: ogBig(a.total_reserve_in_usd),
    vol24: ogBig(a.volume_usd && a.volume_usd.h24),
  };
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

export function ogDescription(meta) {
  const bits = ["Base"];
  if (meta && meta.liquidity) bits.push("Liquidity " + meta.liquidity);
  if (meta && meta.vol24) bits.push("Vol 24h " + meta.vol24);
  return bits.join(" · ") + ". " + PITCH;
}

/* رشته‌ی تگ‌ها. `origin` باید مطلق باشد: ربات پیش‌نمایش صفحه را از جای
   دیگری می‌خواند و مسیر نسبی برایش معنایی ندارد.
   `v` در آدرس تصویر برای شکستن کش ربات‌هاست؛ اگر روزی تصویر عوض شد، همین
   عدد را جلو ببر — وگرنه تلگرام ماه‌ها تصویر قدیمی را نشان می‌دهد. */
export const OG_IMAGE_PATH = "/og.png";
export const OG_IMAGE_V = "1";

export function ogTags(meta, addr, origin) {
  const title = ogTitle(meta);
  const desc = ogDescription(meta);
  const img = origin + OG_IMAGE_PATH + "?v=" + OG_IMAGE_V;
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
    m("property", "og:image:alt", "Zaexa"),
    m("name", "twitter:card", "summary_large_image"),
    m("name", "twitter:site", "@zaexadex"),
    m("name", "twitter:title", title),
    m("name", "twitter:description", desc),
    m("name", "twitter:image", img),
    m("name", "description", desc),
    '<link rel="canonical" href="' + ogEscape(canonical) + '">',
  ].join("");
}
