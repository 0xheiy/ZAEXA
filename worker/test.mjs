/* تست پراکسی GeckoTerminal.
   با node اجرا می‌شود، بدون شبکه: `fetch` سراسری جایگزین می‌شود و آنچه
   بررسی می‌کنیم این است که Worker *چه چیزی* را به بالادست می‌فرستد و چه
   چیزی را اصلاً نمی‌فرستد.

   اجرا:  node worker/test.mjs
   run.py هم پیش از سوییت مرورگر همین را صدا می‌زند. */

import worker from "./index.js";
import { createHash } from "node:crypto";
import { OG_PNG_ETAG } from "./og-image.js";
import fs from "node:fs";
import { createRequire } from "node:module";

let fails = 0;
function ok(cond, what) {
  if (!cond) { fails++; console.log("FAIL " + what); }
}

const ORIGIN = "https://zaexa.com";
let sent = [];       // URLهایی که به بالادست رفت
let reply = null;    // پاسخی که بالادست می‌دهد (یا خطایی که پرتاب می‌کند)

let sentHeaders = [];
/* موکِ ردیاب — تابعِ نام‌دار، نه یک بسته‌شده‌ی بی‌نام، تا هر بخشی که موقتاً
   globalThis.fetch را برای آزمودنِ چیزِ دیگری عوض می‌کند (مثلاً بخشِ ogFetchVerdict)
   بتواند دقیقاً همین را برگرداند، نه یک کپیِ دوم که رفتارش کمی فرق دارد. */
async function trackingFetch(u, o) {
  sent.push(String(u));
  sentHeaders.push((o && o.headers) || {});
  if (reply instanceof Error) throw reply;
  return reply;
}
globalThis.fetch = trackingFetch;

const ASSETS = { fetch: async () => new Response("the site", { status: 200 }) };
const env = { ASSETS };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json" },
  });
}

async function call(path, init, e) {
  sent = []; sentHeaders = [];
  return await worker.fetch(new Request(ORIGIN + path, init), e || env, {});
}

/* ---- ۱. مسیرهای واقعی سایت پراکسی می‌شوند و درست بازنویسی می‌شوند ---- */
const REAL = [
  ["/gt/networks/base/tokens/0xabc", "https://api.geckoterminal.com/api/v2/networks/base/tokens/0xabc"],
  ["/gt/networks/base/tokens/0xabc/pools?page=1", "https://api.geckoterminal.com/api/v2/networks/base/tokens/0xabc/pools?page=1"],
  ["/gt/networks/base/tokens/multi/0xa,0xb,0xc", "https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/0xa,0xb,0xc"],
  ["/gt/networks/base/pools/0xpool/ohlcv/hour?aggregate=4&limit=180&currency=usd", "https://api.geckoterminal.com/api/v2/networks/base/pools/0xpool/ohlcv/hour?aggregate=4&limit=180&currency=usd"],
];
for (const [path, want] of REAL) {
  reply = json({ data: [] });
  const res = await call(path);
  ok(res.status === 200, "should proxy " + path + " (got " + res.status + ")");
  ok(sent[0] === want, "wrong upstream url for " + path + ":\n  got  " + sent[0] + "\n  want " + want);
  ok(res.headers.get("access-control-allow-origin") === "*", "no CORS header on " + path);
  ok(res.headers.get("x-zaexa-proxy") === "miss-free", "missing proxy marker on " + path);
}

/* ---- ۱b. با کلید: همان مسیرها، بالادست CoinGecko ----
   بی‌کلید بی‌فایده است (سقف روی IP مشترک کلادفلر است و سوخته). با کلید،
   سقف روی کلید ماست. هر چهار مسیر زیر /onchain با کلید Demo آزموده شد. */
const KEY = "CG-secret-do-not-leak-me";
const keyed = { ASSETS, CG_KEY: KEY };
for (const [path] of REAL) {
  reply = json({ data: [] });
  const res = await call(path, undefined, keyed);
  const want = path.replace("/gt/", "https://api.coingecko.com/api/v3/onchain/");
  ok(sent[0] === want, "wrong keyed upstream for " + path + ":\n  got  " + sent[0] + "\n  want " + want);
  ok(sentHeaders[0]["x-cg-demo-api-key"] === KEY, "the api key was not sent upstream for " + path);
  ok(res.headers.get("x-zaexa-proxy") === "miss-keyed", "keyed responses must be marked as such");
  // کلید نه در URL (وگرنه در کش و لاگ می‌نشیند) و نه در چیزی که برمی‌گردانیم
  ok(!sent[0].includes(KEY), "THE API KEY LEAKED INTO THE UPSTREAM URL: " + sent[0]);
  const dump = JSON.stringify([...res.headers]) + (await res.clone().text());
  ok(!dump.includes(KEY), "THE API KEY LEAKED INTO THE RESPONSE WE SEND THE BROWSER");
}
// بدون کلید باید همان مسیر بی‌کلید بماند، نه اینکه بشکند
reply = json({ data: [] });
await call(REAL[0][0], undefined, { ASSETS });
ok(sent[0] === REAL[0][1], "without a key the worker must fall back to the free api: " + sent[0]);
ok(!("x-cg-demo-api-key" in sentHeaders[0]), "an empty key was still sent as a header");

/* ---- ۲. هرچیز دیگری رد می‌شود و *به شبکه نمی‌رسد* ----
   این مهم‌ترین بخش است: یک پراکسی باز روی دامنه‌ای که کارش امضای تراکنش
   است، هم برای اعتبار دامنه بد است هم سقف نرخ خودمان را می‌سوزاند. */
const BAD = [
  "/gt/",                                        // خالی
  "/gt/networks/base",                           // ناقص
  "/gt/simple/networks/base/token_price/0xabc",  // اندپوینت دیگر GeckoTerminal
  "/gt/networks/base/tokens/..%2f..%2fadmin",    // بالا رفتن از مسیر
  "/gt/networks/base/tokens/0xabc/../../../x",   // همان، بدون کدگذاری
  "/gt/https://evil.example/steal",              // میزبان دیگر
  "/gt/networks/base/tokens/0xabc?callback=alert(1)",  // پارامتر ناشناخته
  "/gt/networks/base/tokens/0xabc?page=99999",   // پارامتر آشنا، مقدار خارج از شکل
  "/gt/networks/base/tokens/0xabc?currency=USD'",// نقل‌قول در مقدار
];
for (const path of BAD) {
  reply = json({ data: [] });
  const res = await call(path);
  ok(res.status === 400, "should have refused " + path + " (got " + res.status + ")");
  ok(sent.length === 0, "REFUSED BUT STILL CALLED UPSTREAM: " + path + " -> " + sent[0]);
  ok(res.headers.get("access-control-allow-origin") === "*", "refusal without CORS on " + path);
}

/* ---- ۳. فقط خواندن ---- */
for (const method of ["POST", "PUT", "DELETE"]) {
  reply = json({ data: [] });
  const res = await call("/gt/networks/base/tokens/0xabc", { method });
  ok(res.status === 405, method + " should be refused (got " + res.status + ")");
  ok(sent.length === 0, method + " reached upstream");
}
reply = json({ data: [] });
const pre = await call("/gt/networks/base/tokens/0xabc", { method: "OPTIONS" });
ok(pre.status === 204, "preflight should be 204 (got " + pre.status + ")");
ok(pre.headers.get("access-control-allow-methods") === "GET,HEAD,OPTIONS", "preflight without methods");

/* ---- ۴. ۴۲۹ باید *عبور کند*، نه اینکه به خطای مبهم تبدیل شود ----
   کل نکته‌ی این پراکسی همین است: پاسخ ۴۲۹ خود GeckoTerminal هدر CORS
   ندارد، پس در مرورگر به TypeError تبدیل می‌شد و از قطعی شبکه قابل
   تفکیک نبود. حالا وضعیت واقعی به صفحه می‌رسد. */
reply = new Response("rate limited", { status: 429 });
let res = await call("/gt/networks/base/tokens/0xabc");
ok(res.status === 429, "429 must pass through (got " + res.status + ")");
ok(res.headers.get("access-control-allow-origin") === "*", "429 without CORS — the page still cannot see it");
ok(res.headers.get("cache-control") === "no-store", "a 429 must never be cached");
ok(res.headers.get("x-zaexa-proxy") === "upstream-429", "429 not marked");

/* ---- ۵. بالادست در دسترس نیست ---- */
reply = new Error("boom");
res = await call("/gt/networks/base/tokens/0xabc");
ok(res.status === 502, "an unreachable upstream should be 502 (got " + res.status + ")");
ok(res.headers.get("access-control-allow-origin") === "*", "502 without CORS");

/* ---- ۶. عمر کش ---- */
ok(worker !== null, "");
const { ttlFor } = await import("./index.js");
ok(ttlFor("networks/base/tokens/0xabc/pools") === 600, "pool list ttl");
ok(ttlFor("networks/base/pools/0xp/ohlcv/hour") === 45, "ohlcv ttl");
ok(ttlFor("networks/base/tokens/multi/0xa") === 60, "metadata ttl");

/* ---- ۷. بقیه‌ی سایت دست‌نخورده ---- */
reply = json({ data: [] });
res = await call("/");
ok((await res.text()) === "the site", "the root must still come from static assets");
ok(sent.length === 0, "serving the site called geckoterminal");
res = await call("/index.html");
ok(res.status === 200, "index.html must still be served");

/* ---- ۸. کش: پاسخ موفق در لبه می‌نشیند، خطا هرگز ---- */
{
  const shelf = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => {
        const v = shelf.get(req.url);
        return v ? v.clone() : undefined;
      },
      put: async (req, r) => { shelf.set(req.url, r); },
    },
  };
  reply = json({ data: ["fresh"] });
  await call("/gt/networks/base/tokens/0xcached");
  reply = json({ data: ["should not be reached"] });
  const second = await call("/gt/networks/base/tokens/0xcached");
  ok(sent.length === 0, "a cached url still went to the network");
  ok(second.headers.get("x-zaexa-proxy") === "hit", "second call was not served from cache");

  shelf.clear();
  reply = new Response("rate limited", { status: 429 });
  await call("/gt/networks/base/tokens/0xerr");
  ok(shelf.size === 0, "an error response was written to the edge cache");
  delete globalThis.caches;
}

