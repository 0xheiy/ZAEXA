/* =====================================================================
   متنِ واقعیِ صفحه‌ی توکن برای موتورهای جست‌وجو — /t/<آدرس>
   =====================================================================
   قبلاً هر /t/… یک بدنه‌ی یکسان بود و تنها h1 «How ZAEXA works» بود، پس
   گوگل همه را تکراری می‌دید. اینجا از *همان* داده‌ای که کارتِ OG دارد (meta و
   verdict، بدونِ هیچ تماسِ بالادستیِ تازه) متنی ساخته می‌شود که Worker داخلِ
   همان UI مرئی می‌نشاند؛ چیزی از کاربر پنهان نمی‌ماند.

   قاعده‌ها:
   • verdict اول از publishGuardRow رد می‌شود — nosellِ بی‌علت «تأییدنشده» است،
     و سولانا هرگز nosell نشان نمی‌دهد.
   • زمانِ چک و نامِ صرافی: داده‌ی صادقی در meta/verdict نیست (verdict ممکن
     است تا ۵ دقیقه از کش آمده باشد و dex همراهش نیست) → نمی‌آیند.
   • noindex فقط با شاهدِ مثبت: ذخیره‌ی شناخته‌شده زیرِ حداقلِ گزارش، یا
     empty-poolِ اثبات‌شده. نامعلوم/خطای بالادست → هرگز noindex.
   • هر مقدارِ بیرونی از ogEscape می‌گذرد. */

import { ogEscape, ogBig } from "./og.js";
import { publishGuardRow, REPORT_MIN_RESERVE_USD } from "./report.js";
import { dexLabel, fmtDay, fmtDayYear, fmtDayTime, fmtStamp, fmtLong, shortAddress } from "./tokfacts.js";

/* حکمِ نمایشی: "sell" | "nosell" (فقط با علتِ اثبات‌شده) | null */
export function guardedKind(vd, chainLabel) {
  const chain = chainLabel === "Solana" ? "solana" : "base";
  if (!vd || typeof vd !== "object") return { kind: null };
  const g = publishGuardRow({ v: vd.v, why: vd.why, cause: vd.cause }, chain);
  if (g.v === "sell") return { kind: "sell" };
  if (g.v === "nosell" && chain !== "solana" && (g.cause === "empty-pool" || g.cause === "sell-reverts" || g.cause === "one-way-pool")) {
    return { kind: "nosell", cause: g.cause };
  }
  return { kind: null };
}

/* ۵ نوامبر — همان گارد برای کارتِ OG (meta description و تصویر): nosellِ بی‌علتِ
   اثبات‌شده و هر nosellِ سولانا «نامعلوم» (null) می‌شود، نه «No sell route».
   نمونه: XTO کارتش «you may not be able to exit» می‌گفت و صفحه «Not confirmed». */
export function ogGuarded(vd, chainLabel) {
  const k = guardedKind(vd, chainLabel);
  return k.kind === "nosell" ? { verdict: "nosell", cause: k.cause } : { verdict: k.kind, cause: undefined };
}

export function tokenNoindex(meta, vd, chainLabel) {
  const liq = meta && meta.liquidityUsd;
  if (typeof liq === "number" && Number.isFinite(liq) && liq < REPORT_MIN_RESERVE_USD) return true;
  const k = guardedKind(vd, chainLabel);
  return k.kind === "nosell" && k.cause === "empty-pool";
}

/* واژه‌نامه‌ی بسته‌ی حکم — تنها منبعِ متنِ حکم برای چیپ، جعبه‌ی Token facts و عنوان */
const CAUSE_WORDS = { "empty-pool": "pool is empty", "one-way-pool": "one-way pool", "sell-reverts": "the sell reverts" };
function kindOfGuarded(v, cause, chain) {
  if (v === "sell") return { kind: "sell" };
  if (v === "nosell" && chain !== "solana" && Object.prototype.hasOwnProperty.call(CAUSE_WORDS, cause)) return { kind: "nosell", cause };
  return { kind: null };
}
function wordOf(k) {
  if (k.kind === "sell") return "Sell route quoted";
  if (k.kind === "nosell") return "No sell route quoted \u00b7 " + CAUSE_WORDS[k.cause];
  return "Not confirmed";
}
const lowerWord = (k) => (k.kind === "sell" ? "sell route quoted" : k.kind === "nosell" ? "no sell route quoted" : "not confirmed");

function identOf(sym, name) {
  return !sym ? name : (!name || name.toLowerCase() === sym.toLowerCase()) ? sym : name + " (" + sym + ")";
}

