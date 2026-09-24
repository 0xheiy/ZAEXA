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

import { ogTags, ogTitle, pickTokenMeta } from "./og.js";
import { ogImageResponse } from "./og-image.js";
import { fetchVerdict, VD_VENUES, VD_RPCS, VD_V4_STAGE_COUNTERS } from "./verdict.js";
import { EVM_ADDR, SOL_MINT, chainOf, gtNetworkOf } from "./chains.js";
import {
  REPORT_DATE_RE, PAIRS_KEY_BASE, reportKey, utcDateOf, emptyReportDoc, runReportPass, publishGuardRow,
  reportText, REPORT_TEXT_FIRST_DATE, followForRow, recheckForRow, causeForRow, readPassLog,
  REPORT_METER_STAGES, REPORT_PASS_BASE_CAP, REPORT_PAIRS_CAP,
} from "./report.js";
import {
  fetchVerdictSol, VD_SOL_RPCS, VD_SOL_JUP_BASE, VD_SOL_PAYER,
  VD_SOL_RPC_METHODS, VD_SOL_RPC_PROBE_PARAMS, probeRpcMethod,
} from "./verdict_sol.js";
import { indexV4Keys, v4KvKey, V4_LOG_RPCS, V4_LOG_RPC_CANDIDATES, V4_KEY_TTL_S, V4_MISS_TTL_S,
  V4_POOL_MANAGER, V4_INITIALIZE_TOPIC } from "./v4index.js";

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
   محدودکننده‌ی نرخ — درون‌ایزوله، بدون هیچ بایندینگ تازه
   =====================================================================
   /ev و /gt امروز بی‌سقف‌اند: هر کسی با curl می‌تواند انبار آمار را باد
   کند، سهمیه‌ی رایگان ۱۰۰هزارتاییِ روزانه‌ی Worker را بسوزاند، و کلید
   مشترکِ CoinGecko را هم با خودش.

   ⚠️ چرا یک Map درون‌حافظه و نه یک بایندینگِ نرخ یا KV: هر بایندینگ تازه
   یک قدمِ دستیِ پنل کلادفلر می‌خواهد، و نبودنش در پنل کل استقرار را
   می‌شکند — این دقیقاً همان اتفاقی است که یک‌بار با Analytics Engine
   افتاد. یک محدودکننده‌ی درون‌ایزوله صفر کارِ پنلی می‌خواهد و نمی‌تواند
   استقرار را بشکند.

   ضعف‌هایش را عمداً و آگاهانه می‌پذیریم:
   • مالِ *یک* ایزوله در *یک* colo است — یک IP که هم‌زمان از دو colo بزند
     دو سهمیه‌ی جدا می‌گیرد.
   • با بازیافتِ ایزوله (که کلادفلر هر چند دقیقه انجامش می‌دهد) صفر می‌شود.
   • جلوی سیلِ توزیع‌شده از صدها IP را نمی‌گیرد.
   کارش جلوگیری از حالتِ *واقعی* است، نه حالتِ نظری: یک اسکریپت که از یک
   آدرس می‌کوبد — نه یک بات‌نت هماهنگ. آن حالتِ دوم را چیزِ دیگری باید حل
   کند، اگر روزی واقعاً پیش آمد. */
const rlHits = new Map();

/* FNV-1a سیِ‌ودو-بیتی روی IP، *نه* خودِ IP. مرزِ حریم خصوصیِ کل این سایت
   این است که IP را نگه نمی‌داریم؛ یک IP خام که در یک Map زنده — هرچند
   درون‌حافظه — نشسته باشد، باز هم یک IP نگه‌داشته‌شده است. کارش رمزنگاری
   نیست، فقط یک عدد که برای یک IP همیشه یکسان دربیاید. */
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* `bucket` («ev» یا «gt») در همان ورودیِ هش تا شدن جای می‌گیرد، نه در کلید
   به‌شکلِ رشته — وگرنه کلیدِ Map یک رشته می‌شد که IP را در خودش دارد، و
   همان چیزی می‌شد که این تابع قرار است جلویش را بگیرد. با فولدشدن در هش،
   کلید همیشه یک عدد است و دو مسیر مستقل شمرده می‌شوند.
   ⚠️ پارامترِ `now` *فقط* برای تست‌هاست — تا بشود ساعت را جلو برد بدون
   واقعاً صبرکردنِ ۶۰ ثانیه؛ روی خودِ Worker همیشه Date.now() است. پنجره‌ی
   ثابت (نه لغزان) کافی است، چون این‌جا دقتِ سرِ ثانیه لازم نیست، فقط سقف. */
function rateOk(request, bucket, limit, windowMs, now = Date.now()) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const key = fnv1a(bucket + ":" + ip);
  let e = rlHits.get(key);
  if (!e || now >= e.reset) {
    e = { n: 0, reset: now + windowMs };
    rlHits.set(key, e);
  }
  e.n++;

  /* سقفِ حافظه: یک Map بی‌سقف خودش یک ازکارافتادگی می‌شود. اول پنجره‌های
     منقضی‌شده پاک می‌شوند. اگر باز هم زیاد بود، همه‌چیز دور ریخته می‌شود —
     خشن، ولی حافظه‌ی محدود از حسابداریِ دقیق مهم‌تر است این‌جا؛ چند کاربرِ
     بی‌گناه که سهمیه‌شان زودتر از موعد صفر می‌شود بهتر از یک Worker است که
     حافظه‌اش بی‌انتها رشد کند. */
  if (rlHits.size > 2000) {
    for (const [k, v] of rlHits) {
      if (now >= v.reset) rlHits.delete(k);
    }
    if (rlHits.size > 5000) rlHits.clear();
  }
  return e.n <= limit;
}

/* هر سه مسیر (ev، gt، og — این آخری پایین‌تر برای /t/<آدرس>) روی همین دو
   عدد. ⚠️ تنگ‌ترش نکن: بسیاری از کاربرانِ این سایت از پشتِ VPN می‌آیند و
   چند کاربرِ واقعی می‌توانند یک IP خروجیِ مشترک داشته باشند؛ ۱۲۰ در دقیقه
   از مصرفِ واقعی (صفحه تماس‌های /gt را سریالایز و کش می‌کند) خیلی بالاتر
   است ولی از هر سیلی خیلی پایین‌تر. هر بستهٔ (bucket) با IP یک شمارندهٔ
   جدا دارد، پس سیل روی یکی سهمیهٔ بقیه را نمی‌خورد. */
const RL_LIMIT = 120;
const RL_WINDOW_MS = 60000;

/* =====================================================================
   /ev — شمارش رویداد، روی همان Worker
   =====================================================================
   چرا اصلاً لازم است: سایت با بایندینگ ASSETS سرو می‌شود و وقتی یک آدرس با
   فایلی در _site جور دربیاید، این Worker *اجرا نمی‌شود*. پس بازکردن صفحه از
   سمت سرور دیده نمی‌شود و شمارش باید از خود صفحه بیاید. `/ev` هیچ فایلی در
   _site ندارد، پس تنها مسیری است که همیشه به کد می‌رسد.

   ⚠️ مرز حریم خصوصی — این فهرست عمدی است، بدون پرسیدن گسترشش نده:
   • ثبت می‌شود: نام رویداد، یک جزئیات کوتاه از فهرست بسته (یا برای سه
     رویدادِ err: به‌جای آن یک کدِ چهار-رقمیِ شانزده‌شانزدهی که *کدام* باگ
     را می‌گوید، نه چیزِ دیگری)، مبایل/دسکتاپ، و کد کشور که خودِ کلادفلر
     می‌دهد.
   • ثبت *نمی‌شود*: آدرس کیف پول، مبلغ، نام یا آدرس توکن، IP، رشته‌ی
     User-Agent، Referer، کوکی، پیام خطا، نام فایل، خط/ستون، پشته‌ی
     فراخوانی، و هیچ شناسه‌ی نشست یا بازدیدکننده. یعنی دو رویداد از یک نفر
     قابل به‌هم‌بستن نیستند — این عمدی است.
   دلیلش: با ترافیک کم، «سواپ در ۱۴:۳۲» به‌علاوه‌ی تراکنشی که در همان دقیقه
   روی زنجیره نشسته، ردیف آمار را به یک کیف پول وصل می‌کند — حتی بدون آدرس.
   ===================================================================== */

/* هر نام رویداد باید اینجا باشد وگرنه رد می‌شود. صفحه هم فهرست خودش را دارد
   و کاوشگر [events] در run.py تطبیقشان را می‌سنجد — وگرنه یک رویداد تازه در
   صفحه بی‌صدا دور ریخته می‌شد و ما فکر می‌کردیم «کسی این کار را نمی‌کند». */
/* شکلِ مسیر حالا هر دو خانواده‌ی آدرس را می‌پذیرد — از رویِ همان دو الگویی
   که chains.js دارد ساخته می‌شود (source.slice(1,-1) فقط لنگرهای ^/$ را
   برمی‌دارد تا بشود این دو را کنارِ هم، زیرِ یک «یا»، گذاشت) تا این مسیر و
   chainOf هرگز از هم جدا نیفتند. ⚠️ ولی «پذیرفتنِ شکل» به‌معنایِ «سرودادنِ
   صفحه» نیست — پایین‌تر، جایی که این regex استفاده می‌شود، توضیح داده شده
   چرا آدرسِ سولانا با همین شکل باز هم ۴۰۴ می‌گیرد. */
const TOKEN_PAGE = new RegExp(
  "^\\/t\\/(" + EVM_ADDR.source.slice(1, -1) + "|" + SOL_MINT.source.slice(1, -1) + ")\\/?$"
);

const EV_OK = new Set([
  "load",
  "view:swap", "view:folio", "view:flow", "view:token", "view:faq",
  /* ⚠️ این دو از صفحه‌ی معرفی می‌آیند، نه از اپ — تنها دو نامی که اپ هرگز
     نمی‌فرستد. تا امروز صفحه‌ی معرفی هیچ رویدادی نداشت، پس نرخِ تبدیل
     («از هر چند نفر که صفحه را دیدند، یکی وارد اپ شد») اصلاً سنجیده
     نمی‌شد — دقیقاً همان عددی که کلِ آن صفحه برایش ساخته شده. */
  "view:home", "cta:app",
  "check:open",
  "wallet:open", "wallet:on",
  "quote:ok", "quote:none",
  "approve:click", "approve:done",
  "swap:click", "swap:blocked", "swap:sim-fail", "swap:sent",
  "swap:done", "swap:revert", "swap:lost", "swap:fail",
  /* خطاهای گرفته‌نشده‌ی سمت مرورگر. سه نامِ جدا، نه یک نام با detail
     دلبخواه، چون *کدام دسته* (js/promise/res) با name شمرده می‌شود — این
     تصمیم عوض نشده.
     ⚠️ ولی حالا (با اجازه‌ی صریح صاحب سایت) هر سه‌تا اجازه دارند در detail
     *فقط* چهار نویسه‌ی پایانیِ همان کدی که روی صفحه به کاربر نشان داده
     می‌شود را حمل کنند — نگاه کن به EV_ERR_NAMES / EV_ERR_HEX پایین‌تر.
     پیام خطا، نام فایل، خط/ستون و پشته‌ی فراخوانی همچنان هیچ‌کدام نمی‌آیند؛
     فقط می‌شود شمرد «چند باگِ *متمایز*»، نه «کدام پیام». */
  "err:js", "err:promise", "err:res",
  /* شمرده می‌شود وقتی لینکِ چکِ یک توکن با موفقیت کپی می‌شود — هیچ توکن،
     آدرس یا URLای هرگز فرستاده نمی‌شود، فقط خودِ رخداد. */
  "share:copy",
]);
/* جزئیات هم بسته است. رشته‌ی آزاد یعنی هرکسی می‌تواند هرچه خواست در انبار ما
   بنویسد، و یک روز چیزی که نباید ثبت شود از همین راه ثبت می‌شود. */
const EV_DETAIL_OK = new Set(["", "inj", "wc"]);
/* ⚠️ تنها استثنا روی مرزِ بالا، و عمداً *باریک*: نه یک regex سراسری روی
   همه‌ی رویدادها — که بی‌صدا مرزِ detail را برای wallet:on و هر رویدادِ
   دیگری هم باز می‌کرد — بلکه فقط برای همین سه نامِ err:. شکل هم قفل است:
   دقیقاً چهار رقمِ شانزده‌شانزدهیِ *بزرگ* (همان‌طور که tag() در index.html
   می‌سازد؛ حروفِ کوچک یا هر طولِ دیگری رد می‌شود). ۱۶ بیت یعنی نمی‌شود از
   این راه داده‌ی کاربر را قاچاق کرد — فقط می‌گوید «کدام باگ»، نه «چه کسی»
   یا «با چه پیامی». */
const EV_ERR_NAMES = new Set(["err:js", "err:promise", "err:res"]);
const EV_ERR_HEX = /^[0-9A-F]{4}$/;
const EV_SURFACE_OK = new Set(["desktop", "mobile"]);
const EV_MAX_BODY = 256;

function evDone(status, extraHeaders) {
  return new Response(null, {
    status,
    headers: Object.assign({ "cache-control": "no-store" }, extraHeaders),
  });
}