/* ---- ۹. /ev — شمارش رویداد ----
   دو چیز اینجا سنجیده می‌شود و هر دو مهم‌اند:
   الف) فقط شکل مورد انتظار پذیرفته می‌شود — وگرنه یک اندپوینت عمومی هر رشته‌ای
        را در انبار ما می‌نویسد.
   ب)  آنچه *نوشته می‌شود* دقیقاً همان چهار میدان است و نه چیز دیگر: IP و
       User-Agent و Referer و کوکی هرگز نباید در ردیف ذخیره‌شده پیدا شوند. */
{
  let points = [];
  const ZX_EV = { writeDataPoint: (p) => points.push(p) };
  const evEnv = { ASSETS, ZX_EV };

  // هدرهایی که یک مرورگر واقعی می‌فرستد و هیچ‌کدام نباید ثبت شوند
  const NOSY = {
    "content-type": "text/plain;charset=UTF-8",
    "user-agent": "Mozilla/5.0 SecretBrowser/9 SENSITIVE-UA",
    referer: "https://somewhere.example/private-page",
    cookie: "sid=SENSITIVE-COOKIE",
    "cf-connecting-ip": "203.0.113.77",
    "accept-language": "fa-IR",
  };
  function evCall(body, opts = {}) {
    points = []; sent = [];
    const init = {
      method: opts.method || "POST",
      headers: Object.assign({}, NOSY, opts.headers || {}),
    };
    if (init.method !== "GET" && init.method !== "HEAD") init.body = body;
    const req = new Request(ORIGIN + "/ev", init);
    if (opts.cf !== undefined) Object.defineProperty(req, "cf", { value: opts.cf });
    return worker.fetch(req, opts.env || evEnv, {});
  }

  const GOOD = JSON.stringify({ e: "view:folio", d: "", v: "mobile" });

  /* الف) مسیر درست */
  let r = await evCall(GOOD, { cf: { country: "DE" } });
  ok(r.status === 204, "a valid event should be 204 (got " + r.status + ")");
  ok(points.length === 1, "a valid event was not recorded (" + points.length + " points)");
  ok(JSON.stringify(points[0].blobs) === JSON.stringify(["view:folio", "", "mobile", "DE"]),
    "wrong blobs written: " + JSON.stringify(points[0].blobs));
  ok(points[0].indexes && points[0].indexes[0] === "view:folio",
    "the event name must be the sampling index");
  ok(r.headers.get("cache-control") === "no-store", "the /ev reply must not be cached");
  ok(sent.length === 0, "/ev reached the geckoterminal upstream");
  ok((await r.clone().text()) === "", "/ev must answer with an empty body, not the site");

  /* ب) هیچ‌چیز حساسی در آنچه نوشته شد نیست */
  const written = JSON.stringify(points[0]);
  for (const secret of ["SENSITIVE-UA", "SENSITIVE-COOKIE", "203.0.113.77",
                        "somewhere.example", "fa-IR", "Mozilla"]) {
    ok(!written.includes(secret),
      "A SENSITIVE HEADER WAS WRITTEN INTO THE ANALYTICS ROW: " + secret + " in " + written);
  }
  ok(points[0].blobs.length === 4 && points[0].blobs.every(b => typeof b === "string"),
    "the analytics row must be exactly four strings: " + written);

  /* کشور فقط از request.cf، و هر شکل دیگری «??» */
  for (const [given, want] of [["DE", "DE"], ["T1", "T1"], ["XX", "XX"],
                               ["de", "??"], ["IRAN", "??"], ["", "??"], [undefined, "??"]]) {
    await evCall(GOOD, { cf: given === undefined ? {} : { country: given } });
    ok(points[0].blobs[3] === want,
      "country " + JSON.stringify(given) + " should be recorded as " + want +
      " (got " + points[0].blobs[3] + ")");
  }
  await evCall(JSON.stringify({ e: "load", d: "", v: "desktop", country: "US" }), { cf: {} });
  ok(points[0].blobs[3] === "??", "a country in the request body must be ignored");

  /* ج) هرچه شکل مورد انتظار را ندارد رد می‌شود و *نوشته نمی‌شود* */
  const REFUSE = [
    [405, GOOD, { method: "GET" }],
    [405, GOOD, { method: "PUT" }],
    [405, GOOD, { method: "OPTIONS" }],
    [403, GOOD, { headers: { origin: "https://evil.example" } }],
    [400, "not json at all", {}],
    [400, "[1,2,3]", {}],
    [400, "null", {}],
    [400, '"load"', {}],
    [400, JSON.stringify({ e: "view:secret", d: "", v: "desktop" }), {}],
    [400, JSON.stringify({ e: "", d: "", v: "desktop" }), {}],
    [400, JSON.stringify({ d: "", v: "desktop" }), {}],
    [400, JSON.stringify({ e: "load", d: "0xdeadbeef", v: "desktop" }), {}],
    [400, JSON.stringify({ e: "load", d: "", v: "tv" }), {}],
    [400, JSON.stringify({ e: "load", d: "", v: "" }), {}],
    [400, JSON.stringify({ e: ["load"], d: "", v: "desktop" }), {}],
    [413, JSON.stringify({ e: "load", d: "", v: "desktop", pad: "x".repeat(400) }), {}],
  ];
  for (const [want, body, opts] of REFUSE) {
    const res = await evCall(body, opts);
    ok(res.status === want,
      "/ev should answer " + want + " for " + body.slice(0, 50) + " (got " + res.status + ")");
    ok(points.length === 0, "REFUSED BUT STILL RECORDED: " + body.slice(0, 50));
  }
  // Origin خودمان باید عبور کند، وگرنه شرط بالا کل شمارش را می‌خورد
  r = await evCall(GOOD, { headers: { origin: ORIGIN }, cf: {} });
  ok(r.status === 204, "our own Origin must be accepted (got " + r.status + ")");

  // میدان اضافه‌ی ناشناس مانع نیست، ولی وارد ردیف هم نمی‌شود
  r = await evCall(JSON.stringify({ e: "load", d: "", v: "desktop", extra: "SNEAKY" }), { cf: {} });
  ok(r.status === 204, "an unknown extra field should not break the beacon");
  ok(!JSON.stringify(points[0]).includes("SNEAKY"), "an unknown extra field was written");

  // تن بزرگ با content-length دروغین هم باید بیفتد
  r = await evCall("x".repeat(400), { headers: { "content-length": "10" } });
  ok(r.status === 413,
    "an oversized body with a lying content-length should be 413 (got " + r.status + ")");

  /* د) بایندینگ نباشد: سایت نباید بشکند */
  r = await evCall(GOOD, { env: { ASSETS }, cf: { country: "US" } });
  ok(r.status === 204,
    "without the dataset binding /ev must still answer 204 (got " + r.status + ")");

  /* ه) هر نام مجاز واقعاً پذیرفته می‌شود — وگرنه صفحه رویدادی می‌فرستد که
     بی‌صدا دور ریخته می‌شود و ما فکر می‌کنیم «کسی این کار را نمی‌کند». */
  const { EV_OK } = await import("./index.js");
  for (const name of EV_OK) {
    const res = await evCall(JSON.stringify({ e: name, d: "", v: "desktop" }), { cf: {} });
    ok(res.status === 204, "the allowlisted event " + name + " was refused (" + res.status + ")");
  }
  for (const d of ["inj", "wc"]) {
    const res = await evCall(JSON.stringify({ e: "wallet:on", d, v: "desktop" }), { cf: {} });
    ok(res.status === 204, "the allowlisted detail " + d + " was refused (" + res.status + ")");
  }
  /* و) سه رویداد خطا باید *باشند*. حلقه‌ی بالا فقط می‌گوید هرچه در فهرست
     هست پذیرفته می‌شود؛ اگر روزی این سه از فهرست بیفتند، آن حلقه همچنان
     سبز می‌ماند و صفحه بی‌صدا ۴۰۰ می‌گیرد — یعنی «هیچ خطایی نیفتاد» که
     همان عددِ غلطِ شبیهِ عددِ درست است. */
  for (const name of ["err:js", "err:promise", "err:res"]) {
    ok(EV_OK.has(name), "the worker no longer accepts " + name + ", so browser errors "
      + "would be silently dropped and the dashboard would read as 'no errors'");
  }
  /* ز) فهرست بسته‌ی همیشگی دست‌نخورده مانده — سه ورودی، نه بیشتر. */
  const { EV_DETAIL_OK } = await import("./index.js");
  ok(EV_DETAIL_OK.size === 3, "the detail allowlist grew to " + EV_DETAIL_OK.size
    + " entries. Error text must never travel in detail — that list is the privacy boundary.");

  /* ح) استثنای تازه: کدِ چهار-رقمِ بزرگ فقط برای سه رویدادِ err:، و برای
     هیچ رویدادِ دیگری — حتی wallet:on که خودش detail دارد. اگر این باریک
     نماند، مرزِ detail برای همه‌چیز باز می‌شود. */
  let hx = await evCall(JSON.stringify({ e: "err:js", d: "A3F1", v: "desktop" }), { cf: {} });
  ok(hx.status === 204, "a 4-hex detail on an err: event should be accepted (got " + hx.status + ")");

  hx = await evCall(JSON.stringify({ e: "wallet:on", d: "A3F1", v: "desktop" }), { cf: {} });
  ok(hx.status === 400, "the SAME hex detail must be refused on a non-error event like "
    + "wallet:on (got " + hx.status + ") — otherwise the detail boundary is open for "
    + "every event, not just errors");

  hx = await evCall(JSON.stringify({ e: "err:js", d: "ZZZZ", v: "desktop" }), { cf: {} });
  ok(hx.status === 400, "\"ZZZZ\" is not hex and must be refused even on an error event "
    + "(got " + hx.status + ")");

  hx = await evCall(JSON.stringify({ e: "err:js", d: "a3f1", v: "desktop" }), { cf: {} });
  ok(hx.status === 400, "lowercase hex must be refused — the shape is uppercase-only "
    + "(got " + hx.status + ")");

  hx = await evCall(JSON.stringify({ e: "wallet:on", d: "inj", v: "desktop" }), { cf: {} });
  ok(hx.status === 204, "wallet:on must still accept its own allowlisted detail \"inj\" "
    + "(got " + hx.status + ")");

  console.log("[events] " + EV_OK.size + " event names allowed, everything else refused");
}

/* صفحه‌ی توکن: Worker باید *اپ* را از ASSETS بخواهد (/app)، نه ریشه و نه
   /app.html.
   خواستن /index.html یک ۳۰۷ به / برمی‌گرداند و همان ریدایرکت از Worker
   بیرون می‌رود؛ مرورگر سر از صفحه‌ی اصلی درمی‌آورد و صفحه‌ی توکن هرگز باز
   نمی‌شود. این روی سایت زنده اتفاق افتاد، پس اینجا سنجیده می‌شود. */
{
  let asked = [];
  const spyEnv = { ASSETS: { fetch: async (req) => {
    asked.push(new URL(req.url).pathname);
    return new Response("the site", { status: 200 });
  } } };
  const addr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const res = await worker.fetch(new Request(ORIGIN + "/t/" + addr), spyEnv, {});
  ok(res.status === 200,
     "the token page did not return the app (" + res.status + ")");
  ok(asked.length === 1 && asked[0] === "/app",
     "the token page asked ASSETS for " + JSON.stringify(asked) +
     " — it must ask for \"/app\": the root now serves the landing page, so asking " +
     "for \"/\" opens marketing instead of the app and still returns 200, and " +
     "\"/app.html\" answers with a 307 to /app whose redirect leaves the path behind");
  // و یک آدرس بدشکل نباید این مسیر را بگیرد
  asked = [];
  await worker.fetch(new Request(ORIGIN + "/t/not-an-address"), spyEnv, {});
  ok(asked.length === 1 && asked[0] === "/t/not-an-address",
     "a malformed token path was treated as a token page: " + JSON.stringify(asked));
  console.log("[token page] worker serves /app for /t/<address>, untouched for anything else");
}

/* صفحه‌ی توکن هم زیر rateOk است — /gt و /ev هر دو بودند، این یکی نبود، و
   همین یکی مستقیم ogFetchMeta را صدا می‌زند که کلید مشترکِ CoinGecko را
   می‌سوزاند. یک حلقه روی آدرس‌های تصادفیِ /t/0x… دقیقاً همان کلیدی را
   تمام می‌کرد که rateOk قرار بود از آن محافظت کند.
   ⚠️ ولی رویِ سقف نباید ۴۲۹ بدهد — پشتِ این درخواست یک آدم است که یک
   صفحه‌ی واقعی باز کرده، نه اسکریپتی که باید عقب رانده شود. پس زیرِ سقف
   بالادست خوانده می‌شود (خودِ *تزریق* اینجا سنجیدنی نیست — HTMLRewriter
   در node نیست، برای آن worker/og_live_test.mjs هست)، و رویِ سقف صفحه
   همچنان ۲۰۰ است ولی هیچ فراخوانی به بالادست نمی‌رود: تنزلِ پیش‌نمایش،
   نه تنزلِ صفحه. */
{
  const { RL_LIMIT } = await import("./index.js");
  const addr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const ip = "203.0.113.201";

  reply = json({ data: { attributes: { name: "USD Coin", symbol: "USDC",
    total_reserve_in_usd: "1" } } });
  let res = await call("/t/" + addr, { headers: { "cf-connecting-ip": ip } });
  ok(res.status === 200, "a token page under the limit should still be 200 (got " + res.status + ")");
  ok(sent.length === 1,
     "a token page under the limit should still read CoinGecko once, got " + sent.length);

  // بقیه‌ی سهمیه‌ی همین سطل را می‌سوزانیم تا به مرز برسیم
  for (let i = 1; i < RL_LIMIT; i++) {
    reply = json({ data: {} });
    await call("/t/" + addr, { headers: { "cf-connecting-ip": ip } });
  }
  reply = json({ data: {} });
  res = await call("/t/" + addr, { headers: { "cf-connecting-ip": ip } });
  ok(res.status === 200,
     "over the limit the token page must still open — a human is looking at it, not a " +
     "script to push back on (got " + res.status + ")");
  ok(sent.length === 0,
     "over the limit ogFetchMeta must not touch the network — the whole point is protecting " +
     "the shared CoinGecko key, got " + sent.length + " call(s)");
  ok((await res.text()) === "the site",
     "over the limit the page markup itself must be untouched, not a broken or empty page");
  console.log("[og limit] under the cap: upstream read once, page 200; over the cap: page " +
    "still 200 with the site's own markup, zero upstream calls");
}

