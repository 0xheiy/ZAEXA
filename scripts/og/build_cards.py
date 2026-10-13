#!/usr/bin/env python3
"""ساخت کارت‌های پیش‌نمایش (OG) — worker/og-image.js و worker/og-token-data.js

اجرا (از ریشه‌ی مخزن):   python3 scripts/og/build_cards.py
وابستگی‌ها: numpy, Pillow, scipy.
ورودی فقط scripts/og/og_v4_source.png است؛ خروجی قطعی است (بذرهای ثابت).

فونت: Liberation Sans (Regular/Bold) — مجوز SIL Open Font License 1.1، پس
گنجاندنِ شکلِ حروف (اطلس گلیف) داخل کد آزاد است.

خروجی ۱: worker/og-image.js — کارت عمومی v5 = همان v4 با *فقط* پس‌زمینه‌ی
  تازه (گرید برداشته، درخششِ تیل/بنفشِ بیرونِ کادر، دیتر).
خروجی ۲: worker/og-token-data.js — هرچه رندرِ زمان‌اجرای worker/og-token.js
  لازم دارد: پس‌زمینه‌ی هر زنجیره به سه تکه (TOP / BAND / BOTTOM) و اطلس گلیف.
"""
import base64
import hashlib
import json
import os
import struct
import sys
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import binary_dilation, gaussian_filter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "scripts", "og", "og_v4_source.png")
OUT_IMG = os.path.join(ROOT, "worker", "og-image.js")
OUT_DATA = os.path.join(ROOT, "worker", "og-token-data.js")
FD = "/usr/share/fonts/truetype/liberation/"
B = FD + "LiberationSans-Bold.ttf"
R = FD + "LiberationSans-Regular.ttf"
S = 4  # ابرنمونه‌برداری برای قرص‌ها

PURPLE_A, PURPLE_SIGMA = 0.62, 260
TEAL_A, TEAL_SIGMA = 0.42, 250
MAX_GENERIC = 450 * 1024
BAND_Y0, BAND_Y1 = 296, 480  # ردیف‌های BAND: [296, 480)

DITHER_MODE = os.environ.get("OG_DITHER", "tri")  # tri | bayer

o = np.asarray(Image.open(SRC).convert("RGB")).astype(float)
H, W, _ = o.shape
assert (W, H) == (1200, 630)
base = np.array([11, 13, 19], float)

# ---- ۱) پاک‌کردنِ گرید (کدِ مرجع، بدون تغییر) ----
G = o.copy()
for y in range(60, H - 1, 60):
    av = (o[y - 1] + o[y + 1]) / 2
    ok = (np.abs(o[y] - av).sum(-1) < 24)[:, None]
    G[y] = np.where(ok, av, o[y])
for x in range(60, W - 1, 60):
    av = (G[:, x - 1] + G[:, x + 1]) / 2
    ok = (np.abs(G[:, x] - av).sum(-1) < 24)[:, None]
    G[:, x] = np.where(ok, av, G[:, x])


def blur3(a, s):
    return np.stack([gaussian_filter(a[..., c], s) for c in range(3)], -1)


# ---- ۲) پس‌زمینه‌ی نرم S2 با کنار گذاشتنِ پیش‌زمینه ----
S1 = blur3(G, 12)
fg = np.abs(G - S1).sum(-1) > 18
fg = binary_dilation(fg, iterations=5)
w = (~fg).astype(float)
num = blur3(G * w[..., None], 25)
den = gaussian_filter(w, 25)[..., None]
S2 = num / np.maximum(den, 1e-3)

# ---- ۳) پس‌زمینه‌ی تازه ----
yy, xx = np.mgrid[0:H, 0:W].astype(float)


def glow(cx, cy, col, amp, sigma):
    d2 = (xx - cx) ** 2 + (yy - cy) ** 2
    return np.array(col, float) * amp * np.exp(-d2 / (2 * sigma ** 2))[..., None]


teal = glow(-170, -150, (34, 239, 246), TEAL_A, TEAL_SIGMA)
purple = glow(1390, 820, (197, 108, 245), PURPLE_A, PURPLE_SIGMA)
B1 = base + teal + purple
fore = G - S2

# دیتر فقط جایی که سهمِ درخشش > ۰٫۵ است
dmask = ((B1 - base).sum(-1) > 0.5)[..., None]
if DITHER_MODE == "tri":
    rng = np.random.default_rng(7)
    noise = rng.random((H, W, 1)) - rng.random((H, W, 1))