/* ۲۶ نوامبر — عنوانِ مخصوصِ توکن: «SYM (Chain) — sell route quoted · Zaexa».
   بدونِ نماد → نام؛ بدونِ هر دو → null (کالر عنوانِ عمومیِ همیشگی را نگه می‌دارد). */
export function tokenTitle(meta, vd, chainLabel) {
  if (!meta) return null;
  const lead = meta.symbol || meta.name || null;
  if (!lead) return null;
  const chain = chainLabel === "Solana" ? "Solana" : "Base";
  return lead + " (" + chain + ") \u2014 " + lowerWord(guardedKind(vd, chain)) + " \u00b7 Zaexa";
}

const DESC_MAX = 200;
/* «<Name> (<SYM>) on <Chain>, contract <0x12ab…cdef>. Zaexa's last exit check: <word>.
   [ Liquidity now $Y.][ First seen in the Exit Report on D Mon.]» ≤ ۲۰۰ نویسه؛ تکه‌های
   اختیاری از آخر می‌افتند. هر قاعده‌ی ogGuarded (nosellِ بی‌علت/سولانا) همان است. */
export function tokenDescription(meta, vd, chainLabel, addr, tf) {
  if (!meta) return null;
  const sym = meta.symbol || null, name = meta.name || null;
  if (!sym && !name) return null;
  const chain = chainLabel === "Solana" ? "Solana" : "Base";
  const k = guardedKind(vd, chain);
  const emptyPool = k.kind === "nosell" && k.cause === "empty-pool";
  const head = identOf(sym, name) + " on " + chain + (addr ? ", contract " + shortAddress(addr) : "") +
    ". Zaexa's last exit check: " + lowerWord(k) + ".";
  const liq = !emptyPool && meta.liquidity ? " Liquidity now " + meta.liquidity + "." : "";
  const fs = tf && tf.firstDate ? fmtDay(tf.firstDate) : null;
  const seen = fs ? " First seen in the Exit Report on " + fs + "." : "";
  for (const d of [head + liq + seen, head + liq, head]) if (d.length <= DESC_MAX) return d;
  return head.slice(0, DESC_MAX - 1).trimEnd() + "\u2026";
}

/* ---------- جعبه‌ی Token facts ----------
   فقط وقتی tf (tokFacts) داریم؛ هر بخشِ بی‌داده کلاً حذف می‌شود (نه جای‌نگهدار،
   نه «0»). هر رشته‌ی بیرونی از ogEscape می‌گذرد.
   ۲۶ نوامبر (طراحیِ دوباره): نام/نماد/زنجیره/آدرس دیگر اینجا نیست (کارتِ بالایی همان‌ها را دارد؛
   #tk-addr هم سمتِ سرور پر می‌شود)؛ کاشی‌های آمار، خطِ استخر، خطِ زمانیِ exit check، پیل‌های
   گزارش و یک پنلِ هم‌نام. */
const ex = (t) => ogEscape(t);

/* کاشیِ آمار: مقدارِ «Now» درشت، زیرش «First check …». فقط اولین‌مقدار → همان مقدار می‌شود با «at first check» */
function tile(label, firstVal, firstDay, nowStr) {
  let v = null, sub = "";
  if (nowStr) {
    v = nowStr;
    if (firstVal) sub = "First check " + firstVal + (firstDay ? " \u00b7 " + firstDay : "");
  } else if (firstVal) {
    v = firstVal;
    sub = "at first check" + (firstDay ? ", " + firstDay : "");
  }
  if (!v) return "";
  return '<div class="tkfTile"><div class="k">' + ex(label) + '</div><div class="v">' + ex(v) + "</div>" +
    (sub ? '<div class="s">' + ex(sub) + "</div>" : "") + "</div>";
}

const DOT = { sell: "g", nosell: "r", none: "n" };
function exitItems(vd, chain, tf) {
  const items = [{ t: Infinity, cls: DOT[guardedKind(vd, chain).kind || "none"], text: wordOf(guardedKind(vd, chain)), time: "Live, this page" }];
  const ev = [];
  const lc = chain.toLowerCase();
  for (const { row: r } of tf.rows) {
    const k = kindOfGuarded(r.v, r.cause, lc);
    const t = Date.parse(r.checkedAt), st = fmtStamp(r.checkedAt);
    if (st && Number.isFinite(t)) ev.push({ t, cls: DOT[k.kind || "none"], text: wordOf(k), time: st });
    if (r.v === "sell" && (r.follow === "pool-there" || r.follow === "pool-empty")) {
      const ft = Date.parse(r.followAt), fs = fmtStamp(r.followAt);
      if (fs && Number.isFinite(ft)) ev.push({ t: ft, cls: r.follow === "pool-there" ? "g" : "r", text: r.follow === "pool-there" ? "Pool still there an hour later" : "Pool empty an hour later", time: fs });
    }
    if (r.v == null && (r.recheck === "sell" || r.recheck === "nosell")) {
      const rt = Date.parse(r.recheckAt), rs = fmtStamp(r.recheckAt);
      const rk = kindOfGuarded(r.recheck, r.recheckCause, lc);
      if (rs && Number.isFinite(rt)) ev.push({ t: rt, cls: DOT[rk.kind || "none"], text: "Rechecked: " + wordOf(rk), time: rs });
    }
  }
  ev.sort((a, b) => b.t - a.t);
  return items.concat(ev).slice(0, 5);
}