async function collectEv(request, url, env) {
  /* ⚠️ همیشه اولین خط: پیش از هر بررسیِ دیگری، تا یک اسکریپتِ کوبنده حتی
     شکلِ درخواست را هم مجانی نسنجد. یک ۴۲۹ ساده کافی است — صفحه پاسخِ
     /ev را اصلاً نمی‌خواند. */
  if (!rateOk(request, "ev", RL_LIMIT, RL_WINDOW_MS))
    return evDone(429, { "retry-after": "60" });

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
  /* فهرست بسته‌ی همیشگی، به‌علاوه‌ی همان استثنای باریک: کدِ چهار-رقمی فقط
     وقتی name یکی از سه رویدادِ خطاست. ⚠️ این باید همیشه دو شرط را با هم
     بخواهد — تنها EV_ERR_HEX.test(detail) کافی نیست، وگرنه wallet:on هم
     می‌توانست چهار رقم شانزده‌شانزدهی به‌عنوان جزئیات بفرستد و مرز باز
     می‌شد. */
  if (!(EV_DETAIL_OK.has(detail) || (EV_ERR_NAMES.has(name) && EV_ERR_HEX.test(detail))))
    return evDone(400);
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

function fail(status, msg, extraHeaders) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function proxyGt(request, url, ctx, env) {
  /* ⚠️ همیشه اولین خط، پیش از OPTIONS و پیش از هر کشِ لبه یا فراخوانی
     بالادست. برخلافِ /ev، این ۴۲۹ باید CORS داشته باشد وگرنه مرورگر آن را
     به یک خطای مبهم شبکه تبدیل می‌کند و مدارِ قطع‌کننده‌ی صفحه غلط
     می‌خواند — دقیقاً همان مشکلی که خودِ این پراکسی برای ۴۲۹ِ GeckoTerminal
     حل کرده بود؛ اینجا نباید همان اشتباه را روی ۴۲۹ِ خودمان تکرار کنیم. */
  if (!rateOk(request, "gt", RL_LIMIT, RL_WINDOW_MS))
    return fail(429, "too many requests", { "retry-after": "60" });

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

/* =====================================================================
   داده‌ی کارت پیش‌نمایش — سمت سرور
   =====================================================================
   ⚠️ فقط از کش *می‌خواند* و هرگز در آن نمی‌نویسد. کلید کش عمداً همان کلیدی
   است که proxyGt می‌سازد، پس اگر مرورگری همین توکن را تازه گرفته باشد این
   رندر مجانی است. ولی اگر ما هم می‌نوشتیم، پاسخِ بی‌هدرِ CORS ما زیر همان
   کلید می‌نشست و فراخوانی بعدیِ /gt از داخل مرورگر با خطای CORS می‌افتاد —
   یعنی یک کارت پیش‌نمایش، قیمت را روی خودِ سایت خراب می‌کرد.

   ⚠️ شبکه‌ی دوم (سولانا) دیگر رسیده — این ثابت دیگر تصمیم‌گیرنده نیست، فقط
   یک بازمانده‌ی سازگاریِ عقب‌رو است (برای هر کدی که هنوز از رویِ نام این
   export چیزی می‌خواند). تصمیمِ واقعی از رویِ خودِ آدرس گرفته می‌شود:
   `gtNetworkOf(chainOf(addr))` — ogFetchMeta و ogFetchVerdict هر دو همین
   را صدا می‌زنند، نه این ثابت را. `CHAIN.gtNetwork` در web/index.html هم
   «base» است چون آن صفحه هنوز فقط Base را رندر می‌کند (پایین‌تر، کنارِ
   TOKEN_PAGE، توضیح داده شده چرا). */
const OG_NETWORK = "base";
const OG_TIMEOUT_MS = 1200;

/* سقفِ کلِ خط‌لوله‌ی کارت — متادیتا + verdict، هر دو. یک آدم پشتِ این
   درخواست منتظر است؛ handlerهای HTMLRewriter پایین‌تر همین Promiseها را
   await می‌کنند، پس هر میلی‌ثانیه‌ی اینجا یک میلی‌ثانیه‌ی صفحه‌ی سفید است.
   OG_TIMEOUT_MS (سقفِ خودِ متادیتا) دست‌نخورده می‌ماند؛ این یکی سقفِ
   مجموع است، نه جایگزینِ آن. */
export const OG_BUDGET_MS = 2000;

/* میزبانِ خصوصیِ کشِ verdict — هیچ‌جا واقعاً درخواست نمی‌رود، فقط کلیدِ
   Cache API است. عمداً از هر دو بالادستِ /gt جدا: UPSTREAM_FREE/KEYED هر
   دو زیرِ همین کلیدها در proxyGt نشسته‌اند، و اگر verdict هم همان کلیدها
   را به کار می‌گرفت، ⚠️ پاسخِ ما (بدونِ هدرِ CORS) زیرِ کلیدِ یک URLِ
   بالادستِ /gt می‌نشست و فراخوانیِ بعدیِ همان آدرس از داخلِ مرورگر با خطای
   CORS می‌شکست — دقیقاً همان مشکلی که ogFetchMeta با فقط-خواندن دورش
   می‌زند. یک میزبانِ ساختگیِ خودمان با هیچ URLِ واقعیِ /gt برخورد نمی‌کند،
   پس اینجا هم خواندن امن است هم نوشتن. */
export const VD_CACHE_HOST = "zaexa-verdict.internal";

/* نسخه‌ی جزئیات‌دارِ ogFetchMeta — { meta, why }. ogFetchMeta پایین‌تر فقط
   .meta همین تابع را برمی‌گرداند؛ همان تماس‌ها، همان تایم‌اوت، همان خواندنِ
   کش. why فقط برای سنجش است (worker/report.js/reportRow آن را ذخیره
   می‌کند)؛ خودِ meta و رفتارِ کشِ لبه بایت‌به‌بایت دست‌نخورده می‌ماند.
   ⚠️ چرا fetch و json() دو try جدا دارند: تشخیصِ «fetch پرتاب کرد» (که
   signal.aborted می‌گوید تایم‌اوت بود یا نه) از «بدنه‌ی غیرقابلِ‌پارس/شکلِ
   بد» فقط با دو مرحله‌ی جدا ممکن است — یک try مشترک هر دو را زیرِ یک
   catch گم می‌کرد. */
async function ogFetchMetaDetail(addr, env) {
  // شبکه از رویِ خودِ آدرس، نه از رویِ OG_NETWORK — از امروز این تابع هم
  // برای Base هم برای سولانا صدا زده می‌شود (/t/<mint سولانا> دیگر ۴۰۴
  // نمی‌گیرد)، و همین یک خط بدونِ هیچ تغییری هر دو را درست می‌فهمد.
  const network = gtNetworkOf(chainOf(addr)) || OG_NETWORK;
  const key = (env && typeof env.CG_KEY === "string" && env.CG_KEY) || "";
  const rest = "networks/" + network + "/tokens/" + addr;
  const target = (key ? UPSTREAM_KEYED : UPSTREAM_FREE) + "/" + rest;

  const store = (typeof caches !== "undefined" && caches.default) || null;
  if (store) {
    try {
      const hit = await store.match(new Request(target, { method: "GET" }));
      if (hit) {
        const meta = pickTokenMeta(await hit.json());
        return { meta, why: meta ? null : "meta:shape" };
      }
    } catch (e) { /* کش خراب = بی‌کش، نه بی‌کارت */ }
  }

  /* سقف زمانی سخت. اگر بالادست کند بود، کارت عمومی می‌شود ولی صفحه‌ی کاربر
     منتظر نمی‌ماند — «نمی‌دانم» نباید به «صفحه بالا نیامد» ترجمه شود. */
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), OG_TIMEOUT_MS);
  try {
    const h = { accept: "application/json" };
    if (key) h["x-cg-demo-api-key"] = key;
    let up;
    try {
      up = await fetch(target, { headers: h, signal: ac.signal });
    } catch (e) {
      return { meta: null, why: ac.signal.aborted ? "meta:timeout" : "meta:0" };
    }
    if (!up.ok) return { meta: null, why: "meta:" + up.status };
    try {
      const meta = pickTokenMeta(await up.json());
      return { meta, why: meta ? null : "meta:shape" };
    } catch (e) {
      return { meta: null, why: "meta:shape" };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function ogFetchMeta(addr, env) {
  return (await ogFetchMetaDetail(addr, env)).meta;
}

/* نسخه‌ی دسته‌ایِ ogFetchMetaDetail — فقط Base، فقط برایِ گذرِ گزارش (worker/
   report.js → runReportPass با metaMany تزریق می‌کند). یک GET برای چند
   آدرس با هم، دقیقاً همان الگوی بالادستِ کلیددار/رایگان + هدر +
   AbortController(OG_TIMEOUT_MS) که ogFetchMetaDetail بالا دارد — بدونِ
   Cache API (این یک تماسِ دسته‌ایِ یک‌باره است، نه یک کارتِ تک‌آدرسه که
   ترافیکِ تکراری داشته باشد و از کشِ لبه سود ببرد).
   خروجی: Map آدرس(کوچک) → { meta, why }؛ هر meta دقیقاً از همان
   pickTokenMeta‌ای می‌آید که ogFetchMetaDetail استفاده می‌کند، با شکلِ
   تک‌آیتمیِ { data: item } — یعنی هیچ قاعده‌ی دومِ موازی برای «متا چیست»
   ساخته نمی‌شود.
   ⚠️ آدرسی که در پاسخِ موفق نباشد → why:"meta:404" (همان چیزی که
   تک‌آدرسه در آن ۴۰۴ می‌گفت). شکستِ کلِ تماس (fetch پرتاب کرد، status
   ناموفق، JSON خراب، شکلِ بدنه بد) → null، هرگز پرتاب — کالر (runReportPass)
   با غیابِ این نتیجه دقیقاً مثلِ نبودِ metaMany رفتار می‌کند: fallback به
   metaOf تک‌آدرسه‌ی امروز، برای هر توکن. */
async function ogFetchMetaMany(addrs, env) {
  try {
    if (!Array.isArray(addrs) || addrs.length === 0) return null;
    const key = (env && typeof env.CG_KEY === "string" && env.CG_KEY) || "";
    const rest = "networks/base/tokens/multi/" + addrs.join(",");
    const target = (key ? UPSTREAM_KEYED : UPSTREAM_FREE) + "/" + rest;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OG_TIMEOUT_MS);
    try {
      const h = { accept: "application/json" };
      if (key) h["x-cg-demo-api-key"] = key;
      let up;
      try {
        up = await fetch(target, { headers: h, signal: ac.signal });
      } catch (e) {
        return null;
      }
      if (!up.ok) return null;
      let body;
      try {
        body = await up.json();
      } catch (e) {
        return null;
      }
      if (!body || !Array.isArray(body.data)) return null;

      const byAddr = new Map();
      for (const item of body.data) {
        const a = item && item.attributes && typeof item.attributes.address === "string"
          ? item.attributes.address.toLowerCase() : null;
        if (!a) continue;
        const meta = pickTokenMeta({ data: item });
        byAddr.set(a, { meta, why: meta ? null : "meta:shape" });
      }

      const out = new Map();
      for (const addr of addrs) {
        const a = typeof addr === "string" ? addr.toLowerCase() : null;
        if (!a) continue;
        out.set(a, byAddr.has(a) ? byAddr.get(a) : { meta: null, why: "meta:404" });
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return null;
  }
}

/* هستهٔ مشترکِ کش‌کردنِ verdict — هم برای Base هم برای سولانا. قبلاً این
   منطق فقط داخلِ ogFetchVerdict بود؛ با آمدنِ سولانا دو نسخه از همان قاعده‌ی
   «هرگز نامعلوم را کش نکن» می‌شد، و این دقیقاً همان کلاس‌خطایی است که یک بار
   با کپی‌شدنِ منطقِ verdict این مخزن را گزیده. کلیدِ کش را کالر می‌سازد، نه
   این تابع، چون شکلِ آدرسِ دو زنجیره فرق دارد: چک‌سامِ EVM یعنی حروفِ
   کوچک/بزرگ همان آدرس‌اند، پس toLowerCase لازم است؛ mint سولانا حساس به
   حروف است — lowercase کردنش آدرسِ دیگری می‌سازد، نه همان یکی. */
/* out (اختیاری) یک شیءِ مشاهده‌گر است، دقیقاً مثلِ whyOut در fetchVerdict:
   computeFn می‌تواند out.v4Proof را پر کند و همان مقدار **کنارِ خودِ حکم کش
   می‌شود**، و روی هر ضربه‌ی کش دوباره در همان out می‌نشیند.
   🔴 چرا لازم شد: بدونِ این، یک "nosell"ِ کش‌شده در درخواستِ بعدی شاهدِ
   نسخه ۴ خود را نداشت و گاردِ پوشش دوباره به «نامعلوم» تنزلش می‌داد —
   اندازه‌گیریِ زنده‌ی ۱۹ شهریور: همان توکن در دو اجرای پشت‌سرهم دو جوابِ
   متفاوت داد. یک حکم نباید بینِ دو درخواستِ یک‌دقیقه‌ای عوض شود. */
async function cachedVerdict(cacheKeyPath, computeFn, ctx, out) {
  try {
    const store = (typeof caches !== "undefined" && caches.default) || null;
    const cacheKey = new Request("https://" + VD_CACHE_HOST + cacheKeyPath);

    if (store) {
      const hit = await store.match(cacheKey);
      if (hit) {
        const body = await hit.json();
        if (out && body && body.v4Proof === true) out.v4Proof = true;
        if (out && body && body.v4Keyed === true) out.v4Keyed = true;
        return body && (body.verdict === "sell" || body.verdict === "nosell") ? body.verdict : null;
      }
    }

    const verdict = await computeFn();

    /* هرگز «نمی‌دانم» را کش نکن. یک تعلیقِ گذرای یک RPC را به پنج دقیقه‌ی
       خاموشِ کارتِ تنزل‌یافته تبدیل می‌کند — دقیقاً همان «نمی‌دانم که مثل
       نه رفتار کند» که این پروژه هرگز نمی‌پذیرد. */
    if ((verdict === "sell" || verdict === "nosell") && store) {
      const stashBody = { verdict };
      if (out && out.v4Proof === true) stashBody.v4Proof = true;
      if (out && out.v4Keyed === true) stashBody.v4Keyed = true;
      const stash = new Response(JSON.stringify(stashBody), {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
        },
      });
      const put = store.put(cacheKey, stash);
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
      else await put;
    }
    return verdict;
  } catch (e) {
    return null; // این تابع هرگز نباید کارت را بشکند
  }
}

/* =====================================================================
   حفاظِ Base — یک "nosell" بدونِ استخرِ پوشش‌داده‌شده اثبات نیست
   =====================================================================
   اندازه‌گیریِ زنده: یک توکنِ واقعاً قابلِ‌فروش روی Base «nosell» گرفت چون
   استخرهای واقعی‌اش روی صرافی‌هایی بودند که VD_VENUES اصلاً پروب نمی‌کند
   (شش‌تا روی uniswap-v4، یکی روی uniswap-v2) — هر پروب رد شد (چهارتا حتی
   با صفرِ SOLIDLY، لایه‌ی بالا همین را جدا کرد)، ولی هیچ‌کدام چیزی درباره‌ی
   *فروش* نگفتند؛ فقط گفتند «من استخر ندارم». یک ریوِرت از صرافی‌ای که
   اصلاً استخر ندارد اثباتِ هیچ‌چیزی نیست.

   پس یک nosell دیگر به‌تنهایی کافی نیست: باید شاهدِ مثبت هم باشد که
   دست‌کم یک صرافیِ *پوشش‌داده‌شده* واقعاً برای این توکن استخر دارد.

   این هفت id دقیقاً همان‌هایی‌اند که امروز از خودِ فهرستِ زنده‌ی
   networks/base/dexes خوانده شدند — اندازه‌گیری‌شده، نه حدسی. هر idِ دیگرِ
   همان شبکه (از‌جمله uniswap-v4-base، uniswap-v2-base، baseswap-v3،
   sushiswap-v3-base، alien-base-v3، aerodrome-slipstream-2) عمداً غایب
   است: قراردادهای دیگری‌اند که ما پروب نمی‌کنیم، پس نبایدِ نگاشت‌شدنشان
   باید به‌سمتِ «نامعلوم» شکست بخورد، نه به‌سمتِ یک اتهام. */
export const GT_DEX_TO_VENUE = Object.freeze({
  "uniswap-v3-base": "uniswap-v3",
  "pancakeswap-v3-base": "pancake-v3",
  "aerodrome-slipstream": "aerodrome-cl",
  "aerodrome-base": "aerodrome",
  "baseswap": "baseswap",
  "sushiswap-v2-base": "sushiswap",
  "alien-base": "alienbase",
  // از ۸ سپتامبر پوشش داده می‌شود؛ پیش از آن عمداً بیرون بود چون روترش در
  // VD_VENUES نبود. جدول و فهرستِ صرافی‌ها باید همیشه با هم جابه‌جا شوند.
  "uniswap-v2-base": "uniswap-v2",
});

/* از رویِ خودِ VD_VENUES ساخته می‌شود — یک فهرستِ دستیِ دومِ idِ صرافی‌ها
   دقیقاً همان کلاسِ drift است که این فایل جاهای دیگر هم رویش هشدار داده. */
const VD_VENUE_ID_SET = new Set(VD_VENUES.map((v) => v.id));

/* حافظه‌ی یک‌گذر — passPoolsMemo
   =====================================================================
   اندازه‌گیری: یک توکنِ v4 که به "nosell" خام می‌رسد، در طولِ همان یک گذرِ
   ساعتی هم از رویِ ایندکسِ کلیدِ واقعی (fetchV4Pools ← runV4Index) هم از
   رویِ گاردِ پوشش (baseVenueCoveredDetail ← ogFetchVerdictDetail) دقیقاً
   همان یک آدرس را از networks/base/tokens/<addr>/pools می‌پرسد — یعنی
   همان جواب، دوبار، دو ساب‌ریکوئست از سقفِ ۵۰تاییِ همان گذر برایِ یک
   پرسش. fetchBaseTokenPoolsRaw پایین‌تر این دو تماس را در یک تابعِ خامِ
   پایه یکی می‌کند؛ passPoolsMemo فقط دومین‌بار همان آدرس را در همان گذر
   رایگان می‌کند.
   ⚠️ scheduledReportPass دقیقاً کنارِ جایگزینیِ globalThis.fetch این را
   new Map() می‌کند و در همان finally که fetch را برمی‌گرداند دوباره null
   می‌کند (پایین‌تر همین فایل) — یعنی این حافظه فقط عمرِ یک گذرِ زنده را
   دارد. بیرونِ یک گذر (کارتِ /t/، /vd، /vd/v4) همیشه null می‌ماند و این
   تابع دقیقاً همان چیزی است که دیروز بود: هر تماس یک fetch واقعیِ خودش.
   🔴 فقط موفقیت‌ها (ok:true) حافظه می‌شوند — همان قاعده‌ی cachedVerdict
   بالاتر برایِ verdict: «نامعلوم را هرگز کش نکن». یک ۴۲۹/تایم‌اوتِ گذرا
   نباید تماسِ دومِ همان توکن را هم کور کند؛ آن یکی باید دوباره واقعاً
   بپرسد.
   ⚠️ همان احتیاطِ هم‌زمانیِ globalThis.fetch بالاتر (توضیحِ
   scheduledReportPass): یک درخواستِ هم‌زمان در همین ایزوله (اگر باشد) هم
   می‌تواند از همین Map بخواند — یعنی جوابی که می‌بیند حداکثر یک گذر کهنه
   است، هرگز یک حکمِ باطل؛ همان جوابِ بالادست است، فقط یک‌بار پرسیده شده. */
let passPoolsMemo = null;

/* آیا برای این توکن، دست‌کم یک استخر روی یکی از صرافی‌های *پوشش‌داده‌شده*
   واقعاً وجود دارد؟ true/false/null — هرگز پرتاب نمی‌کند.
   همان الگوی upstream/کلید که ogFetchMeta دارد (UPSTREAM_KEYED با هدرِ
   x-cg-demo-api-key وقتی env.CG_KEY هست، وگرنه UPSTREAM_FREE)، و همان
   سبکِ سقفِ زمانیِ سخت. */
/* تماسِ خامِ پایه — یک fetch به networks/base/tokens/<addr>/pools، هرگز
   پرتاب نمی‌کند: { ok:true, data } یا { ok:false, why }. baseVenueCoveredDetail
   و fetchV4Pools هر دو رویِ همین یک تابع سوارند (پایین‌تر)، به‌جای دو کپیِ
   جدا از همین fetch — passPoolsMemo بالا فقط همین‌جا خوانده/نوشته می‌شود. */
async function fetchBaseTokenPoolsRaw(addr, env) {
  const memoKey = typeof addr === "string" ? addr.toLowerCase() : "";
  if (passPoolsMemo instanceof Map && passPoolsMemo.has(memoKey)) {
    return passPoolsMemo.get(memoKey); // ضربه‌ی حافظه‌ی همین گذر — بدونِ fetch
  }

  let result;
  try {
    const key = (env && typeof env.CG_KEY === "string" && env.CG_KEY) || "";
    const target = (key ? UPSTREAM_KEYED : UPSTREAM_FREE) +
      "/networks/base/tokens/" + addr + "/pools";

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OG_TIMEOUT_MS);
    let up;
    try {
      const h = { accept: "application/json" };
      if (key) h["x-cg-demo-api-key"] = key;
      try {
        up = await fetch(target, { headers: h, signal: ac.signal });
      } catch (e) {
        result = { ok: false, why: ac.signal.aborted ? "cover:timeout" : "cover:0" };
      }
    } finally {
      clearTimeout(timer);
    }
    if (!result) {
      if (!up || !up.ok) {
        result = { ok: false, why: "cover:" + (up ? up.status : 0) }; // غیر-۲۰۰ → نامعلوم، نه false
      } else {
        const body = await up.json();
        result = (!body || !Array.isArray(body.data))
          ? { ok: false, why: "cover:shape" } // شکلِ غیرقابلِ‌اعتماد → نامعلوم
          : { ok: true, data: body.data };
      }
    }
  } catch (e) {
    result = { ok: false, why: "cover:shape" }; // پرتاب (پارس) → نامعلوم، هرگز false
  }

  if (result.ok === true && passPoolsMemo instanceof Map) passPoolsMemo.set(memoKey, result);
  return result;
}

/* نسخه‌ی جزئیات‌دارِ baseVenueCovered — { covered, why }. baseVenueCovered
   پایین‌تر فقط .covered همین تابع را برمی‌گرداند؛ خودِ تصمیمِ true/false/null
   بایت‌به‌بایت دست‌نخورده می‌ماند، why فقط برای سنجش (ogFetchVerdictDetail)
   اضافه شده. همان دلیلِ ogFetchMetaDetail بالا برای try جداگانه‌ی fetch. */
/* جمعِ فروشنده‌های یکتای ساعتِ گذشته روی همه‌ی استخرهای یک توکن (بدنه‌ی
   tokens/<addr>/pools گِکوترمینال: attributes.transactions.h1.sellers). اگر حتی
   یک استخر این عدد را به شکلِ درست نداشت → null («نمی‌دانیم»، نه صفر). */
export function sellersH1Of(pools) {
  if (!Array.isArray(pools)) return null;
  let sum = 0;
  for (const pool of pools) {
    const t = pool && pool.attributes && pool.attributes.transactions;
    const n = t && t.h1 && t.h1.sellers;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    sum += n;
  }
  return sum;
}

/* ۲۴ سپتامبر — SN80 (0x6f63…4378): «nosell» ولی استخرِ اصلی‌اش SN80/TAO روی
   aerodrome-slipstream است، ۹۲ هزار دلار و ۲۵ فروشنده در ۲۴ ساعت. ما فقط به اتر و
   USDC کوت می‌گیریم؛ استخرهای SN80 با آن دو خالی بودند، پس حکمِ منفی «از راه‌هایی
   که پرسیدیم» درست بود ولی «نمی‌شود فروخت» غلط. (ادعای بازرس که وتوی فروشنده فقط
   روی v4 است سنجیده و رد شد: sellersH1Of روی همه‌ی استخرهاست؛ جمعِ ساعتِ آخر ۲ بود.)
   این شمارنده فروشنده‌های ۲۴ ساعتِ استخرهایی را جمع می‌کند که ضدجفتشان را اصلاً
   نمی‌پرسیم. استخری که شکلش را نشناسیم شمرده نمی‌شود (وتو نمی‌سازد). */
export function sellersElsewhere24Of(pools, tokenAddr, probed) {
  if (!Array.isArray(pools) || typeof tokenAddr !== "string") return null;
  const t = tokenAddr.toLowerCase();
  const probedSet = new Set((probed || []).map((a) => String(a).toLowerCase()));
  const side = (rel) => {
    const id = rel && rel.data && rel.data.id;
    if (typeof id !== "string") return null;
    const i = id.indexOf("_");
    const a = i === -1 ? null : id.slice(i + 1).toLowerCase();
    return a && /^0x[0-9a-f]{40}$/.test(a) ? a : null;
  };
  let sum = 0;
  for (const pool of pools) {
    const rel = pool && pool.relationships;
    const b = side(rel && rel.base_token), q = side(rel && rel.quote_token);
    if (!b || !q) continue;
    const counter = b === t ? q : q === t ? b : null;
    if (!counter || probedSet.has(counter)) continue;
    const n = pool.attributes && pool.attributes.transactions && pool.attributes.transactions.h24 &&
      pool.attributes.transactions.h24.sellers;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) continue;
    sum += n;
  }
  return sum;
}

async function baseVenueCoveredDetail(addr, env) {
  const r = await fetchBaseTokenPoolsRaw(addr, env);
  if (!r.ok) return { covered: null, why: r.why };
  try {
    // v4Listed: آیا در همینِ بدنه‌ی سالم، دست‌کم یک استخر دقیقاً روی
    // uniswap-v4-base دیده شد؟
    let v4Listed = false;
    /* فروشنده‌های یکتای ساعتِ گذشته، جمع روی همه‌ی استخرهای همین توکن — از
       همین بدنه، بدونِ هیچ درخواستِ اضافه. کنترلِ منفیِ nosell پایین‌تر از آن
       استفاده می‌کند. null یعنی شکل را نشناختیم (نه صفر). */
    const sellersH1 = sellersH1Of(r.data);
    const sellersElsewhere24 = sellersElsewhere24Of(r.data, addr, V4_ALL_COUNTERS);
    for (const pool of r.data) {
      const dexId = pool && pool.relationships && pool.relationships.dex &&
        pool.relationships.dex.data && pool.relationships.dex.data.id;
      if (typeof dexId !== "string") continue;
      if (dexId === "uniswap-v4-base") v4Listed = true;
      const venue = GT_DEX_TO_VENUE[dexId];
      if (venue && VD_VENUE_ID_SET.has(venue)) return { covered: true, why: null, v4Listed, sellersH1, sellersElsewhere24 };
    }
    return { covered: false, why: "cover:false", v4Listed, sellersH1, sellersElsewhere24 }; // بدنه سالم بود، ولی هیچ استخری روی یک صرافیِ پوشش‌داده‌شده نبود
  } catch (e) {
    return { covered: null, why: "cover:shape" }; // پرتاب → نامعلوم، هرگز false
  }
}

async function baseVenueCovered(addr, env) {
  return (await baseVenueCoveredDetail(addr, env)).covered;
}

/* env.BASE_RPC — یک RPC اختصاصیِ Base، دقیقاً هم‌شکل با env.SOL_RPC/env.CG_KEY
   بالا: خوانده می‌شود defensively (typeof … === "string")، در پنل کلادفلر
   به‌صورتِ یک Secret می‌نشیند، و هرگز به مرورگر نمی‌رسد. اگر ست شده باشد،
   *اولین* اندپوینتی است که fetchVerdict امتحان می‌کند؛ فهرستِ عمومیِ VD_RPCS
   (worker/verdict.js) دقیقاً پشتِ آن، بدونِ هیچ تغییری، به‌عنوانِ fallback
   می‌ماند. غایب‌بودنش رفتار را بایت‌به‌بایت همان چیزی نگه می‌دارد که امروز
   است (خودِ VD_RPCS، بدونِ افزوده).

   ⚠️ برخلافِ CG_KEY، یک RPC اختصاصی معمولاً کلید را در خودِ URL حمل می‌کند —
   یا در مسیر یا در کوئری، دقیقاً همان‌طور که env.SOL_RPC می‌کند. پس این URL
   کاملش هرگز نباید در هیچ پاسخ، هیچ لاگ، یا خروجیِ probe (?probe=1 پایین‌تر)
   ظاهر شود. برخلافِ سولانا که یک اندپوینتِ تشخیصیِ هم‌شکل با /vd/rpc دارد
   (که حداقل hostname را گزارش می‌کند)، Base چنین چیزی ندارد — لاگِ پروبِ
   fetchVerdict (opts.collect) اصلاً هیچ اشاره‌ای به کدام RPC ندارد، فقط
   venue/key/stage/out. پس قاعده اینجا حتی سخت‌گیرانه‌تر از سولانا است: نه
   فقط مسیر/کوئری، هیچ‌چیزِ URL هرگز به بیرون نمی‌رود. */
export function baseRpcsFor(env) {
  const baseRpc = (env && typeof env.BASE_RPC === "string" && env.BASE_RPC) || "";
  return baseRpc ? [baseRpc, ...VD_RPCS] : VD_RPCS;
}

/* =====================================================================
   ایندکسِ کلیدِ واقعیِ v4 — سیم‌کشیِ worker/v4index.js داخلِ Worker
   =====================================================================
   خودِ worker/v4index.js خالص است و هیچ fetchی ندارد؛ همین‌جا سه چیز به
   آن تزریق می‌شود: pools (از همان بالادستِ GeckoTerminal که
   baseVenueCovered هم می‌زند)، rpcCall (یک تماسِ تکی؛ failover-اش هم
   همین‌جاست، نه در v4index.js)، و کلیدِ ذخیره‌سازی (v4KvKey). */

/* سقفِ هر تلاشِ RPC — هم‌رده‌ی VD_RPC_PROBE_TIMEOUT_MS پایین‌ترِ همین فایل
   (که برای پروبِ سولانا به‌کار می‌رود)؛ eth_getLogs هم یک تماسِ تکی است،
   پس همان مرتبه از تایم‌اوت منطقی است. */
const V4_LOG_TIMEOUT_MS = 1500;

/* یک JSON-RPC POSTِ تکی، با failover بینِ V4_LOG_RPCS — همان شکلِ
   {ok, result} که indexV4Keys از تابعِ تزریق‌شده‌ی rpcCall می‌خواهد.
   failover *اینجا* اتفاق می‌افتد، نه در v4index.js — همان‌طور که بالای
   خودِ آن فایل هم نوشته شده: indexV4Keys فقط یک rpcCall(method, params)
   می‌خواهد و نمی‌داند پشتش چند اندپوینت است.
   🔴 هرگز URLِ هیچ اندپوینتی را لاگ یا برنگردان — همان قاعده‌ی بالای
   baseRpcsFor، بدونِ هیچ استثنایی برای این تابع. */
async function rpcCallBase(method, params, timeoutMs, collect) {
  /* collect یک مشاهده‌گرِ محض است (همان الگوی opts.collect در
     worker/verdict.js): وقتی آرایه نباشد، این تابع بایت‌به‌بایت همان چیزی
     است که بود. هرگز هیچ تصمیمی از رویش گرفته نمی‌شود.
     🔴 فقط hostname ثبت می‌شود، هرگز خودِ URL — همان قاعده‌ی بالای
     baseRpcsFor. و دلیلِ رد همیشه از کدِ عددی می‌آید (وضعیتِ HTTP و کدِ
     JSON-RPC)، هرگز از متنِ پیامِ خطا: متنِ خطای drpc در اندازه‌گیریِ
     ۱۴ سپتامبر از ۱۰۰۰۰ بلاک حرف می‌زد در حالی که روی ۵۰۰ بلاک هم رد
     می‌کرد — متنِ خطا شاهد نیست. */
  const log_ = Array.isArray(collect) ? collect : null;
  function note(rpcUrl, stage, status, code) {
    if (!log_) return;
    let h = "unparseable-url";
    try { h = new URL(rpcUrl).hostname; } catch (e) { /* عمداً خاموش */ }
    log_.push({ h, m: method, stage, status, code });
  }

  for (const rpcUrl of V4_LOG_RPCS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      note(rpcUrl, "throw", 0, null);
      continue; // پرتابِ شبکه‌ای/تایم‌اوت → این اندپوینت نامعلوم، بعدی را امتحان کن
    }
    clearTimeout(timer);
    if (!res || res.status !== 200) {
      note(rpcUrl, "status", res ? res.status : 0, null);
      continue; // غیرِ ۲۰۰ → این اندپوینت نامعلوم
    }
    let body;
    try { body = await res.json(); } catch (e) {
      note(rpcUrl, "body", res.status, null);
      continue; // بدنه‌ی ناخوانا → نامعلوم
    }
    if (!body || typeof body !== "object" || body.error) {
      const code = body && body.error && typeof body.error === "object" &&
        typeof body.error.code === "number" ? body.error.code : null;
      note(rpcUrl, "rpc-error", res.status, code);
      continue; // خطای JSON-RPC → نامعلوم
    }
    note(rpcUrl, "ok", res.status, null);
    return { ok: true, result: body.result };
  }
  return { ok: false, result: null }; // هیچ اندپوینتی جوابِ خوش‌شکل نداد
}

