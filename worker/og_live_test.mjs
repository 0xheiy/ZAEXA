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
import { OG_IMAGE_V } from "./og.js";

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

function mf() {
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
    bindings: { CG_KEY: "CG-secret-do-not-leak-me" },
    serviceBindings: {
      ASSETS: () =>
        new Response(PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
    // هر fetch بیرونیِ Worker از اینجا رد می‌شود — بالادست واقعی زده نمی‌شود.
    outboundService: (req) => {
      upstreamHits.push(req.url);
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
  ok(html.includes('content="https://zaexa.com/og.png?v=' + OG_IMAGE_V + '"'),
     "og:image is not absolute, or its version is stale (expected v=" + OG_IMAGE_V + ")");
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

console.log(fails === 0
  ? "[og live] ok — injection, escaping, fallback, image and home page all verified on workerd"
  : "[og live] " + fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
