/* تست واقعیِ تزریق کارت پیش‌نمایش — روی خودِ workerd، نه روی ماک.
   ---------------------------------------------------------------------
   چرا جدا از test.mjs: `HTMLRewriter` یک API محیط Workers است و در node
   وجود ندارد. test.mjs بدون هیچ وابستگی با node اجرا می‌شود و تگ‌ها را از
   توابع خالص می‌سنجد؛ ولی آن بخشِ *تزریق* — اینکه تگ‌ها واقعاً داخل HTML
   بنشینند و تگ‌های ثابتِ صفحه‌ی اصلی برداشته شوند — فقط روی موتور واقعی
   سنجیدنی است. این فایل همان را می‌سنجد و به miniflare نیاز دارد:

     npm i -D miniflare@3
     node worker/og_live_test.mjs

   اگر miniflare نصب نباشد، با پیام واضح رد می‌شود و کد خروجی ۰ می‌دهد —
   یعنی «آزموده نشد»، نه «سبز شد». این دو یکی نیستند. */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { OG_IMAGE_V } from "./og.js";
import { OG_BUDGET_MS } from "./index.js";

let Miniflare;
try {
  ({ Miniflare } = await import("miniflare"));
} catch (e) {
  console.log("[og live] SKIPPED — miniflare is not installed (npm i -D miniflare@3)");
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/* صفحه‌ای که ASSETS برمی‌گرداند: همان شکلی که index.html دارد — یک title و
   تگ‌های ثابتِ data-og که باید برداشته شوند. */
const PAGE =
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  "<title>Zaexa</title>" +
  '<meta data-og property="og:title" content="Zaexa — DEX aggregator on Base">' +
  '<meta data-og property="og:description" content="the home page blurb">' +
  '<meta data-og name="twitter:card" content="summary_large_image">' +
  "</head><body>app</body></html>";

let upstreamHits = [];
let upstreamReply = null;

function mf(page = PAGE) {
  return new Miniflare({
    modules: true,
    /* یک ورودیِ نازک که فقط `default` را بیرون می‌دهد.
       index.js چند چیز دیگر هم export می‌کند (PATH_OK، ttlFor، …) که فقط
       برای تست‌اند؛ workerd یک export غیرتابع روی ماژول ورودی را رد می‌کند.
       wrangler موقع باندل‌کردن همان‌ها را کنار می‌گذارد، پس این تفاوتِ
       محیط تست است نه تفاوت رفتار. */
    script: 'import w from "./index.js"; export default w;',
    scriptPath: path.join(here, "__og_live_entry.js"),
    modulesRoot: here,
    /* wrangler خودش با esbuild باندل می‌کند و .js را ESM می‌بیند؛ miniflare
       بدون این قاعده آن را CommonJS فرض می‌کند. */
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-08-10",
    // request-context.js به AsyncLocalStorage نیاز دارد (همان پرچمِ runtime-security.test.mjs)
    compatibilityFlags: ["nodejs_als"],
    bindings: { CG_KEY: "CG-secret-do-not-leak-me" },
    serviceBindings: {
      ASSETS: () =>
        new Response(page, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
    // هر fetch بیرونیِ Worker از اینجا رد می‌شود — بالادست واقعی زده نمی‌شود.
    outboundService: (req) => {
      upstreamHits.push(req.url);
      /* درخواست‌های verdict به یکی از RPCهای Base می‌روند. این کانتینر
         واقعاً به هیچ‌کدام دسترسی ندارد؛ به‌جایِ ساختنِ یک پاسخِ موفقِ
         ساختگی (که «شبکه را جعل‌کردن» می‌شد)، همین نبودِ دسترسی را با یک
         ردِ صریح نشان می‌دهیم — دقیقاً همان چیزی که یک اندپوینتِ واقعاً
         غیرقابل‌دسترس هم برمی‌گرداند. */
      if (/publicnode\.com|meowrpc\.com|drpc\.org|tenderly\.co|mainnet\.base\.org|onfinality\.io|api\.jup\.ag|mainnet-beta\.solana\.com/.test(req.url))
        return Promise.reject(new Error("no route to Base/Solana RPC or Jupiter in this sandbox"));
      if (upstreamReply === "slow")
        return new Promise((r) => setTimeout(() => r(new Response("{}")), 5000));
      if (upstreamReply === "error") return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(upstreamReply), {
        headers: { "content-type": "application/json" },
      });
    },
  });
}

let fails = 0;
function ok(cond, what) {
  if (!cond) { fails++; console.log("FAIL " + what); }
}

const GOOD = {
  data: {
    attributes: {
      name: "USD Coin",
      symbol: "USDC",
      total_reserve_in_usd: "12400000",
      volume_usd: { h24: "3120000" },
    },
  },
};

/* ---- ۱. تگ‌های توکن تزریق می‌شوند و تگ‌های ثابت می‌روند ---- */
{
  upstreamHits = []; upstreamReply = GOOD;
  const m = mf();
  const res = await m.dispatchFetch("https://zaexa.com/t/" + ADDR);
  const html = await res.text();
  await m.dispose();

  ok(res.status === 200, "the token page did not return 200 (" + res.status + ")");
  ok(html.includes('content="USDC · USD Coin — Zaexa"'),
     "og:title does not carry the token:\n" + html.slice(0, 900));
  ok(html.includes("Liquidity $12.40M"), "the description lost the liquidity figure");
  ok(html.includes("Vol 24h $3.12M"), "the description lost the 24h volume");
  ok(/property="og:image" content="https:\/\/zaexa\.com\/og\/t\/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\.png\?v=1&amp;h=[0-9a-f]{8}"/.test(html),
     "og:image is not the absolute, versioned per-token card");
  ok(html.includes('property="og:image:alt" content="USDC on Base — Zaexa"'), "og:image:alt is not the token's");
  ok(html.includes('content="https://zaexa.com/t/' + ADDR + '"'),
     "og:url is not the canonical token url");
  ok(!html.includes("DEX aggregator on Base"),
     "the home page's static og tags were left in place — a bot would see two og:title " +
     "and which one it picks is not ours to decide");
  ok(!html.includes("the home page blurb"), "the static og:description survived");
  ok((html.match(/property="og:title"/g) || []).length === 1,
     "there is more than one og:title in the page");
  ok(html.includes("<title>USDC · USD Coin — Zaexa</title>"),
     "the browser tab title was not replaced");
  ok(html.includes("<body>app</body>"), "the body was damaged by the rewrite");
  ok(upstreamHits.length === 1 &&
     upstreamHits[0] === "https://api.coingecko.com/api/v3/onchain/networks/base/tokens/" + ADDR,
     "wrong upstream call: " + JSON.stringify(upstreamHits));
  console.log("[og live] token tags injected, static tags removed, title replaced");
}

/* ---- ۲. نام دشمن‌خو از HTML بیرون نمی‌زند ---- */
{
  upstreamHits = [];
  upstreamReply = {
    data: { attributes: {
      name: '"><script>alert(1)</script>',
      symbol: "EVIL",
      total_reserve_in_usd: "1000",
    } },
  };
  const m = mf();
  const html = await (await m.dispatchFetch("https://zaexa.com/t/" + ADDR)).text();
  await m.dispose();
  ok(!html.includes("<script>alert(1)</script>"),
     "a token name broke out of the meta tag — this is XSS on our own domain");
  ok(html.includes("&lt;script&gt;"), "the name was dropped instead of escaped");
  console.log("[og live] a hostile token name stays inside the attribute");
}

/* ---- ۳. بالادست خراب یا کند → کارت عمومی، نه صفحه‌ی شکسته ---- */
for (const [mode, label] of [["error", "a 500 from upstream"], ["slow", "an upstream that never answers"]]) {
  upstreamHits = []; upstreamReply = mode;
  const m = mf();
  const t0 = Date.now();
  const res = await m.dispatchFetch("https://zaexa.com/t/" + ADDR);
  const html = await res.text();
  const ms = Date.now() - t0;
  await m.dispose();
  ok(res.status === 200, label + " broke the page (" + res.status + ")");
  ok(html.includes('content="Token on Base — Zaexa"'),
     label + " did not fall back to a generic card:\n" + html.slice(0, 700));
  ok(html.includes("<body>app</body>"), label + " damaged the page body");
  if (mode === "slow")
    ok(ms < 4000, "the page waited " + ms + "ms for a dead upstream — the timeout did not bite");
  console.log("[og live] " + label + " -> generic card, page still serves");
}

/* ---- ۴. تصویر کارت واقعاً از /og.png می‌آید ---- */
{
  const m = mf();
  const res = await m.dispatchFetch("https://zaexa.com/og.png?v=" + OG_IMAGE_V);
  const buf = new Uint8Array(await res.arrayBuffer());
  const etag = res.headers.get("etag");
  const res304 = await m.dispatchFetch("https://zaexa.com/og.png", {
    headers: { "if-none-match": etag },
  });
  await m.dispose();
  ok(res.status === 200, "/og.png did not answer 200 (" + res.status + ")");
  ok(res.headers.get("content-type") === "image/png", "/og.png is not served as a png");
  ok(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
     "/og.png is not actually a png");
  ok(buf.length > 100000, "/og.png looks truncated (" + buf.length + " bytes)");
  ok(res304.status === 304, "/og.png ignores if-none-match (" + res304.status + ")");
  console.log("[og live] /og.png serves the real image and answers 304 on revalidation");
}

/* ---- ۴ب. کارتِ مخصوصِ توکن روی workerd واقعی ---- */
{
  // الف) بالادست در دسترس نیست → کارتِ عمومی با ۲۰۰، و خودِ صفحه هنوز رندر می‌شود
  upstreamHits = []; upstreamReply = "error";
  let m = mf();
  const gen = new Uint8Array(await (await m.dispatchFetch("https://zaexa.com/og.png")).arrayBuffer());
  let res = await m.dispatchFetch("https://zaexa.com/og/t/" + ADDR + ".png?v=1&h=00000000");
  let buf = new Uint8Array(await res.arrayBuffer());
  const page = await m.dispatchFetch("https://zaexa.com/t/" + ADDR);
  const html = await page.text();
  await m.dispose();
  ok(res.status === 200 && res.headers.get("content-type") === "image/png",
     "[og token live] unreachable upstream: /og/t/<addr>.png did not answer 200 image/png (" + res.status + ")");
  ok(buf.length === gen.length && buf.every((b, i) => b === gen[i]),
     "[og token live] unreachable upstream: the response is not the generic card");
  ok(res.headers.get("cache-control") === "public, max-age=60", "[og token live] fallback cache-control: " + res.headers.get("cache-control"));
  ok(page.status === 200 && html.includes("<body>app</body>") && html.includes('content="Token on Base — Zaexa"'),
     "[og token live] the /t/ page must still render with a generic card when upstream is down");
  console.log("[og token live] upstream unreachable: /og/t/<addr>.png -> 200 image/png (generic card), /t/<addr> still renders");

  // ب) بالادست سالم → کارتِ واقعی با DecompressionStream و بقیه‌ی APIهای workerd
  upstreamHits = []; upstreamReply = GOOD;
  m = mf();
  res = await m.dispatchFetch("https://zaexa.com/og/t/" + ADDR + ".png?v=1&h=00000000");
  buf = new Uint8Array(await res.arrayBuffer());
  await m.dispose();
  ok(res.status === 200 && res.headers.get("content-type") === "image/png" && res.headers.get("x-zaexa-logo") === "none",
     "[og token live] real card: status/type/logo header wrong (" + res.status + ", " + res.headers.get("x-zaexa-logo") + ")");
  ok(buf[0] === 0x89 && buf[1] === 0x50 && buf.length > 800000 && buf.length !== gen.length,
     "[og token live] real card does not look like a rendered token card (" + buf.length + " bytes)");
  console.log("[og token live] healthy upstream: workerd renders the token card (" + buf.length + " bytes, logo none)");
}

/* ---- ۵. صفحه‌ی اصلی دست‌نخورده می‌ماند ---- */
{
  upstreamHits = []; upstreamReply = GOOD;
  const m = mf();
  const html = await (await m.dispatchFetch("https://zaexa.com/")).text();
  await m.dispose();
  ok(html.includes("DEX aggregator on Base"),
     "the home page lost its own og tags — the worker rewrote a page it should not touch");
  ok(upstreamHits.length === 0,
     "the home page triggered a token lookup: " + JSON.stringify(upstreamHits));
  console.log("[og live] the home page keeps its own tags and costs no upstream call");
}

/* ---- ۶. verdict — RPC واقعاً غیرقابل‌دسترس → تنزلِ باوقار ----
   این کانتینر به هیچ RPC ای از Base دسترسی ندارد؛ پس صادقانه‌ترین probeِ
   زنده همین است: با RPC غیرقابل‌دسترس، توضیحِ کارت باید بایت‌به‌بایت همان
   چیزی بماند که امروز سرو می‌شود (یعنی verdict چیزی اضافه نکند)، و صفحه
   باید همچنان ۲۰۰ بدهد و کاملاً داخلِ OG_BUDGET_MS تمام شود. */
{
  upstreamHits = [];
  upstreamReply = {
    data: { attributes: {
      name: "USD Coin", symbol: "USDC",
      total_reserve_in_usd: "12400000",
      volume_usd: { h24: "3120000" },
      decimals: 6, price_usd: 1,
    } },
  };
  const m = mf();
  const t0 = Date.now();
  const res = await m.dispatchFetch("https://zaexa.com/t/" + ADDR);
  const html = await res.text();
  const ms = Date.now() - t0;
  await m.dispose();

  const wantDesc = "Base · Liquidity $12.40M · Vol 24h $3.12M. Check whether you can sell it " +
    "back before you buy — exit simulation and risk flags, no wallet needed.";
  ok(res.status === 200,
     "the token page with an unreachable RPC did not return 200 (" + res.status + ")");
  ok(html.includes('content="' + wantDesc + '"'),
     "with the RPC unreachable, og:description is not byte-for-byte today's description:\n" +
     html.slice(0, 900));
  ok(!html.includes("sell route"),
     "an unknown verdict leaked a verdict sentence into the description anyway");
  ok(ms < OG_BUDGET_MS,
     "the page waited " + ms + "ms with an unreachable RPC — that must stay well inside the " +
     OG_BUDGET_MS + "ms card budget");
  ok(upstreamHits.some((u) => /publicnode\.com|meowrpc\.com|drpc\.org|tenderly\.co|base\.org/.test(u)),
     "the verdict path never even attempted an RPC call — is it actually wired up? hits: " +
     JSON.stringify(upstreamHits));
  console.log("[og live] verdict: RPC genuinely unreachable -> today's description byte-for-byte, "
    + "page 200 in " + ms + "ms (budget " + OG_BUDGET_MS + "ms)");
}

/* ---- ۷. /vd/<address> — با RPC واقعاً غیرقابل‌دسترس ----
   همان دلیلِ بخشِ ۶: این کانتینر واقعاً به هیچ Base RPCای دسترسی ندارد.
   پروبِ تشخیصی باید همچنان ۲۰۰ بدهد با v:null — نه خطا، نه آویزان‌شدن —
   و کاملاً داخلِ بودجه بماند. */
{
  upstreamHits = [];
  upstreamReply = {
    data: { attributes: {
      name: "USD Coin", symbol: "USDC",
      total_reserve_in_usd: "12400000",
      decimals: 6, price_usd: 1,
    } },
  };
  const m = mf();
  const t0 = Date.now();
  const res = await m.dispatchFetch("https://zaexa.com/vd/" + ADDR);
  const ms = Date.now() - t0;
  const body = await res.json();
  await m.dispose();

  ok(res.status === 200, "/vd with an unreachable RPC did not return 200 (" + res.status + ")");
  ok(res.headers.get("content-type").includes("application/json"), "/vd must answer JSON");
  ok(res.headers.get("cache-control") === "no-store", "/vd must never be cached");
  ok(body.v === null, "/vd with an unreachable RPC should say v:null, not an error: " +
     JSON.stringify(body));
  ok(typeof body.ms === "number" && body.ms >= 0, "/vd's own ms field looks wrong: " +
     JSON.stringify(body));
  ok(ms < OG_BUDGET_MS,
     "/vd waited " + ms + "ms with an unreachable RPC — must stay well inside the " +
     OG_BUDGET_MS + "ms budget");
  console.log("[og live] /vd: RPC genuinely unreachable -> 200 with v:null, " + ms + "ms " +
    "(budget " + OG_BUDGET_MS + "ms)");
}

/* ---- ۸. متنِ واقعیِ توکن داخلِ UI مرئی (worker/tokseo.js) ----
   الف) خطِ لولهٔ کاملِ Worker روی index.html واقعی: h1، نام، tk-facts، بدونِ تماسِ تازه؛
   ب) همان injectOg با verdictِ کنترل‌شده (sell / nosellِ بی‌علت / empty-pool / سولانا). */
{
  const REAL = fs.readFileSync(path.join(here, "..", "web", "index.html"), "utf8");
  const tag = (html, id) => (new RegExp("<[a-z0-9]+ [^>]*id=\"" + id + "\"[^>]*>").exec(html) || [""])[0];
  const inner = (html, re) => (re.exec(html) || [])[1];
  const h1Of = (html) => inner(html, /<h1 class="tkSym" id="tk-sym">([^<]*)<\/h1>/);
  const aboutOf = (html) => inner(html, /<p class="tkAbout">([^<]*)<\/p>/);
  const factsOf = (html) => (/<div class="tkChips">.*?<\/p>/.exec(html) || [""])[0];
  const robots = (html) => /<meta name="robots" content="noindex,follow">/.test(html);
  const attrs = (reserve, sym, name) => ({ data: { attributes: { name, symbol: sym, total_reserve_in_usd: reserve, volume_usd: { h24: "3120000" } } } });

  // الف-۱) سالم، بدونِ قیمت (verdict اصلاً تلاش نمی‌شود): دقیقاً یک تماسِ GT، h1 = نماد، facts دیده می‌شود
  upstreamHits = []; upstreamReply = attrs("12400000", "USDC", "USD Coin");
  let m = mf(REAL);
  let html = await (await m.dispatchFetch("https://zaexa.com/t/" + ADDR)).text();
  await m.dispose();
  ok(h1Of(html) === "USDC", "[token seo live] h1 must be the symbol, got " + h1Of(html));
  ok((html.match(/<h1[ >]/g) || []).length === 1, "[token seo live] #tk-sym must be the only h1 in the page");
  ok(!/hidden/.test(tag(html, "tk-facts")) && tag(html, "tk-facts").includes('data-addr="' + ADDR + '"'),
     "[token seo live] tk-facts must be visible and stamped with the address: " + tag(html, "tk-facts"));
  ok(/<span id="tk-name">USD Coin<\/span>/.test(html), "[token seo live] #tk-name must carry the token name");
  ok(/Zaexa&#39;s last exit check could not confirm a sell route/.test(aboutOf(html) || ""), "[token seo live] about: " + aboutOf(html));
  ok(html.includes("Pool $12.40M") && html.includes("Vol 24h $3.12M"), "[token seo live] pool and volume chips");
  ok(!robots(html), "[token seo live] a healthy token must not be noindex");
  ok(upstreamHits.length === 1 && /onchain\/networks\/base\/tokens\//.test(upstreamHits[0]),
     "[token seo live] the page must cost exactly the one meta call it cost before: " + JSON.stringify(upstreamHits));

  // الف-۲) با قیمت: verdict تلاش می‌شود (RPC در دسترس نیست) → «Not confirmed»، هنوز بدونِ noindex
  upstreamHits = []; upstreamReply = { data: { attributes: { ...attrs("12400000", "USDC", "USD Coin").data.attributes, decimals: 6, price_usd: 1 } } };
  m = mf(REAL);
  html = await (await m.dispatchFetch("https://zaexa.com/t/" + ADDR)).text();
  await m.dispose();
  ok(/Exit check: Not confirmed/.test(html) && !robots(html), "[token seo live] unreachable RPC: Not confirmed, not noindex");
  ok(upstreamHits.every((u) => /coingecko|publicnode|meowrpc|drpc|tenderly|base\.org|onfinality|dexscreener/.test(u)),
     "[token seo live] unexpected upstream host: " + JSON.stringify(upstreamHits));

  // الف-۳) ذخیره زیرِ حداقل → noindex؛ ذخیره‌ی نامعلوم → نه
  upstreamHits = []; upstreamReply = attrs("1200", "LOW", "Low Coin");
  m = mf(REAL);
  html = await (await m.dispatchFetch("https://zaexa.com/t/" + ADDR)).text();
  await m.dispose();
  ok(robots(html), "[token seo live] reserve below the report minimum must be noindex");
  upstreamHits = []; upstreamReply = attrs(null, "UNK", "Unknown Reserve");
  m = mf(REAL);
  html = await (await m.dispatchFetch("https://zaexa.com/t/" + ADDR)).text();
  await m.dispose();
  ok(!robots(html) && h1Of(html) === "UNK", "[token seo live] an unknown reserve must not be noindex");

  // الف-۴) بالادست خراب → صفحه بدونِ تغییر: h1 «—»، facts مخفی، بدونِ noindex
  upstreamHits = []; upstreamReply = "error";
  m = mf(REAL);
  html = await (await m.dispatchFetch("https://zaexa.com/t/" + ADDR)).text();
  await m.dispose();
  ok(h1Of(html) === "\u2014" && /hidden/.test(tag(html, "tk-facts")) && !/tkAbout/.test(html.replace(/\.tkAbout\{[^}]*\}/, "")) && !robots(html),
     "[token seo live] upstream failure must leave the page as is, never noindex: " + tag(html, "tk-facts"));

  // ب) injectOg با verdictِ کنترل‌شده
  const HARNESS =
    'import { injectOg } from "./index.js";' +
    "export default { async fetch(req, env) {" +
    "  const u = new URL(req.url); const c = JSON.parse(u.searchParams.get('c'));" +
    "  const page = await env.ASSETS.fetch(req);" +
    "  return injectOg(page, u, c.addr, Promise.resolve(c.meta), Promise.resolve(c.vd), c.chain);" +
    "} };";
  const hm = new Miniflare({
    modules: true, script: HARNESS, scriptPath: path.join(here, "__tokseo_harness.js"), modulesRoot: here,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-08-10", compatibilityFlags: ["nodejs_als"],
    serviceBindings: { ASSETS: () => new Response(REAL, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) },
  });
  const run = async (meta, vd, chain, addr) => {
    const c = encodeURIComponent(JSON.stringify({ meta, vd, chain, addr: addr || ADDR }));
    return await (await hm.dispatchFetch("https://zaexa.com/t/" + (addr || ADDR) + "?c=" + c)).text();
  };
  const M = (sym, name, liqUsd, liq) => ({ name, symbol: sym, liquidity: liq, vol24: "$3.1K", liquidityUsd: liqUsd, decimals: 18, priceUsd: 1, imageUrl: null });
  const a1 = await run(M("AAA", "Alpha Coin", 22500, "$22.5K"), { v: "sell" }, "Base");
  const a2 = await run(M("BBB", "Beta Coin", 90000, "$90.0K"), { v: "sell" }, "Base");
  ok(h1Of(a1) === "AAA" && h1Of(a2) === "BBB" && aboutOf(a1) && aboutOf(a1) !== aboutOf(a2),
     "[token seo live] two tokens must differ in h1 and .tkAbout");
  ok(/class="fbChip p">Exit check: Sell route quoted</.test(a1) && /A quote is not a guarantee\./.test(a1), "[token seo live] sell chip and sentence");
  ok(/<title>AAA \u00b7 Alpha Coin \u2014 Zaexa<\/title>/.test(a1), "[token seo live] title is already per-token (ogTags/ogTitle), left alone");

  const EVIL = '<script>alert(1)</script>"&\'';
  const ev = await run(M(EVIL, EVIL, 22500, "$22.5K"), { v: "sell" }, "Base");
  ok(!ev.includes("<script>alert(1)") && !ev.includes('</script>"&'), "[token seo live] a hostile symbol/name broke out somewhere");
  ok(h1Of(ev) && h1Of(ev).includes("&lt;script&gt;alert(1)&lt;/script&gt;\"&amp;") && /<title>[^<]*&lt;script&gt;/.test(ev) &&
     /<span id="tk-name">[^<]*&lt;script&gt;/.test(ev) && /Exit check:/.test(ev) && /&lt;script&gt;[^<]*is a token on Base/.test(aboutOf(ev) || ""),
     "[token seo live] the hostile symbol must be escaped in h1, name, title and paragraph: " + h1Of(ev));

  const nc = await run(M("NCS", "Nocause", 22500, "$22.5K"), { v: "nosell" }, "Base");
  ok(/Exit check: Not confirmed/.test(factsOf(nc)) && !/No sell route|found no sell/.test(factsOf(nc)) && !robots(nc), "[token seo live] a cause-less nosell is Not confirmed");
  const SOLM = "So11111111111111111111111111111111111111112";
  const sl = await run(M("SOLX", "Solx", 22500, "$22.5K"), { v: "nosell", cause: "empty-pool" }, "Solana", SOLM);
  ok(/Exit check: Not confirmed/.test(factsOf(sl)) && !/No sell route|found no sell/.test(factsOf(sl)) && !robots(sl) && /is a token on Solana/.test(sl),
     "[token seo live] a Solana nosell must never be shown");
  const ep = await run(M("EMP", "Empty", 22500, "$22.5K"), { v: "nosell", cause: "empty-pool" }, "Base");
  ok(/pool is empty/.test(factsOf(ep)) && robots(ep), "[token seo live] empty-pool: pool is empty + noindex");
  const nm = await run(null, null, "Base");
  ok(h1Of(nm) === "\u2014" && /hidden/.test(tag(nm, "tk-facts")) && !robots(nm), "[token seo live] no meta: page unchanged, no noindex");
  await hm.dispose();
  console.log("[token seo live] real rewriter on the real index.html: h1 = symbol, only h1, facts visible and escaped, nosell guard, noindex only on positive evidence, no extra upstream call");
}


/* ---- ۹. Exit value: تگ‌های /exit/<آدرس> و /og/exit/<آدرس>.png روی workerd (HTMLRewriter و Cache API واقعی) ----
   جهانِ ساختگی فقط یک کیفِ «فقط ETH» است (هلدینگ + یک دسته‌ی قیمت؛ کوت لازم نیست)، تا بدونِ شبکه‌ی واقعی
   همه‌ی مسیرِ سرور — محاسبه، کش، رندرِ PNG، تزریقِ تگ — روی موتورِ واقعی اجرا شود. */
{
  const REAL = fs.readFileSync(path.join(here, "..", "web", "index.html"), "utf8");
  const WALLET = "0x" + "ab".repeat(20);
  const RPC = "https://exit-live-rpc.example/SECRETKEY-EXITLIVE";
  const WETH = "0x4200000000000000000000000000000000000006";
  let hits = [];
  const m = new Miniflare({
    modules: true,
    script: 'import w from "./index.js"; export default w;',
    scriptPath: path.join(here, "__og_live_entry.js"),
    modulesRoot: here,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-08-10",
    compatibilityFlags: ["nodejs_als"],
    bindings: { BASE_RPC: RPC },
    serviceBindings: { ASSETS: () => new Response(REAL, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) },
    outboundService: async (req) => {
      hits.push(req.url);
      const j = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
      if (req.url === RPC) {
        const body = await req.json();
        return j(body.map((x) => x.method === "alchemy_getTokenBalances"
          ? { jsonrpc: "2.0", id: x.id, result: { address: x.params[0], tokenBalances: [] } }
          : { jsonrpc: "2.0", id: x.id, result: "0xde0b6b3a7640000" }));   // ۱ ETH
      }
      if (/\/tokens\/multi\//.test(req.url)) {
        return j({ data: [{ id: "base_" + WETH, type: "token", attributes: { address: WETH, symbol: "WETH", decimals: 18, price_usd: "3000" },
          relationships: { top_pools: { data: [{ id: "base_pool1", type: "pool" }] } } }],
          included: [{ id: "base_pool1", type: "pool", attributes: { reserve_in_usd: "9000000" } }] });
      }
      return j({ error: "unreachable in this sandbox" }, 500);
    },
  });
  const BOT = { headers: { "user-agent": "TelegramBot (like TwitterBot)" } };
  const tag = (html, k) => { const mm = new RegExp('<meta (?:property|name)="' + k + '" content="([^"]*)">').exec(html); return mm ? mm[1].replace(/&amp;/g, "&") : null; };
  const res = await m.dispatchFetch("https://zaexa.com/exit/" + WALLET, BOT);
  const html = await res.text();
  const bucket = Math.floor(Date.now() / 600000);
  ok(res.status === 200 && (res.headers.get("x-robots-tag") || "").includes("noindex"), "[exit og live] /exit/<addr> is 200 and noindex");
  ok(tag(html, "og:title") === "Exit value of 0xabab…abab: $3,000 if sold now", "[exit og live] og:title from the wallet's real numbers, got " + tag(html, "og:title"));
  const want = "https://zaexa.com/og/exit/" + WALLET + ".png?v=2&r=" + bucket;
  ok(tag(html, "og:image") === want && tag(html, "twitter:image") === want && tag(html, "twitter:card") === "summary_large_image", "[exit og live] og:image / twitter:image / card, got " + tag(html, "og:image"));
  ok((html.match(/property="og:title"/g) || []).length === 1 && !html.includes('content="Zaexa — DEX aggregator on Base"'), "[exit og live] the real page's static data-og tags are gone, one og:title");
  ok(/<head>[\s\S]*?<title>Exit value of 0xabab…abab/.test(html) && /<svg class="wordmark"[^>]*><title>Zaexa<\/title>/.test(html), "[exit og live] only the head title changed (the wordmark's SVG title is intact)");
  ok(hits.filter((u) => u === RPC).length === 1 && hits.length === 2, "[exit og live] one summary computation = 2 subrequests for an ETH-only wallet (holdings + price), got " + hits.length);
  ok(!html.includes("SECRETKEY-EXITLIVE"), "[exit og live] the BASE_RPC secret is not in the page");
  const before = hits.length;
  const img = await m.dispatchFetch(want);
  const bytes = new Uint8Array(await img.arrayBuffer());
  ok(img.status === 200 && img.headers.get("content-type") === "image/png" && bytes.length > 1000000 && bytes[0] === 0x89 && bytes[1] === 0x50, "[exit og live] the card renders on workerd (" + bytes.length + " bytes)");
  ok(hits.length === before, "[exit og live] the card reuses the summary cached by the page request (real Cache API): zero new subrequests, got " + (hits.length - before));
  const human = await m.dispatchFetch("https://zaexa.com/exit/" + WALLET, { headers: { "user-agent": "Mozilla/5.0 Firefox/130" } });
  ok(tag(await human.text(), "og:title") === "Exit value of 0xabab…abab: $3,000 if sold now" && hits.length === before, "[exit og live] a human visit afterwards sees the cached numbers with no recomputation");
  const bad = await m.dispatchFetch("https://zaexa.com/og/exit/0x123.png");
  ok(bad.status === 400, "[exit og live] a bad address is 400 on workerd, got " + bad.status);
  const g = await m.dispatchFetch("https://zaexa.com/exit", BOT);
  const gh = await g.text();
  ok(/^Exit value/.test(tag(gh, "og:title") || "") && tag(gh, "og:image") === "https://zaexa.com/og.png?v=5" && !g.headers.get("x-robots-tag"), "[exit og live] /exit keeps the generic card with an Exit value title and stays indexable");
  await m.dispose();
  console.log("[exit og live] workerd: /exit/<addr> tags from the wallet's numbers (real HTMLRewriter), card PNG, summary reused through the real Cache API, 400 on a bad address, /exit generic");
}

console.log(fails === 0
  ? "[og live] ok — injection, escaping, fallback, image and home page all verified on workerd"
  : "[og live] " + fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