/* ---- ۱۰. کارت پیش‌نمایش (OG) — بخش‌هایی که بدون workerd سنجیدنی‌اند ----
   `HTMLRewriter` در node وجود ندارد، پس خودِ *تزریق* اینجا سنجیده نمی‌شود؛
   آن در `worker/og_live_test.mjs` روی workerd واقعی سنجیده می‌شود.
   اینجا هرچه منطق است سنجیده می‌شود: گریز، قالب عدد، انتخاب عنوان، و
   اینکه Worker چه چیزی به بالادست می‌فرستد و چه وقت هیچ نمی‌فرستد. */
{
  const og = await import("./og.js");
  const { OG_NETWORK, ogFetchMeta, VD_CACHE_HOST, PATH_OK, UPSTREAM_FREE, UPSTREAM_KEYED } =
    await import("./index.js");

  /* گریز: هر پنج نویسه، نه فقط `<`. یک `"` تنها کافی است که نام توکن از
     مقدار ویژگی بیرون بزند و یک تگ تازه باز کند. */
  ok(og.ogEscape('<&>"\'') === "&lt;&amp;&gt;&quot;&#39;",
     "ogEscape left something unescaped: " + og.ogEscape('<&>"\''));

  /* نام چندخطی یا با نویسه‌ی کنترلی نباید بتواند تگ را بشکند یا نامرئی
     شود؛ و طول سقف دارد وگرنه عنوان هیچ‌جا جا نمی‌شود. */
  ok(og.ogClean("a\nb\tc", 40) === "a b c", "ogClean did not fold whitespace");
  ok(og.ogClean("a​b", 40) === "a b", "ogClean kept a zero-width character");
  ok(og.ogClean("   ", 40) === null, "a blank name should be null, not an empty string");
  ok(og.ogClean(null, 40) === null && og.ogClean(undefined, 40) === null,
     "ogClean should turn a missing value into null");
  const long = og.ogClean("x".repeat(200), 16);
  ok(long.length === 16, "ogClean ignored the length cap (" + long.length + ")");

  /* عدد نامعلوم → null، نه «—». روی صفحه «—» یک ردیف جدول را پر می‌کند؛
     در توضیح کارت «Liquidity —» فقط سروصداست. */
  for (const bad of [null, "", "abc", 0, -5, NaN, Infinity])
    ok(og.ogBig(bad) === null, "ogBig should be null for " + JSON.stringify(bad));
  ok(og.ogBig("12400000") === "$12.40M", "ogBig M: " + og.ogBig("12400000"));
  ok(og.ogBig("3120") === "$3.1K", "ogBig K: " + og.ogBig("3120"));
  ok(og.ogBig("2500000000") === "$2.50B", "ogBig B: " + og.ogBig("2500000000"));
  ok(og.ogBig("42") === "$42", "ogBig plain: " + og.ogBig("42"));

  /* بدنه‌ی بدشکل → null، نه یک شیء نصفه که بعداً «undefined» روی کارت بنویسد. */
  for (const bad of [null, {}, { data: [] }, { data: { attributes: 3 } }, "nope"])
    ok(og.pickTokenMeta(bad) === null,
       "pickTokenMeta should be null for " + JSON.stringify(bad));

  /* decimals و priceUsd.
     ⚠️ GeckoTerminal price_usd را هم مثل total_reserve_in_usd/volume_usd.h24
     به‌صورت رشته می‌فرستد؛ رد کردنِ رشته یعنی روی داده‌ی واقعی همیشه null
     دربیاید و fetchVerdict هرگز حتی تلاش نکند — دقیقاً همان باگی که یک‌بار
     کارتِ زنده را ساکت خراب کرد. پس priceUsd هر عددِ رشته‌ای یا خامِ مثبت را
     قبول می‌کند، درست مثلِ ogBig؛ decimals فرق دارد، آن همیشه عدد است، نه
     رشته، پس همان سخت‌گیریِ typeof می‌ماند. بقیه‌ی میدان‌ها (نام، نماد،
     نقدینگی) باید دست‌نخورده بمانند — یک قیمتِ بدشکل نباید آن‌ها را هم با
     خودش ببرد. */
  {
    const attrsOk = { name: "USD Coin", symbol: "USDC", total_reserve_in_usd: "1",
                      decimals: 6, price_usd: 1.0001 };
    const good = og.pickTokenMeta({ data: { attributes: attrsOk } });
    ok(good && good.decimals === 6 && good.priceUsd === 1.0001 &&
       good.name === "USD Coin" && good.symbol === "USDC",
       "pickTokenMeta lost decimals/priceUsd (or something else) for a valid shape: " +
       JSON.stringify(good));

    // یک قیمتِ رشته‌ای — دقیقاً شکلی که بالادستِ واقعی می‌فرستد — باید
    // عیناً مثلِ همان عددِ خام پذیرفته شود.
    const stringPrice = og.pickTokenMeta({ data: { attributes: { ...attrsOk, price_usd: "1.0001" } } });
    ok(stringPrice && stringPrice.priceUsd === 1.0001,
       "a numeric price given as a string must be accepted — GeckoTerminal always sends it as a "
       + "string, and rejecting it is exactly what left fetchVerdict never trying: " +
       JSON.stringify(stringPrice));

    const noPriceField = { ...attrsOk }; delete noPriceField.price_usd;
    const BAD_PRICE = [
      ["a negative price", { ...attrsOk, price_usd: -1 }],
      ["a negative price string", { ...attrsOk, price_usd: "-1" }],
      ["a zero price", { ...attrsOk, price_usd: 0 }],
      ["a zero price string", { ...attrsOk, price_usd: "0" }],
      ["a NaN price", { ...attrsOk, price_usd: NaN }],
      ["a non-numeric price string", { ...attrsOk, price_usd: "abc" }],
      ["an empty price string", { ...attrsOk, price_usd: "" }],
      ["a whitespace-only price string", { ...attrsOk, price_usd: "   " }],
      ["a null price", { ...attrsOk, price_usd: null }],
      ["a missing price field", noPriceField],
    ];
    for (const [label, attrs] of BAD_PRICE) {
      const m = og.pickTokenMeta({ data: { attributes: attrs } });
      ok(m && m.priceUsd === null && m.decimals === 6,
         "priceUsd should be null (decimals unaffected) for " + label + ": " + JSON.stringify(m));
    }

    const BAD_DECIMALS = [
      ["decimals 37", { ...attrsOk, decimals: 37 }],
      ["decimals -1", { ...attrsOk, decimals: -1 }],
      ["decimals given as the string \"18\"", { ...attrsOk, decimals: "18" }],
      ["non-integer decimals", { ...attrsOk, decimals: 1.5 }],
    ];
    for (const [label, attrs] of BAD_DECIMALS) {
      const m = og.pickTokenMeta({ data: { attributes: attrs } });
      ok(m && m.decimals === null && m.priceUsd === 1.0001,
         "decimals should be null (priceUsd unaffected) for " + label + ": " + JSON.stringify(m));
    }
    console.log("[pickTokenMeta] decimals/priceUsd carried through for a valid shape, a string "
      + "price accepted, null for each bad one, without disturbing name/symbol/liquidity");
  }

  /* --- فیکسچرِ واقعی، اندازه‌گیری‌شده روی سایتِ زنده ---
     قاعده‌ی استانداردِ این مخزن: یک ماک باید واقعیت را آینه کند. فیکسچرِ
     قبلی عددها را جایی می‌گذاشت که API رشته می‌فرستد؛ همه‌ی تست‌ها با آن
     سبز بودند و کارتِ زنده هیچ‌کاری نمی‌کرد — دقیقاً همان چیزی که این probe
     قرار است دیگر تکرار نشود. */
  {
    const { sellAmountFrom } = await import("./verdict.js");
    const LIVE_ATTRS = {
      name: "Some Token", symbol: "TOK",
      decimals: 18,
      price_usd: "0.001096077838",
      total_reserve_in_usd:
        "864686.88844287130299348404259937249318777297342779422871533805033929852051014022",
      volume_usd: { h24: "72419.9274686212" },
    };
    const live = og.pickTokenMeta({ data: { attributes: LIVE_ATTRS } });
    ok(live && typeof live.priceUsd === "number" && live.priceUsd > 0 && live.decimals === 18,
       "the measured live-shape fixture did not yield a usable priceUsd/decimals: " +
       JSON.stringify(live));

    const amt = live ? sellAmountFrom(live.priceUsd, live.decimals) : null;
    ok(amt != null, "sellAmountFrom returned null for a realistic price/decimals pair: " +
       (live && live.priceUsd) + "/" + (live && live.decimals));
    // بزرگی، نه رقمِ دقیق: ~۹۱٬۲۳۳ × ۱۰^۱۸ — یعنی بینِ ۹۰٬۰۰۰ و ۹۲٬۰۰۰ واحدِ کامل.
    // amt را فقط وقتی به BigInt تقسیم می‌کنیم که واقعاً BigInt باشد — وگرنه
    // یک احتمالِ null اینجا probe را با یک TypeError خام می‌ترکاند، که یک
    // FAILِ خوانا نیست.
    if (typeof amt === "bigint") {
      const whole = amt / 10n ** 18n;
      ok(whole > 90000n && whole < 92000n,
         "sellAmountFrom's magnitude looks wrong for the measured live price: got " + whole +
         " whole tokens, expected roughly 91,233");
    } else {
      ok(false, "sellAmountFrom did not return a BigInt for a realistic price/decimals pair, " +
        "got " + JSON.stringify(amt));
    }
    console.log("[live fixture] a realistic string-typed GeckoTerminal payload yields a usable "
      + "priceUsd and a sane sellAmountFrom magnitude (~91,233 tokens), not a silent null");
  }

  /* عنوان — چهار حالت، و هیچ‌کدام نباید «undefined» بدهد. */
  ok(og.ogTitle(null) === "Token on Base — Zaexa", "no data should give a generic title");
  ok(og.ogTitle({ symbol: "USDC", name: "USD Coin" }) === "USDC · USD Coin — Zaexa",
     "title with both: " + og.ogTitle({ symbol: "USDC", name: "USD Coin" }));
  ok(og.ogTitle({ symbol: "USDC", name: "usdc" }) === "USDC — Zaexa",
     "a name that only repeats the symbol should not be printed twice");
  ok(og.ogTitle({ symbol: null, name: "USD Coin" }) === "USD Coin — Zaexa",
     "title without a symbol");

  /* توضیح — عددی که نداریم اصلاً نمی‌آید. */
  const dFull = og.ogDescription({ liquidity: "$1.00M", vol24: "$2.00M" });
  ok(dFull.startsWith("Base · Liquidity $1.00M · Vol 24h $2.00M."), "description: " + dFull);
  const dBare = og.ogDescription(null);
  ok(dBare.startsWith("Base. "), "description without data: " + dBare);
  ok(!dBare.includes("Liquidity") && !dBare.includes("Vol 24h"),
     "an unknown figure was printed anyway: " + dBare);
  ok(!dBare.includes("undefined") && !dBare.includes("null") && !dBare.includes("$—"),
     "the description leaked a placeholder: " + dBare);

  /* verdict در توضیح — جمله‌ی verdict همیشه *اول* می‌آید چون تلگرام دم را
     می‌بُرد؛ رشته‌ی «امروز» زیر دست‌نویس شده، نه بازمحاسبه از خودِ تابع،
     وگرنه این probe هیچ‌چیزی را اثبات نمی‌کرد. */
  const VERDICT_META = { liquidity: "$1.00M", vol24: "$2.00M" };
  const TODAY_DESC = "Base · Liquidity $1.00M · Vol 24h $2.00M. Check whether you can sell it " +
    "back before you buy — exit simulation and risk flags, no wallet needed.";
  ok(og.ogDescription(VERDICT_META) === TODAY_DESC,
     "ogDescription called without a second argument at all must be byte-for-byte the old "
     + "string: " + og.ogDescription(VERDICT_META));
  ok(og.ogDescription(VERDICT_META, undefined) === TODAY_DESC,
     "ogDescription(meta, undefined) must be byte-for-byte the old string: " +
     og.ogDescription(VERDICT_META, undefined));
  ok(og.ogDescription(VERDICT_META, "who knows") === TODAY_DESC,
     "a junk verdict value must not change the description at all: " +
     og.ogDescription(VERDICT_META, "who knows"));
  ok(og.ogDescription(VERDICT_META, "sell") === "A sell route was quoted. " + TODAY_DESC,
     "sell verdict sentence missing or misworded: " + og.ogDescription(VERDICT_META, "sell"));
  ok(og.ogDescription(VERDICT_META, "nosell") ===
     "No sell route quoted — you may not be able to exit. " + TODAY_DESC,
     "nosell verdict sentence missing or misworded: " + og.ogDescription(VERDICT_META, "nosell"));
  ok(og.ogDescription(VERDICT_META, "sell").indexOf("A sell route was quoted.") === 0,
     "the sell sentence must be the very first thing in the description — Telegram cuts the tail");
  ok(og.ogDescription(VERDICT_META, "nosell").indexOf("No sell route quoted") === 0,
     "the nosell sentence must be the very first thing in the description — Telegram cuts the tail");
  console.log("[og description] verdict sentence goes first, wording is exact (\"quoted\", not "
    + "\"simulated\"/\"safe\"), and an absent or junk verdict leaves the string byte-for-byte "
    + "unchanged");

  /* تگ‌ها */
  const addr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const tags = og.ogTags({ symbol: "USDC", name: "USD Coin", liquidity: "$1.00M" },
                         addr, "https://zaexa.com");
  ok((tags.match(/property="og:title"/g) || []).length === 1,
     "ogTags produced more than one og:title");
  ok(tags.includes('content="https://zaexa.com/og.png?v=' + og.OG_IMAGE_V + '"'),
     "og:image must be absolute and versioned: " + tags);
  ok(tags.includes('content="https://zaexa.com/t/' + addr + '"'),
     "og:url is not the canonical token url");
  ok(tags.includes('name="twitter:card" content="summary_large_image"'),
     "without summary_large_image X shows a thumbnail, not a card");
  ok(!/content="[^"]*<[^"]*"/.test(tags), "a raw < survived inside a content attribute");
  const evil = og.ogTags({ symbol: "EVIL", name: '"><script>x</script>' },
                         addr, "https://zaexa.com");
  ok(!evil.includes("<script>"), "a hostile token name escaped the attribute");

  /* ogTags با همان سه آرگومانِ همیشگی (بدونِ verdict) نباید هیچ جمله‌ی
     verdict‌ای اضافه کند — کالر قدیمی که این آرگومان تازه را نمی‌فرستد
     باید بایت‌به‌بایت همان چیزی را ببیند که امروز می‌بیند. */
  ok(!tags.includes("sell route") && !tags.includes("No sell route"),
     "ogTags called with three arguments (no verdict) carries a verdict sentence anyway: " + tags);

  /* Worker → بالادست: کدام آدرس، و با کلید کجا می‌رود.
     ⚠️ اگر روزی شبکه‌ی دوم اضافه شد، این ثابت باید از مسیر بیاید. */
  ok(OG_NETWORK === "base", "OG_NETWORK is no longer base — the card would ask the wrong chain");

  /* جداییِ کلیدِ کشِ verdict — نباید هیچ‌وقت زیرِ کلیدی بنشیند که proxyGt هم
     می‌شناسد. اگر VD_CACHE_HOST با یکی از دو بالادستِ /gt یکی یا هم‌پیشوند
     می‌شد، پاسخِ بدونِ CORSِ ما می‌توانست زیرِ همان کلید بنشیند و فراخوانیِ
     بعدیِ /gt از داخلِ مرورگر با خطای CORS بشکند — دقیقاً همان چیزی که این
     میزبانِ جداگانه قرار است ازش دور بماند. */
  for (const up of [UPSTREAM_FREE, UPSTREAM_KEYED]) {
    const upHost = new URL(up).host; // مقایسه روی *میزبان*، نه روی رشته‌ی کاملِ URL —
    // VD_CACHE_HOST خودش بدونِ scheme است، پس مقایسه‌ی رشته‌ای مستقیم با
    // "https://…" هرگز برابر نمی‌شد و این probe چیزی را نمی‌سنجید.
    ok(VD_CACHE_HOST !== upHost, "VD_CACHE_HOST equals an upstream host: " + VD_CACHE_HOST);
    ok(!upHost.startsWith(VD_CACHE_HOST) && !VD_CACHE_HOST.startsWith(upHost),
       "VD_CACHE_HOST is a prefix of (or is prefixed by) an upstream host: " +
       VD_CACHE_HOST + " vs " + upHost);
  }
  // کلیدِ کشِ verdict هرگز شکلی که PATH_OK می‌پذیرد ندارد — با میزبانِ جدا
  // این خودش امن است، ولی صریح سنجیده می‌شود تا هرکسی که این دو را روزی
  // زیرِ یک host مشترک ادغام کرد بلافاصله همین‌جا رد شود.
  for (const a of ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xAbCdEf0000000000000000000000000000dEaD"]) {
    const rest = "v1/" + OG_NETWORK + "/" + a.toLowerCase();
    ok(!PATH_OK.test(rest), "the verdict cache key's path shape is accepted by PATH_OK: " + rest);
  }
  console.log("[verdict cache isolation] VD_CACHE_HOST shares no prefix with either /gt "
    + "upstream, and its key shape never matches PATH_OK");
  sent = []; sentHeaders = [];
  reply = json({ data: { attributes: { name: "USD Coin", symbol: "USDC",
                                       total_reserve_in_usd: "12400000" } } });
  let meta = await ogFetchMeta(addr, { CG_KEY: KEY });
  ok(sent[0] === "https://api.coingecko.com/api/v3/onchain/networks/base/tokens/" + addr,
     "wrong upstream url for the card: " + sent[0]);
  ok(sentHeaders[0] && sentHeaders[0]["x-cg-demo-api-key"] === KEY,
     "the card lookup did not carry the api key");
  ok(meta && meta.symbol === "USDC" && meta.liquidity === "$12.40M",
     "the card did not read the token: " + JSON.stringify(meta));

  /* «نمی‌دانم» نباید به «صفحه‌ی شکسته» ترجمه شود: هر شکست → null → کارت عمومی. */
  reply = new Response("nope", { status: 500 });
  ok(await ogFetchMeta(addr, {}) === null, "a 500 upstream should give no metadata");
  reply = new Response("not json", { status: 200,
                                     headers: { "content-type": "application/json" } });
  ok(await ogFetchMeta(addr, {}) === null, "a broken body should give no metadata");
  reply = new Error("network is down");
  ok(await ogFetchMeta(addr, {}) === null, "a network failure should give no metadata");

  /* تصویر کارت از خودِ Worker می‌آید، نه از فایل‌های ثابت — چون در `_site`
     نیست و اگر به ASSETS می‌رفت ۴۰۴ می‌گرفت و کارت بی‌تصویر می‌ماند. */
  let askedOg = [];
  const ogEnv = { ASSETS: { fetch: async (r) => {
    askedOg.push(new URL(r.url).pathname);
    return new Response("the site", { status: 200 });
  } } };
  const img = await worker.fetch(new Request(ORIGIN + "/og.png?v=1"), ogEnv, {});
  const bytes = new Uint8Array(await img.arrayBuffer());
  ok(img.status === 200 && img.headers.get("content-type") === "image/png",
     "/og.png did not serve a png (" + img.status + ")");
  ok(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
     "/og.png is not actually a png");
  ok(bytes.length > 100000, "/og.png looks truncated (" + bytes.length + " bytes)");
  ok(askedOg.length === 0, "/og.png was handed to ASSETS: " + JSON.stringify(askedOg));

  /* اتگ باید هشِ همان بایت‌هایی باشد که واقعاً سرو می‌شوند.

     این نگهبان از یک شکافِ خاموش آمد: هیچ تستی اتگ را با تصویر نمی‌سنجید.
     تست ۳۰۴ فقط هر اتگی را که سرور داد به خودش پس می‌دهد، پس یک اتگِ کهنه
     از همه‌ی تست‌ها سبز رد می‌شد — و چون هدر `cache-control: immutable`
     است، کلادفلر تا ابد تصویر قدیمی را می‌داد. یعنی تصویر عوض می‌شد،
     همه‌ی تست‌ها سبز بودند، و کاربر هیچ‌وقت تصویر تازه را نمی‌دید. */
  const shouldEtag = '"' + createHash("sha256").update(bytes).digest("hex").slice(0, 16) + '"';
  ok(OG_PNG_ETAG === shouldEtag,
     "OG_PNG_ETAG is stale: the file says " + OG_PNG_ETAG + " but the bytes served hash to " +
     shouldEtag + " — bump it, or Cloudflare keeps serving the old card forever");

  console.log("[og] card text, escaping, upstream call and /og.png ok " +
              "(injection itself: worker/og_live_test.mjs)");
  console.log("[og etag] OG_PNG_ETAG matches the bytes actually served: " + OG_PNG_ETAG);
}

