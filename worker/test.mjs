/* تست پراکسی GeckoTerminal.
   با node اجرا می‌شود، بدون شبکه: `fetch` سراسری جایگزین می‌شود و آنچه
   بررسی می‌کنیم این است که Worker *چه چیزی* را به بالادست می‌فرستد و چه
   چیزی را اصلاً نمی‌فرستد.

   اجرا:  node worker/test.mjs
   run.py هم پیش از سوییت مرورگر همین را صدا می‌زند. */

import worker from "./index.js";
import { REPORT_RUN_MAX_TOKENS } from "./index.js";
import { createHash } from "node:crypto";
import { OG_PNG_ETAG } from "./og-image.js";
import fs from "node:fs";
import { createRequire } from "node:module";
import {
  REPORT_MIN_RESERVE_USD, REPORT_MAX_TOKENS_PER_RUN, REPORT_PAIRS_CAP, REPORT_PACE_MS,
  CHECK_KIND_BY_CHAIN, REPORT_DATE_RE, PAIRS_KEY_BASE,
  newPoolRowToToken, newPoolRowToTokenFor, reportRow, mergeReportDoc, mergePairsRing,
  utcDateOf, reportKey, emptyReportDoc, runReportPass,
  reportText, REPORT_TEXT_FIRST_DATE,
  causeForRow, REPORT_CAUSES,
  followForRow, REPORT_FOLLOWS, applyFollowUps, pickFollowUpTargets,
  retForRow, REPORT_SOL_MAX_TOKENS,
  recheckForRow, REPORT_RECHECKS, applyRechecks, pickRecheckTargets,
  PASS_LOG_KEY, REPORT_PASS_LOG_CAP, readPassLog, REPORT_CAP_PROBE, classifyCapProbe,
  REPORT_METER_STAGES, REPORT_PASS_BASE_CAP,
} from "./report.js";
import * as v4 from "./v4index.js";
import {
  readV4Keys, readV4Entry, rpcCallBase, fetchV4Pools, storeV4Result, v4StoreTtl, runV4Index,
  v4PoolsEmpty, V4_STATE_VIEW, V4_GET_LIQUIDITY_SEL, pairsRowsFor,
  makeSubMeter, meterKv, scheduledReportPass,
} from "./index.js";

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

  /* ط) رویدادِ تازه: share:copy — همیشه با detail="" فرستاده می‌شود (هیچ
     توکن/آدرس/URLای هرگز فرستاده نمی‌شود). حلقه‌ی «ه» بالاتر همین را برای
     همه‌ی EV_OK از‌جمله share:copy سنجیده؛ اینجا صریح‌تر: detail خالی
     پذیرفته می‌شود، و یک detail واقعاً نامعتبر (نه در EV_DETAIL_OK، و
     share:copy جزوِ EV_ERR_NAMES نیست پس استثنای چهار-رقمی هم شاملش
     نمی‌شود) رد می‌شود.
     ⚠️ "inj"/"wc" عضوِ همان EV_DETAIL_OKِ سراسری‌اند و برای *هر* رویدادی
     پذیرفته می‌شوند (نه فقط wallet:on) — این یک قاعده‌ی از پیش‌موجود است،
     نه چیزی که این تغییر باز کرده باشد؛ پس share:copy هم با "inj" ۲۰۴
     می‌گیرد، درست هم‌رده‌ی wallet:on در سطر «ه» بالاتر. */
  let sc = await evCall(JSON.stringify({ e: "share:copy", d: "", v: "desktop" }), { cf: {} });
  ok(sc.status === 204, "share:copy with detail \"\" should be accepted (got " + sc.status + ")");

  sc = await evCall(JSON.stringify({ e: "share:copy", d: "inj", v: "desktop" }), { cf: {} });
  ok(sc.status === 204, "share:copy with the pre-existing globally-allowlisted detail \"inj\" should be "
    + "accepted (got " + sc.status + ") — EV_DETAIL_OK is not per-event");

  sc = await evCall(JSON.stringify({ e: "share:copy", d: "0xdeadbeef", v: "desktop" }), { cf: {} });
  ok(sc.status === 400, "share:copy with a detail outside EV_DETAIL_OK (share:copy is not an err: event, "
    + "so the 4-hex exception never applies to it) should be refused (got " + sc.status + ")");

  console.log("[events] " + EV_OK.size + " event names allowed, everything else refused, including the "
    + "new share:copy (accepted with detail \"\" and with the pre-existing global \"inj\"/\"wc\" details, "
    + "refused with anything else)");
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

/* نگاشتِ id (همان idِ عددیِ eth_call که callBatch در verdict.js می‌سازد —
   ۰ کاناری است، آیتم‌ها از ۱ شروع می‌شوند) به kind، از رویِ خودِ
   buildProbe/VD_VENUES ساخته می‌شود — نه یک فهرستِ دستیِ دومِ نامِ صرافی‌ها
   که اگر VD_VENUES جابه‌جا شود بی‌صدا از هدف جا می‌ماند.
   ⚠️ چند سناریوی زیر (fetchVerdict روی پروبِ *واقعی*) از این استفاده
   می‌کنند تا آیتمِ SOLIDLY (aerodrome) را با یک ریوِرتِ کدِ ۳ اثبات کنند،
   نه با "0x"/صفر — دقیقاً همان استثنایی که VD_ZERO_IS_PROOF اضافه کرد؛
   بدونِ این تفکیک، یک "0x" برای *همه‌ی* آیتم‌ها (که پیش از این تغییر یک
   نوسانِ nosellِ کاملاً معتبر بود) حالا در SOLIDLY نامعلوم می‌ماند و کلِ
   verdict را نامعلوم می‌کند. */
const PROBE_KIND_BY_ID = new Map(
  vd.buildProbe("0x1111111111111111111111111111111111111111", vd.WETH_ADDR, 1n)
    .map((p, i) => [i + 1, vd.VD_VENUES.find((r) => r.id === p.id).kind])
);
function isSolidlyReqId(id) { return PROBE_KIND_BY_ID.get(id) === "SOLIDLY"; }

/* --- ۱۲.۱ نگهبانِ سلکتور --- هرچهار سلکتور از رویِ امضای کاملش با
   ethers.id بازمحاسبه می‌شود؛ یک سلکتورِ دستیِ بی‌تست دقیقاً همان کلاس
   باگی است که این مخزن را یک بار گزیده. */
{
  const sigs = {
    SEL_CL_UINT24: "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
    SEL_CL_INT24: "quoteExactInputSingle((address,address,uint256,int24,uint160))",
    SEL_SOLIDLY: "getAmountsOut(uint256,(address,address,bool,address)[])",
    SEL_V2: "getAmountsOut(uint256,address[])",
    SEL_V4_SINGLE: "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))",
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
  const ifaceV4 = new ethers.Interface([
    "function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)"]);

  // ضدجفتِ مرحله‌ی WETH پس از VD_V4_COUNTER اترِ بومی (address(0)) می‌شود؛
  // TOKEN (0x11..) از صفر بزرگ‌تر است، پس TOKEN همیشه currency1 است و
  // zeroForOne نادرست. ضدجفتِ مرحله‌ی USDC خودِ USDC (0x83..) می‌ماند؛ TOKEN
  // از آن کوچک‌تر است، پس TOKEN همیشه currency0 و zeroForOne درست است —
  // همین دو حالت هر دو سوی مرتب‌سازی را می‌پیمایند، بدون این‌که کدِ تست
  // خودش حدس بزند.
  function wantV4Data(tokenIn, tokenOut, amountIn, fee, tickSpacing) {
    const a = BigInt(tokenIn.toLowerCase()), b = BigInt(tokenOut.toLowerCase());
    const currency0 = a < b ? tokenIn : tokenOut;
    const currency1 = a < b ? tokenOut : tokenIn;
    const zeroForOne = a < b;
    return ifaceV4.encodeFunctionData("quoteExactInputSingle",
      [[[currency0, currency1, fee, tickSpacing, vd.NATIVE_ADDR], zeroForOne, amountIn, "0x"]]);
  }

  const probe = vd.buildProbe(TOKEN, vd.WETH_ADDR, amt);
  ok(probe.length === 21, "buildProbe should produce exactly 21 calls (3+3+5+2+1+1+1+1+4), got " + probe.length);

  for (const p of probe) {
    const row = vd.VD_VENUES.find((r) => r.id === p.id);
    // این حلقه فقط شکلِ حدسیِ "fee:tickSpacing" را می‌فهمد؛ اگر یک کلیدِ
    // واقعیِ "real:..." این‌جا سر برآورد (یعنی گاردِ opts-غایب در بخشِ
    // ۲۷.۱۱ شکسته)، شمارشِ ۲۱‌تاییِ بالا همین را از قبل «FAIL» کرده — ادامه‌ی
    // این حلقه با فرضِ شکلِ غلط باید فقط رد شود، نه با کرش (split/Number
    // روی "real:" یک NaN می‌سازد و ethers را با underflow می‌ترکاند).
    if (typeof p.key === "string" && p.key.startsWith("real:")) continue;
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
    } else if (row.kind === "V4_SINGLE") {
      const [feeStr, tickStr] = p.key.split(":");
      want = wantV4Data(TOKEN, vd.NATIVE_ADDR, amt, Number(feeStr), Number(tickStr));
    }
    ok(p.data === want, row.kind + " encoding mismatch for " + p.id + "/" + p.key + ":\n  got  " +
      p.data + "\n  want " + want);
    ok(p.to === row.to, "wrong contract address for " + p.id);
  }

  // همان چهار کلید، ولی مرحله‌ی USDC — اینجا TOKEN از ضدجفتش کوچک‌تر است،
  // پس zeroForOne باید درست باشد؛ این نصفِ دومِ «هر دو سوی مرتب‌سازی» است.
  const probeUsdcGolden = vd.buildProbe(TOKEN, vd.USDC_ADDR, amt).filter((p) => p.id === "uniswap-v4");
  ok(probeUsdcGolden.length === 4, "expected all four v4 keys in the USDC stage too, got " + probeUsdcGolden.length);
  for (const p of probeUsdcGolden) {
    // همان دلیلِ گاردِ حلقه‌ی بالا: یک کلیدِ "real:..." این‌جا نباید کرش کند.
    if (typeof p.key === "string" && p.key.startsWith("real:")) continue;
    const [feeStr, tickStr] = p.key.split(":");
    const want = wantV4Data(TOKEN, vd.USDC_ADDR, amt, Number(feeStr), Number(tickStr));
    ok(p.data === want, "V4_SINGLE (USDC stage, zeroForOne=true) encoding mismatch for " + p.key +
      ":\n  got  " + p.data + "\n  want " + want);
    ok(p.to === vd.VD_VENUES.find((r) => r.id === "uniswap-v4").to, "wrong contract address for uniswap-v4");
  }

  // خودِ کاناری هم همین امضا را می‌گیرد، با مقادیرِ ثابتش
  const canary = vd.canaryCall();
  const wantCanary = ifaceU.encodeFunctionData("quoteExactInputSingle",
    [[vd.WETH_ADDR, vd.USDC_ADDR, 10000000000000000n, 500, 0]]);
  ok(canary.data === wantCanary, "canaryCall encoding mismatch:\n  got  " + canary.data +
    "\n  want " + wantCanary);
  ok(canary.to === vd.VD_VENUES[0].to, "canaryCall must hit the uniswap-v3 quoter, the pool's liveness "
    + "reference, not some other contract");

  // --- شمارِ متقابلِ v4 --- مرحله‌ی WETH همیشه اترِ بومی می‌پرسد، هرگز خودِ
  // WETH را؛ مرحله‌ی USDC دست‌نخورده می‌ماند و خودِ USDC را می‌پرسد.
  // VD_V4_COUNTER بسته است و دقیقاً یک ورودی دارد.
  {
    const decodeCurrencies = (data) => {
      // پارامترِ تابع خودش یک تاپلِ تک‌عضوی است (QuoteExactSingleParams)؛
      // عضوِ ۰ِ آن poolKey است، نه خودش — یک لایه‌ی دیگر باید باز شود.
      const [params] = ifaceV4.decodeFunctionData("quoteExactInputSingle", data);
      const poolKey = params[0];
      return [String(poolKey[0]).toLowerCase(), String(poolKey[1]).toLowerCase()];
    };
    const probeWethV4 = probe.filter((p) => p.id === "uniswap-v4");
    ok(probeWethV4.length === 4, "expected all four v4 keys in the WETH stage, got " + probeWethV4.length);
    for (const p of probeWethV4) {
      const currencies = decodeCurrencies(p.data);
      ok(currencies.includes(vd.NATIVE_ADDR), "the WETH stage v4 probe must address native ether, got " +
        JSON.stringify(currencies));
      ok(!currencies.includes(vd.WETH_ADDR.toLowerCase()), "the WETH stage v4 probe must never address "
        + "wrapped WETH itself, got " + JSON.stringify(currencies));
    }
    for (const p of probeUsdcGolden) {
      const currencies = decodeCurrencies(p.data);
      ok(currencies.includes(vd.USDC_ADDR.toLowerCase()), "the USDC stage v4 probe must address USDC, got "
        + JSON.stringify(currencies));
    }
    ok(Object.isFrozen(vd.VD_V4_COUNTER), "VD_V4_COUNTER must be frozen");
    ok(Object.keys(vd.VD_V4_COUNTER).length === 1 &&
      vd.VD_V4_COUNTER[vd.WETH_ADDR.toLowerCase()] === vd.NATIVE_ADDR,
      "VD_V4_COUNTER must have exactly one entry, WETH -> native ether, got " +
      JSON.stringify(vd.VD_V4_COUNTER));
  }

  // --- گاردِ uint128 --- مقدارِ برابر یا بیش از ظرفیت باید ردیفِ v4 را
  // بی‌صدا حذف کند (نه بریده)، یکی کمتر باید هر چهار کلید را نگه دارد.
  {
    const overflow = vd.buildProbe(TOKEN, vd.WETH_ADDR, 2n ** 128n);
    ok(overflow.length === 17, "an amountIn at exactly 2**128 must drop all four v4 entries, leaving the "
      + "17 non-v4 calls, got " + overflow.length);
    ok(!overflow.some((p) => p.id === "uniswap-v4"), "an amountIn at 2**128 must never produce a "
      + "uniswap-v4 entry with truncated data");

    const atCap = vd.buildProbe(TOKEN, vd.WETH_ADDR, 2n ** 128n - 1n);
    ok(atCap.length === 21, "an amountIn one below 2**128 must still produce all 21 calls, got " + atCap.length);
    ok(atCap.filter((p) => p.id === "uniswap-v4").length === 4, "an amountIn one below 2**128 must keep "
      + "all four v4 keys");

    ok(vd.encodeV4QuoteExactInputSingle(TOKEN, vd.NATIVE_ADDR, 2n ** 128n, 500, 10) === null,
      "encodeV4QuoteExactInputSingle must return null at exactly 2**128, never mask or truncate");
    ok(vd.encodeV4QuoteExactInputSingle(TOKEN, vd.NATIVE_ADDR, 2n ** 128n - 1n, 500, 10) !== null,
      "encodeV4QuoteExactInputSingle must still succeed one below 2**128");
  }
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

  // --- decodeStatic2 (V4_SINGLE) --- بازگشتِ v4 دو کلمه است (amountOut,
  // gasEstimate)؛ اینجا باید همان کلمه‌ی اول بگیرد و *هرگز* بابتِ کوتاه‌تر
  // بودن از چهار کلمه رد نشود — دقیقاً همان دامی که decodeStatic4 می‌افتاد.
  const ifaceV4Ret = new ethers.Interface(["function h() returns (uint256,uint256)"]);
  const v4Ret = ifaceV4Ret.encodeFunctionResult("h", [321n, 999999n]);
  ok(vd.decodeQuote("V4_SINGLE", v4Ret) === 321n,
    "decodeQuote(V4_SINGLE) must take the first word (amountOut), not the gasEstimate");
  const v4RetBigGas = ifaceV4Ret.encodeFunctionResult("h", [321n, 2n ** 200n]);
  ok(vd.decodeQuote("V4_SINGLE", v4RetBigGas) === 321n,
    "a huge gasEstimate in the second word must not disturb decoding the first");
  ok(vd.decodeQuote("V4_SINGLE", "0x") === null, "decodeQuote(V4_SINGLE) must be null for an empty \"0x\"");
  const oneWord = "0x" + w(42);
  ok(vd.decodeQuote("V4_SINGLE", oneWord) === null,
    "decodeQuote(V4_SINGLE) must be null for a single-word (truncated) payload");
  // نگهبانِ اصلیِ این بخش: یک بازگشتِ دوکلمه‌ایِ واقعیِ v4 (که برای decodeStatic4
  // «کوتاه‌تر از ظرفیت» و رد می‌شد) با V4_SINGLE باید موفق رمزگشایی شود.
  ok(vd.decodeQuote("V4_SINGLE", v4Ret) !== null,
    "a two-word v4 return must decode successfully, not be rejected for being shorter than four words");
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

  // ج) همه ریوِرت + کاناریِ زنده → nosell — SOLIDLY هم اینجا با یک
  // ریوِرتِ کدِ ۳ اثبات می‌کند (اثباتِ ریوِرت مستقل از kind است)، نه با
  // صفرِ رمزگشایی‌شده؛ آن یکی جداگانه، در بخشِ «صفرِ بی‌صدای SOLIDLY» پایین‌تر.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "CL_UINT24", error: { code: 3 } },
      { kind: "CL_INT24", error: { code: -32000 } },
      { kind: "V2", result: "0x" },
      { kind: "SOLIDLY", error: { code: 3 } },
    ],
  }) === "nosell", "all-proven-negative items with a live canary must give nosell, "
    + "including a SOLIDLY item that reverted with code 3");

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

  /* --- ح تا ل) لایه‌ی اول: صفرِ بی‌صدای SOLIDLY اثبات نیست ---
     خودِ باگِ زنده: aerodrome (تنها صرافیِ SOLIDLY در جدول) وقتی استخر
     ندارد ریوِرت نمی‌کند، بی‌صدا صفر برمی‌گرداند — این جفت‌آزمون (ح) دقیقاً
     همان چیزی است که این لایه باید درست کند. */

  // ح) SOLIDLY، صفرِ رمزگشایی‌شده، کاناری زنده، بدونِ هیچ مثبتی → نامعلوم
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ kind: "SOLIDLY", result: mkArray([0n]) }],
  }) === null, "a SOLIDLY item decoding to zero must NOT be a proven negative — it must leave the "
    + "whole verdict unknown, not nosell (this is the live bug: aerodrome returns 0 instead of "
    + "reverting when it has no pool for the token)");

  // همان سناریو، فقط kind به V2 عوض شده — این یکی *باید* nosell بدهد، تا
  // روشن شود تفاوت واقعاً از رویِ VD_ZERO_IS_PROOF[kind] است، نه از رویِ
  // شکلِ بازگشتی.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ kind: "V2", result: mkArray([0n]) }],
  }) === "nosell", "the exact same decoded-zero payload under kind V2 must still prove nosell — "
    + "the SOLIDLY exception must come from VD_ZERO_IS_PROOF, not from the payload shape");

  // ط) SOLIDLY با "0x" خالی → همان نامعلوم؛ SOLIDLY با یک ریوِرتِ کدِ ۳
  // واقعی (نه صفرِ بی‌صدا) کنارِ بقیه‌ی اثباتی‌ها → nosell — ریوِرت هنوز
  // اثبات است، فقط صفرِ بی‌صدا دیگر نیست.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ kind: "SOLIDLY", result: "0x" }],
  }) === null, "a SOLIDLY item returning an empty \"0x\" must also be unknown, not nosell");
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "CL_UINT24", error: { code: 3 } },
      { kind: "SOLIDLY", error: { code: 3 } },
    ],
  }) === "nosell", "a SOLIDLY item that actually reverts with code 3 is still proof, even though a "
    + "decoded zero or \"0x\" from the same kind is not");

  // ي) kindِ غایب/ناشناخته هرگز حدس زده نمی‌شود — نامعلوم، چه ریوِرت باشد
  // چه یک نتیجه‌ی به‌ظاهر موفق.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ result: mkStatic4(0) }], // بدونِ kind
  }) === null, "an item with no kind at all must never be treated as a proven negative");
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ kind: "UNKNOWN_DEX_KIND", error: { code: 3 } }],
  }) === null, "an item with an unrecognised kind must never be treated as a proven negative, "
    + "even when it reverts with a normally-proving code — never guess");

  // ك) مثبت هنوز همیشه برنده است، حتی کنارِ یک صفرِ SOLIDLY که به‌تنهایی
  // نامعلوم بود.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "SOLIDLY", result: mkArray([0n]) },
      { kind: "CL_UINT24", result: mkStatic4(42) },
    ],
  }) === "sell", "a positive quote must still win even alongside an unproven SOLIDLY zero");

  // ل) VD_ZERO_IS_PROOF بسته است و دقیقاً روی همان kindهایی نشسته که
  // VD_VENUES واقعاً دارد — نه بیشتر نه کمتر؛ هر دو سو پیموده می‌شود، نه
  // یک فهرستِ دستیِ دوم.
  {
    const venueKinds = new Set(vd.VD_VENUES.map((r) => r.kind));
    for (const kind of Object.keys(vd.VD_ZERO_IS_PROOF)) {
      ok(venueKinds.has(kind), "VD_ZERO_IS_PROOF has a kind VD_VENUES never uses: " + kind);
    }
    for (const kind of venueKinds) {
      ok(Object.prototype.hasOwnProperty.call(vd.VD_ZERO_IS_PROOF, kind),
        "VD_VENUES uses a kind missing from VD_ZERO_IS_PROOF: " + kind);
    }
    ok(vd.VD_ZERO_IS_PROOF.SOLIDLY === false, "VD_ZERO_IS_PROOF.SOLIDLY must be false — a "
      + "Solidly-style getAmountsOut returns 0 instead of reverting when it has no pool");
    ok(vd.VD_ZERO_IS_PROOF.CL_UINT24 === true && vd.VD_ZERO_IS_PROOF.CL_INT24 === true &&
      vd.VD_ZERO_IS_PROOF.V2 === true, "the three v3/v2-style kinds must keep zero-is-proof");
    ok(Object.isFrozen(vd.VD_ZERO_IS_PROOF), "VD_ZERO_IS_PROOF must be frozen");
  }

  // م) VD_POSITIVE_ONLY هم بسته است و دقیقاً روی همان kindهایی نشسته که
  // VD_VENUES واقعاً دارد — نه بیشتر نه کمتر؛ هر دو سو پیموده می‌شود، دقیقاً
  // همان الگوی VD_ZERO_IS_PROOF بالا.
  {
    const venueKinds = new Set(vd.VD_VENUES.map((r) => r.kind));
    for (const kind of Object.keys(vd.VD_POSITIVE_ONLY)) {
      ok(venueKinds.has(kind), "VD_POSITIVE_ONLY has a kind VD_VENUES never uses: " + kind);
    }
    for (const kind of venueKinds) {
      ok(Object.prototype.hasOwnProperty.call(vd.VD_POSITIVE_ONLY, kind),
        "VD_VENUES uses a kind missing from VD_POSITIVE_ONLY: " + kind);
    }
    ok(vd.VD_POSITIVE_ONLY.V4_SINGLE === true, "VD_POSITIVE_ONLY.V4_SINGLE must be true — v4 can only "
      + "prove a sale, never the absence of one, because we guess its pool keys");
    ok(vd.VD_POSITIVE_ONLY.CL_UINT24 === false && vd.VD_POSITIVE_ONLY.CL_INT24 === false &&
      vd.VD_POSITIVE_ONLY.V2 === false && vd.VD_POSITIVE_ONLY.SOLIDLY === false,
      "every non-v4 kind must stay able to prove nosell");
    ok(Object.isFrozen(vd.VD_POSITIVE_ONLY), "VD_POSITIVE_ONLY must be frozen");
  }

  /* --- ن تا ی) V4_SINGLE positive-only + گاردِ کوروم ---
     v4 با کوترِ چهار PoolKeyِ حدسی حرف می‌زند: یک کوت اثباتِ واقعیِ فروش
     است، ولی یک ریوِرت یا صفر فقط یعنی حدسمان غلط بود — هیچ‌چیزی اثبات
     نمی‌کند. mkStatic2 شکلِ بازگشتیِ واقعیِ v4 است: دو کلمه، نه چهار. */
  const mkStatic2 = (amountOut) => "0x" + w(amountOut) + w(0);

  // ن) یک کوتِ مثبت از v4 باید همچنان برنده باشد، حتی وقتی هرچیزِ دیگر رد شده.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "CL_UINT24", error: { code: 3 } },
      { kind: "V4_SINGLE", result: mkStatic2(777) },
    ],
  }) === "sell", "a v4 positive quote must still win the verdict, exactly like any other kind");

  // س) همه‌ی آیتم‌های non-v4 اثباتِ منفی‌اند، v4 ریوِرت می‌کند → nosell —
  // عمداً با کدِ خطای -۳۲۶۰۳ (نه ۳، نه -۳۲۰۰۰) که خودش هرگز اثباتی نیست؛
  // این‌جا فقط continue می‌شود چون positiveOnly است، پیش از آن‌که حتی کدِ
  // خطا بررسی شود. اگر کدِ ۳/​-۳۲۰۰۰ به‌کار می‌رفت، این probe حتی با
  // VD_POSITIVE_ONLY.V4_SINGLE=false هم nosell می‌داد و چیزی را نمی‌سنجید.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "CL_UINT24", error: { code: 3 } },
      { kind: "V2", result: "0x" },
      { kind: "V4_SINGLE", error: { code: -32603 } },
    ],
  }) === "nosell", "a reverting v4 item (with a non-proving error code) alongside proven-negative "
    + "non-v4 items must still give nosell — v4's own revert proves nothing and must not block the "
    + "verdict");

  // ع) همان، ولی v4 صفرِ رمزگشایی‌شده می‌دهد (نه ریوِرت) → همچنان nosell.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "CL_UINT24", error: { code: 3 } },
      { kind: "V4_SINGLE", result: mkStatic2(0) },
    ],
  }) === "nosell", "a decoded-zero v4 item alongside a proven-negative non-v4 item must still give "
    + "nosell — v4's zero is our own guess failing, not proof, and must not block the verdict");

  // 🔴 ف) گاردِ کوروم — فهرست فقط از آیتم‌های v4 (positive-only) ساخته شده،
  // همه ریوِرت. بدونِ این گارد این سناریو از هر continue رد می‌شد و بی‌صدا
  // nosell می‌گرفت؛ دقیقاً باگِ ۱۶ شهریور، این‌بار با صفر شاهدِ واقعی.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "V4_SINGLE", error: { code: 3 } },
      { kind: "V4_SINGLE", error: { code: 3 } },
    ],
  }) === null, "a list made only of v4 (positive-only) items, all reverting, must give unknown, never "
    + "nosell — there is zero real evidence, only failed guesses (the quorum guard)");

  // (پایداریِ رفتار — بندِ ۱۱ از فهرستِ آزمون‌ها) یک senarioِ ساده‌ی sell و
  // یک all-revert فقط با kindهای v3-style (بدونِ V2، بدونِ SOLIDLY) باید
  // دقیقاً همان چیزی بدهند که امروز می‌دهند، دست‌نخورده از این تغییر.
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [{ kind: "CL_UINT24", result: mkStatic4(42) }],
  }) === "sell", "an existing plain positive-quote scenario must still verdict sell, unchanged");
  ok(vd.verdictFrom({
    canary: aliveCanary,
    items: [
      { kind: "CL_UINT24", error: { code: 3 } },
      { kind: "CL_INT24", error: { code: -32000 } },
    ],
  }) === "nosell", "an existing all-revert scenario using only v3-style kinds (no V2, no SOLIDLY) "
    + "must still verdict nosell, unchanged by the SOLIDLY exception");

  console.log("[verdict rules] positive wins; dead canary -> unknown; all-proven-negative -> "
    + "nosell; an unproven error -> unknown; \"0x\" and zero each proven on their own for "
    + "zero-is-proof kinds; an empty probe list -> unknown; "
    + "[VD_ZERO_IS_PROOF] a SOLIDLY zero/\"0x\" is never proof (the live aerodrome bug) while a "
    + "real SOLIDLY revert still is, an unrecognised/missing kind is never guessed at, positive "
    + "still wins over an unproven SOLIDLY zero, and the frozen map exactly mirrors VD_VENUES's "
    + "kinds in both directions; "
    + "[VD_POSITIVE_ONLY] frozen and mirrors VD_VENUES's kinds too, only V4_SINGLE is true, and a "
    + "v4 positive quote wins/a v4 revert or zero never blocks nosell/a v4-only all-revert list "
    + "gives unknown, never nosell (the quorum guard)");
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
  // ⚠️ آیتمِ SOLIDLY (aerodrome) در مرحله‌ی A با یک ریوِرتِ کدِ ۳ رد می‌شود،
  // نه "0x" — از وقتی SOLIDLY صفر/​"0x" را اثبات نمی‌داند، یک "0x"ِ یکسان
  // برای همه‌ی آیتم‌ها خودِ مرحله‌ی A را نامعلوم می‌کرد و هرگز به مرحله‌ی B
  // نمی‌رسید (دقیقاً همان لایه‌ی اولی که این فایل الان اضافه کرد).
  {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls++;
      const reqs = JSON.parse(init.body);
      const isStageB = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
      const body = reqs.map((r) => {
        if (r.id === 0) return { id: 0, result: mkStatic4(5) };
        if (!isStageB) return isSolidlyReqId(r.id) ? { id: r.id, error: { code: 3 } } : { id: r.id, result: "0x" };
        return { id: r.id, result: r.id === 1 ? mkStatic4(999) : "0x" };
      });
      return jsonRes(body);
    };
    const res = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc.example"] });
    ok(res === "sell", "stage A nosell followed by a stage B positive must return sell (got " + res + ")");
    ok(calls === 2, "stage B must only run once stage A came back nosell (2 fetch calls expected, got " + calls + ")");
  }

  /* ب۲) مرحله‌ی WETH **مبهم** (نه nosell) + کلیدِ واقعیِ USDC → گذرِ اثباتِ
     مثبت. 🔴 این از یک اندازه‌گیریِ زنده آمد، نه از یک ایده: توکنی با استخرِ
     USDCِ نسخه ۴ که معادلِ صد دلار را با ۹۹٫۷۵ دلار خروجی کوت می‌دهد، و
     هرگز پرسیده نمی‌شد چون صفرِ aerodrome مرحله‌ی WETH را مبهم کرده بود. */
  {
    const REAL_USDC_KEY = {
      currency0: TOKEN.toLowerCase(),
      currency1: vd.USDC_ADDR.toLowerCase(),
      fee: 9990, tickSpacing: 100, hooks: vd.NATIVE_ADDR,
    };
    /* مرحله‌ی WETH را مبهم می‌کند. ⚠️ ۱۹ شهریور عوض شد: پیش از آن یک "0x"ِ
       یکسان برای همه کافی بود، چون صفرِ SOLIDLY کلِ حکم را باطل می‌کرد. حالا
       آن صفر فقط «ممتنع» است و "0x"ِ بقیه اثباتِ منفی — یعنی همان فیکسچر
       nosellِ تمیز می‌شد و این گذر اصلاً اجرا نمی‌شد. ابهامِ واقعی یعنی
       «نتوانستیم بپرسیم»: یک کدِ خطای غیرِ اثباتی (خطای داخلیِ نود). */
    const ambiguousWeth = (r) => ({ id: r.id, error: { code: -32603 } });

    // ب۲-۱) کلیدِ واقعیِ USDC کوتِ مثبت می‌دهد → sell
    {
      let calls = 0;
      let proofBatch = null;
      const fetchImpl = async (url, init) => {
        calls++;
        const reqs = JSON.parse(init.body);
        const isProof = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
        if (isProof) proofBatch = reqs;
        return jsonRes(reqs.map((r) => {
          if (r.id === 0) return { id: 0, result: mkStatic4(5) };
          if (!isProof) return ambiguousWeth(r);
          return { id: r.id, result: "0x" + w(99745784) + w(0) }; // v4: دو کلمه
        }));
      };
      const res = await vd.fetchVerdict(TOKEN, meta,
        { fetchImpl, rpcs: ["https://rpc.example"], v4Keys: [REAL_USDC_KEY] });
      ok(res === "sell",
        "an AMBIGUOUS weth stage plus a real USDC v4 key that quotes must still reach sell — a positive " +
        "is proof on its own and does not depend on the earlier stage reaching a clean negative (got " + res + ")");
      ok(calls === 2, "the proof pass must be exactly one extra batch, got " + calls);
      // فقط ردیف‌های کلیدِ واقعی، نه کلِ جدول — وگرنه ردیف‌های منفی‌ساز هم
      // وارد گذری می‌شوند که اصلاً برای منفی ساخته نشده.
      ok(proofBatch && proofBatch.length === 2,
        "the proof batch must carry the canary plus ONLY the real v4 rows, got " +
        (proofBatch ? proofBatch.length : "none") + " requests");
    }

    // ب۲-۲) همان، ولی کلیدِ واقعی ریوِرت می‌دهد → همان null، هرگز nosell
    {
      const fetchImpl = async (url, init) => {
        const reqs = JSON.parse(init.body);
        const isProof = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
        return jsonRes(reqs.map((r) => {
          if (r.id === 0) return { id: 0, result: mkStatic4(5) };
          if (!isProof) return ambiguousWeth(r);
          return { id: r.id, error: { code: 3 } };
        }));
      };
      const res = await vd.fetchVerdict(TOKEN, meta,
        { fetchImpl, rpcs: ["https://rpc.example"], v4Keys: [REAL_USDC_KEY] });
      ok(res === null,
        "a reverting real USDC key must leave the answer at null — this pass may only ever turn null " +
        "into sell, never into nosell (got " + res + ")");
    }

    // ب۲-۳) بدونِ کلیدِ واقعیِ USDC: رفتار باید بایت‌به‌بایت همان دیروز باشد،
    // یعنی حتی یک فراخوانیِ اضافه هم نباید زده شود.
    {
      let calls = 0;
      const fetchImpl = async (url, init) => {
        calls++;
        const reqs = JSON.parse(init.body);
        return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : ambiguousWeth(r))));
      };
      const res = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc.example"] });
      ok(res === null && calls === 1,
        "with no real USDC key an ambiguous weth stage must end exactly as it did before — one batch, " +
        "null, no extra call (got " + res + ", " + calls + " calls)");
    }

    /* ب۲-۳ب) 🔴 صداقت درباره‌ی چیزی که نگهبان ندارد:
       نوشتنِ `=== "sell" ? "sell" : null` در گذرِ اثبات را عمداً برداشتم و
       سوییت **سبز ماند**. دلیلش این است که دسته‌ی اثبات فقط ردیف‌های v4
       دارد و تا وقتی VD_POSITIVE_ONLY.V4_SINGLE برقرار است، verdictFrom از
       چنین دسته‌ای اصلاً نمی‌تواند "nosell" بسازد — پس آن باریک‌سازی امروز
       رفتارِ قابلِ‌سنجشی ندارد.
       یعنی امنیتِ این گذر روی همان پرچم سوار است. این پروب همان وابستگی را
       پین می‌کند: اگر روزی کسی پرچم را برگرداند، این خط قرمز می‌شود و
       یادآوری می‌کند که باریک‌سازیِ fetchVerdict تنها چیزی است که بینِ این
       گذر و یک منفیِ کاذب ایستاده. خودِ باریک‌سازی می‌ماند، چون درست است —
       ولی ادعا نمی‌کنیم آزموده شده. */
    ok(vd.VD_POSITIVE_ONLY.V4_SINGLE === true,
      "the USDC proof pass is only safe because every row it sends is positive-only. If this flag is " +
      "ever flipped, the `=== \"sell\"` narrowing in fetchVerdict becomes the sole guard against a " +
      "false negative — and that narrowing has no behavioural test of its own");

    // ب۲-۴) کلیدِ واقعی که ضدجفتش USDC *نیست* نباید این گذر را باز کند
    {
      let calls = 0;
      const wethKey = {
        currency0: TOKEN.toLowerCase(), currency1: vd.WETH_ADDR.toLowerCase(),
        fee: 3000, tickSpacing: 60, hooks: vd.NATIVE_ADDR,
      };
      const fetchImpl = async (url, init) => {
        calls++;
        const reqs = JSON.parse(init.body);
        return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : ambiguousWeth(r))));
      };
      const res = await vd.fetchVerdict(TOKEN, meta,
        { fetchImpl, rpcs: ["https://rpc.example"], v4Keys: [wethKey] });
      ok(res === null && calls === 1,
        "a real key whose counter is not USDC must not open the proof pass — it already rode along on " +
        "the weth stage (got " + res + ", " + calls + " calls)");
    }
  }

  // ج) اندپوینتِ اول پرتاب می‌کند → اندپوینتِ دوم جواب می‌دهد
  // ⚠️ همان دلیلِ بالا: SOLIDLY با ریوِرتِ کدِ ۳ رد می‌شود، نه "0x"، وگرنه
  // نتیجه‌ی هر دو مرحله روی اندپوینتِ دوم نامعلوم می‌شد.
  {
    let calls = 0;
    const rpcs = ["https://rpc-bad.example", "https://rpc-good.example"];
    const fetchImpl = async (url, init) => {
      calls++;
      if (url === rpcs[0]) throw new Error("network is down");
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : isSolidlyReqId(r.id) ? { id: r.id, error: { code: 3 } } : { id: r.id, result: "0x" });
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

  // simErr: نتیجه‌ی شبیه‌سازیِ *رفت‌وبرگشت* (تماسِ اولِ simulateTransaction).
  // controlErr: نتیجه‌ی شبیه‌سازیِ *کنترل* (تماسِ دومِ simulateTransaction، فقط
  // وقتی رفت‌وبرگشت موفق شده باشد) — پیش‌فرضش "INSTR" است چون این همان
  // چیزی است که مسیرِ سبزِ واقعی انتظار دارد: خرید چیزی تحویل داد که فروشِ
  // تنها بدونش شکست می‌خورد، پس کنترل باید شکست بخورد تا verdict واقعاً
  // "sell" شود. controlSimStatus فقط تماسِ دومِ simulateTransaction را (نه
  // اولی را) به یک ۵۰۰ HTTP می‌شکند — جدا از rpcStatus.simulateTransaction
  // که فقط تماسِ اول را می‌شکند (هر دو روی همان نامِ متد نشسته‌اند، پس یک
  // شمارنده لازم است تا این دو از هم جدا بمانند).
  function makeFetch({ legs, lamports = 2_000_000_000, simErr = "SUCCESS", controlErr = "INSTR",
                       buyQuoteOk = true, buyQuoteEmpty = false, rpcStatus = {}, controlSimStatus = null,
                       altData = null } = {}) {
    const calls = [];
    let simCalls = 0;
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
      if (body.method === "simulateTransaction") {
        simCalls++;
        if (simCalls === 1) {
          if (rpcStatus.simulateTransaction) return new Response("boom", { status: rpcStatus.simulateTransaction });
          const err = simErr === "SUCCESS" ? null
            : simErr === "INSTR" ? { InstructionError: [1, { Custom: 6001 }] }
            : simErr;
          return rpcOk({ value: { err } });
        }
        // دومین تماس = شبیه‌سازیِ کنترل (فقط legِ فروش، بدونِ خرید).
        if (controlSimStatus) return new Response("boom", { status: controlSimStatus });
        const err = controlErr === "SUCCESS" ? null
          : controlErr === "INSTR" ? { InstructionError: [2, { Custom: 6002 }] }
          : controlErr;
        return rpcOk({ value: { err } });
      }
      if (rpcStatus[body.method]) return new Response("boom", { status: rpcStatus[body.method] });
      if (body.method === "getBalance") return rpcOk({ value: lamports });
      if (body.method === "getMultipleAccounts" && altData) {
        const addrs = body.params[0];
        return rpcOk({ value: addrs.map(() => ({ data: [altData, "base64"] })) });
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
  //
  // خانواده‌ی "rpc:<method>:<status>" و "jup:<endpoint>:<status>" همیشه یک
  // عددِ صحیح در آخرین بخش دارند — پس اینجا هر why را از آخرین «:» می‌شکنیم:
  // اگر بخشِ آخر یک عددِ صحیح بود، *پیشوند* (همه‌چیز جز آن بخشِ آخر) باید
  // عضوِ VD_SOL_WHY باشد؛ وگرنه خودِ why بی‌کم‌وکاست باید عضو باشد (مثلِ
  // "payer-balance"، "too-big"، …، که هیچ‌وقت پسوندِ عددی نمی‌گیرند).
  function isFrozenWhy(why) {
    const s = String(why);
    const i = s.lastIndexOf(":");
    if (i > 0) {
      const suffix = s.slice(i + 1);
      if (/^-?\d+$/.test(suffix) && Number.isInteger(Number(suffix)))
        return vs.VD_SOL_WHY.includes(s.slice(0, i));
    }
    return vs.VD_SOL_WHY.includes(s);
  }

  // الف) مسیرِ سبز — رفت‌وبرگشت موفق *و* کنترل (فقط‌فروش) شکست می‌خورد
  // (پیش‌فرضِ controlErr="INSTR")، یعنی خرید واقعاً چیزی تحویل داد. یک
  // sell هیچ کلیدِ why‌ای ندارد، حتی به‌شکلِ undefined؛ و دو تماسِ
  // simulateTransaction دیده می‌شود، یکی رفت‌وبرگشت، یکی کنترل.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, simErr: "SUCCESS", controlErr: "INSTR" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === "sell", "happy path should return { v: \"sell\" } (got " + JSON.stringify(res) + ")");
    ok(!("why" in res), "a \"sell\" result must carry no why key at all: " + JSON.stringify(res));
    ok(calls.join(",") === "rpc:getBalance,quote:buy,quote:sell,swap-ix:buy,swap-ix:sell," +
      "rpc:simulateTransaction,rpc:simulateTransaction",
      "unexpected call sequence for the happy path (must include exactly two simulateTransaction " +
      "calls — roundtrip then control): " + calls.join(","));
    ok(!calls.includes("rpc:getTokenAccountsByOwner"),
      "getTokenAccountsByOwner must never be requested anywhere in the Solana path any more — the " +
      "held-mint check is now the control simulation, got calls: " + calls.join(","));
  }

  // ب) خطای سطحِ تراکنش (InstructionError) روی خودِ رفت‌وبرگشت → nosell،
  // باز هم بدونِ why — و 🔴 کنترل هرگز صدا زده نمی‌شود، چون رفت‌وبرگشت خودش
  // از قبل رد شده و چیزی برای اثبات‌کردن نمانده. شمارشِ خودِ تماس‌ها همین
  // را ثابت می‌کند: فقط یک simulateTransaction، نه دوتا.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, simErr: "INSTR" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === "nosell", "a transaction-level InstructionError should give { v: \"nosell\" } " +
      "(got " + JSON.stringify(res) + ")");
    ok(!("why" in res), "a \"nosell\" result must carry no why key at all: " + JSON.stringify(res));
    ok(calls.filter((c) => c === "rpc:simulateTransaction").length === 1,
      "a failed roundtrip must never trigger the control simulation — expected exactly one " +
      "simulateTransaction call, got: " + calls.join(","));
  }

  // ج) 🔴 رفت‌وبرگشت موفق می‌شود *و* کنترل (فقط‌فروش) هم به‌تنهایی موفق
  // می‌شود → null/"payer-holds": فی‌پیر از قبل موجودی داشته، پس رفت‌وبرگشت
  // هیچ چیزی اثبات نکرد — همان تله‌ای که چهار نتیجه‌ی اولِ اسپایک را
  // بی‌معنی کرده بود، این‌بار گرفته‌شده با اجرا نه با یک lookup.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, simErr: "SUCCESS", controlErr: "SUCCESS" });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "payer-holds" && isFrozenWhy(res.why),
      "a payer for whom the sell-only control transaction also succeeds must give " +
      "null/\"payer-holds\", never \"sell\" (got " + JSON.stringify(res) + ")");
    ok(calls.filter((c) => c === "rpc:simulateTransaction").length === 2,
      "\"payer-holds\" must only be reached after the control simulation actually ran (both " +
      "simulateTransaction calls), got: " + calls.join(","));
  }

  // ج۲) 🔴 رفت‌وبرگشت موفق می‌شود، ولی خودِ تماسِ RPCِ کنترل شکست می‌خورد
  // (۵۰۰) → null/"rpc:simulateTransaction"، هرگز sell — دقیقاً همان قاعده‌ی
  // بالای فایل: بدونِ اجرای واقعیِ کنترل، «sell» ممنوع است.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, simErr: "SUCCESS", controlSimStatus: 500 });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "rpc:simulateTransaction:500" && isFrozenWhy(res.why),
      "a failed RPC call for the control simulation must give null/\"rpc:simulateTransaction:500\", " +
      "never \"sell\" (got " + JSON.stringify(res) + ")");
    ok(calls.filter((c) => c === "rpc:simulateTransaction").length === 2,
      "the control call must actually have been attempted (and failed), got: " + calls.join(","));
  }

  // ج۳) 🔴 رفت‌وبرگشت موفق می‌شود، ولی مهلت درست پیش از کنترل تمام می‌شود →
  // null/"deadline"، هرگز sell — کنترل حتی یک بار هم فراخوانی نمی‌شود.
  {
    const legs = makeLegs();
    const { fetchImpl: baseFetch, calls } = makeFetch({ legs, simErr: "SUCCESS" });
    let past = false;
    const now = () => (past ? 999_999 : 0);
    const fetchImpl = async (url, init) => {
      const res = await baseFetch(url, init);
      // فقط تماس‌های RPC (نه quote/swap-instructionِ جوپیتر که بدونِ init.body می‌روند)
      // بدنه‌ی JSON-RPC دارند؛ init.body برای GETِ quote اصلاً ست نمی‌شود.
      const body = init.body ? JSON.parse(init.body) : null;
      if (body && body.method === "simulateTransaction") past = true; // بعدِ اولین شبیه‌سازی، مهلت را تمام‌شده اعلام کن
      return res;
    };
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl, now, deadlineAt: 10_000 }));
    ok(res && res.v === null && res.why === "deadline" && isFrozenWhy(res.why),
      "a deadline hit exactly before the control simulation must give null/\"deadline\", never " +
      "\"sell\" (got " + JSON.stringify(res) + ")");
    ok(calls.filter((c) => c === "rpc:simulateTransaction").length === 1,
      "the control simulation must never be attempted once the deadline is gone, got calls: " +
      calls.join(","));
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
    ok(res && res.v === null && res.why === "jup:quote:404" && isFrozenWhy(res.why),
      "a non-200 quote response from Jupiter must give null/\"jup:quote:404\", not \"nosell\" " +
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

  // ز) ۵۰۰ از خودِ simulateTransactionِ رفت‌وبرگشت (تماسِ اول) → null/"rpc"،
  // نه nosell — و کنترل هرگز فراخوانی نمی‌شود چون خودِ رفت‌وبرگشت جواب نداد.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs, rpcStatus: { simulateTransaction: 500 } });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "rpc:simulateTransaction:500" && isFrozenWhy(res.why),
      "a 500 from simulateTransaction must give null/\"rpc:simulateTransaction:500\", not \"nosell\" " +
      "(got " + JSON.stringify(res) + ")");
    ok(calls.filter((c) => c === "rpc:simulateTransaction").length === 1,
      "a failed roundtrip simulateTransaction call must never be followed by a control call, got: " +
      calls.join(","));
  }

  // ز۲) ۵۰۰ از خودِ swap-instructionِ leg خرید → null/"jup:swap-instructions"، جدا از
  // "jup:quote" — این دو زیرِ یک "jup" واحد قاطی نمی‌شوند.
  {
    const legs = makeLegs();
    const { fetchImpl, calls } = makeFetch({ legs });
    const wrapped = async (url, init) => {
      const u = String(url);
      if (u.startsWith(JUP + "/swap/v1/swap-instructions")) {
        const body = JSON.parse(init.body);
        if (body.quoteResponse.outAmount === "1000000") return new Response("boom", { status: 500 });
      }
      return fetchImpl(url, init);
    };
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl: wrapped }));
    ok(res && res.v === null && res.why === "jup:swap-instructions:500" && isFrozenWhy(res.why),
      "a 500 from the buy leg's swap-instructions must give null/\"jup:swap-instructions:500\" " +
      "(got " + JSON.stringify(res) + ")");
    ok(!calls.includes("swap-ix:sell"),
      "a failed buy-leg swap-instructions must stop before the sell leg is even requested, got: " +
      calls.join(","));
  }

  // ز۳) جدولِ آدرس (ALT) حاضر است، ولی getMultipleAccounts خودش ۵۰۰ می‌دهد →
  // null/"rpc:getMultipleAccounts" — این تماس فقط وقتی اتفاق می‌افتد که
  // altAddrs خالی نباشد، پس این تنها بخشی است که یک ALT واقعی تزریق می‌کند.
  {
    const ALT_ADDR = fakePubkey(50);
    const legs = makeLegs();
    legs.legBuy.addressLookupTableAddresses = [ALT_ADDR];
    const { fetchImpl, calls } = makeFetch({ legs, rpcStatus: { getMultipleAccounts: 500 } });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "rpc:getMultipleAccounts:500" && isFrozenWhy(res.why),
      "a 500 from getMultipleAccounts (fetching an address-lookup table) must give " +
      "null/\"rpc:getMultipleAccounts:500\" (got " + JSON.stringify(res) + ")");
    ok(!calls.includes("rpc:simulateTransaction"),
      "a failed getMultipleAccounts must stop before simulateTransaction, got: " + calls.join(","));
  }

  // ز۴) همان ALT، این‌بار جواب می‌دهد و یک LookupTable معتبر (بدونِ آدرس) برمی‌گرداند →
  // مسیر همچنان تا sell می‌رسد — اثبات می‌کند حاضربودنِ یک ALT خودش چیزی را
  // نمی‌شکند، فقط شکستِ خودِ تماس why می‌سازد.
  {
    const ALT_ADDR = fakePubkey(51);
    const altHeader = new Uint8Array(56); // discriminant=1 (LE)، بقیه صفر، صفر آدرس دنبالش
    altHeader[0] = 1;
    const legs = makeLegs();
    legs.legBuy.addressLookupTableAddresses = [ALT_ADDR];
    const { fetchImpl, calls } = makeFetch({ legs, altData: vs.bytesToBase64(altHeader) });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === "sell", "a valid (empty) address-lookup table must not block the happy path " +
      "(got " + JSON.stringify(res) + ")");
    ok(calls.includes("rpc:getMultipleAccounts"),
      "getMultipleAccounts must actually be called once an ALT address is present, got: " + calls.join(","));
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

  // ط) شکلِ err کنترل ناشناخته (نه null، نه InstructionError) → "internal"،
  // نه throw و نه به‌اشتباه sell یا payer-holds.
  {
    const legs = makeLegs();
    const { fetchImpl } = makeFetch({ legs, simErr: "SUCCESS", controlErr: { Unknown: true } });
    const res = await vs.fetchVerdictSol(MINT, opts({ fetchImpl }));
    ok(res && res.v === null && res.why === "internal" && isFrozenWhy(res.why),
      "an unrecognised control-simulation err shape must give null/\"internal\" without throwing " +
      "(got " + JSON.stringify(res) + ")");
  }

  // ی) "unsupported" را هیچ مسیری در fetchVerdictSol تولید نمی‌کند (بالای
  // verdict_sol.js توضیح داده چرا) — فقط عضویتش در فهرستِ منجمد سنجیده می‌شود.
  ok(isFrozenWhy("unsupported"), "\"unsupported\" must still be a member of the frozen reason vocabulary");

  // ک) توافق: VD_SOL_RPC_METHODS باید دقیقاً همان متدهایی باشد که خودِ کدِ
  // verdict_sol.js به rpcCall پاس می‌دهد — استخراج‌شده با regex از متنِ خودِ
  // فایل، نه یک فهرستِ دستیِ دیگر در همین تست؛ اگر یک rpcCall تازه اضافه شود
  // بدونِ افزودنِ متدش به VD_SOL_RPC_METHODS، این چک باید بشکند.
  {
    const src = fs.readFileSync(new URL("./verdict_sol.js", import.meta.url), "utf8");
    const seen = new Set();
    const re = /rpcCall\(\s*fetchImpl\s*,\s*[^,]+,\s*"([A-Za-z]+)"/g;
    let m;
    while ((m = re.exec(src))) seen.add(m[1]);
    const fromCode = Array.from(seen).sort();
    const declared = [...vs.VD_SOL_RPC_METHODS].sort();
    ok(fromCode.length > 0 && fromCode.length === declared.length &&
      fromCode.every((method, i) => method === declared[i]),
      "VD_SOL_RPC_METHODS must match exactly the methods literally passed to rpcCall(...) inside " +
      "verdict_sol.js — regex-derived from the source: [" + fromCode.join(",") + "], declared: [" +
      declared.join(",") + "]");
  }

  console.log("[fetchVerdictSol] happy path -> roundtrip ok + control (sell-only) fails -> " +
    "{v:\"sell\"} with no why key, exactly two simulateTransaction calls; roundtrip " +
    "InstructionError -> {v:\"nosell\"} with the control never called (call count asserted); " +
    "roundtrip ok + control also ok -> null/\"payer-holds\"; roundtrip ok + control's RPC call " +
    "fails -> null/\"rpc:simulateTransaction\" (never \"sell\"); roundtrip ok + deadline hit right " +
    "before the control -> null/\"deadline\" (never \"sell\", control never attempted); " +
    "getTokenAccountsByOwner is asserted absent from the whole Solana path; an underfunded payer " +
    "or an unreadable getBalance shape -> \"payer-balance\"; a non-200 Jupiter quote -> " +
    "\"jup:quote\"; a 200 quote with no route -> \"no-route\"; an oversized (>1232 byte) transaction " +
    "-> \"too-big\"; a 500 from getMultipleAccounts/simulateTransaction -> the matching " +
    "\"rpc:<method>\"; a 500 from swap-instructions -> \"jup:swap-instructions\"; a valid empty " +
    "address-lookup table does not block the happy path; a past deadline (before any call) -> " +
    "\"deadline\" with zero fetch calls; an unrecognised control err shape -> \"internal\"; every " +
    "observed why checked against VD_SOL_WHY by iterating the actual frozen list; VD_SOL_RPC_METHODS " +
    "checked against the methods regex-derived from verdict_sol.js itself — all against an injected " +
    "fake, no real RPC or Jupiter call involved");
}

/* ---- ۱۸ب. fetchVerdictSol — failover بینِ چند اندپوینتِ RPC ----
   طبقِ کامنتِ بالای حلقه در verdict_sol.js: failover فقط برای تماسِ *اولِ*
   RPC (getBalance) است؛ هر اندپوینتی که همان‌جا جواب داد، تا آخرِ همان
   درخواست چسبیده می‌ماند. این بخش هم روی یک fetchImpl جعلی است — هیچ
   ادعایی درباره‌ی اینکه کدام‌یک از VD_SOL_RPCS واقعاً از کلادفلر جواب
   می‌دهد نمی‌کند؛ آن سوال فقط با GET /vd/rpc (بخشِ ۲۰، بازهم جعلی در همین
   کانتینر) قابلِ‌سنجش است، و حتی آن هم فقط بعدِ دیپلویِ واقعی معنا پیدا می‌کند. */
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
  function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  function rpcOk(result) { return jsonRes({ jsonrpc: "2.0", id: 1, result }); }

  const PAYER = vs.VD_SOL_PAYER;
  const MINT = fakePubkey(210);
  const PROGRAM = fakePubkey(211);
  const JUP = vs.VD_SOL_JUP_BASE;

  // یک رفت‌وبرگشتِ کوچکِ کاملاً معتبر (همان الگوی بخشِ ۱۹) — این بخش رفتارِ
  // خودِ failover را می‌سنجد، نه بقیه‌ی خط‌لوله را، پس بعد از getBalance
  // موفق همه‌چیزِ دیگر مسیرِ سبز می‌گیرد.
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

  // behaviors: نقشه‌ی url -> "throw" | "403" | "ok"، فقط برای متدِ getBalance.
  function makeFailoverFetch(behaviors) {
    const calls = []; // فقط تماس‌های getBalance، به‌ترتیبِ اندپوینتِ زده‌شده
    let simCalls = 0;
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (u.startsWith(JUP + "/swap/v1/quote")) {
        const isBuy = u.includes("onlyDirectRoutes=true");
        return jsonRes({ outAmount: isBuy ? "1000000" : "40000000", routePlan: [{}] });
      }
      if (u.startsWith(JUP + "/swap/v1/swap-instructions")) {
        const body = JSON.parse(init.body);
        const isBuy = body.quoteResponse.outAmount === "1000000";
        return jsonRes(isBuy ? legBuy : legSell);
      }
      const body = JSON.parse(init.body);
      if (body.method === "getBalance") {
        calls.push(u);
        const behavior = behaviors[u];
        if (behavior === "throw") throw new Error("network down");
        if (behavior === "403") return new Response("forbidden", { status: 403 });
        return rpcOk({ value: 2_000_000_000 });
      }
      if (body.method === "simulateTransaction") {
        simCalls++;
        // اولی رفت‌وبرگشت (موفق)، دومی کنترل (InstructionError) — تا verdict
        // نهایی واقعاً به sell برسد، نه اینکه در payer-holds گیر کند.
        return rpcOk({ value: { err: simCalls === 1 ? null : { InstructionError: [1, { Custom: 1 }] } } });
      }
      return jsonRes({ error: { code: -1, message: "unexpected method " + body.method } }, 500);
    };
    return { fetchImpl, calls };
  }

  const RPC1 = "https://rpc1.example", RPC2 = "https://rpc2.example",
        RPC3 = "https://rpc3.example", RPC4 = "https://rpc4.example";

  // الف) اولی throw می‌کند، دومی جواب می‌دهد → sell
  {
    const { fetchImpl, calls } = makeFailoverFetch({ [RPC1]: "throw", [RPC2]: "ok" });
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, rpcs: [RPC1, RPC2, RPC3], jupBase: JUP, payer: PAYER });
    ok(res && res.v === "sell", "failover to the second endpoint should still reach \"sell\" (got " +
      JSON.stringify(res) + ")");
    ok(calls.join(",") === RPC1 + "," + RPC2,
      "expected exactly two getBalance attempts (first thrown, second answering), got: " + calls.join(","));
  }

  // ب) اولین دوتا ۴۰۳، سومی جواب می‌دهد → sell
  {
    const { fetchImpl, calls } = makeFailoverFetch({ [RPC1]: "403", [RPC2]: "403", [RPC3]: "ok" });
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, rpcs: [RPC1, RPC2, RPC3], jupBase: JUP, payer: PAYER });
    ok(res && res.v === "sell", "failover past two HTTP 403s to a third endpoint should reach \"sell\" " +
      "(got " + JSON.stringify(res) + ")");
    ok(calls.join(",") === RPC1 + "," + RPC2 + "," + RPC3,
      "expected exactly three getBalance attempts, got: " + calls.join(","));
  }

  // ج) هر چهار کاندید شکست می‌خورند → null/"rpc"، ولی فقط ۳تا (نه ۴تا) امتحان می‌شود —
  // کاندیدِ چهارم حتی جواب هم می‌داد ("ok")، ولی سقفِ VD_SOL_RPC_MAX_TRIES هرگز اجازه‌ی
  // امتحان‌کردنش را نمی‌دهد.
  {
    const { fetchImpl, calls } = makeFailoverFetch({ [RPC1]: "throw", [RPC2]: "403", [RPC3]: "throw", [RPC4]: "ok" });
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, rpcs: [RPC1, RPC2, RPC3, RPC4], jupBase: JUP, payer: PAYER });
    ok(res && res.v === null && res.why === "rpc:getBalance:0", "when every tried endpoint fails the " +
      "verdict must stay null/\"rpc:getBalance:0\" (the last attempt's status — RPC3 threw), never " +
      "\"nosell\" (got " + JSON.stringify(res) + ")");
    ok(calls.length === vs.VD_SOL_RPC_MAX_TRIES,
      "at most VD_SOL_RPC_MAX_TRIES (" + vs.VD_SOL_RPC_MAX_TRIES + ") endpoints may be tried in one " +
      "request — got " + calls.length + ": " + calls.join(","));
    ok(!calls.includes(RPC4),
      "the fourth candidate (which would have answered) must never be reached once the cap is hit: " +
      calls.join(","));
  }

  // د) مهلت با کمتر از ۴۰۰میلی‌ثانیه باقیمانده → حتی اولین اندپوینت هم امتحان نمی‌شود
  {
    const { fetchImpl, calls } = makeFailoverFetch({ [RPC1]: "ok" });
    const res = await vs.fetchVerdictSol(MINT,
      { fetchImpl, rpcs: [RPC1, RPC2, RPC3], jupBase: JUP, payer: PAYER, now: () => 10_000, deadlineAt: 10_300 });
    ok(res && res.v === null && res.why === "deadline" && calls.length === 0,
      "with under 400ms left on the deadline, not even the first endpoint should be tried (got " +
      JSON.stringify(res) + ", " + calls.length + " getBalance calls)");
  }

  // ه) env.SOL_RPC — همان الگویِ env.CG_KEY. solRpcsFor (worker/index.js) آن
  // را جلوی VD_SOL_RPCS می‌گذارد، بدونِ لمسِ خودِ فهرستِ عمومی. اول ثابت
  // می‌کنیم solRpcsFor خودش درست است (بدونِ هیچ RPC واقعی)، بعد با
  // fetchVerdictSol واقعی می‌سنجیم که خودِ failover هم همین ترتیب را
  // رعایت می‌کند و سقفِ VD_SOL_RPC_MAX_TRIES رویِ فهرستِ *ترکیب‌شده* اعمال
  // می‌شود، نه رویِ هرکدام جدا.
  {
    const { solRpcsFor } = await import("./index.js");
    // کلید هم در مسیر هم در کوئری — دقیقاً همان دو جایی که یک URL می‌تواند
    // یک کلید را حمل کند؛ بخشِ «۴. secret leak» پایین‌تر همین دو رشته را
    // در خروجیِ /vd/rpc جست‌وجو می‌کند.
    const SECRET_URL = "https://priv-rpc.example/token/SUPERSECRETPATH?api-key=SUPERSECRETQUERY";

    ok(solRpcsFor({}).join(",") === vs.VD_SOL_RPCS.join(","),
      "solRpcsFor with no SOL_RPC must leave today's public list untouched: " +
      JSON.stringify(solRpcsFor({})));
    ok(solRpcsFor(undefined).join(",") === vs.VD_SOL_RPCS.join(","),
      "solRpcsFor must defend against a missing env, exactly like CG_KEY's own read");
    ok(solRpcsFor({ SOL_RPC: 123 }).join(",") === vs.VD_SOL_RPCS.join(","),
      "a non-string SOL_RPC must be ignored, exactly like a non-string CG_KEY would be");

    const withSecret = solRpcsFor({ SOL_RPC: SECRET_URL });
    ok(withSecret[0] === SECRET_URL && withSecret.length === vs.VD_SOL_RPCS.length + 1 &&
      withSecret.slice(1).join(",") === vs.VD_SOL_RPCS.join(","),
      "solRpcsFor with SOL_RPC set must try it first, with the public list intact behind it: " +
      JSON.stringify(withSecret));

    // SOL_RPC خودش شکست می‌خورد (throw) → failover باید همان‌طور که برای
    // هر اندپوینتِ معمولی می‌رود به فهرستِ عمومی برود؛ سقفِ ۳ کلِ فهرستِ
    // ترکیب‌شده (SOL_RPC + عمومی) را می‌شمارد، نه فقط فهرستِ عمومی را.
    const { fetchImpl, calls } = makeFailoverFetch({
      [SECRET_URL]: "throw", [withSecret[1]]: "403", [withSecret[2]]: "ok",
    });
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, rpcs: withSecret, jupBase: JUP, payer: PAYER });
    ok(res && res.v === "sell", "a failing SOL_RPC should still fail over into the public list " +
      "(got " + JSON.stringify(res) + ")");
    ok(calls.join(",") === SECRET_URL + "," + withSecret[1] + "," + withSecret[2],
      "SOL_RPC must be the first URL actually fetched, ahead of any public host, and the cap " +
      "(VD_SOL_RPC_MAX_TRIES) must apply to the combined list — got: " + calls.join(","));
  }

  console.log("[fetchVerdictSol rpc failover] first-endpoint-only failover (getBalance): a thrown " +
    "fetch or a 403 moves to the next endpoint and the winner sticks for the rest of the request; " +
    "at most " + vs.VD_SOL_RPC_MAX_TRIES + " endpoints tried per request; every candidate failing " +
    "gives null/\"rpc:getBalance:<status>\" (never \"nosell\"); an under-400ms deadline tries zero " +
    "endpoints; env.SOL_RPC (via solRpcsFor) is tried first ahead of the public list, falls back " +
    "into it on failure, and the cap still applies to the combined list — all against an injected " +
    "fake, no claim made about which real endpoint answers");
}

/* ---- ۱۸ج. env.JUP_KEY — کلیدِ جوپیتر، فقط در هدر ----
   دقیقاً همان الگوی env.CG_KEY/env.SOL_RPC: خوانده‌شده defensively با
   jupKeyFor (worker/index.js)، در هر چهار جوپیترCall به‌عنوانِ هدرِ
   x-api-key سوار می‌شود، و هرگز در URL. این بخش fetchVerdictSol را
   مستقیم می‌سنجد (نه سرتاسری) تا خودِ init.headers بازرسی شود، نه فقط
   رشته‌ی URL — بخشِ ۱۸د (بعدی) همین چیز را سرتاسری، از دلِ worker.fetch،
   می‌سنجد. */
{
  const vs = await import("./verdict_sol.js");
  const { jupKeyFor } = await import("./index.js");

  // الف) jupKeyFor خودش — همان آزمونی که solRpcsFor بالا برایِ SOL_RPC پس داد.
  ok(jupKeyFor({}) === "", "jupKeyFor with no JUP_KEY must read as empty, exactly like CG_KEY's own read: " +
    JSON.stringify(jupKeyFor({})));
  ok(jupKeyFor(undefined) === "", "jupKeyFor must defend against a missing env, exactly like CG_KEY's own read");
  ok(jupKeyFor({ JUP_KEY: 123 }) === "",
    "a non-string JUP_KEY must be ignored, exactly like a non-string CG_KEY would be");
  ok(jupKeyFor({ JUP_KEY: "sk-live-123" }) === "sk-live-123",
    "jupKeyFor must return the key string as-is when it is present and a string");

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
  function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  function rpcOk(result) { return jsonRes({ jsonrpc: "2.0", id: 1, result }); }

  const PAYER = vs.VD_SOL_PAYER;
  const MINT = fakePubkey(300);
  const PROGRAM = fakePubkey(301);
  const JUP = vs.VD_SOL_JUP_BASE;
  const RPC = "https://rpc-jupkey.example";
  const SECRET = "sk-live-JUPSECRET-do-not-leak-9F3q";

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

  // fetchImpl مشترک برای ب/ج پایین‌تر — یک رفت‌وبرگشتِ کوچکِ کاملاً معتبر
  // (همان الگوی بخشِ ۱۸ب)، به‌علاوه‌ی ثبتِ headersSeen برای هر تماسِ جوپیتری
  // (نه فقط quote — swap-instructions هم، چون init.headers آنجا از قبل
  // content-type دارد و jupCall باید رویِ همان شیء بنشیند، نه آن را دور بریزد).
  function makeFetch() {
    const calls = [];
    const headersSeen = []; // [{ url, headers }] فقط برای تماس‌های جوپیتری
    let simCalls = 0;
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (u.startsWith(JUP)) headersSeen.push({ url: u, headers: (init && init.headers) || {} });
      if (u.startsWith(JUP + "/swap/v1/quote")) {
        const isBuy = u.includes("onlyDirectRoutes=true");
        calls.push(isBuy ? "quote:buy" : "quote:sell");
        return jsonRes({ outAmount: isBuy ? "1000000" : "40000000", routePlan: [{}] });
      }
      if (u.startsWith(JUP + "/swap/v1/swap-instructions")) {
        const body = JSON.parse(init.body);
        const isBuy = body.quoteResponse.outAmount === "1000000";
        calls.push(isBuy ? "swap-ix:buy" : "swap-ix:sell");
        return jsonRes(isBuy ? legBuy : legSell);
      }
      const body = JSON.parse(init.body);
      calls.push("rpc:" + body.method);
      if (body.method === "getBalance") return rpcOk({ value: 2_000_000_000 });
      if (body.method === "simulateTransaction") {
        simCalls++;
        // اولی رفت‌وبرگشت (موفق)، دومی کنترل (InstructionError) — تا verdict
        // واقعاً به sell برسد، نه به payer-holds؛ این بخش رفتارِ خودِ کلید را
        // می‌سنجد، نه دوباره‌ی قواعدِ verdict که بخشِ ۱۸ از قبل پوشانده.
        return rpcOk({ value: { err: simCalls === 1 ? null : { InstructionError: [1, { Custom: 1 }] } } });
      }
      return jsonRes({ error: "unexpected" }, 500);
    };
    return { fetchImpl, calls, headersSeen };
  }

  // ب) JUP_KEY ست‌شده → هر چهار تماسِ جوپیتری (دو quote، دو swap-instructions)
  // هدرِ x-api-key را با همین مقدار حمل می‌کنند، و خودِ URL هیچ‌کدام کلید
  // را در خودش ندارد — init.headers بازرسی می‌شود، نه فقط رشته‌ی URL.
  {
    const { fetchImpl, headersSeen } = makeFetch();
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, rpcs: [RPC], jupBase: JUP, payer: PAYER, jupKey: SECRET });
    ok(res && res.v === "sell", "happy path with JUP_KEY set should still reach \"sell\" (got " +
      JSON.stringify(res) + ")");
    ok(headersSeen.length === 4,
      "expected exactly four Jupiter calls (two quotes, two swap-instructions), got " +
      headersSeen.length + ": " + headersSeen.map((h) => h.url).join(","));
    for (const { url, headers } of headersSeen) {
      ok(headers["x-api-key"] === SECRET,
        "every Jupiter request must carry the x-api-key header equal to JUP_KEY when it is set, " +
        "missing/wrong for " + url + " (got " + JSON.stringify(headers) + ")");
      ok(!url.includes(SECRET), "THE JUP KEY LEAKED INTO A JUPITER REQUEST URL: " + url);
    }
  }

  // ج) JUP_KEY غایب → هیچ هدرِ x-api-key‌ای اصلاً فرستاده نمی‌شود، و توالیِ
  // خودِ تماس‌ها همان چیزی می‌ماند که بخشِ ۱۸ (بدونِ این پارامتر) از قبل سنجید.
  {
    const { fetchImpl, calls, headersSeen } = makeFetch();
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, rpcs: [RPC], jupBase: JUP, payer: PAYER });
    ok(res && res.v === "sell", "happy path without JUP_KEY should still reach \"sell\" (got " +
      JSON.stringify(res) + ")");
    ok(headersSeen.every(({ headers }) => !("x-api-key" in headers)),
      "no x-api-key header should be sent when JUP_KEY is absent: " +
      JSON.stringify(headersSeen.map((h) => h.headers)));
    ok(calls.join(",") === "rpc:getBalance,quote:buy,quote:sell,swap-ix:buy,swap-ix:sell," +
      "rpc:simulateTransaction,rpc:simulateTransaction",
      "the call sequence without JUP_KEY must be byte-for-byte identical to today's sequence, got: " +
      calls.join(","));
  }

  // د) جوپیترِ ۴۰۱ (کلید نامعتبر/رد‌شده) با JUP_KEY ست‌شده → null/"jup:quote:401" —
  // واژه‌نامه‌ی why عوض نمی‌شود؛ کدِ HTTP همان چیزی است که به صاحب می‌گوید
  // کلید غلط است، بدونِ نیاز به متنِ پیام (طبقِ قاعده‌ی همیشگیِ این پروژه).
  {
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (u.startsWith(JUP + "/swap/v1/quote")) return jsonRes({ error: "invalid api key" }, 401);
      const body = JSON.parse(init.body);
      if (body.method === "getBalance") return rpcOk({ value: 2_000_000_000 });
      return jsonRes({ error: "unexpected" }, 500);
    };
    const res = await vs.fetchVerdictSol(MINT, { fetchImpl, rpcs: [RPC], jupBase: JUP, payer: PAYER, jupKey: SECRET });
    ok(res && res.v === null && res.why === "jup:quote:401" && vs.VD_SOL_WHY.includes("jup:quote"),
      "a 401 from Jupiter's quote with a key set must give null/\"jup:quote:401\", the reason " +
      "vocabulary unchanged (got " + JSON.stringify(res) + ")");
  }

  console.log("[env.JUP_KEY] jupKeyFor reads defensively, exactly like CG_KEY/SOL_RPC; with JUP_KEY " +
    "set every one of the four Jupiter calls (both quotes, both swap-instructions) carries " +
    "x-api-key equal to it, inspected via init.headers, and no Jupiter URL ever contains the key; " +
    "without JUP_KEY no x-api-key header is sent and the call sequence matches today's exactly; a " +
    "401 from Jupiter's quote with a key set gives null/\"jup:quote:401\" — all against an injected " +
    "fake, no real Jupiter call involved");
}

/* ---- ۱۸د. env.JUP_KEY سرتاسری — /vd/<mint> با globalThis.fetch جعلی ----
   دقیقاً همان الگوی بخشِ ۱۹ برایِ env.SOL_RPC: این‌بار کلید هرگز نباید در
   هیچ پاسخی ظاهر شود — نه در یک "sell"، نه در یک "nosell"، نه در یک null
   با why (اینجا jup:quote:401، تا هر دو ادعا در یک تیر برود). */
{
  const vs = await import("./verdict_sol.js");
  const SECRET_JUP = "sk-live-JUPSECRET-E2E-do-not-leak-Q7z";

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
  function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  function rpcOk(result) { return jsonRes({ jsonrpc: "2.0", id: 1, result }); }

  const PAYER = vs.VD_SOL_PAYER;
  const PROGRAM = fakePubkey(401);
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

  const spyEnv = {
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(req.url).pathname;
        return p === "/app" ? new Response("the site", { status: 200 })
                             : new Response("not found", { status: 404 });
      },
    },
    JUP_KEY: SECRET_JUP,
  };

  // سه مینتِ سولانا، هرکدام آخرین نویسه‌شان فرق دارد — همان ترفندِ بخشِ ۱۹،
  // با نویسه‌هایی که آنجا استفاده نشده‌اند (۳،۴) تا هیچ mint‌ای دوباره
  // استفاده نشود.
  const BASE_MINT = "So11111111111111111111111111111111111111112";
  const MINT_SELL = BASE_MINT.slice(0, -1) + "5";
  const MINT_NOSELL = BASE_MINT.slice(0, -1) + "6";
  const MINT_NULL = BASE_MINT.slice(0, -1) + "7";

  // الف) sell — و هر تماسِ جوپیتری همان‌جا بازرسی می‌شود که x-api-key دارد.
  {
    let simCalls = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/swap/v1/quote")) {
        ok(init.headers && init.headers["x-api-key"] === SECRET_JUP,
          "a quote call end to end with env.JUP_KEY set must carry x-api-key: " + u);
        const isBuy = u.includes("onlyDirectRoutes=true");
        return jsonRes({ outAmount: isBuy ? "1000000" : "40000000", routePlan: [{}] });
      }
      if (u.includes("/swap/v1/swap-instructions")) {
        ok(init.headers && init.headers["x-api-key"] === SECRET_JUP,
          "a swap-instructions call end to end with env.JUP_KEY set must carry x-api-key: " + u);
        const body = JSON.parse(init.body);
        const isBuy = body.quoteResponse.outAmount === "1000000";
        return jsonRes(isBuy ? legBuy : legSell);
      }
      const body = JSON.parse(init.body);
      if (body.method === "getBalance") return rpcOk({ value: 2_000_000_000 });
      if (body.method === "simulateTransaction") {
        simCalls++;
        return rpcOk({ value: { err: simCalls === 1 ? null : { InstructionError: [1, { Custom: 1 }] } } });
      }
      return jsonRes({ error: "unexpected" }, 500);
    };
    const res = await worker.fetch(new Request(ORIGIN + "/vd/" + MINT_SELL,
      { headers: { "cf-connecting-ip": "203.0.113.80" } }), spyEnv, {});
    const raw = await res.clone().text();
    const body = JSON.parse(raw);
    ok(body.v === "sell", "sell scenario with env.JUP_KEY set did not surface \"sell\": " + raw);
    ok(!raw.includes(SECRET_JUP), "THE JUP KEY LEAKED INTO A \"sell\" RESPONSE BODY: " + raw);
  }

  // ب) nosell — رفت‌وبرگشت خودش InstructionError می‌گیرد، کنترل هرگز صدا زده نمی‌شود.
  {
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
      if (body.method === "simulateTransaction")
        return rpcOk({ value: { err: { InstructionError: [1, { Custom: 1 }] } } });
      return jsonRes({ error: "unexpected" }, 500);
    };
    const res = await worker.fetch(new Request(ORIGIN + "/vd/" + MINT_NOSELL,
      { headers: { "cf-connecting-ip": "203.0.113.81" } }), spyEnv, {});
    const raw = await res.clone().text();
    const body = JSON.parse(raw);
    ok(body.v === "nosell", "nosell scenario with env.JUP_KEY set did not surface \"nosell\": " + raw);
    ok(!raw.includes(SECRET_JUP), "THE JUP KEY LEAKED INTO A \"nosell\" RESPONSE BODY: " + raw);
  }

  // ج) null (۴۰۱ از quote خرید، کلید رد شده) → jup:quote:401 — و کلید همان‌جا
  // نه در why نه در هیچ کلیدِ دیگرِ بدنه نیست.
  {
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/swap/v1/quote")) {
        ok(init.headers && init.headers["x-api-key"] === SECRET_JUP,
          "the quote call must still carry x-api-key even on the path that ends in a 401: " + u);
        return jsonRes({ error: "unauthorized" }, 401);
      }
      const body = JSON.parse(init.body);
      if (body.method === "getBalance") return rpcOk({ value: 2_000_000_000 });
      return jsonRes({ error: "unexpected" }, 500);
    };
    const res = await worker.fetch(new Request(ORIGIN + "/vd/" + MINT_NULL,
      { headers: { "cf-connecting-ip": "203.0.113.82" } }), spyEnv, {});
    const raw = await res.clone().text();
    const body = JSON.parse(raw);
    ok(body.v === null && body.why === "jup:quote:401" && vs.VD_SOL_WHY.includes("jup:quote"),
      "a 401 from Jupiter's quote end to end with a key set must give null/\"jup:quote:401\" " +
      "(got " + raw + ")");
    ok(!raw.includes(SECRET_JUP),
      "THE JUP KEY LEAKED INTO A null-VERDICT RESPONSE BODY (why included): " + raw);
  }

  globalThis.fetch = trackingFetch; // برگرداندنِ موکِ پیش‌فرض برای هرچه بعد از این اجرا می‌شود
  console.log("[env.JUP_KEY e2e] env.JUP_KEY set end to end through worker.fetch: every Jupiter call " +
    "(quote and swap-instructions) carries x-api-key, and the key never appears in the response " +
    "body for a \"sell\", a \"nosell\", or a null/\"jup:quote:401\" outcome");
}

/* ---- ۱۹. /vd/<mint سولانا> سرتاسری، و /t/<mint سولانا> → ۲۰۰ ----
   همان مسیرِ واقعیِ index.js (diagVerdict -> solFetchVerdict -> fetchVerdictSol)
   با globalThis.fetch جعلی، دقیقاً مثلِ بخشِ ۱۳.
   ⚠️ /t/<mint سولانا> دیگر ۴۰۴ نمی‌گیرد — web/index.html حالا یک حالتِ
   فقط-چکِ سولانا دارد، پس همان صفحه‌ی اصلی (زیرِ /app) سرو می‌شود. */
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

  let e2eSimCalls = 0;
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
    if (body.method === "simulateTransaction") {
      e2eSimCalls++;
      // اولی رفت‌وبرگشت (موفق)، دومی کنترل (InstructionError) — تا verdict
      // سرتاسری واقعاً به sell برسد، نه به payer-holds.
      return rpcOk({ value: { err: e2eSimCalls === 1 ? null : { InstructionError: [1, { Custom: 1 }] } } });
    }
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
  ok(tRes.status === 200, "/t/<solana mint> should now serve the app, exactly like a Base address " +
    "(got " + tRes.status + ")");
  ok((await tRes.clone().text()) === "the site",
    "/t/<solana mint> did not ask ASSETS for \"/app\" — got a different body than the Base case");

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

  // یک mint سوم — این‌بار با env.SOL_RPC ست‌شده (کلید در مسیر و کوئریِ خودِ
  // URL) و getBalance شکست‌خورده روی همان اندپوینتِ اختصاصی، تا ثابت شود
  // مسیرِ سرتاسریِ /vd هم why را با پسوندِ عددیِ جدید می‌سازد *و* مسیر/کوئریِ
  // SOL_RPC هیچ‌جای بدنه ظاهر نمی‌شود — نه در why، نه در هیچ کلیدِ دیگر.
  const SOL_ADDR_3 = "So11111111111111111111111111111111111111112".slice(0, -1) + "4";
  const SECRET_PATH_3 = "SUPERSECRETPATH3";
  const SECRET_QUERY_3 = "SUPERSECRETQUERY3";
  const SOL_RPC_URL_3 = "https://priv-rpc-3.example/token/" + SECRET_PATH_3 + "?api-key=" + SECRET_QUERY_3;
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    if (b.method === "getBalance") return new Response("forbidden", { status: 403 }); // فقط SOL_RPC صدا زده می‌شود، همیشه ۴۰۳
    return jsonRes({ error: "unexpected" }, 500);
  };
  const res3 = await worker.fetch(new Request(ORIGIN + "/vd/" + SOL_ADDR_3,
    { headers: { "cf-connecting-ip": "203.0.113.63" } }), { ...spyEnv, SOL_RPC: SOL_RPC_URL_3 }, {});
  const body3 = await res3.json();
  const raw3 = JSON.stringify(body3);
  ok(body3.v === null && body3.why === "rpc:getBalance:403" && vs.VD_SOL_WHY.includes("rpc:getBalance"),
    "/vd end to end with SOL_RPC set must surface the new \"rpc:<method>:<status>\" shape " +
    "(got " + raw3 + ")");
  ok(!raw3.includes(SECRET_PATH_3) && !raw3.includes(SECRET_QUERY_3) && !raw3.includes("api-key"),
    "SOL_RPC's path and query must never appear in /vd's response body, why included: " + raw3);

  globalThis.fetch = trackingFetch; // برگرداندنِ موکِ پیش‌فرض برای هرچه بعد از این اجرا می‌شود
  console.log("[vd/t solana] /vd/<solana mint> runs the Solana verdict pipeline end to end " +
    "through worker.fetch (v:\"sell\"); /t/<solana mint> now serves the app, exactly like Base; " +
    "with env.SOL_RPC set, why now surfaces \"rpc:<method>:<status>\" end to end and the secret " +
    "URL's path/query never appear in the body");
}

/* ---- ۱۹ب. کارتِ پیش‌نمایش (OG) برای یک mintِ سولانا ----
   /t/ دیگر سولانا را رد نمی‌کند، پس این مسیر هم باید کارت بسازد. ogFetchMeta
   از قبل chain-aware است (gtNetworkOf(chainOf(addr)))؛ اینجا همان چیز از
   رویِ worker.fetch سنجیده می‌شود: شبکه‌ی درخواست باید «solana» باشد، نه
   OG_NETWORK ثابت، و عنوان/توضیحِ کارت باید از رویِ همان متادیتای خودِ
   توکن ساخته شوند — نه رشته‌ی عمومیِ fallback («Token on Base — Zaexa»)
   و نه متادیتای توکنِ دیگری. */
{
  const og = await import("./og.js");
  const { ogFetchMeta } = await import("./index.js");
  const mint = "So11111111111111111111111111111111111111112";

  sent = []; sentHeaders = [];
  reply = json({ data: { attributes: { name: "Wrapped SOL", symbol: "SOL",
    total_reserve_in_usd: "5000000", volume_usd: { h24: "2500000" } } } });
  const meta = await ogFetchMeta(mint, {});
  ok(sent[0] === "https://api.geckoterminal.com/api/v2/networks/solana/tokens/" + mint,
    "the Solana OG card asked the wrong upstream: " + sent[0]);
  ok(meta && meta.symbol === "SOL" && meta.name === "Wrapped SOL",
    "the Solana OG card did not read the token's own metadata: " + JSON.stringify(meta));

  const title = og.ogTitle(meta);
  const desc = og.ogDescription(meta, null);
  ok(title.includes("SOL") && title.includes("Wrapped SOL"),
    "the Solana OG title was not built from this token's own metadata: " + title);
  ok(title !== og.ogTitle(null), "a real Solana token fell back to the no-metadata title: " + title);
  ok(desc.includes("Liquidity $5.00M") && desc.includes("Vol 24h $2.50M"),
    "the Solana OG description was not built from this token's own market numbers: " + desc);

  // بدونِ متادیتا (بالادست شکست خورده) کارت باید عمومی بماند، نه غلط —
  // همان قاعده‌ای که Base هم دارد، دوباره برای سولانا سنجیده می‌شود.
  reply = new Response("nope", { status: 500 });
  ok(await ogFetchMeta(mint, {}) === null, "a failed upstream should give no metadata for a Solana mint");

  console.log("[og solana] a Solana mint's OG card asks networks/solana/tokens/<mint> (not Base) " +
    "and builds its title/description from that token's own metadata, falling back to the generic " +
    "card — never to someone else's data — when the upstream fails");
}

/* ---- ۱۹ب‑۲. برچسبِ زنجیره در توضیحِ کارت: پارامتر است، نه حدس ----
   قبل از این، ogDescription همیشه «Base» را literal داخلِ خودش می‌نوشت —
   یعنی کارتِ هر mintِ سولانا هم می‌گفت «Base · …»، دقیقاً همان باگی که
   کوردیناتور دید. حالا chain آرگومان است و کالر (worker/index.js) همان
   chainOf(addr) را پاس می‌دهد. اینجا مستقیماً خودِ og.js را می‌سنجیم:
   با یک متادیتای سولانا و هر سه حالتِ verdict، توضیح باید با «Solana · »
   شروع شود، نه با «Base · »؛ و بدونِ این آرگومان (کالرِ قدیمی) باید
   بایت‌به‌بایت همان رشته‌ی «امروز» بماند — رشته‌های زیر دست‌نویس‌اند، نه
   بازمحاسبه از خودِ تابع، وگرنه این probe هیچ‌چیزی را اثبات نمی‌کرد. */
{
  const og = await import("./og.js");

  const SOL_VERDICT_META = { liquidity: "$5.00M", vol24: "$2.50M" };
  const TODAY_SOL_DESC = "Solana · Liquidity $5.00M · Vol 24h $2.50M. Check whether you can sell it " +
    "back before you buy — exit simulation and risk flags, no wallet needed.";

  ok(og.ogDescription(SOL_VERDICT_META, null, "Solana") === TODAY_SOL_DESC,
     "an unknown Solana verdict must not add a verdict sentence, and must say Solana not Base: " +
     og.ogDescription(SOL_VERDICT_META, null, "Solana"));
  ok(og.ogDescription(SOL_VERDICT_META, "sell", "Solana") === "A sell route was quoted. " + TODAY_SOL_DESC,
     "sell verdict sentence missing/misworded for a Solana description: " +
     og.ogDescription(SOL_VERDICT_META, "sell", "Solana"));
  ok(og.ogDescription(SOL_VERDICT_META, "nosell", "Solana") ===
     "No sell route quoted — you may not be able to exit. " + TODAY_SOL_DESC,
     "nosell verdict sentence missing/misworded for a Solana description: " +
     og.ogDescription(SOL_VERDICT_META, "nosell", "Solana"));
  ok(og.ogDescription(SOL_VERDICT_META, "sell", "Solana").indexOf("A sell route was quoted.") === 0,
     "the sell sentence must lead a Solana description too — Telegram cuts the tail");
  ok(og.ogDescription(SOL_VERDICT_META, "nosell", "Solana").indexOf("No sell route quoted") === 0,
     "the nosell sentence must lead a Solana description too — Telegram cuts the tail");

  // یک Base صریح باید همان رشته‌ی همیشگی را بدهد — chain="Base" فقط اسمِ
  // همان پیش‌فرض را صریح می‌کند، رفتار را عوض نمی‌کند.
  const BASE_VERDICT_META = { liquidity: "$1.00M", vol24: "$2.00M" };
  const TODAY_BASE_DESC = "Base · Liquidity $1.00M · Vol 24h $2.00M. Check whether you can sell it " +
    "back before you buy — exit simulation and risk flags, no wallet needed.";
  ok(og.ogDescription(BASE_VERDICT_META, "sell", "Base") === "A sell route was quoted. " + TODAY_BASE_DESC,
     "chain=\"Base\" explicitly must match the byte-for-byte old Base description: " +
     og.ogDescription(BASE_VERDICT_META, "sell", "Base"));

  // کالرِ قدیمیِ ogTags (چهار آرگومان، بدونِ chain) نباید هیچ فرقی حس کند —
  // بایت‌به‌بایت همان توضیحِ Base که امروز تولید می‌شود.
  const addr4 = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const TODAY_TAGS_DESC = "A sell route was quoted. " + TODAY_BASE_DESC;
  const tags4 = og.ogTags(
    { symbol: "USDC", name: "USD Coin", liquidity: "$1.00M", vol24: "$2.00M" },
    addr4, "https://zaexa.com", "sell",
  );
  ok(tags4.includes('content="' + TODAY_TAGS_DESC + '"'),
     "ogTags called with only four arguments (no chain) must still carry the byte-for-byte old " +
     "Base description: " + tags4);
  ok(!tags4.includes("Solana"), "ogTags with no chain argument must never say Solana: " + tags4);

  console.log("[og chain label] chain is a parameter, not a guess: a Solana meta produces " +
    "\"Solana · Liquidity …\" for all three verdict states (each leading with the right verdict " +
    "sentence), an explicit \"Base\" and an omitted chain both stay byte-for-byte the old string, " +
    "and ogTags called with its old four-argument shape is unaffected");
}

/* ---- ۱۹ج. ogFetchVerdict روی یک mintِ سولانا: به fetchVerdictSol می‌رود ----
   بدونِ این شاخه، ogFetchVerdict یک mintِ سولانا را به‌عنوانِ آدرسِ EVM به
   fetchVerdict (Base، eth_call) می‌داد — یک calldataیِ بی‌معنا به RPCهای
   Base. این پروب دقیقاً همان کلاس‌باگ را می‌گیرد: هیچ eth_call‌ای نباید
   فرستاده شود، و نتیجه باید همان چیزی باشد که fetchVerdictSol/diagVerdict
   هم می‌دهند (دقیقاً همان شبیه‌سازیِ رفت‌وبرگشتِ بخشِ ۱۹). */
{
  const { ogFetchVerdict } = await import("./index.js");
  const vs = await import("./verdict_sol.js");
  const SOL_ADDR = "So11111111111111111111111111111111111111112";

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
  const PROGRAM = fakePubkey(19);
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

  let simCalls = 0, evmCallSeen = false;
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
    let body = null;
    try { body = JSON.parse(init.body); } catch { /* نه JSON، پس مطمئناً eth_call نیست */ }
    // یک batchِ eth_call همیشه آرایه است؛ اگر این شاخه اشتباه به fetchVerdict
    // Base می‌رفت، دقیقاً همین شکل را می‌ساخت — این‌جا گرفته می‌شود.
    if (Array.isArray(body) && body.some((x) => x && x.method === "eth_call")) evmCallSeen = true;
    if (body && body.method === "getBalance") return rpcOk({ value: 2_000_000_000 });
    if (body && body.method === "simulateTransaction") {
      simCalls++;
      return rpcOk({ value: { err: simCalls === 1 ? null : { InstructionError: [1, { Custom: 1 }] } } });
    }
    return jsonRes({ error: "unexpected" }, 500);
  };

  const meta = { symbol: "SOL", name: "Wrapped SOL", priceUsd: 150, decimals: 9 }; // فقط باید truthy باشد
  const v = await ogFetchVerdict(SOL_ADDR, meta, Date.now() + 2000, {}, {});
  globalThis.fetch = trackingFetch;

  ok(v === "sell", "ogFetchVerdict on a Solana mint did not resolve through fetchVerdictSol (got " + v + ")");
  ok(!evmCallSeen, "ogFetchVerdict sent an eth_call for a Solana mint — it must route to " +
    "fetchVerdictSol, never to the Base-only fetchVerdict");
  console.log("[og verdict solana] ogFetchVerdict(<solana mint>) resolves through fetchVerdictSol " +
    "end to end (\"sell\"), never through the Base-only eth_call path");
}

/* ---- ۲۰. GET /vd/rpc — ماتریسِ اندپوینت×متد ----
   سرتاسری از خودِ worker.fetch، با globalThis.fetch جعلی — این کانتینر به
   هیچ RPC واقعی دسترسی ندارد، پس این بخش فقط شکلِ مسیر را می‌سنجد، نه
   اینکه کدام‌یک از VD_SOL_RPCS واقعاً از کلادفلر و رویِ کدام متد جواب
   می‌دهد. آن سوال فقط با یک دیپلویِ واقعی و خواندنِ خودِ /vd/rpc جواب دارد. */
{
  const vs = await import("./verdict_sol.js");
  const spyEnv = {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };

  const DRPC = "solana.drpc.org";
  const ONFINALITY = "solana.api.onfinality.io";
  const calls = []; // "<hostname>|<method>"، به‌ترتیبِ صدا زده‌شدن

  // الف) سه رفتارِ متفاوت روی سه ترکیبِ اندپوینت×متدِ مختلف — پرتابِ شبکه‌ای،
  // خطای سطحِ JSON-RPC (کدِ عددی، نه متن)، و موفقیتِ ساده — به‌علاوه‌ی
  // simulateTransaction که هرگز نباید حتی یک بار فراخوانی شود.
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    const host = new URL(u).hostname;
    calls.push(host + "|" + body.method);
    if (host === DRPC && body.method === "getBalance") throw new Error("connection refused"); // پرتابِ شبکه‌ای
    if (host === ONFINALITY && body.method === "getMultipleAccounts") {
      // خطای سطحِ JSON-RPC: HTTP ۲۰۰ ولی body.error با کدِ عددی — همان شکلی
      // که خیلی از نودهای عمومی برای یک متدِ بسته‌شده می‌دهند.
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
        error: { code: -32601, message: "Method not found" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), { status: 200 });
  };
  const res = await worker.fetch(new Request(ORIGIN + "/vd/rpc",
    { headers: { "cf-connecting-ip": "203.0.113.70" } }), spyEnv, {});
  ok(res.status === 200, "/vd/rpc should be 200 (got " + res.status + ")");
  ok(res.headers.get("cache-control") === "no-store", "/vd/rpc must never be cached");
  const body = await res.json();
  const raw = JSON.stringify(body);

  ok(Array.isArray(body.endpoints) && body.endpoints.length === vs.VD_SOL_RPCS.length,
    "/vd/rpc should report exactly one row per candidate (" + vs.VD_SOL_RPCS.length + "), got: " + raw);
  for (const row of body.endpoints || []) {
    ok(Object.keys(row).sort().join(",") === "h,methods",
      "/vd/rpc endpoint row must carry exactly h/methods, got keys: " + JSON.stringify(row));
    ok(Array.isArray(row.methods) && row.methods.length === vs.VD_SOL_RPC_METHODS.length &&
      row.methods.every((r, i) => r.m === vs.VD_SOL_RPC_METHODS[i]),
      "/vd/rpc must probe exactly VD_SOL_RPC_METHODS, in order, for host " + row.h + ": " +
      JSON.stringify(row.methods));
    for (const m of row.methods) {
      const keys = Object.keys(m).sort().join(",");
      ok(keys === "code,m,ms,ok,status" || keys === "code,m,ms,ok,skipped,status",
        "/vd/rpc method row must carry only m/ok/status/code/ms(+skipped), got keys: " + JSON.stringify(m));
    }
  }

  // ب) simulateTransaction هیچ‌وقت واقعاً فراخوانی نمی‌شود — بدونِ ترکیبِ یک
  // تراکنشِ کامل هیچ راهِ صادقانه‌ای برای پروب‌کردنش نیست.
  ok(!calls.some((c) => c.endsWith("|simulateTransaction")),
    "simulateTransaction must never actually be called by /vd/rpc, got calls: " + calls.join(","));
  for (const row of body.endpoints || []) {
    const simRow = row.methods.find((r) => r.m === "simulateTransaction");
    ok(simRow && simRow.ok === null && simRow.status === null && simRow.code === null &&
      simRow.skipped === "unprobeable",
      "simulateTransaction's row must be ok:null/status:null/code:null/skipped:\"unprobeable\" for " +
      row.h + ", got: " + JSON.stringify(simRow));
  }

  // ج) پرتابِ شبکه‌ای روی یک ترکیبِ خاص → status:0/ok:false/code:null، بدونِ
  // ترکاندنِ بقیه‌ی ماتریس.
  const drpcRow = (body.endpoints || []).find((r) => r.h === DRPC);
  const drpcBalance = drpcRow && drpcRow.methods.find((r) => r.m === "getBalance");
  ok(drpcBalance && drpcBalance.ok === false && drpcBalance.status === 0 && drpcBalance.code === null,
    "a thrown fetch for one endpoint×method must show ok:false/status:0/code:null, without " +
    "crashing the whole matrix: " + JSON.stringify(drpcBalance));

  // د) خطای سطحِ JSON-RPC (کدِ عددی) → همان کد در خروجی، نه یک متنِ آزاد.
  const onfRow = (body.endpoints || []).find((r) => r.h === ONFINALITY);
  const onfHeld = onfRow && onfRow.methods.find((r) => r.m === "getMultipleAccounts");
  ok(onfHeld && onfHeld.ok === false && onfHeld.status === 200 && onfHeld.code === -32601,
    "a 200 response carrying a JSON-RPC error must surface its numeric code, not the message: " +
    JSON.stringify(onfHeld));

  // ه) بقیه‌ی ترکیب‌ها (غیرِ سه‌موردِ بالا) ساده موفق‌اند.
  for (const row of body.endpoints || []) {
    for (const m of row.methods) {
      if (m.skipped || (row.h === DRPC && m.m === "getBalance") ||
          (row.h === ONFINALITY && m.m === "getMultipleAccounts")) continue;
      ok(m.ok === true && m.status === 200 && m.code === null,
        "every other endpoint×method answering plain 200 should show ok:true/status:200/code:null: " +
        JSON.stringify(m) + " on " + row.h);
    }
  }

  // و) هیچ URLای، هیچ متنِ آزادِ خطایی در کلِ پاسخ نیست — فقط میزبان/نامِ
  // متد/عدد. متنِ خطای شبیه‌سازی‌شده‌ی بالا («connection refused»،
  // «Method not found») نباید هیچ‌جای بدنه دیده شود.
  ok(!raw.includes("https://") && !raw.includes("connection refused") && !raw.includes("Method not found"),
    "/vd/rpc's body must carry no URL and no free-text error message: " + raw);

  // ز) env.SOL_RPC — ردیفِ اول با فقط hostname، هرگز مسیر یا کوئری؛ کلید هم
  // در مسیر هم در کوئریِ خودِ URL گذاشته شده تا هر دو جا سنجیده شود.
  {
    const SECRET_HOST = "priv-rpc.example";
    const SECRET_PATH = "SUPERSECRETPATH";
    const SECRET_QUERY = "SUPERSECRETQUERY";
    const SOL_RPC_URL = "https://" + SECRET_HOST + "/token/" + SECRET_PATH + "?api-key=" + SECRET_QUERY;
    const secretCalls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const body = JSON.parse(init.body);
      secretCalls.push(new URL(u).hostname + "|" + body.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), { status: 200 });
    };
    const secretRes = await worker.fetch(new Request(ORIGIN + "/vd/rpc",
      { headers: { "cf-connecting-ip": "203.0.113.72" } }), { ...spyEnv, SOL_RPC: SOL_RPC_URL }, {});
    ok(secretRes.status === 200, "/vd/rpc with SOL_RPC set should still be 200 (got " + secretRes.status + ")");
    const secretBody = await secretRes.json();
    const secretRaw = JSON.stringify(secretBody);
    ok(Array.isArray(secretBody.endpoints) && secretBody.endpoints.length === vs.VD_SOL_RPCS.length + 1,
      "with SOL_RPC set /vd/rpc must report exactly one extra row (the secret endpoint), got: " + secretRaw);
    ok(secretBody.endpoints[0] && secretBody.endpoints[0].h === SECRET_HOST,
      "SOL_RPC's row must be first, and named only by its hostname: " +
      JSON.stringify(secretBody.endpoints[0]));
    ok(!secretRaw.includes(SECRET_PATH) && !secretRaw.includes(SECRET_QUERY) && !secretRaw.includes("api-key"),
      "SOL_RPC's path and query (present in both the URL's path and its query string) must never " +
      "appear anywhere in /vd/rpc's response body: " + secretRaw);
    ok(secretCalls[0] === SECRET_HOST + "|" + vs.VD_SOL_RPC_METHODS[0],
      "SOL_RPC must actually be the first endpoint probed by /vd/rpc, got calls: " + secretCalls.join(","));
  }

  // ح) ریت‌لیمیت — /vd/rpc روی همان سطلِ «vd» است، پس مصرفِ همین مسیر هم رد می‌شود.
  const { RL_LIMIT: RL_LIMIT_VDRPC } = await import("./index.js");
  const RL_IP = "203.0.113.71";
  for (let i = 0; i < RL_LIMIT_VDRPC; i++) {
    await worker.fetch(new Request(ORIGIN + "/vd/rpc", { headers: { "cf-connecting-ip": RL_IP } }), spyEnv, {});
  }
  const limited = await worker.fetch(new Request(ORIGIN + "/vd/rpc",
    { headers: { "cf-connecting-ip": RL_IP } }), spyEnv, {});
  ok(limited.status === 429, "the " + (RL_LIMIT_VDRPC + 1) + "th /vd/rpc request from one IP should " +
    "be rate-limited (got " + limited.status + ")");

  globalThis.fetch = trackingFetch;
  console.log("[vd/rpc] GET /vd/rpc now probes an endpoint×method matrix (VD_SOL_RPC_METHODS) per " +
    "VD_SOL_RPCS candidate — exactly {h,methods:[{m,ok,status,code,ms}]} per row, a thrown fetch " +
    "shows status:0/ok:false/code:null, a 200-with-JSON-RPC-error surfaces its numeric code (never " +
    "message text), simulateTransaction is always skipped:\"unprobeable\" without ever actually " +
    "being called, no-store, shares the \"vd\" rate-limit bucket, and with env.SOL_RPC set its row " +
    "is first and hostname-only — its path and query (planted in both) never appear anywhere in the " +
    "body — no claim made about which real endpoint answers which method from Cloudflare");
}

/* ---- robots.txt و sitemap.xml از خودِ Worker ----
   ⚠️ این‌ها عمداً از کد سرو می‌شوند، نه از `_site`: خط Build در پنل فقط
   html/js/_headers را کپی می‌کند، پس یک فایلِ txt یا xml کنارِ index.html
   بی‌صدا منتشر نمی‌شد. */
{
  const r = await call("/robots.txt");
  const body = await r.text();
  ok(r.status === 200, "GET /robots.txt must be 200, got " + r.status);
  ok(/^text\/plain/.test(r.headers.get("content-type") || ""),
     "robots.txt must be served as text/plain, got " + r.headers.get("content-type"));
  ok(/^\s*User-agent:\s*\*/m.test(body),
     "robots.txt must carry a User-agent: * group");
  ok(/^\s*Allow:\s*\/\s*$/m.test(body),
     "robots.txt must allow the whole site — the whole point of owning this file is that "
     + "Cloudflare's managed default disallowed every AI crawler");
  ok(!/Disallow:\s*\//.test(body),
     "robots.txt must not disallow anything: " + JSON.stringify(body));
  for (const bot of ["ClaudeBot", "GPTBot", "CCBot", "Google-Extended"]) {
    ok(!new RegExp("User-agent:\\s*" + bot, "i").test(body),
       "robots.txt must not single out " + bot + " — a named group here would re-create the "
       + "exact block we are removing");
  }
  ok(/^Sitemap:\s*https:\/\/zaexa\.com\/sitemap\.xml$/m.test(body),
     "robots.txt must point at the sitemap");

  /* ⚠️ خواندن برای جواب‌دادن ≠ برداشتن برای آموزش. این سه مقدار سه تصمیمِ
     جدا هستند و نباید با هم جابه‌جا شوند. */
  ok(/Content-Signal:[^\n]*\bsearch=yes\b/.test(body),
     "Content-Signal must keep search=yes — being findable is the point of this site");
  ok(/Content-Signal:[^\n]*\bai-input=yes\b/.test(body),
     "Content-Signal must keep ai-input=yes — an assistant answering \"is this token a "
     + "honeypot\" is exactly the reader this site exists for");
  ok(/Content-Signal:[^\n]*\bai-train=no\b/.test(body),
     "Content-Signal must say ai-train=no: the README states no license is granted to copy, "
     + "modify or redistribute this code, and permitting training contradicted it. Owner's "
     + "decision, 7 September 2026 — do not flip it back without asking.");

  // این فراخوانی عمداً پیش از هر جعلِ globalThis.fetch/caches در بخشِ بعدی
  // است، پس روی همان trackingFetch پیش‌فرض می‌رود؛ همینجا فقط شکلِ کلیِ
  // پاسخ سنجیده می‌شود، نه رفتارِ توکن‌ها — آن رفتار بخشِ اختصاصیِ خودش را
  // زیر همین کامنت دارد.
  reply = new Response("nope", { status: 500 }); // بالادستِ توکن‌ها هم خراب باشد، قابلِ پیش‌بینی بماند
  const sm = await call("/sitemap.xml");
  const xml = await sm.text();
  ok(sm.status === 200, "GET /sitemap.xml must be 200, got " + sm.status);
  ok(/^application\/xml/.test(sm.headers.get("content-type") || ""),
     "sitemap must be served as application/xml, got " + sm.headers.get("content-type"));
  ok(xml.startsWith("<?xml"), "sitemap must start with an XML declaration");
  ok(xml.includes("<loc>" + ORIGIN + "/</loc>") && xml.includes("<loc>" + ORIGIN + "/app</loc>") &&
     xml.includes("<loc>" + ORIGIN + "/pairs</loc>"),
     "sitemap must list the landing page, the app, and /pairs");
}

/* ---- sitemap.xml — صفحه‌های /t/<آدرس> از رویِ networks/base/pools ----
   ⚠️ اینجا هم globalThis.fetch هم globalThis.caches جعل می‌شوند — سایت‌مپ
   هم به بالادست می‌زند هم روی کشِ لبه می‌نشیند. هر سناریو کشِ خودش را تازه
   می‌سازد تا هیت/میسِ یک سناریو رویِ سناریوی بعدی اثر نگذارد. */
{
  const smIndex = await import("./index.js");
  const { SITEMAP_TOKEN_CAP, SITEMAP_TOKEN_PAGES } = smIndex;

  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function poolRow(addr, reserve) {
    return {
      attributes: { reserve_in_usd: reserve },
      relationships: { base_token: { data: { id: "base_" + addr } } },
    };
  }
  function pageResponse(rows) {
    return new Response(JSON.stringify({ data: rows }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  function freshCacheStore() {
    const shelf = new Map();
    return { default: {
      match: async (req) => { const v = shelf.get(req.url); return v ? v.clone() : undefined; },
      put: async (req, r) => { shelf.set(req.url, r); },
    } };
  }
  function pageOf(u) { return Number(new URL(String(u)).searchParams.get("page")); }

  /* ---- الف) موفق: ردیف‌های ناقص دورریخته، تکرار یک‌بار، ترتیبِ حجم حفظ، سقفِ ۵۰ ---- */
  const SOL_LOOKALIKE = "So11111111111111111111111111111111111111112"; // شکلِ سولانا، نه Base
  const page1Rows = [];
  /* 🔴 اولین ردیف، عمداً: اگر آدرسِ صفر رد نشود، هم در سایت‌مپ ظاهر می‌شود و
     هم *اولین* آدرسِ فهرست می‌شود، پس ادعای ترتیب هم پایین‌تر می‌شکند. یک
     سایت‌مپِ واقعی یک بار همین را لیست کرد. */
  page1Rows.push(poolRow(mkAddr(0), "1000"));
  for (let i = 1; i <= 15; i++) page1Rows.push(poolRow(mkAddr(i), "1000"));
  page1Rows.push(poolRow(mkAddr(9001), "0"));            // رزرو صفر
  page1Rows.push(poolRow(mkAddr(9002), null));           // رزرو غایب
  page1Rows.push(poolRow(mkAddr(9003), ""));              // رزرو خالی
  page1Rows.push(poolRow(mkAddr(9004), "not-a-number"));  // رزرو غیرِ عددی
  page1Rows.push({ attributes: { reserve_in_usd: "500" },
    relationships: { base_token: { data: { id: "base_" + SOL_LOOKALIKE } } } }); // زنجیره‌ی غیرِ Base

  const page2Rows = [];
  for (let i = 16; i <= 35; i++) page2Rows.push(poolRow(mkAddr(i), "500"));

  const page3Rows = [];
  for (let i = 36; i <= 52; i++) page3Rows.push(poolRow(mkAddr(i), "250"));
  page3Rows.push(poolRow(mkAddr(1), "999"));   // تکراریِ صفحه‌ی ۱
  page3Rows.push(poolRow(mkAddr(16), "999"));  // تکراریِ صفحه‌ی ۲
  page3Rows.push(poolRow(mkAddr(36), "999"));  // تکراریِ همین صفحه

  let smCalls = 0;
  globalThis.caches = freshCacheStore();
  globalThis.fetch = async (u) => {
    smCalls++;
    const p = pageOf(u);
    if (p === 1) return pageResponse(page1Rows);
    if (p === 2) return pageResponse(page2Rows);
    if (p === 3) return pageResponse(page3Rows);
    return pageResponse([]);
  };

  let res = await call("/sitemap.xml");
  const coldCalls = smCalls;
  const xml = await res.text();
  ok(res.status === 200, "sitemap with a healthy upstream must be 200, got " + res.status);
  ok(res.headers.get("cache-control") === "public, max-age=86400",
     "a successfully built sitemap must be cached 24h at the edge, got: " +
     res.headers.get("cache-control"));
  ok(xml.startsWith("<?xml"), "sitemap must start with an XML declaration");
  ok((xml.match(/<urlset/g) || []).length === 1,
     "sitemap must carry exactly one <urlset>: " + xml.slice(0, 120));

  const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
  ok(locs[0] === ORIGIN + "/" && locs[1] === ORIGIN + "/app" && locs[2] === ORIGIN + "/pairs",
     "the three static pages must come first, got: " + JSON.stringify(locs.slice(0, 3)));
  const tokenLocs = locs.slice(3);
  ok(tokenLocs.length === SITEMAP_TOKEN_CAP,
     "token URLs must be capped at " + SITEMAP_TOKEN_CAP + ", got " + tokenLocs.length);
  const TOKEN_LOC_RE = new RegExp("^" + ORIGIN + "/t/0x[0-9a-fA-F]{40}$");
  ok(tokenLocs.every((l) => TOKEN_LOC_RE.test(l)),
     "every token URL must match /t/0x<40 hex>: " +
     JSON.stringify(tokenLocs.filter((l) => !TOKEN_LOC_RE.test(l))));
  ok(new Set(locs).size === locs.length, "no <loc> may appear twice in the sitemap");
  ok(tokenLocs[0] === ORIGIN + "/t/" + mkAddr(1) &&
     tokenLocs[tokenLocs.length - 1] === ORIGIN + "/t/" + mkAddr(SITEMAP_TOKEN_CAP),
     "token order must follow upstream volume order and stop exactly at the cap, got first/last: " +
     tokenLocs[0] + " / " + tokenLocs[tokenLocs.length - 1]);
  ok(!xml.includes(mkAddr(51)) && !xml.includes(mkAddr(52)),
     "addresses beyond the " + SITEMAP_TOKEN_CAP + "-token cap must not appear even though the "
     + "upstream returned them");
  ok(!xml.includes(mkAddr(9001)) && !xml.includes(mkAddr(9002)) &&
     !xml.includes(mkAddr(9003)) && !xml.includes(mkAddr(9004)),
     "a pool with reserve_in_usd of 0/null/\"\"/a non-numeric string must never reach the sitemap");
  ok(!xml.includes(SOL_LOOKALIKE),
     "a pool whose base token id is not a Base address must never reach the sitemap");
  ok(!xml.includes(mkAddr(0)),
     "the zero address is not a token and must never reach the sitemap, however healthy the "
     + "pool row around it looks");
  ok(coldCalls === SITEMAP_TOKEN_PAGES,
     "a cold sitemap build should make exactly " + SITEMAP_TOKEN_PAGES + " upstream calls (one per "
     + "page), got " + coldCalls);

  // ب) گرم: همان کشِ لبه، بدونِ حتی یک فراخوانیِ تازه
  smCalls = 0;
  const res2 = await call("/sitemap.xml");
  const xml2 = await res2.text();
  ok(smCalls === 0,
     "a warm sitemap request served from the edge cache must touch the upstream zero times, got " +
     smCalls + " calls");
  ok(xml2 === xml, "a cached sitemap must be served byte-identical on the next request");

  console.log("[sitemap tokens] up to " + SITEMAP_TOKEN_PAGES + " pages of networks/base/pools feed "
    + "/t/<address> entries after the three static pages (/, /app, /pairs): reserve_in_usd of "
    + "0/null/\"\"/non-numeric "
    + "and a non-Base token id are all dropped without breaking the rest of the file, duplicates "
    + "across pools collapse to one, order follows upstream volume and stops exactly at " +
    SITEMAP_TOKEN_CAP + ", no <loc> repeats, a cold build makes exactly " + SITEMAP_TOKEN_PAGES +
    " upstream calls and a warm one (edge-cached, 24h) makes none");

  /* ---- ج) بالادست شکست می‌خورد: ۵۰۰، پرتاب، یا {} بدون‌شکل — هر سه فقط دو
     URL ثابت می‌دهند، با عمرِ کوتاه، و هرگز کش نمی‌شوند ---- */
  async function checkSitemapFallback(label, makeFetchImpl) {
    let calls = 0;
    globalThis.caches = freshCacheStore();
    globalThis.fetch = makeFetchImpl(() => { calls++; });

    const r1 = await call("/sitemap.xml");
    const body1 = await r1.text();
    ok(r1.status === 200, "sitemap must stay 200 when " + label + " (got " + r1.status + ")");
    const ls1 = Array.from(body1.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
    ok(ls1.length === 3 && ls1[0] === ORIGIN + "/" && ls1[1] === ORIGIN + "/app" &&
       ls1[2] === ORIGIN + "/pairs",
       "when " + label + ", sitemap must carry exactly the three static URLs, got: " + JSON.stringify(ls1));
    ok(r1.headers.get("cache-control") === "public, max-age=300",
       "a failed sitemap build must be cached briefly at the edge (not 86400), got: " +
       r1.headers.get("cache-control"));
    const callsAfterFirst = calls;
    ok(callsAfterFirst > 0, "sitemap must actually attempt the upstream when " + label);

    const r2 = await call("/sitemap.xml");
    ok(r2.status === 200, "a second failing sitemap request must still be 200 (got " + r2.status + ")");
    ok(calls > callsAfterFirst,
       "a failed sitemap build must never be cached — a second request must hit the upstream again, "
       + "when " + label + " (calls: " + callsAfterFirst + " -> " + calls + ")");
    console.log("[sitemap fallback] " + label + " -> 200 with exactly the three static URLs, a short "
      + "cache-control, and never cached at the edge (the very next request tries the upstream again)");
  }

  await checkSitemapFallback("the upstream answers 500", (bump) => async () => {
    bump();
    return new Response("boom", { status: 500 });
  });
  await checkSitemapFallback("the upstream throws", (bump) => async () => {
    bump();
    throw new Error("network is down");
  });
  await checkSitemapFallback("the upstream returns {}", (bump) => async () => {
    bump();
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });

  delete globalThis.caches;
  globalThis.fetch = trackingFetch; // برگرداندنِ موکِ پیش‌فرض برای هرچه بعد از این اجرا می‌شود
}

/* ---- ۲۱. worker/report.js — ساختِ ردیف‌ها، بدونِ هیچ I/O ----
   🔴 روی Base رفت‌وبرگشت نداریم؛ worker/verdict.js فقط SELL QUOTE می‌دهد.
   CHECK_KIND_BY_CHAIN و اینکه reportRow اصلاً پارامتری برای checkKind
   نمی‌پذیرد این را از رویِ ساختار تضمین می‌کنند، نه از رویِ متنِ دستی — این
   بخش دقیقاً همان تضمین را می‌سنجد. */
{
  // فیکسچرِ واقعی — امروز از خودِ پراکسیِ زنده گرفته شد. هر عدد رشته است؛
  // یک فیکسچر با literal عددی هیچ‌چیز از Number(...) را نمی‌سنجد.
  const REAL_POOL_ROW = {
    id: "base_0x1c63fb92fc15d39f28a07a76bc4c94c37ae26813",
    type: "pool",
    attributes: {
      base_token_price_usd: "0.00105608666453529",
      base_token_price_native_currency: "0.000000421577885286176",
      quote_token_price_usd: "2480.03",
      base_token_price_quote_token: "0.0000004215778853",
      address: "0x1c63fb92fc15d39f28a07a76bc4c94c37ae26813",
      name: "PC / WETH 1%",
      pool_created_at: "2026-09-07T16:47:23Z",
      fdv_usd: "1056084.154",
      market_cap_usd: null,
      price_change_percentage: { m5: "0" },
      transactions: { m5: { buys: 1, sells: 0, buyers: 1, sellers: 0 } },
      volume_usd: { h24: "2.48003" },
      reserve_in_usd: "1035070.5289",
    },
    relationships: {
      base_token: { data: { id: "base_0xb200000000000000000000c573ceb6905ec145da", type: "token" } },
      quote_token: { data: { id: "base_0x4200000000000000000000000000000000000006", type: "token" } },
      dex: { data: { id: "uniswap-v3-base", type: "dex" } },
    },
  };

  // ۱. فیکسچرِ واقعی → توکنِ قابلِ استفاده
  const tok = newPoolRowToToken(REAL_POOL_ROW);
  ok(tok !== null, "the real GeckoTerminal fixture must yield a usable token");
  ok(tok && tok.address === "0xb200000000000000000000c573ceb6905ec145da",
     "wrong address parsed from the real fixture: " + (tok && tok.address));
  ok(tok && tok.reserveUsd === 1035070.5289,
     "reserve_in_usd (a STRING in the real payload) must be Number()-parsed, got " + (tok && tok.reserveUsd));
  ok(tok && Math.abs(tok.priceUsd - 0.00105608666453529) < 1e-18,
     "base_token_price_usd must be Number()-parsed, got " + (tok && tok.priceUsd));
  ok(tok && tok.poolCreatedAt === "2026-09-07T16:47:23Z", "pool_created_at not carried through");
  ok(tok && tok.dex === "uniswap-v3-base", "dex id not carried through");
  // ۹. volume_usd.h24 و fdv_usd هم رشته‌اند در پاسخِ واقعی — باید Number()
  // شوند، نه اینکه رشته بمانند یا NaN شوند.
  ok(tok && typeof tok.vol24hUsd === "number" && tok.vol24hUsd === 2.48003,
     "volume_usd.h24 (a STRING) must be Number()-parsed into vol24hUsd, got " +
     JSON.stringify(tok && tok.vol24hUsd) + " (" + typeof (tok && tok.vol24hUsd) + ")");
  ok(tok && typeof tok.fdvUsd === "number" && tok.fdvUsd === 1056084.154,
     "fdv_usd (a STRING) must be Number()-parsed into fdvUsd, got " +
     JSON.stringify(tok && tok.fdvUsd) + " (" + typeof (tok && tok.fdvUsd) + ")");
  ok(tok && typeof tok.priceUsd === "number" && tok.priceUsd === 0.00105608666453529,
     "base_token_price_usd must be a number, exactly the parsed double, got " + tok.priceUsd);

  // ۲. آدرسِ صفر و آستانه‌ی رزرو
  function withBaseToken(id) {
    return {
      attributes: { ...REAL_POOL_ROW.attributes },
      relationships: {
        base_token: { data: { id } },
        dex: REAL_POOL_ROW.relationships.dex,
      },
    };
  }
  const zeroAddrRow = withBaseToken("base_0x0000000000000000000000000000000000000000");
  ok(newPoolRowToToken(zeroAddrRow) === null,
     "the zero address must be rejected even though a live sitemap once listed it");

  function withReserve(reserve) {
    const row = withBaseToken("base_0x" + "1".repeat(40));
    row.attributes.reserve_in_usd = reserve;
    return row;
  }
  ok(newPoolRowToToken(withReserve("4999.99")) === null,
     "reserve just under REPORT_MIN_RESERVE_USD (" + REPORT_MIN_RESERVE_USD + ") must be rejected");
  ok(newPoolRowToToken(withReserve("5000")) !== null,
     "reserve exactly at REPORT_MIN_RESERVE_USD must be accepted");

  // ۱۰. یک ردیفِ pool که اصلاً شیءِ volume_usd ندارد — یک استخرِ خیلی تازه‌تر
  // از اولین شمعِ ۲۴ساعته می‌تواند این‌طور باشد؛ نبودنش نباید کلِ ردیف را
  // رد کند (پرتاب کند)، فقط این یک عدد null می‌شود.
  const noVolRow = withBaseToken("base_0x" + "3".repeat(40));
  delete noVolRow.attributes.volume_usd;
  const tokNoVol = newPoolRowToToken(noVolRow);
  ok(tokNoVol !== null, "a pool row with no volume_usd object at all must still produce a token, not null");
  ok(tokNoVol && tokNoVol.vol24hUsd === null,
     "a missing volume_usd object must yield vol24hUsd:null without throwing, got " +
     JSON.stringify(tokNoVol && tokNoVol.vol24hUsd));

  // ۱۱. fdv_usd "0" یا غایب → fdvUsd:null؛ و market_cap_usd هرگز جایگزینش
  // نمی‌شود، حتی وقتی مقداری واقعی دارد — این دو مفهومِ متفاوت‌اند.
  function withFdv(fdv, marketCap) {
    const row = withBaseToken("base_0x" + "4".repeat(40));
    if (fdv === undefined) delete row.attributes.fdv_usd;
    else row.attributes.fdv_usd = fdv;
    row.attributes.market_cap_usd = marketCap;
    return row;
  }
  const tokFdvZero = newPoolRowToToken(withFdv("0", null));
  ok(tokFdvZero && tokFdvZero.fdvUsd === null,
     "fdv_usd \"0\" must yield fdvUsd:null, got " + JSON.stringify(tokFdvZero && tokFdvZero.fdvUsd));
  const tokFdvMissing = newPoolRowToToken(withFdv(undefined, "999"));
  ok(tokFdvMissing !== null, "a missing fdv_usd must still produce a token, not null");
  ok(tokFdvMissing && tokFdvMissing.fdvUsd === null,
     "fdv_usd missing must never fall back to market_cap_usd (here \"999\"), got fdvUsd=" +
     JSON.stringify(tokFdvMissing && tokFdvMissing.fdvUsd));

  // ۳. checkKind از رویِ chain — هرگز از رویِ متن
  const T0 = "2026-09-07T00:00:00.000Z";
  function baseArgs(extra) {
    return Object.assign({ address: "0x" + "2".repeat(40), symbol: null, name: null, verdict: "sell",
      checkedAt: T0, poolCreatedAt: null, priceUsd: 0.5, reserveUsd: 1, vol24hUsd: 2, fdvUsd: 3,
      dex: null }, extra);
  }
  const rowBase = reportRow(baseArgs({ chain: "base" }));
  const rowSol = reportRow(baseArgs({ chain: "solana", verdict: null }));
  const rowEth = reportRow(baseArgs({ chain: "ethereum" }));
  ok(rowBase && rowBase.checkKind === "sell-quote",
     "a Base row must carry checkKind \"sell-quote\", got " + (rowBase && rowBase.checkKind));
  ok(rowSol && rowSol.checkKind === "roundtrip",
     "a Solana row must carry checkKind \"roundtrip\", got " + (rowSol && rowSol.checkKind));
  ok(rowEth === null, "a chain absent from CHECK_KIND_BY_CHAIN must produce no row at all, got " +
     JSON.stringify(rowEth));

  // ۴. گاردِ ساختاری: هیچ checkKindِ caller-داده پذیرفته نمی‌شود
  const spoofed = reportRow(baseArgs({ chain: "base", checkKind: "round trip" }));
  ok(spoofed !== null && spoofed.checkKind === "sell-quote",
     "reportRow must ignore a caller-supplied checkKind entirely, got " + (spoofed && spoofed.checkKind));
  for (const r of [rowBase, rowSol, spoofed]) {
    ok(r && r.checkKind === CHECK_KIND_BY_CHAIN[r.chain],
       "every built row must satisfy checkKind === CHECK_KIND_BY_CHAIN[chain]: " + JSON.stringify(r));
  }

  // ۱۲. 🔴 هیچ فیلدِ ذخیره‌شده رشته‌ی نمایشی نیست — شکلِ ogBig() ("$1.2M")
  // هرگز نباید به یک ردیفِ ساخته‌شده برسد؛ فقط عدد یا null مجاز است.
  for (const key of ["priceUsd", "reserveUsd", "vol24hUsd", "fdvUsd"]) {
    const v = rowBase[key];
    ok(v === null || typeof v === "number",
       "row." + key + " must be a number or null, never a display string, got " +
       JSON.stringify(v) + " (" + typeof v + ")");
    ok(!(typeof v === "string" && /^\$/.test(v)),
       "row." + key + " must never look like an ogBig() rendering (\"$…\"), got " + JSON.stringify(v));
  }
  // همان چیز از یک ورودیِ رشته‌ای/نامعتبر: هرگز رشته یا NaN، فقط null
  // ⚠️ هر چهار فیلد باید *رشته* بگیرند، نه سه‌تا NaN/undefined و یکی رشته:
  // یک بار همین نامتقارنی باعث شد شکستنِ عمدیِ vol24hUsd (رشته را رد کند)
  // از کنارِ سوییت رد شود، چون آن فیلد در این فیکسچر رشته نمی‌گرفت.
  const rowJunkNums = reportRow(baseArgs({
    chain: "base", priceUsd: "$1.2M", reserveUsd: "not-a-number", vol24hUsd: "$3.4K",
    fdvUsd: "1056084.154",
  }));
  for (const key of ["priceUsd", "reserveUsd", "vol24hUsd", "fdvUsd"]) {
    ok(rowJunkNums && rowJunkNums[key] === null,
       "a non-numeric input for " + key + " must become null, never survive as a string/NaN, got " +
       JSON.stringify(rowJunkNums && rowJunkNums[key]));
  }
  // و همان چهار فیلد با شکل‌های غیرِرشته‌ایِ نامعتبر — NaN، بی‌نهایت، غایب.
  const rowJunkShapes = reportRow(baseArgs({
    chain: "base", priceUsd: NaN, reserveUsd: Infinity, vol24hUsd: undefined, fdvUsd: null,
  }));
  for (const key of ["priceUsd", "reserveUsd", "vol24hUsd", "fdvUsd"]) {
    ok(rowJunkShapes && rowJunkShapes[key] === null,
       "a NaN/Infinity/absent input for " + key + " must become null, got " +
       JSON.stringify(rowJunkShapes && rowJunkShapes[key]));
  }

  // ۱۳. ترتیب و مجموعه‌ی دقیقِ کلیدهای ردیف — شکلِ v۱ گسترش‌یافته
  const FROZEN_ROW_KEYS = [
    "chain", "address", "symbol", "name", "v", "checkKind", "checkedAt", "poolCreatedAt",
    "priceUsd", "reserveUsd", "vol24hUsd", "fdvUsd", "dex", "why",
  ];
  ok(JSON.stringify(Object.keys(rowBase)) === JSON.stringify(FROZEN_ROW_KEYS),
     "reportRow's key order/set must match the frozen list exactly, got " +
     JSON.stringify(Object.keys(rowBase)));

  // ۱۴. name: رشته یا null، هرگز چیزِ دیگری — یک مقدارِ نارشته‌ای هرگز رد نمی‌کند
  const rowNameNum = reportRow(baseArgs({ chain: "base", name: 12345 }));
  ok(rowNameNum !== null && rowNameNum.name === null,
     "a non-string name must become null without rejecting the row, got " +
     JSON.stringify(rowNameNum && rowNameNum.name));
  const rowNameStr = reportRow(baseArgs({ chain: "base", name: "Pool Coin" }));
  ok(rowNameStr && rowNameStr.name === "Pool Coin",
     "a string name must be carried through as-is, got " + JSON.stringify(rowNameStr && rowNameStr.name));

  // ۵. هر ردیفِ تولیدشده: chain/checkKind غیرِ خالی، checkedAt به‌شکلِ ISO
  for (const r of [rowBase, rowSol]) {
    ok(typeof r.chain === "string" && r.chain.length > 0, "row.chain must be non-empty");
    ok(typeof r.checkKind === "string" && r.checkKind.length > 0, "row.checkKind must be non-empty");
    ok(/^\d{4}-\d{2}-\d{2}T/.test(r.checkedAt), "row.checkedAt must look like ISO-8601: " + r.checkedAt);
  }

  // ۶. حکمِ null باید null بماند — هرگز به "nosell" تبدیل نشود
  const rowUnknown = reportRow(baseArgs({ chain: "base", verdict: null }));
  ok(rowUnknown && rowUnknown.v === null, "a null verdict must survive as null, got " +
     JSON.stringify(rowUnknown && rowUnknown.v));

  // ۷. mergeReportDoc: اول‌دیده‌شده می‌برد، checked انباشته می‌شود، روزِ
  //    بدونِ‌یافته هم سندِ کامل است
  const emptyRun = mergeReportDoc(null, "2026-09-07", [], 5, T0);
  ok(Array.isArray(emptyRun.rows) && emptyRun.rows.length === 0 && emptyRun.checked === 5,
     "a day with zero findings must still be a full document: rows [] with the real checked count, " +
     "got rows.length=" + emptyRun.rows.length + " checked=" + emptyRun.checked);

  const rowA_early = reportRow(baseArgs({ chain: "base", address: "0xaa", verdict: "sell" }));
  const rowA_late = reportRow(baseArgs({ chain: "base", address: "0xaa", verdict: "nosell" }));
  const doc1 = mergeReportDoc(null, "2026-09-07", [rowA_early], 1, T0);
  const doc2 = mergeReportDoc(doc1, "2026-09-07", [rowA_late], 1, T0);
  ok(doc2.rows.length === 1 && doc2.rows[0].v === "sell",
     "first-seen wins: a later run must never rewrite an earlier verdict for the same address, got v=" +
     (doc2.rows[0] && doc2.rows[0].v));
  ok(doc2.checked === 2, "checked must accumulate across merges, got " + doc2.checked);
  ok(mergeReportDoc(undefined, "2026-09-07", [], 0, T0).rows.length === 0,
     "a missing prevDoc must be treated as an empty day, not an error");
  ok(mergeReportDoc({ garbage: true }, "2026-09-07", [], 0, T0).rows.length === 0,
     "a malformed prevDoc must be treated as an empty day, not an error");

  // ۸. mergePairsRing: تکرار حذف، تازه اول، سقفِ دقیقِ ۲۰۰
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function ringRow(addr) { return { address: addr, v: null }; }
  const prevRing = Array.from({ length: 190 }, (_, i) => ringRow(mkAddr(1000 + i)));
  const newRing = Array.from({ length: 20 }, (_, i) => ringRow(mkAddr(i)));
  newRing[0] = ringRow(mkAddr(1000)); // یک تکراری عمدی با ابتدای prevRing
  const merged = mergePairsRing(prevRing, newRing, REPORT_PAIRS_CAP);
  ok(merged.length === REPORT_PAIRS_CAP,
     "the ring must cap at exactly " + REPORT_PAIRS_CAP + ", got " + merged.length);
  ok(merged[0].address === newRing[0].address,
     "newest rows must sort first in the ring");
  ok(new Set(merged.map((r) => r.address)).size === merged.length,
     "no address may appear twice in the ring");

  console.log("[report rows] worker/report.js pure functions ok — the real GeckoTerminal fixture "
    + "(strings, not numeric literals) parses to address/reserveUsd/priceUsd/poolCreatedAt/dex/"
    + "vol24hUsd/fdvUsd, all as numbers; a missing volume_usd object degrades to vol24hUsd:null without "
    + "throwing; fdv_usd \"0\" or absent yields fdvUsd:null and never falls back to market_cap_usd; the "
    + "zero address and a reserve under $" + REPORT_MIN_RESERVE_USD + " are rejected; checkKind comes "
    + "only from CHECK_KIND_BY_CHAIN (base -> sell-quote, solana -> roundtrip, ethereum -> null row) "
    + "and a caller-supplied checkKind is always ignored; every row carries a non-empty chain/checkKind "
    + "and an ISO checkedAt; a null verdict survives as null, never nosell; priceUsd/reserveUsd/"
    + "vol24hUsd/fdvUsd on a built row are always a number or null, never an ogBig()-shaped display "
    + "string; name is a string or null and never invented from the pool's own name field; the row's "
    + "key order/set matches the frozen v1 list exactly; mergeReportDoc keeps first-seen verdicts, "
    + "accumulates checked, and still produces rows:[] on a zero-finding day; mergePairsRing dedupes "
    + "newest-first and caps at exactly " + REPORT_PAIRS_CAP);
}

/* ---- ۲۲. runReportPass — با kv/fetchPools/metaOf/verdictOf/sleep جعلی ----
   این تابع خودش هیچ I/O یا fetch مستقیم ندارد؛ همه‌چیز تزریق می‌شود، پس
   بدونِ شبکه‌ی واقعی هم رفتارِ کاملش قابلِ سنجیدن است. */
{
  function makeKv() {
    const store = new Map();
    return {
      store,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
    };
  }
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  // vol24h/fdv اختیاری‌اند — پیش‌فرضشان یک عددِ واقعی است (نه رشته‌ی خراب)
  // تا هر فراخوانیِ قدیمی که این دو را نمی‌دهد باز هم یک ردیفِ معتبر بسازد.
  function poolRow(addr, reserve, price, vol24h = 0, fdv = 0) {
    return {
      attributes: { reserve_in_usd: String(reserve), base_token_price_usd: String(price),
        pool_created_at: "2026-09-07T10:00:00Z",
        volume_usd: { h24: String(vol24h) }, fdv_usd: String(fdv) },
      relationships: { base_token: { data: { id: "base_" + addr } },
        dex: { data: { id: "uniswap-v3-base" } } },
    };
  }
  const NOW_MS = Date.parse("2026-09-07T12:00:00.000Z");

  // ۹. بدونِ kv، حتی یک فراخوانیِ fetchPools هم روا نیست
  let fpCalls9 = 0;
  const res9 = await runReportPass({
    kv: null,
    fetchPools: async () => { fpCalls9++; return []; },
    metaOf: async () => ({ meta: null, why: "meta:429" }),
    verdictOf: async () => ({ v: null, why: "no-quote" }),
    now: () => NOW_MS,
    sleep: async () => {},
  });
  ok(fpCalls9 === 0, "runReportPass with kv:null must never call fetchPools, got " + fpCalls9 + " calls");
  ok(res9.checked === 0 && res9.added === 0,
     "runReportPass with kv:null must return {checked:0, added:0}, got " + JSON.stringify(res9));

  // یک fetchPools که پرتاب می‌کند یا آرایه نمی‌دهد → همان صفر، بدونِ کرش
  const kvA = makeKv();
  const resThrow = await runReportPass({
    kv: kvA, fetchPools: async () => { throw new Error("upstream is down"); },
    metaOf: async () => ({ meta: null, why: "meta:429" }), verdictOf: async () => ({ v: null, why: "no-quote" }),
    now: () => NOW_MS, sleep: async () => {},
  });
  ok(resThrow.checked === 0 && resThrow.added === 0, "a throwing fetchPools must yield {checked:0, added:0}");
  const resBad = await runReportPass({
    kv: kvA, fetchPools: async () => ({ not: "an array" }),
    metaOf: async () => ({ meta: null, why: "meta:429" }), verdictOf: async () => ({ v: null, why: "no-quote" }),
    now: () => NOW_MS, sleep: async () => {},
  });
  ok(resBad.checked === 0 && resBad.added === 0, "a non-array fetchPools result must yield {checked:0, added:0}");

  // ۶ + ۱۲. مسیرِ واقعی: دو توکنِ تازه، یکی metaOf-null، پیس/عدم‌همپوشانی
  const kv = makeKv();
  // vol24h/fdv واقعی روی هر دو، تا بشود سنجید metaOf-null فقط name را از دست
  // می‌دهد، نه این اعداد را.
  const rows = [poolRow(mkAddr(1), 10000, 0.001, 500.5, 9999.99), poolRow(mkAddr(2), 10000, 0.002, 10, 5000)];
  let sleepCalls = 0; const sleepArgs = [];
  const sleep = async (ms) => { sleepCalls++; sleepArgs.push(ms); };
  const metaOf = async (addr) => (addr === mkAddr(1)
    ? { meta: null, why: "meta:429" }
    : { meta: { symbol: "T2", name: "Token Two" }, why: null });
  let verdictActive = 0, sawOverlap = false, verdictCalls = 0;
  const verdictOf = async (addr, meta) => {
    verdictCalls++; verdictActive++;
    if (verdictActive > 1) sawOverlap = true;
    await Promise.resolve();
    verdictActive--;
    return addr === mkAddr(1) ? { v: null, why: "no-quote" } : { v: "sell", why: null };
  };
  const res = await runReportPass({ kv, fetchPools: async () => rows, metaOf, verdictOf, now: () => NOW_MS, sleep });
  ok(res.checked === 2, "two fresh tokens must yield checked:2, got " + res.checked);
  ok(res.added === 2, "both tokens must produce a row, got added:" + res.added);
  ok(sleepCalls === 2 && sleepArgs.every((ms) => ms === REPORT_PACE_MS),
     "sleep must be called once per token with exactly REPORT_PACE_MS, got " + JSON.stringify(sleepArgs));
  ok(!sawOverlap, "verdictOf calls must never overlap — pacing must be sequential, not parallel");
  ok(verdictCalls === 2,
     "verdictOf must be called once per token even when metaOf returned null, got " + verdictCalls);

  const dateStr = utcDateOf(NOW_MS);
  const doc = JSON.parse(await kv.get(reportKey(dateStr)));
  const row1 = doc.rows.find((r) => r.address === mkAddr(1));
  ok(row1 && row1.v === null,
     "a token whose metaOf returned null must still get a row with v:null, never nosell, got " +
     JSON.stringify(row1 && row1.v));
  ok(doc.checked === 2, "the written report doc must carry the real checked count, got " + doc.checked);

  // ۱۳. metaOf-null هرگز عدد را از دست نمی‌دهد، فقط name را — و name هرگز از
  // رویِ رشته‌ی نامِ استخر ("PC / WETH 1%") حدس زده نمی‌شود، فقط از meta.name
  ok(row1 && row1.name === null,
     "metaOf-null must yield row.name:null, never a name invented from the pool row, got " +
     JSON.stringify(row1 && row1.name));
  ok(row1 && row1.priceUsd === 0.001 && row1.vol24hUsd === 500.5 && row1.fdvUsd === 9999.99,
     "a metaOf-null token must keep priceUsd/vol24hUsd/fdvUsd straight from the pool row, got " +
     JSON.stringify(row1 && { p: row1.priceUsd, v: row1.vol24hUsd, f: row1.fdvUsd }));
  const row2 = doc.rows.find((r) => r.address === mkAddr(2));
  ok(row2 && row2.name === "Token Two",
     "when metaOf resolves, row.name must come from meta.name, got " + JSON.stringify(row2 && row2.name));

  const pairs = JSON.parse(await kv.get(PAIRS_KEY_BASE));
  ok(Array.isArray(pairs) && pairs.length === 2, "both fresh tokens must land in the pairs ring");

  // دومین اجرا با همان kv: توکن‌های شناخته‌شده دوباره چک نمی‌شوند
  const res2 = await runReportPass({
    kv, fetchPools: async () => rows, metaOf, verdictOf, now: () => NOW_MS + 3600000, sleep,
  });
  ok(res2.checked === 0 && res2.added === 0,
     "tokens already in the pairs ring must not be re-checked on the next hourly run, got " +
     JSON.stringify(res2));

  // ۱۳. سقفِ توکن: اجرای دستی عددِ کوچک می‌دهد، ولی هیچ کالری نمی‌تواند از
  // REPORT_MAX_TOKENS_PER_RUN بالاتر برود — وگرنه اندپوینتِ سنجش خودش راهی
  // برای سوزاندنِ سهمیه‌ی RPC می‌شد.
  const kvCap = makeKv();
  const manyRows = Array.from({ length: 40 }, (_, i) => poolRow(mkAddr(5000 + i), 9000, 1, 10, 100));
  const resCap3 = await runReportPass({
    kv: kvCap, fetchPools: async () => manyRows,
    metaOf: async () => ({ meta: null, why: "meta:429" }), verdictOf: async () => ({ v: null, why: "no-quote" }),
    now: () => NOW_MS, sleep: async () => {}, maxTokens: 3,
  });
  ok(resCap3.checked === 3,
     "maxTokens:3 must check exactly 3 tokens, got " + resCap3.checked);

  const kvCap2 = makeKv();
  const resCapHuge = await runReportPass({
    kv: kvCap2, fetchPools: async () => manyRows,
    metaOf: async () => ({ meta: null, why: "meta:429" }), verdictOf: async () => ({ v: null, why: "no-quote" }),
    now: () => NOW_MS, sleep: async () => {}, maxTokens: 9999,
  });
  ok(resCapHuge.checked === REPORT_MAX_TOKENS_PER_RUN,
     "a caller-supplied maxTokens above REPORT_MAX_TOKENS_PER_RUN must be clamped to " +
     REPORT_MAX_TOKENS_PER_RUN + ", got " + resCapHuge.checked);

  const kvCap3 = makeKv();
  const resCapNone = await runReportPass({
    kv: kvCap3, fetchPools: async () => manyRows,
    metaOf: async () => ({ meta: null, why: "meta:429" }), verdictOf: async () => ({ v: null, why: "no-quote" }),
    now: () => NOW_MS, sleep: async () => {},
  });
  ok(resCapNone.checked === REPORT_MAX_TOKENS_PER_RUN,
     "with no maxTokens the pass must use the full cap, got " + resCapNone.checked);

  console.log("[report kv] runReportPass ok — kv:null skips fetchPools entirely (checked 0/added 0), "
    + "a throwing or non-array fetchPools degrades the same way, a metaOf-null token still produces a "
    + "row with v:null (never nosell) and its priceUsd/vol24hUsd/fdvUsd intact from the pool row while "
    + "name is null (never guessed from the pool's own name string), a metaOf hit carries its name "
    + "through, sleep runs once per token at exactly REPORT_PACE_MS with verdictOf calls never "
    + "overlapping, both KV keys are written with the real checked/added counts, and a second run "
    + "against the same store skips tokens already in the pairs ring, and maxTokens caps a pass "
    + "exactly (3 -> 3) while any value above REPORT_MAX_TOKENS_PER_RUN is clamped down to it");
}

/* ---- ۲۳. /report/<...>.json و /pairs.json — از رویِ worker.fetch ---- */
{
  const envNoKv = { ASSETS };

  // ۱۰. بدونِ env.ZX_KV: هیچ‌جا نباید بشکند
  const rToday = await call("/report/today.json", { method: "GET" }, envNoKv);
  const bToday = await rToday.json();
  ok(rToday.status === 200, "GET /report/today.json without ZX_KV must be 200, got " + rToday.status);
  ok(Array.isArray(bToday.rows) && bToday.rows.length === 0,
     "without ZX_KV, today's doc must have rows:[], got " + JSON.stringify(bToday.rows));
  ok(bToday.date === utcDateOf(Date.now()),
     "today's doc must carry today's UTC date, got " + bToday.date);

  const rPairs = await call("/pairs.json", { method: "GET" }, envNoKv);
  const bPairs = await rPairs.json();
  ok(rPairs.status === 200 && Array.isArray(bPairs.rows) && bPairs.rows.length === 0,
     "GET /pairs.json without ZX_KV must be 200 with rows:[], got " + JSON.stringify(bPairs));
  ok(bPairs.chain === "base", "GET /pairs.json must default chain to base, got " + bPairs.chain);

  const rPost = await call("/report/today.json", { method: "POST" }, envNoKv);
  ok(rPost.status === 405, "POST /report/today.json must be 405, got " + rPost.status);
  ok((await rPost.json()).error === "only GET", "405 body must say only GET");

  const rPostPairs = await call("/pairs.json", { method: "POST" }, envNoKv);
  ok(rPostPairs.status === 405, "POST /pairs.json must be 405, got " + rPostPairs.status);

  const rBadDate = await call("/report/nope.json", { method: "GET" }, envNoKv);
  ok(rBadDate.status === 400, "GET /report/nope.json must be 400, got " + rBadDate.status);
  ok((await rBadDate.json()).error === "bad date", "bad date body must say bad date");

  const rBadChain = await call("/pairs.json?chain=doge", { method: "GET" }, envNoKv);
  ok(rBadChain.status === 400, "GET /pairs.json?chain=doge must be 400, got " + rBadChain.status);
  ok((await rBadChain.json()).error === "bad chain", "bad chain body must say bad chain");

  const rSolChain = await call("/pairs.json?chain=solana", { method: "GET" }, envNoKv);
  const bSolChain = await rSolChain.json();
  ok(rSolChain.status === 200 && Array.isArray(bSolChain.rows) && bSolChain.rows.length === 0,
     "?chain=solana must be accepted today and simply return an empty ring, got " +
     JSON.stringify(bSolChain));

  // ۱۱. عمرِ کش: امروز/تازه‌ها ۵ دقیقه، روزِ گذشته ۲۴ ساعت
  ok(rToday.headers.get("cache-control") === "public, max-age=300",
     "today's report must be cached 300s at the edge, got " + rToday.headers.get("cache-control"));
  ok(rPairs.headers.get("cache-control") === "public, max-age=300",
     "/pairs.json must be cached 300s at the edge, got " + rPairs.headers.get("cache-control"));
  const rPast = await call("/report/2020-01-01.json", { method: "GET" }, envNoKv);
  const bPast = await rPast.json();
  ok(rPast.status === 200 && rPast.headers.get("cache-control") === "public, max-age=86400",
     "a past date must be cached 86400s at the edge, got " + rPast.headers.get("cache-control"));

  // ۱۵. 🔴 store — یک بایندینگِ کاملاً غایب باید از یک بایندینگِ بسته-ولی-خالی
  // از بیرون قابلِ‌تشخیص باشد. سه مسیر، دو حالتِ env: بدونِ ZX_KV → store:false،
  // با یک KV جعلیِ حاضر (حتی خالی) → store:true. store همیشه آخرین کلید است.
  for (const [path, body] of [
    ["/report/today.json", bToday], ["/report/2020-01-01.json", bPast], ["/pairs.json", bPairs],
  ]) {
    ok(body.store === false, "without env.ZX_KV, " + path + " must report store:false, got " +
       JSON.stringify(body.store));
    const keys = Object.keys(body);
    ok(keys[keys.length - 1] === "store",
       path + "'s store must be the last key of the body, got " + JSON.stringify(keys));
  }

  const fakeKv = { get: async () => null, put: async () => {} };
  const envWithKv = { ASSETS, ZX_KV: fakeKv };
  const rTodayKv = await call("/report/today.json", { method: "GET" }, envWithKv);
  const bTodayKv = await rTodayKv.json();
  const rDateKv = await call("/report/2020-01-01.json", { method: "GET" }, envWithKv);
  const bDateKv = await rDateKv.json();
  const rPairsKv = await call("/pairs.json", { method: "GET" }, envWithKv);
  const bPairsKv = await rPairsKv.json();
  for (const [path, body] of [
    ["/report/today.json", bTodayKv], ["/report/2020-01-01.json", bDateKv], ["/pairs.json", bPairsKv],
  ]) {
    ok(body.store === true, "with env.ZX_KV present (even bound to an empty store), " + path +
       " must report store:true, got " + JSON.stringify(body.store));
    const keys = Object.keys(body);
    ok(keys[keys.length - 1] === "store",
       path + "'s store must be the last key of the body, got " + JSON.stringify(keys));
  }
  // یک بایندینگِ حاضر-ولی-خالی و یک بایندینگِ کاملاً غایب باید هر دو rows:[]
  // بدهند — تنها فرقشان همین store است، نه شکلِ rows.
  ok(Array.isArray(bTodayKv.rows) && bTodayKv.rows.length === 0 && bTodayKv.store === true,
     "an empty-but-present KV must still yield rows:[] — store:true here means \"nothing collected "
     + "yet\", not \"the binding is missing\"");

  console.log("[report routes] GET /report/today.json, GET /report/<date>.json and GET /pairs.json "
    + "ok — a missing env.ZX_KV degrades to 200 with an empty doc/ring, never 500; non-GET is 405; an "
    + "unparseable date is 400; an unknown ?chain is 400 while ?chain=solana is accepted and returns "
    + "an empty ring; today and /pairs.json cache 300s at the edge, a past date caches 86400s; all "
    + "three routes report store:false with no ZX_KV and store:true with one bound (even empty), "
    + "always as the response body's last key");
}

/* ---- ۲۴. GET /report/run — اجرای دستیِ همان گذر، پشتِ یک راز ----
   این مسیر ابزارِ سنجش است: وقتی زمان‌بند چیزی نمی‌نویسد، تنها راهِ فرق‌گذاشتنِ
   «کرون شلیک نکرد» با «گذر افتاد» یک اجرای به‌دستور است. */
{
  const KEY = "s3cret-run-key-for-tests";
  const envNoKey = { ASSETS };
  const envKey = { ASSETS, RUN_KEY: KEY };
  const hdr = (k) => ({ method: "GET", headers: { "x-run-key": k } });

  // بدونِ RUN_KEY در env، حتی با یک هدرِ درست‌نما: مسیر اصلاً وجود ندارد
  const rOff = await call("/report/run", hdr(KEY), envNoKey);
  ok(rOff.status === 404,
     "with no RUN_KEY in env, /report/run must be 404 (not 401, not 200), got " + rOff.status);

  // RUN_KEY هست ولی هدر نیست، یا هدر غلط است → باز هم ۴۰۴، نه ۴۰۱:
  // از بیرون نباید معلوم شود چنین مسیری وجود دارد.
  const rNoHdr = await call("/report/run", { method: "GET" }, envKey);
  ok(rNoHdr.status === 404, "a missing x-run-key must be 404, got " + rNoHdr.status);
  const rWrong = await call("/report/run", hdr(KEY + "x"), envKey);
  ok(rWrong.status === 404, "a wrong x-run-key must be 404, got " + rWrong.status);

  // کلیدِ درست، ولی بدونِ ZX_KV: باید اجرا شود و صادقانه بگوید انباری نبود —
  // و مثل خودِ زمان‌بند، هیچ فراخوانیِ بالادستی نزند.
  const rRun = await call("/report/run", hdr(KEY), envKey);
  ok(rRun.status === 200, "a correct x-run-key must run the pass and return 200, got " + rRun.status);
  const bRun = await rRun.json();
  ok(bRun.ran === true, "the manual run must report ran:true, got " + JSON.stringify(bRun.ran));
  ok(bRun.store === false,
     "with no ZX_KV bound the manual run must report store:false, got " + JSON.stringify(bRun.store));
  ok(bRun.checked === 0 && bRun.added === 0,
     "with no store the manual run must check nothing, got " + JSON.stringify(bRun));
  ok(typeof bRun.ms === "number" && bRun.ms >= 0,
     "the manual run must report its own duration as a number, got " + JSON.stringify(bRun.ms));

  // متدِ دیگر با کلیدِ درست → ۴۰۵ (نه ۴۰۴): کلید درست بوده، فقط متد غلط است
  const rPost = await call("/report/run", { method: "POST", headers: { "x-run-key": KEY } }, envKey);
  ok(rPost.status === 405, "POST /report/run with a correct key must be 405, got " + rPost.status);

  // ⚠️ «run» نباید به reportRoute برسد و به‌عنوان تاریخِ بدشکل ۴۰۰ بگیرد
  ok(rOff.status !== 400 && rNoHdr.status !== 400,
     "/report/run must never fall through to the date route and answer \"bad date\"");

  // 🔴 راز هرگز نباید در پاسخ ظاهر شود — نه در بدنه، نه در هدرها
  const runBodyText = JSON.stringify(bRun);
  ok(!runBodyText.includes(KEY), "RUN_KEY must never appear in the response body");
  let hdrText = "";
  rRun.headers.forEach((v, k) => { hdrText += k + ":" + v + "\n"; });
  ok(!hdrText.includes(KEY), "RUN_KEY must never appear in a response header");

  // سقفِ اجرای دستی کوچک است، ولی هرگز بزرگ‌تر از سقفِ زمان‌بند
  ok(REPORT_RUN_MAX_TOKENS > 0 && REPORT_RUN_MAX_TOKENS <= REPORT_MAX_TOKENS_PER_RUN,
     "REPORT_RUN_MAX_TOKENS must be a small positive number, never above REPORT_MAX_TOKENS_PER_RUN, got "
     + REPORT_RUN_MAX_TOKENS);

  console.log("[report run] GET /report/run ok — the route does not exist without env.RUN_KEY (404), "
    + "and a missing or wrong x-run-key is 404 as well, never 401, so its existence never leaks; the "
    + "key rides as a header and never as a query, and never surfaces in the response body or headers; "
    + "a correct key runs the same pass the cron runs and answers {ran, checked, added, ms, store}, "
    + "reporting store:false honestly when no KV is bound (checking nothing, exactly like the "
    + "scheduled pass); a non-GET with a correct key is 405; and its token cap ("
    + REPORT_RUN_MAX_TOKENS + ") is never above the scheduled cap (" + REPORT_MAX_TOKENS_PER_RUN + ")");
}

/* ---- ۲۵. لاگِ پروبِ verdict (opts.collect) و GET /vd/<Base>?probe=1 ----
   مسئله‌ای که این ابزار برای آن ساخته شده در بالای این فایل توضیح داده
   نشده، توضیحش کنارِ خودِ verdict.js/index.js است: امروز یک توکنِ Base که
   واقعاً قابلِ‌فروش است می‌تواند "nosell" بگیرد چون صرافیِ واقعی‌اش
   (مثلاً uniswap-v4-base) اصلاً عضوِ VD_VENUES نیست و هر پروب رد می‌شود —
   و از داخلِ همین کانتینر هیچ RPC واقعیِ Base در دسترس نیست تا فهمید هر
   صرافی واقعاً چه برمی‌گرداند. این بخش خودِ verdictِ برگشتی را عوض نمی‌کند
   (هدفِ این تغییر نبود)، فقط ثابت می‌کند لاگِ observe-only درست کار می‌کند:
   هرگز چیزی را عوض نمی‌کند، هرگز از رویِ متنِ خطا تصمیم نمی‌گیرد، هرگز
   URLِ RPC را لو نمی‌دهد، و هرگز کشِ verdict را آلوده نمی‌کند. */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (amountOut) => "0x" + w(amountOut) + w(0) + w(0) + w(0);
  const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const TOKEN = "0x5555555555555555555555555555555555555555";
  const meta = { decimals: 18, priceUsd: 2000 };
  // شکلِ probeItems واقعی را از خودِ buildProbe می‌گیریم، نه یک فهرستِ
  // دستیِ دومِ نامِ صرافی‌ها — اگر VD_VENUES جابه‌جا شود این هم خودش را
  // به‌روز می‌بیند.
  const probeShape = vd.buildProbe(TOKEN, vd.WETH_ADDR, 1n);
  const N_ITEMS = probeShape.length;

  const allObservedOut = []; // برای بخشِ ۲۵.۶ (واژه‌نامه) از همه‌ی سناریوهای زیر جمع می‌شود

  // الف) opts.collect نباید هیچ اثری روی verdict یا شمارِ فراخوانی‌ها بگذارد —
  // دو سناریوی کاملاً یکسان، یکی بدونِ collect، یکی با آن.
  {
    const fetchOnce = async (url, init) => {
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(777) : "0x" });
      return jsonRes(body);
    };
    let calls1 = 0;
    const v1 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: (u, o) => { calls1++; return fetchOnce(u, o); }, rpcs: ["https://rpc-a.example"] });

    let calls2 = 0;
    const collect = [];
    const v2 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: (u, o) => { calls2++; return fetchOnce(u, o); }, rpcs: ["https://rpc-a.example"], collect });

    ok(v1 === "sell" && v2 === "sell", "sanity: this scenario should verdict sell (got " + v1 + "/" + v2 + ")");
    ok(v1 === v2, "opts.collect must never change the returned verdict: without=" + v1 + " with=" + v2);
    ok(calls1 === calls2, "opts.collect must never change the number of fetch calls: without=" +
      calls1 + " with=" + calls2);
    ok(collect.length > 0, "collect should have been populated when passed as an array");
    allObservedOut.push(...collect.map((e) => e.out));
  }

  // ب) یک کوتِ مثبت میانِ رد‌ها → "quoted"، و verdict همچنان "sell"
  {
    const collect = [];
    const fetchImpl = async (url, init) => {
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(777) : "0x" });
      return jsonRes(body);
    };
    const v = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc-a.example"], collect });
    ok(v === "sell", "one quoting item must verdict sell (got " + v + ")");
    const first = probeShape[0]; // آیتمی که در fetchImpl بالا id=1 می‌گیرد
    const entry = collect.find((e) => e.venue === first.id && e.key === first.key && e.stage === "weth");
    ok(entry && entry.out === "quoted",
      "a decoded positive value must be recorded as \"quoted\", got " + JSON.stringify(entry));
    allObservedOut.push(...collect.map((e) => e.out));
  }

  // ب-۲) همان قاعده، ولی برای یک آیتمِ V4_SINGLE — classifyProbeOut باید
  // بازگشتِ دوکلمه‌ایِ v4 را هم درست به "quoted" بخواند، نه اینکه چون از
  // decodeStatic4 نیست undecodable بشمردش.
  {
    const mkStatic2 = (amountOut) => "0x" + w(amountOut) + w(0);
    const v4Item = probeShape.find((p) => p.id === "uniswap-v4");
    const v4Id = probeShape.indexOf(v4Item) + 1; // همان idِ eth_call که callBatch می‌سازد
    const collect = [];
    const fetchImpl = async (url, init) => {
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === v4Id ? mkStatic2(321) : "0x" });
      return jsonRes(body);
    };
    const v = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc-a.example"], collect });
    ok(v === "sell", "a quoted v4 item must also verdict sell (got " + v + ")");
    const entry = collect.find((e) => e.venue === v4Item.id && e.key === v4Item.key && e.stage === "weth");
    ok(entry && entry.out === "quoted",
      "a V4_SINGLE item decoding to a positive amount must be recorded as \"quoted\", got " +
      JSON.stringify(entry));
    allObservedOut.push(...collect.map((e) => e.out));
  }

  // ج) همه با کدِ ۳ رد می‌شوند → هر آیتم "revert:3"، verdict همچنان "nosell"
  // (همان رفتارِ امروز؛ این ابزار فقط آن را ثبت می‌کند، عوضش نمی‌کند).
  let allCode3Collect;
  {
    const collect = [];
    const fetchImpl = async (url, init) => {
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, error: { code: 3 } });
      return jsonRes(body);
    };
    const v = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc-a.example"], collect });
    ok(v === "nosell", "an all-code-3-revert batch must still verdict nosell — this instrument records "
      + "today's behaviour, it does not change it (got " + v + ")");
    const itemEntries = collect.filter((e) => e.venue !== "canary" && e.venue !== null);
    ok(itemEntries.length === N_ITEMS * 2,
      "expected " + (N_ITEMS * 2) + " item entries (both stages ran), got " + itemEntries.length);
    ok(itemEntries.every((e) => e.out === "revert:3"),
      "every reverted item must read \"revert:3\", got: " + JSON.stringify(itemEntries.filter((e) => e.out !== "revert:3")));
    allCode3Collect = collect;
    allObservedOut.push(...collect.map((e) => e.out));
  }

  // د) واژه‌نامه‌ی بسته: خالی/صفر/رمزگشایی‌نشده/کدهای خطا/بدونِ‌پاسخ، همه در یک batch
  {
    const collect = [];
    const [pEmpty, pZero, pBad, pCode, pNoCode, pMissing] = probeShape; // آیتم‌های ۱ تا ۶
    const fetchImpl = async (url, init) => {
      const reqs = JSON.parse(init.body);
      const body = [];
      for (const r of reqs) {
        if (r.id === 0) { body.push({ id: 0, result: mkStatic4(5) }); continue; }
        if (r.id === 1) { body.push({ id: 1, result: "0x" }); continue; }               // "empty"
        if (r.id === 2) { body.push({ id: 2, result: mkStatic4(0) }); continue; }        // "zero"
        if (r.id === 3) { body.push({ id: 3, result: "0xzz" }); continue; }              // "undecodable"
        if (r.id === 4) { body.push({ id: 4, error: { code: -32000 } }); continue; }     // "revert:-32000"
        if (r.id === 5) { body.push({ id: 5, error: { message: "no code field here" } }); continue; } // "revert:unknown"
        if (r.id === 6) continue; // عمداً حذف شده از پاسخ → «no-answer»
        body.push({ id: r.id, result: "0x" });
      }
      return jsonRes(body);
    };
    await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc-a.example"], collect });
    const find = (p) => collect.find((e) => e.venue === p.id && e.key === p.key && e.stage === "weth");
    ok(find(pEmpty) && find(pEmpty).out === "empty",
      "an exact \"0x\" result must read \"empty\", got " + JSON.stringify(find(pEmpty)));
    ok(find(pZero) && find(pZero).out === "zero",
      "a decoded-zero result must read \"zero\", got " + JSON.stringify(find(pZero)));
    ok(find(pBad) && find(pBad).out === "undecodable",
      "an unparseable result string must read \"undecodable\", got " + JSON.stringify(find(pBad)));
    ok(find(pCode) && find(pCode).out === "revert:-32000",
      "error.code -32000 must read exactly \"revert:-32000\" (never from message text), got " +
      JSON.stringify(find(pCode)));
    ok(find(pNoCode) && find(pNoCode).out === "revert:unknown",
      "an error with a missing code must read \"revert:unknown\", got " + JSON.stringify(find(pNoCode)));
    ok(find(pMissing) && find(pMissing).out === "no-answer",
      "no entry for this id (the -1 sentinel shape) must read \"no-answer\", not \"revert:-1\", got " +
      JSON.stringify(find(pMissing)));
    allObservedOut.push(...collect.map((e) => e.out));
  }

  // ه) شکستِ کلِ batch (پرتاب یا غیر-۲۰۰) → دقیقاً یک "batch-failed:<status>"،
  // نه یک ردیف به‌ازای هر آیتم — و status باید همان کدِ واقعی باشد (پرتاب=۰).
  {
    // ه‌.۱ — پرتابِ شبکه‌ای در همان اولین (و تنها) تلاش → مرحله‌ی weth هرگز کامل نشد
    const collect = [];
    const fetchImpl = async () => { throw new Error("network is down"); };
    const v = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc-a.example"], collect });
    ok(v === null, "a thrown fetch with no other endpoint to try must give null (got " + v + ")");
    ok(collect.length === 1 && collect[0].venue === null && collect[0].key === null &&
      collect[0].out === "batch-failed:0" && collect[0].stage === "weth",
      "a thrown fetch must record exactly one batch-failed:0 entry for the weth stage and nothing else, got: "
      + JSON.stringify(collect));
    allObservedOut.push(...collect.map((e) => e.out));
  }
  {
    // ه‌.۲ — مرحله‌ی weth کامل و nosell می‌شود، بعد مرحله‌ی usdc با ۵۰۰ برمی‌گردد
    const collect = [];
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls++;
      if (calls === 1) {
        const reqs = JSON.parse(init.body);
        const body = reqs.map((r) => r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, error: { code: 3 } });
        return jsonRes(body);
      }
      return new Response("boom", { status: 500 });
    };
    const v = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: ["https://rpc-a.example"], collect });
    ok(v === null, "a stage-B non-200 must give null (got " + v + ")");
    const wethEntries = collect.filter((e) => e.stage === "weth");
    const usdcEntries = collect.filter((e) => e.stage === "usdc");
    ok(wethEntries.length === N_ITEMS + 1,
      "the weth stage ran fully and should carry canary + " + N_ITEMS + " items, got " + wethEntries.length);
    ok(usdcEntries.length === 1 && usdcEntries[0].venue === null && usdcEntries[0].key === null &&
      usdcEntries[0].out === "batch-failed:500",
      "a non-200 stage-B batch must record exactly one batch-failed:<status> entry (the real 500, "
      + "not a bare \"batch-failed\") and no per-item entries, got: " + JSON.stringify(usdcEntries));
    allObservedOut.push(...collect.map((e) => e.out));
  }

  // و) مهلتِ تمام‌شده پیش از یک مرحله → دقیقاً یک "deadline" برای همان مرحله، بدونِ هیچ فراخوانی‌ای
  {
    const collect = [];
    let calls = 0;
    const fetchImpl = async () => { calls++; return jsonRes([]); };
    const v = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl, now: () => 10_000, deadlineAt: 5_000, rpcs: ["https://rpc-a.example"], collect });
    ok(v === null && calls === 0, "past the deadline must give null with zero fetch calls (got " + v +
      ", " + calls + " calls)");
    ok(collect.length === 1 && collect[0].venue === null && collect[0].key === null &&
      collect[0].out === "deadline" && collect[0].stage === "weth",
      "a deadline hit before the weth stage must record exactly one deadline entry, got: " + JSON.stringify(collect));
    allObservedOut.push(...collect.map((e) => e.out));
  }

  // ز) کاناری دقیقاً یک‌بار به‌ازای هر batchی که واقعاً اجرا شد، و ترتیبِ
  // stage همیشه weth سپس (در صورتِ اجرا) usdc — با همان سناریوی «بند ج».
  {
    const collect = allCode3Collect;
    const canaryEntries = collect.filter((e) => e.venue === "canary");
    ok(canaryEntries.length === 2,
      "the canary must be recorded once per batch that ran (weth + usdc here), got " + canaryEntries.length);
    ok(canaryEntries[0] && canaryEntries[0].stage === "weth" && canaryEntries[1] && canaryEntries[1].stage === "usdc",
      "canary stage order must be weth then usdc, got " + JSON.stringify(canaryEntries.map((e) => e.stage)));
    const stages = collect.map((e) => e.stage);
    ok(stages.filter((s) => s === "weth").length === N_ITEMS + 1 &&
      stages.filter((s) => s === "usdc").length === N_ITEMS + 1,
      "expected " + (N_ITEMS + 1) + " entries per stage (canary+items), got weth=" +
      stages.filter((s) => s === "weth").length + " usdc=" + stages.filter((s) => s === "usdc").length);
  }

  // ح) واژه‌نامه‌ی بسته — هر out مشاهده‌شده یا عضوِ VD_PROBE_OUT است، یا با
  // "revert:" شروع می‌شود و بخشِ بعدش یک عددِ صحیح یا لفظِ "unknown" است، یا
  // با "batch-failed:" شروع می‌شود و بخشِ بعدش یک عددِ صحیحِ نامنفی است (هرگز
  // "unknown" — status همیشه یک عددِ واقعی است: ۰ برای پرتاب، وگرنه کدِ HTTP).
  // دقیقاً همان قاعده‌ای که VD_SOL_WHY با isFrozenWhy در همین فایل سنجیده
  // می‌شود؛ فهرست از رویِ خودِ vd.VD_PROBE_OUT پیموده می‌شود، نه یک کپیِ دوم.
  function isFrozenProbeOut(out) {
    const s = String(out);
    if (s.startsWith("revert:")) {
      const suffix = s.slice("revert:".length);
      return suffix === "unknown" || /^-?\d+$/.test(suffix);
    }
    if (s.startsWith("batch-failed:")) {
      const suffix = s.slice("batch-failed:".length);
      return /^\d+$/.test(suffix);
    }
    return vd.VD_PROBE_OUT.includes(s);
  }
  /* ک) شاهدِ «استخرِ واقعیِ v4 هیچ اندازه‌ای را پر نمی‌کند» — تنها حالتی که
     یک ردیفِ positive-only منفی اثبات می‌کند (تصمیمِ حسام، ۱۹ شهریور).
     شکلِ پاسخ از اندازه‌گیریِ زنده آمده: کوترِ v4 خطای استخر را در
     UnexpectedRevertBytes(bytes) می‌پیچد و چهار بایتِ درونی
     NotEnoughLiquidity(bytes32) است، با شناسه‌ی خودِ همان استخر. */
  {
    const POOL_ID = "0x48c69f5edad1664e170aac7c20f7b299add9668bc8dd221d9e18b6649b386263";
    const REAL_KEY = {
      currency0: vd.NATIVE_ADDR, currency1: TOKEN.toLowerCase(),
      fee: 0, tickSpacing: 1, hooks: vd.NATIVE_ADDR, poolId: POOL_ID,
    };
    // 🔴 بایت‌ها دقیقاً همان چیزی است که زنجیره برگرداند: پوشش + طول + درونی
    const wrapped = (poolId) => vd.VD_REVERT_WRAPPER + w(0x20) + w(36) +
      vd.VD_NO_LIQUIDITY_SELECTOR.slice(2) + poolId.slice(2) + "0".repeat(56);
    const dispatch = (poolIdInError) => async (url, init) => {
      const reqs = JSON.parse(init.body);
      return jsonRes(reqs.map((r) => {
        if (r.id === 0) return { id: 0, result: mkStatic4(5) };
        const item = probeShapeReal[r.id - 1];
        if (item && item.poolId) {
          return { id: r.id, error: { code: 3, data: wrapped(poolIdInError) } };
        }
        return { id: r.id, error: { code: 3 } }; // بقیه: ریوِرتِ اثباتیِ معمولی
      }));
    };
    const probeShapeReal = vd.buildProbe(TOKEN, vd.WETH_ADDR, 1n, { v4Keys: [REAL_KEY] });
    ok(probeShapeReal.some((x) => x.poolId === POOL_ID),
       "sanity: buildProbe must carry the real key's poolId on the row it built from it");
    ok(vd.buildProbe(TOKEN, vd.WETH_ADDR, 1n).every((x) => !x.poolId),
       "a guessed v4 row must never carry a poolId — that is what keeps a guess from ever proving a negative");

    const collect = [];
    const whyOut = {};
    const v = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: dispatch(POOL_ID), rpcs: ["https://rpc-a.example"], v4Keys: [REAL_KEY], collect, whyOut });
    ok(v === "nosell", "a real v4 pool answering NotEnoughLiquidity for its own pool id must count as " +
       "evidence, got " + v);
    ok(collect.some((e) => e.out === "no-liquidity"),
       "the probe log must show no-liquidity, separately from revert:<code>, got " +
       JSON.stringify(collect.map((e) => e.out).slice(0, 6)));
    ok(whyOut.v4Proof === true,
       "fetchVerdict must tell the caller the negative rests on a real v4 pool, so the coverage gate can see it");
    allObservedOut.push(...collect.map((e) => e.out));

    // 🔴 همان پاسخ، ولی شناسه‌ی داخلِ خطا مالِ استخرِ دیگری است → هیچ اثباتی
    const OTHER = "0x" + "9".repeat(64);
    const collect2 = [];
    const whyOut2 = {};
    const v2 = await vd.fetchVerdict(TOKEN, { decimals: 18, priceUsd: 2000 },
      { fetchImpl: async (url, init) => {
          const reqs = JSON.parse(init.body);
          return jsonRes(reqs.map((r) => {
            if (r.id === 0) return { id: 0, result: mkStatic4(5) };
            const item = probeShapeReal[r.id - 1];
            if (item && item.poolId) return { id: r.id, error: { code: 3, data: wrapped(OTHER) } };
            return { id: r.id, error: { code: 3 } }; // اثباتِ منفیِ عادی، بدونِ کمکِ v4
          }));
        }, rpcs: ["https://rpc-a.example"], v4Keys: [REAL_KEY], collect: collect2, whyOut: whyOut2 });
    ok(v2 === "nosell", "sanity: the other venues still prove the negative on their own, got " + v2);
    ok(!collect2.some((e) => e.out === "no-liquidity"),
       "a pool id that does not match the key we sent must never be logged as no-liquidity");
    ok(whyOut2.v4Proof !== true,
       "a mismatched pool id must not raise the v4 proof flag — that flag is what lets the coverage gate " +
       "accuse a token whose only pool is on v4");
    allObservedOut.push(...collect2.map((e) => e.out));

    /* 🔴 شرطِ ۲: خطای درونیِ دیگری غیرِ NotEnoughLiquidity هیچ‌چیز اثبات
       نمی‌کند. PoolNotInitialized یعنی کلیدِ ما اشتباه بوده — و یک کلیدِ
       اشتباه دقیقاً همان چیزی است که نباید به اتهام ترجمه شود. */
    const wrappedOther = vd.VD_REVERT_WRAPPER + w(0x20) + w(4) + "486aa307" + "0".repeat(56);
    // مستقیم روی verdictFrom، چون فقط این‌جا می‌شود «تنها شاهد، همین ردیف
    // است» را ساخت: یک فهرستِ تک‌ردیفیِ v4.
    const aliveC = { result: mkStatic4(5) };
    ok(vd.verdictFrom({ canary: aliveC,
        items: [{ kind: "V4_SINGLE", poolId: POOL_ID, error: { code: 3, data: wrapped(POOL_ID) } }] })
        === "nosell",
       "a lone real-key v4 row answering NotEnoughLiquidity for its own pool id must be enough");
    ok(vd.verdictFrom({ canary: aliveC,
        items: [{ kind: "V4_SINGLE", poolId: POOL_ID, error: { code: 3, data: wrappedOther } }] })
        === null,
       "the same row answering PoolNotInitialized proves nothing — a wrong key must never become an accusation");
    ok(vd.verdictFrom({ canary: aliveC,
        items: [{ kind: "V4_SINGLE", poolId: null, error: { code: 3, data: wrapped(POOL_ID) } }] })
        === null,
       "a guessed row (no pool id) answering NotEnoughLiquidity proves nothing");
    /* 🔴 شرطِ ۲ به‌تنهایی: خطای درونیِ دیگری که *اتفاقاً* همان شناسه را هم در
       آرگومانش دارد. اگر فقط شناسه را مقایسه می‌کردیم و چهار بایت را نه،
       این یکی هم اثبات حساب می‌شد. */
    const wrappedSameIdOtherError = vd.VD_REVERT_WRAPPER + w(0x20) + w(36) +
      "deadbeef" + POOL_ID.slice(2) + "0".repeat(56);
    ok(vd.verdictFrom({ canary: aliveC,
        items: [{ kind: "V4_SINGLE", poolId: POOL_ID,
                  error: { code: 3, data: wrappedSameIdOtherError } }] })
        === null,
       "an inner error that is not NotEnoughLiquidity proves nothing, even when its first word happens to " +
       "be our pool id — the selector is checked, not just the id");

    const collect3 = [];
    const whyOut3 = {};
    await vd.fetchVerdict(TOKEN, { decimals: 18, priceUsd: 2000 },
      { fetchImpl: async (url, init) => {
          const reqs = JSON.parse(init.body);
          return jsonRes(reqs.map((r) => {
            if (r.id === 0) return { id: 0, result: mkStatic4(5) };
            const item = probeShapeReal[r.id - 1];
            if (item && item.poolId) return { id: r.id, error: { code: 3, data: wrappedOther } };
            return { id: r.id, error: { code: 3 } };
          }));
        }, rpcs: ["https://rpc-a.example"], v4Keys: [REAL_KEY], collect: collect3, whyOut: whyOut3 });
    ok(!collect3.some((e) => e.out === "no-liquidity"),
       "only NotEnoughLiquidity may ever be logged as no-liquidity, got " +
       JSON.stringify(collect3.map((e) => e.out).slice(0, 6)));
    ok(whyOut3.v4Proof !== true, "a wrong key must never raise the v4 proof flag");

    /* شرطِ ۱: همان پاسخِ NotEnoughLiquidity، ولی روی یک ردیفِ *حدسی* (بدونِ
       poolId) — یک حدس هرگز حق اثبات ندارد. */
    const collect4 = [];
    const whyOut4 = {};
    const v4g = await vd.fetchVerdict(TOKEN, { decimals: 18, priceUsd: 2000 },
      { fetchImpl: async (url, init) => {
          const reqs = JSON.parse(init.body);
          return jsonRes(reqs.map((r) => {
            if (r.id === 0) return { id: 0, result: mkStatic4(5) };
            return { id: r.id, error: { code: 3, data: wrapped(POOL_ID) } };
          }));
        }, rpcs: ["https://rpc-a.example"], collect: collect4, whyOut: whyOut4 }); // بدونِ v4Keys
    ok(!collect4.some((e) => e.out === "no-liquidity"),
       "a guessed v4 row carries no pool id, so its answer may never be read as no-liquidity");
    ok(whyOut4.v4Proof !== true, "a guessed row must never raise the v4 proof flag");
    allObservedOut.push(...collect3.map((e) => e.out), ...collect4.map((e) => e.out));
  }

  ok(allObservedOut.length > 10, "sanity: the scenarios above should have observed a good number of outs, got "
    + allObservedOut.length);
  const stray = allObservedOut.filter((o) => !isFrozenProbeOut(o));
  ok(stray.length === 0, "every observed \"out\" must match the frozen vocabulary (VD_PROBE_OUT, or a " +
    "\"revert:<int|unknown>\" or \"batch-failed:<int>\"), got strays: " + JSON.stringify(stray));
  // هر عضوِ خودِ VD_PROBE_OUT (به‌جز پیشوندهای برهنه‌ی "revert" و "batch-failed")
  // واقعاً هم در یکی از سناریوهای بالا مشاهده شد — واژه‌نامه بازتابِ رفتارِ
  // واقعی است، نه فقط یک آرزو.
  const observedSet = new Set(allObservedOut);
  for (const label of vd.VD_PROBE_OUT) {
    if (label === "revert" || label === "batch-failed") continue; // این دو هرگز خام ثبت نمی‌شوند، همیشه با ":<عدد>"
    ok(observedSet.has(label), "VD_PROBE_OUT lists \"" + label + "\" but no scenario above ever produced it");
  }

  // ط) GET /vd/<Base address>?probe=1 سرتاسری — venues فقط اینجا ظاهر می‌شود
  {
    const { UPSTREAM_FREE: UF } = await import("./index.js");
    const ADDR_PROBE = "0x" + "6".repeat(40);
    const savedFetch = globalThis.fetch;
    const gtMeta = () => new Response(JSON.stringify({ data: { attributes: {
      name: "Probe Test Token", symbol: "PTT", total_reserve_in_usd: "1000",
      decimals: 18, price_usd: "2000" } } }), { status: 200, headers: { "content-type": "application/json" } });

    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF)) return gtMeta();
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(555) : "0x" });
      return jsonRes(body);
    };

    const resProbe = await call("/vd/" + ADDR_PROBE + "?probe=1",
      { headers: { "cf-connecting-ip": "203.0.113.90" } });
    ok(resProbe.status === 200, "/vd/<addr>?probe=1 should be 200 (got " + resProbe.status + ")");
    const bodyProbe = await resProbe.json();
    ok(Array.isArray(bodyProbe.venues), "?probe=1 must answer with a venues array, got " +
      JSON.stringify(bodyProbe).slice(0, 300));
    ok(bodyProbe.v === "sell" && typeof bodyProbe.ms === "number",
      "?probe=1 must still answer {v, ms} alongside venues, got " + JSON.stringify(bodyProbe).slice(0, 300));
    ok(bodyProbe.venues.length > 0, "?probe=1's venues array should not be empty for a scenario that ran");
    for (const rpcHost of vd.VD_RPCS) {
      ok(!JSON.stringify(bodyProbe).includes(new URL(rpcHost).hostname),
        "no real RPC hostname should ever appear in the probe response body, found " + rpcHost);
    }

    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF)) return gtMeta();
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(555) : "0x" });
      return jsonRes(body);
    };
    const resNormal = await call("/vd/" + ADDR_PROBE, { headers: { "cf-connecting-ip": "203.0.113.91" } });
    ok(resNormal.status === 200, "/vd/<addr> without probe should still be 200 (got " + resNormal.status + ")");
    const bodyNormal = await resNormal.json();
    ok(!("venues" in bodyNormal), "a normal (non-probe) /vd/<addr> response must never carry a venues key, "
      + "got keys: " + JSON.stringify(Object.keys(bodyNormal)));
    const normalKeys = Object.keys(bodyNormal).sort();
    ok(normalKeys.length === 2 && normalKeys[0] === "ms" && normalKeys[1] === "v",
      "a normal /vd/<addr> body must be exactly {v, ms}, got keys: " + JSON.stringify(normalKeys));

    globalThis.fetch = savedFetch;
  }

  // ي) URLِ اختصاصیِ RPC هرگز نباید در collect ظاهر شود — نه کاملش، نه
  // مسیرش، نه کوئری‌اش. ⚠️ این‌جا قبلاً نوشته بود «worker/verdict.js هیچ راهِ
  // تزریقِ rpcs را برای /vd/<Base> از env نمی‌دهد، برخلافِ SOL_RPC برای
  // سولانا» — از وقتی env.BASE_RPC اضافه شد (baseRpcsFor در worker/index.js،
  // بخشِ «RPC اختصاصی» پایین‌تر) آن جمله دیگر درست نیست: Base هم حالا دقیقاً
  // همان الگو را دارد. این پروب همچنان مستقیماً روی خودِ fetchVerdict می‌سنجد
  // (نه روی baseRpcsFor)، چون فقط می‌خواهد ثابت کند خودِ fetchVerdict هیچ‌جای
  // آرایه‌ی rpcs را در لاگ فاش نمی‌کند — همان آرایه‌ای که ?probe=1 بدونِ هیچ
  // تغییری زیرِ کلیدِ venues برمی‌گرداند. سنجشِ خودِ baseRpcsFor و سیم‌کشیِ
  // env.BASE_RPC سرتاسری در بخشِ تازه‌ی پایین‌تر می‌آید.
  {
    const SECRET_RPC = "https://rpc.example.invalid/v2/SECRET-PATH?k=SECRET-QUERY";
    const collect = [];
    const fetchImpl = async (url, init) => {
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, error: { code: 3 } });
      return jsonRes(body);
    };
    const v = await vd.fetchVerdict(TOKEN, meta, { fetchImpl, rpcs: [SECRET_RPC], collect });
    ok(v === "nosell", "sanity check for the secrecy scenario (got " + v + ")");
    const serialized = JSON.stringify(collect);
    ok(!serialized.includes("SECRET-PATH"), "the injected RPC URL's path leaked into the probe log: " + serialized);
    ok(!serialized.includes("SECRET-QUERY"), "the injected RPC URL's query leaked into the probe log: " + serialized);
    ok(!serialized.includes(SECRET_RPC), "the full injected RPC URL leaked into the probe log");
  }

  // ك) ?probe=1 هرگز نباید کشِ verdict را بخواند یا در آن بنویسد — یک ضربه‌ی
  // کش دقیقاً یک verdict بدونِ هیچ جزئیاتی می‌داد و کلِ این ابزار کور می‌شد.
  {
    const shelf = new Map();
    globalThis.caches = {
      default: {
        match: async (req) => { const v = shelf.get(req.url); return v ? v.clone() : undefined; },
        put: async (req, r) => { shelf.set(req.url, r); },
      },
    };
    const { UPSTREAM_FREE: UF2 } = await import("./index.js");
    const ADDR_CACHE = "0x" + "7".repeat(40);
    const savedFetch = globalThis.fetch;
    const gtMeta2 = () => new Response(JSON.stringify({ data: { attributes: {
      name: "Cache Test Token", symbol: "CTT", total_reserve_in_usd: "1000",
      decimals: 18, price_usd: "2000" } } }), { status: 200, headers: { "content-type": "application/json" } });

    // اول: ?probe=1 با پاسخی که "nosell" می‌دهد
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF2)) return gtMeta2();
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, error: { code: 3 } });
      return jsonRes(body);
    };
    const resProbe = await call("/vd/" + ADDR_CACHE + "?probe=1",
      { headers: { "cf-connecting-ip": "203.0.113.92" } });
    const bodyProbe = await resProbe.json();
    ok(bodyProbe.v === "nosell", "sanity: the probe scenario here should verdict nosell (got " +
      JSON.stringify(bodyProbe) + ")");
    ok(shelf.size === 0, "?probe=1 must never write to the verdict cache, found " + shelf.size + " entries");

    // بعد: همان آدرس، بدونِ probe، ولی این‌بار RPC جواب دیگری می‌دهد
    // ("sell") — اگر مسیرِ عادی از کش سرو می‌شد همچنان "nosell" قدیمی را
    // می‌دید؛ چون واقعاً دوباره fetch می‌کند، جوابِ تازه را می‌بیند.
    let rpcCallsAfter = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF2)) return gtMeta2();
      rpcCallsAfter++;
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(999) : "0x" });
      return jsonRes(body);
    };
    const resNormal = await call("/vd/" + ADDR_CACHE, { headers: { "cf-connecting-ip": "203.0.113.93" } });
    const bodyNormal = await resNormal.json();
    ok(bodyNormal.v === "sell" && rpcCallsAfter > 0,
      "the normal path after ?probe=1 must really re-fetch and see the new answer, not a cached "
      + "\"nosell\" from the probe path (got v=" + bodyNormal.v + ", rpcCallsAfter=" + rpcCallsAfter + ")");

    delete globalThis.caches;
    globalThis.fetch = savedFetch;
  }

  // ⚠️ این بلوک چند بار globalThis.fetch را برای آزمودنِ worker.fetch سرتاسری
  // عوض کرد؛ اگر همین‌جا به trackingFetch برنگردد، هر بخشِ بعدی که به
  // sent/reply تکیه دارد بی‌صدا چیزی نمی‌بیند (همان تله‌ای که بخشِ ۱۳ هم
  // کنارش هشدار داده).
  globalThis.fetch = trackingFetch;

  console.log("[vd probe] opts.collect never changes the verdict or the fetch-call count; a positive "
    + "item reads \"quoted\"; an all-revert:3 batch is recorded faithfully as nosell (unchanged "
    + "behaviour); \"0x\"/zero/undecodable/revert:<code>/revert:unknown/no-answer all classified from "
    + "status and shape only, never from error.message; a whole-batch failure (throw or non-200) "
    + "records exactly one batch-failed:<status> entry (0 for a throw, the real HTTP status otherwise, "
    + "never from error.message), never one per item; a deadline hit before a stage "
    + "records exactly one deadline entry for that stage; the canary is recorded once per batch that "
    + "ran, weth before usdc; every observed out matches the frozen VD_PROBE_OUT vocabulary (prefix+int "
    + "rule verified the same way as VD_SOL_WHY); GET /vd/<address>?probe=1 adds a venues array "
    + "end to end while a normal /vd/<address> body stays exactly {v, ms}; an injected RPC URL's path "
    + "and query never leak into the probe log; and ?probe=1 never reads or writes the verdict cache");
}

/* ---- ۲۵ب. رفعِ باگِ batch-failedِ متناوب — VD_RPCS/VD_MAX_ENDPOINTS/baseRpcsFor ----
   مسئله (بالای worker/verdict.js): سه از پنج اندپوینتِ VD_RPCS قبلی هرگز
   batch را جواب نمی‌دادند، و سقفِ failoverِ قدیمی (۲) دقیقاً با دومین
   اندپوینتِ ناسالم (meowrpc) پُر می‌شد — یک هیک‌آپِ اولین اندپوینت کافی بود
   کل verdict را «نامعلوم» کند. این بخش هر چهار تکه‌ی رفع را می‌سنجد:
   فهرستِ هرس‌شده، سقفِ تازه، env.BASE_RPC (دقیقاً هم‌شکل با env.SOL_RPC)، و
   اینکه batch-failed حالا وضعیت هم می‌گوید. */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (amountOut) => "0x" + w(amountOut) + w(0) + w(0) + w(0);
  const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const meta = { decimals: 18, priceUsd: 2000 };

  // الف) VD_RPCS پین‌شده — دقیقاً همان دو میزبانِ batch-capable، به همان ترتیب؛
  // و هر سه‌ی حذف‌شده باید غایب باشند، هرکدام با دلیلِ اندازه‌گیری‌شده‌ی خودش.
  {
    ok(vd.VD_RPCS.length === 2 &&
       vd.VD_RPCS[0] === "https://base.publicnode.com" &&
       vd.VD_RPCS[1] === "https://base.gateway.tenderly.co",
       "VD_RPCS must be pinned to exactly the two measured batch-capable hosts, in that order, got: " +
       JSON.stringify(vd.VD_RPCS));
    ok(!vd.VD_RPCS.some((u) => u.includes("meowrpc")),
       "base.meowrpc.com measured batch 0/5 (control only 1/3, an unstable endpoint, not just batch-less) " +
       "— it must never be back in VD_RPCS, got: " + JSON.stringify(vd.VD_RPCS));
    ok(!vd.VD_RPCS.some((u) => u.includes("drpc.org")),
       "base.drpc.org measured batch 0/5 (control 3/3 — single calls always worked, batches never) " +
       "— it must never be back in VD_RPCS, got: " + JSON.stringify(vd.VD_RPCS));
    ok(!vd.VD_RPCS.some((u) => u.includes("mainnet.base.org")),
       "mainnet.base.org measured batch 0/5 (control 3/3 — single calls always worked, batches never) " +
       "— it must never be back in VD_RPCS, got: " + JSON.stringify(vd.VD_RPCS));
  }

  // ب) VD_MAX_ENDPOINTS صادر شده، برابرِ ۳ است، و حلقه واقعاً آن را رعایت
  // می‌کند: با چهار اندپوینتِ تزریقیِ همه‌شکست‌خورده، دقیقاً سه‌تا امتحان
  // می‌شود، نه دو و نه چهار.
  {
    ok(vd.VD_MAX_ENDPOINTS === 3, "VD_MAX_ENDPOINTS must be exported and equal 3, got " + vd.VD_MAX_ENDPOINTS);

    const rpcs = [
      "https://rpc-cap1.example", "https://rpc-cap2.example",
      "https://rpc-cap3.example", "https://rpc-cap4.example",
    ];
    const calls = [];
    const fetchImpl = async (url) => { calls.push(String(url)); throw new Error("down"); };
    const TOKEN_CAP = "0x" + "6".repeat(40);
    const v = await vd.fetchVerdict(TOKEN_CAP, meta, { fetchImpl, rpcs });
    ok(v === null, "four failing endpoints must still verdict null, never throw (got " + v + ")");
    ok(calls.length === vd.VD_MAX_ENDPOINTS,
       "exactly VD_MAX_ENDPOINTS (" + vd.VD_MAX_ENDPOINTS + ") endpoints must be tried with four failing " +
       "candidates available, got " + calls.length + ": " + calls.join(","));
    ok(calls.join(",") === rpcs.slice(0, vd.VD_MAX_ENDPOINTS).join(","),
       "the first VD_MAX_ENDPOINTS candidates must be tried in order and the fourth never reached: " +
       calls.join(","));
  }

  // ج) baseRpcsFor — همان الگویِ solRpcsFor: بدونِ BASE_RPC فهرستِ عمومی
  // بایت‌به‌بایت دست‌نخورده می‌ماند؛ با آن، راز اول می‌آید و فهرستِ عمومی
  // پشتِ آن، بدونِ تغییر.
  {
    const { baseRpcsFor } = await import("./index.js");
    ok(baseRpcsFor({}).join(",") === vd.VD_RPCS.join(","),
       "baseRpcsFor with no BASE_RPC must leave VD_RPCS untouched: " + JSON.stringify(baseRpcsFor({})));
    ok(baseRpcsFor(undefined).join(",") === vd.VD_RPCS.join(","),
       "baseRpcsFor must defend against a missing env, exactly like solRpcsFor/CG_KEY's own read");
    ok(baseRpcsFor({ BASE_RPC: 123 }).join(",") === vd.VD_RPCS.join(","),
       "a non-string BASE_RPC must be ignored, exactly like a non-string SOL_RPC/CG_KEY would be");

    const SECRET_URL = "https://priv-base-rpc.example/token/SUPERSECRETPATH?api-key=SUPERSECRETQUERY";
    const withSecret = baseRpcsFor({ BASE_RPC: SECRET_URL });
    ok(withSecret[0] === SECRET_URL && withSecret.length === vd.VD_RPCS.length + 1 &&
       withSecret.slice(1).join(",") === vd.VD_RPCS.join(","),
       "baseRpcsFor with BASE_RPC set must try it first, with the public VD_RPCS list intact behind it: " +
       JSON.stringify(withSecret));
  }

  // د) batch-failed:<status> هرگز از رویِ error.message نمی‌آید — یک پیغامِ
  // گمراه‌کننده که یک عددِ دیگر (۴۰۳) را داخلِ متن حمل می‌کند نباید آن عدد را
  // به بیرون درز بدهد؛ status باید همچنان ۰ (پرتاب) بماند.
  {
    const collect = [];
    const fetchImpl = async () => { throw new Error("403 Forbidden — access denied, quota exceeded"); };
    const TOKEN_MSG = "0x" + "7".repeat(40);
    const v = await vd.fetchVerdict(TOKEN_MSG, meta, { fetchImpl, rpcs: ["https://rpc-msg.example"], collect });
    ok(v === null, "sanity: a throwing endpoint must verdict null (got " + v + ")");
    ok(collect.length === 1 && collect[0].out === "batch-failed:0",
       "a thrown fetch's batch-failed status must be 0 regardless of the error's message text, got: " +
       JSON.stringify(collect));
    const serialized = JSON.stringify(collect);
    ok(!serialized.includes("Forbidden") && !serialized.includes("403") && !serialized.includes("quota"),
       "batch-failed must never leak error.message text into the probe log: " + serialized);
  }

  // ه) رازِ BASE_RPC هرگز درز نمی‌کند — سرتاسری از رویِ worker.fetch، نه فقط
  // روی fetchImpl تزریقی: GET /vd/<آدرس>?probe=1 با env.BASE_RPC (کلید هم در
  // مسیر هم در کوئریِ خودِ URL) و هر سه کاندید (راز + دو میزبانِ عمومی) شکست‌
  // خورده. هم‌زمان همین سناریو سیم‌کشیِ محلِ فراخوانیِ دومِ fetchVerdict (خطِ
  // probe=1 در diagVerdict) را هم ثابت می‌کند: راز باید اول امتحان شود.
  {
    const { UPSTREAM_FREE: UF_LEAK } = await import("./index.js");
    const ADDR_LEAK = "0x" + "b".repeat(40);
    const SECRET_PATH = "SUPERSECRETPATH-B";
    const SECRET_QUERY = "SUPERSECRETQUERY-B";
    const SECRET_BASE_RPC = "https://priv-base-rpc-leak.example/token/" + SECRET_PATH + "?api-key=" + SECRET_QUERY;
    const savedFetch = globalThis.fetch;
    const rpcCalls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF_LEAK)) {
        return jsonRes({ data: { attributes: {
          name: "Leak Test Token", symbol: "LEAK", total_reserve_in_usd: "1000",
          decimals: 18, price_usd: "2000",
        } } });
      }
      rpcCalls.push(u);
      return new Response("boom", { status: 500 }); // هر اندپوینتی، حتی رازِ اول، شکست می‌خورد
    };
    const res = await call("/vd/" + ADDR_LEAK + "?probe=1",
      { headers: { "cf-connecting-ip": "203.0.113.150" } }, { ASSETS, BASE_RPC: SECRET_BASE_RPC });
    ok(res.status === 200,
       "/vd/<addr>?probe=1 with BASE_RPC set and every endpoint failing must still be 200, got " + res.status);
    const body = await res.json();
    const raw = JSON.stringify(body);
    ok(body.v === null, "every endpoint failing must verdict null, got " + raw);
    ok(rpcCalls.length === 3 && rpcCalls[0] === SECRET_BASE_RPC &&
       rpcCalls[1] === vd.VD_RPCS[0] && rpcCalls[2] === vd.VD_RPCS[1],
       "with BASE_RPC set, ?probe=1 (the second fetchVerdict call site, in diagVerdict) must try the " +
       "secret first, then VD_RPCS in order, all three (VD_MAX_ENDPOINTS) since every one fails, got: " +
       JSON.stringify(rpcCalls));
    ok(!raw.includes(SECRET_PATH) && !raw.includes(SECRET_QUERY) && !raw.includes("api-key") &&
       !raw.includes(SECRET_BASE_RPC),
       "BASE_RPC's path/query/full URL must never leak into ?probe=1's response body: " + raw);
    globalThis.fetch = savedFetch;
  }

  // و) سیم‌کشی — هر سه مسیری که به fetchVerdict می‌رسند باید واقعاً
  // env.BASE_RPC را اول امتحان کنند، سرتاسری از رویِ worker.fetch.
  function makeWireFetch(UF, SECRET, rpcCalls) {
    return async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF)) {
        return jsonRes({ data: { attributes: {
          name: "Wire Test Token", symbol: "WIRE", total_reserve_in_usd: "1000",
          decimals: 18, price_usd: "2000",
        } } });
      }
      rpcCalls.push(u);
      if (u === SECRET) {
        const reqs = JSON.parse(init.body);
        const body = reqs.map((r) =>
          r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, result: mkStatic4(999) });
        return jsonRes(body);
      }
      return new Response("must never be reached", { status: 500 }); // فهرستِ عمومی نباید حتی لمس شود
    };
  }

  // و‌.۱ — GET /vd/<آدرس> عادی (خطِ اولِ fetchVerdict، داخلِ ogFetchVerdict)
  {
    const { UPSTREAM_FREE: UF1 } = await import("./index.js");
    const ADDR1 = "0x" + "c".repeat(40);
    const SECRET1 = "https://priv-base-rpc-wire1.example/token/WIREPATH1?api-key=WIREQUERY1";
    const savedFetch = globalThis.fetch;
    const rpcCalls = [];
    globalThis.fetch = makeWireFetch(UF1, SECRET1, rpcCalls);
    const res = await call("/vd/" + ADDR1,
      { headers: { "cf-connecting-ip": "203.0.113.151" } }, { ASSETS, BASE_RPC: SECRET1 });
    ok(res.status === 200, "/vd/<addr> with BASE_RPC set should be 200, got " + res.status);
    const body = await res.json();
    ok(body.v === "sell",
       "/vd/<addr> (ogFetchVerdict's fetchVerdict call) did not use env.BASE_RPC first: " + JSON.stringify(body));
    ok(rpcCalls.length === 1 && rpcCalls[0] === SECRET1,
       "env.BASE_RPC must be the only/first RPC endpoint hit for /vd/<addr>, got: " + JSON.stringify(rpcCalls));
    globalThis.fetch = savedFetch;
  }

  // و‌.۲ — کارتِ پیش‌نمایش /t/<آدرس> (همان ogFetchVerdict، این‌بار از پشتِ
  // خط‌لوله‌ی کارت). ⚠️ در Node، HTMLRewriter تعریف‌نشده است (injectOg خودش
  // همین را می‌گوید)، پس worker.fetch پیش از تمام‌شدنِ vdPromise برمی‌گردد —
  // زنجیره‌ی metaPromise→ogFetchVerdict→fetchVerdict همچنان در پس‌زمینه اجرا
  // می‌شود. چند تیکِ میکروتاسک/تایمرِ خالی به آن فرصتِ رسیدن به همان fetch
  // جعلی را می‌دهد.
  {
    const { UPSTREAM_FREE: UF2 } = await import("./index.js");
    const ADDR2 = "0x" + "d".repeat(40);
    const SECRET2 = "https://priv-base-rpc-wire2.example/token/WIREPATH2?api-key=WIREQUERY2";
    const savedFetch = globalThis.fetch;
    const rpcCalls = [];
    globalThis.fetch = makeWireFetch(UF2, SECRET2, rpcCalls);
    await call("/t/" + ADDR2, { headers: { "cf-connecting-ip": "203.0.113.152" } }, { ASSETS, BASE_RPC: SECRET2 });
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
    ok(rpcCalls.length > 0 && rpcCalls[0] === SECRET2,
       "the OG-card path (/t/<addr>, same ogFetchVerdict as /vd/<addr>) must also hit env.BASE_RPC first, " +
       "got: " + JSON.stringify(rpcCalls));
    globalThis.fetch = savedFetch;
  }

  // و‌.۳ — گذرِ گزارش/کرون (GET /report/run → scheduledReportPass → runReportPass
  // → verdictOf → ogFetchVerdict). این مسیر لایه‌های بیشتری بینِ راز و
  // fetchVerdict دارد؛ اگر یکی از آن‌ها env را جا می‌گذاشت، همین‌جا معلوم می‌شد.
  {
    const { UPSTREAM_FREE: UF3 } = await import("./index.js");
    const SECRET3 = "https://priv-base-rpc-wire3.example/token/WIREPATH3?api-key=WIREQUERY3";
    const savedFetch = globalThis.fetch;
    const rpcCalls = [];
    const POOL_ROW = {
      attributes: {
        base_token_price_usd: "2000",
        reserve_in_usd: "10000",
        pool_created_at: "2026-09-13T00:00:00Z",
        volume_usd: { h24: "1000" },
        fdv_usd: "500000",
      },
      relationships: {
        base_token: { data: { id: "base_0x" + "e".repeat(40) } },
        dex: { data: { id: "uniswap-v3-base" } },
      },
    };
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/new_pools")) return jsonRes({ data: [POOL_ROW] });
      if (u.startsWith(UF3)) {
        return jsonRes({ data: { attributes: {
          name: "Cron Test Token", symbol: "CRON", total_reserve_in_usd: "1000",
          decimals: 18, price_usd: "2000",
        } } });
      }
      // پروبِ سقفِ ساب‌ریکوئست (انتهای runReportPass) — یک HEAD ساده به
      // GeckoTerminal، نه یک تماسِ RPC؛ نباید در rpcCalls شمرده شود.
      if (u.includes("/networks?page=1")) return new Response("", { status: 200 });
      rpcCalls.push(u);
      if (u === SECRET3) {
        const reqs = JSON.parse(init.body);
        const body = reqs.map((r) =>
          r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, result: mkStatic4(999) });
        return jsonRes(body);
      }
      return new Response("must never be reached", { status: 500 });
    };
    const fakeKvW = { get: async () => null, put: async () => {} };
    const cronEnv = { ASSETS, ZX_KV: fakeKvW, RUN_KEY: "wire-run-key", BASE_RPC: SECRET3 };
    const res = await call("/report/run", { method: "GET", headers: { "x-run-key": "wire-run-key" } }, cronEnv);
    ok(res.status === 200, "/report/run must be 200, got " + res.status);
    const body = await res.json();
    ok(body.checked === 1,
       "/report/run should have checked exactly the one fresh token, got " + JSON.stringify(body));
    ok(rpcCalls.length === 1 && rpcCalls[0] === SECRET3,
       "the report/cron path (scheduledReportPass -> ogFetchVerdict) must also hit env.BASE_RPC first, got: " +
       JSON.stringify(rpcCalls));
    globalThis.fetch = savedFetch;
  }

  globalThis.fetch = trackingFetch; // برگرداندنِ موکِ پیش‌فرض برای هرچه بعد از این اجرا می‌شود

  console.log("[base rpc batch fix] VD_RPCS pinned to the two measured batch-capable hosts (meowrpc/drpc/" +
    "mainnet.base.org absent, each with its measured reason); VD_MAX_ENDPOINTS exported as 3 and the " +
    "failover loop honours it (four failing candidates → exactly three tried); baseRpcsFor mirrors " +
    "solRpcsFor byte-for-byte (absent BASE_RPC → VD_RPCS untouched, present → secret first then the " +
    "public list); batch-failed now carries \":<status>\" (0 for a throw, the real HTTP status " +
    "otherwise, never from error.message); and env.BASE_RPC's path/query never leak — verified end to " +
    "end through worker.fetch for all three fetchVerdict call sites (/vd/<addr>, /vd/<addr>?probe=1, " +
    "and the report/cron pass) plus the OG-card path, which shares ogFetchVerdict with /vd/<addr>");
}

/* ---- ۲۶. حفاظِ پوشش‌ِ Base (baseVenueCovered) — لایه‌ی دوم ----
   مسئله‌ای که این حفاظ برایش ساخته شد بالای worker/index.js توضیح داده
   شده: حتی با لایه‌ی اول (SOLIDLY دیگر با صفرِ بی‌صدا اثبات نمی‌کند)، یک
   توکن که استخرهای واقعی‌اش همگی روی صرافی‌هایی هستند که VD_VENUES اصلاً
   پروب نمی‌کند (مثلِ uniswap-v4-base) هنوز ۱۶ ریوِرتِ اثباتی جمع می‌کند و
   "nosell" می‌گیرد. یک ریوِرت از صرافی‌ای که اصلاً استخر ندارد اثباتِ
   هیچ‌چیزی نیست، پس یک nosell حالا باید شاهدِ مثبتِ پوشش هم داشته باشد. */
{
  const { baseVenueCovered, GT_DEX_TO_VENUE, UPSTREAM_FREE: UF_COV } = await import("./index.js");
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);
  const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const poolsBody = (dexIds) => ({
    data: dexIds.map((id) => ({ relationships: { dex: { data: { id } } } })),
  });
  const ADDR = "0x" + "8".repeat(40);
  const savedFetch = globalThis.fetch;

  /* --- ۶) baseVenueCovered مستقیم، رویِ یک fetch جعلی --- */
  {
    const cases = [
      ["only uniswap-v4-base (a real dex, but not one VD_VENUES probes)", ["uniswap-v4-base"], false],
      ["aerodrome-slipstream (mapped to aerodrome-cl, which is covered)", ["aerodrome-slipstream"], true],
      ["aerodrome-slipstream-2 (deliberately unmapped, not a typo)", ["aerodrome-slipstream-2"], false],
    ];
    for (const [label, dexIds, want] of cases) {
      globalThis.fetch = async () => jsonRes(poolsBody(dexIds));
      const got = await baseVenueCovered(ADDR, {});
      ok(got === want, "baseVenueCovered(" + label + ") should be " + want + ", got " + got);
    }

    globalThis.fetch = async () => new Response("boom", { status: 500 });
    ok(await baseVenueCovered(ADDR, {}) === null, "a 500 from the pools endpoint must give null, never false");

    globalThis.fetch = async () => { throw new Error("network is down"); };
    ok(await baseVenueCovered(ADDR, {}) === null, "a thrown fetch must give null, never false");

    globalThis.fetch = async () => jsonRes({ notData: [] });
    ok(await baseVenueCovered(ADDR, {}) === null, "a body without a data array must give null, never false");

    // نگاشت باید دقیقاً همان هفت idِ اندازه‌گیری‌شده را داشته باشد — نه
    // بیشتر نه کمتر — و uniswap-v4-base هرگز نباید عضوش شود.
    const wantIds = ["uniswap-v3-base", "pancakeswap-v3-base", "aerodrome-slipstream",
      "aerodrome-base", "baseswap", "sushiswap-v2-base", "alien-base", "uniswap-v2-base"];
    ok(Object.keys(GT_DEX_TO_VENUE).length === wantIds.length &&
      wantIds.every((id) => id in GT_DEX_TO_VENUE),
      "GT_DEX_TO_VENUE must have exactly the measured dex ids, got " +
      JSON.stringify(Object.keys(GT_DEX_TO_VENUE)));

    // \U0001f534 هر صرافیی که پروب می‌شود باید در نگاشت هم باشد، وگرنه گاردِ پوشش
    // هرگز آن را «پوشش‌داده‌شده» نمی‌بیند و حکمِ منفی بی‌صدا غیرممکن می‌شود.
    // دقیقاً دامی که افزودنِ uniswap-v2 می‌توانست بیندازد.
    const mappedVenues = new Set(Object.values(GT_DEX_TO_VENUE));
    for (const row of vd.VD_VENUES) {
      // یک venueِ positive-only (مثلِ v4) از این قاعده مستثناست: هیچ‌وقت
      // اثباتِ منفی نمی‌دهد، پس گاردِ پوشش هرگز به دیدنش نیاز ندارد و نبودش
      // در GT_DEX_TO_VENUE عمدی است، نه سهو.
      if (vd.VD_POSITIVE_ONLY[row.kind]) continue;
      ok(mappedVenues.has(row.id),
        "venue " + row.id + " is probed but no GT dex id maps to it, so the coverage guard can never "
        + "see it and a negative verdict for it becomes silently impossible");
    }
    for (const venue of mappedVenues) {
      ok(vd.VD_VENUES.some((r) => r.id === venue),
        "GT_DEX_TO_VENUE maps a dex to " + venue + ", which is not a venue we probe");
    }
    // جهتِ برعکس: هیچ venueِ positive-only نباید هیچ‌وقت به‌عنوانِ مقدار در
    // GT_DEX_TO_VENUE ظاهر شود — وگرنه گاردِ پوشش یک ریوِرتِ حدسیِ v4 را
    // «پوشش» می‌شمرد و دقیقاً همان تله‌ای بازمی‌گردد که این جدول برایش ساخته شد.
    for (const venue of mappedVenues) {
      const row = vd.VD_VENUES.find((r) => r.id === venue);
      ok(!(row && vd.VD_POSITIVE_ONLY[row.kind]),
        "a positive-only venue (" + venue + ") must never appear as a value in GT_DEX_TO_VENUE");
    }

    // روترِ Uniswap نسخه‌ی ۲ روی Base — آدرس پین می‌شود تا یک تغییرِ
    // بی‌دقت بی‌صدا قیمتِ قراردادِ دیگری را نپرسد.
    const uniV2 = vd.VD_VENUES.find((r) => r.id === "uniswap-v2");
    ok(uniV2 && uniV2.kind === "V2",
      "uniswap-v2 must be probed as a V2-style router");
    ok(uniV2 && uniV2.to.toLowerCase() === "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
      "the uniswap-v2 router address must stay exactly the documented Base deployment, got " +
      (uniV2 && uniV2.to));

    // V4Quoter روی Base — همان الگوی پینِ آدرسِ uniswap-v2 بالا؛ یک تغییرِ
    // بی‌دقت نباید بی‌صدا قراردادِ دیگری را بپرسد.
    const uniV4 = vd.VD_VENUES.find((r) => r.id === "uniswap-v4");
    ok(uniV4 && uniV4.kind === "V4_SINGLE", "uniswap-v4 must be probed as a V4_SINGLE quoter");
    ok(uniV4 && uniV4.to.toLowerCase() === "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
      "the v4 quoter address must stay exactly the documented Base deployment, got " +
      (uniV4 && uniV4.to));

    ok(!("uniswap-v4-base" in GT_DEX_TO_VENUE),
      "uniswap-v4-base must never map to a venue — it is a different contract we do not probe");
    ok(Object.isFrozen(GT_DEX_TO_VENUE), "GT_DEX_TO_VENUE must be frozen");
  }

  /* --- ۷ و ۸) سرتاسری از رویِ worker.fetch: /vd/<addr> --- */
  const gtMetaFor = (name) => jsonRes({ data: { attributes: {
    name, symbol: "GST", total_reserve_in_usd: "1000", decimals: 18, price_usd: "1" } } });

  function allRevertFetch(poolsDexIds) {
    return async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return jsonRes(poolsBody(poolsDexIds));
      if (u.startsWith(UF_COV)) return gtMetaFor("Ghost Token");
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) } : { id: r.id, error: { code: 3 } });
      return jsonRes(body);
    };
  }

  // همه‌ی پروب‌ها رد می‌شوند، ولی استخرِ واقعی فقط روی uniswap-v4-base است
  // (پوشش‌داده‌نشده) — nosellِ خام باید به نامعلوم تنزل کند.
  const ADDR_V4 = "0x" + "9".repeat(40);
  globalThis.fetch = allRevertFetch(["uniswap-v4-base"]);
  const resV4 = await call("/vd/" + ADDR_V4, { headers: { "cf-connecting-ip": "203.0.113.201" } });
  const bodyV4 = await resV4.json();
  ok(bodyV4.v === null, "an all-revert token whose only real pool is on an unprobed dex "
    + "(uniswap-v4-base) must answer v:null, never nosell — got " + JSON.stringify(bodyV4));

  // همان دقیقاً همان پروبِ رد‌شده، ولی استخرِ واقعی روی uniswap-v3-base —
  // پوشش‌داده‌شده، پس nosellِ خام باید سرِ جایش بماند.
  const ADDR_V3 = "0x" + "a".repeat(40);
  globalThis.fetch = allRevertFetch(["uniswap-v3-base"]);
  const resV3 = await call("/vd/" + ADDR_V3, { headers: { "cf-connecting-ip": "203.0.113.202" } });
  const bodyV3 = await resV3.json();
  ok(bodyV3.v === "nosell", "the exact same all-revert probe outcome, but with the token's real pool "
    + "on a covered dex (uniswap-v3-base), must answer nosell — got " + JSON.stringify(bodyV3));

  // (۸) یک verdictِ sell هرگز نباید اندپوینتِ pools را صدا بزند — مثبت
  // هرگز از رویِ این حفاظ رد نمی‌شود.
  {
    const ADDR_SELL = "0x" + "b".repeat(40);
    let poolsCalls = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) { poolsCalls++; return jsonRes(poolsBody(["uniswap-v3-base"])); }
      if (u.startsWith(UF_COV)) return gtMetaFor("Sell Token");
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(777) : "0x" });
      return jsonRes(body);
    };
    const resSell = await call("/vd/" + ADDR_SELL, { headers: { "cf-connecting-ip": "203.0.113.203" } });
    const bodySell = await resSell.json();
    ok(bodySell.v === "sell", "sanity: this scenario should verdict sell (got " + JSON.stringify(bodySell) + ")");
    ok(poolsCalls === 0, "a sell verdict must never call the pools coverage endpoint at all, got "
      + poolsCalls + " calls");
  }

  /* --- ۹) شکستِ خودِ چکِ پوشش (۵۰۰ یا پرتاب) روی یک nosellِ خام → null --- */
  {
    const ADDR_500 = "0x" + "c".repeat(40);
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return new Response("boom", { status: 500 });
      if (u.startsWith(UF_COV)) return gtMetaFor("Fail Token");
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, error: { code: 3 } });
      return jsonRes(body);
    };
    const res500 = await call("/vd/" + ADDR_500, { headers: { "cf-connecting-ip": "203.0.113.204" } });
    const body500 = await res500.json();
    ok(body500.v === null, "a 500 from the coverage check on an otherwise-nosell token must degrade "
      + "to v:null, never nosell — got " + JSON.stringify(body500));

    const ADDR_THROW = "0x" + "d".repeat(40);
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) throw new Error("network is down");
      if (u.startsWith(UF_COV)) return gtMetaFor("Throw Token");
      const reqs = JSON.parse(init.body);
      const body = reqs.map((r) => r.id === 0 ? { id: 0, result: mkStatic4(5) } : { id: r.id, error: { code: 3 } });
      return jsonRes(body);
    };
    const resThrow = await call("/vd/" + ADDR_THROW, { headers: { "cf-connecting-ip": "203.0.113.205" } });
    const bodyThrow = await resThrow.json();
    ok(bodyThrow.v === null, "a thrown coverage check on an otherwise-nosell token must also degrade "
      + "to v:null, never nosell — got " + JSON.stringify(bodyThrow));
  }

  /* --- ۱۰) ?probe=1 خامِ verdict+covered را نگه می‌دارد، /vd همان آدرس گیت‌شده جواب می‌دهد --- */
  {
    const ADDR_DIFF = "0x" + "e".repeat(40);
    globalThis.fetch = allRevertFetch(["uniswap-v4-base"]);

    const resProbe = await call("/vd/" + ADDR_DIFF + "?probe=1", { headers: { "cf-connecting-ip": "203.0.113.206" } });
    const bodyProbe = await resProbe.json();
    ok(bodyProbe.v === "nosell", "?probe=1 must keep reporting the RAW verdict, unaffected by the "
      + "coverage gate — got " + JSON.stringify(bodyProbe));
    ok(bodyProbe.covered === false, "?probe=1 must expose the raw coverage result too — got " +
      JSON.stringify(bodyProbe));

    const resNormal = await call("/vd/" + ADDR_DIFF, { headers: { "cf-connecting-ip": "203.0.113.207" } });
    const bodyNormal = await resNormal.json();
    ok(bodyNormal.v === null, "a normal /vd on the exact same address must report the GATED verdict "
      + "(null, because coverage was false) — got " + JSON.stringify(bodyNormal));
  }

  globalThis.fetch = savedFetch;
  console.log("[base coverage gate] baseVenueCovered maps a pool's dex id through the frozen "
    + "seven-entry GT_DEX_TO_VENUE table (uniswap-v4-base and every other unmeasured id stay "
    + "absent on purpose) and is null (never false) on a non-200, a throw, or a body without a "
    + "data array; end to end through worker.fetch, an all-revert token with its only real pool "
    + "on an unprobed dex answers v:null while the identical probe outcome with a covered dex "
    + "answers nosell; a \"sell\" verdict never calls the pools endpoint at all; a failing coverage "
    + "check (500 or throw) degrades an otherwise-nosell token to null; and ?probe=1 keeps "
    + "reporting the raw verdict plus the raw \"covered\" value while a plain /vd on the same "
    + "address reports the gated one — pinned side by side so the difference is never accidental");
}

/* ---- ۲۷. worker/v4index.js — کلیدِ واقعیِ v4، از رویِ لاگِ Initialize ----
   ماژول pure است، هیچ fetchی ندارد؛ اینجا فقط خودش سنجیده می‌شود. سیم‌کشیِ
   worker/verdict.js (VD_V4_STAGE_COUNTERS/encodeV4QuoteExactInputSingleKey/
   buildProbe) و worker/index.js (rpcCallBase/readV4Keys/GET /vd/v4/<addr>)
   زیرِ همین شماره، در زیربخش‌های ۲۷.۹ به بعد، پوشش داده می‌شوند. */

const POOL_ID_A = "0x" + "11".repeat(32);
const POOL_ID_B = "0x" + "22".repeat(32);
const V4_CURR0 = "0x" + "aa".repeat(20);
const V4_CURR1 = "0x" + "bb".repeat(20);
const V4_HOOKS = "0x" + "cc".repeat(20);

function v4wNum(n) { return BigInt(n).toString(16).padStart(64, "0"); }
function v4wAddrWord(addr) { return "0".repeat(24) + String(addr).replace(/^0x/, "").toLowerCase(); }
// دو-مکملِ کاملِ ۲۵۶-بیتی برایِ -mag — دقیقاً همان‌طور که ABI یک int امضادار
// را با چپ‌چینِ بیتِ‌علامت رمز می‌کند، نه با چپ‌چینِ صفر.
function v4wNegWord(mag) { return (2n ** 256n - BigInt(mag)).toString(16).padStart(64, "0"); }

function v4BuildLog({ poolId, currency0, currency1, feeWord, tickWord, hooksWord }) {
  return {
    topics: [v4.V4_INITIALIZE_TOPIC, poolId, "0x" + v4wAddrWord(currency0), "0x" + v4wAddrWord(currency1)],
    data: "0x" + feeWord + tickWord + hooksWord + v4wNum(0) + v4wNum(0),
  };
}

/* --- ۲۷.۱ decodeInitializeLog — لاگِ خوش‌شکل --- */
{
  const log = v4BuildLog({
    poolId: POOL_ID_A, currency0: V4_CURR0, currency1: V4_CURR1,
    feeWord: v4wNum(3000), tickWord: v4wNum(60), hooksWord: v4wAddrWord(V4_HOOKS),
  });
  const key = v4.decodeInitializeLog(log, POOL_ID_A);
  ok(key !== null, "a well-formed Initialize log must decode, got null");
  ok(key && key.poolId === POOL_ID_A, "decodeInitializeLog must echo back the lowercase poolId");
  ok(key && key.currency0 === V4_CURR0.toLowerCase(), "currency0 mismatch: " + JSON.stringify(key));
  ok(key && key.currency1 === V4_CURR1.toLowerCase(), "currency1 mismatch: " + JSON.stringify(key));
  ok(key && key.fee === 3000, "fee mismatch: " + JSON.stringify(key));
  ok(key && key.tickSpacing === 60, "tickSpacing mismatch: " + JSON.stringify(key));
  ok(key && key.hooks === V4_HOOKS.toLowerCase(), "hooks (non-zero) mismatch: " + JSON.stringify(key));

  // fee = 0x800000 — پرچمِ کارمزدِ پویا، عمداً *مجاز* و ویژه‌نشده
  const logDynFee = v4BuildLog({
    poolId: POOL_ID_A, currency0: V4_CURR0, currency1: V4_CURR1,
    feeWord: v4wNum(0x800000), tickWord: v4wNum(60), hooksWord: v4wAddrWord(V4_HOOKS),
  });
  const keyDynFee = v4.decodeInitializeLog(logDynFee, POOL_ID_A);
  ok(keyDynFee !== null && keyDynFee.fee === 0x800000,
    "fee=0x800000 (dynamic-fee flag) must decode as-is, never be special-cased away, got " + JSON.stringify(keyDynFee));
}

/* --- ۲۷.۲ decodeInitializeLog — ردهای رد، هرکدام پروبِ خودش --- */
{
  const good = v4BuildLog({
    poolId: POOL_ID_A, currency0: V4_CURR0, currency1: V4_CURR1,
    feeWord: v4wNum(3000), tickWord: v4wNum(60), hooksWord: v4wAddrWord(V4_HOOKS),
  });

  ok(v4.decodeInitializeLog({ topics: good.topics.slice(0, 3), data: good.data }, POOL_ID_A) === null,
    "3 topics (a missing indexed field) must be refused");

  const wrongTopic0 = { topics: ["0x" + "0".repeat(63) + "1", ...good.topics.slice(1)], data: good.data };
  ok(v4.decodeInitializeLog(wrongTopic0, POOL_ID_A) === null,
    "a topic0 that is not the Initialize signature must be refused");

  ok(v4.decodeInitializeLog({ topics: good.topics, data: good.data.slice(0, 2 + 256) }, POOL_ID_A) === null,
    "data one word short (4 words instead of 5) must be refused");

  ok(v4.decodeInitializeLog({ topics: good.topics, data: good.data + "0".repeat(64) }, POOL_ID_A) === null,
    "data one word long (6 words instead of 5) must be refused, not truncated to fit");

  const badCurrencyWord = "01" + "0".repeat(22) + V4_CURR0.slice(2).toLowerCase();
  const badTopic2 = { topics: [good.topics[0], good.topics[1], "0x" + badCurrencyWord, good.topics[3]], data: good.data };
  ok(v4.decodeInitializeLog(badTopic2, POOL_ID_A) === null,
    "topics[2] with a non-zero byte in the upper 12 bytes must be refused, never sliced blind");

  const negTick = v4BuildLog({
    poolId: POOL_ID_A, currency0: V4_CURR0, currency1: V4_CURR1,
    feeWord: v4wNum(3000), tickWord: v4wNegWord(60), hooksWord: v4wAddrWord(V4_HOOKS),
  });
  ok(v4.decodeInitializeLog(negTick, POOL_ID_A) === null,
    "a properly two's-complement-encoded negative tickSpacing must be refused, not misread as a huge positive");

  const zeroTick = v4BuildLog({
    poolId: POOL_ID_A, currency0: V4_CURR0, currency1: V4_CURR1,
    feeWord: v4wNum(3000), tickWord: v4wNum(0), hooksWord: v4wAddrWord(V4_HOOKS),
  });
  ok(v4.decodeInitializeLog(zeroTick, POOL_ID_A) === null, "tickSpacing of exactly zero must be refused");

  const forB = v4BuildLog({
    poolId: POOL_ID_B, currency0: V4_CURR0, currency1: V4_CURR1,
    feeWord: v4wNum(3000), tickWord: v4wNum(60), hooksWord: v4wAddrWord(V4_HOOKS),
  });
  ok(v4.decodeInitializeLog(forB, POOL_ID_A) === null,
    "a log for a different pool id must be refused even if otherwise perfectly well-formed — an "
    + "endpoint that ignores the topics filter must never slip another pool's key into the store");
  ok(v4.decodeInitializeLog(forB, POOL_ID_B) !== null,
    "sanity: the exact same log must still decode fine when asked for its own pool id");
}

/* --- ۲۷.۳ estimateBlock --- */
{
  const anchor = { number: 1000000, timestampMs: 1700000000000 };
  ok(v4.estimateBlock(anchor.timestampMs - 200000, anchor) === anchor.number - 100,
    "estimateBlock arithmetic (200s back == 100 blocks back) mismatch");
  ok(v4.estimateBlock(anchor.timestampMs - 10_000_000_000, anchor) === 0,
    "estimateBlock must clamp at 0, never go negative");
  ok(v4.estimateBlock(anchor.timestampMs + 10_000_000_000, anchor) === anchor.number,
    "estimateBlock must clamp at anchor.number, never exceed it");
  ok(v4.estimateBlock(NaN, anchor) === null, "estimateBlock(NaN, anchor) must be null");
  ok(v4.estimateBlock(anchor.timestampMs, { number: Infinity, timestampMs: 0 }) === null,
    "a non-finite anchor.number must give null");
  ok(v4.estimateBlock(anchor.timestampMs, null) === null, "a missing anchor must give null");
}

/* --- ۲۷.۴ v4PoolsFromGt — از رویِ شکلِ زنده‌ی نقل‌شده در اسپک --- */
{
  const V3_ADDR_40HEX = "0x" + "9".repeat(40);
  // ⚠️ هر عددِ این پاسخِ زنده رشته است، دقیقاً مثلِ پاسخِ واقعیِ GeckoTerminal —
  // یک فیکسچر با literalِ عددی چیزی از این تبدیل نمی‌سنجید.
  const poolsFixture = [
    {
      relationships: { dex: { data: { id: "uniswap-v3-base" } } },
      attributes: { address: V3_ADDR_40HEX, pool_created_at: "2026-09-07T15:31:23Z", reserve_in_usd: "12345.6" },
    },
    {
      relationships: { dex: { data: { id: "uniswap-v4-base" } } },
      attributes: { address: POOL_ID_A, pool_created_at: "2026-09-06T10:00:00Z", reserve_in_usd: "500.0" },
    },
    {
      relationships: { dex: { data: { id: "uniswap-v4-base" } } },
      attributes: { address: POOL_ID_B, pool_created_at: "2026-09-08T10:00:00Z", reserve_in_usd: "700.0" },
    },
  ];
  const { rows, sawV4, sawId } = v4.v4PoolsFromGt(poolsFixture);
  ok(sawV4 === true && sawId === true, "a fixture with a real, well-formed v4 row must set sawV4/sawId true");
  ok(rows.length === 2, "the uniswap-v3-base row (40-hex address) must be skipped, only the two v4 rows kept, got " + rows.length);
  ok(rows[0] && rows[0].poolId === POOL_ID_B.toLowerCase(), "rows must be newest-first, got " + JSON.stringify(rows));
  ok(rows[1] && rows[1].poolId === POOL_ID_A.toLowerCase(), "rows must be newest-first, got " + JSON.stringify(rows));

  const badIdFixture = [
    { relationships: { dex: { data: { id: "uniswap-v4-base" } } },
      attributes: { address: V3_ADDR_40HEX, pool_created_at: "2026-09-07T15:31:23Z" } },
  ];
  const badId = v4.v4PoolsFromGt(badIdFixture);
  ok(badId.rows.length === 0 && badId.sawV4 === true && badId.sawId === false,
    "a v4 row with a 40-hex (contract-address-shaped) address must yield the no-pool-id path, got " + JSON.stringify(badId));

  const manyRows = [];
  for (let i = 0; i < v4.V4_MAX_POOLS + 4; i++) {
    manyRows.push({
      relationships: { dex: { data: { id: "uniswap-v4-base" } } },
      attributes: { address: "0x" + String(i).padStart(64, "0"), pool_created_at: "2026-09-0" + (1 + (i % 8)) + "T00:00:00Z" },
    });
  }
  ok(v4.v4PoolsFromGt(manyRows).rows.length === v4.V4_MAX_POOLS,
    "v4PoolsFromGt must cap at V4_MAX_POOLS, got " + v4.v4PoolsFromGt(manyRows).rows.length);

  const none = v4.v4PoolsFromGt([]);
  ok(none.rows.length === 0 && none.sawV4 === false && none.sawId === false,
    "an empty pools array must give no rows and both flags false");
}

/* --- ۲۷.۵ windowFor --- */
{
  // انکری با فاصله‌ی زیاد از تخمین تا خودِ عدد ۱۰۰۰۰۰۰، تا هیچ‌کدام از دو
  // چپ‌چین اینجا خودش را نشان ندهد — چپ‌چین‌ها زیرِ همین بخش جداگانه سنجیده می‌شوند.
  const anchor = { number: 10000000, timestampMs: 1700000000000 };
  const est = anchor.number - 100000; // ۲۰۰۰۰۰ ثانیه پیش‌تر
  const w1 = v4.windowFor(anchor.timestampMs - 200000000, anchor);
  ok(w1 && w1[0] === est - v4.V4_WINDOW_BACK && w1[1] === est + v4.V4_WINDOW_FWD,
    "windowFor arithmetic mismatch, got " + JSON.stringify(w1));

  const wGenesis = v4.windowFor(anchor.timestampMs - anchor.number * v4.V4_BLOCK_MS, anchor);
  ok(wGenesis && wGenesis[0] === 0, "windowFor must clamp its lower bound at 0, got " + JSON.stringify(wGenesis));

  const wHead = v4.windowFor(anchor.timestampMs + 10_000_000_000, anchor);
  ok(wHead && wHead[1] === anchor.number, "windowFor must clamp its upper bound at anchor.number, got " + JSON.stringify(wHead));

  ok(v4.windowFor(NaN, anchor) === null, "windowFor(NaN, anchor) must be null");
}

/* --- ۲۷.۶ getLogsParams --- */
{
  const params = v4.getLogsParams([100, 200], POOL_ID_A);
  ok(params && params.address === v4.V4_POOL_MANAGER, "getLogsParams must target the PoolManager, got " + JSON.stringify(params));
  ok(params && params.fromBlock === "0x64" && params.toBlock === "0xc8",
    "getLogsParams fromBlock/toBlock must be minimal hex, got " + JSON.stringify(params));
  ok(params && JSON.stringify(params.topics) === JSON.stringify([v4.V4_INITIALIZE_TOPIC, POOL_ID_A]),
    "getLogsParams.topics must be exactly [topic, poolId], got " + JSON.stringify(params && params.topics));

  const zero = v4.getLogsParams([0, 0], POOL_ID_A);
  ok(zero && zero.fromBlock === "0x0" && zero.toBlock === "0x0",
    "getLogsParams must give \"0x0\" for zero, never \"0x00\", got " + JSON.stringify(zero));

  ok(v4.getLogsParams([100, 200], "0xnotapoolid") === null, "a malformed pool id must give null");
  ok(v4.getLogsParams([100, 200], "0x" + "1".repeat(40)) === null,
    "a 40-hex (contract-address-shaped) pool id must give null, not be accepted as a 64-hex id");
  ok(v4.getLogsParams(null, POOL_ID_A) === null, "a missing window must give null");
}

/* --- ۲۷.۷ keyUsableFor --- */
{
  const key = { currency0: V4_CURR0.toLowerCase(), currency1: V4_CURR1.toLowerCase() };
  ok(v4.keyUsableFor(key, V4_CURR0) === V4_CURR1.toLowerCase(), "keyUsableFor must return the counter when the token is currency0");
  ok(v4.keyUsableFor(key, V4_CURR1) === V4_CURR0.toLowerCase(), "keyUsableFor must return the counter when the token is currency1");
  ok(v4.keyUsableFor(key, "0x" + "9".repeat(40)) === null, "keyUsableFor must refuse a token this key does not contain at all");
}

/* --- ۲۷.۸ mergeV4Keys --- */
{
  const k1 = { poolId: POOL_ID_A, fee: 500 };
  const k2 = { poolId: POOL_ID_B, fee: 3000 };
  const k1dup = { poolId: POOL_ID_A, fee: 999 };
  const merged = v4.mergeV4Keys([k1], [k1dup, k2]);
  ok(merged.length === 2 && merged[0] === k1 && merged[1] === k2,
    "mergeV4Keys must dedupe by poolId, keeping the EXISTING entry first, got " + JSON.stringify(merged));

  const many = [];
  for (let i = 0; i < v4.V4_MAX_KEYS + 3; i++) many.push({ poolId: "0x" + String(i).padStart(64, "0") });
  ok(v4.mergeV4Keys([], many).length === v4.V4_MAX_KEYS, "mergeV4Keys must cap at V4_MAX_KEYS");

  const existingArr = [k1];
  const foundArr = [k2];
  v4.mergeV4Keys(existingArr, foundArr);
  ok(existingArr.length === 1 && foundArr.length === 1, "mergeV4Keys must never mutate its arguments");
}

/* --- ۲۷.۹ indexV4Keys — یک پروب به‌ازای هر دلیل در V4_REASONS، به‌جز no-kv ----
   🔴 نکته‌ی اصلی: صفر پاسخِ eth_getLogs باید rpc-down بدهد، نه no-log؛ یک
   آرایه‌ی خالیِ *خوش‌شکل* باید no-log بدهد. قاطی‌کردنِ این دو دقیقاً همان
   «نمی‌دانم را مثلِ نه رفتار دادن» است که این پروژه هرگز نمی‌پذیرد. */
{
  const TOKEN_ADDR = "0x" + "44".repeat(20);
  const rpcNeverCall = async () => { throw new Error("indexV4Keys must not call rpcCall before it has a valid pool row"); };

  const rNoV4Pool = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools: [], rpcCall: rpcNeverCall, now: () => 0 });
  ok(rNoV4Pool.reason === "no-v4-pool" && rNoV4Pool.keys.length === 0,
    "no v4 dex row at all must give no-v4-pool, got " + JSON.stringify(rNoV4Pool));

  const poolsNoPoolId = [{ relationships: { dex: { data: { id: "uniswap-v4-base" } } },
    attributes: { address: "0x" + "a".repeat(40), pool_created_at: "2026-09-07T15:31:23Z" } }];
  const rNoPoolId = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools: poolsNoPoolId, rpcCall: rpcNeverCall, now: () => 0 });
  ok(rNoPoolId.reason === "no-pool-id", "a v4 row with a 40-hex address must give no-pool-id, got " + JSON.stringify(rNoPoolId));

  const poolsNoCreatedAt = [{ relationships: { dex: { data: { id: "uniswap-v4-base" } } },
    attributes: { address: POOL_ID_A, pool_created_at: "not-a-date" } }];
  const rNoCreatedAt = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools: poolsNoCreatedAt, rpcCall: rpcNeverCall, now: () => 0 });
  ok(rNoCreatedAt.reason === "no-created-at", "an id with an unparseable pool_created_at must give no-created-at, got " + JSON.stringify(rNoCreatedAt));

  const poolsValid = [{ relationships: { dex: { data: { id: "uniswap-v4-base" } } },
    attributes: { address: POOL_ID_A, pool_created_at: "2026-09-07T15:31:23Z" } }];

  const rpcNoAnchor = async (method) => {
    if (method === "eth_getBlockByNumber") return { ok: false, result: null };
    throw new Error("indexV4Keys must not attempt eth_getLogs without a valid anchor");
  };
  const rNoAnchor = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools: poolsValid, rpcCall: rpcNoAnchor, now: () => 0 });
  ok(rNoAnchor.reason === "no-anchor", "a failed eth_getBlockByNumber must give no-anchor (not rpc-down — a separate step), got " + JSON.stringify(rNoAnchor));

  function anchorResult() {
    return { ok: true, result: { number: "0x" + (1000000).toString(16), timestamp: "0x" + (1700000000).toString(16) } };
  }

  const rpcAllLogsFail = async (method) => {
    if (method === "eth_getBlockByNumber") return anchorResult();
    if (method === "eth_getLogs") return { ok: false, result: null };
    return { ok: false, result: null };
  };
  const rRpcDown = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools: poolsValid, rpcCall: rpcAllLogsFail, now: () => 0 });
  ok(rRpcDown.reason === "rpc-down" && rRpcDown.keys.length === 0,
    "every eth_getLogs call failing must give rpc-down — never stored as a miss, got " + JSON.stringify(rRpcDown));

  const rpcEmptyLogs = async (method) => {
    if (method === "eth_getBlockByNumber") return anchorResult();
    if (method === "eth_getLogs") return { ok: true, result: [] };
    return { ok: false, result: null };
  };
  const rNoLog = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools: poolsValid, rpcCall: rpcEmptyLogs, now: () => 0 });
  ok(rNoLog.reason === "no-log" && rNoLog.keys.length === 0,
    "a well-formed EMPTY eth_getLogs array must give no-log — a real proven negative, got " + JSON.stringify(rNoLog));

  const COUNTER_ADDR = "0x" + "55".repeat(20);
  const goodLog = v4BuildLog({
    poolId: POOL_ID_A, currency0: TOKEN_ADDR, currency1: COUNTER_ADDR,
    feeWord: v4wNum(500), tickWord: v4wNum(10), hooksWord: v4wAddrWord("0x0000000000000000000000000000000000000000"),
  });
  const rpcOk = async (method) => {
    if (method === "eth_getBlockByNumber") return anchorResult();
    if (method === "eth_getLogs") return { ok: true, result: [goodLog] };
    return { ok: false, result: null };
  };
  const rOk = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools: poolsValid, rpcCall: rpcOk, now: () => 0 });
  ok(rOk.reason === "ok" && rOk.keys.length === 1 && rOk.keys[0].poolId === POOL_ID_A.toLowerCase(),
    "a well-formed log carrying the token must decode into exactly one stored key, got " + JSON.stringify(rOk));

  /* گاردِ درایفت: هر عضوِ V4_REASONS باید بالا یک پروبِ اختصاصی داشته باشد،
     به‌جز دو تایی که خودِ indexV4Keys هرگز نمی‌سازد و سیم‌کشیِ
     worker/index.js می‌سازدشان — no-kv (بایندینگِ KV نیست) و no-pools
     (فهرستِ استخرها به‌دست نیامد). هر دو در ۲۷.۱۴ و ۲۷.۱۷ پوشش دارند. */
  const WIRING_ONLY_REASONS = ["no-kv", "no-pools"];
  const coveredReasons = new Set(["ok", "no-v4-pool", "no-pool-id", "no-created-at", "no-anchor", "rpc-down", "no-log"]);
  const expectedReasons = new Set(v4.V4_REASONS.filter((r) => !WIRING_ONLY_REASONS.includes(r)));
  ok(coveredReasons.size === expectedReasons.size && [...expectedReasons].every((r) => coveredReasons.has(r)),
    "every V4_REASONS entry except " + JSON.stringify(WIRING_ONLY_REASONS) +
    " must have a dedicated indexV4Keys probe above, V4_REASONS=" + JSON.stringify(v4.V4_REASONS));
}

console.log("[v4index] worker/v4index.js ok — decodeInitializeLog accepts a well-formed log (fee=0x800000 "
  + "and fee=3000 both, non-zero hooks) and refuses each malformed shape on its own probe (topic count, "
  + "topic0, data length short/long, a dirty upper-12-byte currency word, a properly two's-complement "
  + "negative tickSpacing, a zero tickSpacing, and a mismatched pool id); estimateBlock/windowFor match "
  + "hand-computed arithmetic and clamp at both ends; v4PoolsFromGt filters/caps/orders a live-shaped "
  + "(all-string) fixture and separates no-v4-pool from no-pool-id; getLogsParams filters on the exact "
  + "pool id with minimal hex bounds; mergeV4Keys dedupes/caps/never mutates; and indexV4Keys is pinned "
  + "on every V4_REASONS value except no-kv, with rpc-down (nothing answered) kept distinct from no-log "
  + "(something answered empty)");

/* --- ۲۷.۱۰ worker/verdict.js — VD_V4_STAGE_COUNTERS / VD_V4_REAL_MAX / encodeV4QuoteExactInputSingleKey --- */
{
  ok(Object.isFrozen(vd.VD_V4_STAGE_COUNTERS), "VD_V4_STAGE_COUNTERS must be frozen");
  ok(JSON.stringify(vd.VD_V4_STAGE_COUNTERS[vd.WETH_ADDR.toLowerCase()]) ===
      JSON.stringify([vd.NATIVE_ADDR, vd.WETH_ADDR]),
    "the WETH stage must accept native ETH or wrapped WETH as the counter, got " +
    JSON.stringify(vd.VD_V4_STAGE_COUNTERS[vd.WETH_ADDR.toLowerCase()]));
  ok(JSON.stringify(vd.VD_V4_STAGE_COUNTERS[vd.USDC_ADDR.toLowerCase()]) === JSON.stringify([vd.USDC_ADDR]),
    "the USDC stage must accept only USDC itself as the counter");
  ok(vd.VD_V4_REAL_MAX === 4, "VD_V4_REAL_MAX must be 4, got " + vd.VD_V4_REAL_MAX);

  const ifaceV4 = new ethers.Interface([
    "function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)"]);
  const TOKEN = "0x4444444444444444444444444444444444444444";
  const OTHER = "0x5555555555555555555555555555555555555555";
  const amt = 123n;
  const key = { currency0: TOKEN, currency1: OTHER, fee: 3000, tickSpacing: 60, hooks: V4_HOOKS };

  const gotA = vd.encodeV4QuoteExactInputSingleKey(key, TOKEN, amt); // tokenIn===currency0 -> zeroForOne=true
  const wantA = ifaceV4.encodeFunctionData("quoteExactInputSingle",
    [[[TOKEN, OTHER, 3000, 60, V4_HOOKS], true, amt, "0x"]]);
  ok(gotA === wantA, "encodeV4QuoteExactInputSingleKey mismatch (zeroForOne=true):\n  got  " + gotA + "\n  want " + wantA);

  const gotB = vd.encodeV4QuoteExactInputSingleKey(key, OTHER, amt); // tokenIn===currency1 -> zeroForOne=false
  const wantB = ifaceV4.encodeFunctionData("quoteExactInputSingle",
    [[[TOKEN, OTHER, 3000, 60, V4_HOOKS], false, amt, "0x"]]);
  ok(gotB === wantB, "encodeV4QuoteExactInputSingleKey mismatch (zeroForOne=false):\n  got  " + gotB + "\n  want " + wantB);

  ok(vd.encodeV4QuoteExactInputSingleKey(key, "0x" + "7".repeat(40), amt) === null,
    "encodeV4QuoteExactInputSingleKey must return null when tokenIn is neither currency");
  ok(vd.encodeV4QuoteExactInputSingleKey(key, TOKEN, 2n ** 128n) === null,
    "encodeV4QuoteExactInputSingleKey must return null at exactly 2**128, never mask or truncate");
  ok(vd.encodeV4QuoteExactInputSingleKey(key, TOKEN, 2n ** 128n - 1n) !== null,
    "encodeV4QuoteExactInputSingleKey must still succeed one below 2**128");

  // encodeV4QuoteExactInputSingle باید همچنان دقیقاً همان بایتِ امروز را بدهد —
  // امضای صادرشده و بایتِ خروجی نباید حتی یک بیت عوض شوند.
  const a = BigInt(TOKEN.toLowerCase()), b = BigInt(OTHER.toLowerCase());
  const c0 = a < b ? TOKEN : OTHER;
  const c1 = a < b ? OTHER : TOKEN;
  const zfo = a < b;
  const wantOld = ifaceV4.encodeFunctionData("quoteExactInputSingle",
    [[[c0, c1, 3000, 60, vd.NATIVE_ADDR], zfo, amt, "0x"]]);
  const gotOld = vd.encodeV4QuoteExactInputSingle(TOKEN, OTHER, amt, 3000, 60);
  ok(gotOld === wantOld, "encodeV4QuoteExactInputSingle must still produce today's exact bytes:\n  got  " +
    gotOld + "\n  want " + wantOld);
}

/* --- ۲۷.۱۱ buildProbe بدونِ opts — دقیقاً همان ۲۱ تای امروز، بایت‌به‌بایت ----
   فهرستِ موردانتظار از رویِ خودِ VD_VENUES ساخته می‌شود (همان الگویِ بخشِ
   ۱۲.۳)، نه یک بلابِ کپی‌شده. */
{
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const amt = 987654321n;
  const ifaceU = new ethers.Interface([
    "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
  const ifaceI = new ethers.Interface([
    "function quoteExactInputSingle((address,address,uint256,int24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
  const ifaceV2 = new ethers.Interface(["function getAmountsOut(uint256,address[]) returns (uint256[])"]);
  const ifaceSolidly = new ethers.Interface([
    "function getAmountsOut(uint256,(address,address,bool,address)[]) returns (uint256[])"]);
  const ifaceV4b = new ethers.Interface([
    "function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)"]);

  function expectedFor(outAddr) {
    const expected = [];
    for (const row of vd.VD_VENUES) {
      if (row.kind === "CL_UINT24" || row.kind === "CL_INT24") {
        const iface = row.kind === "CL_UINT24" ? ifaceU : ifaceI;
        for (const key of row.keys) {
          expected.push({ id: row.id, key, to: row.to,
            data: iface.encodeFunctionData("quoteExactInputSingle", [[TOKEN, outAddr, amt, key, 0]]) });
        }
      } else if (row.kind === "SOLIDLY") {
        for (const stable of row.keys) {
          expected.push({ id: row.id, key: stable, to: row.to,
            data: ifaceSolidly.encodeFunctionData("getAmountsOut", [amt, [[TOKEN, outAddr, stable, row.factory]]]) });
        }
      } else if (row.kind === "V2") {
        expected.push({ id: row.id, key: null, to: row.to,
          data: ifaceV2.encodeFunctionData("getAmountsOut", [amt, [TOKEN, outAddr]]) });
      } else if (row.kind === "V4_SINGLE") {
        const counter = vd.VD_V4_COUNTER[String(outAddr).toLowerCase()] || outAddr;
        const a = BigInt(TOKEN.toLowerCase()), b = BigInt(String(counter).toLowerCase());
        const currency0 = a < b ? TOKEN : counter;
        const currency1 = a < b ? counter : TOKEN;
        const zeroForOne = a < b;
        for (const [fee, tickSpacing] of row.keys) {
          const data = ifaceV4b.encodeFunctionData("quoteExactInputSingle",
            [[[currency0, currency1, fee, tickSpacing, vd.NATIVE_ADDR], zeroForOne, amt, "0x"]]);
          expected.push({ id: row.id, key: fee + ":" + tickSpacing, to: row.to, data });
        }
      }
    }
    return expected;
  }

  for (const outAddr of [vd.WETH_ADDR, vd.USDC_ADDR]) {
    const got = vd.buildProbe(TOKEN, outAddr, amt);
    const want = expectedFor(outAddr);
    ok(got.length === 21, "buildProbe with opts absent must still return exactly 21 items for stage " +
      outAddr + ", got " + got.length);
    ok(JSON.stringify(got) === JSON.stringify(want),
      "buildProbe with opts absent must be byte-for-byte identical to the pre-change output for stage " + outAddr);

    const gotEmptyKeys = vd.buildProbe(TOKEN, outAddr, amt, { v4Keys: [] });
    ok(JSON.stringify(gotEmptyKeys) === JSON.stringify(want),
      "buildProbe with an empty v4Keys array must be byte-for-byte identical to opts-absent, stage " + outAddr);
  }
}

/* --- ۲۷.۱۲ buildProbe با کلیدهای واقعی --- */
{
  const TOKEN = "0x3333333333333333333333333333333333333333";
  const amt = 42n;

  // کلیدی که ضدجفتش اترِ بومی است — باید در مرحله‌ی WETH ظاهر شود، در USDC نه.
  const keyNative = { poolId: POOL_ID_A, currency0: TOKEN.toLowerCase(), currency1: vd.NATIVE_ADDR,
    fee: 500, tickSpacing: 10, hooks: vd.NATIVE_ADDR };
  const probeWeth = vd.buildProbe(TOKEN, vd.WETH_ADDR, amt, { v4Keys: [keyNative] });
  const realWeth = probeWeth.filter((p) => typeof p.key === "string" && p.key.startsWith("real:"));
  ok(realWeth.length === 1 && realWeth[0].key === "real:500:10" && realWeth[0].id === "uniswap-v4",
    "a key whose counter is native ETH must appear on the WETH stage, got " + JSON.stringify(realWeth));

  const probeUsdc = vd.buildProbe(TOKEN, vd.USDC_ADDR, amt, { v4Keys: [keyNative] });
  ok(!probeUsdc.some((p) => typeof p.key === "string" && p.key.startsWith("real:")),
    "the same native-ETH-counter key must NOT appear on the USDC stage, got " + JSON.stringify(probeUsdc));

  // کلیدی با ضدجفتِ کاملاً نامرتبط — نه در WETH نه در USDC
  const unrelated = "0x" + "9".repeat(40);
  const keyUnrelated = { poolId: POOL_ID_B, currency0: TOKEN.toLowerCase(), currency1: unrelated,
    fee: 3000, tickSpacing: 60, hooks: vd.NATIVE_ADDR };
  const probeWeth2 = vd.buildProbe(TOKEN, vd.WETH_ADDR, amt, { v4Keys: [keyUnrelated] });
  const probeUsdc2 = vd.buildProbe(TOKEN, vd.USDC_ADDR, amt, { v4Keys: [keyUnrelated] });
  ok(!probeWeth2.some((p) => String(p.key).startsWith("real:")),
    "a key paired with an unrelated token must not appear on the WETH stage");
  ok(!probeUsdc2.some((p) => String(p.key).startsWith("real:")),
    "a key paired with an unrelated token must not appear on the USDC stage");

  // سقفِ VD_V4_REAL_MAX
  const manyKeys = [];
  for (let i = 0; i < vd.VD_V4_REAL_MAX + 3; i++) {
    manyKeys.push({ poolId: "0x" + String(i).padStart(64, "0"), currency0: TOKEN.toLowerCase(),
      currency1: vd.NATIVE_ADDR, fee: 100 + i, tickSpacing: 1 + i, hooks: vd.NATIVE_ADDR });
  }
  const probeMany = vd.buildProbe(TOKEN, vd.WETH_ADDR, amt, { v4Keys: manyKeys });
  const realMany = probeMany.filter((p) => String(p.key).startsWith("real:"));
  ok(realMany.length === vd.VD_V4_REAL_MAX,
    "real-key probes must be capped at VD_V4_REAL_MAX (" + vd.VD_V4_REAL_MAX + "), got " + realMany.length);
  ok(realMany.every((p) => p.id === "uniswap-v4"), "every appended real-key probe must carry id:\"uniswap-v4\"");
}

/* --- ۲۷.۱۳ کلیدِ واقعی هرگز حقِ اتهام نمی‌گیرد --- */
{
  ok(vd.VD_POSITIVE_ONLY.V4_SINGLE === true,
    "VD_POSITIVE_ONLY.V4_SINGLE must stay true — a real v4 key still only ever proves a positive");
  const { GT_DEX_TO_VENUE: GDV27 } = await import("./index.js");
  ok(!Object.values(GDV27).includes("uniswap-v4"),
    "uniswap-v4 must stay absent from GT_DEX_TO_VENUE's values even with real keys wired in");
}

console.log("[v4 verdict wiring] VD_V4_STAGE_COUNTERS frozen with exactly the WETH (native+wrapped) and "
  + "USDC entries; VD_V4_REAL_MAX=4; encodeV4QuoteExactInputSingleKey byte-matches ethers.Interface for a "
  + "non-zero-hooks key both ways of zeroForOne and refuses a foreign tokenIn/an amountIn at 2**128; "
  + "encodeV4QuoteExactInputSingle still emits today's exact bytes; buildProbe with opts absent (or an "
  + "empty v4Keys) is byte-for-byte the pre-change 21-item output, rebuilt from VD_VENUES, not a pasted "
  + "blob; a real key is only appended when its counter is listed for that stage, never for an unrelated "
  + "counter, capped at VD_V4_REAL_MAX and always carrying id:\"uniswap-v4\"; and VD_POSITIVE_ONLY."
  + "V4_SINGLE stays true with uniswap-v4 still absent from GT_DEX_TO_VENUE's values");

/* --- ۲۷.۱۴ worker/index.js — v4StoreTtl / storeV4Result --- */
{
  for (const r of ["no-v4-pool", "no-pool-id", "no-created-at", "no-log"]) {
    ok(v4StoreTtl(r) === v4.V4_MISS_TTL_S, "v4StoreTtl('" + r + "') must equal V4_MISS_TTL_S, got " + v4StoreTtl(r));
  }
  ok(v4StoreTtl("ok") === v4.V4_KEY_TTL_S, "v4StoreTtl('ok') must equal V4_KEY_TTL_S, got " + v4StoreTtl("ok"));
  for (const r of ["rpc-down", "no-anchor", "no-kv", "no-pools"]) {
    ok(v4StoreTtl(r) === null, "v4StoreTtl('" + r + "') must be null (never write), got " + v4StoreTtl(r));
  }

  function makeRecordingKv() {
    const store = new Map();
    const puts = [];
    return { store, puts,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v, opts) => { store.set(k, v); puts.push({ k, v, opts }); } };
  }

  const ADDR = "0x" + "6".repeat(40);
  const kvOk = makeRecordingKv();
  const storedOk = await storeV4Result(ADDR, { ZX_KV: kvOk }, { reason: "ok", keys: [{ poolId: POOL_ID_A }] });
  ok(storedOk === true && kvOk.puts.length === 1 && kvOk.puts[0].opts.expirationTtl === v4.V4_KEY_TTL_S,
    "storeV4Result('ok') must write once with V4_KEY_TTL_S, got " + JSON.stringify(kvOk.puts));

  const kvMiss = makeRecordingKv();
  const storedMiss = await storeV4Result(ADDR, { ZX_KV: kvMiss }, { reason: "no-v4-pool", keys: [] });
  ok(storedMiss === true && kvMiss.puts.length === 1 && kvMiss.puts[0].opts.expirationTtl === v4.V4_MISS_TTL_S,
    "storeV4Result('no-v4-pool') must write once with V4_MISS_TTL_S, got " + JSON.stringify(kvMiss.puts));

  const kvUnknown = makeRecordingKv();
  const storedUnknown = await storeV4Result(ADDR, { ZX_KV: kvUnknown }, { reason: "rpc-down", keys: [] });
  ok(storedUnknown === false && kvUnknown.puts.length === 0,
    "storeV4Result('rpc-down') must write NOTHING at all, got " + JSON.stringify(kvUnknown.puts));

  const kvNoAnchor = makeRecordingKv();
  const storedNoAnchor = await storeV4Result(ADDR, { ZX_KV: kvNoAnchor }, { reason: "no-anchor", keys: [] });
  ok(storedNoAnchor === false && kvNoAnchor.puts.length === 0, "storeV4Result('no-anchor') must write NOTHING at all");

  const storedNoKv = await storeV4Result(ADDR, {}, { reason: "ok", keys: [] });
  ok(storedNoKv === false, "storeV4Result without env.ZX_KV must return false, never throw");
}

/* --- ۲۷.۱۵ worker/index.js — readV4Keys / readV4Entry --- */
{
  const ADDR = "0x" + "7".repeat(40);

  ok(JSON.stringify(await readV4Keys(ADDR, {})) === "[]", "readV4Keys without env.ZX_KV must give []");
  const entryNoKv = await readV4Entry(ADDR, {});
  ok(entryNoKv.found === false && entryNoKv.keys.length === 0, "readV4Entry without env.ZX_KV must report found:false");

  function makeKvWith(raw) { return { get: async () => raw, put: async () => {} }; }

  const entryMissing = await readV4Entry(ADDR, { ZX_KV: makeKvWith(null) });
  ok(entryMissing.found === false, "readV4Entry must report found:false when nothing has ever been stored");

  const missBody = JSON.stringify({ keys: [], reason: "no-v4-pool" });
  const entryMiss = await readV4Entry(ADDR, { ZX_KV: makeKvWith(missBody) });
  ok(entryMiss.found === true && entryMiss.keys.length === 0,
    "readV4Entry must report found:true for a stored MISS — an empty-keys miss is not the same as \"never indexed\"");

  const okBody = JSON.stringify({ keys: [{ poolId: POOL_ID_A }], reason: "ok" });
  const keysOk = await readV4Keys(ADDR, { ZX_KV: makeKvWith(okBody) });
  ok(keysOk.length === 1 && keysOk[0].poolId === POOL_ID_A, "readV4Keys must return the stored keys array, got " +
    JSON.stringify(keysOk));

  const entryGarbage = await readV4Entry(ADDR, { ZX_KV: makeKvWith("not json") });
  ok(entryGarbage.found === false, "readV4Entry must degrade to found:false on unparseable KV content, never throw");
}

/* --- ۲۷.۱۶ worker/index.js — rpcCallBase: failover across V4_LOG_RPCS، هرگز URL بیرون نمی‌رود --- */
{
  const savedFetch = globalThis.fetch;
  const calledUrls = [];

  globalThis.fetch = async (u) => {
    calledUrls.push(String(u));
    if (calledUrls.length === 1) throw new Error("network down");
    if (calledUrls.length === 2) return new Response("err", { status: 500 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x1" } }), { status: 200 });
  };
  const res1 = await rpcCallBase("eth_getBlockByNumber", ["latest", false], 1000);
  ok(res1.ok === true && res1.result && res1.result.number === "0x1",
    "rpcCallBase must fail over past a thrown fetch and a 500 to the endpoint that answers, got " + JSON.stringify(res1));
  ok(calledUrls.length === 3, "rpcCallBase must have tried all three endpoints in order, tried " + calledUrls.length);
  ok(JSON.stringify(calledUrls) === JSON.stringify(v4.V4_LOG_RPCS),
    "rpcCallBase must try V4_LOG_RPCS in its own declared order, got " + JSON.stringify(calledUrls));

  calledUrls.length = 0;
  globalThis.fetch = async () => new Response("nope", { status: 502 });
  const res2 = await rpcCallBase("eth_getLogs", [{}], 1000);
  ok(res2.ok === false && res2.result === null, "rpcCallBase must give ok:false, result:null when every endpoint fails");

  globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }), { status: 200 });
  const res3 = await rpcCallBase("eth_getLogs", [{}], 1000);
  ok(res3.ok === false, "a 200-with-JSON-RPC-error body must count as a failure, never a successful result");

  globalThis.fetch = savedFetch;
}

/* --- ۲۷.۱۷ GET /vd/v4/<address> — پروبِ تشخیصی --- */
{
  const savedFetch = globalThis.fetch;
  const ADDR = "0x" + "8".repeat(40);

  function makeRecordingKv() {
    const store = new Map();
    const puts = [];
    return { store, puts,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v, opts) => { store.set(k, v); puts.push({ k, v, opts }); } };
  }

  // بدونِ ZX_KV → reason:"no-kv" و هیچ فراخوانیِ بالادستی
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; throw new Error("must not be called without ZX_KV"); };
  const resNoKv = await call("/vd/v4/" + ADDR, undefined, { ASSETS });
  const bodyNoKv = await resNoKv.json();
  ok(bodyNoKv.reason === "no-kv" && bodyNoKv.store === false && bodyNoKv.stored === false && Array.isArray(bodyNoKv.keys),
    "GET /vd/v4/<address> without ZX_KV must answer reason:no-kv, got " + JSON.stringify(bodyNoKv));
  ok(upstreamCalls === 0, "GET /vd/v4/<address> without ZX_KV must make no upstream call at all");

  // آدرسِ بدشکل → ۴۰۰، دقیقاً پیش از رسیدن به پارسِ خودِ /vd/<address>
  const resBad = await call("/vd/v4/not-an-address", undefined, { ASSETS });
  ok(resBad.status === 400, "GET /vd/v4/<bad address> must be 400, got " + resBad.status);

  // با ZX_KV: مسیرِ کاملِ ایندکس، از GT گرفته تا ذخیره
  const goodLogWire = v4BuildLog({
    poolId: POOL_ID_A, currency0: ADDR, currency1: vd.NATIVE_ADDR,
    feeWord: v4wNum(500), tickWord: v4wNum(10), hooksWord: v4wAddrWord(vd.NATIVE_ADDR),
  });
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes("/tokens/" + ADDR + "/pools")) {
      return new Response(JSON.stringify({ data: [
        { relationships: { dex: { data: { id: "uniswap-v4-base" } } },
          attributes: { address: POOL_ID_A, pool_created_at: "2026-09-07T15:31:23Z" } },
      ] }), { status: 200 });
    }
    if (v4.V4_LOG_RPCS.includes(url)) {
      const req = JSON.parse(o.body);
      if (req.method === "eth_getBlockByNumber") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
          result: { number: "0xf4240", timestamp: "0x64fc0d80" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [goodLogWire] }), { status: 200 });
    }
    throw new Error("unexpected upstream call in /vd/v4 wiring test: " + url);
  };

  const kv = makeRecordingKv();
  const resOk = await call("/vd/v4/" + ADDR, undefined, { ASSETS, ZX_KV: kv });
  ok(resOk.status === 200, "GET /vd/v4/<address> must be matched before the plain /vd/<address> address " +
    "parse (a bad-address 400 there would mean the route was never reached), got " + resOk.status);
  const bodyOk = await resOk.json();
  ok(bodyOk.reason === "ok" && Array.isArray(bodyOk.keys) && bodyOk.keys.length === 1 &&
    bodyOk.keys[0].poolId === POOL_ID_A.toLowerCase() && bodyOk.stored === true && bodyOk.store === true,
    "GET /vd/v4/<address> end to end must index and report ok with the decoded key, got " + JSON.stringify(bodyOk));
  ok(kv.puts.length === 1 && kv.puts[0].opts.expirationTtl === v4.V4_KEY_TTL_S,
    "GET /vd/v4/<address> must store the result with V4_KEY_TTL_S on ok, got " + JSON.stringify(kv.puts));

  /* 🔴 بالادستِ قیمت جواب نداد → no-pools، نه rpc-down: آن یکی یعنی آرپی‌سیِ
     زنجیره جواب نداد. یکی‌کردنشان همان «کجا ایستاد» را کور می‌کند که این
     اندپوینت برای دیدنش هست. و هیچ‌چیز ذخیره نمی‌شود — نامعلوم هرگز میس نیست.
     اگر در این حالت حتی یک تماسِ آرپی‌سی زده شود، یعنی بی‌دلیل هزینه می‌دهیم. */
  let rpcCallsOnNoPools = 0;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (v4.V4_LOG_RPCS.includes(url)) rpcCallsOnNoPools++;
    return new Response("upstream is down", { status: 502 });
  };
  const kvNoPools = makeRecordingKv();
  const resNoPools = await call("/vd/v4/" + ADDR, undefined, { ASSETS, ZX_KV: kvNoPools });
  const bodyNoPools = await resNoPools.json();
  ok(bodyNoPools.reason === "no-pools",
    "a failed GeckoTerminal pools call must answer reason:no-pools, never rpc-down (a chain-RPC failure), got "
    + JSON.stringify(bodyNoPools));
  ok(bodyNoPools.stored === false && kvNoPools.puts.length === 0,
    "reason:no-pools must write NOTHING at all — unknown is never cached as a miss, got " + JSON.stringify(kvNoPools.puts));
  ok(rpcCallsOnNoPools === 0,
    "reason:no-pools must not make a single chain-RPC call — there is nothing to look up, got " + rpcCallsOnNoPools);

  globalThis.fetch = savedFetch;
}

/* --- ۲۷.۱۸ ogFetchVerdict — سیم‌کشیِ v4Keys: ایندکس فقط وقتی هیچ ورودی نیست --- */
{
  const { ogFetchVerdict } = await import("./index.js");
  const savedFetch = globalThis.fetch;
  const savedCaches = globalThis.caches;

  function makeRecordingKv() {
    const store = new Map();
    const puts = [];
    return { store, puts,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v, opts) => { store.set(k, v); puts.push({ k, v, opts }); } };
  }
  function makeCacheShelf() {
    const shelf = new Map();
    return { default: {
      match: async (req) => { const v = shelf.get(req.url); return v ? v.clone() : undefined; },
      put: async (req, r) => { shelf.set(req.url, r); },
    } };
  }
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (amountOut) => "0x" + w(amountOut) + w(0) + w(0) + w(0);
  const meta = { decimals: 18, priceUsd: 2000 };

  // الف) هیچ ورودی‌ای برای این توکن ایندکس نشده → یک waitUntil برنامه‌ریزی
  // می‌شود؛ بعد از await آن، KV باید یک نتیجه‌ی «ok» با V4_KEY_TTL_S داشته باشد.
  globalThis.caches = makeCacheShelf();
  const ADDR1 = "0x" + "a1".repeat(20);
  const kv1 = makeRecordingKv();
  const waited1 = [];
  const ctx1 = { waitUntil: (p) => waited1.push(p) };

  const goodLogW = v4BuildLog({
    poolId: POOL_ID_A, currency0: ADDR1, currency1: vd.NATIVE_ADDR,
    feeWord: v4wNum(500), tickWord: v4wNum(10), hooksWord: v4wAddrWord(vd.NATIVE_ADDR),
  });
  // ⚠️ base.publicnode.com هم در VD_RPCS هم در V4_LOG_RPCS است (عمداً — بالای
  // V4_LOG_RPCS در v4index.js توضیح داده شده)، پس شاخه‌بندی روی خودِ URL کافی
  // نیست: باید شکلِ بدنه را سنجید — batchِ eth_call یک آرایه است، یک
  // JSON-RPCِ تکیِ rpcCallBase یک شیءِ تک با فیلدِ method.
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes("/tokens/" + ADDR1 + "/pools")) {
      return new Response(JSON.stringify({ data: [
        { relationships: { dex: { data: { id: "uniswap-v4-base" } } },
          attributes: { address: POOL_ID_A, pool_created_at: "2026-09-07T15:31:23Z" } },
      ] }), { status: 200 });
    }
    const parsed = JSON.parse(o.body);
    if (!Array.isArray(parsed) && parsed && parsed.method === "eth_getBlockByNumber") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { number: "0xf4240", timestamp: "0x64fc0d80" } }), { status: 200 });
    }
    if (!Array.isArray(parsed) && parsed && parsed.method === "eth_getLogs") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [goodLogW] }), { status: 200 });
    }
    // batchِ eth_call خودِ fetchVerdict (آرایه) — کاناری زنده، بقیه صفر → nosell/null، بدونِ نیاز به کلیدِ واقعی
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    const body = reqs.map((r) => ({ id: r.id, result: mkStatic4(r.id === 0 ? 5 : 0) }));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  await ogFetchVerdict(ADDR1, meta, Date.now() + 2000, { ZX_KV: kv1 }, ctx1);
  ok(waited1.length === 1,
    "ogFetchVerdict must schedule exactly one background index pass via ctx.waitUntil when nothing is " +
    "stored yet for this token, got " + waited1.length);
  await Promise.all(waited1);
  ok(kv1.puts.length === 1 && kv1.puts[0].opts.expirationTtl === v4.V4_KEY_TTL_S,
    "the background index pass scheduled by ogFetchVerdict must store an \"ok\" result with V4_KEY_TTL_S, " +
    "got " + JSON.stringify(kv1.puts));

  // ب) یک ورودی (حتی یک میسِ ذخیره‌شده) از قبل هست → هیچ ایندکسِ تازه‌ای
  // برنامه‌ریزی نمی‌شود و هیچ فراخوانیِ بالادستِ pools/RPCای هم نمی‌رود.
  const ADDR2 = "0x" + "b2".repeat(20);
  const kv2 = makeRecordingKv();
  kv2.store.set(v4.v4KvKey("base", ADDR2), JSON.stringify({ keys: [], reason: "no-v4-pool" }));
  const waited2 = [];
  const ctx2 = { waitUntil: (p) => waited2.push(p) };
  let upstreamHit2 = false;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes("/tokens/")) { upstreamHit2 = true; throw new Error("must not fetch pools for an already-stored entry"); }
    const parsed = JSON.parse(o.body);
    // یک تماسِ تکیِ JSON-RPC با method=eth_getBlockByNumber/eth_getLogs یعنی
    // ایندکس واقعاً دوباره اجرا شد — همان چیزی که این تست باید رد کند. یک
    // batchِ eth_call (آرایه) همان تماسِ همیشگیِ خودِ fetchVerdict است، حتی
    // وقتی میزبانش (base.publicnode.com) با V4_LOG_RPCS مشترک باشد.
    if (!Array.isArray(parsed) && parsed &&
        (parsed.method === "eth_getBlockByNumber" || parsed.method === "eth_getLogs")) {
      upstreamHit2 = true;
      throw new Error("must not re-index an already-stored entry");
    }
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    const body = reqs.map((r) => ({ id: r.id, result: mkStatic4(r.id === 0 ? 5 : 0) }));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  await ogFetchVerdict(ADDR2, meta, Date.now() + 2000, { ZX_KV: kv2 }, ctx2);
  ok(waited2.length === 0,
    "ogFetchVerdict must NOT reschedule indexing once an entry (even a stored miss) already exists, got " +
    waited2.length);
  ok(upstreamHit2 === false,
    "an already-indexed token must never re-hit the pools or RPC upstream from ogFetchVerdict");

  globalThis.fetch = savedFetch;
  if (savedCaches === undefined) delete globalThis.caches; else globalThis.caches = savedCaches;
}

/* --- ۲۷.۱۹ پنجره‌ی تکه‌ای و دو مشاهده‌گر — از دلِ اندازه‌گیریِ ۱۴ سپتامبر ----
   🔴 اندازه‌گیری نشان داد mainnet.base.org سقفِ صریحِ ۲۰۰۰ بلاکی دارد و
   base.drpc.org حتی ۵۰۰ را هم رد می‌کند (با متنِ خطایی که از ۱۰۰۰۰ حرف
   می‌زند — متنِ خطا شاهد نیست). این بخش همان درس را پین می‌کند: پنجره باید
   زیرِ سقفِ اندازه‌گیری‌شده بماند و پوششِ ازدست‌رفته با *تکه*‌ی دوم جبران
   شود، نه با گشادکردنِ دوباره‌ی پنجره. */
{
  const MEASURED_HARD_CAP = 2000; // mainnet.base.org، کدِ -32614، اندازه‌گیریِ ۱۴ سپتامبر
  const span = v4.V4_WINDOW_BACK + v4.V4_WINDOW_FWD;
  ok(span <= MEASURED_HARD_CAP,
    "the block window must stay under the measured 2000-block cap of mainnet.base.org — widen it with " +
    "another CHUNK, never with a bigger span; got " + span);

  ok(!v4.V4_LOG_RPCS.some((u) => u.includes("drpc.org")),
    "base.drpc.org must stay out of V4_LOG_RPCS — it refused a 500-block range while its error text " +
    "claimed a 10000-block limit; re-measure before putting it back, got " + JSON.stringify(v4.V4_LOG_RPCS));

  const anchor = { number: 1_000_000, timestampMs: 1_700_000_000_000 };
  const est = v4.estimateBlock(anchor.timestampMs - 200_000_000, anchor);
  const c0 = v4.windowFor(anchor.timestampMs - 200_000_000, anchor, 0);
  const c1 = v4.windowFor(anchor.timestampMs - 200_000_000, anchor, 1);
  ok(c0 && c0[0] === est - v4.V4_WINDOW_BACK && c0[1] === est + v4.V4_WINDOW_FWD,
    "chunk 0 must sit exactly around the estimate, got " + JSON.stringify(c0));
  /* 🔴 بی‌فاصله و بدونِ هم‌پوشانی: مرزهای eth_getLogs شاملِ خودشان‌اند، پس
     یک گامِ اشتباه یعنی یک بلاک دو بار پرسیده می‌شود. همین پروب همان
     off-by-one را در نسخه‌ی اولِ همین تابع گرفت. */
  ok(c1 && c1[1] === c0[0] - 1 && (c1[1] - c1[0]) === (c0[1] - c0[0]),
    "chunk 1 must be the window immediately BEFORE chunk 0 — contiguous, no overlap, same width, got " +
    JSON.stringify(c1) + " against " + JSON.stringify(c0));
  ok(v4.windowFor(anchor.timestampMs, anchor, v4.V4_WINDOW_CHUNKS) === null,
    "a chunk index at or past V4_WINDOW_CHUNKS must be null");
  ok(v4.windowFor(anchor.timestampMs, anchor, -1) === null, "a negative chunk index must be null");
  ok(v4.windowFor(anchor.timestampMs, anchor, 0.5) === null, "a non-integer chunk index must be null");

  // --- تکه‌ی دوم فقط وقتی تکه‌ی اول خالی و خوش‌شکل بود ---
  const TOKEN_ADDR = "0x" + "44".repeat(20);
  const pools = [{ relationships: { dex: { data: { id: "uniswap-v4-base" } } },
    attributes: { address: POOL_ID_A, pool_created_at: "2026-09-07T15:31:23Z" } }];
  const anchorOk = { jsonrpc: "2.0", result: { number: "0xf4240", timestamp: "0x64fc0d80" } };

  function makeRpc(logsPerCall) {
    const calls = [];
    return { calls, fn: async (method, params) => {
      if (method === "eth_getBlockByNumber") return { ok: true, result: anchorOk.result };
      calls.push(params[0]);
      return logsPerCall(calls.length - 1);
    } };
  }

  const emptyBoth = makeRpc(() => ({ ok: true, result: [] }));
  const winLog = [];
  const rEmpty = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools, rpcCall: emptyBoth.fn, now: () => 0, collect: winLog });
  ok(emptyBoth.calls.length === v4.V4_WINDOW_CHUNKS,
    "an empty well-formed first chunk must be followed by the earlier chunk, got " + emptyBoth.calls.length + " calls");
  ok(rEmpty.reason === "no-log", "both chunks answering empty must still be no-log, got " + JSON.stringify(rEmpty));
  ok(winLog.length === v4.V4_WINDOW_CHUNKS && winLog[0].chunk === 0 && winLog[1].chunk === 1 &&
     winLog[0].answered === true && winLog[0].logs === 0 &&
     typeof winLog[0].from === "number" && typeof winLog[0].to === "number",
    "the window observer must record one row per chunk with its bounds and log count, got " + JSON.stringify(winLog));

  const goodLog = v4BuildLog({
    poolId: POOL_ID_A, currency0: TOKEN_ADDR, currency1: vd.NATIVE_ADDR,
    feeWord: v4wNum(500), tickWord: v4wNum(10), hooksWord: v4wAddrWord(vd.NATIVE_ADDR),
  });
  const hitFirst = makeRpc(() => ({ ok: true, result: [goodLog] }));
  const rHit = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools, rpcCall: hitFirst.fn, now: () => 0 });
  ok(hitFirst.calls.length === 1 && rHit.reason === "ok",
    "a hit in the first chunk must not spend a second call, got " + hitFirst.calls.length + " calls / " + JSON.stringify(rHit));

  const failFirst = makeRpc(() => ({ ok: false, result: null }));
  const rFail = await v4.indexV4Keys({ tokenAddr: TOKEN_ADDR, pools, rpcCall: failFirst.fn, now: () => 0 });
  ok(failFirst.calls.length === 1 && rFail.reason === "rpc-down",
    "a REFUSED first chunk must not retry the earlier chunk (the endpoints just refused, the range is not " +
    "the question) and must stay rpc-down, got " + failFirst.calls.length + " calls / " + JSON.stringify(rFail));

  // --- مشاهده‌گرِ rpcCallBase: فقط hostname و فقط کدِ عددی ---
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes("publicnode")) return new Response("nope", { status: 403 });
    if (url.includes("tenderly")) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32614, message: "limited to a 2,000 range" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
  };
  const rpcLog = [];
  const out = await rpcCallBase("eth_getLogs", [{}], 500, rpcLog);
  ok(out.ok === true, "rpcCallBase must still succeed on the third endpoint, got " + JSON.stringify(out));
  /* بر اساسِ نامِ میزبان سنجیده می‌شود، نه جایگاه — ترتیبِ V4_LOG_RPCS یک
     تصمیمِ اندازه‌گیری‌شده است که عوض می‌شود؛ پینی که به جایگاه چسبیده باشد
     با هر بازچینیِ درست هم قرمز می‌شود و چیزی را محافظت نمی‌کند. */
  const byHost = Object.fromEntries(rpcLog.map((r) => [r.h, r]));
  ok(rpcLog.length === 3 &&
     byHost["base.publicnode.com"].stage === "status" && byHost["base.publicnode.com"].status === 403 &&
     byHost["base.gateway.tenderly.co"].stage === "rpc-error" && byHost["base.gateway.tenderly.co"].code === -32614 &&
     byHost["mainnet.base.org"].stage === "ok",
    "the rpc observer must record each attempt's stage, HTTP status and NUMERIC JSON-RPC code, got " + JSON.stringify(rpcLog));
  ok(rpcLog.every((r) => typeof r.h === "string" && !r.h.includes("://") && !r.h.includes("/")),
    "the rpc observer must record hostnames only — never a URL, which can carry a key in its path or " +
    "query, got " + JSON.stringify(rpcLog.map((r) => r.h)));

  const rpcLogAbsent = await rpcCallBase("eth_getLogs", [{}], 500);
  ok(rpcLogAbsent.ok === true, "rpcCallBase without an observer must behave exactly as before");
  globalThis.fetch = savedFetch;
}

/* --- ۲۷.۱۹ب GET /vd/<address>?probe=1 باید کلیدهای واقعی را هم بدهد ----
   🔴 این ابزار برای «کدام صرافی چه گفت» ساخته شده. اگر ورودیِ مسیرِ واقعی
   (v4Keys) را نگیرد، خروجی‌اش شبیهِ «کلیدِ واقعی پروب نشد» به‌نظر می‌رسد در
   حالی که هیچ‌چیزی درباره‌اش نمی‌گوید — و یک ابزارِ تشخیصیِ گمراه‌کننده از
   نبودنش بدتر است. این دقیقاً روی سایتِ زنده اتفاق افتاد. */
{
  const savedFetch = globalThis.fetch;
  const ADDR = "0x" + "5".repeat(40);
  const stored = [{
    poolId: POOL_ID_A,
    currency0: ADDR.toLowerCase(),
    currency1: vd.WETH_ADDR.toLowerCase(),
    fee: 100, tickSpacing: 1, hooks: vd.NATIVE_ADDR,
  }];
  const kv = { store: new Map([[
    "v4key:base:" + ADDR.toLowerCase(), JSON.stringify({ keys: stored, reason: "ok" }),
  ]]),
    get: async (k) => (kv.store.has(k) ? kv.store.get(k) : null),
    put: async () => {} };

  const seen = [];
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes("/tokens/")) {
      return new Response(JSON.stringify({ data: { attributes: {
        address: ADDR, symbol: "T", name: "T", decimals: 18, price_usd: "1.0",
      } } }), { status: 200 });
    }
    if (url.includes("/pools")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    // هر آرپی‌سیِ Base: همه‌ی آیتم‌ها ریوِرت، کاناری سالم — فقط شکلِ درخواست مهم است
    const reqs = JSON.parse(o.body);
    reqs.forEach((r) => { if (r.params && r.params[0]) seen.push(r.params[0].data); });
    return new Response(JSON.stringify(reqs.map((r, i) => (i === 0
      ? { id: 0, result: "0x" + "0".repeat(63) + "1" + "0".repeat(192) }
      : { id: r.id, error: { code: 3, message: "execution reverted" } }))), { status: 200 });
  };

  const res = await call("/vd/" + ADDR + "?probe=1", undefined, { ASSETS, ZX_KV: kv });
  const body = await res.json();
  ok(body.v4Keys === 1,
    "?probe=1 must report how many stored real keys it was given — \"none stored\" and \"stored but " +
    "never probed\" look identical from outside without it, got " + JSON.stringify(body.v4Keys));
  const realRows = (body.venues || []).filter((r) => typeof r.key === "string" && r.key.startsWith("real:"));
  ok(realRows.length > 0,
    "?probe=1 must probe the stored real keys too — without them this tool cannot see the very row it " +
    "exists to explain, got venues=" + JSON.stringify((body.venues || []).map((r) => r.key)));
  globalThis.fetch = savedFetch;
}

/* --- ۲۷.۲۰ GET /vd/v4/<address>?debug=1 --- */
{
  const savedFetch = globalThis.fetch;
  const ADDR = "0x" + "7".repeat(40);
  const kv = { store: new Map(), puts: [],
    get: async (k) => (kv.store.has(k) ? kv.store.get(k) : null),
    put: async (k, v, o) => { kv.store.set(k, v); kv.puts.push({ k, v, o }); } };

  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes("/tokens/" + ADDR + "/pools")) {
      return new Response(JSON.stringify({ data: [
        { relationships: { dex: { data: { id: "uniswap-v4-base" } } },
          attributes: { address: POOL_ID_A, pool_created_at: "2026-09-07T15:31:23Z" } },
      ] }), { status: 200 });
    }
    /* انکر عمداً جواب می‌دهد و فقط eth_getLogs بلاک می‌شود — دقیقاً همان
       چیزی که سایتِ زنده نشان داد: reason=rpc-down در حالی که خودِ آرپی‌سی
       در دسترس بود. اگر انکر هم بلاک شود، دلیل no-anchor می‌شود و این پروب
       اصلاً به لاگِ getLogs نمی‌رسد. */
    if (v4.V4_LOG_RPCS.includes(url)) {
      const req = JSON.parse(o && o.body ? o.body : "{}");
      if (req.method === "eth_getBlockByNumber") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
          result: { number: "0xf4240", timestamp: "0x64fc0d80" } }), { status: 200 });
      }
      return new Response("blocked", { status: 403 });
    }
    throw new Error("unexpected upstream call in /vd/v4 debug test: " + url);
  };

  const resPlain = await call("/vd/v4/" + ADDR, undefined, { ASSETS, ZX_KV: kv });
  const bodyPlain = await resPlain.json();
  ok(bodyPlain.reason === "rpc-down" && bodyPlain.rpc === undefined && bodyPlain.windows === undefined,
    "without ?debug=1 the response shape must stay exactly what it was, got " + JSON.stringify(bodyPlain));

  const resDebug = await call("/vd/v4/" + ADDR + "?debug=1", undefined, { ASSETS, ZX_KV: kv });
  const bodyDebug = await resDebug.json();
  ok(bodyDebug.reason === "rpc-down" && Array.isArray(bodyDebug.rpc) && bodyDebug.rpc.length > 0,
    "?debug=1 must report every endpoint attempt — that is the whole point of it, got " + JSON.stringify(bodyDebug));
  ok(bodyDebug.rpc.every((r) => !String(r.h).includes("://")),
    "?debug=1 must never print a URL, got " + JSON.stringify(bodyDebug.rpc));
  ok(bodyDebug.rpc.some((r) => r.m === "eth_getBlockByNumber") === false ||
     bodyDebug.rpc.every((r) => typeof r.status === "number"),
    "every recorded attempt must carry a numeric status");
  ok(kv.puts.length === 0, "?debug=1 must not change the never-store rule for rpc-down, got " + JSON.stringify(kv.puts));

  globalThis.fetch = savedFetch;
}

console.log("[v4 window+debug] the block window stays under the measured 2000-block cap and widens by " +
  "CHUNK not by span; base.drpc.org is kept out (it refused 500 blocks while its error text claimed " +
  "10000); chunk 1 is the contiguous earlier window and is tried only when chunk 0 answered empty, never " +
  "when it was refused; and both observers (rpcCallBase attempts, indexV4Keys windows) are pure add-ons " +
  "that record hostnames and numeric codes only, surfacing through GET /vd/v4/<address>?debug=1 without " +
  "changing the plain response shape or the never-store rule");

console.log("[v4 index wiring] worker/index.js ok — v4StoreTtl/storeV4Result follow the ok/miss/never-write " +
  "rule exactly (ok->V4_KEY_TTL_S, no-v4-pool/no-pool-id/no-created-at/no-log->V4_MISS_TTL_S, rpc-down/" +
  "no-anchor/no-kv->nothing written); readV4Entry tells \"never indexed\" (found:false) apart from a " +
  "stored empty-keys miss (found:true); rpcCallBase fails over across V4_LOG_RPCS in order (a throw, a " +
  "500, and a 200-with-JSON-RPC-error all count as failure) and gives ok:false only once every endpoint " +
  "is exhausted; GET /vd/v4/<address> is matched before the plain /vd/<address> parse, answers no-kv " +
  "with zero upstream calls when unbound, 400s a bad address, and end to end indexes+stores a real key; " +
  "and ogFetchVerdict schedules exactly one background index pass via ctx.waitUntil only when nothing is " +
  "stored yet, never again once an entry (even a miss) exists");

/* ---- ۲۷ب. worker/index.js — v4PoolsEmpty و علتِ «empty-pool» رویِ یک nosell ----
   اندازه‌گیریِ ۲۰ شهریور بالای همین فایل: از ۹ nosellِ امروز، ۷ تا استخری
   بودند که نقدینگی‌اش ۱ تا ۵ دقیقه پیش از چکِ ما کشیده شده بود (اثبات از
   رویِ رخدادهای ModifyLiquidity زنجیره‌ی PoolManager)، و ۲ تا هنوز نقدینگی
   داشتند. StateView.getLiquidity(poolId) این دو دسته را بی‌نقص جدا می‌کند:
   صفر برای همان ۷ تا، غیرصفر برای آن ۲ تا. اینجا همان شاهد، از رویِ یک
   worker.fetch("/vd/<addr>") واقعی، سنجیده می‌شود — نه فقط تابعِ خام. */
{
  const { UPSTREAM_FREE: UF_C9 } = await import("./index.js");
  const w9 = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4_9 = (n) => "0x" + w9(n) + w9(0) + w9(0) + w9(0);
  const jsonRes9 = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const poolsBody9 = (dexIds) => ({
    data: dexIds.map((id) => ({ relationships: { dex: { data: { id } } } })),
  });
  const gtMetaFor9 = (name) => jsonRes9({ data: { attributes: {
    name, symbol: "GST", total_reserve_in_usd: "1000", decimals: 18, price_usd: "1" } } });

  const PID1 = "0x" + "aa".repeat(32);
  const PID2 = "0x" + "bb".repeat(32);
  const kvWith = (keys) => ({ get: async () => JSON.stringify({ keys, reason: "ok" }), put: async () => {} });

  /* یک fetchِ جعلیِ عمومی برای این بخش: /pools یک استخرِ پوشش‌داده‌شده
     می‌دهد، متادیتا برمی‌گردد، پروبِ صرافی‌ها همه‌جا ریوِرت می‌کند (nosellِ
     خام)، و eth_call رویِ هر poolId از رویِ liqByPoolId جواب می‌دهد —
     null یعنی خودِ پاسخ ناخواندنی (۵۰۰) باشد.
     ⚠️ فقط بدنه‌ی تکیِ JSON-RPC (نه آرایه‌ی batch پروبِ صرافی‌ها) را
     eth_call می‌شمارد — دقیقاً همان چیزی که rpcCallBase/v4PoolsEmpty
     می‌سازد، برخلافِ آرایه‌ای که fetchVerdict برای batch می‌فرستد. */
  function makeFetch9(liqByPoolId, ethCallsOut) {
    return async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return jsonRes9(poolsBody9(["uniswap-v3-base"]));
      if (u.startsWith(UF_C9)) return gtMetaFor9("Empty Pool Token");
      const parsed = JSON.parse(init.body);
      if (Array.isArray(parsed)) {
        return jsonRes9(parsed.map((r) => r.id === 0
          ? { id: 0, result: mkStatic4_9(5) } : { id: r.id, error: { code: 3 } }));
      }
      if (parsed.method === "eth_call") {
        if (ethCallsOut) ethCallsOut.push({ to: parsed.params[0].to, data: parsed.params[0].data });
        const poolId = "0x" + parsed.params[0].data.slice(10);
        const has = Object.prototype.hasOwnProperty.call(liqByPoolId, poolId);
        const liq = has ? liqByPoolId[poolId] : undefined;
        if (liq === null || liq === undefined) return new Response("boom", { status: 500 });
        return jsonRes9({ jsonrpc: "2.0", id: parsed.id, result: "0x" + BigInt(liq).toString(16).padStart(64, "0") });
      }
      return new Response("unexpected rpc call in this section: " + JSON.stringify(parsed), { status: 500 });
    };
  }

  const savedFetch = globalThis.fetch;

  // (۱) هر دو کلیدِ واقعی صفر → cause:"empty-pool"، و خودِ eth_call با
  // calldataِ V4_GET_LIQUIDITY_SEL+poolId به V4_STATE_VIEW رفته است.
  {
    const ADDR = "0x" + "51".repeat(20);
    const ethCalls = [];
    globalThis.fetch = makeFetch9({ [PID1]: 0n, [PID2]: 0n }, ethCalls);
    const res = await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": "203.0.113.221" } },
      { ASSETS, ZX_KV: kvWith([{ poolId: PID1 }, { poolId: PID2 }]) });
    const body = await res.json();
    ok(body.v === "nosell" && body.cause === "empty-pool",
      "every v4 key reporting zero liquidity must yield {v:nosell,cause:empty-pool} on /vd, got " +
      JSON.stringify(body));
    ok(ethCalls.length === 2 && ethCalls.every((c) => c.to.toLowerCase() === V4_STATE_VIEW.toLowerCase()),
      "v4PoolsEmpty must eth_call V4_STATE_VIEW for every real key, got " + JSON.stringify(ethCalls));
    ok(ethCalls.every((c) => c.data === V4_GET_LIQUIDITY_SEL + PID1.slice(2) ||
      c.data === V4_GET_LIQUIDITY_SEL + PID2.slice(2)),
      "the eth_call data must be V4_GET_LIQUIDITY_SEL followed by the poolId's own 32 bytes, got " +
      JSON.stringify(ethCalls));
  }
  console.log("[v4 empty-pool cause] a nosell whose every real v4 key reads zero on live " +
    "StateView.getLiquidity gets cause:\"empty-pool\" from /vd/<addr>; the eth_call itself is verified " +
    "against the intercepted JSON-RPC request to go to V4_STATE_VIEW with V4_GET_LIQUIDITY_SEL+poolId " +
    "as calldata");

  // (۲) یک کلیدِ پرنقدینگی کافی است — هیچ cause‌ای در پاسخ نباشد.
  {
    const ADDR = "0x" + "52".repeat(20);
    globalThis.fetch = makeFetch9({ [PID1]: 777n, [PID2]: 0n });
    const res = await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": "203.0.113.222" } },
      { ASSETS, ZX_KV: kvWith([{ poolId: PID1 }, { poolId: PID2 }]) });
    const body = await res.json();
    ok(body.v === "nosell", "sanity: this scenario must still verdict nosell, got " + JSON.stringify(body));
    ok(!("cause" in body), "one non-zero v4 key must leave the /vd response with no \"cause\" key at all, got " +
      JSON.stringify(body));
  }
  console.log("[v4 empty-pool cause] one real v4 key reading non-zero liquidity leaves /vd with no " +
    "\"cause\" key at all — liquidity present is never reported as the empty-pool story");

  // (۳) خودِ RPC ناخواندنی (۵۰۰، یا نتیجه‌ی غیرِهگزادسیمال) → هیچ cause‌ای —
  // کنترلِ مثبت: «نتوانستیم بپرسیم» هرگز به یک ادعا تبدیل نمی‌شود.
  {
    const ADDR = "0x" + "53".repeat(20);
    globalThis.fetch = makeFetch9({ [PID1]: null });
    const res500 = await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": "203.0.113.223" } },
      { ASSETS, ZX_KV: kvWith([{ poolId: PID1 }]) });
    const body500 = await res500.json();
    ok(body500.v === "nosell" && !("cause" in body500),
      "a 500 answering the eth_call itself must leave /vd with no cause key, got " + JSON.stringify(body500));

    const ADDR2 = "0x" + "54".repeat(20);
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return jsonRes9(poolsBody9(["uniswap-v3-base"]));
      if (u.startsWith(UF_C9)) return gtMetaFor9("Bad Hex Token");
      const parsed = JSON.parse(init.body);
      if (Array.isArray(parsed)) {
        return jsonRes9(parsed.map((r) => r.id === 0
          ? { id: 0, result: mkStatic4_9(5) } : { id: r.id, error: { code: 3 } }));
      }
      return jsonRes9({ jsonrpc: "2.0", id: parsed.id, result: "not-hex" }); // نتیجه‌ی غیرِهگزادسیمال
    };
    const resBad = await call("/vd/" + ADDR2, { headers: { "cf-connecting-ip": "203.0.113.224" } },
      { ASSETS, ZX_KV: kvWith([{ poolId: PID1 }]) });
    const bodyBad = await resBad.json();
    ok(bodyBad.v === "nosell" && !("cause" in bodyBad),
      "a non-0x-hex eth_call result must leave /vd with no cause key, got " + JSON.stringify(bodyBad));

    // هیچ کلیدِ واقعی‌ای ذخیره نشده — v4PoolsEmpty حتی نباید یک eth_call هم بزند.
    const ADDR3 = "0x" + "5c".repeat(20);
    const ethCallsEmpty = [];
    globalThis.fetch = makeFetch9({}, ethCallsEmpty);
    const resEmpty = await call("/vd/" + ADDR3, { headers: { "cf-connecting-ip": "203.0.113.227" } },
      { ASSETS, ZX_KV: kvWith([]) });
    const bodyEmpty = await resEmpty.json();
    ok(bodyEmpty.v === "nosell" && !("cause" in bodyEmpty),
      "an empty stored v4 key list must leave /vd with no cause key, got " + JSON.stringify(bodyEmpty));
    ok(ethCallsEmpty.length === 0,
      "an empty stored v4 key list must never even attempt an eth_call, got " + ethCallsEmpty.length);

    /* بودجه‌ی زمانی — یک توضیح هرگز نباید جوابِ اصلی را دیر کند. با
       deadlineAtِ گذشته، v4PoolsEmpty باید بدونِ هیچ eth_callی نامعلوم
       بدهد؛ و کنترلِ مثبت: با بودجه‌ی کافی همان ورودی جواب می‌دهد. */
    const ethCallsLate = [];
    globalThis.fetch = makeFetch9({ [PID1]: 0n }, ethCallsLate);
    const envBudget = { ASSETS, ZX_KV: kvWith([{ poolId: PID1 }]) };
    const lateVal = await v4PoolsEmpty(ADDR2, envBudget, Date.now() - 1);
    ok(lateVal === null,
      "an exhausted budget must read as unknown, got " + JSON.stringify(lateVal));
    ok(ethCallsLate.length === 0,
      "an exhausted budget must not spend an eth_call, got " + ethCallsLate.length);
    const roomyVal = await v4PoolsEmpty(ADDR2, envBudget, Date.now() + 5000);
    ok(roomyVal === true,
      "the same input with budget left must still witness the empty pool, got " + JSON.stringify(roomyVal));
    ok(ethCallsLate.length === 1,
      "the budgeted control must spend exactly one eth_call, got " + ethCallsLate.length);
  }
  console.log("[v4 empty-pool budget] the explanation is skipped, not guessed, when the caller's deadline " +
    "is spent: no eth_call and no cause — with a positive control on the same input");
  console.log("[v4 empty-pool cause] an unreadable RPC answer (a 500, or a non-hex result) never becomes " +
    "a cause — \"could not ask\" stays absent, the positive control for the empty-pool claim");

  // (۴) یک حکمِ sell و یک حکمِ null: شکلِ /vd بایت‌به‌بایت مثلِ قبل، بدونِ
  // cause، و v4PoolsEmpty اصلاً صدا زده نمی‌شود — با شمارشِ خودِ eth_callها.
  {
    let ethCallCount = 0;
    function countingWrap(inner) {
      return async (url, init) => {
        try {
          const parsed = init && init.body ? JSON.parse(init.body) : null;
          if (parsed && !Array.isArray(parsed) && parsed.method === "eth_call") ethCallCount++;
        } catch (e) { /* بدنه‌ی غیرِJSON، اهمیتی ندارد */ }
        return inner(url, init);
      };
    }

    const ADDR_SELL = "0x" + "55".repeat(20);
    globalThis.fetch = countingWrap(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return jsonRes9(poolsBody9(["uniswap-v3-base"]));
      if (u.startsWith(UF_C9)) return gtMetaFor9("Sell Token C9");
      const reqs = JSON.parse(init.body);
      return jsonRes9(reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4_9(5) }
        : { id: r.id, result: r.id === 1 ? mkStatic4_9(777) : "0x" }));
    });
    const resSell = await call("/vd/" + ADDR_SELL, { headers: { "cf-connecting-ip": "203.0.113.225" } },
      { ASSETS, ZX_KV: kvWith([{ poolId: PID1 }]) });
    const bodySell = await resSell.json();
    ok(bodySell.v === "sell" && JSON.stringify(Object.keys(bodySell).sort()) === JSON.stringify(["ms", "v"]),
      "a sell verdict's /vd response must keep today's exact shape (only v, ms), got " + JSON.stringify(bodySell));

    const ADDR_NULL = "0x" + "56".repeat(20);
    globalThis.fetch = countingWrap(async () => new Response("boom", { status: 500 }));
    const resNull = await call("/vd/" + ADDR_NULL, { headers: { "cf-connecting-ip": "203.0.113.226" } },
      { ASSETS, ZX_KV: kvWith([{ poolId: PID1 }]) });
    const bodyNull = await resNull.json();
    ok(bodyNull.v === null && !("cause" in bodyNull),
      "a null verdict must keep today's /vd shape, no cause key, got " + JSON.stringify(bodyNull));

    ok(ethCallCount === 0,
      "v4PoolsEmpty must never be reached on a sell or a null verdict, eth_call attempts=" + ethCallCount);
  }
  console.log("[v4 empty-pool cause] a \"sell\" verdict and a null verdict keep today's /vd shape byte-" +
    "for-byte (no cause key at all, why unaffected) and never reach v4PoolsEmpty — proven by counting " +
    "eth_call attempts, not just by reading the response");

  globalThis.fetch = savedFetch;
}

/* ---- ۲۷ج. worker/report.js — causeForRow، ردیف، و متنِ گزارش ----
   دقیقاً همان انضباطِ whyForRow: فقط verdict==="nosell" و فقط رشته‌ای عضوِ
   REPORT_CAUSES از این تابع زنده بیرون می‌آید؛ هر چیزِ دیگر undefined است،
   نه null و نه یک رشته‌ی دست‌ساز. */
{
  ok(causeForRow("nosell", "empty-pool") === "empty-pool",
    "causeForRow must let \"empty-pool\" survive on a nosell row");
  ok(causeForRow("sell", "empty-pool") === undefined,
    "causeForRow must drop \"empty-pool\" on a sell row (a cause on a positive verdict is a fabricated claim)");
  ok(causeForRow(null, "empty-pool") === undefined,
    "causeForRow must drop \"empty-pool\" on a null verdict row");
  ok(causeForRow("nosell", "made-up-cause") === undefined,
    "causeForRow must drop any string not in REPORT_CAUSES, even on a nosell row");
  ok(causeForRow("nosell", undefined) === undefined && causeForRow("nosell", null) === undefined,
    "causeForRow must give undefined (not null) for an absent cause");
  ok(JSON.stringify(REPORT_CAUSES) === JSON.stringify(["empty-pool"]) && Object.isFrozen(REPORT_CAUSES),
    "REPORT_CAUSES must be the frozen one-member closed vocabulary, got " + JSON.stringify(REPORT_CAUSES));

  const T9 = "2026-09-20T00:00:00.000Z";
  function rowArgs(extra) {
    return Object.assign({ chain: "base", address: "0x" + "9".repeat(40), symbol: "T9", name: "T9",
      verdict: "nosell", checkedAt: T9, poolCreatedAt: null, priceUsd: 1, reserveUsd: 1, vol24hUsd: 1,
      fdvUsd: 1, dex: "uniswap-v3-base", why: null }, extra);
  }
  const rowWithCause = reportRow(rowArgs({ cause: "empty-pool" }));
  ok(rowWithCause && rowWithCause.cause === "empty-pool",
    "reportRow must carry cause:\"empty-pool\" through on a nosell row, got " + JSON.stringify(rowWithCause));

  const rowNoCause = reportRow(rowArgs({}));
  ok(rowNoCause && !("cause" in rowNoCause),
    "reportRow must OMIT the cause key entirely when there is none, not store null — got " +
    JSON.stringify(rowNoCause));

  const rowSellCause = reportRow(rowArgs({ verdict: "sell", cause: "empty-pool" }));
  ok(rowSellCause && !("cause" in rowSellCause),
    "reportRow must never let a cause survive on a sell verdict, got " + JSON.stringify(rowSellCause));

  const rowJunkCause = reportRow(rowArgs({ cause: "made-up" }));
  ok(rowJunkCause && !("cause" in rowJunkCause),
    "reportRow must drop an unknown cause string even on a nosell row, got " + JSON.stringify(rowJunkCause));

  function docWith(rows) {
    return { date: "2026-09-20", generatedAt: T9, chains: ["base"], checked: rows.length, rows };
  }
  const rowPlainNoSell = reportRow(rowArgs({ address: "0x" + "8".repeat(40), symbol: "T8" }));
  const textWithCause = reportText(docWith([rowWithCause]));
  const textNoCause = reportText(docWith([rowPlainNoSell]));
  ok(typeof textWithCause === "string" && textWithCause.includes("$T9 — no sell route quoted · pool is empty"),
    "reportText must append \" · pool is empty\" to a row whose cause is empty-pool, got " +
    JSON.stringify(textWithCause));
  ok(typeof textNoCause === "string" && textNoCause.includes("$T8 — no sell route quoted") &&
    !textNoCause.includes("pool is empty"),
    "reportText must leave a causeless row's line byte-for-byte as today's, got " + JSON.stringify(textNoCause));

  // یک سندِ بدونِ هیچ causeای باید بایت‌به‌بایت همان چیزی بماند که پیش از
  // این تغییر بود — هیچ ستون/فاصله‌ای در ردیف‌های دیگر عوض نشود.
  // ⚠️ خطِ سرتیترِ «Exit Report · <date>» خودش همیشه یک «·» دارد — پس این
  // چک فقط دنبالِ پسوندِ مشخصِ « · pool is empty» است، نه هر «·»ای.
  const docNoCauses = docWith([
    reportRow(rowArgs({ address: "0x" + "7".repeat(40), symbol: "T7", verdict: "sell", why: null })),
    reportRow(rowArgs({ address: "0x" + "6".repeat(40), symbol: "T6", verdict: null, why: "internal" })),
    reportRow(rowArgs({ address: "0x" + "5".repeat(40), symbol: "T5" })), // nosell, no cause
  ]);
  const textNoCauses = reportText(docNoCauses);
  ok(typeof textNoCauses === "string" && !textNoCauses.includes(" · pool is empty"),
    "a document with no causes anywhere must render with no \" · pool is empty\" suffix at all, got " +
    JSON.stringify(textNoCauses));
}
console.log("[report cause] causeForRow enforces the closed REPORT_CAUSES vocabulary exactly like " +
  "whyForRow does for why (nosell+empty-pool survives; the same string on sell/null is dropped; an " +
  "unknown string on nosell is dropped); reportRow OMITS the cause key entirely when there is none " +
  "(undefined, never a stored null) so today's documents stay comparable; and reportText appends " +
  "\" · pool is empty\" only to a surviving empty-pool row, leaving every causeless row's line " +
  "byte-for-byte unchanged");

/* ---- ۲۷د. applyFollowUps — یک فالوآپِ افزایشی روی یک ردیفِ sell ----
   دقیقاً همان چیزی که queue item 17 خواسته: پیگیریِ یک‌ساعته‌ی هر ردیفِ
   "sell"، بدونِ لمسِ هیچ کلیدِ دیگری و بدونِ جهش‌دادنِ سندِ ورودی. */
{
  ok(JSON.stringify(REPORT_FOLLOWS) === JSON.stringify(["pool-empty", "pool-there"]) &&
     Object.isFrozen(REPORT_FOLLOWS),
     "REPORT_FOLLOWS must be the frozen two-member closed vocabulary, got " + JSON.stringify(REPORT_FOLLOWS));
  ok(followForRow("sell", "pool-empty") === "pool-empty" && followForRow("sell", "pool-there") === "pool-there",
     "followForRow must let both REPORT_FOLLOWS members survive on a sell row");
  ok(followForRow("nosell", "pool-empty") === undefined,
     "followForRow must drop \"pool-empty\" on a nosell row");
  ok(followForRow(null, "pool-empty") === undefined,
     "followForRow must drop \"pool-empty\" on a null-verdict row");
  ok(followForRow("sell", "made-up") === undefined,
     "followForRow must drop any string not in REPORT_FOLLOWS, even on a sell row");

  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  const T1 = "2026-09-20T10:00:00.000Z";
  function followRow(addr, v, extra) {
    return Object.assign({
      chain: "base", address: addr, symbol: "S", name: "N", v, checkKind: "sell-quote",
      checkedAt: T1, poolCreatedAt: null, priceUsd: 1, reserveUsd: 2, vol24hUsd: 3, fdvUsd: 4,
      dex: "uniswap-v4-base", why: null,
    }, extra);
  }
  const rowA = followRow(mkAddr(1), "sell");
  const rowB = followRow(mkAddr(2), "sell");
  const rowC = followRow(mkAddr(3), "nosell", { cause: "empty-pool" });
  const origDoc = { date: "2026-09-20", generatedAt: T1, chains: ["base"], checked: 3, rows: [rowA, rowB, rowC] };
  const origSnapshot = JSON.stringify(origDoc);

  const atIso = "2026-09-20T11:00:00.000Z";
  const updated = applyFollowUps(origDoc, [{ address: mkAddr(1), follow: "pool-empty" }], atIso);

  ok(updated.rows[0].follow === "pool-empty" && updated.rows[0].followAt === atIso,
     "applyFollowUps must add follow+followAt to the matching sell row, got " + JSON.stringify(updated.rows[0]));
  const { follow: f0, followAt: fa0, ...restRow0 } = updated.rows[0];
  ok(JSON.stringify(restRow0) === JSON.stringify(rowA),
     "every other key of the marked row must stay byte-for-byte identical, got " + JSON.stringify(restRow0));
  ok(JSON.stringify(updated.rows[1]) === JSON.stringify(rowB) &&
     JSON.stringify(updated.rows[2]) === JSON.stringify(rowC),
     "every untouched row must stay byte-for-byte identical, got " +
     JSON.stringify([updated.rows[1], updated.rows[2]]));
  ok(updated.rows.map((r) => r.address).join(",") === [rowA, rowB, rowC].map((r) => r.address).join(","),
     "applyFollowUps must never reorder rows, got " + JSON.stringify(updated.rows.map((r) => r.address)));
  ok(updated.date === origDoc.date && updated.generatedAt === origDoc.generatedAt &&
     updated.checked === origDoc.checked && JSON.stringify(updated.chains) === JSON.stringify(origDoc.chains),
     "date/chains/checked/generatedAt must stay exactly as they were");
  ok(JSON.stringify(origDoc) === origSnapshot,
     "applyFollowUps must never mutate its input doc, got a changed original: " + JSON.stringify(origDoc));

  console.log("[report follow apply] applyFollowUps marks exactly the matching \"sell\" row with " +
    "follow+followAt, leaves every other key of every row byte-for-byte identical, never reorders rows, " +
    "keeps date/chains/checked/generatedAt untouched, and never mutates its input doc; followForRow " +
    "enforces the frozen REPORT_FOLLOWS vocabulary exactly like causeForRow does for REPORT_CAUSES");
}

/* ---- ۲۷ه. applyFollowUps — رد کردنِ هر موردِ نامعتبر ----
   شش سناریو، هرکدام باید کلِ سند را دست‌نخورده برگرداند. */
{
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  const T2 = "2026-09-20T10:00:00.000Z";
  function row(addr, v, extra) {
    return Object.assign({
      chain: "base", address: addr, symbol: "S", name: "N", v, checkKind: "sell-quote",
      checkedAt: T2, poolCreatedAt: null, priceUsd: 1, reserveUsd: 2, vol24hUsd: 3, fdvUsd: 4,
      dex: "uniswap-v4-base", why: null,
    }, extra);
  }
  function freshDoc(r) {
    return { date: "2026-09-20", generatedAt: T2, chains: ["base"], checked: 1, rows: [r] };
  }
  function unchanged(label, doc, updates, atIso) {
    const before = JSON.stringify(doc);
    const after = applyFollowUps(doc, updates, atIso);
    ok(JSON.stringify(after) === before,
       "applyFollowUps must refuse and return the doc unchanged for: " + label + ", got " +
       JSON.stringify(after));
  }

  // الف) ردیفِ nosell
  unchanged("a nosell row", freshDoc(row(mkAddr(1), "nosell")),
    [{ address: mkAddr(1), follow: "pool-empty" }], "2026-09-20T11:00:00.000Z");
  // ب) ردیفِ حکمِ null
  unchanged("a null-verdict row", freshDoc(row(mkAddr(2), null)),
    [{ address: mkAddr(2), follow: "pool-empty" }], "2026-09-20T11:00:00.000Z");
  // ج) ردیفی که از پیش follow دارد
  unchanged("a row that already has follow",
    freshDoc(row(mkAddr(3), "sell", { follow: "pool-there", followAt: T2 })),
    [{ address: mkAddr(3), follow: "pool-empty" }], "2026-09-20T11:00:00.000Z");
  // د) رشته‌ی followِ ناشناخته
  unchanged("an unknown follow string", freshDoc(row(mkAddr(4), "sell")),
    [{ address: mkAddr(4), follow: "pool-maybe" }], "2026-09-20T11:00:00.000Z");
  // ه) آدرسی که در سند نیست
  unchanged("an address not in the doc", freshDoc(row(mkAddr(5), "sell")),
    [{ address: mkAddr(999), follow: "pool-empty" }], "2026-09-20T11:00:00.000Z");
  // و) atIso غیرِ ISO — کلِ فراخوانی رد می‌شود
  unchanged("a non-ISO atIso", freshDoc(row(mkAddr(6), "sell")),
    [{ address: mkAddr(6), follow: "pool-empty" }], "not-a-date");

  console.log("[report follow refuse] applyFollowUps refuses and returns the doc byte-for-byte unchanged " +
    "for a nosell row, a null-verdict row, a row that already carries follow, an unknown follow string, " +
    "an address absent from the doc, and a non-ISO atIso (the whole call is refused, not just that row)");
}

/* ---- ۲۷و. pickFollowUpTargets — پنجره‌ی ۵۵ تا ۱۸۰ دقیقه، سقف، قدیمی‌ترین اول ---- */
{
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  const NOW3 = Date.parse("2026-09-20T12:00:00.000Z");
  function ageRow(addr, minutesAgo, extra) {
    return Object.assign({
      chain: "base", v: "sell", address: addr,
      checkedAt: new Date(NOW3 - minutesAgo * 60000).toISOString(),
    }, extra);
  }
  const r55 = ageRow(mkAddr(1), 55);       // مرزِ پایین، شامل
  const r180 = ageRow(mkAddr(2), 180);     // مرزِ بالا، شامل
  const r54 = ageRow(mkAddr(3), 54);       // خارج، تازه‌تر از مرز
  const r181 = ageRow(mkAddr(4), 181);     // خارج، قدیمی‌تر از مرز
  const rFollowed = ageRow(mkAddr(5), 100, { follow: "pool-empty" }); // از پیش فالو شده
  const rBad = { chain: "base", v: "sell", address: mkAddr(6), checkedAt: "not-a-date" }; // نامعتبر
  const rNoSell = ageRow(mkAddr(7), 100, { v: "nosell" });
  const rSolana = ageRow(mkAddr(8), 100, { chain: "solana" });

  const docWindow = {
    date: "2026-09-20", generatedAt: null, chains: ["base"], checked: 8,
    rows: [r55, r180, r54, r181, rFollowed, rBad, rNoSell, rSolana],
  };
  const picked = pickFollowUpTargets(docWindow, NOW3, 12);
  ok(JSON.stringify(picked) === JSON.stringify([mkAddr(2), mkAddr(1)]),
     "the window must include exactly the 55- and 180-minute rows (180 first, oldest-first), exclude " +
     "54/181/already-followed/unparseable/nosell/non-base, got " + JSON.stringify(picked));

  // سقف و ترتیب: ۲۰ ردیفِ درونِ پنجره، فقط ۱۲تای قدیمی‌ترش
  const manyRows = Array.from({ length: 20 }, (_, i) => ageRow(mkAddr(100 + i), 60 + i));
  const docMany = { date: "2026-09-20", generatedAt: null, chains: ["base"], checked: 20, rows: manyRows };
  const pickedCap = pickFollowUpTargets(docMany, NOW3, 12);
  ok(pickedCap.length === 12, "the cap must hold at exactly 12, got " + pickedCap.length);
  const expectedCap = Array.from({ length: 12 }, (_, k) => mkAddr(100 + (19 - k)));
  ok(JSON.stringify(pickedCap) === JSON.stringify(expectedCap),
     "the 12 oldest rows must be returned oldest-first, got " + JSON.stringify(pickedCap));
  const pickedCap5 = pickFollowUpTargets(docMany, NOW3, 5);
  ok(pickedCap5.length === 5 && JSON.stringify(pickedCap5) === JSON.stringify(expectedCap.slice(0, 5)),
     "a custom cap must be respected exactly, got " + JSON.stringify(pickedCap5));

  console.log("[report follow pick] pickFollowUpTargets picks only base/sell/not-yet-followed rows " +
    "whose checkedAt falls between 55 and 180 minutes before now (both bounds included, 54/181 " +
    "excluded), skips an already-followed row and one with an unparseable checkedAt, returns " +
    "oldest-first, and respects the cap exactly (default 12 and a custom value)");
}

/* ---- ۲۷ز. runReportPass — پیگیریِ یک‌ساعته با poolEmptyOf تزریقی ----
   یک سندِ از پیش‌نوشته که ردیفِ sellِ قدیمی‌ترش درونِ پنجره‌ی ۵۵-۱۸۰ دقیقه‌ای
   است؛ همین گذر باید آن را فالو کند و دوباره در KV بنویسد، بدونِ اینکه
   verdict/why/cause‌اش را لمس کند. */
{
  function makeKv() {
    const store = new Map();
    return {
      store,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
    };
  }
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function poolRow(addr, reserve, price) {
    return {
      attributes: { reserve_in_usd: String(reserve), base_token_price_usd: String(price),
        pool_created_at: "2026-09-20T10:00:00Z", volume_usd: { h24: "0" }, fdv_usd: "0" },
      relationships: { base_token: { data: { id: "base_" + addr } },
        dex: { data: { id: "uniswap-v3-base" } } },
    };
  }
  function seedOldSellRow(nowMs, addr) {
    return reportRow({
      chain: "base", address: addr, symbol: "OLD", name: "Old Token", verdict: "sell",
      checkedAt: new Date(nowMs - 100 * 60000).toISOString(), poolCreatedAt: null,
      priceUsd: 1, reserveUsd: 2, vol24hUsd: 3, fdvUsd: 4, dex: "uniswap-v4-base", why: null,
    });
  }

  // الف) poolEmptyOf → true
  {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const addr = mkAddr(1);
    const oldRow = seedOldSellRow(NOW, addr);
    const seedDoc = mergeReportDoc(null, dateStr, [oldRow], 1, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKv();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    await kv.put(PAIRS_KEY_BASE, JSON.stringify([{ address: addr, v: "sell" }]));
    let calls = [];
    const poolEmptyOf = async (a) => { calls.push(a); return true; };
    const res = await runReportPass({
      kv, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async () => ({ v: null, why: "no-quote" }), now: () => NOW, sleep: async () => {}, poolEmptyOf,
    });
    ok(res.followed === 1, "poolEmptyOf:true must mark exactly one row, followed=" + res.followed);
    ok(calls.length === 1 && calls[0] === addr, "poolEmptyOf must be called with the one due address, got " +
      JSON.stringify(calls));
    const stored = JSON.parse(await kv.get(reportKey(dateStr)));
    const storedRow = stored.rows.find((r) => r.address === addr);
    ok(storedRow.follow === "pool-empty" && typeof storedRow.followAt === "string",
       "a true poolEmptyOf must store follow:\"pool-empty\" with a followAt string, got " +
       JSON.stringify(storedRow));
    ok(storedRow.v === "sell" && storedRow.why === null && !("cause" in storedRow),
       "the followed row's verdict/why/cause must stay unchanged, got " + JSON.stringify(storedRow));
  }

  // ب) poolEmptyOf → false
  {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const addr = mkAddr(2);
    const oldRow = seedOldSellRow(NOW, addr);
    const seedDoc = mergeReportDoc(null, dateStr, [oldRow], 1, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKv();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    await kv.put(PAIRS_KEY_BASE, JSON.stringify([{ address: addr, v: "sell" }]));
    const res = await runReportPass({
      kv, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async () => ({ v: null, why: "no-quote" }), now: () => NOW, sleep: async () => {},
      poolEmptyOf: async () => false,
    });
    ok(res.followed === 1, "poolEmptyOf:false must still mark exactly one row, followed=" + res.followed);
    const stored = JSON.parse(await kv.get(reportKey(dateStr)));
    const storedRow = stored.rows.find((r) => r.address === addr);
    ok(storedRow.follow === "pool-there", "a false poolEmptyOf must store follow:\"pool-there\", got " +
      JSON.stringify(storedRow.follow));
  }

  // ج) poolEmptyOf → null
  {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const addr = mkAddr(3);
    const oldRow = seedOldSellRow(NOW, addr);
    const seedDoc = mergeReportDoc(null, dateStr, [oldRow], 1, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKv();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    await kv.put(PAIRS_KEY_BASE, JSON.stringify([{ address: addr, v: "sell" }]));
    const res = await runReportPass({
      kv, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async () => ({ v: null, why: "no-quote" }), now: () => NOW, sleep: async () => {},
      poolEmptyOf: async () => null,
    });
    ok(res.followed === 0, "poolEmptyOf:null must yield followed:0, got " + res.followed);
    const stored = JSON.parse(await kv.get(reportKey(dateStr)));
    const storedRow = stored.rows.find((r) => r.address === addr);
    ok(!("follow" in storedRow) && !("followAt" in storedRow),
       "poolEmptyOf:null must leave no follow key at all, got " + JSON.stringify(storedRow));
  }

  // د) poolEmptyOf پرتاب می‌کند — همان رفتارِ null، و checked/added دست‌نخورده
  {
    const NOW = Date.parse("2026-09-20T13:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const oldAddr = mkAddr(4);
    const oldRow = seedOldSellRow(NOW, oldAddr);
    const seedDoc = mergeReportDoc(null, dateStr, [oldRow], 1, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKv();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    await kv.put(PAIRS_KEY_BASE, JSON.stringify([{ address: oldAddr, v: "sell" }]));
    const freshAddr = mkAddr(5);
    const res = await runReportPass({
      kv, fetchPools: async () => [poolRow(freshAddr, 10000, 0.5)],
      metaOf: async () => ({ meta: { symbol: "NEW", name: "New Token" }, why: null }),
      verdictOf: async () => ({ v: "sell", why: null }),
      now: () => NOW, sleep: async () => {},
      poolEmptyOf: async () => { throw new Error("rpc is down"); },
    });
    ok(res.checked === 1 && res.added === 1,
       "a throwing poolEmptyOf must never affect the pass's normal checked/added, got " + JSON.stringify(res));
    ok(res.followed === 0, "a throwing poolEmptyOf must yield followed:0, got " + res.followed);
    const stored = JSON.parse(await kv.get(reportKey(dateStr)));
    const storedRow = stored.rows.find((r) => r.address === oldAddr);
    ok(!("follow" in storedRow), "a throwing poolEmptyOf must leave no follow key, got " +
       JSON.stringify(storedRow));
  }

  // ه) بدونِ poolEmptyOf اصلاً — followed همیشه ۰، رفتارِ امروز دست‌نخورده
  {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const addr = mkAddr(6);
    const oldRow = seedOldSellRow(NOW, addr);
    const seedDoc = mergeReportDoc(null, dateStr, [oldRow], 1, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKv();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    await kv.put(PAIRS_KEY_BASE, JSON.stringify([{ address: addr, v: "sell" }]));
    const res = await runReportPass({
      kv, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async () => ({ v: null, why: "no-quote" }), now: () => NOW, sleep: async () => {},
    });
    ok(res.followed === 0, "with no poolEmptyOf injected, followed must be 0, got " + res.followed);
  }

  console.log("[report follow pass] runReportPass's injected poolEmptyOf marks a due sell row " +
    "\"pool-empty\" on true and \"pool-there\" on false, writing the document again; null or a throw " +
    "leaves no follow key at all and followed:0 without disturbing the pass's normal checked/added; " +
    "the followed row's verdict/why/cause never change; and omitting poolEmptyOf entirely leaves " +
    "followed:0 with today's behaviour otherwise untouched");
}

/* ---- ۲۷ح. reportText — خطِ «pool is empty an hour later» ---- */
{
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function row5(overrides) {
    return Object.assign({
      chain: "base", address: mkAddr(1), symbol: null, name: null, v: "sell", checkKind: "sell-quote",
      checkedAt: "2026-09-20T00:00:00.000Z", poolCreatedAt: null, priceUsd: null, reserveUsd: null,
      vol24hUsd: null, fdvUsd: null, dex: null,
    }, overrides);
  }

  // الف) یک ردیفِ pool-empty — عددِ مفرد، جای درست
  const rowFollowed1 = row5({ address: mkAddr(1), follow: "pool-empty" });
  const rowOther1 = row5({ address: mkAddr(2) });
  const doc1 = { date: "2026-09-20", generatedAt: null, rows: [rowFollowed1, rowOther1] };
  const t1 = reportText(doc1);
  const lines1 = t1.split("\n");
  const idx1 = lines1.findIndex((l) => l.endsWith("could not be checked."));
  ok(idx1 >= 0 && lines1[idx1 + 1] === "1 of the quoted tokens had an empty pool an hour later.",
     "the singular line must sit immediately after the \"could not be checked.\" line, got " +
     JSON.stringify(lines1));
  ok(lines1[idx1 + 2] === "", "a blank line must still follow the new line, got " + JSON.stringify(lines1));

  // ب) سه ردیفِ pool-empty — همان جمله، فقط عدد فرق دارد
  const rowFollowedA = row5({ address: mkAddr(11), follow: "pool-empty" });
  const rowFollowedB = row5({ address: mkAddr(12), follow: "pool-empty" });
  const rowFollowedC = row5({ address: mkAddr(13), follow: "pool-empty" });
  const doc3 = { date: "2026-09-20", generatedAt: null, rows: [rowFollowedA, rowFollowedB, rowFollowedC] };
  const t3 = reportText(doc3);
  ok(t3.includes("3 of the quoted tokens had an empty pool an hour later."),
     "three pool-empty rows must produce the count 3 with the same sentence, got " + JSON.stringify(t3));

  // ج) صفر ردیفِ pool-empty — بایت‌به‌بایت همان سندِ بدونِ هیچ followی
  const docNoFollowField = {
    date: "2026-09-20", generatedAt: null,
    rows: [row5({ address: mkAddr(20) }), row5({ address: mkAddr(21), v: "nosell" })],
  };
  const docFollowButNotEmpty = {
    date: "2026-09-20", generatedAt: null,
    rows: [row5({ address: mkAddr(20), follow: "pool-there" }), row5({ address: mkAddr(21), v: "nosell" })],
  };
  const tNoField = reportText(docNoFollowField);
  const tNotEmpty = reportText(docFollowButNotEmpty);
  ok(tNoField === tNotEmpty,
     "with zero pool-empty rows, the output must be byte-for-byte identical to the same document " +
     "without any follow fields, got:\n" + JSON.stringify(tNoField) + "\nvs\n" + JSON.stringify(tNotEmpty));
  ok(!tNoField.includes("empty pool an hour later"),
     "with zero pool-empty rows, no such line may appear at all, got " + JSON.stringify(tNoField));

  console.log("[report follow text] reportText inserts \"N of the quoted tokens had an empty pool an " +
    "hour later.\" immediately after the \"could not be checked.\" line whenever a pool-empty row is " +
    "present, with correct singular/plural wording, and is byte-for-byte identical to the same document " +
    "with no follow fields at all when the count is zero");
}

/* ---- ۲۷الف. کوروم شاهد — یک صرافیِ مبهم نباید اثباتِ بقیه را پاک کند ----
   🔴 از یک اندازه‌گیریِ زنده آمد، نه از یک ایده. پروبِ توکنِ واقعیِ
   0x6F63d869011f95274498023b4ABFC00b30c34378 روی سایتِ زنده:
     by out: {'quoted': 1 (canary), 'revert:3': 19, 'zero': 2}  · covered: true
   آن دو صفر از aerodrome (SOLIDLY) بودند و تا پیش از ۱۹ شهریور کلِ حکم را
   باطل می‌کردند، یعنی نوزده شاهدِ تمیز پاک می‌شد. و چون روترِ سالیدیتی وقتی
   استخر ندارد صفر می‌دهد نه ریوِرت، آن دو صفر تقریباً روی هر توکنِ تازه هست:
   شاخه‌ی nosell عملاً غیرقابلِ‌رسیدن بود (۰ مورد در ۳۱۹ توکنِ زنده).
   حالا صفرِ آن kind «ممتنع» است: نه اثبات می‌کند، نه اثباتِ بقیه را پاک. */
{
  const w2 = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mk4 = (n) => "0x" + w2(n) + w2(0) + w2(0) + w2(0);
  const mkArr = (vals) => "0x" + w2(0x20) + w2(vals.length) + vals.map(w2).join("");
  const alive = { result: mk4(5) };
  const proofs = (n, kind = "CL_UINT24") =>
    Array.from({ length: n }, () => ({ kind, error: { code: 3 } }));
  const solidlyZero = { kind: "SOLIDLY", result: mkArr([0n]) };
  const solidlyEmpty = { kind: "SOLIDLY", result: "0x" };

  // الف) دقیقاً شکلِ زنده: نوزده ریوِرتِ اثباتی + دو صفرِ آئرودروم → nosell
  ok(vd.verdictFrom({ canary: alive, items: proofs(19).concat([solidlyZero, solidlyZero]) }) === "nosell",
     "the live shape (19 proven reverts + 2 aerodrome zeros) must verdict nosell — two abstaining "
     + "rows may not erase nineteen proofs");

  // ب) هیچ اثباتی، فقط ممتنع → نامعلوم (گاردِ کوروم)
  ok(vd.verdictFrom({ canary: alive, items: [solidlyZero, solidlyEmpty, solidlyZero] }) === null,
     "a list of nothing but abstaining SOLIDLY rows must stay unknown — an abstain is not evidence");

  // ج) یک اثبات + ممتنع → nosell (کف همان یک شاهدِ واقعی است، مثلِ قبل)
  ok(vd.verdictFrom({ canary: alive, items: [{ kind: "V2", result: "0x" }, solidlyZero] }) === "nosell",
     "one real proof next to an abstain must still verdict nosell — the floor is unchanged at "
     + "VD_MIN_NEGATIVE_PROOF");

  // د) «نتوانستیم بپرسیم» هنوز کلِ حکم را نامعلوم می‌کند، حتی کنارِ ۱۹ اثبات
  ok(vd.verdictFrom({ canary: alive,
        items: proofs(19).concat([{ kind: "V2", error: { code: -32603 } }, solidlyZero]) }) === null,
     "an unknown error code is \"we could not ask\", not an abstain — it must still make the whole "
     + "verdict unknown even beside nineteen proofs");
  ok(vd.verdictFrom({ canary: alive,
        items: proofs(19).concat([{ kind: "CL_UINT24", result: "0xdeadbeef" }]) }) === null,
     "an undecodable result must still make the whole verdict unknown, beside any number of proofs");

  // ه) ردیف‌های positive-only هرگز کوروم نمی‌سازند، حتی در کنارِ ممتنع‌ها
  ok(vd.verdictFrom({ canary: alive,
        items: [{ kind: "V4_SINGLE", error: { code: 3 } }, { kind: "V4_SINGLE", error: { code: 3 } },
                solidlyZero] }) === null,
     "v4 rows plus abstains carry zero real evidence — that must be unknown, never nosell");

  // و) مثبت همچنان بر همه‌چیز می‌چربد، و کاناریِ مرده همچنان همه را باطل می‌کند
  ok(vd.verdictFrom({ canary: alive,
        items: proofs(19).concat([solidlyZero, { kind: "V2", result: mkArr([0n, 7n]) }]) }) === "sell",
     "a positive quote must still win over nineteen proofs and any abstain");
  ok(vd.verdictFrom({ canary: { error: { code: 3 } },
        items: proofs(19).concat([solidlyZero]) }) === null,
     "a dead canary must still make the verdict unknown, whatever the items said");

  // ز) پین‌های جدول — صفرِ SOLIDLY هنوز اثبات نیست (رفعِ ۷ سپتامبر سرِ جایش)
  ok(vd.VD_MIN_NEGATIVE_PROOF === 1,
     "VD_MIN_NEGATIVE_PROOF must be exported as 1, got " + JSON.stringify(vd.VD_MIN_NEGATIVE_PROOF));
  ok(vd.VD_ZERO_IS_PROOF.SOLIDLY === false && vd.VD_ZERO_IS_PROOF.V4_SINGLE === false,
     "the 7 Sep rule must still hold: a SOLIDLY/V4 zero is never proof on its own");

  /* ح) سرتاسری از رویِ worker.fetch — همان شکلِ زنده، با و بدونِ پوشش.
     گاردِ پوشش (baseVenueCovered) لایه‌ی دومِ ۷ سپتامبر است و باید دست‌نخورده
     بماند: حالا که nosell دوباره قابلِ‌رسیدن است، این تنها چیزی است که
     جلوی اتهام به توکنی را می‌گیرد که استخرش روی صرافیِ پوشش‌نداده است. */
  {
    const { UPSTREAM_KEYED: UK_Q } = await import("./index.js");
    const envQ = { ASSETS, CG_KEY: "SECRET-CG-KEY-FOR-27A" };
    const gtMetaQ = () => new Response(JSON.stringify({ data: { attributes: {
      name: "Quorum Token", symbol: "QRM", total_reserve_in_usd: "1000",
      decimals: 18, price_usd: "2000",
    } } }), { status: 200, headers: { "content-type": "application/json" } });
    // شکلِ زنده: هر ردیفِ غیرِ SOLIDLY ریوِرتِ کدِ ۳، ردیف‌های SOLIDLY صفر
    const liveShapeRow = (r) => (isSolidlyReqId(r.id)
      ? { id: r.id, result: mkArr([0n]) }
      : { id: r.id, error: { code: 3 } });
    const dispatchQ = (dexId) => async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) {
        return new Response(JSON.stringify({ data: [
          { relationships: { dex: { data: { id: dexId } } } },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.startsWith(UK_Q)) return gtMetaQ();
      const reqs = JSON.parse(init.body);
      return new Response(JSON.stringify(reqs.map((r) => (r.id === 0
        ? { id: 0, result: mk4(5) } : liveShapeRow(r)))),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    async function askQ(addr, dexId, ipTail) {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = dispatchQ(dexId);
      const res = await call("/vd/" + addr, { headers: { "cf-connecting-ip": "203.0.113." + ipTail } }, envQ);
      const body = await res.json();
      globalThis.fetch = savedFetch;
      return body;
    }

    const covered = await askQ("0x" + "a".repeat(40), "uniswap-v3-base", 201);
    ok(covered.v === "nosell" && !("why" in covered),
       "the live shape on a COVERED dex must reach nosell end to end, with no why key, got " +
       JSON.stringify(covered));

    const uncovered = await askQ("0x" + "b".repeat(40), "uniswap-v4-base", 202);
    ok(uncovered.v === null && uncovered.why === "cover:false",
       "the same shape on an UNCOVERED dex must still degrade to unknown (cover:false) — the 7 Sep " +
       "coverage guard is what keeps this change from accusing a token we never actually asked about, got " +
       JSON.stringify(uncovered));
  }

  /* ط) استخرِ واقعیِ v4 به‌عنوانِ شاهد *و* پوشش — سرتاسری از رویِ worker.fetch.
     توکنی که بالادست فقط استخرِ v4 برایش می‌شناسد (پوشش false)، ولی کلیدِ
     واقعی‌اش ذخیره شده و خودِ آن استخر می‌گوید هیچ اندازه‌ای را پر نمی‌کند.
     تا ۱۹ شهریور این ترکیب «نامعلوم» می‌شد؛ حالا حکم می‌گیرد. */
  {
    const { UPSTREAM_KEYED: UK_P, v4KvKeyForTest } = await import("./index.js");
    const { v4KvKey } = await import("./v4index.js");
    const ADDR_P = "0x" + "c".repeat(40);
    const POOL_ID_P = "0x" + "7".repeat(64);
    const REAL_KEY_P = { currency0: vd.NATIVE_ADDR, currency1: ADDR_P, fee: 0, tickSpacing: 1,
      hooks: vd.NATIVE_ADDR, poolId: POOL_ID_P };
    const wrappedP = vd.VD_REVERT_WRAPPER + w2(0x20) + w2(36) +
      vd.VD_NO_LIQUIDITY_SELECTOR.slice(2) + POOL_ID_P.slice(2) + "0".repeat(56);
    const kvP = {
      get: async (k) => (k === v4KvKey("base", ADDR_P)
        ? JSON.stringify({ keys: [REAL_KEY_P], reason: "ok" }) : null),
      put: async () => {},
    };
    const envP = { ASSETS, CG_KEY: "SECRET-CG-KEY-FOR-27A-2", ZX_KV: kvP };
    const shapeP = vd.buildProbe(ADDR_P, vd.WETH_ADDR, 1n, { v4Keys: [REAL_KEY_P] });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) {
        return new Response(JSON.stringify({ data: [
          { relationships: { dex: { data: { id: "uniswap-v4-base" } } } },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.startsWith(UK_P)) {
        return new Response(JSON.stringify({ data: { attributes: {
          name: "Only V4", symbol: "ONLYV4", total_reserve_in_usd: "1000",
          decimals: 18, price_usd: "2000",
        } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const reqs = JSON.parse(init.body);
      return new Response(JSON.stringify(reqs.map((r) => {
        if (r.id === 0) return { id: 0, result: mk4(5) };
        const item = shapeP[r.id - 1];
        if (item && item.poolId) return { id: r.id, error: { code: 3, data: wrappedP } };
        return { id: r.id, error: { code: 3 } };
      })), { status: 200, headers: { "content-type": "application/json" } });
    };
    const resP = await call("/vd/" + ADDR_P, { headers: { "cf-connecting-ip": "203.0.113.203" } }, envP);
    const bodyP = await resP.json();
    globalThis.fetch = savedFetch;
    ok(bodyP.v === "nosell" && !("why" in bodyP),
       "a v4-only token whose own indexed pool cannot fill any size must now reach nosell end to end — " +
       "the chain-verified pool is its own coverage evidence, got " + JSON.stringify(bodyP));
  }

  /* ک) 🔴 حکم نباید بینِ دو درخواست عوض شود — شاهدِ نسخه ۴ باید با خودِ حکم
     کش شود. اندازه‌گیریِ زنده‌ی ۱۹ شهریور: همان توکن در اجرای اول nosell داد و
     یک دقیقه بعد «نامعلوم / cover:false»، چون ضربه‌ی کش پرچمِ شاهد را نداشت و
     گاردِ پوشش دوباره تنزلش می‌داد. این تست یک کشِ واقعی‌نما می‌سازد و همان دو
     درخواستِ پشت‌سرهم را می‌زند. */
  {
    const { UPSTREAM_KEYED: UK_K } = await import("./index.js");
    const { v4KvKey } = await import("./v4index.js");
    const ADDR_K = "0x" + "f".repeat(40);
    const POOL_ID_K = "0x" + "3".repeat(64);
    const REAL_KEY_K = { currency0: vd.NATIVE_ADDR, currency1: ADDR_K, fee: 0, tickSpacing: 1,
      hooks: vd.NATIVE_ADDR, poolId: POOL_ID_K };
    const wrappedK = vd.VD_REVERT_WRAPPER + w2(0x20) + w2(36) +
      vd.VD_NO_LIQUIDITY_SELECTOR.slice(2) + POOL_ID_K.slice(2) + "0".repeat(56);
    const shapeK = vd.buildProbe(ADDR_K, vd.WETH_ADDR, 1n, { v4Keys: [REAL_KEY_K] });
    const kvK = {
      get: async (k) => (k === v4KvKey("base", ADDR_K)
        ? JSON.stringify({ keys: [REAL_KEY_K], reason: "ok" }) : null),
      put: async () => {},
    };
    const envK = { ASSETS, CG_KEY: "SECRET-CG-KEY-FOR-27A-3", ZX_KV: kvK };

    let rpcBatches = 0;
    const savedFetch = globalThis.fetch;
    const savedCaches = globalThis.caches;
    const cacheStore = new Map();
    globalThis.caches = { default: {
      match: async (req) => {
        const body = cacheStore.get(String(req.url));
        return body === undefined ? undefined : new Response(body,
          { headers: { "content-type": "application/json" } });
      },
      put: async (req, res) => { cacheStore.set(String(req.url), await res.text()); },
    } };
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) {
        return new Response(JSON.stringify({ data: [
          { relationships: { dex: { data: { id: "uniswap-v4-base" } } } },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.startsWith(UK_K)) {
        return new Response(JSON.stringify({ data: { attributes: {
          name: "Cached V4", symbol: "CACHEV4", total_reserve_in_usd: "1000",
          decimals: 18, price_usd: "2000" } } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      const parsed = JSON.parse(init.body);
      // ⚠️ fix9: v4PoolsEmpty (کالر تازه‌ی cacheOut.v4Proof===true پایین‌تر)
      // یک eth_call تکی می‌زند، نه آرایه‌ی batchِ پروبِ صرافی‌ها — این دو باید
      // جدا شمرده شوند وگرنه شاهدِ «ضربه‌ی کش هیچ RPC تازه‌ای نمی‌زند» یک
      // چیزِ دیگر را می‌سنجد. اینجا فقط batchِ واقعی (آرایه) در rpcBatches
      // می‌نشیند؛ eth_callِ تکی جدا جواب می‌گیرد و شمرده نمی‌شود، چون خودِ
      // این تست فقط می‌خواهد اثبات کند حکمِ نوشته‌شده در کش دوباره محاسبه
      // نمی‌شود — نه اینکه هیچ RPCِ توضیحی هرگز نزند (که طبقِ طراحیِ همین
      // تغییر، روی هر دو درخواست، کش‌شده یا تازه، یکسان اتفاق می‌افتد).
      if (!Array.isArray(parsed)) {
        if (parsed && parsed.method === "eth_call") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id,
            result: "0x" + "0".repeat(64) }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("unexpected single RPC call", { status: 500 });
      }
      rpcBatches++;
      return new Response(JSON.stringify(parsed.map((r) => {
        if (r.id === 0) return { id: 0, result: mk4(5) };
        const item = shapeK[r.id - 1];
        if (item && item.poolId) return { id: r.id, error: { code: 3, data: wrappedK } };
        return { id: r.id, error: { code: 3 } };
      })), { status: 200, headers: { "content-type": "application/json" } });
    };

    const first = await (await call("/vd/" + ADDR_K,
      { headers: { "cf-connecting-ip": "203.0.113.204" } }, envK)).json();
    const batchesAfterFirst = rpcBatches;
    const second = await (await call("/vd/" + ADDR_K,
      { headers: { "cf-connecting-ip": "203.0.113.205" } }, envK)).json();
    globalThis.fetch = savedFetch;
    if (savedCaches === undefined) delete globalThis.caches; else globalThis.caches = savedCaches;

    ok(first.v === "nosell", "the fresh compute must give nosell, got " + JSON.stringify(first));
    ok(second.v === "nosell",
       "the SAME token one request later must still give nosell — the v4 evidence has to be cached " +
       "alongside the verdict, or the coverage gate silently downgrades a cache hit, got " +
       JSON.stringify(second));
    ok(rpcBatches === batchesAfterFirst,
       "sanity: the second request must really be served from the verdict cache (no new venue-probe " +
       "RPC batch) — cause's own explanatory eth_call is a different, always-on-negative call and is " +
       "counted separately, got " + rpcBatches + " vs " + batchesAfterFirst);
  }

  /* ی) گذرِ کرون کلیدِ واقعیِ v4 را *پیش از* حکم می‌سازد.
     🔴 اندازه‌گیریِ ۱۹ شهریور: ۶۴ از ۶۵ توکنِ v4 در گزارش «نامعلوم» بودند،
     چون ایندکس با waitUntil بعد از حکم اجرا می‌شد و گزارش هر توکن را فقط
     یک بار می‌بیند — کلید ساخته می‌شد و هرگز به هیچ ردیفی نمی‌رسید.
     این تست ترتیب را می‌سنجد، نه فقط وجودِ تماس را. */
  {
    const ADDR_C = "0x" + "d".repeat(40);
    const order = [];
    const POOL_ROW_C = {
      attributes: {
        base_token_price_usd: "2000", reserve_in_usd: "10000",
        pool_created_at: "2026-09-19T00:00:00Z", volume_usd: { h24: "1000" }, fdv_usd: "500000",
      },
      relationships: {
        base_token: { data: { id: "base_" + ADDR_C } },
        dex: { data: { id: "uniswap-v4-base" } },
      },
    };
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/new_pools")) {
        return new Response(JSON.stringify({ data: [POOL_ROW_C] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      // ⚠️ اول /pools، بعد /tokens/ — آدرسِ استخرها خودش شاملِ /tokens/ است
      if (u.endsWith("/pools")) {
        order.push("pools");
        return new Response(JSON.stringify({ data: [
          // 🔴 شناسه‌ی استخرِ v4 سی‌ودو بایت است، نه بیست — فیکسچرِ بیست‌بایتی
          // را خودِ v4index کنار می‌گذارد و هیچ لاگی خوانده نمی‌شود.
          { attributes: { address: "0x" + "e".repeat(64), pool_created_at: "2026-09-19T00:00:00Z" },
            relationships: { dex: { data: { id: "uniswap-v4-base" } } } },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/tokens/")) {
        order.push("meta");
        return new Response(JSON.stringify({ data: { attributes: {
          name: "Cron V4", symbol: "CRONV4", total_reserve_in_usd: "1000",
          decimals: 18, price_usd: "2000" } } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      // پروبِ سقفِ ساب‌ریکوئست — یک HEAD بدونِ بدنه، نه یک RPC batch.
      if (u.includes("/networks?page=1")) return new Response("", { status: 200 });
      const body = JSON.parse(init.body);
      const method = Array.isArray(body) ? "eth_call" : body.method;
      order.push(method);
      if (method === "eth_getBlockByNumber") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x3111111" } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "eth_getLogs") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(body.map((r) => (r.id === 0
        ? { id: 0, result: mk4(5) } : { id: r.id, error: { code: 3 } }))),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    const store = new Map();
    const kvC = { get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); } };
    const resC = await call("/report/run", { method: "GET", headers: { "x-run-key": "cron-v4-key" } },
      { ASSETS, ZX_KV: kvC, RUN_KEY: "cron-v4-key" });
    globalThis.fetch = savedFetch;
    ok(resC.status === 200, "the manual report run must answer 200, got " + resC.status);
    // اولین تماسِ زنجیره‌ایِ خودِ ایندکس (هر کدام زودتر بیاید) در برابرِ اولین
    // eth_call که مالِ حکم است.
    const idxCalls = order.filter((m) => m === "eth_getBlockByNumber" || m === "eth_getLogs");
    const firstIndex = order.findIndex((m) => m === "eth_getBlockByNumber" || m === "eth_getLogs");
    const firstCall = order.indexOf("eth_call");
    ok(idxCalls.length > 0,
       "the cron pass must index the real v4 key itself, got call order: " + JSON.stringify(order));
    ok(firstCall === -1 || firstIndex < firstCall,
       "the v4 index must run BEFORE the verdict's eth_call, not after it in the background — " +
       "otherwise the key it builds never reaches any report row. Order: " + JSON.stringify(order));
  }

  console.log("[nosell quorum] an abstaining venue no longer erases proven negatives: the measured live "
    + "shape (19 reverts + 2 aerodrome zeros) now verdicts nosell instead of unknown, while an abstain "
    + "alone still proves nothing, an unknown error code or an undecodable result still makes the whole "
    + "verdict unknown, positive-only v4 rows still carry no evidence, a positive still wins and a dead "
    + "canary still voids everything; end to end the same shape reaches nosell on a covered dex and "
    + "still degrades to cover:false on an uncovered one; a real v4 pool answering NotEnoughLiquidity for its "
    + "own pool id is now both evidence and its own coverage (a guessed row, or a mismatched pool id, still "
    + "proves nothing); and the cron pass indexes the real v4 key BEFORE the verdict instead of after it");
}

/* ---- ۲۷ب. چرا «نامعلوم» — واژه‌نامه‌ی بسته‌ی why روی Base ----
   مسئله (بالای این فایل، ۲۰۲۶-۰۹-۱۴): گزارشِ روزانه‌ی زنده ۱۰۶ از ۲۱۰ ردیف
   را با v:null («نتوانستیم بررسی کنیم») دارد، و امروز هیچ‌جا ثبت نمی‌شود
   *کجا* هرکدام متوقف شد — هر نظریه (سقفِ نرخِ GeckoTerminal حینِ کرون،
   توکن‌های Uniswap v4 بدونِ استخرِ قابلِ‌کوت، مهلت، RPC) فقط یک حدس است.
   این بخش یک ابزارِ اندازه‌گیری است، نه چیزِ دیگر: verdict/کش/شمارِ
   فراخوانی‌ها را عوض نمی‌کند، فقط ثابت می‌کند why دقیقاً همان چیزی را
   می‌گوید که واقعاً اتفاق افتاد. */
{
  // آ) isBaseWhy — واژه‌نامه‌ی بسته: هر عضوِ VD_BASE_WHY، به‌علاوه‌ی
  // پیشوند+وضعیتِ عددیِ ۱ تا ۳ رقمی برای "meta"/"cover"، و نه چیزِ دیگر.
  {
    for (const label of vd.VD_BASE_WHY) {
      ok(vd.isBaseWhy(label) === true,
         "isBaseWhy(" + JSON.stringify(label) + ") must be true — it is a frozen VD_BASE_WHY member");
    }
    for (const s of ["meta:429", "cover:0", "cover:503"]) {
      ok(vd.isBaseWhy(s) === true,
         "isBaseWhy(" + JSON.stringify(s) + ") must be true — prefix+1-3-digit-status is allowed");
    }
    const bad = ["meta:", "meta:4290", "meta:-1", "meta:abc", "cover", "rpc:500", "", null, 42,
      "meta:429 ", "https://x"];
    for (const s of bad) {
      ok(vd.isBaseWhy(s) === false, "isBaseWhy(" + JSON.stringify(s) + ") must be false");
    }
  }

  // ب) fetchVerdict + opts.whyOut — یک سناریو به‌ازای هر دلیل، با
  // fetchImpl/now/deadlineAt تزریقی؛ برای هرکدام: whyOut.why دقیقاً همان
  // دلیل، verdict با/بدونِ whyOut یکسان، و شمارِ فراخوانیِ fetch با/بدونِ
  // whyOut یکسان — این تابع فقط مشاهده می‌کند، هرگز تصمیم نمی‌گیرد.
  {
    const w = (n) => BigInt(n).toString(16).padStart(64, "0");
    const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);
    const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
    const TOKEN = "0x5151515151515151515151515151515151515151";
    const meta = { decimals: 18, priceUsd: 2000 };
    const usdcHexLower = vd.USDC_ADDR.slice(2).toLowerCase();
    const REAL_USDC_KEY = {
      currency0: TOKEN.toLowerCase(), currency1: vd.USDC_ADDR.toLowerCase(),
      fee: 9990, tickSpacing: 100, hooks: vd.NATIVE_ADDR,
    };
    // همه‌جا "0x" (SOLIDLY هرگز صفر را اثبات نمی‌داند) → مرحله مبهم می‌ماند
    // ابهامِ واقعی = «نتوانستیم بپرسیم» → کدِ خطای غیرِ اثباتی. (پیش از
    // ۱۹ شهریور "0x" هم مبهم بود؛ حالا اثباتِ منفی است.)
    const ambiguous = (r) => ({ id: r.id, error: { code: -32603 } });
    // کدِ ۳ برای SOLIDLY، "0x" برای بقیه → مرحله تمیز nosell می‌شود
    const cleanNosell = (r) => (isSolidlyReqId(r.id) ? { id: r.id, error: { code: 3 } } : { id: r.id, result: "0x" });

    async function twice(reason, meta_, buildOpts) {
      let calls1 = 0;
      const v1 = await vd.fetchVerdict(TOKEN, meta_, Object.assign({}, buildOpts(() => calls1++)));
      let calls2 = 0;
      const whyOut = {};
      const v2 = await vd.fetchVerdict(TOKEN, meta_,
        Object.assign({}, buildOpts(() => calls2++), { whyOut }));
      ok(v1 === v2, "[" + reason + "] opts.whyOut must never change the returned verdict: without=" +
        v1 + " with=" + v2);
      ok(calls1 === calls2, "[" + reason + "] opts.whyOut must never change the fetch call count: without=" +
        calls1 + " with=" + calls2);
      ok(whyOut.why === reason,
        "[" + reason + "] whyOut.why must equal " + JSON.stringify(reason) + ", got " + JSON.stringify(whyOut.why));
      return v2;
    }

    // no-amount — بدونِ حتی یک فراخوانی
    await twice("no-amount", { decimals: 18, priceUsd: null }, (tick) => ({
      fetchImpl: async () => { tick(); return jsonRes([]); },
      rpcs: ["https://rpc-why-1.example"],
    }));

    // deadline — مهلت پیش از اولین مرحله، بدونِ حتی یک فراخوانی
    await twice("deadline", meta, (tick) => ({
      fetchImpl: async () => { tick(); return jsonRes([]); },
      now: () => 10_000, deadlineAt: 5_000, rpcs: ["https://rpc-why-2.example"],
    }));

    // rpc-down — هر دو اندپوینت پرتاب می‌کنند
    await twice("rpc-down", meta, (tick) => ({
      fetchImpl: async () => { tick(); throw new Error("network is down"); },
      rpcs: ["https://rpc-why-3a.example", "https://rpc-why-3b.example"],
    }));

    // canary-dead — هر دو اندپوینت ۲۰۰ می‌دهند ولی کاناری‌شان مرده است
    await twice("canary-dead", meta, (tick) => ({
      fetchImpl: async (url, init) => {
        tick();
        JSON.parse(init.body); // فقط شکل را می‌سنجیم؛ محتوا لازم نیست
        return jsonRes([{ id: 0, result: mkStatic4(0) }]); // کاناریِ صفر → مرده
      },
      rpcs: ["https://rpc-why-4a.example", "https://rpc-why-4b.example"],
    }));

    // no-quote — مرحله‌ی WETH مبهم، بدونِ کلیدِ واقعیِ USDC
    await twice("no-quote", meta, (tick) => ({
      fetchImpl: async (url, init) => {
        tick();
        const reqs = JSON.parse(init.body);
        return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : ambiguous(r))));
      },
      rpcs: ["https://rpc-why-5.example"],
    }));

    // proof-rpc — مرحله‌ی WETH مبهم + کلیدِ واقعیِ USDC، ولی گذرِ اثبات ۵۰۰ می‌گیرد
    await twice("proof-rpc", meta, (tick) => ({
      fetchImpl: async (url, init) => {
        tick();
        const reqs = JSON.parse(init.body);
        const isProof = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
        if (isProof) return new Response("boom", { status: 500 });
        return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : ambiguous(r))));
      },
      rpcs: ["https://rpc-why-6.example"], v4Keys: [REAL_USDC_KEY],
    }));

    // proof-no-quote — همان، ولی کلیدِ واقعی ریوِرت می‌دهد
    await twice("proof-no-quote", meta, (tick) => ({
      fetchImpl: async (url, init) => {
        tick();
        const reqs = JSON.parse(init.body);
        const isProof = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
        return jsonRes(reqs.map((r) => {
          if (r.id === 0) return { id: 0, result: mkStatic4(5) };
          if (!isProof) return ambiguous(r);
          return { id: r.id, error: { code: 3 } };
        }));
      },
      rpcs: ["https://rpc-why-7.example"], v4Keys: [REAL_USDC_KEY],
    }));

    // usdc-rpc — مرحله‌ی WETH تمیز nosell، مرحله‌ی USDC ۵۰۰ می‌گیرد
    await twice("usdc-rpc", meta, (tick) => ({
      fetchImpl: async (url, init) => {
        tick();
        const reqs = JSON.parse(init.body);
        const isStageB = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
        if (isStageB) return new Response("boom", { status: 500 });
        return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : cleanNosell(r))));
      },
      rpcs: ["https://rpc-why-8.example"],
    }));

    // usdc-no-proof — مرحله‌ی WETH تمیز nosell، مرحله‌ی USDC مبهم می‌ماند
    await twice("usdc-no-proof", meta, (tick) => ({
      fetchImpl: async (url, init) => {
        tick();
        const reqs = JSON.parse(init.body);
        const isStageB = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
        return jsonRes(reqs.map((r) => {
          if (r.id === 0) return { id: 0, result: mkStatic4(5) };
          if (!isStageB) return cleanNosell(r);
          return ambiguous(r); // مرحله‌ی B هم با همان صفرِ SOLIDLY مبهم می‌ماند
        }));
      },
      rpcs: ["https://rpc-why-9.example"],
    }));

    // sell و nosell — whyOut.why باید undefined بماند
    {
      let calls1 = 0, calls2 = 0;
      const sellImpl = (tick) => async (url, init) => {
        tick();
        const reqs = JSON.parse(init.body);
        return jsonRes(reqs.map((r) => r.id === 0
          ? { id: 0, result: mkStatic4(5) }
          : { id: r.id, result: r.id === 1 ? mkStatic4(777) : "0x" }));
      };
      const v1 = await vd.fetchVerdict(TOKEN, meta,
        { fetchImpl: sellImpl(() => calls1++), rpcs: ["https://rpc-why-10.example"] });
      const whyOut = {};
      const v2 = await vd.fetchVerdict(TOKEN, meta,
        { fetchImpl: sellImpl(() => calls2++), rpcs: ["https://rpc-why-10.example"], whyOut });
      ok(v1 === "sell" && v2 === "sell" && calls1 === calls2,
         "[sell] verdict/call-count must be identical with/without whyOut, got " + v1 + "/" + v2);
      ok(whyOut.why === undefined,
         "[sell] whyOut.why must stay undefined on a sell verdict, got " + JSON.stringify(whyOut));
    }
    {
      let calls1 = 0, calls2 = 0;
      const nosellImpl = (tick) => async (url, init) => {
        tick();
        const reqs = JSON.parse(init.body);
        return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : cleanNosell(r))));
      };
      const v1 = await vd.fetchVerdict(TOKEN, meta,
        { fetchImpl: nosellImpl(() => calls1++), rpcs: ["https://rpc-why-11.example"] });
      const whyOut = {};
      const v2 = await vd.fetchVerdict(TOKEN, meta,
        { fetchImpl: nosellImpl(() => calls2++), rpcs: ["https://rpc-why-11.example"], whyOut });
      ok(v1 === "nosell" && v2 === "nosell" && calls1 === calls2,
         "[nosell] verdict/call-count must be identical with/without whyOut, got " + v1 + "/" + v2);
      ok(whyOut.why === undefined,
         "[nosell] whyOut.why must stay undefined on a nosell verdict, got " + JSON.stringify(whyOut));
    }
  }

  // ج) GET /vd/<Base>(بدونِ probe=1)، سرتاسری از رویِ worker.fetch — هر why
  // که اینجا دیده می‌شود باید isBaseWhy را پاس کند، و هیچ بدنه‌ای هرگز نباید
  // "http"/"://" یا CG_KEYِ همین بخش را درز بدهد.
  const allWhyC = [];
  const allBodiesC = [];
  {
    const { UPSTREAM_KEYED: UK_C } = await import("./index.js");
    const CG_SECRET_C = "SECRET-CG-KEY-FOR-27B";
    const envC = { ASSETS, CG_KEY: CG_SECRET_C };
    const w = (n) => BigInt(n).toString(16).padStart(64, "0");
    const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);
    const jsonResC = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
    const gtMeta = (priceUsd) => new Response(JSON.stringify({ data: { attributes: {
      name: "Why C Token", symbol: "WHYC", total_reserve_in_usd: "1000",
      decimals: 18, price_usd: priceUsd,
    } } }), { status: 200, headers: { "content-type": "application/json" } });
    const cleanNosellRow = (r) => (isSolidlyReqId(r.id) ? { id: r.id, error: { code: 3 } } : { id: r.id, result: "0x" });
    // آدرسِ متمایز + cf-connecting-ip متمایز به‌ازای هر سناریو — دومی برای
    // اینکه محدودکننده‌ی نرخ (بستهٔ «vd») بینِ سناریوها قاطی نشود.
    let ipTailC = 230;
    async function probe(addr, dispatch) {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = dispatch;
      ipTailC++;
      const res = await call("/vd/" + addr, { headers: { "cf-connecting-ip": "203.0.113." + ipTailC } }, envC);
      const raw = await res.text();
      allBodiesC.push(raw);
      globalThis.fetch = savedFetch;
      return { res, body: JSON.parse(raw) };
    }

    // C۱) اندپوینتِ tokens غیر-۲۰۰ (۴۲۹) → why:"meta:429"، دقیقاً ms,v,why
    {
      const { res, body } = await probe("0x" + "1".repeat(40), async (url) => {
        const u = String(url);
        if (u.startsWith(UK_C)) return new Response("rate limited", { status: 429 });
        throw new Error("unexpected upstream call in why-C1: " + u);
      });
      ok(res.status === 200, "a 429 from the GT tokens endpoint must still answer 200, got " + res.status);
      ok(body.v === null && body.why === "meta:429",
         "a 429 from the GT tokens endpoint must surface why:\"meta:429\", got " + JSON.stringify(body));
      ok(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["ms", "v", "why"]),
         "the body must carry exactly ms,v,why, got " + JSON.stringify(Object.keys(body)));
      allWhyC.push(body.why);
    }

    // C۲) fetch به اندپوینتِ tokens پرتاب می‌کند → why:"meta:0"
    {
      const { body } = await probe("0x" + "2".repeat(40), async (url) => {
        const u = String(url);
        if (u.startsWith(UK_C)) throw new Error("network is down");
        throw new Error("unexpected upstream call in why-C2: " + u);
      });
      ok(body.v === null && body.why === "meta:0",
         "a thrown GT tokens fetch must surface why:\"meta:0\", got " + JSON.stringify(body));
      allWhyC.push(body.why);
    }

    // C۳) متادیتا سالم ولی price_usd "0" (بدونِ مقدار) → why:"no-amount"، بدونِ فراخوانیِ RPC
    {
      let rpcCalls = 0;
      const { body } = await probe("0x" + "3".repeat(40), async (url) => {
        const u = String(url);
        if (u.startsWith(UK_C)) return gtMeta("0");
        rpcCalls++;
        throw new Error("must never reach the RPC when the amount is null");
      });
      ok(body.v === null && body.why === "no-amount",
         "price_usd \"0\" must surface why:\"no-amount\", got " + JSON.stringify(body));
      ok(rpcCalls === 0, "no-amount must never reach the RPC, got " + rpcCalls + " calls");
      allWhyC.push(body.why);
    }

    // C۴) متادیتا سالم، RPC یک nosellِ تمیز می‌دهد، pools فقط یک دکسِ
    // پوشش‌نداده‌شده دارد → why:"cover:false"
    {
      const { body } = await probe("0x" + "4".repeat(40), async (url, init) => {
        const u = String(url);
        if (u.endsWith("/pools")) {
          return new Response(JSON.stringify({ data: [
            { relationships: { dex: { data: { id: "uniswap-v4-base" } } } },
          ] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (u.startsWith(UK_C)) return gtMeta("2000");
        const reqs = JSON.parse(init.body);
        return jsonResC(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : cleanNosellRow(r))));
      });
      ok(body.v === null && body.why === "cover:false",
         "an uncovered-only pools body must surface why:\"cover:false\", got " + JSON.stringify(body));
      allWhyC.push(body.why);
    }

    // C۴ب) همان، ولی pools خودش ۴۲۹ می‌گیرد → why:"cover:429"
    {
      const { body } = await probe("0x" + "5".repeat(40), async (url, init) => {
        const u = String(url);
        if (u.endsWith("/pools")) return new Response("rate limited", { status: 429 });
        if (u.startsWith(UK_C)) return gtMeta("2000");
        const reqs = JSON.parse(init.body);
        return jsonResC(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : cleanNosellRow(r))));
      });
      ok(body.v === null && body.why === "cover:429",
         "a 429 from the pools endpoint must surface why:\"cover:429\", got " + JSON.stringify(body));
      allWhyC.push(body.why);
    }

    // C۵) یک sell — کلیدها دقیقاً ms,v، بدونِ why
    {
      const { body } = await probe("0x" + "6".repeat(40), async (url, init) => {
        const u = String(url);
        if (u.startsWith(UK_C)) return gtMeta("2000");
        const reqs = JSON.parse(init.body);
        return jsonResC(reqs.map((r) => r.id === 0
          ? { id: 0, result: mkStatic4(5) }
          : { id: r.id, result: r.id === 1 ? mkStatic4(777) : "0x" }));
      });
      ok(body.v === "sell", "sanity: this scenario must verdict sell, got " + JSON.stringify(body));
      ok(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["ms", "v"]),
         "a sell body must carry exactly ms,v (no why key), got " + JSON.stringify(Object.keys(body)));
    }

    // C۶) بالادستِ tokens جواب نمی‌دهد تا تایم‌اوت → why:"meta:timeout" (نه "meta:0")
    //     — تشخیص از signal.aborted، پس fetchِ جعلی فقط وقتی سیگنال abort شد رد می‌کند.
    const hangUntilAbort = (init) => new Promise((_, reject) => {
      const sig = init && init.signal;
      if (!sig) return; // بدونِ سیگنال هرگز برنمی‌گردد — خودِ تست گیر می‌کند و لو می‌رود
      sig.addEventListener("abort", () => reject(new Error("aborted")));
    });
    {
      const { body } = await probe("0x" + "7".repeat(40), async (url, init) => {
        const u = String(url);
        if (u.startsWith(UK_C)) return hangUntilAbort(init);
        throw new Error("unexpected upstream call in why-C6: " + u);
      });
      ok(body.v === null && body.why === "meta:timeout",
         "a GT tokens call that only ends by our own abort must surface why:\"meta:timeout\", got "
         + JSON.stringify(body));
      allWhyC.push(body.why);
    }

    // C۷) tokens ۲۰۰ ولی بدنه‌ای که pickTokenMeta نمی‌خواند → why:"meta:shape"
    {
      const { body } = await probe("0x" + "8".repeat(40), async (url) => {
        const u = String(url);
        if (u.startsWith(UK_C)) return jsonResC({ data: [] });
        throw new Error("unexpected upstream call in why-C7: " + u);
      });
      ok(body.v === null && body.why === "meta:shape",
         "a 200 tokens body with no attributes must surface why:\"meta:shape\", got " + JSON.stringify(body));
      allWhyC.push(body.why);
    }

    // C۸) nosellِ خام، ولی pools تا تایم‌اوت جواب نمی‌دهد → why:"cover:timeout"
    {
      const { body } = await probe("0x" + "9".repeat(40), async (url, init) => {
        const u = String(url);
        if (u.endsWith("/pools")) return hangUntilAbort(init);
        if (u.startsWith(UK_C)) return gtMeta("2000");
        const reqs = JSON.parse(init.body);
        return jsonResC(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(5) } : cleanNosellRow(r))));
      });
      ok(body.v === null && body.why === "cover:timeout",
         "a pools call that only ends by our own abort must surface why:\"cover:timeout\", got "
         + JSON.stringify(body));
      allWhyC.push(body.why);
    }

    ok(allWhyC.length > 0 && allWhyC.every((w2) => vd.isBaseWhy(w2)),
       "every why observed in this subsection must pass isBaseWhy, got " + JSON.stringify(allWhyC));
    ok(allBodiesC.every((b) => !b.includes("http") && !b.includes("://") && !b.includes(CG_SECRET_C)),
       "no /vd/<addr> response body may ever contain \"http\", \"://\" or the CG_KEY value");
  }

  // د) runReportPass با fakeهای مستقیم — قراردادِ metaOf/verdictOf تازه
  {
    function makeKvD() {
      const store = new Map();
      return { store, get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v) => { store.set(k, v); } };
    }
    function mkAddrD(n) { return "0x" + n.toString(16).padStart(40, "0"); }
    function poolRowD(addr) {
      return {
        attributes: { reserve_in_usd: "9000", base_token_price_usd: "1",
          pool_created_at: "2026-09-14T00:00:00Z", volume_usd: { h24: "10" }, fdv_usd: "100" },
        relationships: { base_token: { data: { id: "base_" + addr } }, dex: { data: { id: "uniswap-v3-base" } } },
      };
    }
    const NOW_MS_D = Date.parse("2026-09-14T12:00:00.000Z");

    async function rowFor(addr, metaOf, verdictOf) {
      const kv = makeKvD();
      await runReportPass({
        kv, fetchPools: async () => [poolRowD(addr)], metaOf, verdictOf,
        now: () => NOW_MS_D, sleep: async () => {},
      });
      const doc = JSON.parse(await kv.get(reportKey(utcDateOf(NOW_MS_D))));
      return doc.rows.find((r) => r.address === addr);
    }

    // verdictOf اینجا دقیقاً همان رفتارِ واقعیِ ogFetchVerdictDetail را برای
    // meta:null تقلید می‌کند (why را از metaWhy می‌گیرد) — چون metaOf پرتاب
    // کرده، runReportPass باید metaWhy را خودش "internal" کرده باشد، و
    // آن باید تا ردیفِ ذخیره‌شده برسد.
    const rowThrow = await rowFor(mkAddrD(1),
      async () => { throw new Error("meta upstream is down"); },
      async (addr, meta, metaWhy) => ({ v: null, why: metaWhy }));
    ok(rowThrow && rowThrow.v === null && rowThrow.why === "internal",
       "a throwing metaOf must yield a stored row v:null why:\"internal\", got " + JSON.stringify(rowThrow));

    const rowMetaWhy = await rowFor(mkAddrD(2),
      async () => ({ meta: null, why: "meta:429" }),
      async (addr, meta, metaWhy) => ({ v: null, why: metaWhy }));
    ok(rowMetaWhy && rowMetaWhy.v === null && rowMetaWhy.why === "meta:429",
       "verdictOf {v:null, why:\"meta:429\"} must be stored as-is, got " + JSON.stringify(rowMetaWhy));

    const rowBogus = await rowFor(mkAddrD(3),
      async () => ({ meta: { symbol: "T3", name: "Token Three" }, why: null }),
      async () => ({ v: null, why: "bogus" }));
    ok(rowBogus && rowBogus.v === null && rowBogus.why === "internal",
       "a why outside the closed vocabulary must be stored as \"internal\", got " + JSON.stringify(rowBogus));

    const rowSellWhy = await rowFor(mkAddrD(4),
      async () => ({ meta: { symbol: "T4", name: "Token Four" }, why: null }),
      async () => ({ v: "sell", why: "no-quote" }));
    ok(rowSellWhy && rowSellWhy.v === "sell" && rowSellWhy.why === null,
       "a why alongside v:\"sell\" must never survive into the stored row, got " + JSON.stringify(rowSellWhy));

    const rowBareNull = await rowFor(mkAddrD(5),
      async () => ({ meta: { symbol: "T5", name: "Token Five" }, why: null }),
      async () => null);
    ok(rowBareNull && rowBareNull.v === null && rowBareNull.why === "internal",
       "a bare-null (old shape) verdictOf must degrade to v:null why:\"internal\", got " + JSON.stringify(rowBareNull));
  }

  // ه) سرتاسر — GET /report/run با یک KV جعلی که put را ثبت می‌کند، دقیقاً
  // همان الگوی تستِ سیم‌کشیِ کرون («و‌.۳» بالاتر)
  {
    const { UPSTREAM_FREE: UF_E } = await import("./index.js");
    const savedFetch = globalThis.fetch;
    const POOL_ROW_E = {
      attributes: {
        base_token_price_usd: "1500", reserve_in_usd: "20000",
        pool_created_at: "2026-09-14T00:00:00Z",
        volume_usd: { h24: "500" }, fdv_usd: "10000",
      },
      relationships: {
        base_token: { data: { id: "base_0x" + "f".repeat(40) } },
        dex: { data: { id: "uniswap-v3-base" } },
      },
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/new_pools")) return new Response(JSON.stringify({ data: [POOL_ROW_E] }),
        { status: 200, headers: { "content-type": "application/json" } });
      if (u.startsWith(UF_E)) return new Response("rate limited", { status: 429 });
      // پروبِ سقفِ ساب‌ریکوئست — انتظاری، نه یک تماسِ ناخواسته.
      if (u.includes("/networks?page=1")) return new Response("", { status: 200 });
      throw new Error("unexpected upstream call in why-E: " + u);
    };
    const puts = [];
    const fakeKvE = { get: async () => null, put: async (k, v) => { puts.push({ k, v }); } };
    const envE = { ASSETS, ZX_KV: fakeKvE, RUN_KEY: "why-e-run-key" };
    const res = await call("/report/run", { method: "GET", headers: { "x-run-key": "why-e-run-key" } }, envE);
    ok(res.status === 200, "GET /report/run must be 200, got " + res.status);
    const body = await res.json();
    ok(body.checked === 1, "exactly the one fresh token must be checked, got " + JSON.stringify(body));
    const reportPut = puts.find((p) => p.k.startsWith("report:"));
    ok(!!reportPut, "the report:<date> key must have been written, got keys: " + JSON.stringify(puts.map((p) => p.k)));
    const storedDoc = reportPut && JSON.parse(reportPut.v);
    ok(storedDoc && storedDoc.rows.length === 1,
       "the stored report doc must carry exactly one row, got " + (storedDoc && storedDoc.rows.length));
    const row = storedDoc && storedDoc.rows[0];
    ok(row && row.v === null && row.why === "meta:429",
       "a 429 from the GT tokens endpoint, through the full cron pass, must store v:null why:\"meta:429\", got " +
       JSON.stringify(row));
    globalThis.fetch = savedFetch;
  }

  // و) مسیرِ کارتِ OG (/t/<addr>) دست‌نخورده — همان ogFetchVerdict (حالا یک
  // نازک‌پوششِ ogFetchVerdictDetail) همچنان بدونِ کرش کار می‌کند
  {
    const { UPSTREAM_FREE: UF_F } = await import("./index.js");
    const ADDR_F = "0x" + "7".repeat(40);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF_F)) {
        return new Response(JSON.stringify({ data: { attributes: {
          name: "OG Untouched Token", symbol: "OGU", total_reserve_in_usd: "1000",
          decimals: 18, price_usd: "2000",
        } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const reqs = JSON.parse(init.body);
      return new Response(JSON.stringify(reqs.map((r) => (r.id === 0
        ? { id: 0, result: "0x" + "0".repeat(64) }
        : { id: r.id, result: "0x" }))), { status: 200, headers: { "content-type": "application/json" } });
    };
    const res = await call("/t/" + ADDR_F, { headers: { "cf-connecting-ip": "203.0.113.220" } });
    ok(res.status === 200, "GET /t/<addr> must still be 200 after the why plumbing, got " + res.status);
    globalThis.fetch = savedFetch;
  }

  globalThis.fetch = trackingFetch; // برگرداندنِ موکِ پیش‌فرض برای هرچه بعد از این اجرا می‌شود

  console.log("[base why] isBaseWhy accepts exactly VD_BASE_WHY plus prefix+1-3-digit-status for meta/cover, "
    + "nothing else; fetchVerdict's opts.whyOut is a pure observer covering all nine null-reasons "
    + "(no-amount/deadline/rpc-down/canary-dead/no-quote/proof-rpc/proof-no-quote/usdc-rpc/usdc-no-proof) "
    + "plus sell/nosell leaving why undefined, each verified identical verdict and call count with/without "
    + "whyOut; GET /vd/<Base>(non-probe) end to end surfaces meta:<status>/meta:0/no-amount/cover:<status> "
    + "with the why key present only when v is null (a sell body stays exactly {v,ms}), never leaking "
    + "\"http\"/\"://\"/the CG_KEY; runReportPass normalizes metaOf/verdictOf's {meta,why}/{v,why} shape "
    + "(a throw, an old bare-null, or a why outside the closed vocabulary all degrade to \"internal\", and "
    + "why is always null alongside a sell/nosell verdict), verified both via direct fakes and end to end "
    + "through GET /report/run with a fake KV; and the OG-card path (/t/<addr>) is unaffected");
}

/* ---- ۲۹. worker/verdict.js — bestPositive ----
   بزرگ‌ترین مقدارِ مثبتِ رمزگشایی‌شده در batch، یا null. همان decodeItemValue
   که verdictFrom استفاده می‌کند، پس نمونه‌ها همان شکل‌های آشنا هستند: مثبت،
   صفر، ریوِرت، و شکلِ رمزگشایی‌ناپذیر (بریده/kindِ ناشناخته). */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);
  const mkStatic2 = (n) => "0x" + w(n) + w(0);

  const mixedItems = [
    { kind: "CL_UINT24", result: mkStatic4(250) },              // مثبت
    { kind: "CL_UINT24", result: mkStatic4(0) },                // صفر
    { kind: "CL_UINT24", error: { code: 3 } },                  // ریوِرتِ اثباتی
    { kind: "CL_UINT24", result: "0x1234" },                    // بریده — رمزگشایی‌ناپذیر
    { kind: "CL_UINT24", result: mkStatic4(900) },               // بزرگ‌ترینِ مثبت
    { kind: "V4_SINGLE", result: mkStatic2(300) },               // مثبتِ کوچک‌تر، kindِ دیگر
    { kind: "MADE_UP_KIND", result: mkStatic4(5000) },           // kindِ ناشناخته → decodeQuote خودش null می‌دهد
    null,
    undefined,
  ];
  ok(vd.bestPositive({ items: mixedItems }) === 900n,
     "bestPositive must pick the largest positive across mixed items, got " +
     vd.bestPositive({ items: mixedItems }));

  const noPositiveItems = [
    { kind: "CL_UINT24", result: mkStatic4(0) },
    { kind: "CL_UINT24", error: { code: 3 } },
    { kind: "CL_UINT24", result: "0x1234" },
  ];
  ok(vd.bestPositive({ items: noPositiveItems }) === null,
     "bestPositive must return null when there is no positive item, got " +
     vd.bestPositive({ items: noPositiveItems }));

  // هرگز پرتاب نمی‌کند، حتی روی یک batchِ کاملاً بدشکل.
  const malformedBatches = [
    null, undefined, {}, "not-an-object", 42,
    { items: null }, { items: "nope" }, { items: 5 },
    { items: [{ kind: "CL_UINT24", result: 123 }] },      // result نه رشته
    { items: [{ kind: "CL_UINT24", result: "0xzzzz" }] }, // هگزِ نامعتبر
    { items: [{}] }, { items: [1, "x", true] },
  ];
  for (const b of malformedBatches) {
    let threw = false;
    let res;
    try { res = vd.bestPositive(b); } catch (e) { threw = true; }
    ok(!threw, "bestPositive must never throw on a malformed batch, got a throw for " + JSON.stringify(b));
    ok(res === null || typeof res === "bigint",
       "bestPositive must return null or a BigInt even on a malformed batch, got " + res + " for " +
       JSON.stringify(b));
  }

  console.log("[verdict bestPositive] bestPositive picks the largest positive across mixed items " +
    "(positive/zero/revert/undecodable/unknown-kind), returns null when there is no positive, and " +
    "never throws on a malformed batch");
}

/* ---- ۳۰. worker/verdict.js — canaryUsdPerEth ----
   قیمتِ دلاریِ ۱ اتر از رویِ همان کاناریِ ۰٫۰۱ WETH→USDC؛ باندِ عقل‌سنجیِ
   ۵۰ تا ۱۰۰۰۰۰ هر عددِ پرت را دور می‌ریزد، نه فقط کاناریِ خراب/ریوِرتی را. */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);

  // واقعی — ۳۰ USDC برای ۰٫۰۱ WETH → ۱ اتر = ۳۰۰۰ دلار
  ok(vd.canaryUsdPerEth({ canary: { result: mkStatic4(30000000) } }) === 3000,
     "canaryUsdPerEth must compute the expected price from a realistic canary, got " +
     vd.canaryUsdPerEth({ canary: { result: mkStatic4(30000000) } }));

  // غایب
  ok(vd.canaryUsdPerEth({}) === null, "canaryUsdPerEth must be null with no canary at all");
  ok(vd.canaryUsdPerEth(null) === null, "canaryUsdPerEth must never throw on a null batch, must give null");

  // صفر
  ok(vd.canaryUsdPerEth({ canary: { result: mkStatic4(0) } }) === null,
     "canaryUsdPerEth must be null for a zero canary");

  // ریوِرتی
  ok(vd.canaryUsdPerEth({ canary: { error: { code: 3 } } }) === null,
     "canaryUsdPerEth must be null for an errored canary");

  // پرتِ پایین (زیرِ ۵۰) — قیمت=۱۰
  ok(vd.canaryUsdPerEth({ canary: { result: mkStatic4(100000) } }) === null,
     "canaryUsdPerEth must be null for a price below the 50 sanity floor");

  // پرتِ بالا (بالای ۱۰۰۰۰۰) — قیمت=۲۰۰۰۰۰
  ok(vd.canaryUsdPerEth({ canary: { result: mkStatic4(2000000000) } }) === null,
     "canaryUsdPerEth must be null for a price above the 100000 sanity ceiling");

  console.log("[verdict canaryUsdPerEth] a realistic canary gives the exact expected USD/ETH price; " +
    "a missing, zero, errored, or out-of-[50,100000]-band canary all give null");
}

/* ---- ۳۱. worker/verdict.js — retPctFrom ----
   درصدِ برگشتِ یک کوتِ فروش در برابرِ VD_NOTIONAL_USD؛ فیکسچرها طوری
   ساخته شده‌اند که پاسخ یک عددِ گِردِ دقیق باشد، نه چیزی که فقط «نزدیک»
   سنجیده شود. */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);

  // مرحله‌ی WETH با کاناریِ زنده — قیمت=۱۲۰۰۰، بهترینِ خروجی=۰٫۰۰۷۵ WETH
  // → بازیافتی=۹۰ دلار → ۹۰٪ از صد دلار، دقیقاً.
  const wethBatch = {
    canary: { result: mkStatic4(120000000) },
    items: [{ kind: "CL_UINT24", result: mkStatic4(7500000000000000) }],
  };
  ok(vd.retPctFrom(wethBatch, "weth") === 90,
     "retPctFrom(weth) must equal exactly 90 for the built fixture, got " + vd.retPctFrom(wethBatch, "weth"));

  // مرحله‌ی USDC کاناری نمی‌خواهد — ۵۰ USDC بازیافتی از رویِ صد دلار = ۵۰٪.
  const usdcBatch = { items: [{ kind: "CL_UINT24", result: mkStatic4(50000000) }] };
  ok(vd.retPctFrom(usdcBatch, "usdc") === 50,
     "retPctFrom(usdc) must equal exactly 50 with no canary at all, got " + vd.retPctFrom(usdcBatch, "usdc"));

  // نتیجه‌ای که بعدِ گردکردن صفر می‌شود → null، نه صفر.
  const dustBatch = { items: [{ kind: "CL_UINT24", result: mkStatic4(1) }] };
  ok(vd.retPctFrom(dustBatch, "usdc") === null,
     "retPctFrom must be null (not zero) when the recovered amount rounds to 0%, got " +
     vd.retPctFrom(dustBatch, "usdc"));

  // پرت (بالای ۱۰۰۰٪) → null، نه یک عددِ کلمپ‌شده.
  const absurdBatch = { items: [{ kind: "CL_UINT24", result: mkStatic4(2000000000) }] };
  ok(vd.retPctFrom(absurdBatch, "usdc") === null,
     "retPctFrom must drop an out-of-band (>1000%) result, not clamp it, got " +
     vd.retPctFrom(absurdBatch, "usdc"));

  // WETH بدونِ کاناریِ قابلِ‌اعتماد → null.
  const noCanaryBatch = { items: [{ kind: "CL_UINT24", result: mkStatic4(7500000000000000) }] };
  ok(vd.retPctFrom(noCanaryBatch, "weth") === null,
     "retPctFrom(weth) must be null with no usable canary, got " + vd.retPctFrom(noCanaryBatch, "weth"));

  // stageِ ناشناخته → null.
  ok(vd.retPctFrom(usdcBatch, "eth") === null, "retPctFrom must be null for an unknown stage");
  ok(vd.retPctFrom(usdcBatch, undefined) === null, "retPctFrom must be null with no stage at all");

  console.log("[verdict retPctFrom] the WETH stage with a live canary and the USDC stage (no canary " +
    "needed) both yield exact round percentages for the built fixtures; a dust result that rounds to " +
    "0% and an absurd (>1000%) result both yield null rather than 0 or a clamped number; and an " +
    "unknown stage always yields null");
}

/* ---- ۳۲. fetchVerdict + opts.retOut ----
   دقیقاً همان انضباطِ opts.whyOut (بخشِ ۲۷ب): یک مشاهده‌گرِ محض که هرگز روی
   verdict یا شمارِ فراخوانی‌ها اثر نمی‌گذارد؛ فقط کنارِ یک "sell" واقعی
   چیزی می‌نویسد. */
{
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);
  const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const mkStatic2 = (n) => "0x" + w(n) + w(0);
  const TOKEN = "0x" + "e".repeat(40);
  const meta = { decimals: 18, priceUsd: 2000 };
  const usdcHexLower = vd.USDC_ADDR.slice(2).toLowerCase();
  const REAL_USDC_KEY_RET = {
    currency0: TOKEN.toLowerCase(), currency1: vd.USDC_ADDR.toLowerCase(),
    fee: 9990, tickSpacing: 100, hooks: vd.NATIVE_ADDR,
  };
  const cleanNosell = (r) => (isSolidlyReqId(r.id) ? { id: r.id, error: { code: 3 } } : { id: r.id, result: "0x" });
  const ambiguous = (r) => ({ id: r.id, error: { code: -32603 } });

  // sell از مرحله‌ی WETH — همان فیکسچرِ بخشِ ۳۱ (کاناری=۱۲۰۰۰، بهترین=۹۰٪).
  {
    const sellImpl = (tick) => async (url, init) => {
      tick();
      const reqs = JSON.parse(init.body);
      return jsonRes(reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(120000000) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(7500000000000000) : "0x" }));
    };
    let calls1 = 0;
    const v1 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: sellImpl(() => calls1++), rpcs: ["https://rpc-ret-1.example"] });
    let calls2 = 0;
    const retOut = {};
    const v2 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: sellImpl(() => calls2++), rpcs: ["https://rpc-ret-1.example"], retOut });
    ok(v1 === "sell" && v2 === "sell" && calls1 === calls2,
       "[sell] opts.retOut must never change the returned verdict/call-count, got v1=" + v1 + " v2=" + v2 +
       " calls1=" + calls1 + " calls2=" + calls2);
    ok(retOut.ret === 90, "[sell] retOut.ret must equal 90 for the WETH-stage fixture, got " +
       JSON.stringify(retOut));
  }

  // sell از مرحله‌ی USDC — مرحله‌ی WETH تمیز nosell می‌شود، بعد مرحله‌ی USDC
  // مثبت می‌دهد (۵۰ USDC روی صد دلار = ۵۰٪). این همان batchB است، نه batchA.
  {
    const stageBSellImpl = (tick) => async (url, init) => {
      tick();
      const reqs = JSON.parse(init.body);
      const isStageB = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
      return jsonRes(reqs.map((r) => {
        if (r.id === 0) return { id: 0, result: mkStatic4(120000000) };
        if (!isStageB) return cleanNosell(r);
        return { id: r.id, result: r.id === 1 ? mkStatic4(50000000) : "0x" };
      }));
    };
    let calls1 = 0;
    const v1 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: stageBSellImpl(() => calls1++), rpcs: ["https://rpc-ret-1b.example"] });
    let calls2 = 0;
    const retOut = {};
    const v2 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: stageBSellImpl(() => calls2++), rpcs: ["https://rpc-ret-1b.example"], retOut });
    ok(v1 === "sell" && v2 === "sell" && calls1 === calls2,
       "[usdc-stage sell] opts.retOut must never change the returned verdict/call-count, got v1=" + v1 +
       " v2=" + v2);
    ok(retOut.ret === 50, "[usdc-stage sell] retOut.ret must equal 50 for the USDC-stage fixture (batchB, " +
       "not batchA), got " + JSON.stringify(retOut));
  }

  // sell از گذرِ اثباتِ USDC (کلیدِ واقعیِ v4) — مرحله‌ی WETH مبهم می‌ماند،
  // گذرِ اثبات مثبت می‌دهد (۵۰ USDC = ۵۰٪). این همان batchP است.
  {
    const proofSellImpl = (tick) => async (url, init) => {
      tick();
      const reqs = JSON.parse(init.body);
      const isProof = reqs.some((r) => r.id >= 1 && r.params[0].data.includes(usdcHexLower));
      return jsonRes(reqs.map((r) => {
        if (r.id === 0) return { id: 0, result: mkStatic4(120000000) };
        if (!isProof) return ambiguous(r);
        return { id: r.id, result: mkStatic2(50000000) };
      }));
    };
    let calls1 = 0;
    const v1 = await vd.fetchVerdict(TOKEN, meta, { fetchImpl: proofSellImpl(() => calls1++),
      rpcs: ["https://rpc-ret-1c.example"], v4Keys: [REAL_USDC_KEY_RET] });
    let calls2 = 0;
    const retOut = {};
    const v2 = await vd.fetchVerdict(TOKEN, meta, { fetchImpl: proofSellImpl(() => calls2++),
      rpcs: ["https://rpc-ret-1c.example"], v4Keys: [REAL_USDC_KEY_RET], retOut });
    ok(v1 === "sell" && v2 === "sell" && calls1 === calls2,
       "[proof-pass sell] opts.retOut must never change the returned verdict/call-count, got v1=" + v1 +
       " v2=" + v2);
    ok(retOut.ret === 50, "[proof-pass sell] retOut.ret must equal 50 for the proof-pass fixture (batchP), " +
       "got " + JSON.stringify(retOut));
  }

  // nosell تمیز — retOut.ret باید undefined بماند.
  {
    const nosellImpl = (tick) => async (url, init) => {
      tick();
      const reqs = JSON.parse(init.body);
      return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(120000000) } : cleanNosell(r))));
    };
    let calls1 = 0;
    const v1 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: nosellImpl(() => calls1++), rpcs: ["https://rpc-ret-2.example"] });
    let calls2 = 0;
    const retOut = {};
    const v2 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: nosellImpl(() => calls2++), rpcs: ["https://rpc-ret-2.example"], retOut });
    ok(v1 === "nosell" && v2 === "nosell" && calls1 === calls2,
       "[nosell] opts.retOut must never change the returned verdict/call-count, got v1=" + v1 + " v2=" + v2);
    ok(retOut.ret === undefined, "[nosell] retOut.ret must stay undefined, got " + JSON.stringify(retOut));
  }

  // حکمِ null — retOut.ret باید undefined بماند.
  {
    const downImpl = (tick) => async () => { tick(); throw new Error("network is down"); };
    let calls1 = 0;
    const v1 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: downImpl(() => calls1++), rpcs: ["https://rpc-ret-3a.example", "https://rpc-ret-3b.example"] });
    let calls2 = 0;
    const retOut = {};
    const v2 = await vd.fetchVerdict(TOKEN, meta,
      { fetchImpl: downImpl(() => calls2++), retOut,
        rpcs: ["https://rpc-ret-3a.example", "https://rpc-ret-3b.example"] });
    ok(v1 === null && v2 === null && calls1 === calls2,
       "[null] opts.retOut must never change the returned verdict/call-count, got v1=" + v1 + " v2=" + v2);
    ok(retOut.ret === undefined, "[null] retOut.ret must stay undefined, got " + JSON.stringify(retOut));
  }

  console.log("[verdict retOut] fetchVerdict's opts.retOut is a pure observer covering all three \"sell\" " +
    "sites with their own batch (WETH stage/batchA, USDC stage/batchB, USDC proof-pass/batchP), each " +
    "setting retOut.ret to the exact expected percentage from its OWN batch; a clean \"nosell\" and a " +
    "null verdict both leave retOut.ret undefined; and in every case the returned verdict and fetch " +
    "call count are byte-for-byte identical with and without retOut");
}

/* ---- ۳۳. GET /vd/<Base> — کلیدِ ret ----
   دقیقاً هم‌رده‌ی بخشِ «C۵» در ۲۷ب برای why/cause: ret فقط کنارِ v:"sell" می‌نشیند. */
{
  const { UPSTREAM_FREE: UF_RET } = await import("./index.js");
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mkStatic4 = (n) => "0x" + w(n) + w(0) + w(0) + w(0);
  const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const gtMeta = (priceUsd) => new Response(JSON.stringify({ data: { attributes: {
    name: "Ret Token", symbol: "RETT", total_reserve_in_usd: "1000",
    decimals: 18, price_usd: priceUsd,
  } } }), { status: 200, headers: { "content-type": "application/json" } });
  const cleanNosellRow = (r) => (isSolidlyReqId(r.id) ? { id: r.id, error: { code: 3 } } : { id: r.id, result: "0x" });

  async function probeRet(addr, dispatch, ipTail) {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = dispatch;
    const res = await call("/vd/" + addr, { headers: { "cf-connecting-ip": "203.0.113." + ipTail } });
    const body = await res.json();
    globalThis.fetch = savedFetch;
    return { res, body };
  }

  // sell — کلیدها دقیقاً ms,ret,v
  {
    const { body } = await probeRet("0x" + "e".repeat(40), async (url, init) => {
      const u = String(url);
      if (u.startsWith(UF_RET)) return gtMeta("2000");
      const reqs = JSON.parse(init.body);
      return jsonRes(reqs.map((r) => r.id === 0
        ? { id: 0, result: mkStatic4(120000000) }
        : { id: r.id, result: r.id === 1 ? mkStatic4(7500000000000000) : "0x" }));
    }, 240);
    ok(body.v === "sell", "sanity: this scenario must verdict sell, got " + JSON.stringify(body));
    ok(body.ret === 90, "a sell /vd response must carry ret:90, got " + JSON.stringify(body));
    ok(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["ms", "ret", "v"]),
       "a sell body must carry exactly ms,ret,v, got " + JSON.stringify(Object.keys(body)));
  }

  // nosell — بدونِ کلیدِ ret. گاردِ پوشش هم باید عبور کند، وگرنه به نامعلوم
  // تنزل می‌کند — پس اندپوینتِ "/pools" هم یک دکسِ پوشش‌داده‌شده می‌دهد.
  {
    const { body } = await probeRet("0x" + "d".repeat(40), async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) {
        return jsonRes({ data: [{ relationships: { dex: { data: { id: "uniswap-v3-base" } } } }] });
      }
      if (u.startsWith(UF_RET)) return gtMeta("2000");
      const reqs = JSON.parse(init.body);
      return jsonRes(reqs.map((r) => (r.id === 0 ? { id: 0, result: mkStatic4(120000000) } : cleanNosellRow(r))));
    }, 241);
    ok(body.v === "nosell", "sanity: this scenario must verdict nosell, got " + JSON.stringify(body));
    ok(!("ret" in body), "a nosell /vd response must carry no ret key at all, got " + JSON.stringify(body));
  }

  // null — بدونِ کلیدِ ret
  {
    const { body } = await probeRet("0x" + "c".repeat(40), async (url) => {
      const u = String(url);
      if (u.startsWith(UF_RET)) return new Response("rate limited", { status: 429 });
      throw new Error("unexpected upstream call in the ret/null probe: " + u);
    }, 242);
    ok(body.v === null, "sanity: this scenario must verdict null, got " + JSON.stringify(body));
    ok(!("ret" in body), "a null /vd response must carry no ret key at all, got " + JSON.stringify(body));
  }

  console.log("[vd ret] GET /vd/<Base> carries ret only alongside v:\"sell\" (exactly ms,ret,v keys), " +
    "and never on a nosell or null response");
}

/* ---- ۳۴. worker/report.js — retForRow و ردیف ----
   دقیقاً هم‌انضباطِ causeForRow (بخشِ ۲۷ج): فقط verdict==="sell" و فقط عددی
   متناهی در بازه‌ی (۰, ۱۰۰۰] از این تابع زنده بیرون می‌آید. */
{
  ok(retForRow("sell", 42.3) === 42.3, "retForRow must let a valid ret survive on a sell row, got " +
     retForRow("sell", 42.3));
  ok(retForRow("nosell", 42.3) === undefined, "retForRow must drop ret on a nosell row");
  ok(retForRow(null, 42.3) === undefined, "retForRow must drop ret on a null verdict row");
  ok(retForRow("sell", 42.34) === 42.3, "retForRow must round to one decimal, got " + retForRow("sell", 42.34));

  for (const bad of [0, -5, 1001, NaN, Infinity, -Infinity, "42", null, undefined, "1000"]) {
    ok(retForRow("sell", bad) === undefined,
       "retForRow must drop " + JSON.stringify(bad) + " even on a sell row, got " +
       JSON.stringify(retForRow("sell", bad)));
  }
  ok(retForRow("sell", 1000) === 1000, "retForRow must let the boundary value 1000 survive");

  const T34 = "2026-09-20T00:00:00.000Z";
  function rowArgsRet(extra) {
    return Object.assign({ chain: "base", address: "0x" + "3".repeat(40), symbol: "T34", name: "T34",
      verdict: "sell", checkedAt: T34, poolCreatedAt: null, priceUsd: 1, reserveUsd: 1, vol24hUsd: 1,
      fdvUsd: 1, dex: "uniswap-v3-base", why: null }, extra);
  }

  const rowWithRet = reportRow(rowArgsRet({ ret: 55 }));
  ok(rowWithRet && rowWithRet.ret === 55,
     "reportRow must carry ret:55 through on a sell row, got " + JSON.stringify(rowWithRet));

  const rowNoRet = reportRow(rowArgsRet({}));
  ok(rowNoRet && !("ret" in rowNoRet),
     "reportRow must OMIT the ret key entirely when there is none, not store null — got " +
     JSON.stringify(rowNoRet));

  const rowNosellRet = reportRow(rowArgsRet({ verdict: "nosell", ret: 55 }));
  ok(rowNosellRet && !("ret" in rowNosellRet),
     "reportRow must never let a ret survive on a nosell verdict, got " + JSON.stringify(rowNosellRet));

  const rowNullRet = reportRow(rowArgsRet({ verdict: null, ret: 55 }));
  ok(rowNullRet && !("ret" in rowNullRet),
     "reportRow must never let a ret survive on a null verdict, got " + JSON.stringify(rowNullRet));

  const rowJunkRet = reportRow(rowArgsRet({ ret: 1001 }));
  ok(rowJunkRet && !("ret" in rowJunkRet),
     "reportRow must drop an out-of-band ret even on a sell row, got " + JSON.stringify(rowJunkRet));

  console.log("[report ret] retForRow enforces the sell-only + (0,1000] finite-number discipline " +
    "(0/negative/1001/NaN/±Infinity/string all dropped, rounded to one decimal otherwise, exactly like " +
    "causeForRow's vocabulary check); reportRow OMITS the ret key entirely when there is none " +
    "(undefined, never a stored null) exactly like cause");
}

/* ---- ۳۵. worker/report.js — reportText، خطِ میانه‌ی ret ----
   فقط با حداقل ۵ ردیفِ retدار یک خطِ تازه می‌آید، درست بعدِ «had a sell "
   route quoted.»؛ با کمتر از ۵ ردیف متن بایت‌به‌بایت همان چیزی می‌ماند که
   بدونِ هیچ retای بود؛ برای تعدادِ زوج عضوِ پایین‌ترِ دو وسطی انتخاب می‌شود. */
{
  function mkRowRet(overrides) {
    return Object.assign({
      chain: "base", address: "0x" + "2".repeat(40), symbol: null, name: null,
      v: "sell", checkKind: "sell-quote", checkedAt: "2026-09-14T00:00:00.000Z",
      poolCreatedAt: null, priceUsd: null, reserveUsd: null, vol24hUsd: null, fdvUsd: null, dex: null,
    }, overrides);
  }
  function mkAddrRet(n) { return "0x" + n.toString(16).padStart(40, "0"); }

  // پنج ردیف — میانه با گردکردنِ عددِ اعشاری به عددِ صحیح.
  const fiveVals = [10, 90, 50.6, 30, 70];
  const rowsFive = fiveVals.map((r, i) => mkRowRet({ address: mkAddrRet(400 + i), ret: r }));
  const tFive = reportText({ date: "2026-09-14", generatedAt: null, rows: rowsFive });
  ok(typeof tFive === "string" && tFive.includes(
    "0 had no sell route quoted.\n5 had a sell route quoted.\n" +
    "A $100 sell quote came back at 51% for the median of them.\n0 could not be checked."),
    "5 ret rows must add the median line right after \"had a sell route quoted.\", with the exact " +
    "median (50.6 rounded to 51), got " + JSON.stringify(tFive));

  // چهار ردیف — بایت‌به‌بایت همان سندِ بدونِ هیچ retای.
  const fourVals = [10, 90, 50, 30];
  const rowsFour = fourVals.map((r, i) => mkRowRet({ address: mkAddrRet(410 + i), ret: r }));
  const rowsFourNoRet = rowsFour.map(({ ret, ...rest }) => rest);
  const tFourWith = reportText({ date: "2026-09-14", generatedAt: null, rows: rowsFour });
  const tFourNoRet = reportText({ date: "2026-09-14", generatedAt: null, rows: rowsFourNoRet });
  ok(tFourWith === tFourNoRet,
     "with fewer than 5 ret rows, reportText must be byte-for-byte identical to the same document with " +
     "no ret fields at all, got:\n" + JSON.stringify(tFourWith) + "\nvs\n" + JSON.stringify(tFourNoRet));
  ok(!tFourWith.includes("median of them"),
     "with 4 ret rows the median line must not appear at all, got " + JSON.stringify(tFourWith));

  // شش ردیف — عضوِ پایین‌ترِ دو وسطی (۳۰، نه ۴۰).
  const sixVals = [50, 10, 60, 30, 40, 20];
  const rowsSix = sixVals.map((r, i) => mkRowRet({ address: mkAddrRet(420 + i), ret: r }));
  const tSix = reportText({ date: "2026-09-14", generatedAt: null, rows: rowsSix });
  ok(tSix.includes("A $100 sell quote came back at 30% for the median of them."),
     "6 ret rows must use the lower of the two middle values (30, not 40, and never an average), got " +
     JSON.stringify(tSix));

  console.log("[report text ret] reportText adds \"A $100 sell quote came back at NN% for the median " +
    "of them.\" immediately after the \"had a sell route quoted.\" line only with 5+ numeric-ret rows, " +
    "rounds the median to a whole number, uses the lower of the two middle values for an even count, " +
    "and with fewer than 5 such rows the text is byte-for-byte identical to a document with no ret " +
    "fields at all");
}

/* گاردِ واژگانِ ممنوع — تنها جایی که این گارد زندگی می‌کند همین فایلِ تست
   است (خودِ worker/report.js چنین regexای ندارد؛ ساختار، نه واژه‌شماری،
   تضمینِ اصلی است — نگاه کن به CHECK_KIND_BY_CHAIN بالای report.js). دو
   بخشِ زیر (۲۸ و ۳۹) از همین یک regex و همین یک تابعِ حذفِ استثناها
   استفاده می‌کنند تا هر دو دقیقاً یک قاعده را بسنجند.
   🔴 استثنا عمداً باریک است: فقط رشته‌های *ثابتِ* زیر (هرکدام یک substring
   دقیق، نه یک الگو) حذف می‌شوند — یک regexِ عمومیِ «هر خطی که simulat
   دارد» دقیقاً همان شکافی است که این گارد باید جلویش را بگیرد. */
const FORBIDDEN_WORDING = /round.?trip|simulat|safe|verified|honeypot|tax|blacklist|revert|cannot be sold/i;
const ALLOWED_WORDING_PHRASES = [
  "not a simulated round trip",
  "failed a simulated buy and sell.",
  "passed a simulated buy and sell.",
  " — failed the simulated buy and sell",
  "On Solana, the buy and the sell are simulated together.",
];
function stripAllowedWording(t) {
  let out = t;
  for (const phrase of ALLOWED_WORDING_PHRASES) out = out.split(phrase).join("");
  return out;
}

/* ---- ۲۸. متنِ گزارش — reportText و /report/<...>.txt ----
   🔴 روی Base رفت‌وبرگشت نداریم — این بخش با یک regex تضمین می‌کند هیچ متنِ
   تولیدشده در کلِ این بخش کلمه‌ای مثل "round trip"، "simulat"، "safe"،
   "verified"، "honeypot"، "tax"، "blacklist"، "revert" یا "cannot be sold"
   نگفته باشد — به‌جز عبارتِ مجازِ ثابتِ فوتر.
   🔴 symbol از بالادست می‌آید و کنترلش دستِ ما نیست؛ اینجا با چند symbolِ
   خصمانه سنجیده می‌شود که هرگز عیناً در متنِ خروجی ننشیند.
   🔴 report:2026-09-07 هنوز ردیف‌های nosellِ نادرست دارد — cutoff باید پیش
   از هر خواندنِ KV رد کند، نه بعدش. */
{
  const textsProduced = [];
  function rt(doc) {
    const t = reportText(doc);
    if (typeof t === "string") textsProduced.push(t);
    return t;
  }

  function mkRow(overrides) {
    return Object.assign({
      chain: "base",
      address: "0x" + "2".repeat(40),
      symbol: null,
      name: null,
      v: "sell",
      checkKind: "sell-quote",
      checkedAt: "2026-09-14T00:00:00.000Z",
      poolCreatedAt: null,
      priceUsd: null,
      reserveUsd: null,
      vol24hUsd: null,
      fdvUsd: null,
      dex: null,
    }, overrides);
  }
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }

  // الف) رشته‌ی دقیقِ نمونه‌ی چهار-ردیفی از خودِ اسپک
  const rowSpacex = mkRow({
    address: "0xebc185ed974f5257d11164e70b9324b9527aca8e", symbol: "SPACEX", v: "sell",
  });
  const rowLapcat = mkRow({ address: mkAddr(1), symbol: "LAPCAT", v: null });
  const rowBaseTok = mkRow({ address: mkAddr(2), symbol: "BASE", v: null });
  const rowRugme = mkRow({
    address: "0x1111111111111111111111111111111111111111", symbol: "RUGME", v: "nosell",
  });
  const docA = {
    date: "2026-09-14", generatedAt: "2026-09-14T23:17:15.207Z", chains: ["base"],
    checked: 210, rows: [rowSpacex, rowLapcat, rowBaseTok, rowRugme],
  };
  const EXPECTED_A = "Exit Report · 14 Sep\n\n4 new Base tokens checked.\n1 had no sell route "
    + "quoted.\n1 had a sell route quoted.\n2 could not be checked.\n\n$RUGME — no sell route "
    + "quoted\nzaexa.com/t/0x1111111111111111111111111111111111111111\n\nSell quotes on Base DEXes, "
    + "not a simulated round trip.\nLast check 23:17 UTC.\n";
  const tA = rt(docA);
  ok(tA === EXPECTED_A, "the 4-row fixture must produce the exact spec'd string, got " +
     JSON.stringify(tA));

  // ب) مفرد در برابر جمع
  const doc1 = { date: "2026-09-14", generatedAt: null, rows: [mkRow({ v: "sell", address: mkAddr(3) })] };
  const t1 = rt(doc1);
  ok(t1.includes("1 new Base token checked."), "a single checked token must say \"token\", not "
     + "\"tokens\", got: " + JSON.stringify(t1));
  ok(!t1.includes("tokens"), "singular count must never contain the word \"tokens\", got: " +
     JSON.stringify(t1));

  // ج) صفر ردیف
  const docEmpty = { date: "2026-09-14", generatedAt: "2026-09-14T23:17:15.207Z", rows: [] };
  const tEmpty = rt(docEmpty);
  ok(tEmpty === "Exit Report · 14 Sep\n\nNo new Base tokens were checked.\n",
     "an empty-rows doc must produce exactly the zero-token body, got " + JSON.stringify(tEmpty));

  // د) صفر پرچم
  const docZeroFlag = {
    date: "2026-09-14", generatedAt: null,
    rows: [mkRow({ v: "sell", address: mkAddr(4) }), mkRow({ v: null, address: mkAddr(5) })],
  };
  const tZero = rt(docZeroFlag);
  ok(tZero.includes("0 had no sell route quoted."), "zero flagged rows must still print the count "
     + "line, got: " + JSON.stringify(tZero));
  ok(!tZero.includes("zaexa.com/t/"), "zero flagged rows must list nothing, got: " + JSON.stringify(tZero));
  // 🔴 بدونِ پرچم هم پانویس باید با یک خطِ خالی از شمارش‌ها جدا بماند.
  ok(tZero === "Exit Report · 14 Sep\n\n2 new Base tokens checked.\n0 had no sell route quoted.\n"
     + "1 had a sell route quoted.\n1 could not be checked.\n\n"
     + "Sell quotes on Base DEXes, not a simulated round trip.\n",
     "zero flagged rows must produce exactly the counts, one blank line, then the footer, got: "
     + JSON.stringify(tZero));

  // ه) سقفِ فهرست — ۱۲ پرچم، فقط ۱۰ لیست‌شده، بقیه در «+more»
  const rows12 = Array.from({ length: 12 }, (_, i) => mkRow({ v: "nosell", address: mkAddr(300 + i) }));
  const doc12 = { date: "2026-09-14", generatedAt: null, rows: rows12 };
  const t12 = rt(doc12);
  const linkMatches = t12.match(/zaexa\.com\/t\//g) || [];
  ok(linkMatches.length === 10, "12 flagged rows must list exactly 10 token links, got " +
     linkMatches.length);
  ok(t12.includes("+2 more: zaexa.com/report/2026-09-14.json"),
     "the overflow line must name the remaining 2 and point at the full JSON report, got: " +
     JSON.stringify(t12));

  // و) symbolهای خصمانه — هرگز عیناً در متن، همیشه به آدرسِ کوتاه‌شده سقوط می‌کند
  const HOSTILE_SYMBOLS = [
    "SAFE\nzaexa.com/t/0xdead", "a b", "https://x", "", 12345, null, "ÆTHER",
    "ABCDEFGHIJKLMNOPQ", "ZAEXA.COM", "$SAFE",
  ];
  const HOSTILE_ADDR = "0x1111111111111111111111111111111111111111";
  for (const sym of HOSTILE_SYMBOLS) {
    const docH = {
      date: "2026-09-14", generatedAt: null,
      rows: [mkRow({ v: "nosell", address: HOSTILE_ADDR, symbol: sym })],
    };
    const tH = rt(docH);
    ok(tH.includes("0x1111…1111 — no sell route quoted"),
       "hostile symbol " + JSON.stringify(sym) + " must fall back to the truncated-address label, got: "
       + JSON.stringify(tH));
    if (typeof sym === "string" && sym.length > 0) {
      ok(!tH.includes(sym), "hostile symbol " + JSON.stringify(sym) +
         " must never appear verbatim in the report text");
    }
  }
  const docSpacexSym = {
    date: "2026-09-14", generatedAt: null,
    rows: [mkRow({ v: "nosell", address: HOSTILE_ADDR, symbol: "SPACEX" })],
  };
  ok(rt(docSpacexSym).includes("$SPACEX — no sell route quoted"),
     "a whitelisted symbol must be labeled \"$SYMBOL\"");

  // ز) هر v غیرِ sell/nosell یعنی «نمی‌توان چک کرد» — هرگز لیست نمی‌شود؛ sell هم هرگز لیست نمی‌شود
  const docUnchecked = {
    date: "2026-09-14", generatedAt: null,
    rows: [
      mkRow({ v: null, address: mkAddr(101) }),
      mkRow({ v: undefined, address: mkAddr(102) }),
      mkRow({ v: "maybe", address: mkAddr(103) }),
      mkRow({ v: "NOSELL", address: mkAddr(104) }),
      mkRow({ v: "sell", address: mkAddr(105) }),
    ],
  };
  const tUnchecked = rt(docUnchecked);
  ok(tUnchecked.includes("0 had no sell route quoted."), "null/undefined/\"maybe\"/\"NOSELL\" must "
     + "never count as flagged, got: " + JSON.stringify(tUnchecked));
  ok(tUnchecked.includes("1 had a sell route quoted."), "exactly the one \"sell\" row must count as "
     + "quoted, got: " + JSON.stringify(tUnchecked));
  ok(tUnchecked.includes("4 could not be checked."), "null/undefined/\"maybe\"/\"NOSELL\" must all "
     + "land in could-not-be-checked, got: " + JSON.stringify(tUnchecked));
  ok(!tUnchecked.includes("zaexa.com/t/"), "no row may be listed when none is flagged, got: " +
     JSON.stringify(tUnchecked));

  // ح) ردیف‌های نامربوط — chain غلط، checkKind ناجور، آدرسِ بزرگ‌حرف — در هیچ شمارشی حساب نمی‌شوند
  const rowValidH = mkRow({ v: "sell", address: mkAddr(201) });
  const rowSolana = mkRow({ chain: "solana", checkKind: "roundtrip", v: "nosell", address: mkAddr(202) });
  const rowBadCheckKind = mkRow({ chain: "base", checkKind: "roundtrip", v: "nosell", address: mkAddr(203) });
  const rowUpperAddr = mkRow({
    chain: "base", checkKind: "sell-quote", v: "nosell", address: "0x" + "A".repeat(40),
  });
  const docH = {
    date: "2026-09-14", generatedAt: null,
    rows: [rowValidH, rowSolana, rowBadCheckKind, rowUpperAddr],
  };
  const tH = rt(docH);
  ok(tH.includes("1 new Base token checked."), "a solana row, a base row with the wrong checkKind, "
     + "and an uppercase address must all be ignored, got: " + JSON.stringify(tH));
  ok(tH.includes("0 had no sell route quoted."), "none of the three ignored rows may count as "
     + "flagged, got: " + JSON.stringify(tH));
  ok(!tH.includes("zaexa.com/t/"), "none of the three ignored rows may be listed, got: " +
     JSON.stringify(tH));

  // ط) گاردِ تاریخ
  ok(reportText({ date: "2026-09-07", generatedAt: null, rows: [] }) === null,
     "the day before the cutoff must return null, even with rows:[]");
  ok(typeof rt({ date: "2026-09-08", generatedAt: null, rows: [] }) === "string",
     "the cutoff date itself must be allowed");
  ok(reportText({ date: "nope", generatedAt: null, rows: [] }) === null,
     "an unparseable date must return null");
  ok(reportText(null) === null, "a null doc must return null");
  ok(reportText({ date: "2026-09-14", generatedAt: null, rows: "not-an-array" }) === null,
     "rows that are not an array must return null");

  // ی) generatedAt خراب — فقط خطِ «Last check» غایب می‌شود، بقیه دست‌نخورده
  const docJValid = {
    date: "2026-09-14", generatedAt: "2026-09-14T23:17:15.207Z",
    rows: [mkRow({ v: "sell", address: mkAddr(6) })],
  };
  const docJBad = { ...docJValid, generatedAt: "garbage" };
  const tJValid = rt(docJValid);
  const tJBad = rt(docJBad);
  ok(!tJBad.includes("Last check"), "an unparseable generatedAt must omit the Last check line "
     + "entirely, got: " + JSON.stringify(tJBad));
  ok(tJValid === tJBad.slice(0, -1) + "\nLast check 23:17 UTC.\n",
     "a bad generatedAt must change nothing else about the text, only drop the Last check line");

  /* ---- مسیرِ /report/<...>.txt — از رویِ worker.fetch ---- */
  const envNoKvTxt = { ASSETS };

  // ل) بدونِ env.ZX_KV
  const rNoKv = await call("/report/today.txt", { method: "GET" }, envNoKvTxt);
  ok(rNoKv.status === 503, "GET /report/today.txt without ZX_KV must be 503, got " + rNoKv.status);
  ok(rNoKv.headers.get("content-type") === "text/plain; charset=utf-8",
     "the .txt route must answer text/plain, got " + rNoKv.headers.get("content-type"));
  ok(rNoKv.headers.get("cache-control") === "no-store",
     "every error response on this route must be no-store, got " + rNoKv.headers.get("cache-control"));
  ok((await rNoKv.text()) === "report store unavailable\n",
     "the no-KV body must be exactly \"report store unavailable\\n\"");

  // م) متد غلط، تاریخِ بدشکل
  const rPostTxt = await call("/report/today.txt", { method: "POST" }, envNoKvTxt);
  ok(rPostTxt.status === 405 && (await rPostTxt.text()) === "only GET\n",
     "POST /report/today.txt must be 405 \"only GET\\n\", got " + rPostTxt.status);
  const rBadDateTxt = await call("/report/nope.txt", { method: "GET" }, envNoKvTxt);
  ok(rBadDateTxt.status === 400 && (await rBadDateTxt.text()) === "bad date\n",
     "GET /report/nope.txt must be 400 \"bad date\\n\", got " + rBadDateTxt.status);

  // ن) گاردِ تاریخ پیش از هر خواندنِ KV
  let cutoffGetCalls = 0;
  const kvCutoffSpy = { get: async () => { cutoffGetCalls++; return null; } };
  const rCutoffTxt = await call("/report/2026-09-07.txt", { method: "GET" },
    { ASSETS, ZX_KV: kvCutoffSpy });
  ok(rCutoffTxt.status === 404 &&
     (await rCutoffTxt.text()) === "no text report before " + REPORT_TEXT_FIRST_DATE + "\n",
     "a pre-cutoff date must 404 with the cutoff message, got " + rCutoffTxt.status);
  ok(cutoffGetCalls === 0, "the cutoff must be checked before any kv.get call, got " + cutoffGetCalls
     + " calls");

  // س) کلیدِ غایب
  const kvMissing = { get: async () => null };
  const rMissingTxt = await call("/report/2026-09-10.txt", { method: "GET" },
    { ASSETS, ZX_KV: kvMissing });
  ok(rMissingTxt.status === 404 && (await rMissingTxt.text()) === "no report for 2026-09-10 yet\n",
     "a missing key must be 404 \"no report for <date> yet\\n\", got " + rMissingTxt.status);

  // ع) kv.get پرتاب می‌کند
  const kvThrows = { get: async () => { throw new Error("kv is down"); } };
  const rThrowsTxt = await call("/report/2026-09-10.txt", { method: "GET" },
    { ASSETS, ZX_KV: kvThrows });
  ok(rThrowsTxt.status === 503 && (await rThrowsTxt.text()) === "report store unavailable\n",
     "a throwing kv.get must be 503 \"report store unavailable\\n\", got " + rThrowsTxt.status);

  // ف) JSON خراب، و سندِ معتبر با تاریخِ نادرست
  const kvBadJson = { get: async () => "{bad" };
  const rBadJsonTxt = await call("/report/2026-09-10.txt", { method: "GET" },
    { ASSETS, ZX_KV: kvBadJson });
  ok(rBadJsonTxt.status === 503 && (await rBadJsonTxt.text()) === "report unreadable\n",
     "unparseable JSON in KV must be 503 \"report unreadable\\n\", got " + rBadJsonTxt.status);
  const kvWrongDate = { get: async () => JSON.stringify({ date: "2026-09-11", rows: [] }) };
  const rWrongDateTxt = await call("/report/2026-09-10.txt", { method: "GET" },
    { ASSETS, ZX_KV: kvWrongDate });
  ok(rWrongDateTxt.status === 503 && (await rWrongDateTxt.text()) === "report unreadable\n",
     "a stored doc whose date does not match the requested date must be 503 \"report unreadable\\n\", "
     + "got " + rWrongDateTxt.status);

  // ص) گذرِ خوش‌مسیر — کلیدِ درخواست‌شده، بدنه، عمرِ کش، هدرها
  let askedKey = null;
  const kvGood = { get: async (k) => { askedKey = k; return JSON.stringify(docA); } };
  const rGoodTxt = await call("/report/2026-09-14.txt", { method: "GET" }, { ASSETS, ZX_KV: kvGood });
  ok(rGoodTxt.status === 200, "a well-formed stored doc must answer 200, got " + rGoodTxt.status);
  const bodyGoodTxt = await rGoodTxt.text();
  ok(bodyGoodTxt === reportText(docA), "the route's body must equal reportText(doc) exactly");
  ok(rGoodTxt.headers.get("cache-control") === "public, max-age=86400",
     "a past date must cache 86400s at the edge, got " + rGoodTxt.headers.get("cache-control"));
  ok(askedKey === "report:2026-09-14", "the route must ask KV for reportKey(dateStr), got " +
     JSON.stringify(askedKey));
  ok(rGoodTxt.headers.get("x-content-type-options") === "nosniff",
     "every response on this route must carry x-content-type-options: nosniff");

  // ق) today.txt روی همان سند — عمرِ کشِ کوتاه‌تر
  const todayStr = utcDateOf(Date.now());
  const docToday = { ...docA, date: todayStr };
  const kvToday = { get: async () => JSON.stringify(docToday) };
  const rTodayTxt = await call("/report/today.txt", { method: "GET" }, { ASSETS, ZX_KV: kvToday });
  ok(rTodayTxt.status === 200 && rTodayTxt.headers.get("cache-control") === "public, max-age=300",
     "/report/today.txt must be 200 and cache 300s at the edge, got " + rTodayTxt.status + " " +
     rTodayTxt.headers.get("cache-control"));

  // ر) رگرسیون — /report/<date>.json دست‌نخورده می‌ماند
  const rJsonRegression = await call("/report/2026-09-14.json", { method: "GET" },
    { ASSETS, ZX_KV: kvGood });
  ok(rJsonRegression.status === 200 &&
     (rJsonRegression.headers.get("content-type") || "").startsWith("application/json"),
     "GET /report/2026-09-14.json must remain untouched (200, application/json), got " +
     rJsonRegression.status + " " + rJsonRegression.headers.get("content-type"));

  // ک) گاردِ واژگان — روی هر متنی که این بخش تولید کرد
  for (const t of textsProduced) {
    ok(!FORBIDDEN_WORDING.test(stripAllowedWording(t)),
       "a report text must never use forbidden wording outside the one allowed phrase, got: " +
       JSON.stringify(t));
  }

  console.log("[report text] worker/report.js's reportText() and GET /report/<...>.txt ok — the "
    + "4-row spec fixture matches byte-for-byte; singular/plural token counts; zero-rows and "
    + "zero-flagged bodies; the flagged list caps at 10 with a \"+N more\" pointer at the full JSON; "
    + "hostile symbols (newlines, URLs, punctuation, non-ASCII, length 17, empty, non-string, null) "
    + "never appear verbatim and always fall back to the truncated-address label, while a whitelisted "
    + "symbol renders as \"$SYMBOL\"; null/undefined/\"maybe\"/\"NOSELL\" all count as could-not-be-"
    + "checked and are never listed, and \"sell\" rows are never listed either; a solana row, a base "
    + "row with the wrong checkKind, and an uppercase address are ignored in every count; the "
    + REPORT_TEXT_FIRST_DATE + " cutoff returns null (and, on the route, 404 before any kv.get call); "
    + "a bad generatedAt drops only the Last check line; the .txt route mirrors reportRoute's KV-error "
    + "handling (503 on missing/throwing binding, 404 on a missing key, 503 on bad JSON or a mismatched "
    + "date) without reusing reportDocFor's empty-doc conflation, serves text/plain with nosniff and "
    + "no-store on every error, caches 86400s for a past date and 300s for today, and leaves GET "
    + "/report/<date>.json unaffected; and no text produced anywhere in this section uses forbidden "
    + "wording outside the one allowed phrase");
}

/* ---- /pairs — نسخه‌ی تمیزِ آدرس برای web/pairs.html ----
   خط Build در پنل امروز web/pairs.html را داخل _site کپی می‌کند، پس
   بایندینگ [assets] معمولاً خودش زودتر از این مسیر جواب می‌دهد و شرطِ
   /pairs در worker/index.js در عمل هرگز اجرا نمی‌شود — همان‌طور که کدِ
   خودش هم می‌گوید. اینجا با یک ASSETS جاسوس دقیقاً همان رفتار سنجیده
   می‌شود: pathname درخواستی از /pairs به /pairs.html تغییر می‌کند، نه
   کمتر و نه بیشتر، و بدنه‌ی پاسخِ ASSETS بدون دست‌خوردن برمی‌گردد. */
{
  let asked = [];
  const spyEnv = { ASSETS: { fetch: async (req) => {
    asked.push(new URL(req.url).pathname);
    return new Response("pairs page body", { status: 200 });
  } } };
  const res = await worker.fetch(new Request(ORIGIN + "/pairs"), spyEnv, {});
  ok(res.status === 200, "GET /pairs must return the ASSETS body's status (got " + res.status + ")");
  ok((await res.text()) === "pairs page body",
     "GET /pairs must return exactly what ASSETS.fetch gave it, unmodified");
  ok(asked.length === 1 && asked[0] === "/pairs.html",
     "GET /pairs must ask ASSETS for \"/pairs.html\", got " + JSON.stringify(asked));

  // بدونِ env.ASSETS: نباید پرتاب کند و نباید ۵۰۰ بدهد — مسیر باید بی‌صدا
  // به رفتارِ امروز (که خودش هم بدونِ ASSETS چهار-صد-چهار می‌دهد) سقوط کند.
  let threw = null;
  let resNoAssets = null;
  try {
    resNoAssets = await worker.fetch(new Request(ORIGIN + "/pairs"), {}, {});
  } catch (e) {
    threw = e;
  }
  ok(threw === null, "GET /pairs with no env.ASSETS must not throw, threw: " + threw);
  ok(resNoAssets && resNoAssets.status !== 500,
     "GET /pairs with no env.ASSETS must not 500, got " + (resNoAssets && resNoAssets.status));

  // /pairs نباید /pairs.json را سایه بیندازد — pathname فرق دارد، ولی
  // چون هر دو با «/pairs» شروع می‌شوند، این را صریح می‌سنجیم.
  const rPairsJson = await call("/pairs.json?chain=base", { method: "GET" }, { ASSETS: spyEnv.ASSETS });
  const bPairsJson = await rPairsJson.json();
  ok(rPairsJson.status === 200 && Array.isArray(bPairsJson.rows) && bPairsJson.chain === "base",
     "GET /pairs.json?chain=base must still behave exactly as today, got " + JSON.stringify(bPairsJson));
  ok(asked.length === 1,
     "GET /pairs.json?chain=base must never be handed to ASSETS by the new /pairs route, asked=" +
     JSON.stringify(asked));

  // مسیرهای شبیه ولی نه دقیقاً «/pairs» نباید گرفته شوند
  for (const bad of ["/pairsX", "/pairs/"]) {
    asked = [];
    const rBad = await worker.fetch(new Request(ORIGIN + bad), spyEnv, {});
    ok(!(asked.length === 1 && asked[0] === "/pairs.html"),
       bad + " must not be captured by the /pairs route, asked=" + JSON.stringify(asked));
    ok(rBad.status !== undefined, bad + " must still get a response, not throw");
  }

  console.log("[pairs route] GET /pairs asks ASSETS for exactly \"/pairs.html\" and returns its body "
    + "untouched; a missing env.ASSETS falls through without throwing or 500ing; GET /pairs.json?"
    + "chain=base is unaffected (never handed to ASSETS); /pairsX and /pairs/ are not captured");
}

/* ---- pairsRowsFor — پیوستِ follow/recheck در زمانِ خواندن — [pairs merge] ----
   حلقه‌ی pairs:base:latest فقط یک بار نوشته می‌شود و هرگز follow/recheck
   نمی‌گیرد؛ pairsRowsFor باید این دو کلید را در زمانِ خواندن از سندِ روزانه
   (امروز، بعد دیروز، امروز برنده) قرض بگیرد، بدونِ اینکه خودِ حلقه یا هیچ
   کلیدِ دیگرِ هر ردیف دست بخورد. */
{
  const T = "2026-09-20T12:00:00.000Z"; // فقط برای generatedAt سندهای زیر
  const todayStr = utcDateOf(Date.now());
  const yesterdayStr = utcDateOf(Date.now() - 86400000);

  function mkKv(map) {
    return { get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null) };
  }
  function addr(n) { return "0x" + n.toString(16).padStart(40, "0"); }

  const addrFollow = addr(0x10);       // v:"sell" در حلقه، follow معتبر در سندِ امروز
  const addrRecheck = addr(0x11);      // v:null در حلقه، recheck:"nosell" معتبر در سندِ امروز
  const addrBadFollow = addr(0x12);    // v:"sell"، ولی follow="maybe" (نامعتبر)
  const addrWrongVerdict = addr(0x13); // v:"nosell" در حلقه — سندِ امروز follow دارد ولی نباید بگیرد
  const addrUnrelated = addr(0x14);    // فقط یک کلیدِ نامربوط در سند عوض شده، بدونِ follow/recheck
  const addrYesterdayOnly = addr(0x15); // follow فقط در سندِ دیروز
  const addrTodayWins = addr(0x16);     // follow در هر دو سند، امروز باید ببرد
  const addrNotInAnyDoc = addr(0x17);   // در هیچ سندی نیست

  const ring = [
    { address: addrFollow, v: "sell", tag: "keep-me-1" },
    { address: addrRecheck, v: null, tag: "keep-me-2" },
    { address: addrBadFollow, v: "sell", tag: "keep-me-3" },
    { address: addrWrongVerdict, v: "nosell", tag: "keep-me-4" },
    { address: addrUnrelated, v: "sell", priceUsd: 1, tag: "keep-me-5" },
    { address: addrYesterdayOnly, v: "sell", tag: "keep-me-6" },
    { address: addrTodayWins, v: "sell", tag: "keep-me-7" },
    { address: addrNotInAnyDoc, v: "sell", tag: "keep-me-8" },
  ];

  const todayDoc = {
    date: todayStr, generatedAt: T, chains: ["base"], checked: 8,
    rows: [
      { address: addrFollow, v: "sell", follow: "pool-empty", followAt: "2026-09-20T13:00:00.000Z" },
      {
        address: addrRecheck, v: null, recheck: "nosell", recheckAt: "2026-09-20T13:00:00.000Z",
        recheckCause: "empty-pool",
      },
      { address: addrBadFollow, v: "sell", follow: "maybe", followAt: "2026-09-20T13:00:00.000Z" },
      { address: addrWrongVerdict, v: "sell", follow: "pool-there", followAt: "2026-09-20T13:00:00.000Z" },
      { address: addrUnrelated, v: "sell", priceUsd: 999 }, // بدونِ follow/recheck — فقط یک کلیدِ نامربوط
      { address: addrTodayWins, v: "sell", follow: "pool-empty", followAt: "2026-09-20T13:00:00.000Z" },
    ],
  };
  const yesterdayDoc = {
    date: yesterdayStr, generatedAt: T, chains: ["base"], checked: 2,
    rows: [
      {
        address: addrYesterdayOnly, v: "sell", follow: "pool-there", followAt: "2026-09-19T13:00:00.000Z",
      },
      { address: addrTodayWins, v: "sell", follow: "pool-there", followAt: "2026-09-19T13:00:00.000Z" },
    ],
  };

  const kv = mkKv({
    [PAIRS_KEY_BASE]: JSON.stringify(ring),
    [reportKey(todayStr)]: JSON.stringify(todayDoc),
    [reportKey(yesterdayStr)]: JSON.stringify(yesterdayDoc),
  });
  const rows = await pairsRowsFor({ ZX_KV: kv }, "base");

  ok(Array.isArray(rows) && rows.length === ring.length,
     "the merged rows must keep the ring's exact length, got " + (rows && rows.length));
  ok(rows.map((r) => r.address).join(",") === ring.map((r) => r.address).join(","),
     "the merged rows must keep the ring's exact order, got " + JSON.stringify(rows.map((r) => r.address)));

  const byAddr = new Map(rows.map((r) => [r.address, r]));

  const rFollow = byAddr.get(addrFollow);
  ok(rFollow.follow === "pool-empty" && rFollow.followAt === "2026-09-20T13:00:00.000Z" &&
     rFollow.tag === "keep-me-1" && rFollow.v === "sell",
     "a sell row must carry follow+followAt copied from today's doc, got " + JSON.stringify(rFollow));

  const rRecheck = byAddr.get(addrRecheck);
  ok(rRecheck.recheck === "nosell" && rRecheck.recheckAt === "2026-09-20T13:00:00.000Z" &&
     rRecheck.recheckCause === "empty-pool" && rRecheck.tag === "keep-me-2" && rRecheck.v === null,
     "a null-verdict row must carry recheck+recheckAt+recheckCause copied from today's doc, got " +
     JSON.stringify(rRecheck));

  const rBadFollow = byAddr.get(addrBadFollow);
  ok(!("follow" in rBadFollow) && !("followAt" in rBadFollow),
     "an invalid follow string (\"maybe\") must never be copied, got " + JSON.stringify(rBadFollow));

  const rWrongVerdict = byAddr.get(addrWrongVerdict);
  ok(!("follow" in rWrongVerdict) && !("followAt" in rWrongVerdict),
     "a follow must never be copied onto a ring row whose own v is not \"sell\", even when the doc row " +
     "says sell, got " + JSON.stringify(rWrongVerdict));

  const rUnrelated = byAddr.get(addrUnrelated);
  ok(rUnrelated.priceUsd === 1 && !("follow" in rUnrelated) && !("recheck" in rUnrelated),
     "unrelated keys of the doc row (priceUsd) must never be copied onto the ring row, got " +
     JSON.stringify(rUnrelated));

  const rYesterdayOnly = byAddr.get(addrYesterdayOnly);
  ok(rYesterdayOnly.follow === "pool-there" && rYesterdayOnly.followAt === "2026-09-19T13:00:00.000Z",
     "a follow present only in yesterday's doc must still be copied, got " + JSON.stringify(rYesterdayOnly));

  const rTodayWins = byAddr.get(addrTodayWins);
  ok(rTodayWins.follow === "pool-empty" && rTodayWins.followAt === "2026-09-20T13:00:00.000Z",
     "today's doc must win over yesterday's for the same address, got " + JSON.stringify(rTodayWins));

  const rNotInAnyDoc = byAddr.get(addrNotInAnyDoc);
  ok(!("follow" in rNotInAnyDoc) && !("recheck" in rNotInAnyDoc) && rNotInAnyDoc.tag === "keep-me-8",
     "a ring row absent from both docs must come back exactly as it was, got " + JSON.stringify(rNotInAnyDoc));

  // یک سندِ نامعتبر (JSON خراب) → حلقه دقیقاً همان چیزی برمی‌گردد که بود —
  // reportDocFor هرگز پرتاب نمی‌کند، فقط سندِ خالی می‌دهد.
  const kvBadDoc = mkKv({
    [PAIRS_KEY_BASE]: JSON.stringify(ring),
    [reportKey(todayStr)]: "{not valid json",
    [reportKey(yesterdayStr)]: "{also not valid",
  });
  const rowsBadDoc = await pairsRowsFor({ ZX_KV: kvBadDoc }, "base");
  ok(JSON.stringify(rowsBadDoc) === JSON.stringify(ring),
     "invalid JSON in either report doc must leave the ring rows exactly as stored, got " +
     JSON.stringify(rowsBadDoc));

  console.log("[pairs merge] pairsRowsFor ok — follow+followAt and recheck+recheckAt(+recheckCause) are "
    + "borrowed at read time from today's/yesterday's report doc (today winning on a shared address) onto "
    + "matching pairs:base:latest ring rows, validated with followForRow/recheckForRow/causeForRow against "
    + "the RING row's own v (never the doc row's); an invalid follow string, a follow on a ring row whose "
    + "v is not \"sell\", and any unrelated key of the doc row are all never copied; a ring row in neither "
    + "doc, or a doc that fails to parse, comes back byte-for-byte unchanged; and the ring's own order and "
    + "length are always preserved");
}

/* ---- ۳۶. worker/report.js — newPoolRowToTokenFor زنجیره‌آگاه ----
   فیکسچرِ سولانا امروز از خودِ پراکسیِ زنده گرفته شد: صفحه‌ی ۱ی new_pools
   هیچ استخری بالای آستانه‌ی رزرو نداشت، سه‌تای واجدِ شرطِ صفحه‌ی ۲ به‌ترتیب
   $48416/$11220/$7721 بودند، و dex‌هایشان pumpswap/meteora-dbc/pump-fun.
   هر عدد در پاسخِ واقعی رشته است، دقیقاً مثلِ Base. */
{
  const REAL_SOL_POOL_ROW = {
    id: "solana_5ZoUg31NuEfDLDJfTh8hJGiavENmE2deDUBT4hhcpump",
    type: "pool",
    attributes: {
      base_token_price_usd: "0.000034521",
      reserve_in_usd: "48416.32",
      pool_created_at: "2026-09-20T09:12:00Z",
      volume_usd: { h24: "12345.6" },
      fdv_usd: "34521.9",
    },
    relationships: {
      base_token: { data: { id: "solana_5ZoUg31NuEfDLDJfTh8hJGiavENmE2deDUBT4hhcpump" } },
      dex: { data: { id: "pumpswap" } },
    },
  };
  const SOL_MINT_ORIG = "5ZoUg31NuEfDLDJfTh8hJGiavENmE2deDUBT4hhcpump";

  // ۱. یک ردیفِ واقعیِ سولانا → mint دقیقاً همان، حروف دست‌نخورده
  const tokSol = newPoolRowToTokenFor("solana", REAL_SOL_POOL_ROW);
  ok(tokSol !== null, "the real Solana new_pools fixture must yield a usable token");
  ok(tokSol && tokSol.address === SOL_MINT_ORIG,
     "the mint must be carried through exactly, got " + (tokSol && tokSol.address));
  // 🔴 اثباتِ صریح: نتیجه نباید با نسخه‌ی lowercase یکی باشد — این mint حروفِ
  // بزرگ واقعی دارد، پس اگر کدی جایی toLowerCase زده باشد اینجا رد می‌شود.
  ok(tokSol && tokSol.address !== SOL_MINT_ORIG.toLowerCase(),
     "a Solana mint must NEVER be lowercased, got " + (tokSol && tokSol.address));
  ok(tokSol && tokSol.reserveUsd === 48416.32,
     "reserve_in_usd (a STRING) must be Number()-parsed for a Solana row too, got " +
     (tokSol && tokSol.reserveUsd));
  ok(tokSol && tokSol.dex === "pumpswap", "dex id not carried through for a Solana row");

  // ۲. یک ردیفِ Base هنوز دقیقاً مثلِ امروز نگاشت می‌شود
  const REAL_BASE_POOL_ROW = {
    attributes: {
      base_token_price_usd: "0.00105608666453529",
      reserve_in_usd: "1035070.5289",
      pool_created_at: "2026-09-07T16:47:23Z",
      volume_usd: { h24: "2.48003" },
      fdv_usd: "1056084.154",
    },
    relationships: {
      base_token: { data: { id: "base_0xb200000000000000000000c573ceb6905ec145da" } },
      dex: { data: { id: "uniswap-v3-base" } },
    },
  };
  const tokBase = newPoolRowToTokenFor("base", REAL_BASE_POOL_ROW);
  ok(tokBase && tokBase.address === "0xb200000000000000000000c573ceb6905ec145da",
     "newPoolRowToTokenFor(\"base\", …) must behave exactly like today's newPoolRowToToken, got " +
     (tokBase && tokBase.address));

  // ۳. یک ردیفِ «سولانا» با idِ شکلِ Base → null (پیشوندِ اشتباه/الفبای اشتباه)
  function poolWithId(id, attrs) {
    return { attributes: attrs, relationships: { base_token: { data: { id } }, dex: { data: { id: "pumpswap" } } } };
  }
  const solRowBaseId = poolWithId("base_0x" + "1".repeat(40), REAL_SOL_POOL_ROW.attributes);
  ok(newPoolRowToTokenFor("solana", solRowBaseId) === null,
     "a Solana-chain call with a Base-shaped id must return null");

  // ۴. یک ردیفِ «Base» با idِ شکلِ سولانا → null
  const baseRowSolId = poolWithId("solana_" + SOL_MINT_ORIG, REAL_BASE_POOL_ROW.attributes);
  ok(newPoolRowToTokenFor("base", baseRowSolId) === null,
     "a Base-chain call with a Solana-shaped id must return null");

  // ۵. زنجیره‌ی ناشناخته → null
  ok(newPoolRowToTokenFor("ethereum", REAL_SOL_POOL_ROW) === null,
     "an unknown chain must return null regardless of the row's shape");
  ok(newPoolRowToTokenFor("ethereum", REAL_BASE_POOL_ROW) === null,
     "an unknown chain must return null regardless of the row's shape (Base-shaped row too)");

  // ۶. زیرِ آستانه‌ی رزرو → null (روی سولانا هم)
  const solLowReserve = poolWithId("solana_" + SOL_MINT_ORIG,
    { ...REAL_SOL_POOL_ROW.attributes, reserve_in_usd: "4999.99" });
  ok(newPoolRowToTokenFor("solana", solLowReserve) === null,
     "a Solana row under REPORT_MIN_RESERVE_USD must be rejected just like a Base row");

  // ۲ (تکمیل). پوششِ نازکِ newPoolRowToToken — بایت‌به‌بایت همان
  // newPoolRowToTokenFor("base", …)
  for (const row of [REAL_BASE_POOL_ROW, solRowBaseId, poolWithId("base_0x0000000000000000000000000000000000000000", REAL_BASE_POOL_ROW.attributes)]) {
    ok(JSON.stringify(newPoolRowToToken(row)) === JSON.stringify(newPoolRowToTokenFor("base", row)),
       "newPoolRowToToken must remain a byte-for-byte thin wrapper over newPoolRowToTokenFor(\"base\", …), " +
       "diverged on " + JSON.stringify(row && row.relationships && row.relationships.base_token));
  }

  console.log("[report chain map] newPoolRowToTokenFor ok — the real Solana new_pools fixture (string "
    + "numbers, a \"solana_…pump\" id) maps with the mint preserved exactly, case intact, and is proven "
    + "NOT lowercased; a Base row still maps exactly as today; a Solana-chain call with a Base-shaped id, "
    + "a Base-chain call with a Solana-shaped id, an unknown chain (either row shape), and a Solana row "
    + "under the reserve floor all return null; newPoolRowToToken stays a byte-for-byte thin wrapper over "
    + "newPoolRowToTokenFor(\"base\", …)");
}

/* ---- ۳۷. runReportPass — پایِ سولانا، تزریقی ----
   fetchPoolsSol/solMaxTokens/metaOf/verdictOf همه جعلی؛ هیچ شبکه‌ی واقعی
   لازم نیست. metaOf/verdictOf عمداً زنجیره‌آگاه نوشته نشده‌اند (دقیقاً مثلِ
   worker/index.js واقعی که ogFetchMetaDetail/ogFetchVerdictDetail را برای
   هر دو زنجیره یکسان تزریق می‌کند) — فقط از رویِ شکلِ آدرس (0x…/mint)
   تشخیص می‌دهند. */
{
  function makeKv() {
    const store = new Map();
    const putCalls = [];
    return {
      store, putCalls,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); putCalls.push(k); },
    };
  }
  function mkAddr(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  // الفبای base58 معتبر (بدونِ 0/O/I/l) — تولیدِ deterministic چند mintِ
  // معتبرِ ۴۴نویسه‌ای برای فیکسچرها.
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function mkSolAddr(n) {
    let s = "";
    const x = n + 1000;
    for (let i = 0; i < 44; i++) s += B58[(x + i * 7) % B58.length];
    return s;
  }
  function poolRow(addr, reserve, price) {
    return {
      attributes: { reserve_in_usd: String(reserve), base_token_price_usd: String(price),
        pool_created_at: "2026-09-20T10:00:00Z", volume_usd: { h24: "0" }, fdv_usd: "0" },
      relationships: { base_token: { data: { id: "base_" + addr } }, dex: { data: { id: "uniswap-v3-base" } } },
    };
  }
  function solPoolRow(addr, reserve, price, dex) {
    return {
      attributes: { reserve_in_usd: String(reserve), base_token_price_usd: String(price),
        pool_created_at: "2026-09-20T09:00:00Z", volume_usd: { h24: "100" }, fdv_usd: "1000" },
      relationships: { base_token: { data: { id: "solana_" + addr } }, dex: { data: { id: dex } } },
    };
  }
  const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");
  const metaOf = async () => ({ meta: { symbol: "X", name: "X" }, why: null });

  // ---- الف) هر دو پا با هم: سند هر دو زنجیره را دارد ----
  {
    const solAddrs = [mkSolAddr(1), mkSolAddr(2), mkSolAddr(3)];
    // اندازه‌گیریِ واقعی: از سه mintِ واجدِ شرط، دو تا "sell" شدند و یکی
    // {v:null, why:"jup:quote:400"} — دقیقاً همان توزیع اینجا بازسازی می‌شود.
    const verdictOf = async (addr) => {
      if (addr === solAddrs[2]) return { v: null, why: "jup:quote:400" };
      return { v: "sell", why: null };
    };
    const baseRows = [poolRow(mkAddr(1), 10000, 0.5)];
    const solRows = [
      solPoolRow(solAddrs[0], 48416, 0.001, "pumpswap"),
      solPoolRow(solAddrs[1], 11220, 0.002, "meteora-dbc"),
      solPoolRow(solAddrs[2], 7721, 0.003, "pump-fun"),
    ];
    const kv = makeKv();
    const res = await runReportPass({
      kv, fetchPools: async () => baseRows, fetchPoolsSol: async () => solRows,
      metaOf, verdictOf, now: () => NOW_MS, sleep: async () => {},
    });
    ok(res.checked === 4, "one Base + three Solana candidates must yield checked:4, got " + res.checked);
    ok(res.addedSol === 3, "all three eligible Solana rows must be added, got addedSol:" + res.addedSol);
    ok(res.added === 4, "added must be the total across both legs, got " + res.added);

    const dateStr = utcDateOf(NOW_MS);
    const doc = JSON.parse(await kv.get(reportKey(dateStr)));
    ok(JSON.stringify(doc.chains) === JSON.stringify(["base", "solana"]),
       "doc.chains must be the sorted unique chains actually present, got " + JSON.stringify(doc.chains));
    const solRowsInDoc = doc.rows.filter((r) => r.chain === "solana");
    ok(solRowsInDoc.length === 3, "the document must carry all three Solana rows, got " + solRowsInDoc.length);
    ok(solRowsInDoc.every((r) => r.checkKind === "roundtrip"),
       "every Solana row must carry checkKind:\"roundtrip\", got " +
       JSON.stringify(solRowsInDoc.map((r) => r.checkKind)));
    ok(doc.rows.some((r) => r.chain === "base" && r.address === mkAddr(1)),
       "the Base row must still be in the same document");

    // 🔴 دقیقاً یک نوشتنِ KV روی خودِ کلیدِ گزارش برای همین گذر — بدونِ
    // poolEmptyOf هیچ نوشتنِ دومِ فالوآپی هم نباید باشد.
    const reportWrites = kv.putCalls.filter((k) => k === reportKey(dateStr));
    ok(reportWrites.length === 1,
       "exactly one KV write of the report document must happen per pass, got " + reportWrites.length);

    // ---- پ) حلقه‌ی pairs هیچ ردیفِ سولانایی نمی‌گیرد ----
    const pairs = JSON.parse(await kv.get(PAIRS_KEY_BASE));
    ok(Array.isArray(pairs) && pairs.length === 1 && pairs[0].address === mkAddr(1),
       "the pairs ring must receive only the Base row, got " + JSON.stringify(pairs));
    ok(!pairs.some((r) => solAddrs.includes(r.address)),
       "the pairs ring must contain no Solana address even though Solana rows were added, got " +
       JSON.stringify(pairs));
  }

  // ---- ب) کنترل: fetchPoolsSol غایب، و fetchPoolsSol پرتاب‌کننده — هر دو
  // باید بایت‌به‌بایت همان سندِ Base-تنها را بدهند ----
  {
    const baseRows = [poolRow(mkAddr(9), 10000, 0.5)];
    const verdictOf = async () => ({ v: "sell", why: null });

    const kvAbsent = makeKv();
    const resAbsent = await runReportPass({
      kv: kvAbsent, fetchPools: async () => baseRows, metaOf, verdictOf, now: () => NOW_MS, sleep: async () => {},
    });

    const kvThrow = makeKv();
    const resThrow = await runReportPass({
      kv: kvThrow, fetchPools: async () => baseRows,
      fetchPoolsSol: async () => { throw new Error("upstream is down"); },
      metaOf, verdictOf, now: () => NOW_MS, sleep: async () => {},
    });

    const dateStr = utcDateOf(NOW_MS);
    const docAbsent = await kvAbsent.get(reportKey(dateStr));
    const docThrow = await kvThrow.get(reportKey(dateStr));
    ok(docAbsent === docThrow,
       "a throwing fetchPoolsSol must produce a document byte-for-byte identical to fetchPoolsSol being " +
       "absent entirely");
    ok(resAbsent.addedSol === 0 && resThrow.addedSol === 0,
       "addedSol must be 0 with no Solana rows, got " + resAbsent.addedSol + "/" + resThrow.addedSol);
    ok(resAbsent.added === 1 && resThrow.added === 1,
       "the Base leg must still land when the Solana leg yields nothing, got " +
       resAbsent.added + "/" + resThrow.added);
    ok(JSON.stringify(JSON.parse(docAbsent).chains) === JSON.stringify(["base"]),
       "chains must be [\"base\"] when no Solana rows landed, got " + JSON.parse(docAbsent).chains);
  }

  console.log("[report sol pass] runReportPass's injected Solana leg ok — both legs land in one document "
    + "written to KV exactly once per pass, chains becomes [\"base\",\"solana\"] sorted, every Solana row "
    + "carries checkKind:\"roundtrip\", checked/added/addedSol all count correctly, and the pairs ring "
    + "receives only the Base row even when Solana rows were added; a fetchPoolsSol that is absent or "
    + "throws yields a byte-for-byte identical document to a Base-only pass with addedSol:0, and the "
    + "Base leg still lands either way");
}

/* ---- ۳۸. runReportPass — سقفِ ۶ توکنِ سولانا در هر گذر ---- */
{
  function makeKv() {
    const store = new Map();
    return { store, get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v) => { store.set(k, v); } };
  }
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function mkSolAddr(n) {
    let s = "";
    const x = n + 5000;
    for (let i = 0; i < 44; i++) s += B58[(x + i * 7) % B58.length];
    return s;
  }
  function solPoolRow(addr, reserve) {
    return {
      attributes: { reserve_in_usd: String(reserve), base_token_price_usd: "0.001",
        pool_created_at: "2026-09-20T09:00:00Z", volume_usd: { h24: "1" }, fdv_usd: "1" },
      relationships: { base_token: { data: { id: "solana_" + addr } }, dex: { data: { id: "pumpswap" } } },
    };
  }
  const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");
  const metaOf = async () => ({ meta: null, why: "meta:429" });
  const verdictOf = async () => ({ v: "sell", why: null });
  const manyEligible = Array.from({ length: 20 }, (_, i) => solPoolRow(mkSolAddr(i), 6000 + i));

  // بدونِ solMaxTokens: پیش‌فرض ۶
  const kvDefault = makeKv();
  const resDefault = await runReportPass({
    kv: kvDefault, fetchPools: async () => [], fetchPoolsSol: async () => manyEligible,
    metaOf, verdictOf, now: () => NOW_MS, sleep: async () => {},
  });
  ok(resDefault.addedSol === REPORT_SOL_MAX_TOKENS,
     "20 eligible Solana rows with no solMaxTokens must add exactly " + REPORT_SOL_MAX_TOKENS +
     ", got " + resDefault.addedSol);

  // solMaxTokens بالاتر از سقفِ سخت هم گیر می‌کند
  const kvHuge = makeKv();
  const resHuge = await runReportPass({
    kv: kvHuge, fetchPools: async () => [], fetchPoolsSol: async () => manyEligible,
    metaOf, verdictOf, now: () => NOW_MS, sleep: async () => {}, solMaxTokens: 9999,
  });
  ok(resHuge.addedSol === REPORT_SOL_MAX_TOKENS,
     "solMaxTokens above the hard cap must still clamp to " + REPORT_SOL_MAX_TOKENS +
     ", got " + resHuge.addedSol);

  // solMaxTokens زیرِ سقف رعایت می‌شود
  const kvLow = makeKv();
  const resLow = await runReportPass({
    kv: kvLow, fetchPools: async () => [], fetchPoolsSol: async () => manyEligible,
    metaOf, verdictOf, now: () => NOW_MS, sleep: async () => {}, solMaxTokens: 2,
  });
  ok(resLow.addedSol === 2, "solMaxTokens:2 must add exactly 2, got " + resLow.addedSol);

  console.log("[report sol cap] runReportPass's Solana leg caps at exactly " + REPORT_SOL_MAX_TOKENS +
    " tokens per pass regardless of how many eligible rows the upstream returns (20 -> " +
    REPORT_SOL_MAX_TOKENS + "), a solMaxTokens above the hard cap clamps down to it, and a lower "
    + "solMaxTokens is respected exactly");
}

/* ---- ۳۹. reportText — ردیف‌های سولانا در متنِ عمومی — [report text solana] ----
   از ۲۰ سپتامبر سندِ روزانه ردیف‌های سولانا هم دارد (پیوستِ روزِ قبل، پایینِ
   همین فایل). این بخش قاعده‌ی تصمیمِ نهایی را می‌سنجد: صفر ردیفِ *شمرده‌شده*
   یعنی خروجی بایت‌به‌بایت همان چیزی می‌ماند که پیش از این تصمیم بود (چون
   بلوکِ سولانا کلاً پشتِ if(solTotal>0) است — هیچ خطِ Base‌ای دست نمی‌خورد)،
   و یک یا بیشتر یعنی یک بلوکِ تازه بعدِ کلِ بلوکِ Base و پیش از پانویس. */
{
  const T9 = "2026-09-20T00:00:00.000Z";
  function baseRowArgs(extra) {
    return Object.assign({ chain: "base", address: "0x" + "3".repeat(40), symbol: "B3", name: "B3",
      verdict: "sell", checkedAt: T9, poolCreatedAt: null, priceUsd: 1, reserveUsd: 1, vol24hUsd: 1,
      fdvUsd: 1, dex: "uniswap-v3-base", why: null }, extra);
  }
  // نمونه‌ی واقعیِ اسپک، عیناً: آدرس/symbol/name/dex همان چیزی که از سایتِ
  // زنده گرفته شد.
  function solRowArgs(extra) {
    return Object.assign({ chain: "solana", address: "eqNcWScchYa8SKsKS6cg3VyKh3Q3j5K1vKiDj26pump",
      symbol: "JEANPHISOL", name: "Jean Phil Solana", verdict: "sell", checkedAt: T9, poolCreatedAt: T9,
      priceUsd: 0.00005251157983698064, reserveUsd: 18543.59, vol24hUsd: 199.34, fdvUsd: 51122.81,
      dex: "pumpswap", why: null }, extra);
  }

  const rowBaseSell = reportRow(baseRowArgs({}));
  const rowBaseNoSell = reportRow(baseRowArgs({ address: "0x" + "4".repeat(40), symbol: "B4", verdict: "nosell" }));

  const EXPECTED_ZERO_SOL = "Exit Report · 20 Sep\n\n2 new Base tokens checked.\n1 had no sell route "
    + "quoted.\n1 had a sell route quoted.\n0 could not be checked.\n\n$B4 — no sell route quoted\n"
    + "zaexa.com/t/0x4444444444444444444444444444444444444444\n\nSell quotes on Base DEXes, not a "
    + "simulated round trip.\nLast check 00:00 UTC.\n";

  // الف) بدونِ هیچ ردیفِ سولانایی — همان مرجعِ پیش از این تغییر.
  const docNoSolAtAll = {
    date: "2026-09-20", generatedAt: T9, chains: ["base"], checked: 2,
    rows: [rowBaseSell, rowBaseNoSell],
  };
  ok(reportText(docNoSolAtAll, { solana: true }) === EXPECTED_ZERO_SOL,
     "a doc with no Solana rows at all must produce exactly the pre-Solana text, got " +
     JSON.stringify(reportText(docNoSolAtAll, { solana: true })));

  // ب) یک ردیفِ سولانا با checkKindِ ناجور — شمرده نمی‌شود، پس همچنان صفر.
  const rowWrongKindOnly = { ...reportRow(solRowArgs({ verdict: "nosell" })), checkKind: "sell-quote" };
  const docWrongKindOnly = {
    date: "2026-09-20", generatedAt: T9, chains: ["base", "solana"], checked: 3,
    rows: [rowBaseSell, rowBaseNoSell, rowWrongKindOnly],
  };
  ok(reportText(docWrongKindOnly, { solana: true }) === EXPECTED_ZERO_SOL,
     "a solana-shaped row with the wrong checkKind must count as zero and leave the text byte-for-byte " +
     "identical to the pre-Solana output, got " + JSON.stringify(reportText(docWrongKindOnly, { solana: true })));

  // پ) یک ردیفِ سولانا با mintِ بدشکل (کوتاه‌تر از ۳۲) — شمرده نمی‌شود.
  const rowBadMintOnly = reportRow(solRowArgs({ address: "short", verdict: "nosell" }));
  const docBadMintOnly = {
    date: "2026-09-20", generatedAt: T9, chains: ["base", "solana"], checked: 3,
    rows: [rowBaseSell, rowBaseNoSell, rowBadMintOnly],
  };
  ok(reportText(docBadMintOnly, { solana: true }) === EXPECTED_ZERO_SOL,
     "a solana row with a malformed (too-short) mint must count as zero and leave the text byte-for-byte " +
     "identical to the pre-Solana output, got " + JSON.stringify(reportText(docBadMintOnly, { solana: true })));

  // ت) سندِ آمیخته — دو ردیفِ Base + سه ردیفِ *شمردنیِ* سولانا (sell/nosell/null)
  // + یک ردیفِ سولانا با mintِ بدشکل و یکی با checkKindِ ناجور (هر دو نادیده
  // گرفته می‌شوند، پس مجموعِ سولانا همچنان ۳ می‌ماند).
  const rowSolSell = reportRow(solRowArgs({
    address: "So11111111111111111111111111111111111111112", verdict: "sell",
  }));
  const rowSolNosell = reportRow(solRowArgs({ verdict: "nosell" })); // eqNc…pump، عیناً نمونه‌ی اسپک
  const rowSolNull = reportRow(solRowArgs({
    address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", verdict: null,
  }));
  const rowSolBadMintUncounted = { ...rowSolNosell, address: "tooshort" };
  const rowSolWrongKindUncounted = {
    ...rowSolSell, checkKind: "sell-quote", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs",
  };

  const docMixed = {
    date: "2026-09-20", generatedAt: T9, chains: ["base", "solana"], checked: 5,
    rows: [rowBaseSell, rowBaseNoSell, rowSolSell, rowSolNosell, rowSolNull,
           rowSolBadMintUncounted, rowSolWrongKindUncounted],
  };
  const textMixed = reportText(docMixed, { solana: true });
  const EXPECTED_MIXED = "Exit Report · 20 Sep\n\n2 new Base tokens checked.\n1 had no sell route "
    + "quoted.\n1 had a sell route quoted.\n0 could not be checked.\n\n$B4 — no sell route quoted\n"
    + "zaexa.com/t/0x4444444444444444444444444444444444444444\n\n3 new Solana tokens checked.\n"
    + "1 failed a simulated buy and sell.\n1 passed a simulated buy and sell.\n1 could not be checked.\n\n"
    + "$JEANPHISOL — failed the simulated buy and sell\n"
    + "zaexa.com/t/eqNcWScchYa8SKsKS6cg3VyKh3Q3j5K1vKiDj26pump\n\n"
    + "Sell quotes on Base DEXes, not a simulated round trip.\n"
    + "On Solana, the buy and the sell are simulated together.\nLast check 00:00 UTC.\n";
  ok(textMixed === EXPECTED_MIXED,
     "the mixed base+solana fixture must produce the exact spec'd string, got " + JSON.stringify(textMixed));

  // شکلِ خط‌های خالی — روی هر ترکیبِ Base/سولانا: هرگز دو خطِ خالیِ پشت‌سرِهم،
  // و پانویس همیشه با یک خطِ خالی از بالایش جدا می‌شود (با یا بدونِ فهرستِ پرچم).
  for (const [label, rowsX] of [
    ["sol sell only", [rowBaseSell, rowSolSell]],
    ["sol nosell only", [rowBaseSell, rowSolNosell]],
    ["base nosell + sol sell", [rowBaseNoSell, rowSolSell]],
    ["both flagged", [rowBaseNoSell, rowSolNosell, rowSolNull]],
  ]) {
    const tx = reportText({ date: "2026-09-20", generatedAt: T9, chains: ["base", "solana"], checked: rowsX.length, rows: rowsX }, { solana: true });
    ok(typeof tx === "string" && !tx.includes("\n\n\n"),
       "report text (" + label + ") must never contain two blank lines in a row, got " + JSON.stringify(tx));
    ok(typeof tx === "string" && tx.includes("\n\nSell quotes on Base DEXes"),
       "report text (" + label + ") footer must be separated by exactly one blank line, got " + JSON.stringify(tx));
  }

  // ث) شمارش‌ها جمع می‌زنند — ۱ (nosell) + ۱ (sell) + ۱ (null) = ۳.
  ok(textMixed.includes("3 new Solana tokens checked.\n1 failed a simulated buy and sell.\n"
     + "1 passed a simulated buy and sell.\n1 could not be checked."),
     "the three solana counts must sum to the printed total, got " + JSON.stringify(textMixed));

  // ج) symbol با ایموجی → fallback به آدرسِ کوتاه‌شده، هرگز عیناً
  const rowSolEmoji = reportRow(solRowArgs({
    address: "3n5oQMhqQ4c9y6d7bJtmuVQnU9UwbXPMTfxQCkmVBcTh", verdict: "nosell", symbol: "🚀ROCKET",
  }));
  const docEmoji = {
    date: "2026-09-20", generatedAt: T9, chains: ["base", "solana"], checked: 2,
    rows: [rowBaseSell, rowSolEmoji],
  };
  const textEmoji = reportText(docEmoji, { solana: true });
  ok(textEmoji.includes("3n5oQM…BcTh — failed the simulated buy and sell\n" +
     "zaexa.com/t/3n5oQMhqQ4c9y6d7bJtmuVQnU9UwbXPMTfxQCkmVBcTh"),
     "an emoji symbol must fall back to the truncated mint address, got " + JSON.stringify(textEmoji));
  ok(!textEmoji.includes("🚀ROCKET"), "the emoji symbol must never appear verbatim in the report text");

  // چ) بیش از ۱۰ nosell → سقفِ فهرست در ۱۰ و خطِ overflow، هم‌رده‌ی Base
  const SOL_OVERFLOW_SUFFIXES = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh", "jj", "kk", "mm", "nn"];
  function mkSolAddr(i) { return "Sun9BkTPQ7xVne9CyR8mFhWZzAq3Kd" + SOL_OVERFLOW_SUFFIXES[i]; }
  const rows12Sol = Array.from({ length: 12 }, (_, i) =>
    reportRow(solRowArgs({ address: mkSolAddr(i), verdict: "nosell", symbol: "S" + i })));
  const doc12Sol = {
    date: "2026-09-20", generatedAt: T9, chains: ["base", "solana"], checked: 13,
    rows: [rowBaseSell, ...rows12Sol],
  };
  const text12Sol = reportText(doc12Sol, { solana: true });
  const solLinkMatches = (text12Sol.match(/zaexa\.com\/t\/Sun9/g) || []);
  ok(solLinkMatches.length === 10, "12 flagged solana rows must list exactly 10 token links, got " +
     solLinkMatches.length + " in " + JSON.stringify(text12Sol));
  ok(text12Sol.includes("+2 more: zaexa.com/report/2026-09-20.json"),
     "the solana overflow line must name the remaining 2 and point at the full JSON report, got: " +
     JSON.stringify(text12Sol));

  // ح) گاردِ واژگان روی خطوطِ سولانا — «honeypot»/«round trip» هرگز، و
  // استثنای باریک فقط چهار رشته‌ی ثابت را می‌پذیرد، نه هر چیزی که "simulat" دارد.
  for (const t of [textMixed, textEmoji, text12Sol]) {
    ok(!/honeypot/i.test(t), "a solana-bearing report text must never say \"honeypot\", got: " +
       JSON.stringify(t));
    ok(!FORBIDDEN_WORDING.test(stripAllowedWording(t)),
       "a solana-bearing report text failed the shared banned-wording guard after stripping only the " +
       "narrow allowance, got: " + JSON.stringify(t));
  }
  // استثنای باریک، نه یک regexِ عمومی: یک رشته‌ی ساختگی که "simulat" دارد ولی
  // دقیقاً هیچ‌کدام از چهار رشته‌ی مجاز نیست باید همچنان رد شود.
  const fakeWidening = "some other simulated thing entirely, not one of the four allowed phrases";
  ok(FORBIDDEN_WORDING.test(stripAllowedWording(fakeWidening)),
     "the narrow allowance must not strip arbitrary \"simulat\" text that is not one of the four exact " +
     "allowed phrases — got a false pass on: " + JSON.stringify(fakeWidening));

  console.log("[report text solana] reportText(doc, {solana:true}) ok — zero counted Solana rows " +
    "(none at all, a wrong-checkKind row, or a malformed mint) leaves the text byte-for-byte identical " +
    "to the pre-Solana output; the mixed Base+Solana fixture matches the exact spec'd string; the " +
    "three Solana counts (failed/passed/could-not-check) sum to the printed total; a nosell Solana row " +
    "is listed with its own zaexa.com/t/<mint> link; an emoji symbol falls back to the truncated mint " +
    "address and never appears verbatim; 12 nosell rows cap the list at 10 with a \"+2 more\" pointer " +
    "at the full JSON; and the shared banned-wording guard still rejects \"honeypot\"/\"round trip\" on " +
    "every Solana-bearing text while its narrow allowance admits only the four exact fixed Solana " +
    "phrases, never arbitrary \"simulat\" text");
}

/* ---- ۴۰. reportText — بلوکِ سولانا با تصمیمِ مالک پیش‌فرض مخفی است، تا رفعِ
   باگِ سهمیه‌ی ساب‌ریکوئست (۲۱ سپتامبرِ ۲۰۲۶) — [report text solana hidden] ----
   همان docMixed بالا (دو ردیفِ Base + سه ردیفِ سولانایِ شمردنی)، ولی بدونِ
   opts یا با {solana:false}: خروجی باید بایت‌به‌بایت همان سندی باشد که اصلاً
   ردیفِ سولانا نداشت — پس هیچ خطِ سولانایی، هیچ‌جا. */
{
  const T9H = "2026-09-20T00:00:00.000Z";
  function baseRowArgsH(extra) {
    return Object.assign({ chain: "base", address: "0x" + "3".repeat(40), symbol: "B3", name: "B3",
      verdict: "sell", checkedAt: T9H, poolCreatedAt: null, priceUsd: 1, reserveUsd: 1, vol24hUsd: 1,
      fdvUsd: 1, dex: "uniswap-v3-base", why: null }, extra);
  }
  function solRowArgsH(extra) {
    return Object.assign({ chain: "solana", address: "eqNcWScchYa8SKsKS6cg3VyKh3Q3j5K1vKiDj26pump",
      symbol: "JEANPHISOL", name: "Jean Phil Solana", verdict: "sell", checkedAt: T9H, poolCreatedAt: T9H,
      priceUsd: 0.00005251157983698064, reserveUsd: 18543.59, vol24hUsd: 199.34, fdvUsd: 51122.81,
      dex: "pumpswap", why: null }, extra);
  }
  const rowBaseSellH = reportRow(baseRowArgsH({}));
  const rowBaseNoSellH = reportRow(baseRowArgsH({ address: "0x" + "4".repeat(40), symbol: "B4", verdict: "nosell" }));
  const rowSolSellH = reportRow(solRowArgsH({
    address: "So11111111111111111111111111111111111111112", verdict: "sell",
  }));
  const rowSolNosellH = reportRow(solRowArgsH({ verdict: "nosell" }));
  const rowSolNullH = reportRow(solRowArgsH({
    address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", verdict: null,
  }));
  const docWithSol = {
    date: "2026-09-20", generatedAt: T9H, chains: ["base", "solana"], checked: 5,
    rows: [rowBaseSellH, rowBaseNoSellH, rowSolSellH, rowSolNosellH, rowSolNullH],
  };
  const docSolRemoved = {
    date: "2026-09-20", generatedAt: T9H, chains: ["base"], checked: 2,
    rows: [rowBaseSellH, rowBaseNoSellH],
  };
  const refText = reportText(docSolRemoved, { solana: true }); // مرجع: سندی که اصلاً ردیفِ سولانا ندارد

  const noOpts = reportText(docWithSol);
  ok(noOpts === refText,
     "reportText(doc) with no opts (the owner's decision, 21 Sep 2026) must be byte-for-byte " +
     "identical to the same doc with its Solana rows removed, got " + JSON.stringify(noOpts));
  ok(!noOpts.includes("Solana"),
     "with the Solana block hidden, the text must not say \"Solana\" anywhere, got " + JSON.stringify(noOpts));

  const solFalse = reportText(docWithSol, { solana: false });
  ok(solFalse === refText,
     "reportText(doc, {solana:false}) must also be byte-for-byte identical to the Solana-removed " +
     "reference, got " + JSON.stringify(solFalse));

  const solTrue = reportText(docWithSol, { solana: true });
  ok(solTrue !== refText && solTrue.includes("Solana"),
     "sanity: {solana:true} on the very same doc must actually print the Solana block, got " +
     JSON.stringify(solTrue));

  console.log("[report text solana hidden] reportText(doc, opts) — the Solana block and its footer " +
    "line print only when opts.solana===true; the default (no opts) and opts.solana:false are both " +
    "byte-for-byte identical to the same doc with its Solana rows stripped, verified against a live " +
    "sanity check that {solana:true} on the same doc does print the block");
}

/* ---- ۴۱. GET /report/<...>.txt با ردیف‌های سولانا در KV — پیش‌فرضِ مسیر ----
   همان مسیرِ واقعی، نه یک فراخوانیِ مستقیمِ reportText: اثباتِ اینکه route
   هم reportText(parsed) را بدونِ opts صدا می‌زند، دقیقاً مثلِ امروز. */
{
  const T9R = "2026-09-20T00:00:00.000Z";
  const rowBaseR = reportRow({
    chain: "base", address: "0x" + "5".repeat(40), symbol: "B5", name: "B5", verdict: "sell",
    checkedAt: T9R, poolCreatedAt: null, priceUsd: 1, reserveUsd: 1, vol24hUsd: 1, fdvUsd: 1,
    dex: "uniswap-v3-base", why: null,
  });
  const rowSolR = reportRow({
    chain: "solana", address: "eqNcWScchYa8SKsKS6cg3VyKh3Q3j5K1vKiDj26pump", symbol: "JEANPHISOL",
    name: "Jean Phil Solana", verdict: "nosell", checkedAt: T9R, poolCreatedAt: T9R,
    priceUsd: 0.00005, reserveUsd: 18543.59, vol24hUsd: 199.34, fdvUsd: 51122.81, dex: "pumpswap",
    why: null,
  });
  const docRouteSol = {
    date: "2026-09-20", generatedAt: T9R, chains: ["base", "solana"], checked: 2,
    rows: [rowBaseR, rowSolR],
  };
  const kvRouteSol = { get: async () => JSON.stringify(docRouteSol) };
  const rRouteSol = await call("/report/2026-09-20.txt", { method: "GET" }, { ASSETS, ZX_KV: kvRouteSol });
  ok(rRouteSol.status === 200, "GET /report/2026-09-20.txt with Solana rows in KV must still be 200, "
    + "got " + rRouteSol.status);
  const bodyRouteSol = await rRouteSol.text();
  ok(!bodyRouteSol.includes("Solana"),
     "GET /report/<date>.txt must not print \"Solana\" while the block is hidden by default, got " +
     JSON.stringify(bodyRouteSol));

  console.log("[report route solana hidden] GET /report/<date>.txt calls reportText(doc) with no opts "
    + "— a stored doc that does carry Solana rows still produces a body with no \"Solana\" substring");
}

/* ---- ۴۰. استثنای پوششِ v4 — [cover v4 exception] ----
   مسئله (اندازه‌گیریِ ۲۰ سپتامبر): GT_DEX_TO_VENUE عمداً uniswap-v4-base را
   ندارد، با این توضیح که «قراردادهای v4 را پروب نمی‌کنیم». آن توضیح حالا
   کهنه است — کلیدهای واقعیِ v4 از رویِ لاگِ زنجیره ایندکس می‌شوند و استخرِ
   خودِ توکن پروب می‌شود؛ ۴۸۵ از ۱۰۸۳ ردیفِ شش‌روزِ اخیر دقیقاً همین‌جا به
   نامعلوم می‌افتند. این بخش شاخهٔ تازه‌ی گیت را می‌سنجد: باید *هم* بالادست
   یک استخرِ v4 برای همین توکن دیده باشد (v4Listed) *هم* ما دست‌کم یک کلیدِ
   واقعیِ ایندکس‌شده داشته باشیم (v4Keyed) — وگرنه نامعلوم دست‌نخورده می‌ماند. */
{
  const { UPSTREAM_KEYED: UK_V4X, baseVenueCoveredDetail: bvcdX } = await import("./index.js");
  const { v4KvKey: v4KvKeyX } = await import("./v4index.js");
  const w2x = (n) => BigInt(n).toString(16).padStart(64, "0");
  const mk4x = (n) => "0x" + w2x(n) + w2x(0) + w2x(0) + w2x(0);
  // همان الگوی cleanNosellRow بالاتر (۲۷ب): کدِ ۳ برای SOLIDLY، "0x" برای
  // بقیه — یک nosellِ تمیزِ متعارف، بدونِ هیچ ربطی به شاهدِ v4.
  const cleanNosellRowX = (r) => (isSolidlyReqId(r.id) ? { id: r.id, error: { code: 3 } } : { id: r.id, result: "0x" });
  const gtMetaX = () => new Response(JSON.stringify({ data: { attributes: {
    name: "V4 Exception Token", symbol: "V4X", total_reserve_in_usd: "1000",
    decimals: 18, price_usd: "2000",
  } } }), { status: 200, headers: { "content-type": "application/json" } });
  const poolsBodyX = (dexIds) => new Response(JSON.stringify({ data: dexIds.map((id) => (
    { relationships: { dex: { data: { id } } } })) }), { status: 200, headers: { "content-type": "application/json" } });
  // eth_call تکیِ v4PoolsEmpty (نه آرایه‌ی batch) — همیشه یک نقدینگیِ صفرِ
  // خواندنی برمی‌گرداند؛ خودِ cause این بخش را نمی‌سنجد، فقط v/why را.
  const singleEthCallOkX = (parsed) => new Response(JSON.stringify(
    { jsonrpc: "2.0", id: parsed.id, result: "0x" + "0".repeat(64) }),
    { status: 200, headers: { "content-type": "application/json" } });
  const realKvX = (addr, key) => ({
    get: async (k) => (k === v4KvKeyX("base", addr) ? JSON.stringify({ keys: [key], reason: "ok" }) : null),
    put: async () => {},
  });
  const noKvX = () => ({ get: async () => null, put: async () => {} });
  // شناسه‌ی استخرِ این کلید هرگز با هیچ داده‌ی ریوِرتی که پایین‌تر می‌سازیم
  // یکی نمی‌شود — یعنی v4NoLiquidityProof/whyOut.v4Proof هرگز true نمی‌شود؛
  // این بخش عمداً شاخه‌ی تازه را می‌سنجد، نه شاخه‌ی قدیمیِ ۱۹ شهریور.
  const realKeyX = (addr) => ({ currency0: vd.NATIVE_ADDR, currency1: addr, fee: 0, tickSpacing: 1,
    hooks: vd.NATIVE_ADDR, poolId: "0x" + "9".repeat(64) });

  async function askV4X(addr, env_, dispatch, ipTail) {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = dispatch;
    const res = await call("/vd/" + addr, { headers: { "cf-connecting-ip": "198.51.100." + ipTail } }, env_);
    const body = await res.json();
    globalThis.fetch = savedFetch;
    return body;
  }

  function nosellDispatchX(dexIds) {
    return async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return poolsBodyX(dexIds);
      if (u.startsWith(UK_V4X)) return gtMetaX();
      const parsed = JSON.parse(init.body);
      if (!Array.isArray(parsed)) return singleEthCallOkX(parsed);
      return new Response(JSON.stringify(parsed.map((r) => (r.id === 0
        ? { id: 0, result: mk4x(5) } : cleanNosellRowX(r)))),
        { status: 200, headers: { "content-type": "application/json" } });
    };
  }

  // ۱) covered:false + v4Listed:true + v4Keyed:true + خامِ nosell → nosell نهایی، بدونِ why
  {
    const ADDR = "0x" + "a1".repeat(20);
    const env_ = { ASSETS, CG_KEY: "SECRET-CG-KEY-V4X-1", ZX_KV: realKvX(ADDR, realKeyX(ADDR)) };
    const body = await askV4X(ADDR, env_, nosellDispatchX(["uniswap-v4-base"]), 11);
    ok(body.v === "nosell" && !("why" in body),
       "[cover v4 exception] covered:false + v4Listed:true + v4Keyed:true with a raw nosell must reach " +
       "nosell end to end, got " + JSON.stringify(body));
  }

  // ۲) همان شکل، ولی بدونِ هیچ کلیدِ واقعی‌ای (v4Keyed:false) → نامعلوم/cover:false
  {
    const ADDR = "0x" + "a2".repeat(20);
    const env_ = { ASSETS, CG_KEY: "SECRET-CG-KEY-V4X-2", ZX_KV: noKvX() };
    const body = await askV4X(ADDR, env_, nosellDispatchX(["uniswap-v4-base"]), 12);
    ok(body.v === null && body.why === "cover:false",
       "[cover v4 exception] without a real indexed v4 key (v4Keyed:false) the same v4-only pools shape " +
       "must stay cover:false, got " + JSON.stringify(body));
  }

  // ۳) خودِ چکِ پوشش اصلاً جواب نداد (cover:timeout) → نامعلوم می‌ماند، حتی با کلیدِ واقعی
  {
    const ADDR = "0x" + "a3".repeat(20);
    const env_ = { ASSETS, CG_KEY: "SECRET-CG-KEY-V4X-3", ZX_KV: realKvX(ADDR, realKeyX(ADDR)) };
    const hangUntilAbortX = (init) => new Promise((_, reject) => {
      const sig = init && init.signal;
      if (!sig) return; // بدونِ سیگنال هرگز برنمی‌گردد — خودِ تست گیر می‌کند و لو می‌رود
      sig.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const body = await askV4X(ADDR, env_, async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return hangUntilAbortX(init);
      if (u.startsWith(UK_V4X)) return gtMetaX();
      const parsed = JSON.parse(init.body);
      if (!Array.isArray(parsed)) return singleEthCallOkX(parsed);
      return new Response(JSON.stringify(parsed.map((r) => (r.id === 0
        ? { id: 0, result: mk4x(5) } : cleanNosellRowX(r)))),
        { status: 200, headers: { "content-type": "application/json" } });
    }, 13);
    ok(body.v === null && body.why === "cover:timeout",
       "[cover v4 exception] a coverage check that could not answer must stay unknown forever, even with " +
       "a real indexed v4 key present, got " + JSON.stringify(body));
  }

  // ۴) covered:false + v4Listed:false (دکسِ نامرتبطِ دیگری، نه v4) + v4Keyed:true → cover:false
  {
    const ADDR = "0x" + "a4".repeat(20);
    const env_ = { ASSETS, CG_KEY: "SECRET-CG-KEY-V4X-4", ZX_KV: realKvX(ADDR, realKeyX(ADDR)) };
    const body = await askV4X(ADDR, env_, nosellDispatchX(["some-other-dex"]), 14);
    ok(body.v === null && body.why === "cover:false",
       "[cover v4 exception] v4Listed:false (an unrelated uncovered dex, not v4) must never trigger the " +
       "exception even with a real indexed key present, got " + JSON.stringify(body));
  }

  // ۵) کنترلِ مثبت — یک sellِ خام هرگز baseVenueCoveredDetail (اندپوینتِ pools) را صدا نمی‌زند
  {
    const ADDR = "0x" + "a5".repeat(20);
    const env_ = { ASSETS, CG_KEY: "SECRET-CG-KEY-V4X-5", ZX_KV: realKvX(ADDR, realKeyX(ADDR)) };
    let poolsCalledX = false;
    const body = await askV4X(ADDR, env_, async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) { poolsCalledX = true; return poolsBodyX(["uniswap-v4-base"]); }
      if (u.startsWith(UK_V4X)) return gtMetaX();
      const parsed = JSON.parse(init.body);
      return new Response(JSON.stringify(parsed.map((r) => (r.id === 0
        ? { id: 0, result: mk4x(5) }
        : { id: r.id, result: r.id === 1 ? mk4x(777) : "0x" }))),
        { status: 200, headers: { "content-type": "application/json" } });
    }, 15);
    ok(body.v === "sell" && !("why" in body),
       "[cover v4 exception] sanity: this scenario must verdict sell, got " + JSON.stringify(body));
    ok(poolsCalledX === false,
       "[cover v4 exception] positive control: a raw sell must never call the coverage (pools) endpoint " +
       "at all, got poolsCalled=" + poolsCalledX);
  }

  // ۶) baseVenueCoveredDetail مستقیم، رویِ شکلِ واقعیِ زنده‌ی GeckoTerminal —
  // اعداد به‌صورتِ رشته می‌آیند (measured, نه حدسی؛ رجوع به بالای فایل).
  {
    const savedFetch = globalThis.fetch;
    const ADDR = "0x" + "a6".repeat(20);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { relationships: { dex: { data: { id: "uniswap-v4-base", type: "dex" } } },
        attributes: { reserve_in_usd: "267410.9781" } },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
    const detailV4X = await bvcdX(ADDR, {});
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { relationships: { dex: { data: { id: "uniswap-v3-base", type: "dex" } } },
        attributes: { reserve_in_usd: "267410.9781" } },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
    const detailV3X = await bvcdX(ADDR, {});
    globalThis.fetch = savedFetch;
    ok(detailV4X.covered === false && detailV4X.why === "cover:false" && detailV4X.v4Listed === true,
       "[cover v4 exception] the real live payload shape (string reserve numbers) with only a v4 pool " +
       "must give covered:false, why:\"cover:false\", v4Listed:true, got " + JSON.stringify(detailV4X));
    ok(detailV3X.covered === true && detailV3X.v4Listed !== true,
       "[cover v4 exception] the same shape with a covered v3 pool must give covered:true and " +
       "v4Listed false/absent, got " + JSON.stringify(detailV3X));
  }

  // ۷) گردشِ کش — v4Keyed که درونِ computeFn نشسته باید از ضربه‌ی کش هم زنده بیرون بیاید
  // (همان اندازه‌گیریِ ۱۹ شهریور بالاتر، این‌بار برایِ v4Keyed نه v4Proof).
  {
    const ADDR = "0x" + "a7".repeat(20);
    const env_ = { ASSETS, CG_KEY: "SECRET-CG-KEY-V4X-7", ZX_KV: realKvX(ADDR, realKeyX(ADDR)) };
    let rpcBatchesX = 0;
    const savedFetch = globalThis.fetch;
    const savedCaches = globalThis.caches;
    const cacheStoreX = new Map();
    globalThis.caches = { default: {
      match: async (req) => {
        const b = cacheStoreX.get(String(req.url));
        return b === undefined ? undefined : new Response(b, { headers: { "content-type": "application/json" } });
      },
      put: async (req, res) => { cacheStoreX.set(String(req.url), await res.text()); },
    } };
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/pools")) return poolsBodyX(["uniswap-v4-base"]);
      if (u.startsWith(UK_V4X)) return gtMetaX();
      const parsed = JSON.parse(init.body);
      if (!Array.isArray(parsed)) return singleEthCallOkX(parsed);
      rpcBatchesX++;
      return new Response(JSON.stringify(parsed.map((r) => (r.id === 0
        ? { id: 0, result: mk4x(5) } : cleanNosellRowX(r)))),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    const firstX = await (await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": "198.51.100.17" } }, env_)).json();
    const batchesAfterFirstX = rpcBatchesX;
    const secondX = await (await call("/vd/" + ADDR, { headers: { "cf-connecting-ip": "198.51.100.18" } }, env_)).json();
    globalThis.fetch = savedFetch;
    if (savedCaches === undefined) delete globalThis.caches; else globalThis.caches = savedCaches;

    ok(firstX.v === "nosell", "[cover v4 exception] the fresh compute must give nosell, got " + JSON.stringify(firstX));
    ok(secondX.v === "nosell",
       "[cover v4 exception] the SAME token one request later must still give nosell — v4Keyed has to be " +
       "cached alongside the verdict, or the coverage gate silently downgrades a cache hit, got " +
       JSON.stringify(secondX));
    ok(rpcBatchesX === batchesAfterFirstX,
       "[cover v4 exception] sanity: the second request must really be served from the verdict cache (no " +
       "new venue-probe RPC batch), got " + rpcBatchesX + " vs " + batchesAfterFirstX);
  }

  console.log("[cover v4 exception] the stale \"we never probe v4\" comment is gone: a token whose only "
    + "GeckoTerminal-listed pool is uniswap-v4-base (v4Listed) now keeps its raw nosell verdict when we "
    + "hold a real indexed v4 key for it (v4Keyed), and that survives a cache hit; dropping either v4Listed "
    + "or v4Keyed alone still degrades to cover:false; a coverage check that could not answer (cover:timeout) "
    + "still stays unknown forever even with a real key present; a raw sell never calls the coverage endpoint "
    + "at all; and baseVenueCoveredDetail against the measured live payload shape (string reserve numbers) "
    + "correctly flags v4Listed only on the v4-only pools body, never on a covered v3 one");
}

/* ---- ۴۱. رِی‌چکِ یک‌ساعته‌ی ردیف‌های نامعلوم — [report recheck] ----
   اندازه‌گیریِ زنده: پنج ردیفِ نامعلومِ امروز که یک ساعت بعد دوباره پرسیده
   شدند، هر پنج‌تا یک حکمِ واقعی برگرداندند — نامعلومی‌ها گذرا بودند (نرخ‌گیر،
   استثناهای قورت‌داده‌شده). هم‌رده‌ی followUp روی sell، این بخش همان کار را
   روی v===null انجام می‌دهد، افزایشی و بدونِ بازنویسیِ حکمِ اصلی. */
{
  ok(JSON.stringify(REPORT_RECHECKS) === JSON.stringify(["sell", "nosell"]) &&
     Object.isFrozen(REPORT_RECHECKS),
     "REPORT_RECHECKS must be the frozen two-member closed vocabulary, got " + JSON.stringify(REPORT_RECHECKS));
  ok(recheckForRow(null, "sell") === "sell" && recheckForRow(null, "nosell") === "nosell",
     "recheckForRow must let both REPORT_RECHECKS members survive on a null-verdict row");
  ok(recheckForRow("sell", "sell") === undefined,
     "recheckForRow must drop any recheck on an already-\"sell\" row");
  ok(recheckForRow("nosell", "nosell") === undefined,
     "recheckForRow must drop any recheck on an already-\"nosell\" row");
  ok(recheckForRow(null, "made-up") === undefined,
     "recheckForRow must drop any string not in REPORT_RECHECKS, even on a null-verdict row");

  // ---- pickRecheckTargets — پنجره‌ی ۵۵ تا ۱۸۰ دقیقه، سقف، قدیمی‌ترین اول، dex ----
  function mkAddrR(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  const NOWR = Date.parse("2026-09-20T12:00:00.000Z");
  function ageRowR(addr, minutesAgo, extra) {
    return Object.assign({
      chain: "base", v: null, address: addr, dex: "uniswap-v3-base",
      checkedAt: new Date(NOWR - minutesAgo * 60000).toISOString(),
    }, extra);
  }
  const rr55 = ageRowR(mkAddrR(1), 55);                                   // مرزِ پایین، شامل
  const rr180 = ageRowR(mkAddrR(2), 180, { dex: null });                  // مرزِ بالا، شامل — dexِ null هم برمی‌گردد
  const rr54 = ageRowR(mkAddrR(3), 54);                                   // خارج، تازه‌تر از مرز
  const rr181 = ageRowR(mkAddrR(4), 181);                                 // خارج، قدیمی‌تر از مرز
  const rrHasRecheck = ageRowR(mkAddrR(5), 100, { recheck: "sell", recheckAt: "x" }); // از پیش رِی‌چک شده
  const rrBad = { chain: "base", v: null, address: mkAddrR(6), dex: null, checkedAt: "not-a-date" };
  const rrSell = ageRowR(mkAddrR(7), 100, { v: "sell" });
  const rrNosell = ageRowR(mkAddrR(8), 100, { v: "nosell" });
  const rrSolana = ageRowR(mkAddrR(9), 100, { chain: "solana" });

  const docWindowR = {
    date: "2026-09-20", generatedAt: null, chains: ["base"], checked: 9,
    rows: [rr55, rr180, rr54, rr181, rrHasRecheck, rrBad, rrSell, rrNosell, rrSolana],
  };
  const pickedR = pickRecheckTargets(docWindowR, NOWR, 4);
  ok(JSON.stringify(pickedR) === JSON.stringify([
       { address: mkAddrR(2), dex: null }, { address: mkAddrR(1), dex: "uniswap-v3-base" },
     ]),
     "the window must include exactly the 55- and 180-minute null rows (180 first, oldest-first), each " +
     "carrying its own dex (null when the row has none), and exclude 54/181/already-rechecked/" +
     "unparseable/sell/nosell/non-base, got " + JSON.stringify(pickedR));

  // سقف و ترتیب: ۱۰ ردیفِ درونِ پنجره، فقط ۴تای قدیمی‌ترش (سقفِ پیش‌فرض)
  const manyRowsR = Array.from({ length: 10 }, (_, i) => ageRowR(mkAddrR(100 + i), 60 + i));
  const docManyR = { date: "2026-09-20", generatedAt: null, chains: ["base"], checked: 10, rows: manyRowsR };
  const pickedCapR = pickRecheckTargets(docManyR, NOWR, 4);
  ok(pickedCapR.length === 4, "the default cap must hold at exactly 4, got " + pickedCapR.length);
  const expectedCapR = Array.from({ length: 4 }, (_, k) => ({ address: mkAddrR(100 + (9 - k)), dex: "uniswap-v3-base" }));
  ok(JSON.stringify(pickedCapR) === JSON.stringify(expectedCapR),
     "the 4 oldest rows must be returned oldest-first with dex, got " + JSON.stringify(pickedCapR));
  const pickedCapR2 = pickRecheckTargets(docManyR, NOWR, 2);
  ok(pickedCapR2.length === 2 && JSON.stringify(pickedCapR2) === JSON.stringify(expectedCapR.slice(0, 2)),
     "a custom cap must be respected exactly, got " + JSON.stringify(pickedCapR2));

  console.log("[report recheck pick] pickRecheckTargets picks only base/null-verdict/not-yet-rechecked " +
    "rows whose checkedAt falls between 55 and 180 minutes before now (both bounds included, 54/181 " +
    "excluded), skips an already-rechecked row, a sell row, a nosell row, a non-base row and one with " +
    "an unparseable checkedAt, returns {address, dex} oldest-first (dex null when the row has none), " +
    "and respects the cap exactly (default 4 and a custom value)");
}

/* ---- applyRechecks — یک رِی‌چکِ افزایشی روی یک ردیفِ v===null ---- */
{
  function mkAddrA(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  const T1A = "2026-09-20T10:00:00.000Z";
  function recheckRow(addr, v, extra) {
    return Object.assign({
      chain: "base", address: addr, symbol: "S", name: "N", v, checkKind: "sell-quote",
      checkedAt: T1A, poolCreatedAt: null, priceUsd: 1, reserveUsd: 2, vol24hUsd: 3, fdvUsd: 4,
      dex: "uniswap-v4-base", why: v === null ? "no-quote" : null,
    }, extra);
  }
  const rowA1 = recheckRow(mkAddrA(1), null);   // می‌شود recheck:"sell"
  const rowA2 = recheckRow(mkAddrA(2), null);   // می‌شود recheck:"nosell" با cause
  const rowA3 = recheckRow(mkAddrA(3), "sell"); // v!==null → هرگز رِی‌چک نمی‌گیرد
  const origDocA = {
    date: "2026-09-20", generatedAt: T1A, chains: ["base"], checked: 3, rows: [rowA1, rowA2, rowA3],
  };
  const origSnapshotA = JSON.stringify(origDocA);
  const origCloneA = JSON.parse(origSnapshotA);

  const atIsoA = "2026-09-20T11:00:00.000Z";
  const updatedA = applyRechecks(origDocA, [
    { address: mkAddrA(1), recheck: "sell" },
    { address: mkAddrA(2), recheck: "nosell", cause: "empty-pool" },
    { address: mkAddrA(3), recheck: "sell" }, // v!==null، بی‌اثر
  ], atIsoA);

  ok(updatedA.rows[0].recheck === "sell" && updatedA.rows[0].recheckAt === atIsoA &&
     !("recheckCause" in updatedA.rows[0]),
     "applyRechecks must add exactly recheck+recheckAt for a \"sell\" recheck, never recheckCause, got " +
     JSON.stringify(updatedA.rows[0]));
  ok(updatedA.rows[1].recheck === "nosell" && updatedA.rows[1].recheckAt === atIsoA &&
     updatedA.rows[1].recheckCause === "empty-pool",
     "applyRechecks must add recheck+recheckAt+recheckCause for a \"nosell\" recheck with a valid cause, " +
     "got " + JSON.stringify(updatedA.rows[1]));
  const { recheck: rk0, recheckAt: rka0, ...restRowA0 } = updatedA.rows[0];
  ok(JSON.stringify(restRowA0) === JSON.stringify(rowA1),
     "every other key of the sell-rechecked row must stay byte-for-byte identical, got " +
     JSON.stringify(restRowA0));
  const { recheck: rk1, recheckAt: rka1, recheckCause: rkc1, ...restRowA1 } = updatedA.rows[1];
  ok(JSON.stringify(restRowA1) === JSON.stringify(rowA2),
     "every other key of the nosell-rechecked row must stay byte-for-byte identical, got " +
     JSON.stringify(restRowA1));
  ok(JSON.stringify(updatedA.rows[2]) === JSON.stringify(rowA3),
     "a row whose v is not null must stay untouched even when it is named in updates, got " +
     JSON.stringify(updatedA.rows[2]));
  ok(updatedA.date === origDocA.date && updatedA.generatedAt === origDocA.generatedAt &&
     updatedA.checked === origDocA.checked && JSON.stringify(updatedA.chains) === JSON.stringify(origDocA.chains),
     "date/chains/checked/generatedAt must stay exactly as they were");
  ok(JSON.stringify(origDocA) === origSnapshotA,
     "applyRechecks must never mutate its input doc, got a changed original: " + JSON.stringify(origDocA));
  ok(JSON.stringify(origDocA) === JSON.stringify(origCloneA),
     "a deep clone taken before the call must still match the input doc afterwards, got " +
     JSON.stringify(origDocA));

  // یک recheck:"sell" با یک cause همراهش هم هرگز recheckCause نمی‌سازد
  const updatedSellCause = applyRechecks(
    { date: "2026-09-20", generatedAt: T1A, chains: ["base"], checked: 1, rows: [recheckRow(mkAddrA(9), null)] },
    [{ address: mkAddrA(9), recheck: "sell", cause: "empty-pool" }], atIsoA);
  ok(!("recheckCause" in updatedSellCause.rows[0]),
     "a \"sell\" recheck must never get recheckCause even when a cause is passed alongside it, got " +
     JSON.stringify(updatedSellCause.rows[0]));

  function freshDocA(r) {
    return { date: "2026-09-20", generatedAt: T1A, chains: ["base"], checked: 1, rows: [r] };
  }
  function unchangedA(label, doc, updates, atIso) {
    const before = JSON.stringify(doc);
    const after = applyRechecks(doc, updates, atIso);
    ok(JSON.stringify(after) === before,
       "applyRechecks must refuse and return the doc unchanged for: " + label + ", got " + JSON.stringify(after));
  }

  // نامعتبر — هر کدام باید کلِ سند را دست‌نخورده برگردانند
  unchangedA("recheck \"maybe\"", freshDocA(recheckRow(mkAddrA(10), null)),
    [{ address: mkAddrA(10), recheck: "maybe" }], atIsoA);
  unchangedA("recheck \"unknown\"", freshDocA(recheckRow(mkAddrA(11), null)),
    [{ address: mkAddrA(11), recheck: "unknown" }], atIsoA);
  unchangedA("recheck null", freshDocA(recheckRow(mkAddrA(12), null)),
    [{ address: mkAddrA(12), recheck: null }], atIsoA);
  unchangedA("a row whose v is \"sell\"", freshDocA(recheckRow(mkAddrA(13), "sell")),
    [{ address: mkAddrA(13), recheck: "sell" }], atIsoA);
  unchangedA("a row whose v is \"nosell\"", freshDocA(recheckRow(mkAddrA(14), "nosell")),
    [{ address: mkAddrA(14), recheck: "nosell" }], atIsoA);
  unchangedA("a row that already carries recheck",
    freshDocA(recheckRow(mkAddrA(15), null, { recheck: "sell", recheckAt: T1A })),
    [{ address: mkAddrA(15), recheck: "nosell" }], atIsoA);
  unchangedA("an address not in the doc", freshDocA(recheckRow(mkAddrA(16), null)),
    [{ address: mkAddrA(999), recheck: "sell" }], atIsoA);
  unchangedA("a non-ISO atIso", freshDocA(recheckRow(mkAddrA(17), null)),
    [{ address: mkAddrA(17), recheck: "sell" }], "not-a-date");

  // اعمالِ دوباره روی ردیفی که همین الان رِی‌چک گرفت — دومین فراخوانی بی‌اثر است
  const onceDoc = applyRechecks(freshDocA(recheckRow(mkAddrA(20), null)),
    [{ address: mkAddrA(20), recheck: "sell" }], atIsoA);
  const onceSnapshot = JSON.stringify(onceDoc);
  const twiceDoc = applyRechecks(onceDoc, [{ address: mkAddrA(20), recheck: "nosell", cause: "empty-pool" }],
    "2026-09-20T12:00:00.000Z");
  ok(JSON.stringify(twiceDoc) === onceSnapshot,
     "a second application to an already-rechecked row must leave the doc byte-for-byte unchanged, got " +
     JSON.stringify(twiceDoc));

  console.log("[report recheck apply] applyRechecks marks exactly the matching v===null row with " +
    "recheck+recheckAt (and recheckCause only for a \"nosell\" recheck with a valid cause; a \"sell\" " +
    "recheck never gets recheckCause), leaves every other key of every row byte-for-byte identical, " +
    "refuses and returns the whole doc untouched for an invalid recheck string, a row whose v is " +
    "already \"sell\"/\"nosell\", a row that already carries recheck, an address absent from the doc, " +
    "a non-ISO atIso, and a second application to an already-rechecked row, and never mutates its input " +
    "doc; recheckForRow enforces the frozen REPORT_RECHECKS vocabulary exactly like followForRow does " +
    "for REPORT_FOLLOWS");
}

/* ---- runReportPass — رِی‌چکِ یک‌ساعته با metaOf/verdictOfِ همان تزریقی ---- */
{
  function makeKvR() {
    const store = new Map();
    return {
      store,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
    };
  }
  function mkAddrP(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function seedOldNullRow(nowMs, addr) {
    return reportRow({
      chain: "base", address: addr, symbol: "OLD", name: "Old Token", verdict: null,
      checkedAt: new Date(nowMs - 100 * 60000).toISOString(), poolCreatedAt: null,
      priceUsd: 1, reserveUsd: 2, vol24hUsd: 3, fdvUsd: 4, dex: "uniswap-v4-base", why: "no-quote",
    });
  }
  function seedOldSellRowP(nowMs, addr) {
    return reportRow({
      chain: "base", address: addr, symbol: "OLD", name: "Old Token", verdict: "sell",
      checkedAt: new Date(nowMs - 100 * 60000).toISOString(), poolCreatedAt: null,
      priceUsd: 1, reserveUsd: 2, vol24hUsd: 3, fdvUsd: 4, dex: "uniswap-v4-base", why: null,
    });
  }

  // الف) یک ردیفِ نامعلومِ قدیمی → رِی‌چک به "sell"، v/why دست‌نخورده
  {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const addr = mkAddrP(1);
    const oldRow = seedOldNullRow(NOW, addr);
    const seedDoc = mergeReportDoc(null, dateStr, [oldRow], 1, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKvR();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    const res = await runReportPass({
      kv, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async () => ({ v: "sell", why: null }), now: () => NOW, sleep: async () => {},
    });
    ok(res.rechecked === 1 && res.recheckTried === 1,
       "one due null row must yield recheckTried=1 and rechecked=1, got " + JSON.stringify(res));
    const stored = JSON.parse(await kv.get(reportKey(dateStr)));
    const storedRow = stored.rows.find((r) => r.address === addr);
    ok(storedRow.recheck === "sell" && typeof storedRow.recheckAt === "string",
       "a \"sell\" verdictOf reply must store recheck:\"sell\" with a recheckAt string, got " +
       JSON.stringify(storedRow));
    ok(storedRow.v === null && storedRow.why === "no-quote",
       "the rechecked row's original v/why must stay exactly as they were, got " + JSON.stringify(storedRow));
  }

  // ب) یک verdictOf که برای یک هدف پرتاب می‌کند نباید بقیه را متوقف کند، و
  //    نباید کلِ گذر را بشکند
  {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const addrThrow = mkAddrP(2);
    const addrOk = mkAddrP(3);
    const rowThrow = seedOldNullRow(NOW, addrThrow);
    const rowOk = seedOldNullRow(NOW, addrOk);
    const seedDoc = mergeReportDoc(null, dateStr, [rowThrow, rowOk], 2, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKvR();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    const res = await runReportPass({
      kv, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async (addr) => {
        if (addr === addrThrow) throw new Error("rpc is down");
        return { v: "nosell", why: null, cause: "empty-pool" };
      },
      now: () => NOW, sleep: async () => {},
    });
    ok(res.recheckTried === 2, "both due null rows must be attempted, got " + JSON.stringify(res));
    ok(res.rechecked === 1,
       "only the non-throwing target must actually gain a recheck key, got " + JSON.stringify(res));
    const stored = JSON.parse(await kv.get(reportKey(dateStr)));
    const storedThrow = stored.rows.find((r) => r.address === addrThrow);
    const storedOk = stored.rows.find((r) => r.address === addrOk);
    ok(!("recheck" in storedThrow), "the throwing target must gain no recheck key, got " +
       JSON.stringify(storedThrow));
    ok(storedOk.recheck === "nosell" && storedOk.recheckCause === "empty-pool",
       "the other target must still be rechecked normally, got " + JSON.stringify(storedOk));
  }

  // ج) یک فالوآپ که در همین گذر نوشته شد باید بعدِ گامِ رِی‌چک هم بماند —
  //    latestDoc نباید کارِ applyFollowUps را پاک کند
  {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const dateStr = utcDateOf(NOW);
    const addrSell = mkAddrP(4);
    const addrNull = mkAddrP(5);
    const sellRow = seedOldSellRowP(NOW, addrSell);
    const nullRow = seedOldNullRow(NOW, addrNull);
    const seedDoc = mergeReportDoc(null, dateStr, [sellRow, nullRow], 2, new Date(NOW - 100 * 60000).toISOString());
    const kv = makeKvR();
    await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));
    await kv.put(PAIRS_KEY_BASE, JSON.stringify([{ address: addrSell, v: "sell" }]));
    const res = await runReportPass({
      kv, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async () => ({ v: "sell", why: null }),
      now: () => NOW, sleep: async () => {},
      poolEmptyOf: async () => true,
    });
    ok(res.followed === 1 && res.rechecked === 1,
       "both the follow-up and the recheck step must do their own job in the same pass, got " +
       JSON.stringify(res));
    const stored = JSON.parse(await kv.get(reportKey(dateStr)));
    const storedSell = stored.rows.find((r) => r.address === addrSell);
    const storedNull = stored.rows.find((r) => r.address === addrNull);
    ok(storedSell.follow === "pool-empty" && typeof storedSell.followAt === "string",
       "the follow-up written earlier in the pass must survive the later recheck step, got " +
       JSON.stringify(storedSell));
    ok(storedNull.recheck === "sell" && typeof storedNull.recheckAt === "string",
       "the recheck step must still do its own job alongside the surviving follow-up, got " +
       JSON.stringify(storedNull));
  }

  console.log("[report recheck pass] runReportPass's recheck step reuses the same injected metaOf/" +
    "verdictOf as the main loop to re-ask a due null row, storing recheck:\"sell\"/\"nosell\" (with " +
    "recheckCause when applicable) while leaving that row's original v/why untouched; a verdictOf that " +
    "throws for one target skips only that target, never stops the others and never breaks the pass; " +
    "and a follow-up written earlier in the same pass survives the later recheck step untouched (no " +
    "clobbering via latestDoc)");
}

/* ---- reportText — بایت‌به‌بایت پیش و پس از applyRechecks ---- */
{
  function mkAddrT(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  const T1T = "2026-09-20T10:00:00.000Z";
  const rowSellT = reportRow({
    chain: "base", address: mkAddrT(1), symbol: "T1", name: "N1", verdict: "sell",
    checkedAt: T1T, poolCreatedAt: null, priceUsd: 1, reserveUsd: 100000, vol24hUsd: 3, fdvUsd: 4,
    dex: "uniswap-v4-base", why: null,
  });
  const rowNullT = reportRow({
    chain: "base", address: mkAddrT(2), symbol: "T2", name: "N2", verdict: null,
    checkedAt: T1T, poolCreatedAt: null, priceUsd: 1, reserveUsd: 100000, vol24hUsd: 3, fdvUsd: 4,
    dex: "uniswap-v4-base", why: "no-quote",
  });
  const docBeforeT = {
    date: "2026-09-20", generatedAt: T1T, chains: ["base"], checked: 2, rows: [rowSellT, rowNullT],
  };
  const textBeforeT = reportText(docBeforeT);

  const docAfterT = applyRechecks(docBeforeT, [{ address: mkAddrT(2), recheck: "sell" }],
    "2026-09-20T11:00:00.000Z");
  const textAfterT = reportText(docAfterT);

  ok(textBeforeT === textAfterT,
     "reportText must be byte-for-byte identical before and after applyRechecks, got:\n" +
     JSON.stringify(textBeforeT) + "\nvs\n" + JSON.stringify(textAfterT));
  ok(docAfterT.rows[1].recheck === "sell",
     "sanity: the recheck must actually have been applied to the doc reportText was given, got " +
     JSON.stringify(docAfterT.rows[1]));

  console.log("[report recheck text] reportText's output is byte-for-byte identical whether or not a " +
    "row carries recheck keys — the public text counts only original verdicts, never a recheck");
}

/* ---- recheck زنده می‌ماند تا گذرِ بعدی — mergeReportDoc اول‌دیده‌شده‌می‌برد ---- */
{
  function mkAddrS(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function makeKvS() {
    const store = new Map();
    return {
      store,
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
    };
  }
  function poolRowS(addr, reserve, price) {
    return {
      attributes: { reserve_in_usd: String(reserve), base_token_price_usd: String(price),
        pool_created_at: "2026-09-20T10:00:00Z", volume_usd: { h24: "0" }, fdv_usd: "0" },
      relationships: { base_token: { data: { id: "base_" + addr } },
        dex: { data: { id: "uniswap-v3-base" } } },
    };
  }
  const NOW1 = Date.parse("2026-09-20T12:00:00.000Z");
  const dateStr = utcDateOf(NOW1);
  const rechAddr = mkAddrS(1);
  const rechAtIso = "2026-09-20T11:55:00.000Z";
  const rechRow = Object.assign(reportRow({
    chain: "base", address: rechAddr, symbol: "OLD", name: "Old Token", verdict: null,
    checkedAt: new Date(NOW1 - 100 * 60000).toISOString(), poolCreatedAt: null,
    priceUsd: 1, reserveUsd: 2, vol24hUsd: 3, fdvUsd: 4, dex: "uniswap-v4-base", why: "no-quote",
  }), { recheck: "sell", recheckAt: rechAtIso });
  const seedDoc = mergeReportDoc(null, dateStr, [rechRow], 1, new Date(NOW1 - 100 * 60000).toISOString());
  const kv = makeKvS();
  await kv.put(reportKey(dateStr), JSON.stringify(seedDoc));

  const freshAddr = mkAddrS(2);
  const NOW2 = NOW1 + 5 * 60000; // پنج دقیقه بعد، همان روزِ UTC
  const res = await runReportPass({
    kv, fetchPools: async () => [poolRowS(freshAddr, 10000, 0.5)],
    metaOf: async () => ({ meta: { symbol: "NEW", name: "New Token" }, why: null }),
    verdictOf: async () => ({ v: "sell", why: null }),
    now: () => NOW2, sleep: async () => {},
  });
  ok(res.added === 1, "the second pass must still add the one brand-new token, got " + JSON.stringify(res));

  const stored = JSON.parse(await kv.get(reportKey(dateStr)));
  const storedRech = stored.rows.find((r) => r.address === rechAddr);
  const storedFresh = stored.rows.find((r) => r.address === freshAddr);
  ok(storedRech.recheck === "sell" && storedRech.recheckAt === rechAtIso,
     "the row rechecked in a prior pass must keep its recheck+recheckAt after a later pass adds new " +
     "rows via mergeReportDoc (first-occurrence wins), got " + JSON.stringify(storedRech));
  ok(!!storedFresh, "the fresh token from the second pass must also be present, got " + JSON.stringify(stored));

  console.log("[report recheck survive] recheck+recheckAt from an earlier pass survive an unrelated " +
    "later pass that adds new rows — mergeReportDoc's first-occurrence-wins merge keeps the already-" +
    "rechecked row exactly as it was, the same way a follow keeps its follow/followAt");
}

/* ---- ۴۲. classifyCapProbe — واژه‌نامه‌ی بسته‌ی REPORT_CAP_PROBE، با کنترلِ مثبت ----
   این تنها کلاسی که روی متنِ پیام سنجیده می‌شود ("cap") بدونِ کنترلِ مثبت
   قابلِ‌اعتماد نیست — پس همان‌جا کنارِ سه‌تای دیگر، هرکدام با یک fetchِ جعلیِ
   واقعی، نه فرضی. */
{
  ok(JSON.stringify(REPORT_CAP_PROBE) === JSON.stringify(["ok", "cap", "timeout", "threw"]),
     "REPORT_CAP_PROBE must be exactly the closed vocabulary [\"ok\",\"cap\",\"timeout\",\"threw\"], got "
     + JSON.stringify(REPORT_CAP_PROBE));

  const okC = await classifyCapProbe(async () => new Response("rate limited", { status: 429 }));
  ok(okC === "ok", "a real 429 Response must classify as \"ok\" (any Response, any status), got " + okC);

  const capC = await classifyCapProbe(async () => { throw new Error("Too many subrequests."); });
  ok(capC === "cap", "a thrown \"Too many subrequests.\" must classify as \"cap\", got " + capC);

  const timeoutC = await classifyCapProbe(async () => {
    const e = new Error("The operation was aborted."); e.name = "AbortError"; throw e;
  });
  ok(timeoutC === "timeout", "a thrown AbortError must classify as \"timeout\", got " + timeoutC);

  const threwC = await classifyCapProbe(async () => { throw new TypeError("x"); });
  ok(threwC === "threw", "any other thrown error (e.g. TypeError) must classify as \"threw\", got " + threwC);

  const oddC = await classifyCapProbe(async () => ({ status: 200 }));
  ok(oddC === "threw", "a resolved non-Response value must classify as \"threw\", not a guess, got " + oddC);

  console.log("[cap probe] classifyCapProbe ok — REPORT_CAP_PROBE is the closed [\"ok\",\"cap\","
    + "\"timeout\",\"threw\"] vocabulary; positive controls: a real 429 Response -> \"ok\", a thrown "
    + "\"Too many subrequests.\" -> \"cap\", a thrown AbortError -> \"timeout\", a thrown TypeError and "
    + "a resolved non-Response value both -> \"threw\"");
}

/* ---- ۴۳. runReportPass — لاگِ گذر (report:passlog) و capProbe ---- */
{
  function makeKvP() {
    const store = new Map();
    return { store, get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); } };
  }
  function mkAddrP(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function poolRowP(addr, reserve, price) {
    return {
      attributes: { reserve_in_usd: String(reserve), base_token_price_usd: String(price),
        pool_created_at: "2026-09-21T10:00:00Z", volume_usd: { h24: "0" }, fdv_usd: "0" },
      relationships: { base_token: { data: { id: "base_" + addr } }, dex: { data: { id: "uniswap-v3-base" } } },
    };
  }
  const NOWP = Date.parse("2026-09-21T12:00:00.000Z");

  // الف) probeFetch غایب → capProbe کلاً غایب، هم در نتیجه هم در ردیفِ لاگ
  const kvA1 = makeKvP();
  const resNoProbe = await runReportPass({
    kv: kvA1, fetchPools: async () => [poolRowP(mkAddrP(1), 9000, 1)],
    metaOf: async () => ({ meta: { symbol: "P1", name: "P1" }, why: null }),
    verdictOf: async () => ({ v: "sell", why: null }),
    now: () => NOWP, sleep: async () => {},
  });
  ok(!Object.prototype.hasOwnProperty.call(resNoProbe, "capProbe"),
     "with no probeFetch injected, capProbe must be absent from the pass result, got " +
     JSON.stringify(resNoProbe));
  const logA1 = JSON.parse(await kvA1.get(PASS_LOG_KEY));
  ok(Array.isArray(logA1) && logA1.length === 1,
     "the pass log must gain exactly one entry, got " + JSON.stringify(logA1));
  ok(!Object.prototype.hasOwnProperty.call(logA1[0], "capProbe"),
     "with no probeFetch, the stored pass record must not carry a capProbe key, got " + JSON.stringify(logA1[0]));

  // ب) probeFetch حاضر → capProbe در نتیجه و در ردیفِ لاگ، هر دو
  const kvA2 = makeKvP();
  const resProbe = await runReportPass({
    kv: kvA2, fetchPools: async () => [poolRowP(mkAddrP(2), 9000, 1)],
    metaOf: async () => ({ meta: { symbol: "P2", name: "P2" }, why: null }),
    verdictOf: async () => ({ v: "nosell", why: null }),
    now: () => NOWP, sleep: async () => {},
    probeFetch: async () => new Response("", { status: 200 }),
  });
  ok(resProbe.capProbe === "ok",
     "with a probeFetch resolving to a Response, the returned capProbe must be \"ok\", got " +
     JSON.stringify(resProbe.capProbe));
  const logA2 = JSON.parse(await kvA2.get(PASS_LOG_KEY));
  ok(logA2[0].capProbe === "ok", "the stored pass record must carry the same capProbe, got " +
     JSON.stringify(logA2[0]));

  // پ) شکلِ ردیفِ لاگ — فقط عدد/رشته‌ی بسته، هیچ آدرس/symbol/why
  const rec = logA2[0];
  ok(typeof rec.at === "string" && typeof rec.checked === "number" && typeof rec.added === "number" &&
     typeof rec.addedSol === "number" && typeof rec.followed === "number" &&
     typeof rec.rechecked === "number" && typeof rec.recheckTried === "number",
     "the pass record must carry at/checked/added/addedSol/followed/rechecked/recheckTried as " +
     "string/numbers, got " + JSON.stringify(rec));
  for (const side of ["base", "sol"]) {
    const s = rec[side];
    ok(s && typeof s.n === "number" && typeof s.nulls === "number" && typeof s.firstNullIdx === "number",
       "rec." + side + " must carry {n, nulls, firstNullIdx} as numbers, got " + JSON.stringify(s));
  }
  ok(REPORT_CAP_PROBE.includes(rec.capProbe),
     "rec.capProbe must be a member of the closed REPORT_CAP_PROBE vocabulary, got " +
     JSON.stringify(rec.capProbe));
  const recKeys = Object.keys(rec).sort();
  ok(JSON.stringify(recKeys) === JSON.stringify(
       ["added", "addedSol", "at", "base", "capAt", "capProbe", "checked", "discarded", "followed",
        "metaBatch", "recheckTried", "rechecked", "sol", "stoppedAt"]),
     "the pass record must carry exactly its documented keys, nothing else, got " + JSON.stringify(recKeys));
  const recRaw = JSON.stringify(logA2);
  ok(!/0x[0-9a-f]{40}/i.test(recRaw),
     "no 0x<40 hex> address may ever appear in the stored pass log, got " + recRaw);

  // ت) base.n/nulls/firstNullIdx واقعاً از رویِ ردیف‌های همین گذر می‌آید، به‌ترتیبِ چک‌شدن
  const kvA3 = makeKvP();
  const rowsMixedNull = [poolRowP(mkAddrP(11), 9000, 1), poolRowP(mkAddrP(12), 9000, 1),
    poolRowP(mkAddrP(13), 9000, 1)];
  let callN = 0;
  await runReportPass({
    kv: kvA3, fetchPools: async () => rowsMixedNull,
    metaOf: async () => ({ meta: { symbol: "M", name: "M" }, why: null }),
    verdictOf: async () => {
      callN++;
      return callN === 2 ? { v: null, why: "no-quote" } : { v: "sell", why: null };
    },
    now: () => NOWP, sleep: async () => {},
  });
  const logA3 = JSON.parse(await kvA3.get(PASS_LOG_KEY));
  ok(logA3[0].base.n === 3 && logA3[0].base.nulls === 1 && logA3[0].base.firstNullIdx === 1,
     "with the 2nd of 3 tokens returning v:null, base must be {n:3, nulls:1, firstNullIdx:1}, got " +
     JSON.stringify(logA3[0].base));

  // چ) پایِ سولانا هم — هیچ mintِ base58ای در لاگِ ذخیره‌شده ننشیند
  const B58_P = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function mkSolAddrP(n) {
    let s = "";
    const x = n + 2000;
    for (let i = 0; i < 44; i++) s += B58_P[(x + i * 7) % B58_P.length];
    return s;
  }
  function solPoolRowP(addr) {
    return {
      attributes: { reserve_in_usd: "9000", base_token_price_usd: "1",
        pool_created_at: "2026-09-21T09:00:00Z", volume_usd: { h24: "10" }, fdv_usd: "100" },
      relationships: { base_token: { data: { id: "solana_" + addr } }, dex: { data: { id: "pumpswap" } } },
    };
  }
  const kvA3b = makeKvP();
  const solMint = mkSolAddrP(1);
  await runReportPass({
    kv: kvA3b, fetchPools: async () => [], fetchPoolsSol: async () => [solPoolRowP(solMint)],
    metaOf: async () => ({ meta: { symbol: "SM", name: "SM" }, why: null }),
    verdictOf: async () => ({ v: "sell", why: null }),
    now: () => NOWP, sleep: async () => {},
  });
  const logA3b = JSON.parse(await kvA3b.get(PASS_LOG_KEY));
  ok(logA3b[0].sol.n === 1,
     "the Solana leg must still reach the pass record (sol.n:1), got " + JSON.stringify(logA3b[0].sol));
  const logA3bRaw = JSON.stringify(logA3b);
  ok(!logA3bRaw.includes(solMint),
     "the base58 mint itself must never appear verbatim in the stored pass log, got " + logA3bRaw);
  ok(!/0x[0-9a-f]{40}/i.test(logA3bRaw) && !new RegExp("[" + B58_P + "]{32,44}").test(logA3bRaw),
     "no 0x<40 hex> address and no base58-shaped (32-44 char) mint string may ever appear in the " +
     "stored pass log, got " + logA3bRaw);

  // ث) حلقه — تازه‌ترین اول، سقف در REPORT_PASS_LOG_CAP
  const kvA4 = makeKvP();
  for (let i = 0; i < REPORT_PASS_LOG_CAP + 5; i++) {
    await runReportPass({
      kv: kvA4, fetchPools: async () => [], metaOf: async () => ({ meta: null, why: "meta:429" }),
      verdictOf: async () => ({ v: null, why: "no-quote" }), now: () => NOWP + i, sleep: async () => {},
    });
  }
  const logA4 = JSON.parse(await kvA4.get(PASS_LOG_KEY));
  ok(logA4.length === REPORT_PASS_LOG_CAP,
     "the pass log ring must cap at exactly REPORT_PASS_LOG_CAP (" + REPORT_PASS_LOG_CAP + "), got " +
     logA4.length);
  ok(logA4[0].at === new Date(NOWP + REPORT_PASS_LOG_CAP + 4).toISOString(),
     "the newest pass must sort first in the ring, got " + JSON.stringify(logA4[0].at));

  // ج) نوشتنِ لاگ هرگز نباید خودِ گذر را بشکند — یک KV که فقط put رویِ همین کلید پرتاب می‌کند
  const kvThrowsPut = {
    get: async () => null,
    put: async (k) => { if (k === PASS_LOG_KEY) throw new Error("kv put is down"); },
  };
  const resThrowsLog = await runReportPass({
    kv: kvThrowsPut, fetchPools: async () => [poolRowP(mkAddrP(9), 9000, 1)],
    metaOf: async () => ({ meta: { symbol: "T9", name: "T9" }, why: null }),
    verdictOf: async () => ({ v: "sell", why: null }),
    now: () => NOWP, sleep: async () => {}, probeFetch: async () => new Response("", { status: 200 }),
  });
  ok(resThrowsLog.checked === 1 && resThrowsLog.added === 1,
     "a throwing report:passlog kv.put must not break the pass itself, got " + JSON.stringify(resThrowsLog));

  console.log("[report passlog] runReportPass ok — probeFetch missing leaves capProbe absent from both "
    + "the result and the stored record; a resolving probeFetch classifies via classifyCapProbe and rides "
    + "on both; each pass record carries exactly {at, checked, added, addedSol, followed, rechecked, "
    + "recheckTried, base:{n,nulls,firstNullIdx}, sol:{n,nulls,firstNullIdx}, capProbe} with no address "
    + "ever in it; base/sol n/nulls/firstNullIdx reflect the rows built in that pass in check order; the "
    + "ring sorts newest-first and caps at " + REPORT_PASS_LOG_CAP + "; and a throwing report:passlog "
    + "kv.put never breaks the pass itself");
}

/* ---- ۴۴. GET /report/run — capProbe در پاسخ ---- */
{
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/new_pools")) return new Response(JSON.stringify({ data: [] }),
      { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/networks?page=1")) return new Response("", { status: 200 });
    return new Response("must never be reached", { status: 500 });
  };
  const kvCP = { get: async () => null, put: async () => {} };
  const res = await call("/report/run", { method: "GET", headers: { "x-run-key": "cap-probe-key" } },
    { ASSETS, ZX_KV: kvCP, RUN_KEY: "cap-probe-key" });
  globalThis.fetch = savedFetch;
  ok(res.status === 200, "GET /report/run must be 200, got " + res.status);
  const body = await res.json();
  ok(REPORT_CAP_PROBE.includes(body.capProbe),
     "GET /report/run's response must carry capProbe from the closed vocabulary, got " + JSON.stringify(body));
  ok(body.capProbe === "ok",
     "with the injected probe fetch resolving to a Response, capProbe must be \"ok\" end to end through " +
     "GET /report/run, got " + JSON.stringify(body.capProbe));

  console.log("[report run capProbe] GET /report/run's response now carries capProbe (\"ok\" end to end "
    + "when the injected probe fetch resolves to a Response)");
}

/* ---- ۴۵. GET /vd/passes — رونوشتِ خواندنیِ لاگِ گذر ---- */
{
  const rNoKvP = await call("/vd/passes", { headers: { "cf-connecting-ip": "203.0.113.90" } },
    { ASSETS });
  ok(rNoKvP.status === 200, "GET /vd/passes without ZX_KV must still be 200, got " + rNoKvP.status);
  const bNoKvP = await rNoKvP.json();
  ok(Array.isArray(bNoKvP.passes) && bNoKvP.passes.length === 0,
     "without ZX_KV, /vd/passes must answer {passes:[]}, got " + JSON.stringify(bNoKvP));
  ok(rNoKvP.headers.get("cache-control") === "no-store",
     "GET /vd/passes must be no-store, got " + rNoKvP.headers.get("cache-control"));

  const fakeRing = [{ at: "2026-09-21T12:00:00.000Z", checked: 1, added: 1, addedSol: 0, followed: 0,
    rechecked: 0, recheckTried: 0, base: { n: 1, nulls: 0, firstNullIdx: -1 },
    sol: { n: 0, nulls: 0, firstNullIdx: -1 }, capProbe: "ok" }];
  const kvWithLog = { get: async (k) => (k === PASS_LOG_KEY ? JSON.stringify(fakeRing) : null) };
  const rWithLog = await call("/vd/passes", { headers: { "cf-connecting-ip": "203.0.113.91" } },
    { ASSETS, ZX_KV: kvWithLog });
  ok(rWithLog.status === 200, "GET /vd/passes with a stored ring must be 200, got " + rWithLog.status);
  const bWithLog = await rWithLog.json();
  ok(JSON.stringify(bWithLog.passes) === JSON.stringify(fakeRing),
     "GET /vd/passes must return exactly the stored ring, got " + JSON.stringify(bWithLog));

  const rPostP = await call("/vd/passes",
    { method: "POST", headers: { "cf-connecting-ip": "203.0.113.92" } }, { ASSETS, ZX_KV: kvWithLog });
  ok(rPostP.status === 405, "POST /vd/passes must be 405, got " + rPostP.status);

  const { RL_LIMIT: RL_LIMIT_PASSES } = await import("./index.js");
  const RL_IP_PASSES = "203.0.113.93";
  for (let i = 0; i < RL_LIMIT_PASSES; i++) {
    await call("/vd/passes", { headers: { "cf-connecting-ip": RL_IP_PASSES } }, { ASSETS, ZX_KV: kvWithLog });
  }
  const limitedPasses = await call("/vd/passes", { headers: { "cf-connecting-ip": RL_IP_PASSES } },
    { ASSETS, ZX_KV: kvWithLog });
  ok(limitedPasses.status === 429,
     "the (RL_LIMIT+1)th /vd/passes request from one IP must be rate-limited, got " + limitedPasses.status);

  console.log("[vd passes] GET /vd/passes ok — {passes:[]} without ZX_KV, the stored report:passlog ring "
    + "returned verbatim when present, no-store, 405 for non-GET, and shares the \"vd\" rate-limit bucket");
}

/* ---- ۴۶. متر ساب‌ریکوئست — [pass meter] ----
   اندازه‌گیریِ زنده‌ی ۱۸:۱۷ UTC به سقفِ ساب‌ریکوئست خورد (capProbe:"cap")؛
   این بخش خودِ makeSubMeter/meterKv (worker/index.js) را مستقیم می‌سنجد و
   بعد سیم‌کشیِ کاملش داخلِ runReportPass (worker/report.js) را — همه‌چیز
   فقط اندازه‌گیری است، هیچ رفتاری از خودِ گذر عوض نمی‌شود. */
{
  // الف) fetch — شمارش زیرِ مرحله‌ی جاری و hostname (نه مسیر/کوئری)
  const savedGF1 = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(String(u), { status: 200 });
  const meterA = makeSubMeter();
  globalThis.fetch = savedGF1;

  meterA.stage("pools");
  await meterA.fetch("https://host-a.example.com/pools?x=1");
  await meterA.fetch("https://host-a.example.com/pools/2");
  meterA.stage("base-token");
  await meterA.fetch("https://host-b.example.com/meta/0xabc");
  meterA.stage("probe");
  await meterA.fetch("https://host-a.example.com/probe");

  const snapA = meterA.snapshot();
  ok(snapA.total === 4, "makeSubMeter: total must count every fetch exactly once, got " + snapA.total);
  ok(JSON.stringify(snapA.byStage) === JSON.stringify({ pools: 2, "base-token": 1, probe: 1 }),
     "makeSubMeter: byStage must attribute each fetch to the stage active at call time, got " +
     JSON.stringify(snapA.byStage));
  ok(JSON.stringify(snapA.byHost) === JSON.stringify({ "host-a.example.com": 3, "host-b.example.com": 1 }),
     "makeSubMeter: byHost must key on hostname only (path/query dropped), got " + JSON.stringify(snapA.byHost));

  // ب) URLِ ناپارس‌شدنی → hostname "?"
  const savedGF2 = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200 });
  const meterB = makeSubMeter();
  globalThis.fetch = savedGF2;
  meterB.stage("pools");
  await meterB.fetch("not a url at all");
  const snapB = meterB.snapshot();
  ok(snapB.byHost["?"] === 1,
     "makeSubMeter: an unparseable URL must be counted under host \"?\", got " + JSON.stringify(snapB.byHost));

  // پ) یک URLِ حاملِ راز — فقط hostname می‌نشیند، هرگز مسیر/کوئری/کلید
  const savedGF3 = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200 });
  const meterC = makeSubMeter();
  globalThis.fetch = savedGF3;
  const secretUrl = "https://solana-mainnet.g.alchemy.com/v2/SECRETKEY123456789012345";
  meterC.stage("sol-token");
  await meterC.fetch(secretUrl);
  const snapC = meterC.snapshot();
  const rawC = JSON.stringify(snapC);
  ok(snapC.byHost["solana-mainnet.g.alchemy.com"] === 1,
     "makeSubMeter: a secret-bearing URL must still be recorded under its hostname, got " +
     JSON.stringify(snapC.byHost));
  ok(!rawC.includes("/v2/") && !rawC.toLowerCase().includes("secretkey"),
     "makeSubMeter: the path/key of a secret-bearing URL must never appear in the snapshot, got " + rawC);

  // ت) tokenStart/tokenEnd — دلتاهای درست، به‌ترتیب؛ cacheOp/kvOp هرگز در byHost نمی‌نشینند
  const savedGF4 = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200 });
  const meterD = makeSubMeter();
  globalThis.fetch = savedGF4;

  meterD.stage("base-token");
  meterD.tokenStart();
  await meterD.fetch("https://host-d.example.com/a");
  meterD.cacheOp();
  meterD.tokenEnd(); // دلتا: ۲

  meterD.stage("base-token");
  meterD.tokenStart();
  await meterD.fetch("https://host-d.example.com/b");
  meterD.tokenEnd(); // دلتا: ۱

  meterD.stage("sol-token");
  meterD.tokenStart();
  await meterD.fetch("https://host-d.example.com/c");
  await meterD.fetch("https://host-d.example.com/d");
  meterD.kvOp();
  meterD.tokenEnd(); // دلتا: ۳

  meterD.stage("pools"); // بیرونِ هر tokenStart/tokenEnd — نباید در هیچ آرایه‌ای بنشیند
  await meterD.fetch("https://host-d.example.com/e");

  const snapD = meterD.snapshot();
  ok(JSON.stringify(snapD.baseTokens) === JSON.stringify([2, 1]),
     "makeSubMeter: baseTokens must record each base-token window's delta, in order, got " +
     JSON.stringify(snapD.baseTokens));
  ok(JSON.stringify(snapD.solTokens) === JSON.stringify([3]),
     "makeSubMeter: solTokens must record each sol-token window's delta, got " + JSON.stringify(snapD.solTokens));
  ok(snapD.cache === 1, "makeSubMeter: cacheOp must be counted under cache, got " + snapD.cache);
  ok(snapD.kv === 1, "makeSubMeter: kvOp must be counted under kv, got " + snapD.kv);
  ok(!Object.prototype.hasOwnProperty.call(snapD.byHost, "cache") &&
     !Object.prototype.hasOwnProperty.call(snapD.byHost, "kv"),
     "makeSubMeter: cache/kv ops must never leak into byHost, got " + JSON.stringify(snapD.byHost));
  ok(snapD.total === 7, "makeSubMeter: total must equal fetch+cache+kv operations combined, got " + snapD.total);

  // ث) meterKv — فقط شمارش، هرگز مقدارِ برگشتیِ خودِ kv را عوض نمی‌کند
  const meterE = makeSubMeter();
  const storeE = new Map([["k1", "v1"]]);
  const fakeKvE = {
    get: async (k) => (storeE.has(k) ? storeE.get(k) : null),
    put: async (k, v) => { storeE.set(k, v); },
    list: async () => ({ keys: [{ name: "k1" }], list_complete: true }),
  };
  const wrappedE = meterKv(fakeKvE, meterE);
  meterE.stage("kv-write");
  const got1 = await wrappedE.get("k1");
  const got2 = await wrappedE.get("missing");
  await wrappedE.put("k2", "v2");
  const gotList = await wrappedE.list({ prefix: "k" });

  ok(got1 === "v1", "meterKv: get must return the exact same value as the underlying kv, got " + JSON.stringify(got1));
  ok(got2 === null, "meterKv: a miss must still come back as null through the wrapper, got " + JSON.stringify(got2));
  ok(storeE.get("k2") === "v2",
     "meterKv: put must still reach the underlying kv unmodified, got " + JSON.stringify(storeE.get("k2")));
  ok(gotList && Array.isArray(gotList.keys) && gotList.keys.length === 1,
     "meterKv: list must return the exact same value as the underlying kv, got " + JSON.stringify(gotList));
  const snapE = meterE.snapshot();
  ok(snapE.kv === 4, "meterKv: get/put/list (2 gets + 1 put + 1 list) must all be counted as kv, got " + snapE.kv);
  ok(snapE.byStage["kv-write"] === 4,
     "meterKv: kv ops must also land under the current stage, got " + JSON.stringify(snapE.byStage));

  console.log("[pass meter unit] makeSubMeter/meterKv ok — fetch counts under the current stage and under "
    + "the target hostname only, never the path/query; an unparseable URL falls to host \"?\"; a secret-bearing "
    + "URL (a Solana RPC-shaped path+key) is recorded only as its hostname; tokenStart/tokenEnd record the "
    + "exact per-window delta into baseTokens/solTokens, in order; cacheOp/kvOp count into their own dedicated "
    + "buckets and never leak into byHost; and meterKv counts get/put/list without ever changing what the "
    + "underlying KV binding returns");
}

/* ---- ۴۷. runReportPass + meter — سیم‌کشیِ مرحله‌به‌مرحله — [pass meter wiring] ----
   یک گذرِ کامل با fixtureهای تزریقی که هرکدام خودشان meter.fetch را صدا
   می‌زنند — دقیقاً همان چیزی که worker/index.js با جایگزینیِ موقتِ
   globalThis.fetch باعثش می‌شود، ولی اینجا صریح و قابل‌ردیابی. */
{
  function makeKvM() {
    const store = new Map();
    return { store, get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); } };
  }
  function mkAddrM(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function poolRowM(addr) {
    return {
      attributes: { reserve_in_usd: "9000", base_token_price_usd: "1",
        pool_created_at: "2026-09-21T10:00:00Z", volume_usd: { h24: "0" }, fdv_usd: "0" },
      relationships: { base_token: { data: { id: "base_" + addr } }, dex: { data: { id: "uniswap-v3-base" } } },
    };
  }
  const B58_M = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function mkSolAddrM(n) {
    let s = "";
    const x = n + 5000;
    for (let i = 0; i < 44; i++) s += B58_M[(x + i * 7) % B58_M.length];
    return s;
  }
  function solPoolRowM(addr) {
    return {
      attributes: { reserve_in_usd: "9000", base_token_price_usd: "1",
        pool_created_at: "2026-09-21T09:00:00Z", volume_usd: { h24: "10" }, fdv_usd: "100" },
      relationships: { base_token: { data: { id: "solana_" + addr } }, dex: { data: { id: "pumpswap" } } },
    };
  }
  const NOWM = Date.parse("2026-09-21T12:00:00.000Z");
  const oldIsoM = new Date(NOWM - 90 * 60000).toISOString();
  const seedDateM = utcDateOf(NOWM);
  const seedFollowAddr = mkAddrM(900);
  const seedRecheckAddr = mkAddrM(901);

  // دو ردیفِ «کاشته‌شده» از یک گذرِ فرضیِ قبلی — یکی کاندیدِ فالوآپ، یکی
  // کاندیدِ رِی‌چک؛ هر دو ۹۰ دقیقه قدیمی‌اند (بازه‌ی ۵۵ تا ۱۸۰) تا حتماً همین
  // گذر هر دو مرحله را واقعاً اجرا کند، نه فقط رد شود.
  const seedDoc = {
    date: seedDateM, generatedAt: oldIsoM, chains: ["base"], checked: 2,
    rows: [
      reportRow({ chain: "base", address: seedFollowAddr, symbol: "SF", name: "SF", verdict: "sell",
        checkedAt: oldIsoM, poolCreatedAt: oldIsoM, priceUsd: 1, reserveUsd: 9000, vol24hUsd: 0, fdvUsd: 0,
        dex: "uniswap-v3-base", why: null }),
      reportRow({ chain: "base", address: seedRecheckAddr, symbol: "SR", name: "SR", verdict: null,
        checkedAt: oldIsoM, poolCreatedAt: oldIsoM, priceUsd: 1, reserveUsd: 9000, vol24hUsd: 0, fdvUsd: 0,
        dex: "uniswap-v3-base", why: "no-quote" }),
    ],
  };

  function freshMeter() {
    const saved = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    const m = makeSubMeter();
    globalThis.fetch = saved;
    return m;
  }

  // fetcher: یا خودِ meter (اجرای متردار) یا یک شیءِ ساختگیِ هم‌شکل (اجرای
  // بدونِ meter) — تا دو اجرا دقیقاً همان fetchهای واقعی را انجام دهند.
  function makeFixture(fetcher) {
    return {
      fetchPools: async () => {
        await fetcher.fetch("https://pools.example.com/networks/base/new_pools");
        return [poolRowM(mkAddrM(1)), poolRowM(mkAddrM(2))];
      },
      metaOf: async (addr) => {
        await fetcher.fetch("https://meta.example.com/networks/base/tokens/" + addr);
        return { meta: { symbol: "T", name: "T" }, why: null };
      },
      verdictOf: async (addr) => {
        await fetcher.fetch("https://verdict.example.com/rpc/" + addr + "?apikey=shouldnotleak12345");
        return { v: "sell", why: null };
      },
      fetchPoolsSol: async () => {
        await fetcher.fetch("https://solpools.example.com/networks/solana/new_pools");
        return [solPoolRowM(mkSolAddrM(1))];
      },
      poolEmptyOf: async (addr) => {
        await fetcher.fetch("https://poolempty.example.com/check/" + addr);
        return true;
      },
      probeFetch: async () => {
        await fetcher.fetch("https://probe.example.com/networks?page=1");
        return new Response("", { status: 200 });
      },
      now: () => NOWM,
      sleep: async () => {},
    };
  }

  async function runOnce(withMeter) {
    const kv = makeKvM();
    await kv.put(reportKey(seedDateM), JSON.stringify(seedDoc));
    const fetcher = withMeter ? freshMeter() : { fetch: async () => new Response("ok", { status: 200 }) };
    const fx = makeFixture(fetcher);
    const result = await runReportPass({
      kv: withMeter ? meterKv(kv, fetcher) : kv,
      meter: withMeter ? fetcher : undefined,
      fetchPools: fx.fetchPools, metaOf: fx.metaOf, verdictOf: fx.verdictOf,
      now: fx.now, sleep: fx.sleep, poolEmptyOf: fx.poolEmptyOf,
      fetchPoolsSol: fx.fetchPoolsSol, probeFetch: fx.probeFetch,
    });
    const storedRaw = await kv.get(PASS_LOG_KEY);
    const stored = JSON.parse(storedRaw)[0];
    return { result, stored, storedRaw };
  }

  const withM = await runOnce(true);
  const noM = await runOnce(false);

  // الف) غیاب meter → بدونِ کلیدِ sub، در نتیجه و در سندِ ذخیره‌شده هر دو
  ok(!Object.prototype.hasOwnProperty.call(noM.result, "sub"),
     "runReportPass without an injected meter must never add a sub key to its result, got " +
     JSON.stringify(noM.result));
  ok(!Object.prototype.hasOwnProperty.call(noM.stored, "sub"),
     "runReportPass without an injected meter must never add a sub key to the stored pass record, got " +
     JSON.stringify(noM.stored));

  // ب) غیاب meter → بایت‌به‌بایت همان چیزی که امروز برمی‌گشت (فقط sub فرق می‌کند)
  const { sub: _s1, ...resultWithoutSub } = withM.result;
  ok(JSON.stringify(resultWithoutSub) === JSON.stringify(noM.result),
     "apart from sub, an injected meter must never change runReportPass's returned result, got with=" +
     JSON.stringify(resultWithoutSub) + " without=" + JSON.stringify(noM.result));
  const { sub: _s2, ...storedWithoutSub } = withM.stored;
  ok(JSON.stringify(storedWithoutSub) === JSON.stringify(noM.stored),
     "apart from sub, an injected meter must never change the stored pass record, got with=" +
     JSON.stringify(storedWithoutSub) + " without=" + JSON.stringify(noM.stored));

  // پ) sub — دقیقاً هشت مرحله، هرکدام با شمارِ دقیق (حاصلِ همین fixture،
  // دست‌محاسبه‌شده: مرحله‌به‌مرحله زیرِ ویرایشِ report.js دنبال شده)
  const sub = withM.stored.sub;
  ok(sub && typeof sub === "object",
     "the stored pass record must carry a sub object when a meter is injected, got " + JSON.stringify(withM.stored));
  ok(sub.total === 18,
     "sub.total must equal the exact number of metered ops up to where the pass record is snapshotted, got " +
     sub.total);
  ok(JSON.stringify(sub.byStage) === JSON.stringify({
       pools: 2, "base-token": 4, "sol-pools": 1, "sol-token": 3, "kv-write": 4, follow: 1, recheck: 2, probe: 1,
     }), "sub.byStage must attribute every metered op to the exact stage active at call time, got " +
     JSON.stringify(sub.byStage));
  ok(JSON.stringify(sub.byHost) === JSON.stringify({
       "pools.example.com": 1, "meta.example.com": 4, "verdict.example.com": 4,
       "solpools.example.com": 1, "poolempty.example.com": 1, "probe.example.com": 1,
     }), "sub.byHost must key on hostname only, got " + JSON.stringify(sub.byHost));
  ok(JSON.stringify(sub.baseTokens) === JSON.stringify([2, 2]),
     "sub.baseTokens must carry one entry per Base token in check order, got " + JSON.stringify(sub.baseTokens));
  ok(JSON.stringify(sub.solTokens) === JSON.stringify([2]),
     "sub.solTokens must carry one entry per Solana token in check order, got " + JSON.stringify(sub.solTokens));
  ok(JSON.stringify(Object.keys(sub.byStage).sort()) === JSON.stringify([...REPORT_METER_STAGES].sort()),
     "this fixture must exercise every stage in the closed REPORT_METER_STAGES vocabulary at least once, got " +
     JSON.stringify(Object.keys(sub.byStage).sort()));

  // ت) هیچ مسیر/کوئری/رشته‌ی شبیه‌کلید هرگز در سندِ ذخیره‌شده نمی‌نشیند —
  // فقط hostname/نامِ مرحله/عدد. قاعده‌ی «رشته‌ی شبیه‌کلید»: ۲۰+ نویسه‌ی
  // پیوسته‌ی الفبایی‌عددی بدونِ نقطه‌ای در میانش — hostnameهای این فیکسچر
  // (که خودشان باید بمانند) قبل از سنجش حذف می‌شوند.
  ok(!/\/v2\//.test(withM.storedRaw),
     "the stored pass record must never carry a \"/v2/\" path segment, got " + withM.storedRaw);
  ok(!/apikey=/.test(withM.storedRaw) && !/shouldnotleak/i.test(withM.storedRaw),
     "the stored pass record must never carry a query string, got " + withM.storedRaw);
  const scrubbed = withM.storedRaw
    .replace(/[a-z0-9-]+\.example\.com/gi, "")
    .replace(/0x[0-9a-f]{40}/gi, "");
  ok(!/[A-Za-z0-9]{20,}/.test(scrubbed),
     "the stored pass record must never carry a key-looking (>=20 alnum, no dots) string outside of a known " +
     "hostname or address, got " + withM.storedRaw);
  for (const host of Object.keys(sub.byHost)) {
    ok(withM.storedRaw.includes(host),
       "each real hostname must still appear plainly in the stored record (that is the point), got missing " +
       host);
  }

  console.log("[pass meter wiring] runReportPass+meter ok — a full pass (Base pool+token, follow, recheck, "
    + "Solana pool+token, probe, kv-write) attributes every metered op to the exact stage active at call time "
    + "and to its exact hostname, with baseTokens/solTokens carrying the exact per-token delta in check order; "
    + "every stage in the closed REPORT_METER_STAGES vocabulary is exercised; no path, query, \"/v2/\" segment "
    + "or key-looking string ever reaches the stored report:passlog record, only hostnames/stage names/numbers "
    + "do; and omitting the meter leaves both the returned result and the stored record byte-for-byte identical "
    + "to the metered run, minus the sub key itself");
}

/* ---- ۴۸. globalThis.fetch همیشه در finally برمی‌گردد — [pass meter restore] ---- */
{
  const kvSchedOk = { get: async () => null, put: async () => {} };
  const okFetch = async (url) => {
    const u = String(url);
    if (u.includes("/new_pools")) return json({ data: [] });
    if (u.includes("/networks?page=1")) return new Response("", { status: 200 });
    return new Response("{}", { status: 200 });
  };
  globalThis.fetch = okFetch;
  await scheduledReportPass({ ZX_KV: kvSchedOk }, {});
  ok(globalThis.fetch === okFetch,
     "scheduledReportPass must restore globalThis.fetch to its pre-call value after a normal pass, got a " +
     "different function");

  const kvSchedThrow = { get: async () => null, put: async () => {} };
  const throwFetch = async () => { throw new Error("network exploded mid-stage"); };
  globalThis.fetch = throwFetch;
  await scheduledReportPass({ ZX_KV: kvSchedThrow }, {});
  ok(globalThis.fetch === throwFetch,
     "scheduledReportPass must restore globalThis.fetch to its pre-call value even when every stage's fetch " +
     "throws, got a different function");

  globalThis.fetch = trackingFetch; // برگرداندنِ حالتِ سراسریِ فایل تست

  console.log("[pass meter restore] scheduledReportPass ok — globalThis.fetch is swapped for meter.fetch only "
    + "for the duration of the pass and is always put back in a finally, whether the pass completes normally "
    + "or every injected fetch throws mid-stage");
}

/* ---- ۴۹. سقفِ ساب‌ریکوئست: توقفِ گذر، هرگز ذخیره‌ی ردیفِ آلوده، متادیتای
   دسته‌ای — [pass budget] ----
   makeSubMeter.capHit/capAt، capHit تزریقیِ runReportPass، دورریختنِ ردیفِ
   نیمه‌کاره، سهمِ هر مرحله، و ogFetchMetaMany — همه‌شان از رویِ همان لاگِ
   گذرِ زنده‌ی ۱۹:۱۷ UTC که در بالای این فایل توضیح داده شد. */
{
  function makeKvBudget() {
    const store = new Map();
    return { store, get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v) => { store.set(k, v); } };
  }
  function mkAddrBudget(n) { return "0x" + n.toString(16).padStart(40, "0"); }
  function poolRowBudget(addr) {
    return {
      attributes: { reserve_in_usd: "9000", base_token_price_usd: "1",
        pool_created_at: "2026-09-21T10:00:00Z", volume_usd: { h24: "0" }, fdv_usd: "0" },
      relationships: { base_token: { data: { id: "base_" + addr } }, dex: { data: { id: "uniswap-v3-base" } } },
    };
  }
  const B58_BUDGET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function mkSolAddrBudget(n) {
    let s = "";
    const x = n + 9000;
    for (let i = 0; i < 44; i++) s += B58_BUDGET[(x + i * 7) % B58_BUDGET.length];
    return s;
  }
  function solPoolRowBudget(addr) {
    return {
      attributes: { reserve_in_usd: "9000", base_token_price_usd: "1",
        pool_created_at: "2026-09-21T09:00:00Z", volume_usd: { h24: "10" }, fdv_usd: "100" },
      relationships: { base_token: { data: { id: "solana_" + addr } }, dex: { data: { id: "pumpswap" } } },
    };
  }
  function shapeOkPassRecord(rec) {
    ok(rec.stoppedAt === null || REPORT_METER_STAGES.includes(rec.stoppedAt),
       "stoppedAt must be null or a member of REPORT_METER_STAGES, got " + JSON.stringify(rec.stoppedAt));
    ok(typeof rec.discarded === "number", "discarded must be a number, got " + JSON.stringify(rec.discarded));
    ok(["ok", "failed", "absent"].includes(rec.metaBatch),
       "metaBatch must be one of ok/failed/absent, got " + JSON.stringify(rec.metaBatch));
    ok(rec.capAt === null || (typeof rec.capAt.ops === "number" && typeof rec.capAt.fetches === "number" &&
       typeof rec.capAt.cache === "number"),
       "capAt must be null or {ops,fetches,cache} numbers, got " + JSON.stringify(rec.capAt));
    ok(!/0x[0-9a-f]{40}/i.test(JSON.stringify(rec)) && !/https?:\/\//i.test(JSON.stringify(rec)),
       "no address or URL may ever appear in the stored pass record, got " + JSON.stringify(rec));
  }

  // الف) makeSubMeter — capHit/capAt
  {
    // یک fetch که پیامِ سقف را پرتاب می‌کند
    const savedF1 = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Too many subrequests."); };
    const meter1 = makeSubMeter();
    globalThis.fetch = savedF1;

    ok(meter1.isCapHit() === false && meter1.capAt === null,
       "a fresh meter must start with capHit:false and capAt:null");

    let threw1 = null;
    try { await meter1.fetch("https://host-budget.example.com/a"); } catch (e) { threw1 = e; }
    ok(threw1 && threw1.message === "Too many subrequests.",
       "a cap-shaped throw must propagate unchanged, got " + threw1);
    ok(meter1.isCapHit() === true, "a cap-shaped throw must set capHit:true");
    ok(meter1.capAt && JSON.stringify(meter1.capAt) === JSON.stringify({ ops: 1, fetches: 1, cache: 0 }),
       "capAt must be the meter's own running totals at that moment, got " + JSON.stringify(meter1.capAt));
    const capAtFirst = meter1.capAt;

    // یک ضربه‌ی دومِ سقف — capAt دیگر جابه‌جا نمی‌شود
    let threw2 = null;
    try { await meter1.fetch("https://host-budget.example.com/b"); } catch (e) { threw2 = e; }
    ok(threw2 && threw2.message === "Too many subrequests.",
       "a second cap-shaped throw must still propagate unchanged, got " + threw2);
    ok(JSON.stringify(meter1.capAt) === JSON.stringify(capAtFirst),
       "a later cap error must never move capAt, got " + JSON.stringify(meter1.capAt) + " vs first " +
       JSON.stringify(capAtFirst));

    // یک خطای غیرِسقف — capHit هرگز true نمی‌شود
    const savedF2 = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network exploded"); };
    const meter2 = makeSubMeter();
    globalThis.fetch = savedF2;
    let threw3 = null;
    try { await meter2.fetch("https://host-budget.example.com/c"); } catch (e) { threw3 = e; }
    ok(threw3 && threw3.message === "network exploded",
       "a non-cap throw must still propagate unchanged, got " + threw3);
    ok(meter2.isCapHit() === false && meter2.capAt === null,
       "a non-cap throw must never set capHit/capAt, got isCapHit=" + meter2.isCapHit() + " capAt=" +
       JSON.stringify(meter2.capAt));

    // یک عملیاتِ کش که به سقف می‌خورد هم — از همان مسیری که کالرِ واقعی
    // (scheduledReportPass در index.js) با noteThrow استفاده می‌کند
    const savedF3 = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 200 });
    const meter3 = makeSubMeter();
    globalThis.fetch = savedF3;
    meter3.cacheOp();
    meter3.noteThrow(new Error("Too many subrequests. (cache)"));
    ok(meter3.isCapHit() === true, "a cache op reporting the cap error via noteThrow must set capHit");
    ok(meter3.capAt && meter3.capAt.cache === 1 && meter3.capAt.fetches === 0,
       "capAt from a cache-op cap error must reflect the cache/fetch counters at that moment, got " +
       JSON.stringify(meter3.capAt));

    console.log("[pass budget meter] makeSubMeter ok — a fetch or a cache op reporting a \"too many " +
      "subrequests\" message sets capHit:true and freezes capAt at the meter's own running totals, the error " +
      "propagates unchanged, a later cap error never moves capAt again, and a non-cap error never sets " +
      "capHit at all");
  }

  // ب) runReportPass — capHit تزریقی که در میانه‌ی توکنِ سومِ Base true می‌شود
  {
    const NOWB = Date.parse("2026-09-21T13:00:00.000Z");
    const dateStrB = utcDateOf(NOWB);
    const oldIsoB = new Date(NOWB - 90 * 60000).toISOString();
    const followAddrB = mkAddrBudget(900);
    const recheckAddrB = mkAddrBudget(901);
    const seedDocB = {
      date: dateStrB, generatedAt: oldIsoB, chains: ["base"], checked: 2,
      rows: [
        reportRow({ chain: "base", address: followAddrB, symbol: "SF", name: "SF", verdict: "sell",
          checkedAt: oldIsoB, poolCreatedAt: oldIsoB, priceUsd: 1, reserveUsd: 9000, vol24hUsd: 0, fdvUsd: 0,
          dex: "uniswap-v3-base", why: null }),
        reportRow({ chain: "base", address: recheckAddrB, symbol: "SR", name: "SR", verdict: null,
          checkedAt: oldIsoB, poolCreatedAt: oldIsoB, priceUsd: 1, reserveUsd: 9000, vol24hUsd: 0, fdvUsd: 0,
          dex: "uniswap-v3-base", why: "no-quote" }),
      ],
    };
    const kvB = makeKvBudget();
    await kvB.put(reportKey(dateStrB), JSON.stringify(seedDocB));

    const addrsB = [1, 2, 3, 4, 5].map(mkAddrBudget);
    const poolsB = addrsB.map(poolRowBudget);
    const metaCallsB = [];
    const verdictCallsB = [];
    let solCalledB = 0;
    let followCalledB = 0;
    const capHitB = () => metaCallsB.length >= 3; // درست پس از metaOfِ توکنِ سوم true می‌شود

    const resB = await runReportPass({
      kv: kvB, fetchPools: async () => poolsB,
      metaOf: async (addr) => { metaCallsB.push(addr); return { meta: { symbol: "T", name: "T" }, why: null }; },
      verdictOf: async (addr) => { verdictCallsB.push(addr); return { v: "sell", why: null }; },
      now: () => NOWB, sleep: async () => {}, capHit: capHitB,
      fetchPoolsSol: async () => { solCalledB++; return []; },
      poolEmptyOf: async () => { followCalledB++; return true; },
    });

    ok(JSON.stringify(metaCallsB) === JSON.stringify(addrsB.slice(0, 3)),
       "capHit flipping during the 3rd Base token must call metaOf for exactly tokens 1-3 and no others, got " +
       JSON.stringify(metaCallsB));
    ok(JSON.stringify(verdictCallsB) === JSON.stringify(addrsB.slice(0, 3)),
       "capHit flipping during the 3rd Base token must call verdictOf for exactly tokens 1-3 and no others, " +
       "got " + JSON.stringify(verdictCallsB));
    ok(resB.checked === 3, "checked must count exactly the 3 attempted Base tokens, got " + resB.checked);
    ok(solCalledB === 0, "the Solana leg must never start once the Base leg hit the cap, got " + solCalledB);
    ok(followCalledB === 0, "the follow-up stage must never start once the Base leg hit the cap, got " +
       followCalledB);

    const storedDocB = JSON.parse(await kvB.get(reportKey(dateStrB)));
    const storedAddrsB = storedDocB.rows.map((r) => r.address);
    ok(!storedAddrsB.includes(addrsB[2]),
       "the token whose processing crossed the cap must never be stored in the doc, got " +
       JSON.stringify(storedAddrsB));
    ok(storedAddrsB.includes(addrsB[0]) && storedAddrsB.includes(addrsB[1]),
       "the two tokens finished before the cap must be stored normally, got " + JSON.stringify(storedAddrsB));

    const ringB = JSON.parse(await kvB.get(PAIRS_KEY_BASE)) || [];
    ok(!ringB.some((r) => r.address === addrsB[2]),
       "the token whose processing crossed the cap must never enter the pairs ring, got " +
       JSON.stringify(ringB.map((r) => r.address)));

    const logB = JSON.parse(await kvB.get(PASS_LOG_KEY));
    ok(Array.isArray(logB) && logB.length === 1, "the KV pass log must still gain exactly one entry, got " +
       JSON.stringify(logB));
    ok(logB[0].stoppedAt === "base-token", "stoppedAt must record \"base-token\", got " +
       JSON.stringify(logB[0].stoppedAt));
    ok(logB[0].discarded === 1, "discarded must be exactly 1, got " + logB[0].discarded);
    ok(logB[0].recheckTried === 0, "recheckTried must be 0 — the recheck stage must never start, got " +
       logB[0].recheckTried);
    shapeOkPassRecord(logB[0]);

    // ---- همان قاعده برای سولانا: توکنی که سقف وسطِ بررسی‌اش خورد نه در سند
    //      می‌نشیند نه شمرده می‌شود، و توکنِ بعدیِ سولانا اصلاً شروع نمی‌شود.
    {
      const B58S = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const mkMintS = (n) => { let x = ""; for (let i = 0; i < 44; i++) x += B58S[(n + 3000 + i * 7) % B58S.length]; return x; };
      const solPoolS = (addr) => ({
        attributes: { reserve_in_usd: "9000", base_token_price_usd: "1",
          pool_created_at: "2026-09-21T09:00:00Z", volume_usd: { h24: "10" }, fdv_usd: "100" },
        relationships: { base_token: { data: { id: "solana_" + addr } }, dex: { data: { id: "pumpswap" } } },
      });
      const mintsS = [1, 2].map(mkMintS);
      const kvS = makeKvBudget();
      const solMetaCalls = [];
      const capHitS = () => solMetaCalls.length >= 1; // درست پس از metaOfِ اولین توکنِ سولانا true می‌شود
      await runReportPass({
        kv: kvS, fetchPools: async () => [], fetchPoolsSol: async () => mintsS.map(solPoolS),
        metaOf: async (addr) => { if (!addr.startsWith("0x")) solMetaCalls.push(addr); return { meta: { symbol: "SM", name: "SM" }, why: null }; },
        verdictOf: async () => ({ v: "sell", why: null }),
        now: () => NOWB, sleep: async () => {}, capHit: capHitS,
      });
      const docS = JSON.parse(await kvS.get(reportKey(dateStrB)) || "null");
      const solStored = docS && Array.isArray(docS.rows) ? docS.rows.filter((r) => r.chain === "solana").map((r) => r.address) : [];
      ok(solStored.length === 0,
         "a Solana token whose check crossed the cap must never be stored, got " + JSON.stringify(solStored));
      ok(solMetaCalls.length === 1,
         "the next Solana token must never start once the cap was hit, got metaOf calls " + JSON.stringify(solMetaCalls));
      const logS = JSON.parse(await kvS.get(PASS_LOG_KEY));
      ok(Array.isArray(logS) && logS[0] && logS[0].discarded === 1 && logS[0].stoppedAt === "sol-token",
         "the pass log must record discarded 1 and stoppedAt sol-token, got " + JSON.stringify(logS && logS[0]));
    }

    console.log("[pass budget base stop] runReportPass ok — a capHit that flips true while the 3rd Base " +
      "token is being processed stores tokens 1-2 normally, discards token 3 from both the doc and the " +
      "pairs ring, never starts token 4/5/Solana/follow/recheck, and still writes both the doc and the " +
      "pass log (stoppedAt:\"base-token\", discarded:1)");
  }

  // ب٢) capHit تزریقی که *پیش از* شروعِ توکنِ دوم true می‌شود، نه در میانه‌ی
  // پردازشِ خودِ آن توکن — این دقیقاً همان گاردِ جداگانه‌ی «پیش از شروعِ هر
  // توکن» را می‌سنجد، مستقل از گاردِ «در میانه‌ی همین توکن» بالاتر.
  {
    const NOWB2 = Date.parse("2026-09-21T13:30:00.000Z");
    const addrsB2 = [1, 2, 3].map(mkAddrBudget);
    const poolsB2 = addrsB2.map(poolRowBudget);
    const metaCallsB2 = [];
    let capCallsB2 = 0;
    // true از سومین باری که capHit صدا زده می‌شود — با گاردِ پیش از شروع
    // (که یک‌بار قبل از هر توکن صدا می‌زند) این دقیقاً درست پیش از توکنِ
    // دوم می‌رسد، پیش از آنکه metaOf آن اصلاً صدا زده شود.
    const capHitB2 = () => { capCallsB2++; return capCallsB2 >= 3; };
    const kvB2 = makeKvBudget();
    await runReportPass({
      kv: kvB2, fetchPools: async () => poolsB2,
      metaOf: async (addr) => { metaCallsB2.push(addr); return { meta: { symbol: "T", name: "T" }, why: null }; },
      verdictOf: async () => ({ v: "sell", why: null }),
      now: () => NOWB2, sleep: async () => {}, capHit: capHitB2,
    });
    ok(JSON.stringify(metaCallsB2) === JSON.stringify([addrsB2[0]]),
       "the pre-token cap check (before starting the next Base token) must stop token 2 before its metaOf " +
       "is ever called, got " + JSON.stringify(metaCallsB2));

    console.log("[pass budget base pre-check] runReportPass ok — the cap check before starting the next " +
      "Base token stops the pass without ever calling that token's metaOf, independently of the " +
      "mid-token discard check");
  }

  // ج) runReportPass — capHit تزریقی که در میانه‌ی یک فالوآپ true می‌شود
  {
    const NOWC = Date.parse("2026-09-21T14:00:00.000Z");
    const dateStrC = utcDateOf(NOWC);
    const oldIsoC = new Date(NOWC - 90 * 60000).toISOString();
    const followAddrC = mkAddrBudget(950);
    const recheckAddrC = mkAddrBudget(951);
    const seedDocC = {
      date: dateStrC, generatedAt: oldIsoC, chains: ["base"], checked: 2,
      rows: [
        reportRow({ chain: "base", address: followAddrC, symbol: "SF", name: "SF", verdict: "sell",
          checkedAt: oldIsoC, poolCreatedAt: oldIsoC, priceUsd: 1, reserveUsd: 9000, vol24hUsd: 0, fdvUsd: 0,
          dex: "uniswap-v3-base", why: null }),
        reportRow({ chain: "base", address: recheckAddrC, symbol: "SR", name: "SR", verdict: null,
          checkedAt: oldIsoC, poolCreatedAt: oldIsoC, priceUsd: 1, reserveUsd: 9000, vol24hUsd: 0, fdvUsd: 0,
          dex: "uniswap-v3-base", why: "no-quote" }),
      ],
    };
    const kvC = makeKvBudget();
    await kvC.put(reportKey(dateStrC), JSON.stringify(seedDocC));

    let poolEmptyCalledC = 0;
    let metaCalledC = 0;
    let verdictCalledC = 0;
    const capHitC = () => poolEmptyCalledC >= 1; // پس از تنها تماسِ فالوآپ true می‌شود

    const resC = await runReportPass({
      kv: kvC, fetchPools: async () => [],
      metaOf: async () => { metaCalledC++; return { meta: null, why: "meta:429" }; },
      verdictOf: async () => { verdictCalledC++; return { v: null, why: "no-quote" }; },
      now: () => NOWC, sleep: async () => {}, capHit: capHitC,
      poolEmptyOf: async () => { poolEmptyCalledC++; return true; },
    });

    ok(resC.followed === 0, "a capHit flip mid follow-up must leave followed:0, got " + resC.followed);
    ok(poolEmptyCalledC === 1, "poolEmptyOf must have been called exactly once (the one target attempted), " +
       "got " + poolEmptyCalledC);
    ok(metaCalledC === 0 && verdictCalledC === 0,
       "the recheck stage must never start once the follow stage hit the cap (metaOf/verdictOf untouched " +
       "since the Base leg had nothing to check), got meta=" + metaCalledC + " verdict=" + verdictCalledC);

    const storedDocC = JSON.parse(await kvC.get(reportKey(dateStrC)));
    const followRowC = storedDocC.rows.find((r) => r.address === followAddrC);
    ok(followRowC && !("follow" in followRowC),
       "the follow update that crossed the cap must never be applied, got " + JSON.stringify(followRowC));

    const logC = JSON.parse(await kvC.get(PASS_LOG_KEY));
    ok(logC[0].stoppedAt === "follow", "stoppedAt must record \"follow\", got " + JSON.stringify(logC[0].stoppedAt));
    ok(logC[0].discarded === 1, "discarded must be exactly 1, got " + logC[0].discarded);
    ok(logC[0].recheckTried === 0, "recheckTried must be 0 — recheck must never start, got " + logC[0].recheckTried);
    shapeOkPassRecord(logC[0]);

    console.log("[pass budget follow stop] runReportPass ok — a capHit that flips true while the one due " +
      "follow-up target is being checked leaves its update unapplied, never starts the recheck stage, and " +
      "still writes both the doc and the pass log (stoppedAt:\"follow\", discarded:1)");
  }

  // د) سهمِ هر مرحله — ۱۲ کاندید در هر پا، capHit همیشه false
  {
    const NOWD = Date.parse("2026-09-21T15:00:00.000Z");
    const dateStrD = utcDateOf(NOWD);
    const oldIsoD = new Date(NOWD - 90 * 60000).toISOString();

    const baseCands = Array.from({ length: 12 }, (_, i) => mkAddrBudget(1 + i));
    const solCands = Array.from({ length: 12 }, (_, i) => mkSolAddrBudget(1 + i));
    const followAddrsD = Array.from({ length: 12 }, (_, i) => mkAddrBudget(100 + i));
    const recheckAddrsD = Array.from({ length: 12 }, (_, i) => mkAddrBudget(200 + i));

    const seedRowsD = [
      ...followAddrsD.map((a) => reportRow({ chain: "base", address: a, symbol: "SF", name: "SF",
        verdict: "sell", checkedAt: oldIsoD, poolCreatedAt: oldIsoD, priceUsd: 1, reserveUsd: 9000,
        vol24hUsd: 0, fdvUsd: 0, dex: "uniswap-v3-base", why: null })),
      ...recheckAddrsD.map((a) => reportRow({ chain: "base", address: a, symbol: "SR", name: "SR",
        verdict: null, checkedAt: oldIsoD, poolCreatedAt: oldIsoD, priceUsd: 1, reserveUsd: 9000,
        vol24hUsd: 0, fdvUsd: 0, dex: "uniswap-v3-base", why: "no-quote" })),
    ];
    const seedDocD = { date: dateStrD, generatedAt: oldIsoD, chains: ["base"], checked: 24, rows: seedRowsD };
    const kvD = makeKvBudget();
    await kvD.put(reportKey(dateStrD), JSON.stringify(seedDocD));

    const metaCallsD = [];
    const poolEmptyCallsD = [];

    const resD = await runReportPass({
      kv: kvD, fetchPools: async () => baseCands.map(poolRowBudget),
      metaOf: async (addr) => { metaCallsD.push(addr); return { meta: { symbol: "T", name: "T" }, why: null }; },
      verdictOf: async () => ({ v: "sell", why: null }),
      now: () => NOWD, sleep: async () => {}, maxTokens: REPORT_PASS_BASE_CAP,
      fetchPoolsSol: async () => solCands.map(solPoolRowBudget), solMaxTokens: 2,
      poolEmptyOf: async (addr) => { poolEmptyCallsD.push(addr); return true; },
    });

    const baseCallsD = metaCallsD.filter((a) => baseCands.includes(a));
    const solCallsD = metaCallsD.filter((a) => solCands.includes(a));
    const recheckCallsD = metaCallsD.filter((a) => recheckAddrsD.includes(a));

    ok(baseCallsD.length === 5,
       "with 12 Base candidates, maxTokens:REPORT_PASS_BASE_CAP and no cap hit, exactly 5 must be attempted, " +
       "got " + baseCallsD.length);
    ok(solCallsD.length === 2,
       "with 12 Solana candidates, solMaxTokens:2 and no cap hit, exactly 2 must be attempted, got " +
       solCallsD.length);
    ok(poolEmptyCallsD.length === 3,
       "with 12 follow-up candidates and no cap hit, exactly 3 (runReportPass's own internal cap) must be " +
       "attempted, got " + poolEmptyCallsD.length);
    ok(recheckCallsD.length === 2,
       "with 12 recheck candidates and no cap hit, exactly 2 (runReportPass's own internal cap) must be " +
       "attempted, got " + recheckCallsD.length);
    ok(resD.checked === 7, "checked must equal the Base+Solana tokens actually attempted (5+2), got " +
       resD.checked);

    const logD = JSON.parse(await kvD.get(PASS_LOG_KEY));
    ok(logD[0].stoppedAt === null, "with capHit absent, stoppedAt must stay null, got " +
       JSON.stringify(logD[0].stoppedAt));
    ok(logD[0].discarded === 0, "with capHit absent, discarded must stay 0, got " + logD[0].discarded);
    shapeOkPassRecord(logD[0]);

    console.log("[pass budget stage caps] runReportPass ok — with 12 eligible candidates on every leg and " +
      "capHit staying false, exactly 5 Base tokens, 2 Solana tokens, 3 follow-ups and 2 rechecks are " +
      "attempted (REPORT_PASS_BASE_CAP/solMaxTokens as injected, follow/recheck at runReportPass's own " +
      "internal 3/2), and stoppedAt/discarded stay null/0");
  }

  // ه) ogFetchMetaMany — شکلِ زنده‌ی batch (رشته‌ای)، همان pickTokenMeta تک‌آدرسه
  {
    const { ogFetchMetaMany, UPSTREAM_FREE: UF_MM } = await import("./index.js");
    const { pickTokenMeta } = await import("./og.js");

    const addrA = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const addrMissing = "0x0000000000000000000000000000000000dEaD";
    // دقیقاً شکلِ زنده — همه‌ی اعداد رشته‌اند، فقط decimals عدد است
    const itemA = {
      id: "base_" + addrA, type: "token",
      attributes: {
        address: addrA, name: "USD Coin", symbol: "USDC", decimals: 6,
        image_url: "https://example.com/x.png", coingecko_coin_id: "usd-coin",
        total_supply: "4293037995232084.0", normalized_total_supply: "4293037995.23208",
        price_usd: "0.9968434683", fdv_usd: "4279461069.5161", total_reserve_in_usd: "258481966.13245",
      },
    };

    let sentMM = [];
    const savedFetchMM = globalThis.fetch;
    globalThis.fetch = async (u) => { sentMM.push(String(u)); return json({ data: [itemA] }); };
    const mapMM = await ogFetchMetaMany([addrA, addrMissing], {});
    globalThis.fetch = savedFetchMM;

    ok(sentMM[0] === UF_MM + "/networks/base/tokens/multi/" + addrA + "," + addrMissing,
       "ogFetchMetaMany must GET networks/base/tokens/multi/<addr1>,<addr2>, got " + sentMM[0]);
    ok(mapMM instanceof Map, "ogFetchMetaMany must return a Map on success, got " + typeof mapMM);

    const gotA = mapMM.get(addrA.toLowerCase());
    const wantA = pickTokenMeta({ data: itemA });
    ok(gotA && JSON.stringify(gotA.meta) === JSON.stringify(wantA) && gotA.why === null,
       "the present address's meta must equal pickTokenMeta fed the single-item shape {data:item}, got " +
       JSON.stringify(gotA) + " vs want " + JSON.stringify(wantA));

    const gotMissing = mapMM.get(addrMissing.toLowerCase());
    ok(gotMissing && gotMissing.meta === null && gotMissing.why === "meta:404",
       "an address absent from a successful batch response must map to {meta:null, why:\"meta:404\"}, got " +
       JSON.stringify(gotMissing));

    // شکستِ کل تماس → null، هرگز پرتاب
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    ok(await ogFetchMetaMany([addrA], {}) === null, "a 500 upstream must give null, never throw");
    globalThis.fetch = async () => new Response("not json", { status: 200,
      headers: { "content-type": "application/json" } });
    ok(await ogFetchMetaMany([addrA], {}) === null, "a broken body must give null, never throw");
    globalThis.fetch = async () => { throw new Error("network is down"); };
    ok(await ogFetchMetaMany([addrA], {}) === null, "a network failure must give null, never throw");
    globalThis.fetch = savedFetchMM;

    console.log("[pass budget meta many] ogFetchMetaMany ok — a single batch GET to " +
      "networks/base/tokens/multi/<addr1>,<addr2>, meta for a present address equal to pickTokenMeta fed " +
      "the single-item shape {data:item}, an address absent from a successful response mapped to " +
      "meta:404, and a failed/broken/unreachable upstream returning null, never throwing");
  }

  // و) metaMany در runReportPass — batch موفق/ناموفق/غایب
  {
    const NOWE = Date.parse("2026-09-21T16:00:00.000Z");
    const addrsE = [1, 2, 3].map(mkAddrBudget);
    const poolsE = addrsE.map(poolRowBudget);

    // batch موفق — metaOf هرگز صدا زده نمی‌شود
    let metaOfCallsOk = 0;
    let metaManyCallsOk = 0;
    const kvOk = makeKvBudget();
    await runReportPass({
      kv: kvOk, fetchPools: async () => poolsE,
      metaOf: async () => { metaOfCallsOk++; return { meta: { symbol: "X", name: "X" }, why: null }; },
      verdictOf: async () => ({ v: "sell", why: null }),
      now: () => NOWE, sleep: async () => {},
      metaMany: async (addrs) => {
        metaManyCallsOk++;
        const map = new Map();
        for (const a of addrs) map.set(a, { meta: { symbol: "B", name: "B" }, why: null });
        return map;
      },
    });
    ok(metaOfCallsOk === 0, "a successful metaMany batch must mean metaOf is never called, got " + metaOfCallsOk);
    ok(metaManyCallsOk === 1, "metaMany must be called exactly once per pass, got " + metaManyCallsOk);
    const docOk = JSON.parse(await kvOk.get(reportKey(utcDateOf(NOWE))));
    ok(docOk.rows.every((r) => r.symbol === "B"),
       "every row must carry the batch's own symbol, not metaOf's, got " +
       JSON.stringify(docOk.rows.map((r) => r.symbol)));
    const logOk = JSON.parse(await kvOk.get(PASS_LOG_KEY));
    ok(logOk[0].metaBatch === "ok", "a successful metaMany must record metaBatch:\"ok\", got " +
       JSON.stringify(logOk[0].metaBatch));
    shapeOkPassRecord(logOk[0]);

    // batch ناموفق (null) — metaOf دقیقاً یک بار به‌ازای هر توکن، نتیجه‌ای
    // بایت‌به‌بایت مثلِ نبودِ metaMany
    let metaOfCallsFail = 0;
    let metaManyCallsFail = 0;
    const kvFail = makeKvBudget();
    await runReportPass({
      kv: kvFail, fetchPools: async () => poolsE,
      metaOf: async () => { metaOfCallsFail++; return { meta: { symbol: "X", name: "X" }, why: null }; },
      verdictOf: async () => ({ v: "sell", why: null }),
      now: () => NOWE, sleep: async () => {},
      metaMany: async () => { metaManyCallsFail++; return null; },
    });
    ok(metaOfCallsFail === 3, "a null metaMany batch must fall back to metaOf for every token, got " +
       metaOfCallsFail);
    ok(metaManyCallsFail === 1, "metaMany must still be called exactly once even when it fails, got " +
       metaManyCallsFail);
    const docFail = JSON.parse(await kvFail.get(reportKey(utcDateOf(NOWE))));
    const logFail = JSON.parse(await kvFail.get(PASS_LOG_KEY));
    ok(logFail[0].metaBatch === "failed", "a failing metaMany must record metaBatch:\"failed\", got " +
       JSON.stringify(logFail[0].metaBatch));
    shapeOkPassRecord(logFail[0]);

    let metaOfCallsPlain = 0;
    const kvPlain = makeKvBudget();
    await runReportPass({
      kv: kvPlain, fetchPools: async () => poolsE,
      metaOf: async () => { metaOfCallsPlain++; return { meta: { symbol: "X", name: "X" }, why: null }; },
      verdictOf: async () => ({ v: "sell", why: null }),
      now: () => NOWE, sleep: async () => {},
    });
    ok(metaOfCallsPlain === metaOfCallsFail,
       "a failed batch must call metaOf exactly as many times as omitting metaMany entirely, got " +
       metaOfCallsPlain + " vs " + metaOfCallsFail);
    const docPlain = JSON.parse(await kvPlain.get(reportKey(utcDateOf(NOWE))));
    ok(JSON.stringify(docPlain.rows) === JSON.stringify(docFail.rows),
       "a failed batch's stored rows must be byte-for-byte identical to omitting metaMany entirely, got " +
       JSON.stringify(docPlain.rows) + " vs " + JSON.stringify(docFail.rows));
    const logPlain = JSON.parse(await kvPlain.get(PASS_LOG_KEY));
    ok(logPlain[0].metaBatch === "absent", "with no metaMany injected, metaBatch must be \"absent\", got " +
       JSON.stringify(logPlain[0].metaBatch));
    shapeOkPassRecord(logPlain[0]);

    console.log("[pass budget meta many wiring] runReportPass+metaMany ok — a successful batch means metaOf " +
      "is never called and every row carries the batch's own meta; a failing (null) batch falls back to " +
      "metaOf for every token, byte-for-byte identical to omitting metaMany entirely; metaMany is called " +
      "exactly once per pass regardless of outcome; and metaBatch records \"ok\"/\"failed\"/\"absent\" " +
      "accordingly, with none of it ever carrying an address or a URL");
  }
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
    + "/t/<mint> now 200, same as Base; the OG card's title/description build from the Solana "
    + "token's own metadata; ogFetchVerdict routes a Solana address to fetchVerdictSol, never "
    + "to the Base-only eth_call path\n" +
    "[solana rpc] RPC endpoint failover (first-call-only, capped, never nosell), per-method \"why\" "
    + "reasons now carrying a numeric status (rpc:<method>:<status>, jup:quote:<status>, "
    + "jup:swap-instructions:<status>, verified via the frozen-prefix+integer-suffix rule), "
    + "env.SOL_RPC tried first ahead of the public list (via solRpcsFor, same shape as CG_KEY) with "
    + "its path/query never surfacing anywhere, and GET /vd/rpc's endpoint×method matrix all covered "
    + "against injected fakes — no claim made about which real endpoint answers which method\n" +
    "[jup key] env.JUP_KEY (via jupKeyFor, same shape as CG_KEY/SOL_RPC) rides as the x-api-key "
    + "header on every Jupiter call and never in a URL; absent it, behaviour is byte-for-byte "
    + "today's; the key never surfaces in a \"sell\", \"nosell\", or null/\"jup:quote:401\" response "
    + "body, checked both against an injected fetchImpl and end to end through worker.fetch\n" +
    "[robots] /robots.txt and /sitemap.xml are served by the Worker, not from _site (the "
    + "panel build line copies only html/js/_headers, so a .txt or .xml beside index.html "
    + "would never ship): the whole site is allowed, no crawler is singled out, and the "
    + "sitemap is pointed at\n" +
    "[sitemap tokens] the sitemap's long tail: up to 3 pages of networks/base/pools feed "
    + "/t/<address> entries after the three always-first static pages (/, /app, /pairs), filtered, "
    + "deduped, capped "
    + "at 50 and ordered by upstream volume; a failed or unusable upstream (500, a thrown fetch, "
    + "or an unparseable body) degrades to exactly the three static URLs with a short cache-control "
    + "and is never cached at the edge, while a successful build is cached 24h"

  : "[gt proxy] " + fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
