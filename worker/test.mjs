/* تست پراکسی GeckoTerminal.
   با node اجرا می‌شود، بدون شبکه: `fetch` سراسری جایگزین می‌شود و آنچه
   بررسی می‌کنیم این است که Worker *چه چیزی* را به بالادست می‌فرستد و چه
   چیزی را اصلاً نمی‌فرستد.

   اجرا:  node worker/test.mjs
   run.py هم پیش از سوییت مرورگر همین را صدا می‌زند. */

import worker from "./index.js";

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

console.log(fails === 0
  ? "[gt proxy] worker ok — " + REAL.length + " real paths proxied, " + BAD.length +
    " refused without touching the network, 429 passes through with CORS"
  : "[gt proxy] " + fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