/* ---- ۱۱. محدودکننده‌ی نرخ — درون‌ایزوله، بدون هیچ بایندینگ ----
   هدف: یک اسکریپت که از یک IP می‌کوبد بعد از سقف رد شود؛ IP دیگری در همان
   پنجره اثر نبیند؛ جلورفتنِ ساعت پنجره را از نو باز کند؛ ۴۲۹ِ /gt همچنان
   CORS داشته باشد؛ و Map نه بی‌سقف رشد کند و نه خودِ IP را نگه دارد. */
{
  const { rateOk, rlHits, RL_LIMIT, RL_WINDOW_MS } = await import("./index.js");
  ok(RL_LIMIT === 120, "the rate limit is no longer 120 — it must not be tightened: " + RL_LIMIT);
  ok(RL_WINDOW_MS === 60000, "the rate limit window is no longer 60000ms: " + RL_WINDOW_MS);

  function reqIp(ip) {
    return new Request(ORIGIN + "/x", { headers: { "cf-connecting-ip": ip } });
  }

  // الف) ۱۲۰ درخواست از یک IP در یک سطل عبور می‌کند، ۱۲۱‌ام رد می‌شود
  const now0 = 1_700_000_000_000;
  let lastAllowed = false;
  for (let i = 0; i < RL_LIMIT; i++)
    lastAllowed = rateOk(reqIp("1.2.3.4"), "rl-a", RL_LIMIT, RL_WINDOW_MS, now0);
  ok(lastAllowed === true, "the " + RL_LIMIT + "th request in a fresh window should still pass");
  ok(rateOk(reqIp("1.2.3.4"), "rl-a", RL_LIMIT, RL_WINDOW_MS, now0) === false,
    "the " + (RL_LIMIT + 1) + "th request in the same window should be refused");

  // ب) IP دیگری در همان سطل و همان پنجره اصلاً اثر نمی‌بیند
  ok(rateOk(reqIp("5.6.7.8"), "rl-a", RL_LIMIT, RL_WINDOW_MS, now0) === true,
    "a different IP sharing the same bucket and window must have its own budget");

  // ج) گذشتنِ کاملِ پنجره دوباره اجازه می‌دهد — به همان IPِ بسته‌شده
  ok(rateOk(reqIp("1.2.3.4"), "rl-a", RL_LIMIT, RL_WINDOW_MS, now0 + RL_WINDOW_MS) === true,
    "advancing the clock past the window must reopen the same client's budget");

  // د) ۴۲۹ِ خودِ /gt باید CORS داشته باشد وگرنه صفحه با قطعیِ شبکه اشتباهش می‌گیرد
  for (let i = 0; i < RL_LIMIT; i++) {
    reply = json({ data: [] });
    await call("/gt/networks/base/tokens/0xratelimit",
      { headers: { "cf-connecting-ip": "203.0.113.200" } });
  }
  reply = json({ data: [] });
  const rl429 = await call("/gt/networks/base/tokens/0xratelimit",
    { headers: { "cf-connecting-ip": "203.0.113.200" } });
  ok(rl429.status === 429,
    "the " + (RL_LIMIT + 1) + "th /gt request from one IP should be rate-limited (got " +
    rl429.status + ")");
  ok(rl429.headers.get("access-control-allow-origin") === "*",
    "a rate-limited /gt response has no CORS header — the browser turns it into an opaque "
    + "network error and the page's circuit breaker mis-reads it");
  ok(rl429.headers.get("retry-after") === "60",
    "a rate-limited response must say retry-after: 60 (got " +
    rl429.headers.get("retry-after") + ")");

  // ه) حافظه‌ی نامحدود خودش یک ازکارافتادگی است: ۶۰۰۰ IP متمایز نباید Map
  //    را بی‌سقف نگه دارد.
  for (let i = 0; i < 6000; i++)
    rateOk(reqIp("198.51.100." + (i % 256) + "-" + i), "rl-mem", 999999, 999999999, now0);
  ok(rlHits.size <= 5000, "rlHits grew past its hard bound: size=" + rlHits.size);

  // و) کلید Map باید همیشه عدد باشد — هرگز رشته‌ای که خودِ IP را در خودش دارد.
  //    این مرزِ حریم خصوصیِ محدودکننده است: یک IP خام حتی در حافظه هم IP است.
  const SECRET_IP = "198.51.100.77-secret";
  rateOk(reqIp(SECRET_IP), "rl-priv", RL_LIMIT, RL_WINDOW_MS, now0);
  let sawNonNumberKey = false, sawIpInKey = false;
  for (const k of rlHits.keys()) {
    if (typeof k !== "number") sawNonNumberKey = true;
    if (String(k).includes(SECRET_IP)) sawIpInKey = true;
  }
  ok(!sawNonNumberKey, "rlHits has a non-numeric key — it must be keyed by a hash, never a string");
  ok(!sawIpInKey, "AN IP ADDRESS LEAKED INTO THE RATE LIMITER'S MAP KEY: " + SECRET_IP);

  console.log("[rate limit] " + RL_LIMIT + "/" + RL_WINDOW_MS + "ms per bucket per hashed IP; "
    + "independent IPs unaffected; window reopens; /gt 429 carries CORS; rlHits bounded at "
    + rlHits.size + " after a 6000-IP flood");
}

/* ---- ۱۲. verdict.js — «آیا هنوز جایی این توکن به فروش می‌رسد؟» ----
   ماژول pure است و هنوز به هیچ Workerی وصل نشده؛ فقط خودِ ماژول این‌جا
   سنجیده می‌شود.

   کِکاک۲۵۶ در Node بدونِ کتابخانه نیست، پس سلکتورها و چک‌سام‌ها را با
   ethersِ وندورشده‌ی خودِ مخزن (web/ethers.umd.min.*.js) مستقل بازمحاسبه
   می‌کنیم. نامِ فایل هرباز که باندل ساخته شود عوض می‌شود، پس با
   fs.readdirSync پیدایش می‌کنیم، نه هاردکدِ نام.

   ⚠️ این مخزن ریشه‌اش "type":"module" دارد، پس این .js با require معمولی
   ESM دیده می‌شود و باندلِ UMD چیزی به‌عنوان named export نمی‌دهد — ولی
   همان باندل، چون require را ندید، شاخه‌ی fallbackِ خودش را می‌رود و
   globalThis.ethers را پر می‌کند؛ همان‌جا می‌خوانیمش. */
const vd = await import("./verdict.js");
const webDir = new URL("../web/", import.meta.url);
const ethersFile = fs.readdirSync(webDir).find((f) => /^ethers\.umd\.min\..*\.js$/.test(f));
if (!ethersFile) throw new Error("could not find the vendored ethers bundle under web/");
createRequire(import.meta.url)(new URL(ethersFile, webDir).pathname);
const ethers = globalThis.ethers;

/* --- ۱۲.۱ نگهبانِ سلکتور --- هرچهار سلکتور از رویِ امضای کاملش با
   ethers.id بازمحاسبه می‌شود؛ یک سلکتورِ دستیِ بی‌تست دقیقاً همان کلاس
   باگی است که این مخزن را یک بار گزیده. */
{
  const sigs = {
    SEL_CL_UINT24: "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
    SEL_CL_INT24: "quoteExactInputSingle((address,address,uint256,int24,uint160))",
    SEL_SOLIDLY: "getAmountsOut(uint256,(address,address,bool,address)[])",
    SEL_V2: "getAmountsOut(uint256,address[])",
  };
  for (const [name, sig] of Object.entries(sigs)) {
    const want = ethers.id(sig).slice(0, 10);
    ok(vd[name] === want,
      name + " is stale: file says " + vd[name] + " but \"" + sig + "\" hashes to " + want);
  }
}

