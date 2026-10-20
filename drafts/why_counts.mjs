#!/usr/bin/env node
/*
 * why_counts.mjs — پیش‌نویس، هنوز کامیت نشده
 * =========================================
 * صفِ کارِ باز، مورد ۲: «نیمی از گزارش نامعلوم است. قدمِ بعد: شمردنِ دلیل‌ها
 * روی ردیف‌های بعد از deploy، نه حدس.»
 *
 * این فقط یک شمارنده است. هیچ چیزی را در سایت، KV یا کد عوض نمی‌کند —
 * فقط GET می‌زند و می‌شمارد. اجرا روی سایتِ زنده بی‌خطر است.
 *
 *   node drafts/why_counts.mjs                    # امروز
 *   node drafts/why_counts.mjs 2026-09-16         # یک روز
 *   node drafts/why_counts.mjs 2026-09-15 2026-09-16
 *   node drafts/why_counts.mjs --file zx.json     # از فایلِ محلی
 *
 * 🔴 چرا «ردیف‌های بعد از deploy» مهم است: ردیف‌هایی که پیش از انتشارِ `why`
 *    نوشته شده‌اند اصلاً این کلید را ندارند. شمردنشان به‌عنوان «بدونِ دلیل»
 *    یک دسته‌ی ساختگی می‌سازد که هیچ‌چیز درباره‌ی خط‌لوله نمی‌گوید. پس
 *    ردیفِ بدونِ کلید از ردیفِ با `why: null` جدا شمرده می‌شود.
 */

import { readFileSync } from "node:fs";

const BASE = process.env.ZX_BASE || "https://zaexa.com";

/* همان واژه‌نامه‌ی بسته‌ی VD_BASE_WHY در worker/verdict.js، به همان ترتیبِ
   جایی که خط‌لوله می‌ایستد. اینجا کپی شده و *وارد نشده*، عمداً: این اسکریپت
   باید بتواند روی یک گزارشِ زنده اجرا شود بی‌آنکه به درختِ کد وابسته باشد.
   ⚠️ اگر آن فهرست عوض شد، این هم باید عوض شود — نگهبانِ `unknown reason`
   پایین‌تر همین واگرایی را داد می‌زند. */
const KNOWN_WHY = [
  "meta:timeout", "meta:shape", "no-amount", "deadline", "rpc-down",
  "canary-dead", "no-quote", "proof-rpc", "proof-no-quote", "usdc-rpc",
  "usdc-no-proof", "cover:timeout", "cover:shape", "cover:false", "internal",
];
// `meta:<status>` و `cover:<status>` عددِ HTTP را در خودشان دارند
const KNOWN_PREFIX = ["meta:", "cover:"];

// دو فرضیه‌ای که *پیش از دیدنِ عدد* در PROJECT_STATUS.md ثبت شدند
const HYPOTHESES = [
  { key: "meta:429", label: "سقفِ نرخِ گِکوترمینال" },
  { key: "no-quote", label: "توکن‌های نسخه ۴ بی‌کلیدِ واقعی" },
];

const isKnown = (w) =>
  KNOWN_WHY.includes(w) || KNOWN_PREFIX.some((p) => w.startsWith(p));

async function loadDate(date) {
  const url = `${BASE}/report/${date}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function count(doc) {
  const rows = doc.rows || [];
  const out = {
    total: rows.length,
    byVerdict: {},          // sell / nosell / null
    whyCounts: {},          // فقط ردیف‌هایی که حکمشان null است
    nullNoKey: 0,           // null، ولی اصلاً کلیدِ why ندارد → پیش از deploy
    nullWithKey: 0,
    unknownReasons: [],     // چیزی بیرون از واژه‌نامه → واگراییِ کد و اسکریپت
  };

  for (const r of rows) {
    const v = r.v === null || r.v === undefined ? "null" : String(r.v);
    out.byVerdict[v] = (out.byVerdict[v] || 0) + 1;
    if (v !== "null") continue;

    if (!("why" in r)) { out.nullNoKey++; continue; }
    out.nullWithKey++;
    const w = r.why === null ? "(null — کلید هست، مقدار نیست)" : String(r.why);
    out.whyCounts[w] = (out.whyCounts[w] || 0) + 1;
    if (r.why !== null && !isKnown(String(r.why))) out.unknownReasons.push(String(r.why));
  }
  return out;
}

function render(date, doc, c) {
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1).padStart(5) : "  0.0");
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  ${date}   (generatedAt: ${doc.generatedAt || "—"})`);
  console.log("═".repeat(62));
  console.log(`  ردیف‌ها: ${c.total}   ·   store: ${doc.store}`);

  console.log(`\n  ── حکم ──`);
  for (const [v, n] of Object.entries(c.byVerdict).sort((a, b) => b[1] - a[1]))
    console.log(`    ${v.padEnd(28)} ${String(n).padStart(4)}   ${pct(n, c.total)}%`);

  const nulls = c.byVerdict["null"] || 0;
  if (!nulls) { console.log("\n  هیچ ردیفِ نامعلومی نیست."); return c; }

  console.log(`\n  ── چرا نامعلوم؟ (${nulls} ردیف) ──`);
  if (c.nullNoKey)
    console.log(`    ⚠️  ${c.nullNoKey} ردیف اصلاً کلیدِ why ندارد → پیش از deploy، قابل شمردن نیست`);
  if (!c.nullWithKey) {
    console.log("    (هیچ ردیفِ پس از deploy ای در این روز نیست)");
    return c;
  }
  for (const [w, n] of Object.entries(c.whyCounts).sort((a, b) => b[1] - a[1]))
    console.log(`    ${w.padEnd(28)} ${String(n).padStart(4)}   ${pct(n, c.nullWithKey)}%  از قابل‌شمردن‌ها`);

  console.log(`\n  ── دو فرضیه‌ی از پیش ثبت‌شده ──`);
  for (const h of HYPOTHESES) {
    const n = c.whyCounts[h.key] || 0;
    const mark = n > 0 ? "✓" : "✗";
    console.log(`    ${mark} ${h.key.padEnd(14)} ${String(n).padStart(4)}   ${pct(n, c.nullWithKey)}%   ${h.label}`);
  }

  if (c.unknownReasons.length) {
    const uniq = [...new Set(c.unknownReasons)];
    console.log(`\n  🔴 دلیلِ بیرون از واژه‌نامه (${uniq.length} نوع): ${uniq.join(", ")}`);
    console.log(`     یعنی KNOWN_WHY در این اسکریپت از worker/verdict.js عقب است.`);
  }
  return c;
}

const args = process.argv.slice(2);
let dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const fileIdx = args.indexOf("--file");

if (fileIdx !== -1) {
  const doc = JSON.parse(readFileSync(args[fileIdx + 1], "utf8"));
  render(doc.date || "(فایل)", doc, count(doc));
} else {
  if (!dates.length) dates = [new Date().toISOString().slice(0, 10)];
  for (const d of dates) {
    try {
      const doc = await loadDate(d);
      render(d, doc, count(doc));
    } catch (e) {
      console.log(`\n  ${d} — ${e.message}`);
    }
  }
}