/* همان بالادستِ baseVenueCovered (networks/base/tokens/<addr>/pools) —
   امروز دیگر یک فراخوانیِ جدا نیست: هر دو رویِ همان fetchBaseTokenPoolsRaw
   بالاتر سوارند، تا در طولِ یک گذر (passPoolsMemo) همان آدرس دوبار
   پرسیده نشود. fetchV4Pools فقط شکلش با baseVenueCoveredDetail فرق دارد —
   این‌جا ردیف‌های خامِ data برمی‌گردد (v4PoolsFromGt در v4index.js خودش
   شکلشان را می‌سنجد)، آن‌جا فقط true/false/null. */
async function fetchV4Pools(addr, env) {
  const r = await fetchBaseTokenPoolsRaw(addr, env);
  return r.ok ? r.data : null; // غیرِ۲۰۰/پرتاب/شکلِ بد → نامعلوم، نه فهرستِ خالی
}

/* ضدجفت‌های مجاز، مسطح و بدونِ تکرار، از رویِ VD_V4_STAGE_COUNTERS خودِ
   worker/verdict.js — تنها جایی که آن قاعده نوشته می‌شود؛ اینجا فقط مصرف
   می‌شود. v4PoolsFromGt خودش با حروفِ کوچک مقایسه می‌کند، لوئرکِردنِ اینجا
   فقط برای dedupe است. */
const V4_ALL_COUNTERS = Object.freeze(
  [...new Set(Object.values(VD_V4_STAGE_COUNTERS).flat().map((a) => String(a).toLowerCase()))]
);

/* چه مدت (ثانیه) نتیجه‌ی ایندکس ذخیره شود، یا اصلاً ذخیره نشود.
   🔴 «ok» با V4_KEY_TTL_S (۳۰ روز — یک PoolKey هرگز عوض نمی‌شود) می‌نشیند.
   no-v4-pool/no-created-at/no-log با V4_MISS_TTL_S (۶ ساعت) — این سه از
   دلِ خودِ pools یا لاگِ زنجیره‌ای که واقعاً خوانده شده می‌آیند، یک منفیِ
   صادقانه‌اند، هرچند کوتاه‌عمر.
   rpc-down/no-anchor هرگز نوشته نمی‌شوند — نامعلوم هرگز کش نمی‌شود؛
   دفعه‌ی بعد دوباره امتحان می‌شود.
   ⚠️ no-pool-id در اسپکِ این تغییر از قلمِ این فهرست افتاده بود (فقط
   no-v4-pool/no-created-at/no-log به‌عنوانِ میسِ ذخیره‌شدنی نام برده شده
   بودند) — ولی از همان جنسِ no-created-at است: هر دو از شکلِ دادهٔ خودِ
   GeckoTerminal می‌آیند (نه از یک RPCِ نامعلوم)، پس همان رفتار به آن هم
   داده شد؛ در گزارشِ نهایی به‌عنوانِ یک نکته گزارش می‌شود، نه یک تصمیمِ
   بی‌صدا.
   no-v4-counter هم از همین جنس است — از رویِ شکلِ خودِ pools (ضدجفتِ هیچ
   ردیفی با VD_V4_STAGE_COUNTERS جور درنیامد)، نه یک RPCِ نامعلوم. */
function v4StoreTtl(reason) {
  if (reason === "ok") return V4_KEY_TTL_S;
  if (reason === "no-v4-pool" || reason === "no-pool-id" ||
      reason === "no-created-at" || reason === "no-log" || reason === "no-v4-counter") return V4_MISS_TTL_S;
  return null; // rpc-down / no-anchor / no-kv → هرگز نوشته نمی‌شود
}

async function storeV4Result(addr, env, result) {
  try {
    const kv = env && env.ZX_KV;
    if (!kv) return false;
    const ttl = v4StoreTtl(result && result.reason);
    if (ttl === null) return false;
    const body = JSON.stringify({
      keys: Array.isArray(result && result.keys) ? result.keys : [],
      reason: result.reason,
      complete: result && result.complete === true,
    });
    await kv.put(v4KvKey("base", addr), body, { expirationTtl: ttl });
    return true;
  } catch (e) {
    return false; // نوشتنِ ناموفق نباید هیچ‌چیزِ دیگری را بشکند
  }
}

/* { found, keys, complete } — found فقط برای تشخیصِ «هیچ‌وقت ایندکس نشده» از
   «ایندکس شده ولی میسِ خالی» لازم است (هر دو حالت آرایه‌ی [] می‌دهند).
   complete از رویِ همان فیلدی می‌آید که storeV4Result نوشته؛ یک ورودیِ
   قدیمی‌تر که هنوز آن فیلد را ندارد → complete:false (نامعلوم هرگز true
   فرض نمی‌شود). هر مسیرِ شکست هم complete:false می‌دهد. */
async function readV4Entry(addr, env) {
  try {
    const kv = env && env.ZX_KV;
    if (!kv) return { found: false, keys: [], complete: false };
    const raw = await kv.get(v4KvKey("base", addr));
    if (typeof raw !== "string") return { found: false, keys: [], complete: false };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return { found: false, keys: [], complete: false }; }
    if (!parsed || !Array.isArray(parsed.keys)) return { found: false, keys: [], complete: false };
    // legacy: ورودیِ پیش از ۲۴ سپتامبر که فیلدِ complete ندارد — کالرِ /vd و کارت آن را
    // در پس‌زمینه دوباره ایندکس می‌کند تا cause="empty-pool" (مثلِ WHEN) برگردد.
    return { found: true, keys: parsed.keys, complete: parsed.complete === true,
             legacy: !Object.prototype.hasOwnProperty.call(parsed, "complete") };
  } catch (e) {
    return { found: false, keys: [], complete: false };
  }
}

// readV4Keys(addr, env) → آرایه‌ی ذخیره‌شده یا []. بدونِ ZX_KV ⇒ []، هرگز پرتاب نمی‌کند.
async function readV4Keys(addr, env) {
  return (await readV4Entry(addr, env)).keys;
}

/* آدرسِ StateView در Base — روی زنجیره‌ی زنده تایید شده (۲۰ سپتامبر)؛
   چک‌سامِ حروف بزرگ/کوچکِ این آدرس معنادار است، دقیقاً همان‌طور که این‌جا
   نوشته شده فرستاده شود، نه lowercase/uppercase‌شده. */
export const V4_STATE_VIEW = "0xa3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
// سلکتورِ getLiquidity(bytes32) روی همان StateView — از رویِ ABI واقعی‌اش،
// همان‌جا که آدرسِ بالا تایید شد.
export const V4_GET_LIQUIDITY_SEL = "0xfa6793d5";
/* سقفِ یک تماسِ شاهد، و کف‌ِ بودجه‌ای که زیرش اصلاً پرسیده نمی‌شود. */
export const V4_EMPTY_CALL_MS = 1200;
export const V4_EMPTY_MIN_MS = 400;

/* شاهدِ زنده‌ی «آیا استخرِ واقعیِ این توکن هنوز چیزی دارد؟» — true فقط وقتی
   *هر* کلیدِ واقعیِ v4ِ این توکن روی StateView.getLiquidity صفر پاسخ داد،
   false به‌محضِ اولین پاسخِ غیرصفر (نقدینگی هست)، و null هر جا که واقعاً
   نتوانستیم بپرسیم — بدونِ کلید، پاسخِ ناخواندنی، تایم‌اوت. هرگز پرتاب
   نمی‌کند: صفر از یک پاسخِ *خواندنی* شاهد است، پاسخِ ناخواندنی هرگز به یک
   ادعا تبدیل نمی‌شود.
   🔴 این تابع هرگز یک حکمِ منفی نمی‌سازد — فقط حکمِ منفی‌ای را که از جایی
   دیگر (پوششِ صرافی/اثباتِ لاگِ v4) آمده توضیح می‌دهد؛ کالر فقط زمانی
   صدایش می‌زند که raw از قبل "nosell" است.
   🔴 ۲۳ سپتامبر — SPIKE بیست استخرِ v4 داشت، فقط سه‌تا ایندکس شدند و آن سه
   دقیقاً همان استخرهایی نبودند که واقعاً معامله می‌شدند: هر کلیدِ *ایندکس‌شده*
   صفر بود، ولی این هرگز به‌معنیِ «همه‌ی استخرهای v4 این توکن خالی‌اند» نبود —
   یک empty-pool غلط که رویِ /vd زنده منتشر شد. entry.complete دقیقاً همین را
   می‌سنجد: آیا آن‌چه ایندکس شده *همه‌ی* آن چیزی بود که باید ایندکس می‌شد؟
   اگر نه، جواب null می‌ماند، نه false و نه true — ورودی‌های ذخیره‌شده‌ی
   قدیمی‌تر (بدونِ این فیلد) هم تا دوباره ایندکس‌شدن همین‌طور نامعلوم
   می‌مانند؛ نامعلوم هرگز «نه» نیست. */
export async function v4PoolsEmpty(addr, env, deadlineAt) {
  /* ⚠️ بودجه‌ی زمانی: این تابع روی مسیرِ کارتِ OG هم اجرا می‌شود که کلِ
     بودجه‌اش OG_BUDGET_MS است. یک توضیح هرگز نباید خودِ جواب را دیر کند،
     پس اگر کمتر از V4_EMPTY_MIN_MS از بودجه مانده باشد اصلاً شروع نمی‌شود
     و تایم‌اوتِ هر تماس هم به باقی‌مانده‌ی بودجه بریده می‌شود. */
  const left = typeof deadlineAt === "number" ? deadlineAt - Date.now() : V4_EMPTY_CALL_MS;
  if (left < V4_EMPTY_MIN_MS) return null;
  const entry = await readV4Entry(addr, env);
  if (entry.complete !== true) return null; // ایندکسِ ناقص/قدیمی — نامعلوم، نه ادعا
  const keys = entry.keys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const use = keys.slice(0, 4);
  for (const key of use) {
    const poolId = key && typeof key.poolId === "string" ? key.poolId : null;
    if (!poolId) return null;
    const data = V4_GET_LIQUIDITY_SEL + poolId.slice(2);
    const budget = typeof deadlineAt === "number"
      ? Math.min(V4_EMPTY_CALL_MS, deadlineAt - Date.now()) : V4_EMPTY_CALL_MS;
    if (budget < V4_EMPTY_MIN_MS) return null;   // بودجه تمام شد → نامعلوم، نه ادعا
    const res = await rpcCallBase("eth_call", [{ to: V4_STATE_VIEW, data }, "latest"], budget);
    if (!res || !res.ok || typeof res.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(res.result))
      return null; // پاسخِ ناخواندنی — «نتوانستیم بپرسیم» هرگز یک ادعا نیست
    let liquidity;
    try { liquidity = BigInt(res.result); } catch (e) { return null; }
    if (liquidity !== 0n) return false; // اولین کلیدِ پرنقدینگی کافی است
  }
  return true; // همه‌ی کلیدهای پرسیده‌شده، با پاسخی خواندنی، صفر بودند
}

/* یک گذرِ کاملِ ایندکس: pools را بگیر، indexV4Keys را با failover-rpcCall
   صدا بزن، نتیجه را ذخیره کن. هم از ctx.waitUntil (ogFetchVerdict) هم از
   GET /vd/v4/<address> صدا زده می‌شود — یک‌جا نوشته شده تا این دو مسیر
   هرگز از هم جدا نیفتند، دقیقاً همان استدلالِ همیشگیِ این فایل
   (cachedVerdict بالاتر برای verdict همین کار را می‌کند). */
async function runV4Index(addr, env, diag) {
  /* diag، وقتی شیء باشد، دو آرایه‌ی مشاهده‌گر می‌گیرد: rpc (به‌ازای هر تلاشِ
     اندپوینت) و windows (به‌ازای هر تکه‌ی بلاک). فقط GET /vd/v4/…?debug=1
     آن را می‌دهد؛ مسیرِ عادی هیچ‌کدام را نمی‌سازد. */
  const rpcLog = diag && Array.isArray(diag.rpc) ? diag.rpc : null;
  const winLog = diag && Array.isArray(diag.windows) ? diag.windows : null;
  const pools = await fetchV4Pools(addr, env);
  let result;
  if (!Array.isArray(pools)) {
    /* 🔴 خودِ فهرستِ استخرها به‌دست نیامد — indexV4Keys اصلاً صدا زده
       نمی‌شود، چون ورودی‌اش وجود ندارد. قاعده‌ی ذخیره‌اش همان rpc-down است
       (هرگز نوشته نمی‌شود)، ولی دلیلش عمداً جداست: rpc-down یعنی آرپی‌سیِ
       زنجیره جواب نداد و no-pools یعنی بالادستِ قیمت. یکی‌کردنشان همان
       «کجا ایستاد» را کور می‌کند که این اندپوینت برای دیدنش ساخته شده. */
    result = { keys: [], reason: "no-pools", complete: false };
  } else {
    const rpcCall = (method, params) => rpcCallBase(method, params, V4_LOG_TIMEOUT_MS, rpcLog);
    result = await indexV4Keys({
      tokenAddr: addr, pools, rpcCall, now: Date.now, collect: winLog, counters: V4_ALL_COUNTERS,
    });
  }
  const stored = await storeV4Result(addr, env, result);
  return {
    reason: result.reason, keys: Array.isArray(result.keys) ? result.keys : [], stored,
    complete: result.complete === true,
  };
}

/* آیا هنوز جایی این توکن قیمت فروش می‌دهد؟ — سمت سرور، فقط برای همین یک
   جمله‌ی اولِ توضیح؛ Base و سولانا هر دو، از رویِ chainOf(addr).
   ⚠️ برخلافِ ogFetchMeta که فقط از کش می‌خواند، اینجا هم می‌خوانیم هم
   می‌نویسیم — روی VD_CACHE_HOST که هیچ ربطی به proxyGt ندارد (توضیح بالای
   همین فایل، کنارِ VD_CACHE_HOST). */
/* نسخه‌ی جزئیات‌دارِ ogFetchVerdict — { v, why }. ogFetchVerdict پایین‌تر
   فقط .v همین تابع را برمی‌گرداند؛ خودِ verdict/کش/گیتِ پوشش بایت‌به‌بایت
   دست‌نخورده می‌ماند. metaWhy اختیاری است: کالر (مثلاً scheduledReportPass)
   وقتی خودش متادیتا را جدا از ogFetchMetaDetail گرفته، دلیلِ نبودِ آن را
   همین‌جا پاس می‌دهد؛ نبودنش (undefined) یعنی "internal". */