/* --- ۱۲.۲ نگهبانِ چک‌سام --- این مخزن یک‌بار با یک حرفِ کوچکِ اشتباه در
   یک آدرس شکسته بود؛ هر آدرسِ جدولِ صرافی‌ها + WETH + USDC از رویِ
   ethers.getAddress عوض نمی‌شود. */
{
  const addrs = [["WETH_ADDR", vd.WETH_ADDR], ["USDC_ADDR", vd.USDC_ADDR]];
  for (const row of vd.VD_VENUES) {
    addrs.push([row.id + ".to", row.to]);
    if (row.factory) addrs.push([row.id + ".factory", row.factory]);
  }
  ok(addrs.length === 2 + vd.VD_VENUES.length + 1, "expected exactly one factory address (aerodrome)");
  for (const [label, a] of addrs) {
    let checksummed;
    try { checksummed = ethers.getAddress(a); } catch { checksummed = null; }
    ok(checksummed === a, "address is not correctly checksummed for " + label + ": " + a);
  }
}

/* --- ۱۲.۳ طلای رمزگذاری --- کالدیتای دست‌ساز باید بایت‌به‌بایت با
   ethers.Interface یکی باشد؛ این چیزی است که خودِ رمزگذارِ دستی را اثبات
   می‌کند، نه فقط شکل‌های ایستا. */
{
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const amt = 123456789n;

  const ifaceU = new ethers.Interface([
    "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
  const ifaceI = new ethers.Interface([
    "function quoteExactInputSingle((address,address,uint256,int24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
  const ifaceV2 = new ethers.Interface(["function getAmountsOut(uint256,address[]) returns (uint256[])"]);
  const ifaceSolidly = new ethers.Interface([
    "function getAmountsOut(uint256,(address,address,bool,address)[]) returns (uint256[])"]);

  const probe = vd.buildProbe(TOKEN, vd.WETH_ADDR, amt);
  ok(probe.length === 16, "buildProbe should produce exactly 16 calls (3+3+5+2+1+1+1), got " + probe.length);

  for (const p of probe) {
    const row = vd.VD_VENUES.find((r) => r.id === p.id);
    let want;
    if (row.kind === "CL_UINT24") {
      want = ifaceU.encodeFunctionData("quoteExactInputSingle", [[TOKEN, vd.WETH_ADDR, amt, p.key, 0]]);
    } else if (row.kind === "CL_INT24") {
      want = ifaceI.encodeFunctionData("quoteExactInputSingle", [[TOKEN, vd.WETH_ADDR, amt, p.key, 0]]);
    } else if (row.kind === "SOLIDLY") {
      want = ifaceSolidly.encodeFunctionData("getAmountsOut",
        [amt, [[TOKEN, vd.WETH_ADDR, p.key, row.factory]]]);
    } else if (row.kind === "V2") {
      want = ifaceV2.encodeFunctionData("getAmountsOut", [amt, [TOKEN, vd.WETH_ADDR]]);
    }
    ok(p.data === want, row.kind + " encoding mismatch for " + p.id + "/" + p.key + ":\n  got  " +
      p.data + "\n  want " + want);
    ok(p.to === row.to, "wrong contract address for " + p.id);
  }

  // خودِ کاناری هم همین امضا را می‌گیرد، با مقادیرِ ثابتش
  const canary = vd.canaryCall();
  const wantCanary = ifaceU.encodeFunctionData("quoteExactInputSingle",
    [[vd.WETH_ADDR, vd.USDC_ADDR, 10000000000000000n, 500, 0]]);
  ok(canary.data === wantCanary, "canaryCall encoding mismatch:\n  got  " + canary.data +
    "\n  want " + wantCanary);
  ok(canary.to === vd.VD_VENUES[0].to, "canaryCall must hit the uniswap-v3 quoter, the pool's liveness "
    + "reference, not some other contract");
}

/* --- ۱۲.۴ رمزگشایی --- */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (amountOut) => "0x" + w(amountOut) + w(0) + w(0) + w(0);

  const ifaceArr = new ethers.Interface(["function f() returns (uint256[])"]);
  const arr3 = ifaceArr.encodeFunctionResult("f", [[10n, 20n, 30n]]);
  ok(vd.decodeQuote("V2", arr3) === 30n,
    "decodeQuote must take the LAST element of a uint256[], not assume exactly two entries");
  ok(vd.decodeQuote("SOLIDLY", arr3) === 30n, "decodeQuote(SOLIDLY) must take the last element too");

  ok(vd.decodeQuote("V2", "0x") === null, "decodeQuote must be null for an empty \"0x\" array return");
  ok(vd.decodeQuote("CL_UINT24", "0x") === null, "decodeQuote must be null for an empty \"0x\" static return");

  ok(vd.decodeQuote("V2", "0x1234") === null, "decodeQuote must be null for truncated garbage (array)");
  ok(vd.decodeQuote("CL_UINT24", "0x1234") === null, "decodeQuote must be null for truncated garbage (static)");

  const ifaceStatic = new ethers.Interface(["function g() returns (uint256,uint160,uint32,uint256)"]);
  const staticRet = ifaceStatic.encodeFunctionResult("g", [777n, 5n, 6n, 8n]);
  ok(vd.decodeQuote("CL_UINT24", staticRet) === 777n,
    "decodeQuote(CL_UINT24) must take the FIRST word (amountOut), not the last");
  ok(vd.decodeQuote("CL_INT24", staticRet) === 777n, "decodeQuote(CL_INT24) must take the first word too");
}

/* --- ۱۲.۵ verdictFrom --- قلبِ کار؛ یک probe به‌ازای هر قاعده. */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (amountOut) => "0x" + w(amountOut) + w(0) + w(0) + w(0);
  const mkArray = (vals) => "0x" + w(0x20) + w(vals.length) + vals.map(w).join("");
  const aliveCanary = { result: mkStatic4(5) };

  // الف) مثبت همیشه برنده است، هرچه‌ی دیگر هم اتفاق افتاده باشد
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ kind: "CL_UINT24", error: { code: 3 } }, { kind: "V2", result: mkArray([0n, 42n]) }],
  }) === "sell", "a single positive item must win over reverts elsewhere");

  // ب) کاناریِ مرده → نامعلوم، حتی اگر همه رد شده باشند
  ok(vd.verdictFrom({
    canary: { error: { code: 3 } },
    items: [{ kind: "V2", error: { code: 3 } }, { kind: "CL_UINT24", error: { code: -32000 } }],
  }) === null, "a dead canary must make the verdict unknown, even when every item reverted — "
    + "we never call a token unsellable on an endpoint that could not even price WETH→USDC");

  // ج) همه ریوِرت + کاناریِ زنده → nosell
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "CL_UINT24", error: { code: 3 } },
      { kind: "CL_INT24", error: { code: -32000 } },
      { kind: "V2", result: "0x" },
      { kind: "SOLIDLY", result: mkArray([0n]) },
    ],
  }) === "nosell", "all-proven-negative items with a live canary must give nosell");

  // د) یک کدِ خطای دیگر (نه ۳، نه -۳۲۰۰۰) میانِ ریوِرت‌ها → نامعلوم
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ kind: "CL_UINT24", error: { code: 3 } }, { kind: "V2", error: { code: -32603 } }],
  }) === null, "an error code other than 3/-32000 is not a proven negative — one such item must "
    + "make the whole verdict unknown, not nosell");

  // ه) "0x" خودش به‌تنهایی اثباتی است
  ok(vd.verdictFrom({ canary: aliveCanary, items: [{ kind: "V2", result: "0x" }] }) === "nosell",
    "an empty \"0x\" return must count as a proven negative on its own");

  // و) صفرِ رمزگشایی‌شده هم اثباتی است
  ok(vd.verdictFrom({ canary: aliveCanary, items: [{ kind: "CL_UINT24", result: mkStatic4(0) }] }) === "nosell",
    "a decoded zero must count as a proven negative on its own");

  // ز) فهرستِ پروبِ خالی، حتی با کاناریِ زنده، چیزی را اثبات نمی‌کند —
  // هیچ صرافی‌ای پرسیده نشده، پس نه sell است نه nosell.
  ok(vd.verdictFrom({ canary: aliveCanary, items: [] }) === null,
    "an empty probe list must be unknown, not nosell — nothing was actually asked");
  ok(vd.verdictFrom({ canary: aliveCanary }) === null,
    "a missing items array (defaults to empty) must also be unknown, not nosell");

  console.log("[verdict rules] positive wins; dead canary -> unknown; all-proven-negative -> "
    + "nosell; an unproven error -> unknown; \"0x\" and zero each proven on their own; an empty "
    + "probe list -> unknown");
}

/* --- ۱۲.۶ sellAmountFrom --- */
{
  ok(vd.sellAmountFrom(2000, 18) === 5n * 10n ** 16n,
    "$100 of a token priced at $2000 with 18 decimals should be 0.05 tokens raw, got " +
    vd.sellAmountFrom(2000, 18));
  ok(vd.sellAmountFrom(1, 6) === 100000000n,
    "$100 of a $1 token with 6 decimals should be 100e6 raw, got " + vd.sellAmountFrom(1, 6));
  ok(vd.sellAmountFrom("2000", 18) === 5n * 10n ** 16n, "sellAmountFrom must accept a price given as a string");
  ok(vd.sellAmountFrom(0, 18) === null, "a zero price must give null, not zero");
  ok(vd.sellAmountFrom(null, 18) === null, "a missing price must give null — \"I don't know\" must never act like \"no\"");
  ok(vd.sellAmountFrom(undefined, 18) === null, "an undefined price must give null");
  ok(vd.sellAmountFrom(NaN, 18) === null, "a NaN price must give null");
  ok(vd.sellAmountFrom(-5, 18) === null, "a negative price must give null");
  ok(vd.sellAmountFrom("abc", 18) === null, "a non-numeric price string must give null");
  ok(vd.sellAmountFrom(2000, 37) === null, "decimals above 36 must give null");
  ok(vd.sellAmountFrom(2000, -1) === null, "negative decimals must give null");
  ok(vd.sellAmountFrom(2000, 1.5) === null, "non-integer decimals must give null");
  ok(vd.sellAmountFrom(1e30, 0) === null, "a price so high the notional floors to zero raw units must "
    + "give null, not zero");
  console.log("[sellAmountFrom] normal 18/6-decimal cases match hand-computed integers; every bad "
    + "input (price <=0/NaN/missing/non-numeric, decimals outside 0..36, floors-to-zero) gives null");
}

/* --- ۱۲.۷ fetchVerdict --- با fetchImpl جعلی، بدونِ هیچ شبکه‌ای. */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (amountOut) => "0x" + w(amountOut) + w(0) + w(0) + w(0);
  const jsonRes = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const TOKEN = "0x2222222222222222222222222222222222222222";
  const meta = { decimals: 18, priceUsd: 2000 };
  const usdcHexLower = vd.USDC_ADDR.slice(2).toLowerCase();

  // الف) پاسخِ به‌هم‌ریخته: کاناری آخرِ آرایه، آیتم‌ها هم برعکسِ ترتیبِ
  // درخواست — اگر تطبیق روی موقعیت به‌جای id بود، اینجا قطعاً به‌هم می‌ریخت،
  // چون شکلِ رمزگشاییِ کاناری با آیتم‌ها یکی نیست.
  {
    const fetchImpl = async (url, init) => {
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(999) : "0x" });
      body.reverse(); // ترتیبِ آرایه‌ی پاسخ را عمداً برعکس می‌کنیم
      return jsonRes(body);
    };
    const res = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc.example"] });
    ok(res === "sell", "a reordered batch must still be matched by id, not by array position "
      + "(got " + res + ")");
  }

  // ب) مرحله‌ی A نامعلوم/nosell → مرحله‌ی B مثبت → نتیجه‌ی نهایی sell
  {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls++;
      const reqs = JSON.parse(init.body);
      const isStageB = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
      const body = reqs.map((r) => {
        if (r.id === 0) return { id: 0, result: mkStatic4(5) };
        if (!isStageB) return { id: r.id, result: "0x" };
        return { id: r.id, result: r.id === 1 ? mkStatic4(999) : "0x" };
      });
      return jsonRes(body);
    };
    const res = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc.example"] });
    ok(res === "sell", "stage A nosell followed by a stage B positive must return sell (got " + res + ")");
    ok(calls === 2, "stage B must only run once stage A came back nosell (2 fetch calls expected, got " + calls + ")");
  }

  // ج) اندپوینتِ اول پرتاب می‌کند → اندپوینتِ دوم جواب می‌دهد
  {
    let calls = 0;
    const rpcs = ["https://rpc-bad.example", "https://rpc-good.example"];
    const fetchImpl = async (url, init) => {
      calls++;
      if (url === rpcs[0]) throw new Error("network is down");
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, result: "0x" });
      return jsonRes(body);
    };
    const res = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs });
    ok(res === "nosell", "a throw on the first endpoint must not sink the whole call — the second "
      + "endpoint should still be tried (got " + res + ")");
    ok(calls === 3, "expected 1 (failed) + 2 (stage A + stage B on the second endpoint) = 3 calls, got " + calls);
  }

  // د) مهلت گذشته → نامعلوم، بدونِ حتی یک فراخوانیِ شبکه
  {
    let calls = 0;
    const fetchImpl = async () => { calls++; return jsonRes([]); };
    let res = await vd.fetchVerdict(TOKEN, meta, {
      fetchImpl, now: () => 10_000, deadlineAt: 5_000, rpcs: ["https://rpc.example"],
    });
    ok(res === null && calls === 0, "past the deadline fetchVerdict must return null without any "
      + "fetch call (got " + res + ", " + calls + " calls)");

    res = await vd.fetchVerdict(TOKEN, meta, {
      fetchImpl, now: () => 9_700, deadlineAt: 10_000, rpcs: ["https://rpc.example"],
    }); // فقط ۳۰۰ میلی‌ثانیه مانده، کمتر از ۴۰۰
    ok(res === null && calls === 0, "fewer than 400ms left must also stop before any fetch "
      + "(got " + res + ", " + calls + " calls)");
  }

  // ه) پاسخِ غیر-۲۰۰ روی هر دو اندپوینت → نامعلوم
  {
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response("boom", { status: 500 }); };
    const res = await vd.fetchVerdict(TOKEN, meta, {
      fetchImpl, rpcs: ["https://rpc-a.example", "https://rpc-b.example"],
    });
    ok(res === null, "a non-200 upstream response must give null (got " + res + ")");
    ok(calls === 2, "a non-200 must try the second endpoint too, and stop at 2 (got " + calls + " calls)");
  }

  // و) sellAmountFrom(null) → بدونِ حتی یک فراخوانی
  {
    let calls = 0;
    const fetchImpl = async () => { calls++; return jsonRes([]); };
    const res = await vd.fetchVerdict(TOKEN, { decimals: 18, priceUsd: null }, { fetchImpl, rpcs: ["https://rpc.example"] });
    ok(res === null && calls === 0, "an unpriceable token must return null before any fetch "
      + "(got " + res + ", " + calls + " calls)");
  }

  console.log("[fetchVerdict] id-matched batches, stage A->B escalation, endpoint failover "
    + "(max 2), deadline enforced with zero calls, non-200 handled, unpriced tokens skip the "
    + "network entirely — all against an injected fake, no real RPC involved");
}

