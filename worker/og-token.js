/* =====================================================================
   کارت پیش‌نمایشِ مخصوصِ هر توکن — رندر داخل خودِ Worker، بدون wasm
   =====================================================================
   چرا ممکن است (برخلافِ satori/resvg که ~۱MB باندل و بیش از ۱۰ms CPU
   می‌خواهند): پس‌زمینه از قبل ساخته و فشرده شده (scripts/og/build_cards.py
   → worker/og-token-data.js) و فقط یک نوار ۱۸۴ردیفی از تصویر در زمان اجرا
   تغییر می‌کند. PNG نهایی از سه تکه سرِ هم می‌شود:
     IDAT#1 = TOP پیش‌فشرده (CRC از پیش حساب‌شده)
     IDAT#2 = BAND به‌صورت بلوک‌های stored (بدون فشرده‌سازی) + CRC زمان‌اجرا
     IDAT#3 = BOTTOM پیش‌فشرده + adler32ِ کلِ جریان (با adler32_combine)
   متن از اطلس گلیف (Liberation Sans، SIL OFL 1.1) می‌آید؛ بدون کرنینگ —
   فقط جمعِ advanceها.

   ⚠️ بودجه‌ی CPU: پلن رایگان ~۱۰ms در هر درخواست. worker/test.mjs بخشِ
   [og token cpu] میانه‌ی رندر را می‌سنجد و بالای ۵ms شکست می‌خورد.
   ===================================================================== */

import {
  TOP, BAND_RAW, BAND_Y0, BAND_ROWS, BOTTOM_Z, BOTTOM_ADLER, BOTTOM_LEN, BOTTOM_CRC_STATE,
  ATLAS_RAW, ATLAS_META, ATLAS_INDEX, OG_W, OG_H,
} from "./og-token-data.js";
import { decodeJpeg } from "./vendor/jpeg-decode.js";

const ROW = OG_W * 3 + 1; // ۳۶۰۱ بایت: فیلتر + RGB

