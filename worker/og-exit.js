/* =====================================================================
   کارتِ پیش‌نمایشِ Exit value — /og/exit/<آدرس>.png (۱۲۰۰×۶۳۰، همان سبکِ تیره‌ی کارتِ توکن)
   =====================================================================
   همان رندرِ worker/og-token.js: پس‌زمینه‌ی پیش‌ساخته + یک نوارِ خام که در زمانِ اجرا متن می‌گیرد. تفاوت‌ها:
   • TOP.Base (ردیف‌های ۰–۲۹۵: نشان، «Zaexa»، پیلِ Base) و ردیف‌های ۲۹۶–۴۷۹ همان داده‌ی کارتِ توکن‌اند — تکرارِ ۱٫۸MB نیست.
   • ردیف‌های ۴۸۰–۵۹۹ و ۶۰۰–۶۲۹ از worker/og-exit-data.js (ساخته‌ی scripts/og/build_cards.py، خروجی ۳) می‌آیند؛
     در آن «zaexa.com»ِ پخته‌شده برداشته شده تا «zaexa.com/exit» را خودمان بنویسیم.
   • اطلسِ عددِ بزرگ (B96: فقط «$0123456789,.») از همان فایل؛ بقیه‌ی فونت‌ها از اطلسِ کارتِ توکن.
   • 🔴 نبودِ عدد هرگز «$0» نمی‌شود: exitCardPng({generic:true}) کارتِ «Exit value — check any Base wallet» را می‌سازد.
   ⚠️ CPU: مثلِ کارتِ توکن هیچ فشرده‌سازی‌ای در زمانِ اجرا نیست (بلوک‌های stored)؛ تست [exit og] میانه‌ی رندر را می‌سنجد.
   ===================================================================== */

import { TOP, BAND_Y0, ATLAS_INDEX, OG_W } from "./og-token-data.js";
import {
  EXIT_Y1, BAND2_RAW, BOTTOM2_Z, BOTTOM2_ADLER, BOTTOM2_LEN, BOTTOM2_CRC_STATE,
  EXIT_ATLAS_RAW, EXIT_ATLASES,
} from "./og-exit-data.js";
import {
  b64, crcUpdate, adler32, adlerCombine, put32, TYPE, SIG, BAND_BYTES, ATLAS_BYTES, TOP_BYTES, CHAR_IDX,
} from "./og-token.js";
import { exitMoney, exitPct, shortAddr, utcClock, EXIT_GAP_MED, EXIT_GAP_BIG, EXIT_LOST_NONE, exitLostSome } from "./exit.js";

const ROW = OG_W * 3 + 1;
const Y0 = BAND_Y0;                       // ۲۹۶
const ROWS = EXIT_Y1 - Y0;                // ۳۰۴ = ۱۸۴ ردیفِ توکن + ۱۲۰ ردیفِ تازه
const BAND1_LEN = BAND_BYTES.length;

// یک بار در هر isolate (خارج از درخواست)
const BAND2_BYTES = b64(BAND2_RAW);
const BOTTOM2_BYTES = b64(BOTTOM2_Z);
const EXIT_ATLAS_BYTES = b64(EXIT_ATLAS_RAW);
if (BAND1_LEN + BAND2_BYTES.length !== ROWS * ROW) throw new Error("exit band size mismatch");

const GRAY = [154, 162, 182], DIM = [115, 109, 138], WHITE = [242, 244, 250];
const GREEN = [33, 211, 160], AMBER = [245, 166, 35], RED = [242, 84, 91];
const GRAD = [[34, 239, 246], [115, 150, 248], [197, 108, 245]];

function blend(band, p, r, g, b, a) {
  if (a <= 0) return;
  if (a >= 255) { band[p] = r; band[p + 1] = g; band[p + 2] = b; return; }
  const ia = 255 - a;
  band[p] = ((band[p] * ia + r * a + 127) / 255) | 0;
  band[p + 1] = ((band[p + 1] * ia + g * a + 127) / 255) | 0;
  band[p + 2] = ((band[p + 2] * ia + b * a + 127) / 255) | 0;
}
const px = (x, y) => (y - Y0) * ROW + 1 + x * 3;

// رنگِ گرادیان در t∈[0,1]
function gradAt(t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const seg = k * (GRAD.length - 1), i = Math.min(GRAD.length - 2, Math.floor(seg)), f = seg - i;
  return [0, 1, 2].map((c) => Math.round(GRAD[i][c] + (GRAD[i + 1][c] - GRAD[i][c]) * f));
}