/* ---- ۱۳. ogFetchVerdict — سیم‌کشیِ verdict داخل worker/index.js ----
   برخلافِ fetchVerdict که خودش پارامتری است، ogFetchVerdict مستقیماً از
   کشِ لبه و از globalThis.fetch استفاده می‌کند؛ اینجا هر دو را جعل می‌کنیم. */
{
  const { ogFetchVerdict } = await import("./index.js");
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (amountOut) => "0x" + w(amountOut) + w(0) + w(0) + w(0);
  const meta = { decimals: 18, priceUsd: 2000 };

  // الف) بدونِ متادیتا حتی یک تلاش هم نمی‌کند
  ok(await ogFetchVerdict("0x" + "1".repeat(40), null, Date.now() + 2000, {}, {}) === null,
     "ogFetchVerdict without meta must return null with no work at all");

  const shelf = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => { const v = shelf.get(req.url); return v ? v.clone() : undefined; },
      put: async (req, r) => { shelf.set(req.url, r); },
    },
  };
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };

  // ب) میسِ کش → fetchVerdict واقعاً صدا زده می‌شود و نتیجه در کش می‌نشیند
  const TOKEN_SELL = "0x" + "2".repeat(40);
  let calls = 0;
  globalThis.fetch = async (u, o) => {
    calls++;
    const reqs = JSON.parse(o.body);
    const body = reqs.map((r) =>
      r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, result: mkStatic4(999) });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  let v = await ogFetchVerdict(TOKEN_SELL, meta, Date.now() + 2000, {}, ctx);
  ok(v === "sell" && calls === 1,
     "a cache miss must call fetchVerdict once and surface its verdict (got " + v + ", " + calls + " calls)");
  await Promise.all(waited);
  ok(shelf.size === 1, "a resolved verdict must be written to the edge cache");
  for (const stashed of shelf.values()) {
    ok(stashed.headers.get("cache-control") === "public, max-age=300",
       "wrong cache lifetime for a cached verdict: " + stashed.headers.get("cache-control"));
    const stored = JSON.parse(await stashed.clone().text());
    ok(stored.verdict === "sell", "wrong verdict written to cache: " + JSON.stringify(stored));
  }

  // ج) هیت کش → بدونِ حتی یک فراخوانیِ تازه به fetchVerdict
  calls = 0;
  v = await ogFetchVerdict(TOKEN_SELL, meta, Date.now() + 2000, {}, ctx);
  ok(v === "sell" && calls === 0,
     "a cache hit must skip fetchVerdict entirely (calls=" + calls + ")");

  // د) هرگز یک verdictِ نامعلوم (null) را کش نکن — یک تعلیقِ گذرا نباید ۵
  // دقیقه‌ی خاموش شود.
  const TOKEN_UNKNOWN = "0x" + "3".repeat(40);
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  v = await ogFetchVerdict(TOKEN_UNKNOWN, meta, Date.now() + 2000, {}, ctx);
  ok(v === null, "an unreachable rpc must give a null verdict, not a broken card: got " + v);
  ok(shelf.size === 1, "A NULL VERDICT WAS WRITTEN TO THE CACHE — a transient RPC hiccup would "
    + "silently degrade the card for 5 whole minutes");

  // ه) مهلتِ deadlineAt باید واقعاً تا fetchVerdict برسد — یک مهلتِ گذشته
  // باید بدونِ حتی یک فراخوانیِ شبکه null بدهد.
  const TOKEN_LATE = "0x" + "4".repeat(40);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }); };
  v = await ogFetchVerdict(TOKEN_LATE, meta, Date.now() - 1000, {}, ctx);
  ok(v === null && calls === 0,
     "ogFetchVerdict must pass deadlineAt through to fetchVerdict end to end — a past deadline "
     + "should stop it before any network call (got " + v + ", " + calls + " calls)");

  delete globalThis.caches;
  // ⚠️ این بخش globalThis.fetch را چند بار برای آزمودنِ ogFetchVerdict عوض
  // کرد؛ اگر همین‌جا برنگردد، هر بخشِ بعدی که به sent/reply تکیه می‌کند
  // (مثلاً بخشِ ۱۴) بی‌صدا چیزی ثبت نمی‌بیند — نه یک FAILِ درست، بلکه یک
  // probe که همیشه به همان جواب می‌رسد چه باگ باشد چه نباشد.
  globalThis.fetch = trackingFetch;
  console.log("[og verdict wiring] no-meta short-circuit; cache miss calls fetchVerdict once and "
    + "writes the result; cache hit skips the network; an unknown verdict is never cached; "
    + "deadlineAt reaches fetchVerdict end to end");
}