async function ogFetchVerdictDetail(addr, meta, deadlineAt, env, ctx, metaWhy) {
  if (!meta) return { v: null, why: typeof metaWhy === "string" ? metaWhy : "internal" }; // بدونِ متادیتا حتی یک تلاش هم لازم نیست
  const chain = chainOf(addr);
  if (chain === "solana") {
    /* ⚠️ اینجا toLowerCase نمی‌شود — mint سولانا حساسِ به حروف است،
       برخلافِ چک‌سامِ Base؛ همان قاعده‌ای که solFetchVerdict/diagVerdict
       رعایت می‌کنند (توضیحِ بالای cachedVerdict). و همان fetchVerdictSol
       صدا زده می‌شود، نه یک کپیِ دومِ منطقِ verdict — دقیقاً همان استدلالِ
       همیشگیِ این فایل؛ بدونِ این شاخه، تابعِ Base-محورِ fetchVerdict یک
       رشته‌ی base58 را به‌جای آدرس EVM می‌گرفت و بی‌فایده یک eth_call واقعی
       به RPCهای Base می‌فرستاد. کشِ آن هم با /vd/<mint> مشترک است: اگر
       کاربر همین mint را تازه چک کرده باشد، این رایگان است. */
    return await solFetchVerdict(addr, deadlineAt, ctx, env);
  }
  const network = gtNetworkOf(chain) || OG_NETWORK;
  // فقط computeFn (نه یک ضربه‌ی کش) آن را پر می‌کند، و فقط وقتی raw نهایتاً
  // null بماند معنا دارد — دقیقاً همان الگویی که solFetchVerdict برای why
  // بیرونِ cachedVerdict دارد.
  let baseWhy;
  // ret فقط از computeFn پر می‌شود، هرگز از ضربه‌ی کش — یک "sell"ِ کش‌شده
  // بدونِ batchِ تازه، ret ندارد و همین درست است؛ چیزی حدسی جایش نمی‌نشیند.
  let ret;
  const cacheOut = {}; // {v4Proof} — هم از computeFn پر می‌شود هم از ضربه‌ی کش
  const raw = await cachedVerdict(
    "/v1/" + network + "/" + addr.toLowerCase(),
    async () => {
      /* کلیدهای واقعیِ v4 — فقط داخلِ خودِ computeFn خوانده می‌شوند، نه
         بیرون از cachedVerdict: یک ضربه‌ی کش اصلاً به آن‌ها نیازی ندارد، پس
         این‌جا خواندنِ KV و برنامه‌ریزیِ ایندکس هر دو فقط وقتی واقعاً اتفاق
         می‌افتند که computeFn قرار است اجرا شود.
         ⚠️ اگر هنوز هیچ ورودی‌ای برای این توکن ایندکس نشده، خودِ
         ایندکس‌کردن با ctx.waitUntil به پس‌زمینه فرستاده می‌شود تا *همین*
         درخواست هزینه‌اش را نپردازد — فقط درخواستِ بعدیِ همین توکن از
         کلیدهای واقعی بهره می‌برد. */
      let v4Keys = [];
      if (env && env.ZX_KV) {
        const entry = await readV4Entry(addr, env);
        v4Keys = entry.keys;
        if ((!entry.found || entry.legacy) && ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(runV4Index(addr, env));
        }
      }
      // فقط مشاهده‌گر: آیا دست‌کم یک کلیدِ واقعیِ v4 برای این توکن ایندکس
      // شده؟ درست مثلِ v4Proof پایین‌تر، هرگز روی fetchVerdict اثر نمی‌گذارد.
      cacheOut.v4Keyed = v4Keys.length > 0;
      const whyOut = {};
      const retOut = {};
      const result = await fetchVerdict(addr, meta,
        { deadlineAt, fetchImpl: fetch, rpcs: baseRpcsFor(env), v4Keys, whyOut, retOut });
      baseWhy = whyOut.why;
      ret = retOut.ret;
      if (whyOut.v4Proof === true) cacheOut.v4Proof = true;
      return result;
    },
    ctx,
    cacheOut,
  );

  /* حفاظِ پوشش — فقط روی Base، و فقط وقتی raw واقعاً "nosell" است. مثبت
     هرگز از این‌جا رد نمی‌شود (baseVenueCoveredDetail اصلاً صدا زده
     نمی‌شود)، و نامعلوم همان نامعلوم می‌ماند. توجه: raw همان چیزی است که
     cachedVerdict کش کرد/می‌کند (بدونِ تغییر در منطقِ کش)، پس یک ضربه‌ی کش
     هم دوباره از همین گیت رد می‌شود — یک "nosell"ِ کش‌شده هرگز بدونِ این
     چک به بیرون نمی‌رود. */
  if (chain !== "base" || raw !== "nosell") {
    return raw === null
      ? { v: null, why: baseWhy || "internal" }
      // ret فقط کنارِ یک "sell" واقعی می‌نشیند — یک "nosellِ" غیرِBase هم از
      // همین شاخه رد می‌شود ولی هرگز ret نمی‌گیرد. و حتی روی "sell" هم ret
      // فقط وقتی عدد است می‌نشیند — retPctFrom که نتوانسته قیمت‌گذاری کند
      // null می‌دهد، و آن null هم باید undefined بشود، نه یک کلیدِ واقعی با
      // مقدارِ null: «نتوانستیم اندازه بگیریم» باید غایب باشد، نه صفر/null.
      : { v: raw, why: null, ret: raw === "sell" && typeof ret === "number" ? ret : undefined };
  }
  const covered = await baseVenueCoveredDetail(addr, env);
  // 🔴 شکستِ خودِ چکِ پوشش (false یا null) هم به نامعلوم تنزل می‌کند —
  // «نتوانستیم پوشش را بسنجیم» هرگز اجازه‌ی اتهام نیست.
  /* ⚠️ تماسِ اضافه‌ی v4PoolsEmpty فقط همین‌جا، روی مسیرِ منفی، اتفاق
     می‌افتد — هرگز روی مثبت یا نامعلوم. شکستِ همین یک eth_call چیزی برای
     کالر هزینه ندارد جز خودِ توضیح (cause می‌شود undefined، خودِ حکم دست‌نخورده
     می‌ماند)؛ این با v4PoolsEmpty که هرگز پرتاب نمی‌کند تضمین می‌شود. */
  if (covered.covered === true) {
    const empty = await v4PoolsEmpty(addr, env, deadlineAt);
    return finalizeBaseNosell(empty, covered, false);
  }
  /* 🔴 استثنای پوشش (۱۹ شهریور، با تصمیمِ صریحِ حسام): وقتی خودِ حکمِ منفی از
     شاهدِ «استخرِ واقعیِ این توکن هیچ اندازه‌ای را پر نمی‌کند» آمده باشد، ما
     *واقعاً* از استخرِ خودش پرسیده‌ایم — حتی اگر بالادست هیچ استخری روی
     صرافی‌های پروب‌شونده نشان ندهد. کلید از لاگِ Initialize زنجیره آمده و
     شناسه‌ی داخلِ خطا با همان کلید یکی است (verdict.js/v4NoLiquidityProof).
     ⚠️ این پرچم کنارِ خودِ حکم کش می‌شود (cachedVerdict بالاتر)، وگرنه همان
     توکن در درخواستِ بعدی جوابِ دیگری می‌گرفت. */
  if (cacheOut.v4Proof === true) {
    const empty = await v4PoolsEmpty(addr, env, deadlineAt);
    return finalizeBaseNosell(empty, covered, false); // شاهدِ واقعی از خودِ استخر: «هیچ اندازه‌ای پر نمی‌شود»
  }
  /* 🔴 استثنای پوششِ v4 (۲۹ شهریور): بالادست برای همین توکن یک استخرِ
     uniswap-v4-base *دید* (v4Listed) و ما دست‌کم یک کلیدِ واقعیِ ایندکس‌شده
     برای همان توکن داریم (v4Keyed) — یعنی واقعاً از استخرِ خودِ این توکن
     پرسیده‌ایم، حتی اگر جدولِ GT_DEX_TO_VENUE این صرافی را پروب نمی‌کند.
     ⚠️ عمداً فقط covered.covered === false، نه null: چکی که اصلاً نتوانسته
     جواب بدهد (cover:timeout / cover:shape / cover:<status>) هرگز به این
     شاخه نمی‌رسد و همیشه نامعلوم می‌ماند — یک چکِ ناکام هرگز اتهام نیست. */
  if (covered.covered === false && covered.v4Listed === true && cacheOut.v4Keyed === true) {
    const empty = await v4PoolsEmpty(addr, env, deadlineAt);
    return finalizeBaseNosell(empty, covered, true);
  }
  return { v: null, why: covered.why || "cover:shape" };
}

/* ۲۳ سپتامبر — منفیِ کاذبِ منتشرشده ($SPIKE، ۰x1685…): تنها استخرش روی v4 با
   ۲۰۶ هزار دلار نقدینگی و ۲۹۶ فروشنده‌ی یکتا در ساعتِ گذشته، ولی حکمِ ما
   «nosell» بدونِ هیچ cause بود. ریشه: شاهدِ منفی از صرافی‌هایی آمد که این توکن
   اصلاً روی‌شان استخر ندارد، و خودِ v4 فقط مثبت را می‌تواند ثابت کند (کوترِ ما
   روی استخرهای هوک‌دار جواب نمی‌دهد). قاعده‌ها، به این ترتیب:
   ۱. استخرِ خالی ثابت شد → nosell با cause="empty-pool" (مثلِ $WHEN).
   ۲. کنترلِ منفی از خودِ زنجیره: اگر در ساعتِ گذشته دست‌کم SELLERS_H1_VETO
      فروشنده‌ی *یکتا* فروخته‌اند، «فروش نمی‌رود» با واقعیت نقض شده → نامعلوم.
      آستانه ۳ است نه ۱، چون هانی‌پات‌ها معمولاً یکی‌دو آدرسِ سفیدشده (سازنده)
      دارند که می‌توانند بفروشند.
   ۳. حکمی که فقط به v4 تکیه دارد و خالی‌بودن را ثابت نکرده → نامعلوم.
   ۴. در بقیه (شاهدِ واقعیِ ریوِرت روی صرافیِ پوشش‌داده‌شده) → nosell، همان
      هانی‌پاتِ کلاسیک که نقدینگی دارد و cause ندارد. این را عمداً نگه می‌داریم:
      «هیچ nosellی بدونِ cause» کلِ یافته‌ی اصلیِ محصول را پاک می‌کرد. */
export const SELLERS_H1_VETO = 3;
export function finalizeBaseNosell(empty, covered, v4Only) {
  /* ۰. (۲۴ سپتامبر، SN80) استخرِ زنده با ضدجفتی که نمی‌پرسیم و دست‌کم SELLERS_H1_VETO
     فروشنده در ۲۴ ساعت → نامعلوم، حتی پیش از «استخرِ خالی»: خالی‌بودنِ استخرهای
     اتر/USDC یعنی از راهِ ما نمی‌شود، نه اینکه هیچ راهی نیست. */
  const elsewhere = covered && covered.sellersElsewhere24;
  if (typeof elsewhere === "number" && elsewhere >= SELLERS_H1_VETO) return { v: null, why: "sells:elsewhere" };
  if (empty === true) return { v: "nosell", why: null, cause: "empty-pool" };
  const sellers = covered && covered.sellersH1;
  if (typeof sellers === "number" && sellers >= SELLERS_H1_VETO) return { v: null, why: "sells:recent" };
  if (v4Only) return { v: null, why: "v4:unproven" };
  return { v: "nosell", why: null, cause: undefined };
}

async function ogFetchVerdict(addr, meta, deadlineAt, env, ctx) {
  return (await ogFetchVerdictDetail(addr, meta, deadlineAt, env, ctx)).v;
}

/* env.SOL_RPC — یک RPC اختصاصیِ سولانا، دقیقاً هم‌شکل با env.CG_KEY بالای
   همین فایل: خوانده می‌شود defensively (typeof … === "string")، در پنل
   کلادفلر به‌صورتِ یک Secret می‌نشیند، و هرگز به مرورگر نمی‌رسد. اگر ست شده
   باشد، *اولین* اندپوینتی است که fetchVerdictSol (و پروبِ GET /vd/rpc
   پایین‌تر) امتحان می‌کنند؛ فهرستِ عمومیِ VD_SOL_RPCS دقیقاً پشتِ آن، بدونِ
   هیچ تغییری، به‌عنوانِ fallback می‌ماند. غایب‌بودنش رفتار را بایت‌به‌بایت
   همان چیزی نگه می‌دارد که امروز است (خودِ VD_SOL_RPCS، بدونِ افزوده).

   ⚠️ برخلافِ CG_KEY که همیشه در هدر می‌رود، یک RPC اختصاصی معمولاً کلید را
   در خودِ URL حمل می‌کند — یا در مسیر (…/rpc/<KEY>) یا در کوئری
   (…?api-key=<KEY>). پس این URL کاملش هرگز نباید در هیچ پاسخ، هیچ لاگ، یا
   خروجیِ GET /vd/rpc ظاهر شود. diagVerdictRpc پایین‌تر همیشه فقط
   new URL(rpcUrl).hostname را گزارش می‌کند — همان تابعی که مسیر و کوئری را
   خودش دور می‌ریزد، نه چیزی که این تابع باید جداگانه پاک کند. */
export function solRpcsFor(env) {
  const solRpc = (env && typeof env.SOL_RPC === "string" && env.SOL_RPC) || "";
  return solRpc ? [solRpc, ...VD_SOL_RPCS] : VD_SOL_RPCS;
}

/* env.JUP_KEY — دقیقاً همان الگوی env.CG_KEY/env.SOL_RPC بالا: خوانده
   می‌شود defensively (typeof … === "string")، در پنل کلادفلر به‌صورتِ یک
   Secret می‌نشیند، و هرگز به مرورگر نمی‌رسد. کلید‌دار (Jupiter's Swap API
   plan) سقفِ نرخش خیلی بالاتر از میزبانِ کلیددارِ رایگان است — بی‌کلید
   حدودِ ۰٫۵ درخواست در ثانیه، و یک verdict چند تماس لازم دارد؛ همان کاری
   که CG_KEY برای GeckoTerminal حل کرد، این برای Jupiter می‌کند.

   ⚠️ برخلافِ SOL_RPC (که کلید را در خودِ URL می‌برد)، اینجا کلید همیشه در
   هدر می‌رود — VD_SOL_JUP_BASE (worker/verdict_sol.js) دست‌نخورده می‌ماند،
   میزبان برای کلیددار و بی‌کلید یکی است، فقط هدرِ x-api-key فرق می‌کند؛
   کسی این را «تعمیر» نکند به عوض‌کردنِ میزبان. غایب‌بودنِ JUP_KEY رفتار را
   بایت‌به‌بایت همان چیزی نگه می‌دارد که امروز است: هیچ هدرِ x-api-key‌ای
   اضافه نمی‌شود. */
export function jupKeyFor(env) {
  return (env && typeof env.JUP_KEY === "string" && env.JUP_KEY) || "";
}

/* همان سوال، برای سولانا — بدونِ متادیتای GeckoTerminal، چون
   fetchVerdictSol چیزی از قیمت/دسیمال نمی‌خواهد (رفت‌وبرگشتش را جوپیتر با
   quote خودش حساب می‌کند، نه با priceUsd ما).

   ⚠️ cachedVerdict عمداً دست‌نخورده مانده (همان قراردادِ خامِ
   "sell"/"nosell"/null که ogFetchVerdict هم می‌بیند و کارتِ Base هم رویش
   حساب باز کرده) — پس «why» را همین‌جا، بیرونِ آن تابعِ مشترک، از دلِ
   شیءِ برگشتیِ fetchVerdictSol جدا می‌کنیم. هرگز کش نمی‌شود، چون فقط وقتی
   پر می‌شود که computeFn واقعاً اجرا شده باشد (نه از cache hit) و
   cachedVerdict فقط verdictِ sell/nosell را می‌نویسد، نه why را. */
async function solFetchVerdict(mint, deadlineAt, ctx, env) {
  let why; // فقط computeFn (نه cache hit) آن را پر می‌کند، و فقط وقتی v نهایی null باشد معنا دارد
  const v = await cachedVerdict(
    "/v1/solana/" + mint,
    async () => {
      const res = await fetchVerdictSol(mint,
        { deadlineAt, fetchImpl: fetch, rpcs: solRpcsFor(env), jupBase: VD_SOL_JUP_BASE, payer: VD_SOL_PAYER,
          jupKey: jupKeyFor(env) });
      why = res.why;
      return res.v;
    },
    ctx,
  );
  return v === null ? { v: null, why: why || "internal" } : { v };
}

/* تگ‌ها را داخل همان HTML می‌نشاند.
   HTMLRewriter جریانی است، پس ۲۹۰KB صفحه در حافظه بافر نمی‌شود.
   ترتیب مهم است: اول تگ‌های ثابتِ صفحه‌ی اصلی (که با data-og علامت خورده‌اند)
   برداشته می‌شوند، بعد تگ‌های این توکن اضافه می‌شود — وگرنه ربات دو og:title
   می‌دید و کدام را برمی‌دارد به خودش بستگی داشت. */
function injectOg(res, url, addr, metaPromise, vdPromise, chain) {
  if (typeof HTMLRewriter === "undefined") return res;   // بیرون از Workers (تست node)
  if (!res || res.status !== 200) return res;
  const ct = res.headers.get("content-type") || "";
  if (!/text\/html/i.test(ct)) return res;
  return new HTMLRewriter()
    .on("meta[data-og]", { element(el) { el.remove(); } })
    .on("link[data-og]", { element(el) { el.remove(); } })
    .on("title", {
      async element(el) {
        // عنوان به verdict نیازی ندارد، ولی باید همان Promise را await کند
        // تا سرِ نخِ زمانی هر دو handler یکی باشد — نه اینکه عنوان زودتر
        // از verdict چاپ شود و بعد head دوباره صبر کند.
        const [meta] = await Promise.all([metaPromise, vdPromise]);
        el.setInnerContent(ogTitle(meta), { html: false });
      },
    })
    .on("head", {
      async element(el) {
        const [meta, verdict] = await Promise.all([metaPromise, vdPromise]);
        // برچسبِ زنجیره از همان chainOf(addr) که کالر پاس داده — نه حدسی
        // که اینجا دوباره زده شود.
        el.append(ogTags(meta, addr, url.origin, verdict, chain), { html: true });
      },
    })
    .transform(res);
}

/* =====================================================================
   /vd/<آدرس> — پروبِ تشخیصیِ verdict، بدونِ کارت
   =====================================================================
   مسئله: یک verdictِ نامعلوم روی کارت بایت‌به‌بایت همان توضیحِ قدیمی است،
   پس «RPC از کار افتاده» با «کد هنوز دیپلوی نشده» با «priceUsd جایی null
   شد» از بیرون هیچ فرقی ندارند — بدونِ این مسیر، فهمیدنِ کدام‌یک، یک حلقه‌ی
   سه‌دقیقه‌ایِ دیپلوی-و-چک می‌خواست.

   ⚠️ همان خط‌لوله‌ی کارت را صدا می‌زند (ogFetchMeta سپس ogFetchVerdict) —
   یک کپیِ دومِ منطقِ verdict نیست؛ اگر بود، این دو می‌توانستند از هم جدا
   بیفتند و همین مسیر هم چیزِ اشتباهی نشان می‌داد.

   بستهٔ (bucket) نرخِ خودش «vd» است، جدا از «og» — کاوش‌کردن با این مسیر
   نباید سهمیه‌ی رندرِ کارتِ واقعی را بخورد. هیچ‌چیزی ثبت یا لاگ نمی‌شود؛
   فقط یک عددِ خام برمی‌گردد.

   ⚠️ برخلافِ /t/ که تا رسیدنِ صفحه‌اش یک mint سولانا را رد می‌کند، /vd/
   همین امروز هر دو زنجیره را جواب می‌دهد — این مسیر کارتی سرو نمی‌کند، فقط
   یک عدد؛ محدودیتِ web/index.html اینجا معنایی ندارد. chainOf همان تصمیمی
   را می‌گیرد که chains.js همه‌جای دیگر هم می‌گیرد. */
const VD_ADDR_RE = EVM_ADDR; // برای هرکسی که هنوز این نام را ایمپورت می‌کند

function vdDone(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      extraHeaders),
  });
}

// همان vdDone، برای پاسخِ متنیِ ساده‌ی /report/<...>.txt — content-type متن، نه JSON.
function textDone(status, text, extraHeaders) {
  return new Response(text, {
    status,
    headers: Object.assign({
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }, extraHeaders),
  });
}

