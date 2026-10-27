import { pageShell, whyTable, WHY_FALLBACK_TEXT, REPORT_SITE_ORIGIN } from "./report_page.js";
import { REPORT_CAUSES } from "./report.js";
import { ogVerdictLabel } from "./og-token.js";
import { LAST_LINE } from "./tg.js";

/* =====================================================================
   worker/api_page.js — GET /api، راهنمای عمومیِ GET /vd/<address> برای اسکنرها و بات‌ها
   =====================================================================
   مثل صفحه‌ی گزارش از Worker می‌آید (نه _site: خط Build در پنل فایلِ تازه را نمی‌رساند)
   و از همان pageShell استفاده می‌کند — هدر، تم، فونت، فوتر و موبایل یکی است.
   هیچ I/O ندارد. سه چیز عمداً از منبعِ خودش ساخته می‌شود، نه کپی:
     • جدولِ why  ← whyTable (worker/report_page.js، همان plainWhy که صفحه‌ی گزارش دارد)
     • علت‌ها    ← REPORT_CAUSES + ogVerdictLabel (متنِ کارت)
     • سقفِ نرخ  ← پارامترِ limit/windowMs که index.js از RL_LIMIT/RL_WINDOW_MS می‌دهد
   مثال‌ها از شکلِ واقعیِ پاسخ در diagVerdict (worker/index.js) گرفته شده‌اند؛ عددها نمونه‌اند. */

export const API_BASE_EXAMPLE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC روی Base
export const API_SOL_EXAMPLE = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";  // JUP؛ همان mintِ فهرستِ سولاناییِ web/index.html
export const API_TELEGRAM = "https://t.me/zaexadex";
export const API_X = "https://x.com/zaexadex";

// جمله‌ی توضیحِ هر علت — کلیدها باید دقیقاً REPORT_CAUSES باشند (تستِ worker/test.mjs)؛ علتِ بی‌جمله فقط برچسبِ کارت را نشان می‌دهد.
export const API_CAUSE_NOTES = Object.freeze({
  "empty-pool": "The pool holds nothing, so there is nothing to sell into.",
  "sell-reverts": "The pool holds funds, but a sell quote on it reverts.",
  "one-way-pool": "A $100 buy fills on a Uniswap v4 pool, but selling the same amount back does not.",
});

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const API_CSS = String.raw`
.api{gap:28px}
.api h2{margin:0 0 10px;font-size:18px;letter-spacing:-.02em}
.api h3{margin:0 0 6px;font-size:14px;letter-spacing:-.01em}
.api p{margin:0 0 10px;color:var(--tx2);font-size:14.5px;line-height:1.65;max-width:70ch}
.api p:last-child{margin-bottom:0}
.api code,.api pre{font-family:var(--mono)}
.api p code,.api td code,.api li code{font-size:12.5px;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:var(--tx);overflow-wrap:anywhere}
.api pre{margin:0 0 10px;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:12.5px;line-height:1.6;color:var(--tx);overflow-x:auto;white-space:pre;-webkit-overflow-scrolling:touch}
.api pre:last-child{margin-bottom:0}
.api pre .dim{color:var(--tx3)}
.api .two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.api .two>div{min-width:0}
.api .eg{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.api .eg h3 span{color:var(--tx3);font-weight:500}
.api table.k{min-width:0;table-layout:auto}
.api table.k td,.api table.k th{vertical-align:top}
.api table.k td:first-child{white-space:nowrap}
.api table.k td{overflow-wrap:anywhere}
.api .tblwrap{margin-top:8px}
.api ul{margin:0 0 10px;padding-left:18px;color:var(--tx2);font-size:14.5px;line-height:1.65}
.api .kv{display:inline-block;padding:2px 9px;border-radius:999px;font:600 12px var(--mono);margin-right:6px}
.api .kv.s{background:color-mix(in srgb,var(--pos) 12%,transparent);color:var(--pos)}
.api .kv.n{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.api .kv.u{background:var(--raise);color:var(--tx2)}
.api .std{margin-top:4px;font-family:var(--serif);font-style:italic;font-size:20px;color:var(--tx)}
.api .eg pre{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:820px){.api .two{grid-template-columns:1fr}.api{gap:22px}
.api table.k thead{display:none}
.api table.k,.api table.k tbody,.api table.k tr,.api table.k td{display:block;width:100%}
.api table.k tr{padding:9px 0;border-bottom:1px solid var(--line)}
.api table.k td{border:0;padding:2px 0}
.api table.k td:first-child{white-space:normal}}
`;

function windowText(windowMs) {
  const s = Math.round(windowMs / 1000);
  if (s === 60) return "per minute";
  if (s % 60 === 0) return "per " + (s / 60) + " minutes";
  return "per " + s + " seconds";
}

const kvTable = (rows, head) =>
  '<div class="tblwrap"><table class="k"><thead><tr><th>' + esc(head[0]) + "</th><th>" + esc(head[1]) + "</th></tr></thead><tbody>" +
  rows.map((r) => "<tr><td><code>" + esc(r.code) + "</code></td><td>" + esc(r.text) + "</td></tr>").join("") +
  "</tbody></table></div>";