function textW(rows, idx, str) {
  let w = 0;
  for (const ch of str) w += rows[idx.get(ch)][0];
  return w;
}
function drawGlyphs(band, rows, idx, atlas, str, x, base, col, grad) {
  const total = grad ? textW(rows, idx, str) : 0;
  let pen = x;
  for (const ch of str) {
    const [adv, dx, dy, w, h, off] = rows[idx.get(ch)];
    if (w > 0) {
      const gx = Math.round(pen) + dx, gy = base + dy;
      for (let j = 0; j < h; j++) {
        const y = gy + j;
        if (y < Y0 || y >= Y0 + ROWS) continue;
        for (let i = 0; i < w; i++) {
          const xx = gx + i;
          if (xx < 0 || xx >= OG_W) continue;
          const cov = atlas[off + j * w + i];
          if (!cov) continue;
          const c = grad ? gradAt((pen - x + dx + i) / Math.max(1, total)) : col;
          blend(band, px(xx, y), c[0], c[1], c[2], cov);
        }
      }
    }
    pen += adv;
  }
}
const tok = (key) => ({ rows: ATLAS_INDEX[key], idx: CHAR_IDX, atlas: ATLAS_BYTES });
const KEYS = { B56: tok("B56"), R34: tok("R34"), R28: tok("R28"), B28: tok("B28"), B31: tok("B31"),
  B72: { rows: EXIT_ATLASES.B72.rows, idx: new Map(Array.from(EXIT_ATLASES.B72.chars).map((c, i) => [c, i])), atlas: EXIT_ATLAS_BYTES },
  R20: { rows: EXIT_ATLASES.R20.rows, idx: new Map(Array.from(EXIT_ATLASES.R20.chars).map((c, i) => [c, i])), atlas: EXIT_ATLAS_BYTES } };
const wid = (key, s) => textW(KEYS[key].rows, KEYS[key].idx, s);
function text(band, key, s, x, base, col, grad) {
  const k = KEYS[key];
  drawGlyphs(band, k.rows, k.idx, k.atlas, s, x, base, col, grad);
}
// «۱۲٫۳۴» همان رشته‌ی کارتِ کلاینت؛ هر نویسه‌ی بیرون از اطلس = رشته‌ی خالی، نه پرتاب
const okChars = (key, s) => { const k = KEYS[key]; for (const ch of s) if (!k.idx.has(ch)) return false; return true; };

function rect(band, x0, y0, x1, y1, col, a) {
  x0 = Math.round(x0); x1 = Math.round(x1);   // ایندکسِ غیرصحیح در Uint8Array بی‌صدا هیچ‌چیز نمی‌نویسد
  for (let y = y0; y < y1; y++) {
    if (y < Y0 || y >= Y0 + ROWS) continue;
    for (let x = x0; x < x1; x++) if (x >= 0 && x < OG_W) blend(band, px(x, y), col[0], col[1], col[2], a);
  }
}
function dot(band, cx, cy, r, col) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const cov = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      if (cov > 0 && y >= Y0 && y < Y0 + ROWS) blend(band, px(x, y), col[0], col[1], col[2], Math.round(cov * 255));
    }
  }
}

const LEFT = 88, MAXW = 690, RIGHT = 1112;

// خطوطِ کارتِ عدددار — همه‌چیز از همان خلاصه‌ای که کلاینت هم می‌سازد (quotedPaper در برابرِ exit وقتی توکنِ بی‌کوت هست)
export function exitCardLines(s) {
  const unk = s.unknownCount > 0 || s.partial === true;
  const lp = s.lostPct == null ? null : Math.max(0, s.lostPct);
  const lost = lp == null ? "" : lp < EXIT_LOST_NONE ? "Almost nothing would be lost on exit" : exitPct(lp) + " would be lost on exit";
  const lostCol = lp == null ? GRAY : lp < EXIT_GAP_MED ? GREEN : lp < EXIT_GAP_BIG ? AMBER : RED;
  const excl = s.unknownCount > 0
    ? "Excludes " + s.unknownCount + (s.partial ? "+" : "") + " token" + (s.unknownCount === 1 && !s.partial ? "" : "s") + " without a quote"
    : s.partial ? "Excludes some tokens without a quote" : "";
  return { strike: exitLostSome(lp), paper: exitMoney(unk ? s.quotedPaper : s.paper), exit: exitMoney(s.exit), lost, lostCol, excl, time: utcClock(s.at) };
}