const tokPill = (s) => {
  const bits = [];
  if (s.y) bits.push(s.y);
  bits.push(shortAddress(s.a));
  const d = fmtDay(s.d);
  return '<a class="fbChip" href="/t/' + ex(s.a) + '">' + ex(bits.join(" \u00b7 ")) + (d ? ' <span class="d">' + ex(d) + "</span>" : "") + "</a>";
};

function panelHtml(nb, sb, name, sym, range) {
  const hashes = (b) => new Set(String(b.set || "").split(",").filter(Boolean));
  const from = range && fmtDay(range.from), to = range && fmtDay(range.to);
  const sameYear = range && range.from.slice(0, 4) === range.to.slice(0, 4);
  const span = from && to ? "In Zaexa's daily reports, " + (sameYear ? from + " \u2013 " + to : fmtDayYear(range.from) + " \u2013 " + fmtDayYear(range.to)) : "";
  const plural = (n) => n + " other token" + (n === 1 ? "" : "s");
  const one = (blk, word, shown, tail) => '<div class="tkfPanel"><b>' + ex(plural(blk.count) + " used the " + word + " \u201c" + shown + "\u201d" + (tail || "")) + "</b>" +
    (span ? '<div class="s">' + ex(span) + "</div>" : "") +
    (blk.samples.length ? '<div class="tkfPills">' + blk.samples.map(tokPill).join("") + "</div>" : "") + "</div>";
  let out = "";
  if (nb && name) {
    let tail = "";
    let symNew = false;
    if (sb && sym) {
      const nh = hashes(nb), sh = hashes(sb);
      const both = [...sh].filter((h) => nh.has(h)).length;
      symNew = [...sh].some((h) => !nh.has(h));
      if (!symNew && both >= 1) tail = " (" + both + (both === 1 ? " of them also uses" : " of them also use") + " the symbol " + sym + ")";
    }
    out += one(nb, "name", name, tail);
    if (sb && sym && symNew) out += one(sb, "symbol", sym);
  } else if (sb && sym) {
    out += one(sb, "symbol", sym);
  }
  return out;
}

export function tokenFactsBox(meta, vd, chainLabel, addr, tf) {
  if (!meta || !tf || typeof tf !== "object") return "";
  const chain = chainLabel === "Solana" ? "Solana" : "Base";
  const k = guardedKind(vd, chain);
  const emptyPool = k.kind === "nosell" && k.cause === "empty-pool";
  const rows = Array.isArray(tf.rows) ? tf.rows : [];
  const newest = rows.length ? rows[0].row : null;
  const firstRow = (tf.firstDate && (rows.find((x) => x.date === tf.firstDate) || {}).row) || null;
  const firstDay = firstRow && tf.firstDate ? fmtDay(tf.firstDate) : null;

  const nowLiq = emptyPool ? null : meta.liquidity || null;
  const nowVol = emptyPool ? null : meta.vol24 || null;
  const nowFdv = emptyPool ? null : ogBig(meta.fdvUsd);
  const tiles =
    tile("Liquidity", firstRow ? ogBig(firstRow.reserveUsd) : null, firstDay, nowLiq) +
    tile("FDV", firstRow ? ogBig(firstRow.fdvUsd) : null, firstDay, nowFdv) +
    tile("Volume 24h", firstRow ? ogBig(firstRow.vol24hUsd) : null, firstDay, nowVol);

  let pool = "";
  if (newest) {
    const lab = dexLabel(newest.dex), cr = fmtLong(newest.poolCreatedAt);
    pool = lab && cr ? lab + " pool \u00b7 created " + cr : lab ? lab + " pool" : cr ? "Pool created " + cr : "";
  }

  const items = exitItems(vd, chain, tf);
  const tl = '<ol class="tkfTl">' + items.map((i) => '<li class="' + i.cls + '"><i></i><span>' + ex(i.text) + "</span><time>" + ex(i.time) + "</time></li>").join("") + "</ol>";
  const dates = (Array.isArray(tf.dates) ? tf.dates : []).slice().sort().reverse().slice(0, 5);
  const pills = dates.map((d) => '<a class="fbChip" href="/report/' + ex(d) + '">Exit Report \u00b7 ' + ex(fmtDay(d) || d) + "</a>").join("");

  const sm = tf.same && typeof tf.same === "object" ? tf.same : null;
  const nb = sm && sm.name && sm.name.count >= 1 ? sm.name : null;
  const sb = sm && sm.symbol && sm.symbol.count >= 1 ? sm.symbol : null;
  const name = meta.name || (newest && typeof newest.name === "string" ? newest.name : null);
  const sym = meta.symbol || (newest && typeof newest.symbol === "string" ? newest.symbol : null);

  return '<section class="tkFactsBox" aria-labelledby="tk-facts-h"><h2 id="tk-facts-h" class="tkfH">Token facts</h2>' +
    (tiles ? '<div class="tkfTiles">' + tiles + "</div>" : "") +
    (pool ? '<p class="tkfPool">' + ex(pool) + "</p>" : "") +
    '<div class="tkfGroup"><h3 class="tkfH">Exit checks</h3>' + tl + "</div>" +
    (pills ? '<div class="tkfGroup"><h3 class="tkfH">In Exit Report</h3><div class="tkfPills">' + pills + "</div></div>" : "") +
    panelHtml(nb, sb, name, sym, tf.range) + "</section>";
}

