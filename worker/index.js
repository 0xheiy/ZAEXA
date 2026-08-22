/* =====================================================================
   پراکسی GeckoTerminal — روی همان Worker که خود سایت را سرو می‌کند
   =====================================================================
   مسئله: GeckoTerminal رایگان و بی‌کلید است و سقف نرخش روی *IP کاربر*
   حساب می‌شود. یعنی هر بازدیدکننده سهم خودش را دارد و به‌سرعت ۴۲۹ می‌گیرد.
   بدتر: پاسخ ۴۲۹ هدر CORS ندارد، پس مرورگر اصلاً وضعیت را به جاوااسکریپت
   نمی‌دهد و `fetch` فقط throw می‌کند — از داخل صفحه نمی‌شود فهمید چه شد.

   با پراکسی‌کردن از همین‌جا سه چیز حل می‌شود:
   • درخواست از IP کلادفلر می‌رود، نه از IP کاربر (که در ایران با VPN
     می‌تواند IP مشترک و از قبل سوخته باشد).
   • پاسخ در کش لبه می‌نشیند، پس همه‌ی کاربرانِ یک منطقه روی یک تماس
     واقعی جمع می‌شوند — به‌جای اینکه هرکدام جدا بپرسند.
   • هدر CORS را خودمان می‌گذاریم، پس ۴۲۹ *دیده* می‌شود و دیگر با قطعی
     شبکه اشتباه گرفته نمی‌شود.

   ⚠️ این Worker همچنان فایل‌های ثابت را هم سرو می‌کند. هر مسیری غیر از
   /gt/ دست‌نخورده به بایندینگ ASSETS می‌رود.
   ===================================================================== */

/* دو بالادست، با شکل مسیر یکسان.
   • بی‌کلید: API عمومی GeckoTerminal — سقفش ۳۰ درخواست در دقیقه *روی IP*
     است، و IP خروجی Workers مشترک و سوخته. عملاً بی‌فایده.
   • با کلید: همان داده از CoinGecko زیر /onchain. سقف روی *کلید ما*ست، نه
     روی IP. کلید در `env.CG_KEY` (secret در پنل کلادفلر) می‌ماند و هرگز
     به مرورگر نمی‌رسد — دلیل اصلی وجود این پراکسی همین است.
   هر چهار مسیری که سایت می‌زند زیر /onchain آزموده شد و ۲۰۰ داد. */
const UPSTREAM_FREE = "https://api.geckoterminal.com/api/v2";
const UPSTREAM_KEYED = "https://api.coingecko.com/api/v3/onchain";

/* پراکسی باز نیست. فقط شکل مسیرهایی که خودِ سایت می‌زند اجازه دارد:
     networks/base/tokens/<addr>
     networks/base/tokens/<addr>/pools
     networks/base/tokens/multi/<addr,addr,...>
     networks/base/pools/<pool>/ohlcv/<tf>
   چون هر بخش فقط حروف و رقم و , _ - می‌پذیرد، نه `..` رد می‌شود نه `%2e`
   نه یک URL کامل به میزبان دیگر. کسی نمی‌تواند از دامنه‌ی ما برای زدن به
   جای دیگری استفاده کند. */
const PATH_OK = /^networks\/[a-z0-9_-]{1,32}(?:\/[A-Za-z0-9,_-]{1,1200}){1,4}$/;

/* پارامترها هم allowlist‌اند و رشته‌ی پرس‌وجو از نو ساخته می‌شود — یعنی
   هرچه در ورودی بود دور ریخته می‌شود، نه اینکه «تمیز» شود. */
const QUERY_OK = {
  page: /^[0-9]{1,3}$/,
  aggregate: /^[0-9]{1,4}$/,
  limit: /^[0-9]{1,4}$/,
  currency: /^[a-z]{1,8}$/,
  before_timestamp: /^[0-9]{1,12}$/,
  token: /^[A-Za-z0-9]{1,10}$/,
};

/* همان عمرهایی که gtTtl در index.html دارد — استخر برتر زود عوض نمی‌شود،
   شمع‌های قیمت زود. */