// opts: { limit, windowMs } از RL_LIMIT / RL_WINDOW_MS در worker/index.js
export function renderApiPage(opts) {
  const limit = Number(opts && opts.limit), windowMs = Number(opts && opts.windowMs);
  const per = windowText(windowMs);
  const url = REPORT_SITE_ORIGIN + "/vd/";

  const causes = REPORT_CAUSES.map((c) => ({
    code: c,
    text: ogVerdictLabel("nosell", c).replace(/^No sell route quoted: /, "").replace(/^./, (m) => m.toUpperCase()) +
      (API_CAUSE_NOTES[c] ? ". " + API_CAUSE_NOTES[c] : "."),
  }));

  const sBase = '{"v":"sell","ms":1240,"ret":99.9}';
  const sSol = '{"v":"sell","ms":2870}';

  const main = '<main class="wrap api" id="top">' +
    '<section class="top"><p class="eyebrow">Public API · no key</p>' +
    "<h1>Exit check <em>API</em></h1>" +
    '<p class="lede">One GET tells you if a token can be sold: on Base, a live sell quote across the DEXs; on Solana, a simulated buy and sell.</p></section>' +

    '<section class="panel"><h2>How to call</h2>' +
    "<pre>GET " + esc(url) + '&lt;address&gt;</pre>' +
    "<p>Send a Base token contract (<code>0x…</code>) or a Solana mint. The chain is detected from the address. No key, no sign-up, no parameters, JSON back. It is meant for servers, scanners and bots: browser scripts on other sites are not allowed to read it (no CORS).</p>" +
    '<div class="two">' +
    '<div class="eg"><h3>Base <span>· USDC</span></h3><pre>curl ' + esc(url + API_BASE_EXAMPLE) + "\n<span class=\"dim\">" + esc(sBase) + "</span></pre></div>" +
    '<div class="eg"><h3>Solana <span>· JUP</span></h3><pre>curl ' + esc(url + API_SOL_EXAMPLE) + "\n<span class=\"dim\">" + esc(sSol) + "</span></pre></div>" +
    "</div>" +
    "<p>A bad address returns HTTP 400 <code>{\"error\":\"bad address\"}</code>. <code>ms</code> is how long the check took. Numbers above are examples; they vary per token and per moment.</p></section>" +

    '<section class="panel"><h2>What the answer means</h2>' +
    '<h3><span class="kv s">v: "sell"</span></h3>' +
    "<p>A sell route works. On Base a sell quote came back for about $100 of the token. On Solana a buy and a sell were simulated together and both passed.</p>" +
    "<p><code>ret</code>, when present, is how much a $100 sell quote returned, in percent (<code>97.4</code> means about $97.40 back). It compares the pool's quote with the listed price: it is not a promise and not a price call, and a value over 100 means the price feed and the pool disagreed, not a profit. On Solana it appears only with <code>\"basis\":\"quote\"</code>: the sell was quoted, not simulated, because the test wallet already held the token.</p>" +
    '<pre><span class="dim">{"v":"sell","ms":3400,"basis":"quote","ret":97.8}</span></pre>' +
    '<h3><span class="kv n">v: "nosell"</span> + <code>cause</code></h3>' +
    "<p>No sell route on Base. Zaexa publishes a no-sell only with a proven cause, and <code>cause</code> says which:</p>" +
    kvTable(causes, ["cause", "meaning"]) +
    '<pre style="margin-top:10px"><span class="dim">{"v":"nosell","ms":1530,"cause":"empty-pool"}</span></pre>' +
    "<p>A <code>nosell</code> without a <code>cause</code> is unproven. Zaexa does not publish it, and you should not either.</p>" +
    '<h3><span class="kv u">v: null</span> + <code>why</code></h3>' +
    "<p>The check could not be done. That is not a verdict on the token. <code>why</code> says what went wrong; the same sentences appear on the <a class=\"go\" href=\"/report\">Exit Report</a>. An unknown code means: " + esc(WHY_FALLBACK_TEXT) + "</p>" +
    '<pre><span class="dim">{"v":null,"ms":9100,"why":"rpc-down"}</span></pre>' +
    "<h3>Base</h3>" + kvTable(whyTable("base"), ["why", "meaning"]) +
    '<h3 style="margin-top:14px">Solana</h3>' + kvTable(whyTable("solana"), ["why", "meaning"]) +
    "<p style=\"margin-top:10px\">On Solana we never publish a <code>nosell</code>: a failed simulated sell becomes <code>{\"v\":null,\"why\":\"sol:unconfirmed\"}</code>.</p></section>" +

    '<section class="panel"><h2>Limits</h2>' +
    "<p><strong>" + esc(limit) + " requests " + esc(per) + " per IP.</strong> Over that you get HTTP 429 with <code>retry-after: 60</code>.</p>" +
    '<p>Need more? <a class="go" href="' + API_TELEGRAM + '" target="_blank" rel="noopener">Message us</a> on Telegram or <a class="go" href="' + API_X + '" target="_blank" rel="noopener">X</a>.</p></section>' +

    '<section class="panel"><h2>If you publish the result</h2>' +
    '<p>Please write <strong>Exit check by Zaexa</strong> and link <code>https://zaexa.com/t/&lt;address&gt;</code>.</p>' +
    '<p class="std">' + esc(LAST_LINE) + "</p></section>" +
    "</main>";

  return pageShell({
    title: "API — Zaexa",
    description: "Free exit-check API: GET /vd/<address> tells you if a Base or Solana token can be sold. No key; " + limit + " requests " + per + " per IP.",
    canonical: REPORT_SITE_ORIGIN + "/api",
    noindex: false, main, extraCss: API_CSS, noActiveTab: true,
  });
}
