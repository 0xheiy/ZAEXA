/* =====================================================================
   Keccak-256 — خودکفا و بدون هیچ وابستگی
   =====================================================================
   Workers کِکاک۲۵۶ ندارد و این ماژول فقط برای محاسبه‌ی آدرسِ CREATE2 و
   سلکتورها لازم شد (verdict.js: clMetaPoolAddr). پدینگِ *اصلیِ* Keccak
   (بایتِ 0x01) است، نه SHA3-256 (0x06) — اتریوم از همان اول استفاده می‌کند
   و این دو هش برای یک ورودی کاملاً فرق دارند. worker/test.mjs با بردارهای
   شناخته‌شده، یک ورودیِ چندبلوکی و ethers (فقط در تست، به‌عنوانِ اوراکل)
   این را می‌سنجد؛ ethers هرگز از این‌جا ایمپورت نمی‌شود.
   ===================================================================== */

const MASK = (1n << 64n) - 1n;
const RATE = 136; // بایت — برای خروجیِ ۲۵۶ بیتی (۱۶۰۰ - ۲×۲۵۶)/۸

// ثابت‌های دور — از LFSR ساخته می‌شوند تا جدولِ دستیِ بی‌تست نداشته باشیم
const RC = (() => {
  const out = [];
  let r = 1;
  for (let i = 0; i < 24; i++) {
    let c = 0n;
    for (let j = 0; j < 7; j++) {
      if (r & 1) c |= 1n << BigInt((1 << j) - 1);
      r = (r & 0x80) ? ((r << 1) ^ 0x171) & 0xff : (r << 1) & 0xff;
    }
    out.push(c);
  }
  return out;
})();

// مقدارِ چرخش و جایگشتِ ρ/π
const ROT = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

function rotl(x, n) {
  const k = BigInt(n);
  return ((x << k) | (x >> (64n - k))) & MASK;
}

function keccakF(s) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) bc[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const t = bc[(x + 4) % 5] ^ rotl(bc[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= t;
    }
    let t = s[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i];
      const tmp = s[j];
      s[j] = rotl(t, ROT[i]);
      t = tmp;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) bc[x] = s[y + x];
      for (let x = 0; x < 5; x++) s[y + x] = bc[x] ^ ((~bc[(x + 1) % 5] & MASK) & bc[(x + 2) % 5]);
    }
    s[0] ^= RC[round];
  }
}

export function keccak256(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] ^= 0x01; // پدینگِ اصلیِ Keccak — نه 0x06ِ SHA3
  padded[padded.length - 1] ^= 0x80;

  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((s[i] >> BigInt(8 * b)) & 0xffn);
  }
  return out;
}

export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, "");
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error("bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s; // بدونِ پیشوندِ 0x
}

export function utf8Bytes(str) {
  return new TextEncoder().encode(String(str));
}