/* { sym, facts } — facts رشته‌ی HTML (همه‌ی مقادیر گریزخورده) یا null.
   tf (اختیاری) خروجیِ tokFacts است؛ بدونِ آن، خروجی بایت‌به‌بایت همان قبلی است
   (عنوان/توضیحِ تازه فقط با meta ساخته می‌شوند و جدا از tf‌اند). */
export function tokenSeo(meta, vd, chainLabel, addr, tf) {
  const out = { sym: null, name: null, facts: null, noindex: false, title: null, desc: null };
  if (!meta) return out;
  out.noindex = tokenNoindex(meta, vd, chainLabel);
  const sym = meta.symbol || null, name = meta.name || null;
  if (!sym && !name) return out;
  out.sym = sym || name;
  out.name = name;
  out.title = tokenTitle(meta, vd, chainLabel);
  out.desc = tokenDescription(meta, vd, chainLabel, addr, tf);

  const chain = chainLabel === "Solana" ? "Solana" : "Base";
  const k = guardedKind(vd, chain);
  const ident = identOf(sym, name);

  let chip, cls = "fbChip", pred, tail = "";
  if (k.kind === "sell") {
    chip = "Sell route quoted"; cls += " p"; pred = "quoted a sell route"; tail = " A quote is not a guarantee.";
  } else if (k.kind === "nosell") {
    const why = k.cause === "empty-pool" ? "pool is empty" : k.cause === "one-way-pool" ? "one-way pool" : "the sell reverts";
    chip = "No sell route quoted · " + why; cls += " n";
    pred = "found no sell route: " + why;
  } else {
    chip = "Not confirmed";
    pred = "could not confirm a sell route (this is not a verdict that you cannot sell)";
  }

  /* استخرِ خالیِ اثبات‌شده: عددِ ذخیره/حجمِ GT شاهدِ نقدینگی نیست و کنارِ
     «pool is empty» متناقض دیده می‌شود (JFF، ۵ نوامبر) → هیچ مبلغی نمی‌آید. */
  const emptyPool = k.kind === "nosell" && k.cause === "empty-pool";
  const pool = emptyPool ? null : (meta.liquidity || null), vol = emptyPool ? null : (meta.vol24 || null);
  let money = "";
  if (pool && vol) money = " Its pools held about " + pool + " with " + vol + " traded in the last 24 hours.";
  else if (pool) money = " Its pools held about " + pool + ".";
  else if (vol) money = " Its pools had " + vol + " traded in the last 24 hours.";

  const text = ident + " is a token on " + chain + ". Zaexa's last exit check " + pred + "." + money + tail;
  const chips = ['<span class="' + cls + '">Exit check: ' + ogEscape(chip) + "</span>"];
  if (pool) chips.push('<span class="fbChip">Pool ' + ogEscape(pool) + "</span>");
  if (vol) chips.push('<span class="fbChip">Vol 24h ' + ogEscape(vol) + "</span>");
  out.facts = '<div class="tkChips">' + chips.join("") + '</div><p class="tkAbout">' + ogEscape(text) + "</p>" +
    tokenFactsBox(meta, vd, chainLabel, addr, tf);
  return out;
}
