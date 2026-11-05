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

import { ogEscape } from "./og.js";
import { publishGuardRow, REPORT_MIN_RESERVE_USD } from "./report.js";

/* حکمِ نمایشی: "sell" | "nosell" (فقط با علتِ اثبات‌شده) | null */
export function guardedKind(vd, chainLabel) {
  const chain = chainLabel === "Solana" ? "solana" : "base";
  if (!vd || typeof vd !== "object") return { kind: null };
  const g = publishGuardRow({ v: vd.v, why: vd.why, cause: vd.cause }, chain);
  if (g.v === "sell") return { kind: "sell" };
  if (g.v === "nosell" && chain !== "solana" && (g.cause === "empty-pool" || g.cause === "sell-reverts")) {
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

/* { sym, facts } — facts رشته‌ی HTML (همه‌ی مقادیر گریزخورده) یا null */
export function tokenSeo(meta, vd, chainLabel, addr) {
  const out = { sym: null, name: null, facts: null, noindex: false };
  if (!meta) return out;
  out.noindex = tokenNoindex(meta, vd, chainLabel);
  const sym = meta.symbol || null, name = meta.name || null;
  if (!sym && !name) return out;
  out.sym = sym || name;
  out.name = name;

  const chain = chainLabel === "Solana" ? "Solana" : "Base";
  const k = guardedKind(vd, chain);
  const ident = !sym ? name
    : (!name || name.toLowerCase() === sym.toLowerCase()) ? sym
    : name + " (" + sym + ")";

  let chip, cls = "fbChip", pred, tail = "";
  if (k.kind === "sell") {
    chip = "Sell route quoted"; cls += " p"; pred = "quoted a sell route"; tail = " A quote is not a guarantee.";
  } else if (k.kind === "nosell") {
    const why = k.cause === "empty-pool" ? "pool is empty" : "the sell reverts";
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
  out.facts = '<div class="tkChips">' + chips.join("") + '</div><p class="tkAbout">' + ogEscape(text) + "</p>";
  return out;
}