/* ---- ۱۴. /vd/<address> — پروبِ تشخیصی، بدونِ کارت ----
   همان خط‌لوله‌ی کارت (ogFetchMeta سپس ogFetchVerdict) را صدا می‌زند؛
   اینجا فقط سیم‌کشیِ خودِ مسیر سنجیده می‌شود: متد، شکلِ آدرس، بستهٔ نرخِ
   جدا از «og»، و اینکه پاسخ همیشه JSON با cache-control: no-store است. */
{
  const { RL_LIMIT: RL, PATH_OK: PATH_OK_2 } = await import("./index.js");
  const ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  // الف) شکلِ درست، متادیتا موفق؛ همان fetch جعلی برای هر تلاشِ RPC هم
  // صدا زده می‌شود ولی هیچ‌وقت شکلِ یک batch واقعی را ندارد → v:null.
  reply = json({ data: { attributes: { name: "USD Coin", symbol: "USDC",
    total_reserve_in_usd: "1", decimals: 18, price_usd: "1" } } });
  let res = await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": "203.0.113.50" } });
  ok(res.status === 200, "a well-formed /vd request should be 200 (got " + res.status + ")");
  ok((res.headers.get("content-type") || "").includes("application/json"), "/vd must answer JSON");
  ok(res.headers.get("cache-control") === "no-store", "/vd must never be cached");
  const body = await res.json();
  ok("v" in body && "ms" in body, "/vd body is missing v/ms: " + JSON.stringify(body));
  ok(body.v === null,
     "with no real RPC batch ever answering, /vd should say v:null, not error or hang: " +
     JSON.stringify(body));
  ok(typeof body.ms === "number" && body.ms >= 0, "ms should be a non-negative number: " +
     JSON.stringify(body));

  // ب) متد غیرِ GET
  reply = json({ data: {} });
  res = await call("/vd/" + ADDR, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.51" } });
  ok(res.status === 405, "/vd should refuse non-GET (got " + res.status + ")");

  // ج) آدرسِ بدشکل
  for (const bad of ["/vd/not-an-address", "/vd/0xabc", "/vd/", "/vd"]) {
    reply = json({ data: {} });
    res = await call(bad, { headers: { "cf-connecting-ip": "203.0.113.52" } });
    ok(res.status === 400, "/vd should refuse a malformed address " + bad + " (got " + res.status + ")");
  }

  // د) بستهٔ نرخِ خودش «vd» است — سوزاندنِ سهمیه‌ی vd نباید og را بسوزاند
  const ip = "203.0.113.53";
  for (let i = 0; i < RL; i++) {
    reply = json({ data: {} });
    await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": ip } });
  }
  reply = json({ data: {} });
  res = await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": ip } });
  ok(res.status === 429,
     "the " + (RL + 1) + "th /vd request from one IP should be rate-limited (got " + res.status + ")");
  ok(res.headers.get("retry-after") === "60", "/vd's 429 must say retry-after: 60");

  // همان IP باید هنوز بتواند صفحه‌ی توکن (بستهٔ «og») را باز کند — بسته‌ها مستقل‌اند.
  // ⚠️ صفحه‌ی توکن روی سقف هم همیشه ۲۰۰ می‌دهد (تنزلِ باوقار)، پس خودِ کدِ
  // وضعیت اثباتی نیست؛ اثبات این است که متادیتا واقعاً از بالادست خوانده
  // شود — اگر «vd» با «og» یکی شده بود، این IP سهمیه‌ی og را هم قبلاً
  // سوزانده بود و metaPromise اصلاً ساخته نمی‌شد.
  const spyEnv = { ASSETS: { fetch: async () => new Response("the site", { status: 200 }) } };
  reply = json({ data: {} });
  res = await call("/t/" + ADDR, { headers: { "cf-connecting-ip": ip } }, spyEnv);
  ok(res.status === 200,
     "burning out the vd bucket must not rate-limit the og bucket for the same IP (got " +
     res.status + ")");
  ok(sent.length === 1,
     "the og bucket looks shared with vd — burning the vd bucket for this IP left 0 upstream " +
     "metadata calls for the token page (got " + sent.length + ")");

  // ه) شکلِ آدرسِ خامِ /vd هرگز چیزی نیست که PATH_OK بپذیرد
  ok(!PATH_OK_2.test(ADDR.toLowerCase()), "a raw /vd address must never match PATH_OK's shape");

  console.log("[vd diag] well-formed request -> {v, ms} JSON, no-store; non-GET 405; malformed "
    + "address 400; its own \"vd\" rate bucket independent of \"og\"; 429 carries retry-after");
}

/* ---- ۱۵. chains.js — تشخیصِ زنجیره از رویِ شکلِ آدرس ----
   بدونِ ابهام: هر رشته‌ای که EVM_ADDR بپذیرد با «0x» شروع می‌شود، یعنی
   نویسه‌ی اولش «0» است؛ الفبای SOL_MINT اصلاً نویسه‌ی «0» ندارد — نه فقط در
   جایگاهِ اول، در هیچ جایگاهی. پس این دو الگو ذاتاً جدا از همند، نه فقط در
   نمونه‌های زیر — ولی همان نمونه‌ها هم اینجا سنجیده می‌شوند. */
{
  const { EVM_ADDR, SOL_MINT, chainOf, gtNetworkOf } = await import("./chains.js");

  const BASE_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const SOL_ADDR = "So11111111111111111111111111111111111111112"; // خودِ wSOL mint
  ok(chainOf(BASE_ADDR) === "base", "a real Base address should resolve to \"base\": " + chainOf(BASE_ADDR));
  ok(chainOf(SOL_ADDR) === "solana", "a real Solana mint should resolve to \"solana\": " + chainOf(SOL_ADDR));

  // شکل‌های نزدیک‌به‌درست — همه باید نامعلوم بدهند، نه یکی از دو زنجیره
  const NEAR_MISS = [
    ["39 hex chars (one short)", "0x" + "a".repeat(39)],
    ["41 hex chars (one over)", "0x" + "a".repeat(41)],
    ["base58 31 chars (one short)", "1".repeat(31)],
    ["base58 45 chars (one over)", "1".repeat(45)],
    ["base58 containing 0", "1111111111111111111111111111110111"],
    ["base58 containing O", "1111111111111111111111111111111O11"],
    ["base58 containing I", "1111111111111111111111111111111I11"],
    ["base58 containing l", "1111111111111111111111111111111l11"],
    ["an empty string", ""],
    ["a 0x address with non-hex characters", "0x" + "g".repeat(40)],
  ];
  for (const [label, addr] of NEAR_MISS) {
    ok(chainOf(addr) === null, "chainOf should be null for " + label + " (" + JSON.stringify(addr) +
      "), got " + chainOf(addr));
  }

  // اثباتِ بدون‌ابهامی: هیچ آدرسِ Base ای هرگز شکلِ سولانا هم ندارد
  const BASE_SAMPLES = [
    "0x" + "0".repeat(36) + "dEaD",
    "0x4200000000000000000000000000000000000006",
    "0xffffffffffffffffffffffffffffffffffffffff",
  ];
  for (const a of BASE_SAMPLES) {
    ok(EVM_ADDR.test(a), "test fixture is not actually a valid Base address: " + a);
    ok(!SOL_MINT.test(a), "A BASE ADDRESS ALSO MATCHED SOL_MINT — the two shapes are no longer "
      + "unambiguous: " + a);
  }

  ok(gtNetworkOf("base") === "base", "gtNetworkOf(\"base\") should be \"base\"");
  ok(gtNetworkOf("solana") === "solana", "gtNetworkOf(\"solana\") should be \"solana\"");
  ok(gtNetworkOf("ethereum") === null, "gtNetworkOf of an unknown chain should be null, not a guess");
  ok(gtNetworkOf(null) === null, "gtNetworkOf(null) should be null");

  console.log("[chains] chainOf resolves real Base/Solana addresses correctly, every near-miss "
    + "shape (wrong length, forbidden base58 character, empty string, non-hex 0x) gives null, and "
    + "no address can ever match both EVM_ADDR and SOL_MINT at once");
}

/* ---- ۱۶. verdict_sol.js — رمزگذاری/رمزگشاییِ base58 و base64 ---- */
{
  const vs = await import("./verdict_sol.js");
  const decodedMint = vs.base58Decode(vs.SOL_MINT_ADDR);
  const decodedPayer = vs.base58Decode(vs.VD_SOL_PAYER);
  ok(decodedMint && decodedMint.length === 32,
    "base58Decode(SOL_MINT_ADDR) should be 32 bytes, got " + (decodedMint && decodedMint.length));
  ok(decodedPayer && decodedPayer.length === 32,
    "base58Decode(VD_SOL_PAYER) should be 32 bytes, got " + (decodedPayer && decodedPayer.length));

  ok(vs.base58Encode(decodedMint) === vs.SOL_MINT_ADDR,
    "base58 round-trip broke for the wSOL mint: " + vs.base58Encode(decodedMint));
  ok(vs.base58Encode(decodedPayer) === vs.VD_SOL_PAYER,
    "base58 round-trip broke for the payer address: " + vs.base58Encode(decodedPayer));

  ok(vs.base58Decode("") === null, "base58Decode of an empty string should be null");
  ok(vs.base58Decode("0OIl") === null, "base58Decode must refuse the four excluded characters");
  ok(vs.base58Decode(null) === null, "base58Decode of a non-string should be null");

  // صفرِ ابتدایی → «۱»ِ ابتدایی، رفت‌وبرگشت باید حفظش کند
  const zeros = new Uint8Array(32);
  ok(vs.base58Encode(zeros) === "1".repeat(32),
    "encoding 32 zero bytes should give 32 leading \"1\"s, got " + vs.base58Encode(zeros));
  const roundTrippedZeros = vs.base58Decode(vs.base58Encode(zeros));
  ok(roundTrippedZeros.length === 32 && roundTrippedZeros.every((b) => b === 0),
    "round-tripping 32 zero bytes through base58 lost the leading zeros");

  // base64 دستی هم باید رفت‌وبرگشت را حفظ کند — تمامِ داده‌ی دستورالعمل و
  // بایتِ نهاییِ تراکنشی که به simulateTransaction می‌رود از همین دو تابع رد می‌شود.
  for (const len of [0, 1, 2, 3, 4, 31, 32, 33]) {
    const raw = new Uint8Array(len);
    for (let i = 0; i < len; i++) raw[i] = (i * 37 + 5) % 256;
    const back = vs.base64ToBytes(vs.bytesToBase64(raw));
    ok(back && back.length === len && back.every((b, i) => b === raw[i]),
      "base64 round-trip broke for a " + len + "-byte buffer");
  }

  console.log("[base58/base64] decode/encode round-trip holds for the wSOL mint and the payer "
    + "address (both 32 bytes), leading zero bytes survive, the excluded base58 characters "
    + "(0/O/I/l) are refused, and base64 round-trips cleanly across several buffer lengths");
}

/* ---- ۱۷. verdict_sol.js — اندازه‌گیریِ اندازه‌ی سیم ----
   پیام‌های زیر دستی ساخته شده‌اند، نه از رویِ compileV0Message؛ عددِ موردِ
   انتظار هم دستی محاسبه شده (کنارِ هر بلوک نوشته شده چطور)، نه با شمردنِ
   دوباره از رویِ shortvecLen خودِ ماژول — وگرنه این تست هیچ‌چیزی را اثبات
   نمی‌کرد. */
{
  const vs = await import("./verdict_sol.js");

  // امضاها: shortvec(1)=۱ + ۱×۶۴=۶۴  → ۶۵
  // پیشوندِ نسخه + هدر: ۱+۳            → ۴
  // کلیدهای استاتیک: shortvec(2)=۱ + ۲×۳۲=۶۴ → ۶۵
  // recentBlockhash                    → ۳۲
  // شمارشِ دستورالعمل‌ها: shortvec(1)=۱ → ۱
  // دستورالعملِ تنها: ۱ (programIdIndex) + shortvec(1)=۱+۱=۲ (اندیس‌ها) +
  //                    shortvec(3)=۱+۳=۴ (دادهٔ ۳بایتی)              → ۷
  // جدول‌های آدرس: shortvec(0)=۱، بدونِ ورودی                        → ۱
  // جمع: ۶۵+۴+۶۵+۳۲+۱+۷+۱ = ۱۷۵
  const msg1 = {
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    staticAccountKeys: ["payer-placeholder", "program-placeholder"],
    recentBlockhash: "blockhash-placeholder",
    compiledInstructions: [
      { programIdIndex: 1, accountKeyIndexes: [0], data: new Uint8Array([1, 2, 3]) },
    ],
    addressTableLookups: [],
  };
  ok(vs.transactionWireSize(msg1) === 175,
    "hand-computed wire size mismatch: expected 175, got " + vs.transactionWireSize(msg1));

  // همان محاسبه، این‌بار با یک ورودیِ Address Lookup Table:
  // امضاها ۶۵؛ پیشوند+هدر ۴؛ کلیدهای استاتیک shortvec(1)=۱+۳۲=۳۳؛ blockhash
  // ۳۲؛ شمارشِ دستورالعمل ۱؛ دستورالعمل: ۱+(shortvec(2)=۱+۲=۳)+(shortvec(2)=۱+۲=۳)=۷؛
  // شمارشِ جدول ۱؛ ورودیِ جدول: ۳۲+(shortvec(2)=۱+۲=۳)+(shortvec(1)=۱+۱=۲)=۳۷.
  // جمع: ۶۵+۴+۳۳+۳۲+۱+۷+۱+۳۷ = ۱۸۰
  const msg2 = {
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
    staticAccountKeys: ["payer-placeholder"],
    recentBlockhash: "blockhash-placeholder",
    compiledInstructions: [
      { programIdIndex: 0, accountKeyIndexes: [1, 2], data: new Uint8Array([9, 9]) },
    ],
    addressTableLookups: [
      { accountKey: "table-placeholder", writableIndexes: [0, 1], readonlyIndexes: [2] },
    ],
  };
  ok(vs.transactionWireSize(msg2) === 180,
    "hand-computed wire size mismatch (with an ALT entry): expected 180, got " +
    vs.transactionWireSize(msg2));

  console.log("[wire size] transactionWireSize matches a hand-computed byte count for a small "
    + "fixed message, with and without an address-table-lookup entry");
}

/* ---- ۱۸. fetchVerdictSol — با fetchImpl جعلی، بدونِ هیچ RPC یا جوپیترِ واقعی ----
   این کانتینر به هیچ RPC سولانا یا api.jup.ag دسترسی ندارد؛ هرچه اینجا
   سنجیده می‌شود روی یک fetchImpl تزریق‌شده است، نه شبکه‌ی واقعی — پس این
   بخش هیچ ادعایی درباره‌ی رفتارِ زنده نمی‌کند، فقط درباره‌ی قواعدِ خودِ کد. */
{
  const vs = await import("./verdict_sol.js");

  function fakePubkey(n) {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = (n * 41 + i * 7 + 3) % 256;
    return vs.base58Encode(b);
  }
  function ixData(bytes) { return vs.bytesToBase64(Uint8Array.from(bytes)); }
  function rawIx(programId, accounts, dataBytes) {
    return {
      programId,
      accounts: accounts.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
      data: ixData(dataBytes),
    };
  }

  const PAYER = vs.VD_SOL_PAYER;
  const MINT = fakePubkey(100);
  const PROGRAM_CB = fakePubkey(1);
  const PROGRAM_SETUP = fakePubkey(2);
  const PROGRAM_SWAP = fakePubkey(3);
  const ATA_MINT = fakePubkey(4);
  const ATA_WSOL = fakePubkey(5);
  const WSOL_ACCT = fakePubkey(6);

  function makeLegs({ hugeSwapData = false } = {}) {
    const legBuy = {
      computeBudgetInstructions: [rawIx(PROGRAM_CB, [], [2, 0, 0, 0, 0])],
      setupInstructions: [rawIx(PROGRAM_SETUP, [[PAYER, true, true], [ATA_MINT, false, true]], [1])],
      swapInstruction: rawIx(PROGRAM_SWAP,
        [[PAYER, true, true], [ATA_MINT, false, true], [WSOL_ACCT, false, true]],
        hugeSwapData ? new Array(1400).fill(7) : [9, 9, 9, 9]),
      cleanupInstruction: null,
      addressLookupTableAddresses: [],
    };
    const legSell = {
      // ⚠️ کامپیوت‌بادجتِ leg فروش هم عمداً اینجا هست تا ثابت شود کدِ زیر
      // واقعاً *فقط از خرید* برمی‌دارد، نه اینکه تصادفاً هیچ‌کدام نداشته باشند.
      computeBudgetInstructions: [rawIx(PROGRAM_CB, [], [3, 0, 0, 0, 0])],
      setupInstructions: [rawIx(PROGRAM_SETUP, [[PAYER, true, true], [ATA_WSOL, false, true]], [1])],
      swapInstruction: rawIx(PROGRAM_SWAP,
        [[PAYER, true, true], [ATA_WSOL, false, true], [WSOL_ACCT, false, true]],
        [8, 8, 8, 8]),
      cleanupInstruction: rawIx(PROGRAM_SETUP, [[WSOL_ACCT, false, true]], [3]),
      addressLookupTableAddresses: [],
    };
    return { legBuy, legSell };
  }

  function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  function rpcOk(result) { return jsonRes({ jsonrpc: "2.0", id: 1, result }); }

  const RPC = "https://rpc.example";
  const JUP = vs.VD_SOL_JUP_BASE;

  function makeFetch({ legs, lamports = 2_000_000_000, heldRaw = null, simErr = "SUCCESS",
                       buyQuoteOk = true, buyQuoteEmpty = false, rpcStatus = {} } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (u.startsWith(JUP + "/swap/v1/quote")) {
        const isBuy = u.includes("onlyDirectRoutes=true");
        calls.push(isBuy ? "quote:buy" : "quote:sell");
        if (isBuy) {
          if (!buyQuoteOk) return jsonRes({ error: "no route" }, 404); // غیرِ ۲۰۰ → "jup"
          if (buyQuoteEmpty) return jsonRes({ routePlan: [] }); // ۲۰۰ ولی بدونِ outAmount → "no-route"
          return jsonRes({ outAmount: "1000000", routePlan: [{}] });
        }
        return jsonRes({ outAmount: "40000000", routePlan: [{}] });
      }
      if (u.startsWith(JUP + "/swap/v1/swap-instructions")) {
        const body = JSON.parse(init.body);
        const isBuy = body.quoteResponse.outAmount === "1000000";
        calls.push(isBuy ? "swap-ix:buy" : "swap-ix:sell");
        return jsonRes(isBuy ? legs.legBuy : legs.legSell);
      }
      const body = JSON.parse(init.body);
      calls.push("rpc:" + body.method);
      if (rpcStatus[body.method]) return new Response("boom", { status: rpcStatus[body.method] });
      if (body.method === "getBalance") return rpcOk({ value: lamports });
      if (body.method === "getTokenAccountsByOwner") {
        return rpcOk({ value: heldRaw == null ? [] :
          [{ account: { data: { parsed: { info: { tokenAmount: { amount: heldRaw } } } } } }] });
      }
      if (body.method === "simulateTransaction") {
        const err = simErr === "SUCCESS" ? null
          : simErr === "INSTR" ? { InstructionError: [1, { Custom: 6001 }] }
          : simErr;
        return rpcOk({ value: { err } });
      }
      return jsonRes({ error: { code: -1, message: "unexpected method " + body.method } }, 500);
    };
    return { fetchImpl, calls };
  }

  function opts(extra) {
    return Object.assign({ rpcs: [RPC], jupBase: JUP, payer: PAYER }, extra);
  }

  // کمکیِ مشترک: هر why مشاهده‌شده باید عضوِ فهرستِ منجمدِ VD_SOL_WHY باشد —
  // با پیمایشِ خودِ فهرست (Array.includes)، نه با کپی‌کردنِ دوباره‌ی آن در
  // این فایل؛ اگر فهرست روزی جابه‌جا شود، این چک هم خودش را همان لحظه به‌روز می‌بیند.
  function isFrozenWhy(why) { return vs.VD_SOL_WHY.includes(why); }

  // الف) مسیرِ سبز — هیچ چیزِ استثنایی، همه‌چیز موفق. یک sell هیچ کلیدِ
  // why‌ای ندارد، حتی به‌شکلِ undefined.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, simErr: "SUCCESS" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === "sell", "happy path should return { v: \"sell\" } (got " + JSON.stringify(res) + ")");
    ok(!("why" in res), "a \"sell\" result must carry no why key at all: " + JSON.stringify(res));
    ok(calls.join(",") === "rpc:getBalance,rpc:getTokenAccountsByOwner,quote:buy,quote:sell," +
      "swap-ix:buy,swap-ix:sell,rpc:simulateTransaction",
      "unexpected call sequence for the happy path: " + calls.join(","));
  }

  // ب) خطای سطحِ تراکنش (InstructionError) → nosell، باز هم بدونِ why
  {
    const legs = makeLegs();
    const { fetchImpl } = makeFetch({ legs, simErr: "INSTR" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === "nosell", "a transaction-level InstructionError should give { v: \"nosell\" } " +
      "(got " + JSON.stringify(res) + ")");
    ok(!("why" in res), "a \"nosell\" result must carry no why key at all: " + JSON.stringify(res));
  }

  // ج) 🔴 فی‌پیر از قبل خودِ mint را دارد → null/"payer-holds"، حتی اگر
  // شبیه‌سازی زیرش موفق می‌بود — همان تله‌ای که چهار نتیجه‌ی اول را
  // بی‌معنی کرده بود.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, heldRaw: "500", simErr: "SUCCESS" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "payer-holds" && isFrozenWhy(res.why),
      "a payer that already holds the mint must give null/\"payer-holds\", even though the " +
      "simulation underneath would say success (got " + JSON.stringify(res) + ")");
    ok(calls.join(",") === "rpc:getBalance,rpc:getTokenAccountsByOwner",
      "the guard must stop before any Jupiter/simulate call once the payer is found to hold the " +
      "mint, got: " + calls.join(","));
  }

  // د) فی‌پیر کمتر از ۱ SOL → null/"payer-balance"، بدونِ حتی یک فراخوانیِ جوپیتر
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, lamports: 100_000_000 }); // ۰٫۱ SOL
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "payer-balance" && isFrozenWhy(res.why),
      "a payer under 1 SOL must give null/\"payer-balance\" (got " + JSON.stringify(res) + ")");
    ok(calls.join(",") === "rpc:getBalance",
      "an underfunded payer must stop before even the held-mint check or any Jupiter call, got: " +
      calls.join(","));
  }

  // د۲) همان "payer-balance"، ولی از راهِ دیگرِ تعریفش: خودِ getBalance شکلی
  // داد که مقدارش عدد نبود — نه اینکه کم بود.
  {
    const legs = makeLegs();
    const { fetchImpl } = makeFetch({ legs, lamports: "not-a-number" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "payer-balance" && isFrozenWhy(res.why),
      "an unreadable getBalance shape must also give \"payer-balance\", not a crash or a different " +
      "reason (got " + JSON.stringify(res) + ")");
  }

  // ه) بدونِ مسیرِ خرید در جوپیتر، به‌شکلِ یک غیرِ۲۰۰ از خودِ Jupiter → "jup"
  // (تماس در سطحِ HTTP شکست خورده، نه اینکه با ۲۰۰ گفته باشد route‌ای نیست)
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, buyQuoteOk: false });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "jup" && isFrozenWhy(res.why),
      "a non-200 quote response from Jupiter must give null/\"jup\", not \"nosell\" " +
      "(got " + JSON.stringify(res) + ")");
    ok(!calls.includes("swap-ix:buy"), "swap-instructions must not be requested after a failed quote");
  }

  // ه۲) quote خرید با ۲۰۰ ولی بدونِ outAmount → "no-route" — Jupiter واقعاً
  // جواب داد، فقط چیزی برای این mint نداشت.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, buyQuoteEmpty: true });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "no-route" && isFrozenWhy(res.why),
      "a 200 quote response with no outAmount must give null/\"no-route\" " +
      "(got " + JSON.stringify(res) + ")");
    ok(!calls.includes("swap-ix:buy"), "swap-instructions must not be requested after a route-less quote");
  }

  // و) تراکنشِ بزرگ‌تر از ۱۲۳۲ بایت → null/"too-big"، هرگز حتی به
  // simulateTransaction نمی‌رسد
  {
    const legs = makeLegs({ hugeSwapData: true });
    const { fetchImpl, calls } = makeFetch({ legs, simErr: "SUCCESS" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "too-big" && isFrozenWhy(res.why),
      "a transaction over the 1232-byte limit must give null/\"too-big\" (got " + JSON.stringify(res) + ")");
    ok(!calls.includes("rpc:simulateTransaction"),
      "an oversized transaction must never reach simulateTransaction — got calls: " + calls.join(","));
  }

  // ز) ۵۰۰ از خودِ simulateTransaction → null/"rpc"، نه nosell
  {
    const legs = makeLegs();
    const { fetchImpl } = makeFetch({ legs, rpcStatus: { simulateTransaction: 500 } });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "rpc" && isFrozenWhy(res.why),
      "a 500 from simulateTransaction must give null/\"rpc\", not \"nosell\" (got " + JSON.stringify(res) + ")");
  }

  // ح) مهلتِ گذشته → null/"deadline"، بدونِ حتی یک فراخوانیِ شبکه
  {
    let calls = 0;
    const fetchImpl = async () => { calls++; return jsonRes({}); };
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, now: () => 10_000, deadlineAt: 5_000 });
    ok(res && res.v === null && res.why === "deadline" && isFrozenWhy(res.why) && calls === 0,
      "past the deadline fetchVerdictSol must return null/\"deadline\" without any fetch call " +
      "(got " + JSON.stringify(res) + ", " + calls + " calls)");
  }

  // ط) موجودیِ همین mint با شکلِ عددیِ نامعتبر (نه throw، نه یک why دیگر) → "internal"
  {
    const legs = makeLegs();
    const { fetchImpl } = makeFetch({ legs, heldRaw: "not-a-bigint" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "internal" && isFrozenWhy(res.why),
      "an unparsable held-token amount must give null/\"internal\" without throwing " +
      "(got " + JSON.stringify(res) + ")");
  }

  // ی) "unsupported" را هیچ مسیری در fetchVerdictSol تولید نمی‌کند (بالای
  // verdict_sol.js توضیح داده چرا) — فقط عضویتش در فهرستِ منجمد سنجیده می‌شود.
  ok(isFrozenWhy("unsupported"), "\"unsupported\" must still be a member of the frozen reason vocabulary");

  console.log("[fetchVerdictSol] happy path -> {v:\"sell\"} with no why key; InstructionError -> " +
    "{v:\"nosell\"} with no why key; a payer holding the mint -> \"payer-holds\"; an underfunded " +
    "payer or an unreadable getBalance shape -> \"payer-balance\"; a non-200 Jupiter quote -> " +
    "\"jup\"; a 200 quote with no route -> \"no-route\"; an oversized (>1232 byte) transaction -> " +
    "\"too-big\"; a 500 from simulateTransaction -> \"rpc\"; a past deadline -> \"deadline\" with " +
    "zero fetch calls; an unparsable held-token amount -> \"internal\"; every observed why checked " +
    "against VD_SOL_WHY by iterating the actual frozen list — all against an injected fake, no " +
    "real RPC or Jupiter call involved");
}