const VD_RPC_PROBE_TIMEOUT_MS = 1500; // سقفِ هر تماسِ تک‌متدی

// سقفِ سختِ کلِ درخواست (همه‌ی اندپوینت‌ها، همه‌ی متدها) — یک نودِ کند نباید
// کلِ /vd/rpc را کند کند؛ هر متدی که تا این لحظه نوبتش نرسیده skip می‌شود،
// نه اینکه بی‌صدا از خروجی بیفتد.
const VD_RPC_PROBE_BUDGET_MS = 4000;

/* GET /vd/rpc — پروبِ تشخیصیِ خودِ اندپوینت‌های RPC سولانا، از کلادفلر،
   حالا به‌صورتِ یک ماتریسِ اندپوینت×متد، نه فقط یک getHealth تنها.
   مسئله‌ای که این تغییر را لازم کرد: getHealth موفق‌بودن به این معنا
   نیست که همان نود متدهایی را هم که مسیرِ verdict واقعاً به آن‌ها نیاز
   دارد جواب می‌دهد — بعضی نودهای عمومی دقیقاً همین متدهای سنگین‌تر را
   عمداً می‌بندند. بدونِ این ماتریس، یک why:"rpc:…" فقط می‌گفت *که* شکست
   خورد، نه کدام تماس — این پروب دقیقاً همان سوال را پیش از نیاز به یک
   deploy-and-guess دیگر جواب می‌دهد.

   فهرستِ متدها از VD_SOL_RPC_METHODS در worker/verdict_sol.js می‌آید —
   دقیقاً همان سه رشته‌ای که fetchVerdictSol صدا می‌زند، نه یک کپیِ دستیِ
   جدا؛ worker/test.mjs با regex روی خودِ کدِ verdict_sol.js می‌سنجد که این
   دو هیچ‌وقت از هم جدا نیفتند. (getTokenAccountsByOwner دیگر عضوِ این
   فهرست نیست — verdict_sol.js دیگر آن را صدا نمی‌زند؛ چکِ «فی‌پیر قبلاً این
   mint را دارد» حالا با یک شبیه‌سازیِ کنترل انجام می‌شود، نه یک lookup.)
   simulateTransaction بدونِ ترکیبِ یک تراکنشِ کامل هیچ راهِ صادقانه‌ای برای
   پروب‌شدن ندارد، پس اصلاً فراخوانی نمی‌شود — ردیفش ok:null با
   skipped:"unprobeable" است، نه یک پاسِ جعلی.

   اندپوینت‌ها موازی امتحان می‌شوند (یک نودِ کند نباید بقیه را منتظر بگذارد)،
   ولی متدهای *داخلِ* یک اندپوینت پشتِ‌سرِهم — همان‌طور که فهرستِ متدها به
   ترتیب صدا زده می‌شوند، تا یک نودِ حساس به نرخ زیرِ فشارِ موازی سه تماس
   قرار نگیرد. VD_RPC_PROBE_BUDGET_MS سقفِ کلِ درخواست است، جدا از سقفِ
   هر تماس؛ هر متدی که مهلتش رسیده باشد اما نوبتش نرسیده skipped:"deadline"
   می‌گیرد.

   خروجی فقط میزبان/نامِ متد/ok/کدِ HTTP/کدِ JSON-RPC/میلی‌ثانیه است — نه
   بدنه، نه URL کامل، نه متنِ خطا.

   ⚠️ اگر env.SOL_RPC ست شده باشد (solRpcsFor بالا)، همان اندپوینتِ
   اختصاصی هم *ردیفِ اول* همین ماتریس است — ولی باز هم فقط با hostname، نه
   URL کامل؛ هیچ استثنایی برای این یک اندپوینت در قاعده‌ی بالا نیست. */
async function diagVerdictRpc(env) {
  const deadlineAt = Date.now() + VD_RPC_PROBE_BUDGET_MS;
  const rpcs = solRpcsFor(env);
  const endpoints = await Promise.all(rpcs.map(async (rpcUrl) => {
    const methods = [];
    for (const m of VD_SOL_RPC_METHODS) {
      if (m === "simulateTransaction") {
        methods.push({ m, ok: null, status: null, code: null, ms: 0, skipped: "unprobeable" });
        continue;
      }
      if (Date.now() >= deadlineAt) {
        methods.push({ m, ok: null, status: null, code: null, ms: 0, skipped: "deadline" });
        continue;
      }
      const row = await probeRpcMethod(fetch, rpcUrl, m, VD_SOL_RPC_PROBE_PARAMS[m], VD_RPC_PROBE_TIMEOUT_MS);
      methods.push(row);
    }
    return { h: new URL(rpcUrl).hostname, methods };
  }));
  return vdDone(200, { endpoints });
}

/* GET /vd/v4/<address> — پروبِ تشخیصیِ ایندکسِ v4: همین حالا اجرایش کن،
   نتیجه را با همان قاعده‌ی storeV4Result ذخیره کن، و بگو چه شد.
   rateOk و متد از قبل در diagVerdict سنجیده شده‌اند (همان سطلِ «vd»)، پس
   اینجا دوباره تکرار نمی‌شود.
   بدونِ ZX_KV: reason="no-kv" و هیچ فراخوانیِ بالادستی اصلاً انجام نمی‌شود —
   نه pools، نه هیچ RPC ای. */
async function diagVerdictV4(url, env) {
  const addr = url.pathname.slice("/vd/v4/".length);
  if (chainOf(addr) !== "base") return vdDone(400, { error: "bad address" });

  const t0 = Date.now();
  const kv = env && env.ZX_KV;
  if (!kv) {
    return vdDone(200, { addr, reason: "no-kv", keys: [], stored: false, complete: false, store: false, ms: Date.now() - t0 });
  }

  /* ?debug=1 — همان گذر، ولی با دو مشاهده‌گر. چرا لازم است: «rpc-down» فقط
     می‌گوید هیچ اندپوینتی جواب نداد، نه اینکه کدام و با چه کدی رد کرد. یک
     اندازه‌گیری از ویندوزِ حسام هم این را نمی‌گوید، چون آن‌جا کدِ ما اجرا
     نمی‌شود. این تنها جایی است که پاسخِ واقعی دیده می‌شود.
     🔴 هیچ URLی بیرون نمی‌رود — فقط hostname، و فقط کدهای عددی. */
  const debug = url.searchParams.get("debug") === "1";
  const diag = debug ? { rpc: [], windows: [] } : null;
  const result = await runV4Index(addr, env, diag);
  const body = {
    addr, reason: result.reason, keys: result.keys, stored: result.stored,
    complete: result.complete, store: true, ms: Date.now() - t0,
  };
  if (debug) { body.rpc = diag.rpc; body.windows = diag.windows; }
  return vdDone(200, body);
}

/* =====================================================================
   GET /vd/logrpc — ماتریسِ «کدام اندپوینت لاگ می‌دهد»، از داخلِ خودِ Worker
   =====================================================================
   ۲۴ سپتامبر ۲۰۲۶: هر سه‌ی V4_LOG_RPCS از کلادفلر رد کردند و ایندکسِ v4
   بی‌صدا ایستاد. اندازه‌گیری از ویندوزِ حسام یا از کانتینر شاهد نیست (همان
   اندپوینت از WSL جواب می‌دهد و از کلادفلر ۴۰۳)؛ فقط همین‌جا.
   برای هر کاندید (V4_LOG_RPCS + V4_LOG_RPC_CANDIDATES + env.BASE_RPC، بدونِ تکرار):
     head      eth_blockNumber — کنترلِ مثبت: اندپوینت اصلاً زنده است؟
     recent1k  eth_getLogs روی PoolManager، topic=Initialize، ۱۰۰۰ بلاکِ آخر
     old1k     همان، ۱۰۰۰ بلاک حدودِ ۴٫۶ روز عقب‌تر (ایندکس‌کننده پنجره‌ی
               ساختِ استخر را می‌پرسد، نه نوکِ زنجیره را — یک نودِ هرس‌شده
               اولی را می‌دهد و دومی را نه)
     recent10  فقط وقتی recent1k با خطای JSON-RPC رد شد: همان با ۱۰ بلاک —
               تا «سقفِ بازه» از «متد بسته است» جدا شود.
   n = تعدادِ لاگِ برگشتی. عددِ صفر روی recent1k مشکوک است (روی Base در هر
   نیم‌ساعت استخرِ v4 تازه ساخته می‌شود) ولی خودِ این ابزار حکم نمی‌کند.
   🔴 فقط hostname بیرون می‌رود — BASE_RPC کلید را در مسیر دارد. دلیلِ رد
   فقط از کدهای عددی (وضعیتِ HTTP و کدِ JSON-RPC)، هرگز از متنِ پیام.
   🔴 سقفِ زیر‌درخواست: کلادفلرِ رایگان ۵۰ زیر‌درخواست در هر درخواست دارد؛
   بیش از LOGRPC_SUBREQ_CAP هرگز زده نمی‌شود و بقیه skipped:"budget" می‌گیرند.
   هیچ‌چیز در KV نوشته نمی‌شود و ایندکس‌کننده هیچ تغییری نمی‌کند. */
export const LOGRPC_SUBREQ_CAP = 46;
export const LOGRPC_TIMEOUT_MS = 3000;
export const LOGRPC_BUDGET_MS = 20000;
export const LOGRPC_OLD_BACK = 200000; // حدودِ ۴٫۶ روز روی Base (بلاکِ ۲ ثانیه‌ای)
export const LOGRPC_STEPS = Object.freeze(["head", "recent1k", "old1k", "recent10"]);

export function logRpcCandidates(env) {
  const out = [];
  const seen = new Set();
  const add = (u, isEnv) => {
    let h;
    try { h = new URL(u).hostname; } catch (e) { return; }
    const k = isEnv ? "env:" + u : u; // BASE_RPC با کلیدِ خودش جداست حتی اگر میزبانش تکراری باشد
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ url: u, h, env: isEnv });
  };
  for (const u of V4_LOG_RPCS) add(u, false);
  for (const u of V4_LOG_RPC_CANDIDATES) add(u, false);
  const baseRpc = (env && typeof env.BASE_RPC === "string" && env.BASE_RPC) || "";
  if (baseRpc) add(baseRpc, true);
  return out;
}