function ttlFor(path) {
  if (/\/pools$/.test(path)) return 600;
  if (/\/ohlcv\//.test(path)) return 45;
  return 60;
}

/* =====================================================================
   /ev — شمارش رویداد، روی همان Worker
   =====================================================================
   چرا اصلاً لازم است: سایت با بایندینگ ASSETS سرو می‌شود و وقتی یک آدرس با
   فایلی در _site جور دربیاید، این Worker *اجرا نمی‌شود*. پس بازکردن صفحه از
   سمت سرور دیده نمی‌شود و شمارش باید از خود صفحه بیاید. `/ev` هیچ فایلی در
   _site ندارد، پس تنها مسیری است که همیشه به کد می‌رسد.

   ⚠️ مرز حریم خصوصی — این فهرست عمدی است، بدون پرسیدن گسترشش نده:
   • ثبت می‌شود: نام رویداد، یک جزئیات کوتاه از فهرست بسته، مبایل/دسکتاپ،
     و کد کشور که خودِ کلادفلر می‌دهد.
   • ثبت *نمی‌شود*: آدرس کیف پول، مبلغ، نام یا آدرس توکن، IP، رشته‌ی
     User-Agent، Referer، کوکی، و هیچ شناسه‌ی نشست یا بازدیدکننده.
     یعنی دو رویداد از یک نفر قابل به‌هم‌بستن نیستند — این عمدی است.
   دلیلش: با ترافیک کم، «سواپ در ۱۴:۳۲» به‌علاوه‌ی تراکنشی که در همان دقیقه
   روی زنجیره نشسته، ردیف آمار را به یک کیف پول وصل می‌کند — حتی بدون آدرس.
   ===================================================================== */

/* هر نام رویداد باید اینجا باشد وگرنه رد می‌شود. صفحه هم فهرست خودش را دارد
   و کاوشگر [events] در run.py تطبیقشان را می‌سنجد — وگرنه یک رویداد تازه در
   صفحه بی‌صدا دور ریخته می‌شد و ما فکر می‌کردیم «کسی این کار را نمی‌کند». */
const EV_OK = new Set([
  "load",
  "view:swap", "view:folio", "view:flow",
  "check:open",
  "wallet:open", "wallet:on",
  "quote:ok", "quote:none",
  "approve:click", "approve:done",
  "swap:click", "swap:blocked", "swap:sim-fail", "swap:sent",
  "swap:done", "swap:revert", "swap:lost", "swap:fail",
]);
/* جزئیات هم بسته است. رشته‌ی آزاد یعنی هرکسی می‌تواند هرچه خواست در انبار ما
   بنویسد، و یک روز چیزی که نباید ثبت شود از همین راه ثبت می‌شود. */
const EV_DETAIL_OK = new Set(["", "inj", "wc"]);
const EV_SURFACE_OK = new Set(["desktop", "mobile"]);
const EV_MAX_BODY = 256;

function evDone(status) {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

async function collectEv(request, url, env) {
  if (request.method !== "POST") return evDone(405);

  /* اگر مرورگر Origin فرستاد، باید خودِ ما باشیم. جلوی «صفحه‌ی کسی دیگر که
     در پس‌زمینه شمارنده‌ی ما را باد می‌کند» را می‌گیرد. curl را نمی‌گیرد و
     ادعا هم نمی‌کنیم که می‌گیرد — یک اندپوینت عمومی روی سایت ثابت راه
     رمزنگاشتی ندارد. */
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return evDone(403);

  if (Number(request.headers.get("content-length") || "0") > EV_MAX_BODY)
    return evDone(413);

  let body;
  try { body = await request.text(); } catch (e) { return evDone(400); }
  if (body.length > EV_MAX_BODY) return evDone(413);

  let msg;
  try { msg = JSON.parse(body); } catch (e) { return evDone(400); }
  if (!msg || typeof msg !== "object") return evDone(400);

  const name = typeof msg.e === "string" ? msg.e : "";
  const detail = typeof msg.d === "string" ? msg.d : "";
  const surface = typeof msg.v === "string" ? msg.v : "";
  if (!EV_OK.has(name)) return evDone(400);
  if (!EV_DETAIL_OK.has(detail)) return evDone(400);
  if (!EV_SURFACE_OK.has(surface)) return evDone(400);

  /* کشور از خودِ کلادفلر می‌آید، نه از چیزی که صفحه گفته. «T1» یعنی Tor.
     هر شکل دیگری «??» می‌شود — با رشته تصمیم نمی‌گیریم. */
  const raw = (request.cf && request.cf.country) || "";
  const country = /^[A-Z][A-Z0-9]$/.test(raw) ? raw : "??";

  /* بایندینگ ممکن است هنوز در پنل اضافه نشده باشد. نبودنش خطا نیست — فقط
     یعنی چیزی ثبت نمی‌شود؛ سایت نباید به‌خاطرش بشکند. */
  const ds = env && env.ZX_EV;
  if (ds && typeof ds.writeDataPoint === "function") {
    ds.writeDataPoint({
      blobs: [name, detail, surface, country],
      doubles: [1],
      // ایندکس کلید نمونه‌برداری است؛ نام رویداد یعنی نمونه‌برداری
      // پُرترافیک‌ها به کم‌ترافیک‌ها آسیب نمی‌زند.
      indexes: [name],
    });
  }
  return evDone(204);
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
  "access-control-max-age": "86400",
  // صفحه باید بتواند نشان پراکسی را بخواند تا «۴۰۴ از GeckoTerminal» را از
  // «/gt اصلاً وجود ندارد» تشخیص بدهد.
  "access-control-expose-headers": "x-zaexa-proxy",
};

function fail(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function proxyGt(request, url, ctx, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD")
    return fail(405, "only GET is proxied");

  const rest = url.pathname.slice("/gt/".length);
  if (!PATH_OK.test(rest)) return fail(400, "this path is not proxied");

  const qs = [];
  for (const [k, v] of url.searchParams) {
    const shape = Object.prototype.hasOwnProperty.call(QUERY_OK, k) ? QUERY_OK[k] : null;
    if (!shape || !shape.test(v)) return fail(400, "this query parameter is not proxied: " + k);
    qs.push(k + "=" + encodeURIComponent(v));
  }

  const key = (env && typeof env.CG_KEY === "string" && env.CG_KEY) || "";
  const target = (key ? UPSTREAM_KEYED : UPSTREAM_FREE) + "/" + rest +
    (qs.length ? "?" + qs.join("&") : "");
  const ttl = ttlFor(rest);

  /* کش لبه. عمداً از Cache API استفاده می‌شود و نه از cf.cacheTtl، چون
     فقط پاسخ موفق باید کش شود؛ کش‌شدن یک ۴۲۹ برای ده دقیقه یعنی همان
     «نمی‌دانم = نه» که قاعده‌ی اول این پروژه است.
     `caches` بیرون از محیط Workers وجود ندارد (مثلاً در تست Node)، پس
     نبودنش خطا نیست — فقط یعنی بدون کش کار کن. */
  const store = (typeof caches !== "undefined" && caches.default) || null;
  const cacheKey = new Request(target, { method: "GET" });
  if (store) {
    const hit = await store.match(cacheKey);
    if (hit) return hit;
  }

  let up;
  try {
    /* هیچ‌کدام از هدرهای کاربر (کوکی، Referer، …) به بالادست نمی‌رود؛ هدرها
       از نو ساخته می‌شوند. کلید فقط اینجاست — نه در URL (وگرنه در کش و در
       لاگ‌ها می‌نشست) و نه در هیچ پاسخی که برمی‌گردانیم. */
    const h = { accept: "application/json" };
    if (key) h["x-cg-demo-api-key"] = key;
    up = await fetch(target, { headers: h });
  } catch (e) {
    return fail(502, "the price service is unreachable");
  }

  const body = await up.arrayBuffer();
  const headers = {
    ...CORS,
    "content-type": up.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": up.ok ? "public, max-age=" + ttl : "no-store",
    /* برای بازرسی از بیرون: هم معلوم است پاسخ از پراکسی آمده، هم اینکه
       کلید واقعاً به Worker رسیده یا نه. خودِ کلید هرگز چاپ نمی‌شود. */
    "x-zaexa-proxy": up.ok ? (key ? "miss-keyed" : "miss-free")
                           : "upstream-" + up.status,
  };
  const res = new Response(body, { status: up.status, headers });

  if (up.ok && store) {
    const stash = new Response(body, {
      status: up.status,
      headers: { ...headers, "x-zaexa-proxy": "hit" },
    });
    const put = store.put(cacheKey, stash);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/gt" || url.pathname.startsWith("/gt/"))
      return proxyGt(request, url, ctx, env);
    if (url.pathname === "/ev") return collectEv(request, url, env);
    // بقیه‌ی سایت دست‌نخورده از فایل‌های ثابت می‌آید.
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  },
};

// برای تست‌ها — در زمان اجرا روی Worker استفاده نمی‌شود.
export { PATH_OK, QUERY_OK, ttlFor, EV_OK, EV_DETAIL_OK, EV_SURFACE_OK, EV_MAX_BODY };