/* ورودی: { addr, summary } یا { generic:true }. خروجی: Uint8Array PNG. */
export async function exitCardPng({ addr, summary, generic }) {
  const band = new Uint8Array(ROWS * ROW);
  band.set(BAND_BYTES, 0);
  band.set(BAND2_BYTES, BAND1_LEN);

  if (generic || !summary) {
    text(band, "B56", "Exit value", LEFT, 372, WHITE);
    text(band, "R34", "Check any Base wallet", LEFT, 424, GRAY);
    text(band, "R28", "What it would fetch if everything were sold now.", LEFT, 470, DIM);
  } else {
    const L = exitCardLines(summary);
    // ریتم (baseline): آدرسِ کوچک زیرِ نشان ۳۱۲ · On paper ۳۵۶ · If you sold now ۳۹۴ · عددِ بزرگ ۴۶۴ · درصد ۵۱۰ · یک خطِ ریزِ muted ۵۴۰
    // (پیلِ Base جزءِ TOP پخته است، پس آدرس فقط می‌تواند زیرِ wordmark بنشیند)
    text(band, "R20", shortAddr(String(addr).toLowerCase()), LEFT, 312, DIM);
    text(band, "R28", "On paper", LEFT, 356, GRAY);
    const px0 = LEFT + wid("R28", "On paper") + 16;
    const pStr = okChars("B31", L.paper) ? L.paper : "";
    text(band, "B31", pStr, px0, 356, DIM);
    const pw = wid("B31", pStr);
    if (L.strike) rect(band, px0 - 4, 345, px0 + pw + 4, 348, RED, 235);
    text(band, "R28", "If you sold now", LEFT, 394, GRAY);
    const big = L.exit;
    if (wid("B72", big) <= MAXW) text(band, "B72", big, LEFT - 3, 464, null, true);
    else text(band, "B56", big, LEFT, 464, null, true);
    if (L.lost) text(band, "B31", L.lost, LEFT, 510, L.lostCol);
    // یک خطِ muted: «Floor from live quotes · 09:41 UTC» و اگر هست «· excludes N tokens without a quote» («·» در اطلس نیست؛ می‌کشیمش)
    let mx = LEFT;
    const seg = (str) => { text(band, "R20", str, mx, 540, DIM); mx += wid("R20", str); };
    const dotSep = () => { dot(band, mx + 10, 534, 2, DIM); mx += 20; };
    seg("Floor from live quotes"); dotSep(); seg(L.time);
    if (L.excl) { dotSep(); seg(L.excl.charAt(0).toLowerCase() + L.excl.slice(1)); }
  }
  const url = "zaexa.com/exit";
  text(band, "B28", url, RIGHT - wid("B28", url), 590, GRAY);

  // ---- مونتاژِ PNG (همان IDAT#1 TOP + IDAT#2 stored + IDAT#3 پایین، با پایینِ تازه) ----
  const top = TOP_BYTES.Base;
  const bot = BOTTOM2_BYTES;
  const bandLen = band.length;
  const nBlocks = Math.ceil(bandLen / 65535);
  const idat1Len = 2 + top.length;
  const idat2Len = bandLen + nBlocks * 5;
  const idat3Len = bot.length + 4;
  const total = 8 + 25 + (12 + idat1Len) + (12 + idat2Len) + (12 + idat3Len) + 12;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(SIG, o); o += 8;
  put32(out, o, 13); out.set(TYPE("IHDR"), o + 4);
  put32(out, o + 8, OG_W); put32(out, o + 12, 630);
  out[o + 16] = 8; out[o + 17] = 2; out[o + 18] = 0; out[o + 19] = 0; out[o + 20] = 0;
  put32(out, o + 21, (crcUpdate(0xffffffff, out, o + 4, o + 21) ^ 0xffffffff) >>> 0);
  o += 25;
  put32(out, o, idat1Len); out.set(TYPE("IDAT"), o + 4);
  out[o + 8] = 0x78; out[o + 9] = 0x01;
  out.set(top, o + 10);
  put32(out, o + 8 + idat1Len, TOP.Base.crc);
  o += 12 + idat1Len;
  put32(out, o, idat2Len); out.set(TYPE("IDAT"), o + 4);
  let p = o + 8;
  for (let s = 0; s < bandLen; s += 65535) {
    const n = Math.min(65535, bandLen - s);
    out[p] = 0;
    out[p + 1] = n & 255; out[p + 2] = n >>> 8;
    out[p + 3] = ~n & 255; out[p + 4] = (~n >>> 8) & 255;
    out.set(band.subarray(s, s + n), p + 5);
    p += 5 + n;
  }
  put32(out, p, (crcUpdate(0xffffffff, out, o + 4, p) ^ 0xffffffff) >>> 0);
  o = p + 4;
  put32(out, o, idat3Len); out.set(TYPE("IDAT"), o + 4);
  out.set(bot, o + 8);
  const adl = adlerCombine(adlerCombine(TOP.Base.adler, adler32(band), bandLen), BOTTOM2_ADLER, BOTTOM2_LEN);
  put32(out, o + 8 + bot.length, adl);
  const crc3 = crcUpdate(BOTTOM2_CRC_STATE, out, o + 8 + bot.length, o + 12 + bot.length);
  put32(out, o + 12 + bot.length, (crc3 ^ 0xffffffff) >>> 0);
  o += 12 + idat3Len;
  put32(out, o, 0); out.set(TYPE("IEND"), o + 4);
  put32(out, o + 8, 0xae426082);
  return out;
}