async function diagLogRpc(env) {
  const deadlineAt = Date.now() + LOGRPC_BUDGET_MS;
  let used = 0;
  const hex = (n) => "0x" + Math.max(0, n).toString(16);

  async function call(rpcUrl, method, params) {
    if (used >= LOGRPC_SUBREQ_CAP) return { skipped: "budget" };
    if (Date.now() >= deadlineAt) return { skipped: "deadline" };
    used++;
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LOGRPC_TIMEOUT_MS);
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ac.signal,
      });
      if (!res || res.status !== 200) return { ok: false, status: res ? res.status : 0, code: null, ms: Date.now() - t0 };
      let body;
      try { body = await res.json(); } catch (e) { return { ok: false, status: 200, code: null, ms: Date.now() - t0, shape: "body" }; }
      if (!body || typeof body !== "object" || body.error) {
        const code = body && body.error && typeof body.error === "object" &&
          typeof body.error.code === "number" ? body.error.code : null;
        return { ok: false, status: 200, code, ms: Date.now() - t0, rpcError: true };
      }
      return { ok: true, status: 200, code: null, ms: Date.now() - t0, result: body.result };
    } catch (e) {
      return { ok: false, status: 0, code: null, ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
  const row = (s, r, extra) => r.skipped
    ? { s, ok: null, status: null, code: null, ms: 0, skipped: r.skipped }
    : { s, ok: r.ok, status: r.status, code: r.code, ms: r.ms, ...(extra || {}) };
  const logsRow = (s, r) => {
    if (r.ok && !Array.isArray(r.result)) return { s, ok: false, status: r.status, code: null, ms: r.ms, shape: "not-array" };
    return row(s, r, r.ok ? { n: r.result.length } : null);
  };
  const logParams = (from, to) => [{
    address: V4_POOL_MANAGER, topics: [V4_INITIALIZE_TOPIC], fromBlock: hex(from), toBlock: hex(to),
  }];

  const endpoints = await Promise.all(logRpcCandidates(env).map(async (c) => {
    const steps = [];
    const h0 = await call(c.url, "eth_blockNumber", []);
    let head = null;
    if (h0.ok && typeof h0.result === "string" && /^0x[0-9a-f]+$/i.test(h0.result)) head = parseInt(h0.result, 16);
    steps.push(h0.ok && head === null
      ? { s: "head", ok: false, status: 200, code: null, ms: h0.ms, shape: "not-hex" }
      : row("head", h0));
    if (head === null) {
      for (const s of LOGRPC_STEPS.slice(1)) steps.push({ s, ok: null, status: null, code: null, ms: 0, skipped: "no-head" });
      return { h: c.h, env: c.env, steps };
    }
    const tip = head - 5; // نوکِ زنجیره روی بعضی نودها هنوز لاگ ندارد
    const r1 = await call(c.url, "eth_getLogs", logParams(tip - 1000, tip));
    steps.push(logsRow("recent1k", r1));
    const r2 = await call(c.url, "eth_getLogs", logParams(tip - LOGRPC_OLD_BACK - 1000, tip - LOGRPC_OLD_BACK));
    steps.push(logsRow("old1k", r2));
    if (r1.rpcError) {
      steps.push(logsRow("recent10", await call(c.url, "eth_getLogs", logParams(tip - 10, tip))));
    } else {
      steps.push({ s: "recent10", ok: null, status: null, code: null, ms: 0, skipped: "not-needed" });
    }
    return { h: c.h, env: c.env, steps };
  }));
  return vdDone(200, { endpoints, subreq: { used, cap: LOGRPC_SUBREQ_CAP } });
}

async function diagVerdict(request, url, env, ctx) {
  /* همیشه اولین خط، پیش از هر بررسیِ دیگری — همان قاعده‌ای که /gt و /ev
     دارند: یک اسکریپتِ کوبنده نباید حتی شکلِ درخواست را هم مجانی بسنجد. */
  if (!rateOk(request, "vd", RL_LIMIT, RL_WINDOW_MS))
    return vdDone(429, { error: "too many requests" }, { "retry-after": "60" });
  if (request.method !== "GET") return vdDone(405, { error: "only GET" });

  // «rpc» هرگز نمی‌تواند با یک mint واقعی قاطی شود — کوتاه‌ترین SOL_MINT
  // معتبر ۳۲ نویسه‌ی base58 است، «rpc» فقط ۳ نویسه. پس این چک باید پیش از
  // chainOf/parsing بیاید؛ وگرنه این مسیر فقط با ۴۰۰ («bad address») رد
  // می‌شد، نه با پاسخِ خودِ probe. همان سطلِ نرخِ «vd» بالا برایش هم سنجیده
  // شده، پس این مسیر نمی‌تواند سهمیه‌ای جدا از /vd/<mint> بخورد.
  if (url.pathname === "/vd/rpc") return diagVerdictRpc(env);

  /* GET /vd/v4/<address> — دقیقاً پیش از پارسِ آدرسِ خودِ /vd/<address> زیر،
     درست مثلِ /vd/rpc بالا؛ وگرنه «v4/<address>» خودش به‌عنوانِ یک آدرسِ
     بدشکل رد می‌شد و هرگز به این تشخیص نمی‌رسید. همان سطلِ نرخِ «vd» (بالای
     همین تابع) را می‌خورد، سطلِ جداگانه ندارد. */
  if (url.pathname.startsWith("/vd/v4/")) return diagVerdictV4(url, env);

  /* GET /vd/logrpc — کدام RPC از *داخلِ کلادفلر* eth_getLogs را جواب می‌دهد.
     همان سطلِ نرخِ «vd» بالا را می‌خورد. */
  if (url.pathname === "/vd/logrpc") return diagLogRpc(env);

  /* GET /vd/passes — رونوشتِ خواندنیِ لاگِ گذر (report:passlog)، فقط برای
     اندازه‌گیری. متد/سطلِ نرخ همین بالای diagVerdict سنجیده شده، دوباره
     تکرار نمی‌شود. بدونِ ZX_KV → passes:[]، نه خطا. */
  if (url.pathname === "/vd/passes") {
    const kv = env && env.ZX_KV;
    const passes = kv ? await readPassLog(kv) : [];
    return vdDone(200, { passes });
  }

  const addr = url.pathname.slice("/vd/".length);
  const chain = chainOf(addr);
  if (chain === null) return vdDone(400, { error: "bad address" });

  const t0 = Date.now();
  if (chain === "solana") {
    // «why» فقط وقتی v واقعاً null باشد چیزی غیرِ undefined است؛ JSON.stringify
    // کلیدی با مقدارِ undefined را خودش حذف می‌کند، پس یک sell/nosell همان
    // شکلِ {v,ms} امروز را بایت‌به‌بایت نگه می‌دارد.
    const { v, why } = await solFetchVerdict(addr, t0 + OG_BUDGET_MS, ctx, env);
    return vdDone(200, { v, ms: Date.now() - t0, why });
  }
  // چرا با ogFetchMetaDetail: پایین‌تر (شاخه‌ی غیرِ probe) metaWhy لازم است
  // تا وقتی خودِ متادیتا نیامد، دلیلش هم گزارش شود، نه فقط internal حدسی.
  // شاخه‌ی ?probe=1 دست‌نخورده همان meta را می‌گیرد، پس رفتارش عوض نمی‌شود.
  const { meta, why: metaWhy } = await ogFetchMetaDetail(addr, env);

  // ?probe=1 — همان سطلِ نرخِ «vd» بالا را می‌خورد (هیچ مسیرِ ارزان‌تری
  // ندارد)، ولی ogFetchVerdict را دور می‌زند: آن تابع از کشِ verdict
  // می‌خواند و در آن می‌نویسد، و یک برخوردِ کش دقیقاً یک verdict بدونِ هیچ
  // جزئیاتِ صرافی‌ای برمی‌گرداند — این ابزار برای همان «کدام صرافی چه
  // گفت» ساخته شده، پس باید مستقیم fetchVerdict را با یک collect تازه صدا
  // بزند، نه از پشتِ کش. هیچ‌چیزی هم در کش نوشته نمی‌شود؛ این یک پروبِ
  // یک‌باره است، نه چیزی که verdictِ بعدیِ همین آدرس را رنگ بزند.
  // ⚠️ اینجا عمداً همچنان verdictِ خامِ fetchVerdict را گزارش می‌کند، نه
  // خروجیِ گیت‌شده‌ی ogFetchVerdict — این یک ابزارِ تشخیصی است، باید نشان
  // بدهد صرافی‌ها واقعاً چه گفتند، نه جوابِ نهایی‌ای که کاربر می‌بیند.
  // covered دقیقاً همان ورودیِ گیت را از بیرون قابلِ‌دیدن می‌کند — کسی روزی
  // این تابع را «تعمیر» نکند تا با /vd هم‌رنگ شود؛ آن هم‌رنگی خودِ این
  // ابزارِ تشخیصی را کور می‌کند.
  if (url.searchParams.get("probe") === "1") {
    const collect = [];
    /* 🔴 کلیدهای واقعیِ ذخیره‌شده *باید* اینجا هم داده شوند. بدونشان این
       ابزار دقیقاً همان چیزی را نمی‌بیند که برای دیدنش هست: مسیرِ واقعی
       (ogFetchVerdict) ردیف‌های `real:` را می‌سازد و این‌جا نمی‌ساخت، پس
       خروجی‌اش شبیهِ «کلیدِ واقعی اصلاً پروب نشد» به‌نظر می‌رسید در حالی که
       هیچ‌چیزی درباره‌اش نمی‌گفت. یک ابزارِ تشخیصی که ورودیِ مسیرِ واقعی را
       ندارد، شاهد نیست.
       v4Keys در پاسخ هم می‌آید تا «هیچ کلیدی ذخیره نشده» از «کلید ذخیره شده
       ولی ردیفش ساخته نشد» قابلِ‌تفکیک باشد — این دو از بیرون یک شکل‌اند. */
    const v4Keys = await readV4Keys(addr, env);
    // whyOut هم اینجا داده می‌شود — فقط مشاهده‌گر، دقیقاً همان الگویی که
    // ogFetchVerdictDetail بالاتر برای خواندنِ why/v4Proof دارد؛ فیلدهای
    // افزوده‌ی why/errName زیر همان observer را به بیرون قابلِ‌دیدن می‌کنند.
    const whyOut = {};
    const v = await fetchVerdict(addr, meta,
      { deadlineAt: t0 + OG_BUDGET_MS, fetchImpl: fetch, collect, rpcs: baseRpcsFor(env), v4Keys, whyOut });
    const covered = await baseVenueCovered(addr, env);
    return vdDone(200, {
      v, ms: Date.now() - t0, venues: collect, covered, v4Keys: v4Keys.length,
      why: whyOut.why, errName: whyOut.errName,
    });
  }

  // ⚠️ ماژولِ Base (worker/verdict.js) حالا واژه‌نامه‌ی بسته‌ی why دارد
  // (VD_BASE_WHY) — این کلید فقط وقتی v واقعاً null است در پاسخ می‌آید
  // (undefined پایین‌تر با JSON.stringify حذف می‌شود، دقیقاً همان ترفندی که
  // شاخه‌ی سولانا بالاتر هم دارد)، نه اینکه همیشه یک internal حدسی بگوید.
  // cause هم از همان قاعده پیروی می‌کند: فقط وقتی v واقعاً "nosell" است —
  // یک sell/null همان شکلِ امروز را بایت‌به‌بایت نگه می‌دارد.
  // ret هم دقیقاً همین قاعده را دارد، ولی برعکس: فقط کنارِ v==="sell" —
  // چقدر از صد دلارِ فرضی برگشت، نه اینکه فروش رخ داد یا نه؛ nosell/null
  // هرگز ret نمی‌گیرد.
  const { v, why, cause, ret } = await ogFetchVerdictDetail(addr, meta, t0 + OG_BUDGET_MS, env, ctx, metaWhy);
  return vdDone(200, {
    v, ms: Date.now() - t0,
    why: v === null ? why : undefined,
    cause: v === "nosell" ? cause : undefined,
    ret: v === "sell" && typeof ret === "number" ? ret : undefined,
  });
}

/* =====================================================================
   robots.txt — چه کسی اجازه دارد این سایت را بخواند
   =====================================================================
   ۷ سپتامبر ۲۰۲۶: `zaexa.com/robots.txt` هیچ‌وقت مالِ ما نبود. کلادفلر
   نسخه‌ی «مدیریت‌شده»ی خودش را سرو می‌کرد و آن نسخه ClaudeBot، GPTBot،
   CCBot، Google-Extended، Amazonbot، Applebot-Extended، Bytespider و
   meta-externalagent را با `Disallow: /` می‌بست.

   چرا این برای *این* سایت مهم است و برای خیلی سایت‌ها نیست: کاربرِ Zaexa
   دقیقاً همان کسی است که از یک دستیار می‌پرسد «چطور بفهمم این توکن
   هانی‌پات است؟». اگر دستیارها اجازه‌ی خواندنِ ما را نداشته باشند، آن
   سؤال با ما جواب داده نمی‌شود — بی‌آنکه هیچ‌جا خطایی دیده شود. این یک
   تصمیمِ محصولی است که کسی نگرفته بود، فقط پیش‌فرضِ یک پنل بود.

   ⚠️ سرو کردنش از این‌جا لزوماً نسخه‌ی مدیریت‌شده را کنار نمی‌زند: آن
   قابلیت در سطحِ زون کار می‌کند و ممکن است جلوتر از Worker بنشیند. پس
   بعد از انتشار باید *سنجیده* شود، نه فرض:
     curl -s https://zaexa.com/robots.txt | head -20
   اگر باز هم «Cloudflare Managed content» دیدی، خاموش‌کردنش در داشبورد
   لازم است و این فایل به‌تنهایی کافی نیست.

   `Content-Signal` دو تا را باز می‌گذارد و یکی را نه، و این تفکیک عمدی است:
   • `search=yes` و `ai-input=yes` — خوانده‌شدن و جواب‌داده‌شدن **هدفِ** این
     سایت است. کاربرِ ما همان کسی است که از یک دستیار می‌پرسد «این توکن
     هانی‌پات است؟»؛ نادیدنی‌بودن برای دستیارها یعنی آن سؤال بدونِ ما جواب
     داده شود.
   • `ai-train=no` — چون README همین مخزن صریح می‌گوید «It is not open
     source: no license is granted to copy, modify, or redistribute it»
     (و عمداً هیچ فایل LICENSE‌ای هم ندارد). اجازه‌ی آموزش دادن با آن جمله
     در تناقض بود. تصمیمِ صاحب سایت، ۷ سپتامبر ۲۰۲۶.
   ⚠️ خواندن برای جواب‌دادن با برداشتن برای آموزش یکی نیست؛ این خط همان
   مرز است و نگهبانش در worker/test.mjs پینش می‌کند. */
export const ROBOTS_TXT = [
  "# Zaexa — a DEX aggregator with an exit check. Read us; that is the point.",
  "",
  "User-agent: *",
  "Content-Signal: search=yes,ai-input=yes,ai-train=no",
  "Allow: /",
  "",
  "Sitemap: https://zaexa.com/sitemap.xml",
  "",
].join("\n");

function robotsResponse() {
  return new Response(ROBOTS_TXT, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

/* sitemap.xml — سه صفحه‌ی همیشگی («/»، «/app» و «/pairs» — تا ۲۱ سپتامبر
   ۲۰۲۶ هیچ‌جای سایت به /pairs لینک نداشت و اینجا هم نبود، پس هیچ‌کس پیدایش
   نمی‌کرد) به‌علاوه‌ی صفحه‌های
   `/t/<آدرس>` — همان دنباله‌ی بلندِ جست‌وجو («فلان توکن هانی‌پات است؟»،
   «می‌شود فلان را فروخت؟») که سرورساید با عنوان و رقمِ واقعیِ همان توکن
   رندر می‌شود، پس واقعاً قابلِ ایندکس است؛ فقط تا امروز هیچ‌جا فهرست
   نمی‌شد. فهرستِ دستیِ «توکن‌های مهم» دقیقاً همان چیزی است که در این پروژه
   بارها بی‌صدا drift کرده، پس منبعِ توکن‌ها خودِ GeckoTerminal است:
   استخرهای Base به‌ترتیبِ حجمِ ۲۴ساعته، از رویِ همان پراکسیِ کلیددار که
   proxyGt/ogFetchMeta هم به کار می‌برند.

   ⚠️ چرا صفحه‌های ۱ تا ۳ (حداکثر ۶۰ استخر، حداکثر ۳ فراخوانیِ بالادست) و نه
   مثلاً ۵۰۰۰ آدرس: ۵۰۰۰ یعنی ۲۵۰ فراخوانیِ بالادست روی یک کلیدِ مشترک، برای
   فایلی که کراولرها مکرراً دوباره می‌گیرند — دقیقاً همان مصرفی که proxyGt
   برای *کاربر* حل کرده بود را اینجا خودمان بازتولید می‌کردیم. */
const SITEMAP_TOKEN_PAGES = 3;
const SITEMAP_TOKEN_CAP = 50;

/* میزبانِ خصوصیِ کشِ سایت‌مپ — دقیقاً همان تکنیکِ VD_CACHE_HOST بالاتر: هیچ‌جا
   واقعاً درخواست نمی‌رود، فقط کلیدِ Cache API است، و عمداً از میزبانِ واقعیِ
   بالادست جداست تا کلیدش هرگز با یک ورودیِ کشِ /gt برخورد نکند. */
const SITEMAP_CACHE_HOST = "zaexa-sitemap.internal";
const SITEMAP_CACHE_PATH = "/tokens";

/* یک صفحه از networks/base/pools — بدونِ هیچ فرضی روی شکلِ پاسخ. اگر بدنه
   آرایه‌ی data نداشته باشد یعنی «قابلِ استفاده نیست»، دقیقاً هم‌ردیفِ ۴۰۴/۵۰۰:
   کالر باید هر دو را یک‌جور شکست بداند. */
async function fetchSitemapPoolsPage(page, env) {
  const key = (env && typeof env.CG_KEY === "string" && env.CG_KEY) || "";
  const target = (key ? UPSTREAM_KEYED : UPSTREAM_FREE) +
    "/networks/base/pools?page=" + page;
  const h = { accept: "application/json" };
  if (key) h["x-cg-demo-api-key"] = key;
  const up = await fetch(target, { headers: h });
  if (!up.ok) throw new Error("sitemap upstream status " + up.status);
  const body = await up.json();
  if (!body || !Array.isArray(body.data)) throw new Error("sitemap upstream: unusable body");
  return body.data;
}

/* یک ردیفِ استخر → آدرسِ توکنِ پایه، یا null. هر فیلد «نامعتمد» است — از
   بالادستی می‌آید که کنترلش دستِ ما نیست — پس یک ردیفِ عجیب فقط خودش را رد
   می‌کند، نه کل فایل را می‌شکند. */
function sitemapTokenFromPool(row) {
  try {
    const rawId = row && row.relationships && row.relationships.base_token &&
      row.relationships.base_token.data && row.relationships.base_token.data.id;
    if (typeof rawId !== "string") return null;
    const addr = rawId.replace(/^base_/, "");
    if (chainOf(addr) !== "base") return null; // شکلِ دیگر یا زنجیره‌ی دیگر → دور ریخته می‌شود، نه گزارش
    /* 🔴 آدرسِ صفر یک توکن نیست و صفحه‌اش هیچ‌وقت چیزی برای نشان‌دادن ندارد.
       یک سایت‌مپِ واقعی یک بار همین را لیست کرد. newPoolRowToToken در
       worker/report.js از همان روز ردش می‌کند؛ این مسیر جا مانده بود، و
       جاماندنش دیده نمی‌شد چون خروجی‌اش فقط یک آدرسِ اضافه در یک فایلِ XML
       است که هیچ‌کس نمی‌خواندش — تا وقتی یک کراولر بخواند. */
    if (/^0x0{40}$/i.test(addr)) return null;

    // reserve_in_usd گم/غیرِ عددی/۰/منفی → همان «استخری که کسی معامله نمی‌کند»؛
    // Number روی هرکدام از این‌ها (undefined، null، ""، رشته‌ی غیرِ عددی) یا
    // NaN می‌دهد یا ۰، پس یک شرط برای همه کافی است.
    const reserve = Number(row && row.attributes && row.attributes.reserve_in_usd);
    if (!Number.isFinite(reserve) || reserve <= 0) return null;

    return addr;
  } catch (e) {
    return null;
  }
}

/* فهرستِ نهاییِ آدرس‌ها، به همان ترتیبی که بالادست داد (حجم‌محور)، بدونِ
   تکرار، سقف‌خورده در SITEMAP_TOKEN_CAP. null یعنی «بالادست قابلِ اعتماد
   نبود» — کالر باید دقیقاً مثلِ یک ۵۰۰/پرتاب رفتار کند، نه مثلِ فهرستِ خالی. */
async function buildSitemapTokens(env) {
  const seen = new Set();
  const tokens = [];
  for (let page = 1; page <= SITEMAP_TOKEN_PAGES; page++) {
    let rows;
    try {
      rows = await fetchSitemapPoolsPage(page, env);
    } catch (e) {
      // اگر همان صفحه‌ی اول شکست بخورد، کل بالادست را خراب فرض کن.
      // اگر صفحه‌ی بعدتری بود، آنچه تا اینجا جمع شده معتبر می‌ماند — فقط
      // ادامه‌ی جمع‌آوری متوقف می‌شود، نه چیزی که تا الان داریم دور ریخته.
      if (tokens.length === 0 && page === 1) return null;
      break;
    }
    for (const row of rows) {
      const addr = sitemapTokenFromPool(row);
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      tokens.push(addr);
    }
  }
  return tokens.slice(0, SITEMAP_TOKEN_CAP);
}

function renderSitemapXml(origin, paths, lastmod) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    paths.map((p) =>
      "<url><loc>" + origin + p + "</loc><lastmod>" + lastmod + "</lastmod></url>"
    ).join("") +
    "</urlset>"
  );
}

/* 🔴 هرگز شکست را کش نکن، هرگز یک سایت‌مپِ شکسته سرو نکن. «/»، «/app» و
   «/pairs» همیشه اول‌اند، هرچه پیش بیاید. توکن‌ها فقط وقتی اضافه می‌شوند که buildSitemapTokens
   واقعاً یک آرایه بدهد (حتی خالی — یعنی بالادست جواب داد ولی چیزِ قابلِ
   استفاده‌ای نداشت)؛ اگر بالادست پرتاب کرد یا ۲۰۰ نداد یا به چیزِ قابلِ فهم
   parse نشد (null)، دقیقاً همان دو مسیرِ ثابت با عمرِ کوتاه برمی‌گردد تا
   درخواستِ بعدی دوباره تلاش کند — نه یک روز کامل بدونِ صفحه‌های توکن. */
async function sitemapResponse(url, env, ctx) {
  const origin = url.origin;
  const staticPaths = ["/", "/app", "/pairs"];
  const lastmod = new Date().toISOString().slice(0, 10);

  const store = (typeof caches !== "undefined" && caches.default) || null;
  const cacheKey = store ? new Request("https://" + SITEMAP_CACHE_HOST + SITEMAP_CACHE_PATH) : null;
  if (store) {
    try {
      const hit = await store.match(cacheKey);
      if (hit) return hit;
    } catch (e) { /* کش خراب = بی‌کش، نه بی‌سایت‌مپ */ }
  }

  let tokens = null;
  try {
    tokens = await buildSitemapTokens(env);
  } catch (e) {
    tokens = null; // هرگز نباید به اینجا برسد (buildSitemapTokens خودش try/catch دارد)، ولی محافظِ آخر باشد
  }
  const ok = Array.isArray(tokens);
  const paths = staticPaths.concat(ok ? tokens.map((a) => "/t/" + a) : []);
  const body = renderSitemapXml(origin, paths, lastmod);

  const headers = {
    "content-type": "application/xml; charset=utf-8",
    // موفق: ۲۴ ساعت، لبه نگهش می‌دارد. ناموفق: عمرِ کوتاه، تا درخواستِ بعدی
    // دوباره امتحان کند — نه یک روزِ کامل با فقط دو URL.
    "cache-control": ok ? "public, max-age=86400" : "public, max-age=300",
  };
  const res = new Response(body, { headers });

  if (ok && store) {
    const stash = new Response(body, { headers });
    const put = store.put(cacheKey, stash);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  }
  return res;
}

/* =====================================================================
   /report/<...>.json و /pairs.json — دو نمای همان یک انبار
   =====================================================================
   worker/report.js تصمیم می‌گیرد سند چه شکلی است؛ اینجا فقط مسیر و سقفِ
   کش و رفتارِ «بدونِ KV نشکن» هستند. هر سه مسیر بستهٔ نرخِ خودشان را دارند
   («report»، جدا از ev/gt/vd/og) تا کاوش روی این سه سهمیهٔ بقیه را نخورد. */

async function reportDocFor(env, dateStr) {
  const kv = env && env.ZX_KV;
  if (!kv) return emptyReportDoc(dateStr); // بایندینگ نبود → سایت نباید بشکند، فقط سندِ خالی
  try {
    const raw = await kv.get(reportKey(dateStr));
    if (typeof raw !== "string") return emptyReportDoc(dateStr);
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rows)) return emptyReportDoc(dateStr);
    // گاردِ زمانِ انتشار (publishGuardRow در worker/report.js) — انبار دست نمی‌خورد.
    return { ...parsed, rows: parsed.rows.map((r) => publishGuardRow(r, undefined)) };
  } catch (e) {
    // 🔴 خواندنِ KV پرتاب کرد یا JSON خراب بود — همان «سندِ خالی»، هرگز ۵۰۰
    return emptyReportDoc(dateStr);
  }
}

/* پیوستِ follow/recheck در زمانِ خواندن — حلقه‌ی pairs:base:latest فقط یک
   بار نوشته می‌شود و هرگز follow (یک ساعت بعد، فقط در سندِ روزانه) یا
   recheck (رِی‌چکِ ردیفِ نامعلوم، همان‌جا) نمی‌گیرد. این تابع خودِ حلقه را
   دست‌نخورده می‌گذارد و فقط در پاسخ این دو کلید را از سندِ روزانه قرض
   می‌گیرد — امروز و دیروز (UTC)، امروز برنده وقتی هر دو همان آدرس را
   دارند. reportDocFor هرگز پرتاب نمی‌کند و هر شکستِ خواندن/پارس را به
   سندِ خالی تخت می‌کند، پس هر شکست اینجا فقط یعنی «چیزی برای قرض‌گرفتن
   نیست»، نه شکستِ کل تابع — ردیف‌های حلقه همان می‌مانند که بودند. */