/* ---- ۱۹. /vd/<mint سولانا> سرتاسری، و /t/<mint سولانا> → ۴۰۴ ----
   همان مسیرِ واقعیِ index.js (diagVerdict -> solFetchVerdict -> fetchVerdictSol)
   با globalThis.fetch جعلی، دقیقاً مثلِ بخشِ ۱۳. */
{
  const vs = await import("./verdict_sol.js");
  const { TOKEN_PAGE: TP } = await import("./index.js");
  const SOL_ADDR = "So11111111111111111111111111111111111111112";

  ok(TP.test("/t/" + SOL_ADDR), "TOKEN_PAGE should accept a Solana mint's shape too: " +
    "/t/" + SOL_ADDR);

  function fakePubkey(n) {
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = (n * 41 + i * 7 + 3) % 256;
    return vs.base58Encode(b);
  }
  function ixData(bytes) { return vs.bytesToBase64(Uint8Array.from(bytes)); }
  function rawIx(programId, accounts, dataBytes) {
    return {
      programId,
      accounts: accounts.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
      data: ixData(dataBytes),
    };
  }
  const PAYER = vs.VD_SOL_PAYER;
  const PROGRAM = fakePubkey(9);
  const legBuy = {
    computeBudgetInstructions: [], setupInstructions: [],
    swapInstruction: rawIx(PROGRAM, [[PAYER, true, true]], [1, 2]),
    cleanupInstruction: null, addressLookupTableAddresses: [],
  };
  const legSell = {
    computeBudgetInstructions: [], setupInstructions: [],
    swapInstruction: rawIx(PROGRAM, [[PAYER, true, true]], [3, 4]),
    cleanupInstruction: null, addressLookupTableAddresses: [],
  };
  function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  function rpcOk(result) { return jsonRes({ jsonrpc: "2.0", id: 1, result }); }

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/swap/v1/quote")) {
      const isBuy = u.includes("onlyDirectRoutes=true");
      return jsonRes({ outAmount: isBuy ? "1000000" : "40000000", routePlan: [{}] });
    }
    if (u.includes("/swap/v1/swap-instructions")) {
      const body = JSON.parse(init.body);
      const isBuy = body.quoteResponse.outAmount === "1000000";
      return jsonRes(isBuy ? legBuy : legSell);
    }
    const body = JSON.parse(init.body);
    if (body.method === "getBalance") return rpcOk({ value: 2_000_000_000 });
    if (body.method === "getTokenAccountsByOwner") return rpcOk({ value: [] });
    if (body.method === "simulateTransaction") return rpcOk({ value: { err: null } });
    return jsonRes({ error: "unexpected" }, 500);
  };

  const spyEnv = {
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(req.url).pathname;
        return p === "/app" ? new Response("the site", { status: 200 })
                             : new Response("not found", { status: 404 });
      },
    },
  };

  const res = await worker.fetch(new Request(ORIGIN + "/vd/" + SOL_ADDR,
    { headers: { "cf-connecting-ip": "203.0.113.60" } }), spyEnv, {});
  ok(res.status === 200, "/vd/<solana mint> should be 200 (got " + res.status + ")");
  ok(res.headers.get("cache-control") === "no-store", "/vd must never be cached");
  const body = await res.json();
  ok(body.v === "sell", "/vd/<solana mint> did not surface the Solana verdict: " + JSON.stringify(body));
  ok(!("why" in body), "/vd's response for a \"sell\" verdict must carry no why key at all: " +
    JSON.stringify(body));

  const tRes = await worker.fetch(new Request(ORIGIN + "/t/" + SOL_ADDR,
    { headers: { "cf-connecting-ip": "203.0.113.61" } }), spyEnv, {});
  ok(tRes.status === 404, "/t/<solana mint> must be 404 until web/index.html can render a Solana " +
    "token (got " + tRes.status + ")");

  // یک mint دیگر، این‌بار فی‌پیرِ کم‌موجودی — سرتاسری از خودِ /vd، تا ثابت
  // شود why واقعاً تا بیرونی‌ترین لایه می‌رسد، نه فقط تا fetchVerdictSol.
  const SOL_ADDR_2 = "So11111111111111111111111111111111111111112".slice(0, -1) + "3"; // شکلِ معتبر، آدرسِ دیگر
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    if (b.method === "getBalance") return rpcOk({ value: 100_000_000 }); // ۰٫۱ SOL
    return jsonRes({ error: "unexpected" }, 500);
  };
  const res2 = await worker.fetch(new Request(ORIGIN + "/vd/" + SOL_ADDR_2,
    { headers: { "cf-connecting-ip": "203.0.113.62" } }), spyEnv, {});
  ok(res2.status === 200, "/vd/<solana mint> with an underfunded payer should still be 200 " +
    "(got " + res2.status + ")");
  const body2 = await res2.json();
  ok(Object.keys(body2).sort().join(",") === "ms,v,why",
    "/vd's null-verdict body must be exactly {v, ms, why}, got keys: " + JSON.stringify(body2));
  ok(body2.v === null && body2.why === "payer-balance" && vs.VD_SOL_WHY.includes(body2.why),
    "/vd end to end did not surface fetchVerdictSol's reason: " + JSON.stringify(body2));

  globalThis.fetch = trackingFetch; // برگرداندنِ موکِ پیش‌فرض برای هرچه بعد از این اجرا می‌شود
  console.log("[vd/t solana] /vd/<solana mint> runs the Solana verdict pipeline end to end " +
    "through worker.fetch (v:\"sell\"); /t/<solana mint> is still 404, exactly like an unknown " +
    "path, until the token page itself can render Solana");
}

console.log(fails === 0
  ? "[gt proxy] worker ok — " + REAL.length + " real paths proxied, " + BAD.length +
    " refused without touching the network, 429 passes through with CORS\n" +
    "[events] /ev ok — only the four allowed fields are stored; ip, user-agent, " +
    "referer and cookie never are\n" +
    "[verdict] worker/verdict.js ok — selectors and checksums independently verified, hand "
    + "encoder matches ethers byte-for-byte, decode/verdict/sellAmountFrom/fetchVerdict all "
    + "covered\n" +
    "[solana] chains.js chain detection, hand-rolled base58/base64, wire-size math and "
    + "fetchVerdictSol all covered against injected fakes; /vd/<mint> wired end to end; "
    + "/t/<mint> still 404"
  : "[gt proxy] " + fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
