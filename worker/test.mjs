/* تست پراکسی GeckoTerminal.
   با node اجرا می‌شود، بدون شبکه: `fetch` سراسری جایگزین می‌شود و آنچه
   بررسی می‌کنیم این است که Worker *چه چیزی* را به بالادست می‌فرستد و چه
   چیزی را اصلاً نمی‌فرستد.

   اجرا:  node worker/test.mjs
   run.py هم پیش از سوییت مرورگر همین را صدا می‌زند. */

import worker from "./index.js";
import { createHash } from "node:crypto";
import { OG_PNG_ETAG } from "./og-image.js";

let fails = 0;
function ok(cond, what) {
  if (!cond) { fails++; console.log("FAIL " + what); }
}

const ORIGIN = "https://zaexa.com";
let sent = [];       // URLهایی که به بالادست رفت
let reply = null;    // پاسخی که بالادست می‌دهد (یا خطایی که پرتاب می‌کند)

let sentHeaders = [];
globalThis.fetch = async (u, o) => {
  sent.push(String(u));
  sentHeaders.push((o && o.headers) || {});
  if (reply instanceof Error) throw reply;
  return reply;
};

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

/* صفحه‌ی توکن: Worker باید *ریشه* را از ASSETS بخواهد، نه /index.html.
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
  ok(asked.length === 1 && asked[0] === "/",
     "the token page asked ASSETS for " + JSON.stringify(asked) +
     " — it must ask for \"/\": /index.html answers with a 307 to /, and that " +
     "redirect leaves the path behind, so the token page never opens");
  // و یک آدرس بدشکل نباید این مسیر را بگیرد
  asked = [];
  await worker.fetch(new Request(ORIGIN + "/t/not-an-address"), spyEnv, {});
  ok(asked.length === 1 && asked[0] === "/t/not-an-address",
     "a malformed token path was treated as a token page: " + JSON.stringify(asked));
  console.log("[token page] worker serves / for /t/<address>, untouched for anything else");
}

/* ---- ۱۰. کارت پیش‌نمایش (OG) — بخش‌هایی که بدون workerd سنجیدنی‌اند ----
   `HTMLRewriter` در node وجود ندارد، پس خودِ *تزریق* اینجا سنجیده نمی‌شود؛
   آن در `worker/og_live_test.mjs` روی workerd واقعی سنجیده می‌شود.
   اینجا هرچه منطق است سنجیده می‌شود: گریز، قالب عدد، انتخاب عنوان، و
   اینکه Worker چه چیزی به بالادست می‌فرستد و چه وقت هیچ نمی‌فرستد. */
{
  const og = await import("./og.js");
  const { OG_NETWORK, ogFetchMeta } = await import("./index.js");

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

  /* Worker → بالادست: کدام آدرس، و با کلید کجا می‌رود.
     ⚠️ اگر روزی شبکه‌ی دوم اضافه شد، این ثابت باید از مسیر بیاید. */
  ok(OG_NETWORK === "base", "OG_NETWORK is no longer base — the card would ask the wrong chain");
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

console.log(fails === 0
  ? "[gt proxy] worker ok — " + REAL.length + " real paths proxied, " + BAD.length +
    " refused without touching the network, 429 passes through with CORS\n" +
    "[events] /ev ok — only the four allowed fields are stored; ip, user-agent, " +
    "referer and cookie never are"
  : "[gt proxy] " + fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