async function pairsRowsFor(env, chain) {
  // سولانا مسیرِ جدایی دارد (سندهای روزانه، نه حلقه‌ی base) — مسیرِ Base
  // زیر همان‌طور که بود دست‌نخورده می‌ماند.
  if (chain === "solana") return pairsRowsForSolana(env);
  const kv = env && env.ZX_KV;
  if (!kv) return [];
  let ringRows;
  try {
    const raw = await kv.get(PAIRS_KEY_BASE);
    if (typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    ringRows = Array.isArray(parsed) ? parsed.map((r) => publishGuardRow(r, "base")) : [];
  } catch (e) {
    return [];
  }

  const nowMs = Date.now();
  const todayStr = utcDateOf(nowMs);
  const yesterdayStr = utcDateOf(nowMs - 86400000);
  const [todayDoc, yesterdayDoc] = await Promise.all([
    reportDocFor(env, todayStr),
    reportDocFor(env, yesterdayStr),
  ]);

  // نقشه‌ی آدرس → ردیفِ سندِ روزانه — دیروز اول، امروز دوم، پس امروز
  // (اگر همان آدرس را داشته باشد) برنده می‌شود.
  const byAddr = new Map();
  for (const r of (yesterdayDoc && Array.isArray(yesterdayDoc.rows) ? yesterdayDoc.rows : [])) {
    if (r && typeof r.address === "string") byAddr.set(r.address, r);
  }
  for (const r of (todayDoc && Array.isArray(todayDoc.rows) ? todayDoc.rows : [])) {
    if (r && typeof r.address === "string") byAddr.set(r.address, r);
  }
  if (byAddr.size === 0) return ringRows;

  return ringRows.map((ringRow) => {
    if (!ringRow || typeof ringRow.address !== "string" || !byAddr.has(ringRow.address)) return ringRow;
    const docRow = byAddr.get(ringRow.address);
    // 🔴 همیشه یک کپی — هیچ کلیدِ دیگری از ringRow عوض نمی‌شود، هیچ کلیدِ
    // دیگری از docRow قرض گرفته نمی‌شود.
    const out = { ...ringRow };

    const follow = followForRow(ringRow.v, docRow.follow);
    if (follow !== undefined && typeof docRow.followAt === "string" &&
        !Number.isNaN(Date.parse(docRow.followAt))) {
      out.follow = follow;
      out.followAt = docRow.followAt;
    }

    const recheck = recheckForRow(ringRow.v, docRow.recheck);
    if (recheck !== undefined && typeof docRow.recheckAt === "string" &&
        !Number.isNaN(Date.parse(docRow.recheckAt))) {
      out.recheck = recheck;
      out.recheckAt = docRow.recheckAt;
      if (recheck === "nosell") {
        const recheckCause = causeForRow("nosell", docRow.recheckCause);
        if (recheckCause !== undefined) out.recheckCause = recheckCause;
      }
    }

    return out;
  });
}

/* ردیف‌های سولانا برای /pairs.json?chain=solana — بر خلافِ Base هیچ حلقه‌ی
   جداگانه‌ای برای سولانا نداریم، پس مستقیماً از همان دو سندِ روزانه
   (امروز و دیروز UTC) می‌خوانیم، همان دو reportDocFor بالا. فقط ردیف‌هایی
   با chain === "solana" و آدرسِ رشته‌ای برداشته می‌شوند؛ یکتاسازی بر
   اساسِ آدرس با برنده‌بودنِ امروز (دیروز اول نوشته می‌شود، امروز رویش
   می‌نشیند)، سپس مرتب‌سازیِ نزولی بر اساسِ checkedAt — ردیف‌هایی که
   checkedAt قابلِ‌پارس ندارند آخر صف می‌روند، نه اول یا وسط. سقف همان
   REPORT_PAIRS_CAP است که حلقه‌ی Base هم دارد. هر ردیفِ خروجی یک کپیِ
   دست‌نخورده است — هیچ کلیدی افزوده/کم نمی‌شود، برخلافِ پیوستِ follow/
   recheck که فقط برای Base معنا دارد. */
async function pairsRowsForSolana(env) {
  const kv = env && env.ZX_KV;
  if (!kv) return [];

  const nowMs = Date.now();
  const todayStr = utcDateOf(nowMs);
  const yesterdayStr = utcDateOf(nowMs - 86400000);
  const [todayDoc, yesterdayDoc] = await Promise.all([
    reportDocFor(env, todayStr),
    reportDocFor(env, yesterdayStr),
  ]);

  const byAddr = new Map();
  for (const r of (yesterdayDoc && Array.isArray(yesterdayDoc.rows) ? yesterdayDoc.rows : [])) {
    if (r && r.chain === "solana" && typeof r.address === "string") byAddr.set(r.address, r);
  }
  for (const r of (todayDoc && Array.isArray(todayDoc.rows) ? todayDoc.rows : [])) {
    if (r && r.chain === "solana" && typeof r.address === "string") byAddr.set(r.address, r);
  }

  const rows = Array.from(byAddr.values());
  rows.sort((a, b) => {
    const at = Date.parse(a && a.checkedAt);
    const bt = Date.parse(b && b.checkedAt);
    const aOk = !Number.isNaN(at);
    const bOk = !Number.isNaN(bt);
    if (aOk && bOk) return bt - at;
    if (aOk) return -1; // فقط a قابلِ‌پارس است → a جلوتر
    if (bOk) return 1;  // فقط b قابلِ‌پارس است → b جلوتر
    return 0;            // هیچ‌کدام قابلِ‌پارس نیستند → ترتیبِ نسبی دست‌نخورده
  });

  return rows.slice(0, REPORT_PAIRS_CAP).map((r) => ({ ...r }));
}

async function reportRoute(request, url, env) {
  // همیشه اولین خط — همان قاعده‌ای که /ev و /gt و /vd دارند.
  if (!rateOk(request, "report", RL_LIMIT, RL_WINDOW_MS))
    return vdDone(429, { error: "too many requests" }, { "retry-after": "60" });
  if (request.method !== "GET") return vdDone(405, { error: "only GET" });

  const rest = url.pathname.slice("/report/".length);
  const isToday = rest === "today.json";
  const datePart = rest.endsWith(".json") ? rest.slice(0, -".json".length) : rest;
  if (!isToday && !REPORT_DATE_RE.test(datePart)) return vdDone(400, { error: "bad date" });

  const dateStr = isToday ? utcDateOf(Date.now()) : datePart;
  const doc = await reportDocFor(env, dateStr);
  const live = dateStr >= utcDateOf(Date.now());
  // امروز زود عوض می‌شود (اجرای ساعتی بعدی)، روزِ گذشته دیگر هرگز عوض
  // نمی‌شود — عمرِ کش هم همین تفاوت را باید نشان بدهد. تاریخِ صریحِ امروز هم
  // مثل today.json همین رفتار را می‌گیرد.
  const cacheControl = live ? "public, max-age=300" : "public, max-age=86400";
  // 🔴 store فقط از بیرون دیده می‌شود، هرگز در KV نمی‌نشیند — یک بایندینگِ
  // بسته‌شده-ولی-خالی و یک ZX_KV کاملاً غایب امروز پاسخِ یکسان می‌دهند، و از
  // بیرون هیچ راهی برای فرق‌گذاشتنشان نیست. rows:[] با store:true یعنی
  // «هنوز چیزی جمع نشده»؛ با store:false یعنی «خودِ بایندینگ هرگز نرسید».
  return vdDone(200, { ...doc, store: !!(env && env.ZX_KV) }, { "cache-control": cacheControl });
}

/* GET /report/<...>.txt — همان انبار، نمای متنِ ساده برای پُستِ عمومی.
   🔴 عمداً reportDocFor را دوباره به‌کار نمی‌گیرد: آن تابع «نبودِ بایندینگ»،
   «پرتاب» و «کلیدِ غایب» را همه در یک سندِ خالی تخت می‌کند — دقیقاً همان
   قاطی‌کردنی که این مسیر نباید بکند (بدونِ KV باید ۵۰۳ بدهد، نه یک متنِ
   خالیِ ۲۰۰). */
async function reportTextRoute(request, url, env) {
  if (!rateOk(request, "report", RL_LIMIT, RL_WINDOW_MS))
    return textDone(429, "too many requests\n", { "retry-after": "60" });
  if (request.method !== "GET") return textDone(405, "only GET\n");

  const rest = url.pathname.slice("/report/".length);
  const isToday = rest === "today.txt";
  const datePart = rest.endsWith(".txt") ? rest.slice(0, -".txt".length) : rest;
  if (!isToday && !REPORT_DATE_RE.test(datePart)) return textDone(400, "bad date\n");

  const dateStr = isToday ? utcDateOf(Date.now()) : datePart;
  // پیش از هر چیز، حتی پیش از لمسِ KV — report:2026-09-07 هنوز ردیف‌های
  // nosellِ نادرست دارد.
  if (dateStr < REPORT_TEXT_FIRST_DATE)
    return textDone(404, "no text report before " + REPORT_TEXT_FIRST_DATE + "\n");

  const kv = env && env.ZX_KV;
  if (!kv) return textDone(503, "report store unavailable\n");

  let raw;
  try {
    raw = await kv.get(reportKey(dateStr));
  } catch (e) {
    return textDone(503, "report store unavailable\n");
  }
  if (typeof raw !== "string") return textDone(404, "no report for " + dateStr + " yet\n");

  let text;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.date !== dateStr) return textDone(503, "report unreadable\n");
    if (Array.isArray(parsed.rows)) parsed.rows = parsed.rows.map((r) => publishGuardRow(r, undefined));
    text = reportText(parsed, { solana: true });
    if (text === null) return textDone(503, "report unreadable\n");
  } catch (e) {
    return textDone(503, "report unreadable\n");
  }

  // همان تفاوتِ عمرِ کشِ reportRoute: امروز زود عوض می‌شود، روزِ گذشته هرگز —
  // و تاریخِ صریحِ امروز هم مثل today.txt همین رفتار را می‌گیرد.
  const live = dateStr >= utcDateOf(Date.now());
  const cacheControl = live ? "public, max-age=300" : "public, max-age=86400";
  return textDone(200, text, { "cache-control": cacheControl });
}

async function pairsRoute(request, url, env) {
  if (!rateOk(request, "report", RL_LIMIT, RL_WINDOW_MS))
    return vdDone(429, { error: "too many requests" }, { "retry-after": "60" });
  if (request.method !== "GET") return vdDone(405, { error: "only GET" });

  const chain = url.searchParams.get("chain") || "base";
  if (chain !== "base" && chain !== "solana") return vdDone(400, { error: "bad chain" });

  const rows = await pairsRowsFor(env, chain);
  // 🔴 همان دلیلِ reportRoute: store فقط می‌گوید بایندینگ حاضر است یا نه —
  // یک حلقه‌ی خالی به‌تنهایی این را نمی‌گوید.
  return vdDone(200, { chain, rows, store: !!(env && env.ZX_KV) }, { "cache-control": "public, max-age=300" });
}

/* بدنه‌ی scheduled — تابعِ جداگانه تا worker/test.mjs بتواند بدونِ ساختنِ
   یک event واقعیِ کرون آن را صدا بزند، همان الگویی که sitemapResponse و
   diagVerdict برای تست‌پذیریِ handlerهای دیگر دنبال می‌کنند. */
/* =====================================================================
   متر ساب‌ریکوئست — فقط اندازه‌گیری، هیچ رفتاری از گذرِ گزارش عوض نمی‌شود
   =====================================================================
   اندازه‌گیریِ زنده‌ی ۱۸:۱۷ UTC نشان داد گذرِ ساعتی به سقفِ ساب‌ریکوئستِ
   Worker می‌خورد (capProbe:"cap")، ولی معلوم نبود *کدام* مرحله هزینه‌بر
   است. این متر دقیقاً همان چیزی را می‌شمارد که سقف را می‌سوزاند: هر
   fetch واقعی (زیرِ hostname مقصد، هرگز مسیر/کوئری — یک راز می‌تواند در
   مسیر بنشیند، مثلِ URLِ RPCِ سولانا)، هر عملیاتِ Cache API، و هر عملیاتِ
   KV — همه زیرِ برچسبِ «الان کدام مرحله‌ایم».

   🔴 شمارش دقیقِ همان چیزی نیست که واقعاً روی زیرساختِ کلادفلر اتفاق
   می‌افتد — این یک بالاسری امنِ عمدی است (پایین‌تر توضیح داده شده)، نه
   یک ادعای دقیقِ صددرصد. */
function makeSubMeter() {
  // fetchِ واقعی همین الان (پیش از اینکه کالر globalThis.fetch را با
  // meter.fetch عوض کند) — وگرنه meter.fetch خودش را صدا می‌زد و هرگز به
  // شبکه نمی‌رسید.
  const realFetch = globalThis.fetch;

  let stage_ = "?";
  let total = 0;
  const byStage = {};
  const byHost = {};
  let cacheN = 0;
  let cacheSkipN = 0;
  let kvN = 0;
  let fetchN = 0;
  const baseTokens = [];
  const solTokens = [];
  let tokenBase = null;

  // سقفِ ساب‌ریکوئست — capHit/capAt. این کلاس فقط از رویِ متنِ پیام سنجیده
  // می‌شود چون خودِ پلتفرم برایش هیچ کدِ جداگانه‌ای نمی‌دهد (همان کلاسی که
  // classifyCapProbe در worker/report.js با /too many subrequests/i تشخیص
  // می‌دهد)؛ capProbe در انتهای گذر همان کنترلِ مثبتِ این تشخیص است. فقط
  // اولین بار ثبت می‌شود (capAt دیگر جابه‌جا نمی‌شود)، و پیام هرگز اینجا
  // بلعیده نمی‌شود — نوتِ زیر همیشه پیام را بدونِ دست‌کاری دوباره پرتاب
  // می‌کند، این تابع فقط رصد می‌کند.
  let capHit_ = false;
  let capAt_ = null;
  function noteThrow(e) {
    if (capHit_) return; // فقط اولین ضربه
    if (e && typeof e.message === "string" && /too many subrequests/i.test(e.message)) {
      capHit_ = true;
      capAt_ = { ops: total, fetches: fetchN, cache: cacheN };
    }
  }

  function bumpStage() {
    total++;
    byStage[stage_] = (byStage[stage_] || 0) + 1;
  }

  return {
    // ⚠️ همیشه fetchِ واقعی را صدا می‌زند، هرگز globalThis.fetch را (که
    // ممکن است خودِ همین تابع باشد) — شمارش هیچ‌وقت نباید حلقه بزند.
    async fetch(input, init) {
      let host = "?";
      try {
        const u = typeof input === "string" ? input : (input && input.url);
        host = new URL(u).hostname;
      } catch (e) {
        host = "?"; // پارسِ URL شکست خورد → فقط زیرِ «؟»، هرگز چیزِ خامِ ورودی
      }
      bumpStage();
      byHost[host] = (byHost[host] || 0) + 1;
      fetchN++;
      try {
        return await realFetch(input, init);
      } catch (e) {
        noteThrow(e); // پیام دست‌نخورده دوباره پرتاب می‌شود؛ این فقط رصد می‌کند
        throw e;
      }
    },
    // فقط برای فراخوانیِ بیرونی (کالرِ cache/kv که خودِ عملیات را await
    // می‌کند و خطایش را می‌گیرد) — همان تشخیصی که fetch بالا رویِ خودش دارد.
    noteThrow,
    isCapHit() { return capHit_; },
    get capAt() { return capAt_; },
    stage(name) {
      // 🔴 فقط از REPORT_METER_STAGES — یک نامِ ناشناخته گذرِ آینده را
      // نمی‌شکند، فقط زیرِ همان نامِ دست‌ساز می‌نشیند (هنوز یک عدد است، نه
      // یک رشته‌ی دلخواهِ کاربر، پس ریسکِ نشتِ داده‌ای ندارد).
      stage_ = typeof name === "string" && name ? name : "?";
    },
    tokenStart() { tokenBase = total; },
    tokenEnd() {
      const delta = total - (tokenBase === null ? total : tokenBase);
      tokenBase = null;
      if (stage_ === "base-token") baseTokens.push(delta);
      else if (stage_ === "sol-token") solTokens.push(delta);
    },
    // Cache API — caches.default.match/put را wrap می‌کند (پایین‌تر، در
    // scheduledReportPass)؛ تحتِ یک سطلِ ثابتِ «cache»، نه hostname واقعی.
    cacheOp() {
      bumpStage();
      cacheN++;
    },
    // Cache API خاموش است (پایین‌تر، در scheduledReportPass) — این فقط
    // شمارش می‌کند که تلاش برای کش وجود داشت، هرگز bumpStage را صدا
    // نمی‌زند و به total/byStage/byHost دست نمی‌زند: یک عملیاتِ رد‌شده
    // یک ساب‌ریکوئستِ واقعی نیست.
    cacheSkip() {
      cacheSkipN++;
    },
    // KV — همان الگو، تحتِ یک سطلِ ثابتِ «kv». نامِ دومِ متفاوت (نه
    // cacheOp دوباره) تا شمارشِ cache/kv هرگز با هم قاطی نشود.
    kvOp() {
      bumpStage();
      kvN++;
    },
    // رونوشتِ فقط-خواندنی برای نشستن در passRecord — فقط عدد/hostname/نامِ
    // مرحله، هرگز مسیر/کوئری/کلید.
    snapshot() {
      return {
        total,
        byStage: { ...byStage },
        byHost: { ...byHost },
        cache: cacheN,
        cacheSkipped: cacheSkipN,
        kv: kvN,
        baseTokens: baseTokens.slice(),
        solTokens: solTokens.slice(),
      };
    },
  };
}

/* پوششِ نازکِ get/put/list رویِ env.ZX_KV — فقط شمارش، هرگز نتیجه را عوض
   نمی‌کند (همان مقدارِ برگشتی/پرتابِ خودِ kv بدونِ دست‌کاری رد می‌شود). */
function meterKv(kv, meter) {
  if (!kv || !meter) return kv;
  return {
    get: (...args) => { meter.kvOp(); return kv.get(...args); },
    put: (...args) => { meter.kvOp(); return kv.put(...args); },
    list: (...args) => { meter.kvOp(); return kv.list(...args); },
  };
}

async function scheduledReportPass(env, ctx, opts) {
  try {
    // بدونِ KV، حتی یک تماسِ بالادست هم روا نیست — همان گاردِ اولِ
    // runReportPass، اینجا هم پیش از ساختنِ fetchPools تکرار می‌شود.
    if (!env || !env.ZX_KV) return { checked: 0, added: 0 };

    /* متر ساب‌ریکوئست — برای *هر* اجرا (چه کرونِ ساعتی چه /report/run)
       ساخته می‌شود. globalThis.fetch فقط برای طولِ همین گذر جایگزین
       می‌شود و در finally همیشه برمی‌گردد — حتی وقتی یک مرحله در وسطِ راه
       throw کند. این جایگزینی خودِ رفتارِ هیچ fetchی را عوض نمی‌کند
       (meter.fetch همان fetchِ واقعی را صدا می‌زند)، فقط رهگیری‌اش می‌کند.
       ⚠️ این اجرای زمان‌بندی‌شده «درخواستِ خودش» است؛ درخواست‌های هم‌زمانِ
       دیگر در همین ایزوله (اگر باشند) هم می‌توانند از همین globalThis.fetch
       جایگزین‌شده رد شوند و زیرِ همین شمارش بنشینند — پس عددها یک بالاسری
       هستند، نه یک اندازه‌گیریِ دقیقِ ایزوله‌شده. برای بودجه‌بندی این طرفِ
       امن است: کم‌شماری خطرناک‌تر از بیش‌شماری بود.

       🔴 Cache API در طولِ همین گذر کاملاً خاموش است — caches.default.match
       هیچ‌وقت واقعاً صدا زده نمی‌شود، فقط undefined برمی‌گرداند، و .put هم
       هیچ‌وقت واقعاً چیزی نمی‌نویسد. دلیل: اندازه‌گیریِ زنده نشان داد ۱۵ از
       ۵۱ ساب‌ریکوئستِ یک گذر عملیاتِ Cache API بودند، و کلادفلر همین
       عملیات‌ها را هم جزوِ سقفِ ۵۰تایی می‌شمرد — درحالی‌که کش تقریباً همیشه
       برای توکن‌های تازه خالی است (یک توکنِ تازه‌کشف‌شده هیچ‌وقت از قبل کش
       نشده)، پس آن ۱۵ تماس تقریباً همیشه فقط برای رسیدن به یک miss بودند.
       خاموش کردنش یعنی همان بودجه برای فالوآپ/رِی‌چک/سولانا می‌ماند.
       ⚠️ یک درخواستِ هم‌زمان در همین ایزوله (اگر باشد) هم در طولِ گذر کش
       را میس می‌کند و رویش نمی‌نویسد — طرفِ امن: فقط یعنی آن درخواست
       کارِ تازه انجام می‌دهد، هرگز یک حکمِ کهنه/باطل نمی‌بیند.

       🔴 passPoolsMemo (بالاترِ همین فایل، کنارِ fetchBaseTokenPoolsRaw) هم
       دقیقاً همین‌جا زنده می‌شود: چرا لازم شد — یک توکنِ v4 که در همین گذر
       به "nosell" خام می‌رسد، هم از رویِ ایندکسِ کلیدِ واقعی (fetchV4Pools)
       هم از رویِ گاردِ پوشش (baseVenueCoveredDetail) دقیقاً همان یک آدرس را
       از pools بالادست می‌پرسید — همان جواب، دوبار. فقط موفقیت‌ها حافظه
       می‌شوند (یک ۴۲۹/تایم‌اوتِ گذرا باید دوباره واقعاً پرسیده شود)، و این
       حافظه فقط عمرِ همین گذر را دارد — درست مثلِ globalThis.fetch بالا،
       در همان finally پایین‌تر به null برمی‌گردد. همان احتیاطِ هم‌زمانی هم
       اینجا صادق است: یک درخواستِ هم‌زمان در همین ایزوله (اگر باشد) هم
       می‌تواند از همین Map بخواند — یعنی جوابی که می‌بیند حداکثر یک گذر
       کهنه است، هرگز یک حکمِ باطل؛ همان جوابِ بالادست، فقط یک‌بار پرسیده‌شده. */
    const meter = makeSubMeter();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = meter.fetch;
    passPoolsMemo = new Map();
    const cacheStore = (typeof caches !== "undefined" && caches.default) || null;
    const originalCacheMatch = cacheStore ? cacheStore.match : null;
    const originalCachePut = cacheStore ? cacheStore.put : null;
    if (cacheStore) {
      cacheStore.match = async () => {
        meter.cacheSkip();
        return undefined;
      };
      cacheStore.put = async () => {
        meter.cacheSkip();
      };
    }

    try {
      return await scheduledReportPassInner(env, ctx, opts, meter);
    } finally {
      globalThis.fetch = originalFetch;
      passPoolsMemo = null;
      if (cacheStore) {
        cacheStore.match = originalCacheMatch;
        cacheStore.put = originalCachePut;
      }
    }
  } catch (e) {
    return { checked: 0, added: 0 }; // یک اجرای زمان‌بندی‌شده هرگز نباید پرتاب کند
  }
}