/* ---------- ابزارهای بایتی ---------- */
function b64(s) {
  // مسیرِ بومی اگر باشد؛ وگرنه atob + حلقه‌ی تنگ
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* CRC-32، slicing-by-4 */
const CT = (() => {
  const t = new Uint32Array(256 * 4);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 4; k++) {
      c = t[c & 255] ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
})();

/* حالتِ داخلیِ CRC را روی buf[a..b) جلو می‌برد (بدون xor نهایی) */
function crcUpdate(state, buf, a, b) {
  let c = state;
  let i = a;
  for (; i + 4 <= b; i += 4) {
    c ^= buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
    c = CT[768 + (c & 255)] ^ CT[512 + ((c >>> 8) & 255)] ^ CT[256 + ((c >>> 16) & 255)] ^ CT[c >>> 24];
  }
  for (; i < b; i++) c = CT[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return c >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  const n = buf.length;
  for (let i = 0; i < n;) {
    const end = Math.min(i + 5552, n);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/* adler32_combine استانداردِ zlib */
function adlerCombine(a1, a2, len2) {
  const BASE = 65521;
  const rem = len2 % BASE;
  let s1 = a1 & 0xffff;
  let s2 = (rem * s1) % BASE;
  s1 += (a2 & 0xffff) + BASE - 1;
  s2 += ((a1 >>> 16) & 0xffff) + ((a2 >>> 16) & 0xffff) + BASE - rem;
  if (s1 >= BASE) s1 -= BASE;
  if (s1 >= BASE) s1 -= BASE;
  if (s2 >= BASE << 1) s2 -= BASE << 1;
  if (s2 >= BASE) s2 -= BASE;
  return ((s1 | (s2 << 16)) >>> 0);
}

/* ---------- یک‌بار در هر isolate ---------- */
const CHARS = ATLAS_META.chars;
const CHAR_IDX = new Map();
for (let i = 0; i < CHARS.length; i++) CHAR_IDX.set(CHARS[i], i);

/* ⚠️ همه‌ی decodeهای base64 در *دامنه‌ی سراسریِ ماژول* انجام می‌شوند، نه
   داخلِ درخواست: زمانِ راه‌اندازی از سقفِ CPUِ هر درخواست (~۱۰ms در پلن
   رایگان) حساب نمی‌شود، ولی اولین درخواستِ یک isolate را سنگین می‌کرد. */
const BAND_BYTES = b64(BAND_RAW);
const ATLAS_BYTES = b64(ATLAS_RAW);
const BOTTOM_BYTES = b64(BOTTOM_Z);
const TOP_BYTES = { Base: b64(TOP.Base.z), Solana: b64(TOP.Solana.z) };
function init() { return [BAND_BYTES, ATLAS_BYTES]; }

/* آیا هر نویسه‌ی رشته در اطلس هست؟ */
export function renderable(str) {
  if (typeof str !== "string") return false;
  for (const ch of str) if (!CHAR_IDX.has(ch)) return false;
  return true;
}

function width(key, str) {
  const rows = ATLAS_INDEX[key];
  let w = 0;
  for (const ch of str) w += rows[CHAR_IDX.get(ch)][0];
  return w;
}

/* رشته را تا جایی که با «…» در maxW جا شود کوتاه می‌کند */
function fit(key, str, maxW) {
  if (width(key, str) <= maxW) return str;
  const chars = Array.from(str);
  while (chars.length && width(key, chars.join("") + "…") > maxW) chars.pop();
  return chars.length ? chars.join("") + "…" : width(key, "…") <= maxW ? "…" : "";
}

/* ---------- رندر روی نوار ---------- */
const SAT = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

function blendPx(band, p, r, g, b, a) { // a ∈ [0,255] صحیح
  if (a <= 0) return;
  if (a >= 255) { band[p] = r; band[p + 1] = g; band[p + 2] = b; return; }
  const ia = 255 - a;
  band[p] = ((band[p] * ia + r * a + 127) / 255) | 0;
  band[p + 1] = ((band[p + 1] * ia + g * a + 127) / 255) | 0;
  band[p + 2] = ((band[p + 2] * ia + b * a + 127) / 255) | 0;
}

function pxIndex(x, y) { return (y - BAND_Y0) * ROW + 1 + x * 3; }

function drawText(band, atlas, key, str, x, base, col, alphaMul) {
  const rows = ATLAS_INDEX[key];
  const am = alphaMul == null ? 255 : alphaMul;
  let pen = x;
  for (const ch of str) {
    const g = rows[CHAR_IDX.get(ch)];
    const [adv, dx, dy, w, h, off] = g;
    if (w > 0) {
      const gx = Math.round(pen) + dx;
      const gy = base + dy;
      for (let j = 0; j < h; j++) {
        const y = gy + j;
        if (y < BAND_Y0 || y >= BAND_Y0 + BAND_ROWS) continue;
        for (let i = 0; i < w; i++) {
          const xx = gx + i;
          if (xx < 0 || xx >= OG_W) continue;
          const cov = atlas[off + j * w + i];
          if (!cov) continue;
          blendPx(band, pxIndex(xx, y), col[0], col[1], col[2], am === 255 ? cov : ((cov * am + 127) / 255) | 0);
        }
      }
    }
    pen += adv;
  }
}

/* قرصِ کاملاً گردِ stadium با پوششِ سطحیِ ضدّلبه‌پر (فاصله‌ی علامت‌دار) */
function stadiumCov(px, py, x0, y0, x1, y1, inset) {
  const r = (y1 - y0) / 2 - inset;
  const cy = (y0 + y1) / 2;
  const ax = x0 + (y1 - y0) / 2, bx = x1 - (y1 - y0) / 2;
  const cx = px < ax ? ax : px > bx ? bx : px;
  const d = Math.hypot(px - cx, py - cy) - r;
  return SAT(0.5 - d);
}

function drawPill(band, x0, y0, x1, y1, col) {
  for (let y = y0 - 1; y <= y1; y++) {
    for (let x = x0 - 1; x <= x1; x++) {
      if (x < 0 || x >= OG_W || y < BAND_Y0 || y >= BAND_Y0 + BAND_ROWS) continue;
      const outer = stadiumCov(x + 0.5, y + 0.5, x0, y0, x1, y1, 0);
      if (outer <= 0) continue;
      const inner = stadiumCov(x + 0.5, y + 0.5, x0, y0, x1, y1, 1);
      const a = Math.round(inner * 28 + (outer - inner) * 110);
      blendPx(band, pxIndex(x, y), col[0], col[1], col[2], a);
    }
  }
}

function drawDot(band, cx, cy, r, col) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const cov = SAT(r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      if (cov > 0) blendPx(band, pxIndex(x, y), col[0], col[1], col[2], Math.round(cov * 255));
    }
  }
}

const AV = 68, AV_X = 88, AV_Y = 300;
const C0 = [34, 239, 246], C1 = [197, 108, 245];

function drawAvatar(band, atlas, symbol, logo) {
  const haveLogo = logo && logo.length === AV * AV * 3;
  for (let j = 0; j < AV; j++) {
    for (let i = 0; i < AV; i++) {
      const cov = SAT(AV / 2 + 0.5 - Math.hypot(i + 0.5 - AV / 2, j + 0.5 - AV / 2));
      if (cov <= 0) continue;
      const p = pxIndex(AV_X + i, AV_Y + j);
      if (haveLogo) {
        const q = (j * AV + i) * 3;
        blendPx(band, p, logo[q], logo[q + 1], logo[q + 2], Math.round(cov * 255));
      } else {
        const t = (i + 0.5) / AV;
        blendPx(band, p, Math.round(C0[0] + (C1[0] - C0[0]) * t), Math.round(C0[1] + (C1[1] - C0[1]) * t),
          Math.round(C0[2] + (C1[2] - C0[2]) * t), Math.round(cov * 255));
      }
    }
  }
  if (!haveLogo) {
    const ch = String(symbol || "").charAt(0).toUpperCase();
    if (ch && renderable(ch)) {
      const adv = width("B31", ch);
      drawText(band, atlas, "B31", ch, AV_X + AV / 2 - adv / 2, Math.round(AV_Y + ATLAS_META.letterBase), [11, 13, 19]);
    }
  }
}

const WHITE = [242, 244, 250], GRAY = [154, 162, 182];
const POS = [52, 211, 153], NEG = [248, 113, 113];
const ROW1_MAX = 900;

/* ---------- PNG ---------- */
const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
function put32(buf, o, v) {
  buf[o] = v >>> 24; buf[o + 1] = (v >>> 16) & 255; buf[o + 2] = (v >>> 8) & 255; buf[o + 3] = v & 255;
}
const TYPE = (s) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];

/* ۲۶ اکتبر: علتِ اثبات‌شده‌ی nosell همان واژه‌های ربات تلگرام (worker/tg.js) — فقط دو علتِ بسته؛ هر چیزِ دیگر = متنِ قدیم */
export function ogVerdictLabel(verdict, cause) {
  if (verdict === "sell") return "A sell route was quoted";
  if (cause === "empty-pool") return "No sell route quoted: pool is empty";
  if (cause === "sell-reverts") return "No sell route quoted: the sell reverts";
  return "No sell route quoted";
}
export async function tokenCardPng({ symbol, name, liquidity, vol24, verdict, chain, logo, cause }) {
  const [bandSrc, atlas] = init();
  const ch = chain === "Solana" ? "Solana" : "Base";
  const band = bandSrc.slice(); // کپیِ تازه برای هر درخواست

  // ردیف ۱
  let sym = renderable(symbol) && symbol ? symbol : "";
  sym = fit("B56", sym, 700);
  drawAvatar(band, atlas, sym, logo);
  const symW = width("B56", sym);
  drawText(band, atlas, "B56", sym, 176, 352, WHITE);
  if (typeof name === "string" && name && renderable(name) && name.toLowerCase() !== String(symbol).toLowerCase()) {
    const nx = 176 + symW + 18;
    const nm = fit("R34", name, ROW1_MAX - nx);
    if (nm) drawText(band, atlas, "R34", nm, nx, 352, GRAY);
  }
  // ردیف ۲
  let x = 88;
  for (const [lab, val] of [["Liquidity", liquidity], ["Vol 24h", vol24]]) {
    if (!val || !renderable(val)) continue;
    drawText(band, atlas, "R28", lab, x, 410, GRAY);
    x += width("R28", lab) + 10;
    drawText(band, atlas, "B28", val, x, 410, WHITE);
    x += width("B28", val) + 40;
  }
  // ردیف ۳ — فقط sell / nosell؛ nosellِ سولانا هرگز
  if (verdict === "sell" || (verdict === "nosell" && ch !== "Solana")) {
    const sell = verdict === "sell";
    const msg = ogVerdictLabel(verdict, ch === "Solana" ? undefined : cause);
    const col = sell ? POS : NEG;
    const x1 = Math.round(88 + width("B24", msg) + 64);
    drawPill(band, 88, 430, x1, 472, col);
    drawDot(band, 112, 451, 6, col);
    drawText(band, atlas, "B24", msg, 128, 460, col);
  }

  // مونتاژ
  const top = TOP_BYTES[ch];
  const bot = BOTTOM_BYTES;
  const bandLen = band.length;
  const nBlocks = Math.ceil(bandLen / 65535);
  const idat1Len = 2 + top.length;
  const idat2Len = bandLen + nBlocks * 5;
  const idat3Len = bot.length + 4;
  const total = 8 + 25 + (12 + idat1Len) + (12 + idat2Len) + (12 + idat3Len) + 12;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(SIG, o); o += 8;
  // IHDR
  put32(out, o, 13); out.set(TYPE("IHDR"), o + 4);
  put32(out, o + 8, OG_W); put32(out, o + 12, OG_H);
  out[o + 16] = 8; out[o + 17] = 2; out[o + 18] = 0; out[o + 19] = 0; out[o + 20] = 0;
  put32(out, o + 21, (crcUpdate(0xffffffff, out, o + 4, o + 21) ^ 0xffffffff) >>> 0);
  o += 25;
  // IDAT#1
  put32(out, o, idat1Len); out.set(TYPE("IDAT"), o + 4);
  out[o + 8] = 0x78; out[o + 9] = 0x01;
  out.set(top, o + 10);
  put32(out, o + 8 + idat1Len, TOP[ch].crc);
  o += 12 + idat1Len;
  // IDAT#2 — بلوک‌های stored
  put32(out, o, idat2Len); out.set(TYPE("IDAT"), o + 4);
  const d2 = o + 8;
  let p = d2;
  for (let s = 0; s < bandLen; s += 65535) {
    const n = Math.min(65535, bandLen - s);
    out[p] = 0; // BFINAL=0, BTYPE=00
    out[p + 1] = n & 255; out[p + 2] = n >>> 8;
    out[p + 3] = ~n & 255; out[p + 4] = (~n >>> 8) & 255;
    out.set(band.subarray(s, s + n), p + 5);
    p += 5 + n;
  }
  put32(out, p, (crcUpdate(0xffffffff, out, o + 4, p) ^ 0xffffffff) >>> 0);
  o = p + 4;
  // IDAT#3
  put32(out, o, idat3Len); out.set(TYPE("IDAT"), o + 4);
  out.set(bot, o + 8);
  const adl = adlerCombine(adlerCombine(TOP[ch].adler, adler32(band), bandLen), BOTTOM_ADLER, BOTTOM_LEN);
  put32(out, o + 8 + bot.length, adl);
  const crc3 = crcUpdate(BOTTOM_CRC_STATE, out, o + 8 + bot.length, o + 12 + bot.length);
  put32(out, o + 12 + bot.length, (crc3 ^ 0xffffffff) >>> 0);
  o += 12 + idat3Len;
  // IEND
  put32(out, o, 0); out.set(TYPE("IEND"), o + 4);
  put32(out, o + 8, 0xae426082);
  return out;
}

/* ---------- لوگو: JPEG ۶۸×۶۸ که کلادفلر مستقیم در همین اندازه می‌دهد ----------
   بدونِ بازتغییراندازه در Worker. هر اندازه‌ی دیگر → Error("size")،
   خطای رمزگشایی → Error("decode"); کالر آن را به هدر می‌برد. */
export function logoFromJpeg(bytes) {
  let img;
  try {
    img = decodeJpeg(bytes, { maxDim: 160 });
  } catch (e) {
    throw new Error("decode");
  }
  if (img.width !== AV || img.height !== AV) throw new Error("size");
  return img.data;
}

/* گرم‌کردنِ JIT در دامنه‌ی سراسری: یک رندرِ آزمایشی هنگامِ راه‌اندازی (بدنه‌ی
   tokenCardPng همگام است)، تا اولین درخواستِ واقعیِ isolate با کدِ داغ
   اجرا شود و از سقفِ CPUِ درخواست رد نشود. خطا اینجا نباید ماژول را بشکند. */
try {
  tokenCardPng({ symbol: "WARM", name: "Warm Up", liquidity: "$1.0K", vol24: "$1.0K", verdict: "sell", chain: "Solana", logo: null })
    .catch(() => {});
} catch (e) { /* مهم نیست */ }