else:
    # ماتریس بایرِ ۸×۸، هم‌دامنه با نویزِ مثلثی (±۱)
    bm = np.array([[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
                   [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
                   [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
                   [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]], float)
    tile = np.tile(bm, (H // 8 + 1, W // 8 + 1))[:H, :W]
    noise = ((tile + 0.5) / 64 * 2 - 1)[..., None]
noise = np.where(dmask, noise, 0.0)


def bg_array(f):
    return np.clip(np.round(B1 + f + noise), 0, 255).astype(np.uint8)


# ---- قرص‌ها (همان text_layer مرجع) ----
def text_layer(size, draws):
    Wd, Hd = size
    im = Image.new("RGBA", (Wd * S, Hd * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for kind, args in draws:
        if kind == "text":
            (x, y), s, font, px, col = args
            d.text((x * S, y * S), s, font=ImageFont.truetype(font, px * S), fill=col, anchor="ls")
        elif kind == "pill":
            (x0, y0, x1, y1), fill, outline = args
            d.rounded_rectangle((x0 * S, y0 * S, x1 * S, y1 * S), radius=(y1 - y0) * S // 2,
                                fill=fill, outline=outline, width=S)
        elif kind == "dot":
            (cx, cy, r), col = args
            d.ellipse(((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S), fill=col)
    return im.resize((Wd, Hd), Image.LANCZOS)


def tw(s, font, px):
    return ImageFont.truetype(font, px).getlength(s)


def token_bg(chain):
    f = fore.copy()
    f[296:357, 80:801] = 0
    f[357:453, 80:701] = 0
    if chain != "Base":
        f[52:119, 930:1136] = 0
    img = Image.fromarray(bg_array(f)).convert("RGBA")
    if chain != "Base":
        wd = tw(chain, R, 20) + 66
        x1 = 1111
        x0 = x1 - wd
        dr = [
            ("pill", ((x0, 61, x1, 109), (17, 20, 27, 255), (44, 48, 60, 255))),
            ("dot", ((x0 + 28, 85, 5), (153, 69, 255, 255))),
            ("text", ((x0 + 45, 92), chain, R, 20, (174, 182, 200, 255))),
        ]
        img.alpha_composite(text_layer(img.size, dr))
    return np.asarray(img.convert("RGB"))


# ---- کمکی‌های PNG / base64 ----
def chunks_js(name, data, comment=""):
    b = base64.b64encode(data).decode()
    parts = [b[i:i + 96] for i in range(0, len(b), 96)]
    body = ",\n".join('  "%s"' % p for p in parts)
    return "%sconst %s = [\n%s,\n].join(\"\");\n" % (comment, name, body)


def scan(arr):
    """ردیف‌های RGB → اسکن‌لاین‌های PNG با فیلتر ۰."""
    h = arr.shape[0]
    out = np.zeros((h, 1 + arr.shape[1] * 3), np.uint8)
    out[:, 1:] = arr.reshape(h, -1)
    return out.tobytes()


# =====================================================================
# خروجی ۱ — کارت عمومی v5
# =====================================================================
generic = bg_array(fore)
buf = __import__("io").BytesIO()
Image.fromarray(generic).save(buf, "PNG", optimize=True)
png = buf.getvalue()
tri_size = len(png)
if DITHER_MODE == "tri" and tri_size > MAX_GENERIC:
    print("generic PNG with triangular dither: %d bytes > %d, switching to Bayer" % (tri_size, MAX_GENERIC))
    os.environ["OG_DITHER"] = "bayer"
    os.execv(sys.executable, [sys.executable] + sys.argv)
print("generic PNG (%s dither): %d bytes" % (DITHER_MODE, len(png)))
etag = '"%s"' % hashlib.sha256(png).hexdigest()[:16]

HEAD_IMG = """/* =====================================================================
   تصویر کارت پیش‌نمایش — یک PNG ۱۲۰۰×۶۳۰، داخل خودِ Worker
   =====================================================================
   ⚠️ این فایل ساخته‌ی دست نیست: `python3 scripts/og/build_cards.py` آن را
   تولید می‌کند (ورودی: scripts/og/og_v4_source.png). v5: همان کارت v4 با
   پس‌زمینه‌ی تازه — گرید برداشته، درخششِ تیل و بنفشِ بیرون‌ازکادر، دیتر.

   منبع: ساخته‌شده از خودِ نشان و گرادیان `web/index.html`
         (`#22EFF6 → #C56CF5`) روی سطح تم تیره‌ی همان سایت.

   ⚠️ چرا base64 داخل کد و نه یک فایل کنار index.html:
   خط Build command که تعیین می‌کند چه فایل‌هایی در `_site` منتشر شوند
   **فقط در پنل کلادفلر است، نه در مخزن**. هر فایل تازه‌ای آنجا یعنی یک
   تغییر دستیِ نسخه‌نخورده که اگر یادت برود، og:image بی‌صدا ۴۰۴ می‌شود و
   کارت خالی می‌ماند — و کسی خبردار نمی‌شود چون سایت سالم است. این‌طوری
   تصویر با خودِ کد جابه‌جا می‌شود و انتشارش اتمیک است.

   کارت مخصوصِ هر توکن جداست: worker/og-token.js آن را در زمان اجرا از
   روی پس‌زمینه‌ی پیش‌فشرده و اطلس گلیف می‌سازد (worker/og-token-data.js).

   اگر تصویر عوض شد: `OG_IMAGE_V` در og.js را جلو ببر، وگرنه ربات‌ها
   ماه‌ها نسخه‌ی قدیمی را از کش خودشان نشان می‌دهند.
   ===================================================================== */

"""
TAIL_IMG = """
export const OG_PNG_ETAG = '%s';

/* یک بار در راه‌اندازی ماژول باز می‌شود، نه در هر درخواست. */
let bytes = null;
function png() {
  if (bytes) return bytes;
  const bin = atob(OG_PNG_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  bytes = out;
  return out;
}

export function ogImageResponse(request) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  /* ربات‌ها همین تصویر را بارها می‌خواهند؛ ETag یعنی دفعه‌ی بعد ۳۰۴.
     عمر بلند بی‌خطر است چون نسخه در خودِ آدرس است (`?v=`). */
  if (request.headers.get("if-none-match") === OG_PNG_ETAG)
    return new Response(null, { status: 304, headers: { etag: OG_PNG_ETAG } });
  const body = request.method === "HEAD" ? null : png();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(png().length),
      "cache-control": "public, max-age=31536000, immutable",
      etag: OG_PNG_ETAG,
      "access-control-allow-origin": "*",
    },
  });
}
""" % etag.replace("'", "")
with open(OUT_IMG, "w") as fh:
    fh.write(HEAD_IMG + chunks_js("OG_PNG_B64", png) + TAIL_IMG)

# =====================================================================
# خروجی ۲ — داده‌ی کارت توکن
# =====================================================================
bgs = {c: token_bg(c) for c in ("Base", "Solana")}


def deflate_part(raw, final):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    d = c.compress(raw) + c.flush(zlib.Z_FINISH if final else zlib.Z_FULL_FLUSH)
    return d


def crc_state(data, seed=0):
    # حالتِ داخلیِ CRC (پیش از xor نهایی)؛ زمان‌اجرا با چند بایت ادامه می‌دهد
    return (zlib.crc32(data, seed) ^ 0xFFFFFFFF) & 0xFFFFFFFF


tops, bottoms, bands = {}, {}, {}
for ch, arr in bgs.items():
    tops[ch] = scan(arr[:BAND_Y0])
    bands[ch] = scan(arr[BAND_Y0:BAND_Y1])
    bottoms[ch] = scan(arr[BAND_Y1:])
assert bands["Base"] == bands["Solana"], "BAND differs between chains"
assert bottoms["Base"] == bottoms["Solana"], "BOTTOM differs between chains"
band_raw = bands["Base"]
bottom_raw = bottoms["Base"]
assert len(band_raw) == (BAND_Y1 - BAND_Y0) * 3601

top_d, top_crc, top_adler, top_len = {}, {}, {}, {}
for ch in tops:
    d = deflate_part(tops[ch], False)
    top_d[ch] = d
    # IDAT#1 = 78 01 + TOP
    top_crc[ch] = zlib.crc32(b"IDAT" + b"\x78\x01" + d) & 0xFFFFFFFF
    top_adler[ch] = zlib.adler32(tops[ch]) & 0xFFFFFFFF
    top_len[ch] = len(tops[ch])
    assert d[-4:] == b"\x00\x00\xff\xff", "TOP is not byte-aligned"
bot_d = deflate_part(bottom_raw, True)
bot_adler = zlib.adler32(bottom_raw) & 0xFFFFFFFF
bot_state = crc_state(bot_d, zlib.crc32(b"IDAT"))  # حالت پس از IDAT+BOTTOM

# ---- اطلس گلیف ----
CHARS = [chr(c) for c in range(0x20, 0x7F)] + ["…"]
PAIRS = [("B56", B, 56), ("R34", R, 34), ("R28", R, 28), ("B28", B, 28), ("B24", B, 24), ("B31", B, 31)]
blob = bytearray()
index = {}
for key, path, px in PAIRS:
    font = ImageFont.truetype(path, px)
    rows = []
    for ch in CHARS:
        adv = round(font.getlength(ch), 4)
        x0, y0, x1, y1 = font.getbbox(ch, anchor="ls")
        wd, ht = x1 - x0, y1 - y0
        off = len(blob)
        if wd > 0 and ht > 0:
            im = Image.new("L", (wd, ht), 0)
            ImageDraw.Draw(im).text((-x0, -y0), ch, font=font, fill=255, anchor="ls")
            blob += im.tobytes()
        else:
            wd = ht = 0
        rows.append([adv, x0, y0, wd, ht, off])
    index[key] = rows
asc, desc = ImageFont.truetype(B, 31).getmetrics()
meta = {"chars": "".join(CHARS), "letterBase": round(34 + (asc - desc) / 2, 3)}
atlas_raw = bytes(blob)

HEAD_DATA = """/* =====================================================================
   داده‌ی رندرِ کارت توکن — ساخته‌ی ماشین، دست نزن
   =====================================================================
   تولید: `python3 scripts/og/build_cards.py` (scripts/og/build_cards.py).
   خواننده: worker/og-token.js.

   TOP/BOTTOM: دیفلیتِ خامِ پس‌زمینه (TOP با Z_FULL_FLUSH بایت‌تراز، BOTTOM
   با Z_FINISH) — مستقیم داخل IDAT می‌نشینند و CRC شان از پیش حساب شده.
   BAND: ردیف‌های ۲۹۶ تا ۴۷۹ (۱۸۴ ردیف × ۳۶۰۱ بایت اسکن‌لاینِ خام)، بدونِ فشرده‌سازی
   (تا زمان اجرا هیچ inflate‌ای لازم نباشد؛ فقط یک decodeِ base64 در هر isolate).
   اطلس (او هم خام): فونت Liberation Sans (SIL OFL 1.1)، آلفای ۸بیتی در اندازه‌ی ۱×،
   بدون کرنینگ (فقط جمعِ advanceها).
   ===================================================================== */

"""
out = [HEAD_DATA]
out.append("export const OG_W = 1200;\nexport const OG_H = 630;\nexport const BAND_Y0 = %d;\nexport const BAND_ROWS = %d;\n" % (BAND_Y0, BAND_Y1 - BAND_Y0))
out.append(chunks_js("BAND_B64", band_raw))
out.append("export const BAND_RAW = BAND_B64;\n")
out.append(chunks_js("BOTTOM_B64", bot_d))
out.append("export const BOTTOM_Z = BOTTOM_B64;\n")
out.append("export const BOTTOM_ADLER = %d;\nexport const BOTTOM_LEN = %d;\nexport const BOTTOM_CRC_STATE = %d;\n" % (bot_adler, len(bottom_raw), bot_state))
for ch in ("Base", "Solana"):
    out.append(chunks_js("TOP_%s_B64" % ch.upper(), top_d[ch]))
out.append("export const TOP = {\n")
for ch in ("Base", "Solana"):
    out.append('  %s: { z: TOP_%s_B64, adler: %d, len: %d, crc: %d },\n' % (ch, ch.upper(), top_adler[ch], top_len[ch], top_crc[ch]))
out.append("};\n")
out.append(chunks_js("ATLAS_B64", atlas_raw))
out.append("export const ATLAS_RAW = ATLAS_B64;\n")
out.append("export const ATLAS_META = %s;\n" % json.dumps(meta, ensure_ascii=True))
out.append("// هر ردیف: [advance, dx, dy, w, h, offset] — به ترتیبِ ATLAS_META.chars\n")
out.append("export const ATLAS_INDEX = %s;\n" % json.dumps(index, separators=(",", ":")))
with open(OUT_DATA, "w") as fh:
    fh.write("".join(out))
print("og-token-data.js: %d bytes; TOP base/solana %d/%d, BAND %d, BOTTOM %d, atlas %d" % (
    os.path.getsize(OUT_DATA), len(top_d["Base"]), len(top_d["Solana"]), len(band_raw), len(bot_d), len(atlas_raw)))