// بدنه‌ی واقعیِ گذر — جدا از scheduledReportPass تا سیم‌کشیِ متر (بالا) و
// خودِ منطقِ گذر (اینجا) قاطی نشوند؛ همان تقسیمِ مسئولیتی که خودِ
// runReportPass با kv/fetchPools/... تزریقی رعایت می‌کند.
async function scheduledReportPassInner(env, ctx, opts, meter) {
  try {
    const fetchPools = async () => {
      try {
        const key = (env && typeof env.CG_KEY === "string" && env.CG_KEY) || "";
        const target = (key ? UPSTREAM_KEYED : UPSTREAM_FREE) + "/networks/base/new_pools";
        const h = { accept: "application/json" };
        if (key) h["x-cg-demo-api-key"] = key;
        const up = await fetch(target, { headers: h });
        if (!up.ok) return [];
        const body = await up.json();
        if (!body || !Array.isArray(body.data)) return [];
        return body.data;
      } catch (e) {
        return []; // همان قاعده‌ی fetchSitemapPoolsPage: بالادستِ نامعتبر یعنی «چیزی نداریم»
      }
    };

    /* همان کلید/هدر/قاعده‌ی fetchPools بالا، ولی برای سولانا و دو صفحه: امروز
       اندازه‌گیری شد که صفحه‌ی اول هیچ استخری بالای آستانه‌ی رزرو نداشت و
       سه‌تای واجدِ شرط همه در صفحه‌ی دوم بودند — پس بدونِ صفحه‌ی دوم این پا
       عملاً همیشه خالی می‌ماند. هر صفحه try/catchِ خودش را دارد؛ شکستِ یکی
       فقط یعنی هرچه صفحه‌ی دیگر داد، نه شکستِ کلِ fetchPoolsSol. */
    const fetchPoolsSol = async () => {
      const key = (env && typeof env.CG_KEY === "string" && env.CG_KEY) || "";
      const h = { accept: "application/json" };
      if (key) h["x-cg-demo-api-key"] = key;
      const base = (key ? UPSTREAM_KEYED : UPSTREAM_FREE) + "/networks/solana/new_pools";
      const fetchPage = async (target) => {
        try {
          const up = await fetch(target, { headers: h });
          if (!up.ok) return [];
          const body = await up.json();
          if (!body || !Array.isArray(body.data)) return [];
          return body.data;
        } catch (e) {
          return [];
        }
      };
      const page1 = await fetchPage(base);
      const page2 = await fetchPage(base + "?page=2");
      return page1.concat(page2);
    };

    return await runReportPass({
      kv: meterKv(env.ZX_KV, meter),
      meter,
      fetchPools,
      metaOf: (addr) => ogFetchMetaDetail(addr, env),
      /* 🔴 ۱۹ شهریور: تا امروز کلیدِ واقعیِ v4 با ctx.waitUntil *بعد* از حکم
         ساخته می‌شد، و چون گزارش هر توکن را فقط یک بار می‌بیند (حلقه‌ی
         pairs)، آن کلید هرگز روی هیچ ردیفی اثر نمی‌گذاشت — اندازه‌گیری:
         ۶۴ از ۶۵ توکنِ v4 در گزارشِ ۱۹ شهریور «نامعلوم». پس این‌جا، و فقط
         این‌جا (مسیرِ کارتِ /t/ دست‌نخورده)، ایندکس پیش از حکم و منتظرشونده
         اجرا می‌شود — تنها برای توکنی که دکسش v4 است و هنوز ورودی ندارد. */
      verdictOf: async (addr, meta, metaWhy, dex) => {
        if (env.ZX_KV && typeof dex === "string" && dex.startsWith("uniswap-v4")) {
          try {
            const entry = await readV4Entry(addr, env);
            if (!entry.found) await runV4Index(addr, env);
          } catch (e) { /* ایندکس هرگز نباید گذرِ گزارش را بشکند */ }
        }
        return ogFetchVerdictDetail(addr, meta, Date.now() + OG_BUDGET_MS, env, ctx, metaWhy);
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      // 🔴 اجرای دستی (/report/run) سقفِ کوچک‌ترِ خودش را می‌دهد
      // (REPORT_RUN_MAX_TOKENS)؛ کرونِ ساعتی هیچ opts.maxTokens‌ای نمی‌دهد،
      // پس همان‌جا REPORT_PASS_BASE_CAP (=۵) به کار می‌رود — از رویِ لاگِ
      // گذرِ زنده‌ی ۱۹:۱۷ UTC تنظیم شده (پایِ Base پیش از توکنِ چهارم به
      // سقفِ ساب‌ریکوئستِ Worker خورد)، جزئیاتش کنارِ خودِ ثابت در
      // worker/report.js.
      maxTokens: (opts && opts.maxTokens) || REPORT_PASS_BASE_CAP,
      // فالوآپِ «یک ساعت بعد»: pickFollowUpTargets داخلِ runReportPass خودش
      // به ۳ آدرس در هر گذر سقف‌گذاری شده (از ۱۲، هم‌رده‌ی کاهشِ سهمِ Base) —
      // این حداکثر ۳ eth_call کوتاهِ اضافه در ساعت است، روی مسیری که هیچ
      // کاربری منتظرش نیست.
      poolEmptyOf: (addr) => v4PoolsEmpty(addr, env, Date.now() + 1200),
      fetchPoolsSol,
      // از ۶ به ۲ — همان تنظیمِ سهمِ هر مرحله از رویِ لاگِ گذرِ زنده‌ی
      // ۱۹:۱۷ UTC (کنارِ REPORT_PASS_BASE_CAP در worker/report.js).
      solMaxTokens: 2,
      // سقفِ ساب‌ریکوئست — هرگز خودش یک ساب‌ریکوئست دیگر مصرف نمی‌کند تا
      // بودجه بسوزاند؛ فقط رصدِ همان capHit_ی است که meter.fetch/noteThrow
      // بالاتر ثبت می‌کنند.
      capHit: () => meter.isCapHit(),
      // متادیتای دسته‌ایِ Base — یک تماس به‌جای N؛ غایب یا ناموفق یعنی
      // runReportPass دقیقاً مسیرِ metaOf تک‌آدرسه‌ی امروز را طی می‌کند.
      metaMany: (addrs) => ogFetchMetaMany(addrs, env),
      /* پروبِ سقفِ ساب‌ریکوئست — فقط اندازه‌گیری: یک HEAD تک به همان بالادستِ
         GeckoTerminal، پشتِ مهلتِ ۱۵۰۰ میلی‌ثانیه‌ایِ خودش. اثباتِ «گذرِ ساعتی
         به سقفِ ساب‌ریکوئستِ Worker می‌خورد یا نه» — هیچ رفتاری از خودِ گذر
         عوض نمی‌شود. */
      probeFetch: async () => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), REPORT_CAP_PROBE_TIMEOUT_MS);
        try {
          return await fetch(UPSTREAM_FREE + "/networks?page=1", {
            method: "HEAD", signal: controller.signal,
          });
        } finally {
          clearTimeout(t);
        }
      },
    });
  } catch (e) {
    return { checked: 0, added: 0 }; // یک اجرای زمان‌بندی‌شده هرگز نباید پرتاب کند
  }
}

/* ---------------------------------------------------------------------
   GET /report/run — همان گذرِ زمان‌بند، ولی به‌دستور.
   ---------------------------------------------------------------------
   چرا هست: وقتی زمان‌بند چیزی نمی‌نویسد، از بیرون نمی‌شود فهمید «کرون شلیک
   نکرد» یا «گذر شلیک شد و وسطش افتاد». این مسیر همان تفاوت را با یک
   درخواست روشن می‌کند — همان الگویی که /vd و /vd/rpc برای حکم انجام دادند.

   🔴 کلید از هدر می‌آید نه از کوئری: یک راز می‌تواند در مسیر یا کوئریِ URL
   بنشیند و از آن‌جا در لاگ و تاریخچه‌ی شل بماند. هدر هیچ‌کدام را نمی‌سازد.
   🔴 نبودِ RUN_KEY و کلیدِ غلط هر دو ۴۰۴ می‌گیرند، نه ۴۰۱: از بیرون اصلاً
   معلوم نشود چنین مسیری وجود دارد.
   ⚠️ سقفِ توکن اینجا ۵ است نه ۳۰ — پاسخ باید در چند ثانیه برگردد، و
   tokenCap در report.js هم اجازه نمی‌دهد هیچ کالری از سقفِ اصلی بالاتر برود. */
const REPORT_RUN_MAX_TOKENS = 5;
// سقفِ زمانیِ همان پروبِ سقفِ ساب‌ریکوئست — عمداً کوتاه، این یک اندازه‌گیریِ
// اضافه در انتهای گذر است، نباید خودش کند شدنِ گذر را بسازد.
const REPORT_CAP_PROBE_TIMEOUT_MS = 1500;

async function reportRunRoute(request, env, ctx) {
  const want = (env && typeof env.RUN_KEY === "string" && env.RUN_KEY) || "";
  const got = request.headers.get("x-run-key") || "";
  if (!want || got !== want) return vdDone(404, { error: "not found" });
  if (request.method !== "GET") return vdDone(405, { error: "only GET" });

  const t0 = Date.now();
  const r = await scheduledReportPass(env, ctx, { maxTokens: REPORT_RUN_MAX_TOKENS });
  return vdDone(200, {
    ran: true,
    checked: r.checked,
    added: r.added,
    followed: r.followed,
    rechecked: r.rechecked,
    sub: r.sub,
    recheckTried: r.recheckTried,
    capProbe: r.capProbe,
    ms: Date.now() - t0,
    store: !!(env && env.ZX_KV),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/gt" || url.pathname.startsWith("/gt/"))
      return proxyGt(request, url, ctx, env);
    if (url.pathname === "/ev") return collectEv(request, url, env);
    /* تصویر کارت نیست، بایندینگ ASSETS هم نیست — مثل /gt و /ev همیشه باید
       به کد برسد، نه به فایل‌های ثابت. */
    if (url.pathname === "/vd" || url.pathname.startsWith("/vd/"))
      return diagVerdict(request, url, env, ctx);
    /* گزارشِ روزانه و نمای «تازه‌ها». نه فایل‌اند، نه بایندینگ ASSETS، پس
       باید مثلِ /gt و /ev و /vd همیشه به کد برسند — همان دلیلی که پایین‌تر
       برای robots.txt/sitemap.xml هم تکرار شده: خط Build در پنل فقط
       html/js/_headers را کپی می‌کند، پس یک مسیرِ تازه باید از همین‌جا سرو
       شود، نه از `_site`، وگرنه بی‌صدا ۴۰۴ می‌گرفت. */
    /* پیش از reportRoute: وگرنه «run» یک تاریخِ بدشکل حساب می‌شد و ۴۰۰
       می‌گرفت، نه اجرا. */
    if (url.pathname === "/report/run") return reportRunRoute(request, env, ctx);
    if (url.pathname.startsWith("/report/") && url.pathname.endsWith(".txt"))
      return reportTextRoute(request, url, env);
    if (url.pathname.startsWith("/report/")) return reportRoute(request, url, env);
    if (url.pathname === "/pairs.json") return pairsRoute(request, url, env);
    /* تصویر کارت. عمداً در `_site` نیست، پس همیشه به کد می‌رسد — مثل /gt و
       /ev. یعنی برای اضافه‌شدنش لازم نیست کسی Build command را در پنل عوض
       کند، و انتشارش با خودِ کد اتمیک است. */
    if (url.pathname === "/og.png") return ogImageResponse(request);
    /* robots.txt و sitemap.xml هم از کد می‌آیند، نه از `_site` — به همان
       دلیلِ بالا: خط Build در پنل فقط `web/*.html`، `web/_headers` و
       `web/*.js` را کپی می‌کند، پس یک فایلِ `.txt` یا `.xml` کنارِ
       index.html بی‌صدا منتشر *نمی‌شود* و ما فکر می‌کنیم شده. از این‌جا،
       انتشارش با خودِ کد اتمیک است و هیچ قدمِ دستیِ پنلی نمی‌خواهد. */
    if (url.pathname === "/robots.txt") return robotsResponse();
    if (url.pathname === "/sitemap.xml") return sitemapResponse(url, env, ctx);
    /* GET /pairs — نسخه‌ی تمیزِ آدرس برای web/pairs.html.
       🔴 برخلافِ /gt و /ev و /vd، این مسیر یک فایل *دارد*: خطِ Build در
       پنل همین امروز `web/*.html` را (پس web/pairs.html را هم) داخلِ
       `_site` کپی می‌کند، یعنی بایندینگِ [assets] معمولاً خودش زودتر از
       این خط به این pathname جواب می‌دهد و این شرط هرگز در عمل اجرا
       نمی‌شود. با این‌حال این‌جا نگه داشته می‌شود تا اگر یک‌روز آن رفتار
       عوض شد (مثلاً فایل از _site جا افتاد)، آدرس تمیز بی‌صدا ۴۰۴ نگیرد.
       الگو عیناً همان الگوی /t/<آدرس> پایین‌تر است: یک Request تازه با
       pathname واقعیِ فایل ساخته می‌شود و به env.ASSETS داده می‌شود. */
    if (url.pathname === "/pairs" && env && env.ASSETS)
      return env.ASSETS.fetch(new Request(new URL("/pairs.html", url), request));
    /* /t/<آدرس> یک صفحه‌ی واقعی است، نه یک هش. بایندینگ [assets] برای مسیری
       که فایل ندارد ۴۰۴ می‌دهد، پس خودمان همان index.html را برایش سرو
       می‌کنیم و صفحه از روی pathname می‌فهمد کدام توکن را باید نشان بدهد.
       چرا مسیر و نه هش: هش هیچ‌وقت به سرور نمی‌رسد، پس با هش هرگز نمی‌شد
       کارت پیش‌نمایش (OG) برای تلگرام و ایکس ساخت. */
    /* ⚠️ «/» نه «/index.html». سرویس فایل‌های ثابت برای /index.html طبق
       قاعده‌ی خودش ۳۰۷ به / می‌دهد، و آن ریدایرکت از همین‌جا بیرون می‌رفت:
       مرورگر سر از صفحه‌ی اصلی درمی‌آورد، pathname دیگر /t/… نبود، و صفحه‌ی
       توکن هیچ‌وقت باز نمی‌شد. اندازه‌گیری‌شده روی سایت زنده:
         /t/0x8335…  307 -> https://zaexa.com/
       در حالی که /tx/0xabc و /hello-there ۴۰۴ می‌دادند — یعنی مسیرهای
       ناشناخته سالم بودند و فقط همین یکی ریدایرکت می‌شد. */
    if (TOKEN_PAGE.test(url.pathname) && env && env.ASSETS) {
      const addr = url.pathname.slice(3).replace(/\/$/, "");
      /* ⚠️ سولانا از امروز همین‌جا صفحه می‌گیرد، نه ۴۰۴. تا همین‌جا، یک mint
         سولانا با همان ۴۰۴ای که هر مسیرِ ناشناخته می‌گرفت رد می‌شد، چون
         web/index.html نمی‌توانست آن را رندر کند و سرودادنِ اپ برایش یک
         صفحه‌ی ساکت‌شکسته می‌ساخت. حالا web/index.html یک «حالتِ فقط-چکِ
         سولانا» دارد (بدونِ ethers، بدونِ کیف‌پول، فقط GET /gt +‌ GET /vd) —
         پس آن رد دیگر لازم نیست: chainOf(addr) اینجا دیگر چک نمی‌شود، هر
         دو شکل همان مسیرِ زیر را طی می‌کنند و همان index.html (زیرِ /app)
         سرو می‌شود. */
      /* ⚠️ /gt و /ev هر دو زیر rateOk بودند، این مسیر نبود — و همین یکی
         مستقیم به ogFetchMeta می‌رسد که کلید مشترکِ CoinGecko را می‌سوزاند.
         یک حلقه روی آدرس‌های تصادفیِ /t/0x… دقیقاً همان کلیدی را تمام
         می‌کند که rateOk قرار است از آن محافظت کند — بدونِ این‌که هیچ‌وقت
         از خودِ rateOk رد شود.
         ⚠️ ولی ۴۲۹ اینجا غلط است: پشتِ این درخواست یک آدم است که دارد یک
         صفحه‌ی واقعی باز می‌کند، نه یک اسکریپت که باید عقب رانده شود. پس
         روی سقف، صفحه هنوز ۲۰۰ برمی‌گردد — فقط تزریقِ OGِ مخصوصِ توکن حذف
         می‌شود و کارتِ عمومیِ سایت (همان data-og ثابت) جایش می‌ماند. تنزلِ
         پیش‌نمایش، نه تنزلِ صفحه. بستهٔ (bucket) «og» جدا از «gt» است چون
         این دو مصرفِ متفاوتی از همان کلید دارند و نباید سهمیهٔ هم را بخورند. */
      const withinLimit = rateOk(request, "og", RL_LIMIT, RL_WINDOW_MS);
      /* ⚠️ فراخوانی داده **قبل** از await روی ASSETS شروع می‌شود تا این دو
         موازی بروند، نه پشت سر هم. همان درسی که در خودِ صفحه‌ی توکن گرفتیم:
         خواندن توکن پشت verifyDexes منتظر می‌ماند در حالی که ربطی به آن
         نداشت. اینجا هم صفحه نباید پشت یک API بیرونی صف بایستد.
         روی سقف، metaPromise اصلاً ساخته نمی‌شود — نه فقط نتیجه‌اش دور
         ریخته می‌شود — وگرنه خودِ همین شرط بی‌فایده می‌شد: هر کاربرِ آخرِ
         سقف باز هم یک بار به CoinGecko می‌زد. */
      /* مهلتِ verdict از همین‌جا، پیش از شروعِ خودِ متادیتا، محاسبه می‌شود —
         تا شمارشِ OG_BUDGET_MS واقعاً از لحظه‌ی رسیدنِ درخواست باشد، نه از
         لحظه‌ای که متادیتا برگشت (که خودش می‌تواند تا OG_TIMEOUT_MS طول
         بکشد و مهلتِ verdict را بی‌صدا آب کند). */
      const deadlineAt = Date.now() + OG_BUDGET_MS;
      const metaPromise = withinLimit ? ogFetchMeta(addr, env) : null;
      /* verdict فقط بعد از متادیتا معنا دارد (به decimals/priceUsd همان
         نیاز دارد)، پس زنجیر می‌شود، نه موازیِ کامل — ولی چون خودش هم یک
         Promise جداست، صفحه هنوز پشتِ آن صف نمی‌ایستد؛ هر دو Promise با
         هم در injectOg پایین await می‌شوند.
         روی سقف نرخ metaPromise اصلاً null است، پس اینجا هم هیچ verdict‌ای
         ساخته نمی‌شود — دقیقاً همان استدلالِ metaPromise بالا. */
      const vdPromise = metaPromise ? metaPromise.then((m) => ogFetchVerdict(addr, m, deadlineAt, env, ctx)) : null;
      /* ⚠️ «/app» نه «/». از روزی که صفحه‌ی معرفی روی ریشه نشست، «/» دیگر
         اپ نیست. اگر این خط روی «/» بماند، هر لینکِ /t/<آدرس> صفحه‌ی
         معرفی را باز می‌کند و اپ هرگز بالا نمی‌آید — و چون ۲۰۰ برمی‌گردد،
         هیچ خطایی هم دیده نمی‌شود. بدونِ پسوند، به همان دلیلِ زیر: /app.html
         یک ۳۰۷ به /app می‌دهد و آن ریدایرکت مسیر را جا می‌گذارد. */
      const res = await env.ASSETS.fetch(new Request(new URL("/app", url), request));
      // همان chainOf(addr) که ogFetchVerdict بالاتر برای انتخابِ verdictِ
      // درست به کار می‌برد — یک منبعِ حقیقت، نه تشخیصِ دومی داخلِ og.js.
      const chain = chainOf(addr) === "solana" ? "Solana" : "Base";
      return withinLimit ? injectOg(res, url, addr, metaPromise, vdPromise, chain) : res;
    }
    // بقیه‌ی سایت دست‌نخورده از فایل‌های ثابت می‌آید.
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  },

  // اجرای ساعتیِ کرون (wrangler.toml، [triggers]). بدنه‌ی واقعی در
  // scheduledReportPass است تا worker/test.mjs بتواند بدونِ event واقعیِ
  // کرون آن را صدا بزند.
  async scheduled(event, env, ctx) {
    const p = scheduledReportPass(env, ctx);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
    else await p;
  },
};

// برای تست‌ها — در زمان اجرا روی Worker استفاده نمی‌شود.
export { PATH_OK, QUERY_OK, ttlFor, EV_OK, EV_DETAIL_OK, EV_SURFACE_OK, EV_MAX_BODY, pairsRowsFor };
export { rateOk, rlHits, RL_LIMIT, RL_WINDOW_MS };
export { OG_NETWORK, OG_TIMEOUT_MS, ogFetchMeta, ogFetchVerdict, ogFetchMetaMany };
export { baseVenueCovered, baseVenueCoveredDetail };
export { UPSTREAM_FREE, UPSTREAM_KEYED };
export { VD_ADDR_RE };
export { TOKEN_PAGE, solFetchVerdict };
export { SITEMAP_TOKEN_PAGES, SITEMAP_TOKEN_CAP, sitemapResponse, buildSitemapTokens };
export { reportRoute, pairsRoute, scheduledReportPass, reportRunRoute, REPORT_RUN_MAX_TOKENS };
export { makeSubMeter, meterKv };
export { readV4Keys, readV4Entry, rpcCallBase, fetchV4Pools, storeV4Result, v4StoreTtl, runV4Index };
export { V4_LOG_TIMEOUT_MS };
