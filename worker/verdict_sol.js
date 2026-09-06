/* =====================================================================
   آیا رفت‌وبرگشتِ خرید+فروش یک توکنِ سولانا، فقط شبیه‌سازی‌شده، جواب می‌دهد؟
   =====================================================================
   این پورتِ همان چیزی است که /home/claude/spike/solana_roundtrip.mjs روی
   mainnet واقعی اندازه گرفت: با simulateTransaction (sigVerify:false +
   replaceRecentBlockhash:true) هیچ امضایی لازم نیست، پس هر آدرسی می‌تواند
   فی‌پیر باشد — به شرطِ آنکه واقعاً SOL داشته باشد، چون سولانا برخلافِ
   eth_call هیچ state override‌ای ندارد (accounts در simulateTransaction
   فقط انتخاب می‌کند چه چیزی *خوانده* شود، موجودی را جعل نمی‌کند). به همین
   دلیل رفت‌وبرگشت از SOL شروع و به SOL ختم می‌شود.

   مثلِ worker/verdict.js این ماژول هم **خالص** است: هیچ‌چیزی را خودش fetch
   نمی‌کند مگر آنچه تزریق شده. این کانتینر به هیچ RPC سولانا یا جوپیتری
   دسترسی ندارد؛ بدونِ تزریق هیچ تستی این ماژول را در Node نمی‌سنجید.

   ⚠️ در Workers چیزی مثلِ @solana/web3.js بارگذاری‌شده نیست (و قرار نیست
   هم بشود — کلادفلر فقط چیزی را باندل می‌کند که در همین مخزن باشد). پس
   رمزگذاری/رمزگشاییِ base58، شمارشِ shortvec، و چیدمانِ خامِ پیامِ v0 همه
   دستی نوشته شده‌اند، دقیقاً همان کاری که verdict.js با ABI انجام می‌دهد.
   ===================================================================== */

/* ---------------------------------------------------------------------
   base58 — رمزگشایی/رمزگذاری دستی
   الفبا عمداً 0/O/I/l ندارد (chains.js همین را برای SOL_MINT هم به کار
   می‌برد؛ اینجا دوباره‌نویسی شده چون این ماژول باید خودکفا بماند و به
   worker/chains.js وابسته نشود — دو فایلِ نازک بهتر از یک وابستگیِ اضافه).
   --------------------------------------------------------------------- */
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

export function base58Decode(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  let num = 0n;
  for (const ch of s) {
    const v = B58_INDEX.get(ch);
    if (v === undefined) return null; // نویسه‌ی خارج از الفبا → کلاً نامعتبر
    num = num * 58n + BigInt(v);
  }
  let leadingOnes = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leadingOnes++;
  } // هر «1» ابتدایی یعنی یک بایتِ صفرِ ابتدایی
  const be = [];
  while (num > 0n) {
    be.unshift(Number(num % 256n));
    num /= 256n;
  }
  const out = new Uint8Array(leadingOnes + be.length);
  out.set(be, leadingOnes);
  return out;
}

export function base58Encode(bytes) {
  const arr = Array.from(bytes);
  let leadingZeros = 0;
  for (const b of arr) {
    if (b !== 0) break;
    leadingZeros++;
  }
  let num = 0n;
  for (const b of arr) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return "1".repeat(leadingZeros) + out;
}

/* ---------------------------------------------------------------------
   base64 — دستی، بدونِ atob/btoa/Buffer (تا این ماژول در هر دو محیط —
   workerd و Node — بدونِ فرضِ اضافه اجرا شود).
   --------------------------------------------------------------------- */
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64_ALPHABET].map((c, i) => [c, i]));

export function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64_ALPHABET[(triple >> 18) & 63];
    out += B64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHABET[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[triple & 63] : "=";
  }
  return out;
}

export function base64ToBytes(s) {
  if (typeof s !== "string") return null;
  const clean = s.replace(/=+$/, "");
  const out = [];
  let buffer = 0, bits = 0;
  for (const ch of clean) {
    if (ch === "\n" || ch === "\r") continue;
    const v = B64_INDEX.get(ch);
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/* ---------------------------------------------------------------------
   shortvec (compact-u16) — پیشوندِ طولِ فرمتِ سیمِ سولانا: هر بایت ۷ بیتِ
   داده به‌علاوه‌ی یک بیتِ ادامه. legacy و v0 هر دو همین را دارند.
   --------------------------------------------------------------------- */
function shortvecLen(n) {
  let len = 0, rem = n;
  do { len++; rem >>>= 7; } while (rem !== 0);
  return len;
}
function writeShortvec(out, n) {
  let rem = n;
  for (;;) {
    let byte = rem & 0x7f;
    rem >>>= 7;
    if (rem !== 0) byte |= 0x80;
    out.push(byte);
    if (rem === 0) break;
  }
}

/* ---------------------------------------------------------------------
   اندازه‌گیریِ اندازه‌ی سیم — همان تابعِ solana_roundtrip.mjs، بایت‌به‌بایت.
   عمداً بدونِ نیاز به base58Decode/آدرسِ واقعی: هر کلیدِ عمومی روی سولانا
   همیشه دقیقاً ۳۲ بایت است، پس شمارش فقط به *تعدادِ* کلیدها نیاز دارد، نه
   به خودِ بایت‌ها — دقیقاً همین چیزی است که «سنجشِ اندازه» را از «سریالایزِ
   واقعی» جدا و مستقل‌آزمودنی می‌کند.
   --------------------------------------------------------------------- */
export function transactionWireSize(message) {
  const numSignatures = message.header.numRequiredSignatures;
  let size = shortvecLen(numSignatures) + numSignatures * 64;
  size += 1 + 3; // پیشوندِ نسخه (0x80 برای v0) + سه‌عددِ هدر
  size += shortvecLen(message.staticAccountKeys.length) + message.staticAccountKeys.length * 32;
  size += 32; // recentBlockhash
  size += shortvecLen(message.compiledInstructions.length);
  for (const ix of message.compiledInstructions) {
    size += 1; // programIdIndex
    size += shortvecLen(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length;
    size += shortvecLen(ix.data.length) + ix.data.length;
  }
  size += shortvecLen(message.addressTableLookups.length);
  for (const l of message.addressTableLookups) {
    size += 32; // accountKey
    size += shortvecLen(l.writableIndexes.length) + l.writableIndexes.length;
    size += shortvecLen(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  }
  return size;
}

/* سریالایزِ واقعیِ بایت‌های تراکنش — فقط وقتی صدا زده می‌شود که از قبل
   transactionWireSize گفته باشد جا می‌شود؛ برخلافِ @solana/web3.js که
   داخلش یک بافرِ ثابتِ ۱۲۳۲بایتی می‌سازد و اگر رد شده باشیم throw می‌کند،
   این تابع صرفاً بایت می‌سازد و اندازه‌گیری را به عهده‌ی تابعِ بالا می‌گذارد. */
function serializeTransaction(message) {
  const bytes = [];
  const n = message.header.numRequiredSignatures;
  writeShortvec(bytes, n);
  // sigVerify:false یعنی امضای واقعی لازم نیست؛ فقط جای‌خالیِ صفر کافی است —
  // هیچ کلید خصوصی‌ای اینجا نه ساخته می‌شود نه لازم است.
  for (let i = 0; i < n * 64; i++) bytes.push(0);

  bytes.push(0x80); // نسخه v0: بیتِ بالا ست، ۷ بیتِ پایین = شماره‌ی نسخه (۰)
  bytes.push(message.header.numRequiredSignatures);
  bytes.push(message.header.numReadonlySignedAccounts);
  bytes.push(message.header.numReadonlyUnsignedAccounts);

  writeShortvec(bytes, message.staticAccountKeys.length);
  for (const pk of message.staticAccountKeys) {
    const d = base58Decode(pk);
    if (!d || d.length !== 32) throw new Error("bad static account key: " + pk);
    for (const b of d) bytes.push(b);
  }

  const bh = base58Decode(message.recentBlockhash);
  if (!bh || bh.length !== 32) throw new Error("bad recentBlockhash");
  for (const b of bh) bytes.push(b);

  writeShortvec(bytes, message.compiledInstructions.length);
  for (const ix of message.compiledInstructions) {
    bytes.push(ix.programIdIndex);
    writeShortvec(bytes, ix.accountKeyIndexes.length);
    for (const idx of ix.accountKeyIndexes) bytes.push(idx);
    writeShortvec(bytes, ix.data.length);
    for (const b of ix.data) bytes.push(b);
  }

  writeShortvec(bytes, message.addressTableLookups.length);
  for (const l of message.addressTableLookups) {
    const d = base58Decode(l.accountKey);
    if (!d || d.length !== 32) throw new Error("bad address-lookup-table key: " + l.accountKey);
    for (const b of d) bytes.push(b);
    writeShortvec(bytes, l.writableIndexes.length);
    for (const idx of l.writableIndexes) bytes.push(idx);
    writeShortvec(bytes, l.readonlyIndexes.length);
    for (const idx of l.readonlyIndexes) bytes.push(idx);
  }
  return Uint8Array.from(bytes);
}

/* ---------------------------------------------------------------------
   رمزگشاییِ حسابِ Address Lookup Table — بدونِ آن، این احتمالاً روی این
   رفت‌وبرگشت جا نمی‌شود (اندازه‌های اندازه‌گیری‌شده در بالای فایل ماژولِ
   verdict_sol با ALT به‌دست آمده‌اند، نه بدونِ آن).
   چیدمان (طبقِ برنامه‌ی address-lookup-table خودِ سولانا): ۴ بایتِ اول
   discriminant (باید ۱ باشد یعنی «LookupTable»)، بعد ۵۲ بایتِ ثابتِ متادیتا
   (deactivation_slot/last_extended_slot/…/authority — طولش صرف‌نظر از
   حضورِ authority همیشه ثابت است چون Option<Pubkey> با بورش هم با تگ‌بودن
   هم بدونش ۳۳ بایت جا می‌گیرد)، جمعاً ۵۶ بایتِ سرآیند، و از آن‌جا به بعد هر
   ۳۲ بایت یک آدرس. */
const ALT_META_SIZE = 56;
export function decodeLookupTable(data) {
  if (!data || data.length < ALT_META_SIZE) return null;
  const discriminant = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  if (discriminant !== 1) return null; // این حساب اصلاً یک LookupTable فعال نیست
  const rest = data.length - ALT_META_SIZE;
  if (rest % 32 !== 0) return null; // طولِ نامعقول → داده‌ی خراب/ناشناخته
  const out = [];
  for (let i = 0; i < rest / 32; i++) {
    out.push(base58Encode(data.slice(ALT_META_SIZE + i * 32, ALT_META_SIZE + i * 32 + 32)));
  }
  return out;
}

/* ---------------------------------------------------------------------
   ثابت‌ها
   --------------------------------------------------------------------- */
export const SOL_MINT_ADDR = "So11111111111111111111111111111111111111112";
export const VD_SOL_NOTIONAL_SOL = 0.05;

// ⚠️ اندازه‌گیری‌شده از خودِ کلادفلر (GET /vd/rpc در یک دیپلویِ واقعی)، ۶
// سپتامبرِ ۲۰۲۶: هیچ‌کدامِ این چهار اندپوینتِ رایگان کلِ مسیرِ verdict را سرِپا
// جواب نمی‌دهد.
//   • api.mainnet-beta.solana.com → ۴۰۳ روی هر متد، بی‌قیدوشرط (مستنداتِ
//     خودش هم می‌گوید این اندپوینت برای تولید نیست).
//   • solana.drpc.org → ۴۰۰ روی هر متد.
//   • solana.api.onfinality.io → ۴۲۹ روی هر متد.
//   • solana-rpc.publicnode.com → جزئی و throttled: مثلاً getMultipleAccounts
//     با یک درخواستِ کوچک ۳۰ms جواب داد، ولی getBalance رویِ همان میزبان ۴۲۹
//     گرفت — یعنی «کار می‌کند» بسته به متد و لحظه فرق دارد، نه یک قطعیت.
// دلیلِ مشترکِ هر چهارتا یکی است: IP خروجیِ کلادفلر مشترک و داغ است — دقیقاً
// همان مشکلی که این پروژه با CG_KEY (پراکسیِ CoinGecko به‌جای GeckoTerminالِ
// بی‌کلید) از قبل حلش کرده بود. پس نتیجه‌گیریِ درست «یک اندپوینتِ رایگانِ
// پنجم را امتحان کن» نیست: env.SOL_RPC (پایین‌تر در worker/index.js، هم‌شکل
// با env.CG_KEY) تنظیمِ *پشتیبانی‌شده* است؛ فهرستِ زیر فقط fallbackِ
// best-effort است، نه یک راه‌حلِ کامل. کسی که این را یک ماه بعد می‌خواند لازم
// نیست دوباره کشفش کند — GET /vd/rpc هنوز همان ابزاری است که این وضعیت را
// (یا تغییرش را) از یک دیپلویِ واقعی نشان می‌دهد.
export const VD_SOL_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://solana.drpc.org",
  "https://api.mainnet-beta.solana.com",
  "https://solana.api.onfinality.io/public",
];

// حداکثرِ تعدادِ اندپوینتی که fetchVerdictSol در یک درخواست امتحان می‌کند —
// فقط برای failoverِ اولین تماسِ RPC (پایین‌تر، کنارِ همان حلقه). صادر شده
// تا worker/test.mjs رویش بشمارد، نه اینکه دوباره در تست کپی شود.
export const VD_SOL_RPC_MAX_TRIES = 3;

export const VD_SOL_JUP_BASE = "https://api.jup.ag";

// ۱ SOL — کف امنی که فی‌پیر واقعاً بتواند کارمزد/rent را روی خودِ همین
// رفت‌وبرگشت بدهد؛ کمتر از این یعنی این آدرسِ خاص نمی‌تواند پروب را تامین
// کند — نه اینکه توکن قابل‌فروش نیست.
export const VD_SOL_MIN_PAYER_LAMPORTS = 1_000_000_000;

// ⚠️ فقط یک حدسِ تاییدنشده. دو چکِ اجرایی (موجودیِ SOL در مرحله‌ی ۱، صفربودنِ
// موجودیِ همین mint در مرحله‌ی ۲) هستند که واقعاً تصمیم می‌گیرند؛ این کد هرگز
// فرض نمی‌کند این آدرس از قبل واجدِ شرایط است.
export const VD_SOL_PAYER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

const TX_SIZE_LIMIT = 1232; // سقفِ سختِ پروتکلِ سولانا، چه legacy چه v0

// recentBlockhash فقط یک مقدارِ ۳۲-بایتیِ معتبر برای سریالایزشدن لازم دارد؛
// چون درخواستِ simulateTransaction با replaceRecentBlockhash:true می‌رود،
// خودِ RPC آن را قبل از اجرا عوض می‌کند — پس نیازی به یک getLatestBlockhash
// واقعی (و یک فراخوانیِ RPC اضافه) نیست. رشته‌ی زیر همان base58 معادلِ
// ۳۲ بایتِ صفر است (۳۲ نویسه‌ی «1»، چون هر بایتِ صفرِ ابتدایی در base58
// یک «1» می‌شود).
const PLACEHOLDER_BLOCKHASH = "1".repeat(32);

/* ---------------------------------------------------------------------
   واژه‌نامه‌ی «why» — چرا verdict نامعلوم است، از یک فهرستِ بسته و منجمد،
   هرگز متنِ آزاد. هر مسیرِ return null داخلِ fetchVerdictSol باید دقیقاً
   یکی از این‌ها را حمل کند؛ گریپ‌کردنِ «return null» داخلِ این فایل باید
   هیچ موردِ بی‌برچسب پیدا نکند.

   نگاشتِ دقیق (یک‌جا نوشته شده تا پراکنده در کامنتِ کنارِ هر return نباشد):
     • "rpc:<method>:<status>" فقط وقتی rpcCall خودش برای همان متدِ مشخص
       {ok:false} داده — یعنی پرتابِ شبکه‌ای، غیرِ ۲۰۰، یا خطای سطحِ JSON-RPC.
       نامِ متد از خودِ کد است (رشته‌ای که به rpcCall پاس داده می‌شود)، نه یک
       کپیِ جدا که بتواند از کد جدا بیفتد — به همین دلیل قبلاً یک "rpc" تنها
       همه‌چیز را قاطی می‌کرد: می‌گفت شکست خورد، نه اینکه کدام تماس. بخشِ
       عددیِ آخر (rpcFailReason، کنارِ خودِ rpcCall پایین‌تر) هم می‌گوید *چرا*
       شکست خورد: کدِ HTTP وقتی خودِ HTTP غیرِ ۲۰۰ بود یا fetch پرتاب/تایم‌اوت
       کرد (۰ برای این یکی)، یا کدِ عددیِ JSON-RPC وقتی HTTP خودش ۲۰۰ بود ولی
       بدنه خطا داشت — هرگز از رویِ متنِ error.message. هر بررسیِ شکل *بعد از*
       ok:true (فیلدی که انتظارش می‌رفت نبود) زیرِ "internal" می‌رود، نه
       "rpc:…" — چون آن دیگر شکستِ خودِ تماس نیست.
     • "jup:<endpoint>:<status>" همان قاعده برای jupCall است، دو سطل:
       "jup:quote:<status>" برای هر دو quote (خرید و فروش، هر دو روی همان
       مسیرِ /swap/v1/quote)، و "jup:swap-instructions:<status>" برای هر دو
       swap-instructions (خرید و فروش، هر دو روی /swap/v1/swap-instructions).
       بخشِ عددی همیشه کدِ HTTPِ همان تماس است (۰ برای پرتابِ شبکه‌ای/تایم‌اوت)
       — جوپیتر کدِ خطای سطحِ JSON-RPC ندارد، پس اینجا فقط یک عدد در کار است،
       نه دوتا مثلِ rpc. برای دو swap-instructions که مفهومِ route اصلاً
       ندارند، یک بدنه‌ی ok:true ولی بدونِ json هم زیرِ همان
       "jup:swap-instructions:200" می‌ماند چون سطلِ اختصاصیِ دیگری برایشان
       نیست (برخلافِ quote که "no-route" دارد).
     • ⚠️ هر دو خانواده («rpc:…»، «jup:…») همیشه دقیقاً سه بخشِ جداشده با «:»
       دارند: خودِ پیشوند، نامِ متد/اندپوینت، و یک عددِ صحیح در آخر — هرگز متنِ
       آزاد. VD_SOL_WHY پایین‌تر فقط *پیشوندِ دوبخشی* را نگه می‌دارد (مثلاً
       "rpc:getMultipleAccounts")؛ عضویت در فهرستِ منجمد یعنی این پیشوند
       یکی از آن‌هاست و بخشِ آخر با Number.isInteger معتبر است — دقیقاً همان
       چیزی که worker/test.mjs با isFrozenWhy می‌سنجد.
     • "no-route" فقط برای دو quote (خرید/فروش): تماس موفق بود (ok:true)
       ولی outAmount در کار نبود.
     • "payer-balance" همان‌طور که خودِ تعریف می‌گوید: یا فی‌پیر کمتر از
       ۱ SOL دارد، یا خودِ getBalance شکلی داد که خواندنش ممکن نبود.
     • "payer-holds" دیگر از یک lookup (getTokenAccountsByOwner) نمی‌آید —
       از شبیه‌سازیِ کنترلِ گامِ ۸ می‌آید: وقتی تراکنشِ فقط-فروش هم به‌تنهایی
       موفق می‌شود، یعنی فی‌پیر از قبل موجودی داشته و رفت‌وبرگشت هیچ چیزی
       اثبات نکرده. "too-big"، "deadline" همان یک چکِ صریحِ خودشان.
     • "internal" همه‌ی بقیه: شکلِ ناخوانا/غیرمنتظره‌ی داده‌ای که خودِ تماس
       در آن موفق بود (BigInt رویِ مقدارِ نامعتبر، محاسبه‌ی sellAmount که
       صفر/نامحدود درآمد، ALT/decodeLookupTable، compose/compile/serialize،
       شکلِ ناشناخته‌ی err شبیه‌سازی)، به‌علاوه‌ی catch بیرونیِ خودِ تابع.

   ⚠️ "unsupported" هم در همین فهرست است چون خودِ واژه‌نامه آن را خواسته،
   ولی هیچ مسیری داخلِ همین تابع آن را تولید نمی‌کند: به زمانی اشاره دارد
   که chainOf آدرس را به‌کل نه Base نه سولانا تشخیص می‌دهد — و آن حالت
   همین امروز پیش از رسیدن به این‌جا با ۴۰۰ («bad address» در diagVerdict)
   رد می‌شود، نه با v:null. تغییرِ آن رفتار خواسته‌ی این اسلایس نبود، پس
   این کد فقط اینجا در فهرست نگه‌داشته می‌شود، بدونِ مسیرِ تولیدکننده. */
export const VD_SOL_WHY = Object.freeze([
  "unsupported",
  "payer-balance",
  "payer-holds",
  "no-route",
  "too-big",
  "rpc:getBalance",
  "rpc:getMultipleAccounts",
  "rpc:simulateTransaction",
  "jup:quote",
  "jup:swap-instructions",
  "deadline",
  "internal",
]);

/* ---------------------------------------------------------------------
   فهرستِ متدهای RPC که مسیرِ verdict سولانا واقعاً صدا می‌زند — دقیقاً همان
   سه رشته‌ای که به rpcCall در fetchVerdictSol پاس داده می‌شوند، پایین‌تر
   در همین فایل. صادر شده برای دو مصرف:
     • GET /vd/rpc در worker/index.js همین فهرست را پیمایش می‌کند تا هر
       اندپوینت را رویِ همین متدها پروب کند — نه یک فهرستِ دستیِ جدا که
       می‌توانست از کد جدا بیفتد.
     • worker/test.mjs همین فایل را با regex می‌خواند و متدهای واقعاً
       صداشده را دوباره استخراج می‌کند تا بسنجد این فهرست همچنان همان‌هاست؛
       افزودنِ یک rpcCall تازه بدونِ افزودنِ متدش اینجا آن تست را می‌شکند.
   getTokenAccountsByOwner دیگر اینجا نیست: چکِ «فی‌پیر از قبل این mint را
   دارد» حالا با یک شبیه‌سازیِ کنترل انجام می‌شود (گامِ ۸ در fetchVerdictSol)،
   نه با این lookup — پس مسیرِ verdict دیگر این متد را صدا نمی‌زند، و این
   پروب هم نباید دیگر رویش تلاش کند. getHealth عمداً اینجا نیست: هیچ‌جا در
   مسیرِ verdict صدا زده نمی‌شود. */
export const VD_SOL_RPC_METHODS = Object.freeze([
  "getBalance",
  "getMultipleAccounts",
  "simulateTransaction",
]);

/* پارامترهای واقعی و بی‌ضرر برای هر متد در GET /vd/rpc — همان آدرسِ فی‌پیر
   و همان mint وسولی که خودِ fetchVerdictSol هم به کار می‌برد، نه یک
   جای‌گزینِ ساختگی که یک نود می‌تواند طورِ دیگری با آن رفتار کند.
   simulateTransaction عمداً اینجا نیست: بدونِ ترکیبِ یک تراکنشِ کامل هیچ
   راهِ صادقانه‌ای برای پروب‌کردنش نیست (diagVerdictRpc آن را skip می‌کند،
   نه اینکه یک پاسِ ساختگی جعل کند). */
export const VD_SOL_RPC_PROBE_PARAMS = Object.freeze({
  getBalance: [VD_SOL_PAYER, { commitment: "confirmed" }],
  getMultipleAccounts: [[SOL_MINT_ADDR], { encoding: "base64", commitment: "confirmed" }],
});

/* ---------------------------------------------------------------------
   تبدیلِ دستورالعملِ خامِ جوپیتر (programId رشته، accounts با
   pubkey/isSigner/isWritable، data به‌صورت base64) به شکلِ داخلی.
   --------------------------------------------------------------------- */
function rawToInstruction(raw) {
  if (!raw || typeof raw.programId !== "string" || !Array.isArray(raw.accounts) ||
      typeof raw.data !== "string")
    throw new Error("malformed jupiter instruction");
  const data = base64ToBytes(raw.data);
  if (!data) throw new Error("malformed jupiter instruction data");
  return {
    programId: raw.programId,
    keys: raw.accounts.map((a) => ({
      pubkey: a && a.pubkey,
      isSigner: !!(a && a.isSigner),
      isWritable: !!(a && a.isWritable),
    })),
    data,
  };
}

/* کلیدِ یکتا برای dedupe کردنِ setupInstructions — دو leg (خرید و فروش) هر
   دو ممکن است بخواهند همان associated-token-account را بسازند (برای mint
   یا برای wSOL)؛ نگه‌داشتنِ هر دو کپی روی زنجیره با «account already in
   use» شکست می‌خورد. */
function ixKey(raw) {
  return (
    raw.programId + "|" +
    raw.accounts.map((a) => `${a.pubkey}:${a.isSigner ? 1 : 0}:${a.isWritable ? 1 : 0}`).join(",") +
    "|" + raw.data
  );
}

/* ---------------------------------------------------------------------
   ترکیبِ دو leg در یک فهرستِ دستورالعملِ واحد — همان قاعده‌های
   solana_roundtrip.mjs: کامپیوت‌بادجت فقط از خرید، setup دیدوپ‌شده از هر
   دو، و فقط cleanupِ *نهایی*.
   --------------------------------------------------------------------- */
function composeRoundtrip(legBuy, legSell) {
  if (!legBuy || !legSell || !legBuy.swapInstruction || !legSell.swapInstruction) return null;

  const computeBudgetRaw = legBuy.computeBudgetInstructions || [];

  const setupRawAll = [...(legBuy.setupInstructions || []), ...(legSell.setupInstructions || [])];
  const seen = new Set();
  const dedupedSetup = [];
  for (const raw of setupRawAll) {
    const k = ixKey(raw);
    if (!seen.has(k)) { seen.add(k); dedupedSetup.push(raw); }
  }

  const cleanupRaw = legSell.cleanupInstruction || legBuy.cleanupInstruction || null;

  const rawInstructions = [
    ...computeBudgetRaw,
    ...dedupedSetup,
    legBuy.swapInstruction,
    legSell.swapInstruction,
    ...(cleanupRaw ? [cleanupRaw] : []),
  ];
  const instructions = rawInstructions.map(rawToInstruction);

  const altAddrs = Array.from(new Set([
    ...(legBuy.addressLookupTableAddresses || []),
    ...(legSell.addressLookupTableAddresses || []),
  ]));

  return { instructions, altAddrs };
}

/* ---------------------------------------------------------------------
   ترکیبِ کنترلِ منفی — فقط legِ فروش، بدونِ خریدِ همین تراکنش. کامپیوت‌بادجت
   و setup حالا از خودِ legSell می‌آیند (نه از خرید، چون خرید اصلاً در این
   تراکنش نیست). همان قاعده‌ی composeRoundtrip: فقط *cleanup نهایی* نگه
   داشته می‌شود، setup دیدوپ‌شده تا حسابی دوبار ساخته نشود. */
function composeSellOnly(legSell) {
  if (!legSell || !legSell.swapInstruction) return null;

  const computeBudgetRaw = legSell.computeBudgetInstructions || [];

  const setupRawAll = legSell.setupInstructions || [];
  const seen = new Set();
  const dedupedSetup = [];
  for (const raw of setupRawAll) {
    const k = ixKey(raw);
    if (!seen.has(k)) { seen.add(k); dedupedSetup.push(raw); }
  }

  const rawInstructions = [
    ...computeBudgetRaw,
    ...dedupedSetup,
    legSell.swapInstruction,
    ...(legSell.cleanupInstruction ? [legSell.cleanupInstruction] : []),
  ];
  const instructions = rawInstructions.map(rawToInstruction);

  const altAddrs = Array.from(new Set(legSell.addressLookupTableAddresses || []));

  return { instructions, altAddrs };
}

/* ---------------------------------------------------------------------
   کامپایلِ پیامِ v0 — دستی، بدونِ @solana/web3.js.
   ترتیبِ کلیدهای استاتیک طبقِ پروتکلِ سولانا: [نویسنده‌های نوشتنی][نویسنده‌های
   فقط‌خواندنی][غیرنویسنده‌های نوشتنی][غیرنویسنده‌های فقط‌خواندنی]. هر آدرسِ
   غیرنویسنده که در یکی از جدول‌های آدرس باشد، به‌جای نشستن در فهرستِ استاتیک،
   با اندیس به همان جدول ارجاع داده می‌شود — دقیقاً همین کوچک‌کردن است که
   اجازه می‌دهد یک رفت‌وبرگشتِ دو-swap زیرِ ۱۲۳۲ بایت جا شود.
   --------------------------------------------------------------------- */
function compileV0Message(payer, instructions, lookupTables) {
  const meta = new Map();
  function touch(pubkey, isSigner, isWritable) {
    if (!pubkey) throw new Error("instruction referenced an empty pubkey");
    const cur = meta.get(pubkey) || { isSigner: false, isWritable: false };
    meta.set(pubkey, { isSigner: cur.isSigner || isSigner, isWritable: cur.isWritable || isWritable });
  }
  touch(payer, true, true); // فی‌پیر همیشه امضاکننده و نوشتنی است

  const order = [];
  const seenOrder = new Set();
  function noteOrder(pubkey) {
    if (!seenOrder.has(pubkey)) { seenOrder.add(pubkey); order.push(pubkey); }
  }
  noteOrder(payer);

  const programIds = new Set();
  for (const ix of instructions) {
    touch(ix.programId, false, false);
    noteOrder(ix.programId);
    programIds.add(ix.programId);
    for (const k of ix.keys) {
      touch(k.pubkey, k.isSigner, k.isWritable);
      noteOrder(k.pubkey);
    }
  }

  const writableSigners = [], readonlySigners = [], writableNonSigners = [], readonlyNonSigners = [];
  for (const pk of order) {
    const m = meta.get(pk);
    if (m.isSigner) (m.isWritable ? writableSigners : readonlySigners).push(pk);
    else (m.isWritable ? writableNonSigners : readonlyNonSigners).push(pk);
  }
  // فی‌پیر باید همیشه اولینِ گروهِ خودش باشد (هزینه‌ی تراکنش از حسابِ اول
  // کسر می‌شود؛ این قراردادِ خودِ پروتکل است، انتخابِ ما نیست).
  const payerIdx = writableSigners.indexOf(payer);
  if (payerIdx > 0) { writableSigners.splice(payerIdx, 1); writableSigners.unshift(payer); }

  // برنامه‌ها همیشه استاتیک می‌مانند — programIdIndex باید همیشه به یک
  // کلیدِ استاتیک اشاره کند، هرگز به یک اندیسِ بارشده از جدول.
  function resolve(list) {
    const staticList = [];
    const lookups = []; // { tableIdx, indexInTable, pubkey }
    for (const pk of list) {
      if (programIds.has(pk)) { staticList.push(pk); continue; }
      let found = null;
      for (let t = 0; t < lookupTables.length; t++) {
        const idx = lookupTables[t].addresses.indexOf(pk);
        if (idx !== -1) { found = { tableIdx: t, indexInTable: idx, pubkey: pk }; break; }
      }
      if (found) lookups.push(found); else staticList.push(pk);
    }
    return { staticList, lookups };
  }

  const rw = resolve(writableNonSigners);
  const ro = resolve(readonlyNonSigners);

  const staticAccountKeys = [...writableSigners, ...readonlySigners, ...rw.staticList, ...ro.staticList];

  const globalIndex = new Map();
  staticAccountKeys.forEach((pk, i) => globalIndex.set(pk, i));

  const perTableWritable = lookupTables.map(() => []);
  const perTableReadonly = lookupTables.map(() => []);
  for (const l of rw.lookups) perTableWritable[l.tableIdx].push(l);
  for (const l of ro.lookups) perTableReadonly[l.tableIdx].push(l);

  const usedTables = [];
  for (let t = 0; t < lookupTables.length; t++) {
    if (perTableWritable[t].length > 0 || perTableReadonly[t].length > 0) usedTables.push(t);
  }

  // ترتیبِ بارگذاری: اول همه‌ی آدرس‌های نوشتنیِ همه‌ی جدول‌ها (به ترتیبِ
  // جدول)، بعد همه‌ی آدرس‌های فقط‌خواندنی — نه جدول‌به‌جدولِ متناوب.
  let cursor = staticAccountKeys.length;
  for (const t of usedTables) for (const l of perTableWritable[t]) globalIndex.set(l.pubkey, cursor++);
  for (const t of usedTables) for (const l of perTableReadonly[t]) globalIndex.set(l.pubkey, cursor++);

  const addressTableLookups = usedTables.map((t) => ({
    accountKey: lookupTables[t].key,
    writableIndexes: perTableWritable[t].map((l) => l.indexInTable),
    readonlyIndexes: perTableReadonly[t].map((l) => l.indexInTable),
  }));

  const compiledInstructions = instructions.map((ix) => {
    const programIdIndex = globalIndex.get(ix.programId);
    if (programIdIndex === undefined) throw new Error("program id missing from compiled keys");
    const accountKeyIndexes = ix.keys.map((k) => {
      const gi = globalIndex.get(k.pubkey);
      if (gi === undefined) throw new Error("account missing from compiled keys: " + k.pubkey);
      return gi;
    });
    return { programIdIndex, accountKeyIndexes, data: ix.data };
  });

  return {
    header: {
      numRequiredSignatures: writableSigners.length + readonlySigners.length,
      numReadonlySignedAccounts: readonlySigners.length,
      numReadonlyUnsignedAccounts: ro.staticList.length,
    },
    staticAccountKeys,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    compiledInstructions,
    addressTableLookups,
  };
}

/* ---------------------------------------------------------------------
   شبکه — همه‌چیز تزریق‌شدنی، هیچ‌وقت پرتاب نمی‌کند.
   برخلافِ نسخه‌ی قدیمی که فقط ok:true/false برمی‌گرداند، حالا status/code
   هم همراهش می‌آید — دقیقاً همان دو عددی که probeRpcMethod پایین‌تر برای
   GET /vd/rpc نگه می‌دارد. دلیل: خودِ حلقه‌ی failover فقط به ok نیاز دارد،
   ولی why (پایین‌تر در fetchVerdictSol، از دلِ rpcFailReason) باید بگوید
   شکست از کجا بود — ۴۲۹؟ تایم‌اوت؟ خطای سطحِ JSON-RPC؟ — و برای آن این دو
   عدد لازم است، نه یک ok خامِ تنها. */
async function rpcCall(fetchImpl, rpcUrl, method, params, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });
  } catch {
    return { ok: false, status: 0, code: null }; // پرتابِ شبکه‌ای/تایم‌اوت → نامعلوم، نه ریوِرت
  } finally {
    clearTimeout(timer);
  }
  const status = res ? res.status : 0;
  if (!res || status !== 200) return { ok: false, status, code: null }; // غیرِ ۲۰۰ → نامعلوم
  let body;
  try { body = await res.json(); } catch { return { ok: false, status, code: null }; }
  if (!body || typeof body !== "object") return { ok: false, status, code: null };
  if (body.error) {
    // کدِ عددیِ JSON-RPC، فقط وقتی واقعاً عدد است — هرگز متنِ error.message.
    const code = typeof body.error === "object" && typeof body.error.code === "number"
      ? body.error.code : null;
    return { ok: false, status, code };
  }
  return { ok: true, status, code: null, result: body.result };
}

/* ساختنِ بخشِ عددیِ "rpc:<method>:<status>" از رویِ خروجیِ rpcCall: کدِ
   عددیِ JSON-RPC وقتی HTTP خودش ۲۰۰ بود ولی بدنه خطا داشت، وگرنه خودِ کدِ
   HTTP (۰ برای پرتابِ شبکه‌ای/تایم‌اوت). attempt نظری null هم می‌تواند
   باشد (هرگز واقعاً در مسیرِ fetchVerdictSol پیش نمی‌آید، چون پیش از
   رسیدن به اینجا حلقه یا با "deadline" برمی‌گردد یا حداقل یک بار تلاش
   کرده) — ولی status:0 یک پیش‌فرضِ امن است، نه یک throw. */
function rpcFailReason(method, attempt) {
  const status = attempt ? attempt.status : 0;
  const code = attempt ? attempt.code : null;
  const num = status === 200 && code != null ? code : status;
  return "rpc:" + method + ":" + num;
}

/* ---------------------------------------------------------------------
   probeRpcMethod — برای GET /vd/rpc در worker/index.js. برخلافِ rpcCall
   (که فقط ok/notok برای مصرفِ داخلیِ fetchVerdictSol لازم دارد و هر جزئیاتِ
   دیگر را دور می‌ریزد)، این تابع خودِ کدِ HTTP واقعی و کدِ خطای JSON-RPC را
   نگه می‌دارد — تشخیص دقیقاً همین دو عدد را می‌خواهد، نه یک ok/notok خام:
   یک ۴۰۳ یعنی چیزِ دیگری از یک ۲۰۰-با-error-code (مثلاً -۳۲۶۰۱ «متد پیدا
   نشد»، شکلی که خیلی از نودهای عمومی برای متدهای سنگین می‌دهند).
     status ۰  → خودِ fetch پرتاب کرد (قطعیِ شبکه/تایم‌اوت).
     code null → یا HTTP خودش غیرِ۲۰۰ بود، یا بدنه اصلاً JSON-RPC error نداشت.
   هرگز از رویِ متنِ خطا تصمیم نمی‌گیرد — فقط از رویِ همین دو عدد. */
export async function probeRpcMethod(fetchImpl, rpcUrl, method, params, timeoutMs) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ac.signal,
      });
    } catch {
      return { m: method, ok: false, status: 0, code: null, ms: Date.now() - t0 }; // پرتابِ خودِ fetch
    }
    const status = res ? res.status : 0;
    let body = null;
    try { body = await res.json(); } catch { /* بدنه‌ی غیرِ JSON — کدی برای استخراج نیست */ }
    const code = body && typeof body === "object" && body.error && typeof body.error === "object" &&
      typeof body.error.code === "number" ? body.error.code : null;
    const ok = status === 200 && !!body && typeof body === "object" && !body.error;
    return { m: method, ok, status, code, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function jupCall(fetchImpl, jupBase, path, opts, timeoutMs) {
  let url = jupBase + path;
  if (opts.query) url += "?" + new URLSearchParams(opts.query).toString();
  const init = { method: opts.method || "GET" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const ac = new AbortController();
  init.signal = ac.signal;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return { ok: false, status: 0, json: null }; // پرتابِ شبکه‌ای/تایم‌اوت → بخشِ عددیِ why برابرِ ۰
  } finally {
    clearTimeout(timer);
  }
  if (!res) return { ok: false, status: 0, json: null };
  let json = null;
  try { json = await res.json(); } catch { /* پایین با json:null رد می‌شود */ }
  return { ok: !!res.ok, status: res.status, json };
}

/* ---------------------------------------------------------------------
   fetchVerdictSol — ارکستراسیون؛ هشت گام. گام‌های ۱ تا ۷ دقیقاً همان
   ترتیبِ اسپایک‌اند (رفت‌وبرگشت را شبیه‌سازی کن)؛ گامِ ۸ چیزی است که اسپایک
   نداشت — یک شبیه‌سازیِ کنترلِ منفی به‌جایِ lookupِ getTokenAccountsByOwner،
   دقیقاً همان چکِ «فی‌پیر از قبل این mint را ندارد»، این‌بار با اجرا نه با
   خواندنِ حساب.
   بازگشت حالا همیشه یک شیء است: { v: "sell" } / { v: "nosell" } برای
   موفقیت (بدونِ کلیدِ why)، یا { v: null, why } برای هر بن‌بست — نگاشتِ
   دقیقِ هر why بالای فایل، کنارِ VD_SOL_WHY، یک‌جا نوشته شده. */
export async function fetchVerdictSol(mint, opts) {
  try {
    const o = opts || {};
    const fetchImpl = o.fetchImpl || fetch;
    const now = o.now || Date.now;
    const deadlineAt = o.deadlineAt;
    const rpcs = o.rpcs || VD_SOL_RPCS;
    const jupBase = o.jupBase || VD_SOL_JUP_BASE;
    const timeoutMs = o.timeoutMs || 900;
    const payer = o.payer || VD_SOL_PAYER;

    function pastDeadline() {
      return deadlineAt != null && (now() >= deadlineAt || deadlineAt - now() < 400);
    }
    // یک نقطه‌ی واحد برای «نامعلوم» — تا هیچ return بی‌برچسب نماند.
    function unknown(why) { return { v: null, why }; }

    // ۱. موجودیِ SOL فی‌پیر — کمتر از ۱ SOL یعنی این آدرس نمی‌تواند پروب را
    // تامین کند؛ این یک واقعیت درباره‌ی *این آدرس* است، نه درباره‌ی توکن.
    //
    // failover بینِ اندپوینت‌ها *فقط همین‌جا* اتفاق می‌افتد — دقیقاً همان
    // شکلِ batchA در worker/verdict.js: هر اندپوینتی که همین اولین تماس
    // رویش شکست بخورد (پرتابِ شبکه‌ای، غیرِ۲۰۰، بدنه‌ی ناخوانا) کنار گذاشته
    // می‌شود و اندپوینتِ بعدی امتحان می‌شود؛ هرکدام که همین‌جا جواب داد، از
    // این‌جا تا آخرِ همین درخواست «چسبیده» می‌ماند و بقیه‌ی تماس‌های RPC
    // پایین‌تر (getMultipleAccounts، simulateTransaction — این یکی دوبار،
    // یک‌بار برای رفت‌وبرگشت و یک‌بار برای کنترل) دیگر failover نمی‌گیرند
    // — همان‌طور که batchB در
    // fetchVerdict هم اگر شکست بخورد مستقیم null می‌شود، نه اینکه اندپوینتِ
    // بعدی را امتحان کند. حداکثر VD_SOL_RPC_MAX_TRIES اندپوینت در یک
    // درخواست، و هر بار پیش از امتحانِ اندپوینتِ بعدی مهلت دوباره سنجیده
    // می‌شود — یعنی اگر مهلت کم بیاورد، امتحان‌کردنِ بقیه‌ی فهرست هم متوقف
    // می‌شود. هیچ اندپوینتی «مرده» شمرده نمی‌شود مگر اینکه واقعاً امتحان و
    // رد شده باشد؛ اگر همه رد شوند نتیجه null/"rpc" می‌ماند، هرگز nosell —
    // همان قاعده‌ی مقایسه‌ای که کل این پروژه رویش ایستاده.
    let rpc = null;
    let balRes = null;
    let lastBalAttempt = null; // فقط برای بخشِ عددیِ why اگر همه شکست بخورند — آخرین تلاش، نه اولین
    for (let i = 0; i < rpcs.length && i < VD_SOL_RPC_MAX_TRIES; i++) {
      if (pastDeadline()) return unknown("deadline");
      const attempt = await rpcCall(fetchImpl, rpcs[i], "getBalance",
        [payer, { commitment: "confirmed" }], timeoutMs);
      lastBalAttempt = attempt;
      if (attempt.ok) { rpc = rpcs[i]; balRes = attempt; break; }
    }
    // هیچ‌کدام از اندپوینت‌های امتحان‌شده جواب نداد.
    if (!rpc) return unknown(rpcFailReason("getBalance", lastBalAttempt));
    if (!balRes.result || typeof balRes.result.value !== "number") return unknown("payer-balance");
    if (balRes.result.value < VD_SOL_MIN_PAYER_LAMPORTS) return unknown("payer-balance");

    // ۲. quote خرید SOL -> mint — فقط مسیرِ مستقیم (چندجهشی احتمالاً جا نمی‌شود).
    if (pastDeadline()) return unknown("deadline");
    const amountLamports = Math.round(VD_SOL_NOTIONAL_SOL * 1e9);
    const quoteBuyRes = await jupCall(fetchImpl, jupBase, "/swap/v1/quote", {
      query: { inputMint: SOL_MINT_ADDR, outputMint: mint, amount: String(amountLamports),
               slippageBps: "500", onlyDirectRoutes: "true" },
    }, timeoutMs);
    if (!quoteBuyRes.ok) return unknown("jup:quote:" + quoteBuyRes.status);
    if (!quoteBuyRes.json || !quoteBuyRes.json.outAmount) return unknown("no-route"); // بی‌مسیر → نامعلوم، نه nosell
    const quoteBuy = quoteBuyRes.json;

    // ۳. quote فروش mint -> SOL، عمداً برای ۹۰٪ خروجیِ خرید — نه ۱۰۰٪، چون
    // مقدارِ واقعیِ رسیده در همین تراکنش می‌تواند به‌خاطرِ اسلیپیج کمتر از
    // quote باشد؛ لگِ فروش نباید صرفاً به‌خاطرِ «موجودی کافی نیست» شکست بخورد.
    if (pastDeadline()) return unknown("deadline");
    const sellAmount = Math.floor(Number(quoteBuy.outAmount) * 0.9);
    // مقدارِ نامعقول (صفر/نامحدود) یعنی خودِ محاسبه‌ی ما روی این quote جا
    // نیفتاد؛ Jupiter در همین مرحله چیزی برنگردانده که «no-route» باشد،
    // پس internal درست‌تر است تا نامش را جعل نکنیم.
    if (!Number.isFinite(sellAmount) || sellAmount <= 0) return unknown("internal");
    const quoteSellRes = await jupCall(fetchImpl, jupBase, "/swap/v1/quote", {
      query: { inputMint: mint, outputMint: SOL_MINT_ADDR, amount: String(sellAmount), slippageBps: "500" },
    }, timeoutMs);
    if (!quoteSellRes.ok) return unknown("jup:quote:" + quoteSellRes.status);
    if (!quoteSellRes.json || !quoteSellRes.json.outAmount) return unknown("no-route");
    const quoteSell = quoteSellRes.json;

    // ۴. دستورالعمل‌های swap برای هر دو leg.
    if (pastDeadline()) return unknown("deadline");
    const legBuyRes = await jupCall(fetchImpl, jupBase, "/swap/v1/swap-instructions", {
      method: "POST", body: { userPublicKey: payer, quoteResponse: quoteBuy, wrapAndUnwrapSol: true },
    }, timeoutMs);
    // این اندپوینت مفهومِ route ندارد، پس سطلِ اختصاصیِ دیگری هم برایش نیست.
    if (!legBuyRes.ok || !legBuyRes.json) return unknown("jup:swap-instructions:" + legBuyRes.status);

    const legSellRes = await jupCall(fetchImpl, jupBase, "/swap/v1/swap-instructions", {
      method: "POST", body: { userPublicKey: payer, quoteResponse: quoteSell, wrapAndUnwrapSol: true },
    }, timeoutMs);
    if (!legSellRes.ok || !legSellRes.json) return unknown("jup:swap-instructions:" + legSellRes.status);

    // ۵. ترکیبِ یک تراکنشِ v0 واحد، و حل کردنِ هر جدولِ آدرسی که هرکدام از
    // دو leg نام برده.
    if (pastDeadline()) return unknown("deadline");
    let composed;
    try { composed = composeRoundtrip(legBuyRes.json, legSellRes.json); } catch { return unknown("internal"); }
    if (!composed) return unknown("internal");

    const lookupTables = [];
    if (composed.altAddrs.length > 0) {
      const altRes = await rpcCall(fetchImpl, rpc, "getMultipleAccounts",
        [composed.altAddrs, { encoding: "base64", commitment: "confirmed" }], timeoutMs);
      if (!altRes.ok) return unknown(rpcFailReason("getMultipleAccounts", altRes));
      if (!altRes.result || !Array.isArray(altRes.result.value) ||
          altRes.result.value.length !== composed.altAddrs.length) return unknown("internal");
      for (let i = 0; i < altRes.result.value.length; i++) {
        const info = altRes.result.value[i];
        if (!info || !Array.isArray(info.data) || typeof info.data[0] !== "string") return unknown("internal");
        const raw = base64ToBytes(info.data[0]);
        const addrs = raw ? decodeLookupTable(raw) : null;
        if (!addrs) return unknown("internal"); // جدولِ آدرس روی زنجیره نیست یا خراب است → نامعلوم
        lookupTables.push({ key: composed.altAddrs[i], addresses: addrs });
      }
    }

    let message;
    try { message = compileV0Message(payer, composed.instructions, lookupTables); } catch { return unknown("internal"); }

    // ۶. سقفِ سختِ اندازه — رد شدن یعنی نتوانستیم سوال را بپرسیم، نه اینکه
    // جوابش «نه» بود.
    if (transactionWireSize(message) > TX_SIZE_LIMIT) return unknown("too-big");

    let wireBytes;
    try { wireBytes = serializeTransaction(message); } catch { return unknown("internal"); }
    const b64tx = bytesToBase64(wireBytes);

    // ۷. شبیه‌سازیِ رفت‌وبرگشت — بدونِ امضا، بدونِ کیف‌پولِ واقعی.
    if (pastDeadline()) return unknown("deadline");
    const simRes = await rpcCall(fetchImpl, rpc, "simulateTransaction",
      [b64tx, { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" }], timeoutMs);
    if (!simRes.ok) return unknown(rpcFailReason("simulateTransaction", simRes));
    if (!simRes.result || !simRes.result.value ||
        !Object.prototype.hasOwnProperty.call(simRes.result.value, "err")) return unknown("internal");
    const err = simRes.result.value.err;
    // ⚠️ هرگز از رویِ متنِ آزادِ خطا تصمیم نمی‌گیریم — فقط از رویِ شکل: یک
    // InstructionError یعنی زنجیره واقعاً اجرا کرد و ردش کرد؛ هر شکلِ دیگر
    // (خطای سطحِ RPC، شکلِ ناشناخته) یعنی نامعلوم، نه غیرقابل‌فروش.
    if (err && typeof err === "object" && Object.prototype.hasOwnProperty.call(err, "InstructionError"))
      return { v: "nosell" };
    if (err !== null) return unknown("internal"); // شکلِ err ناشناخته — نه موفقیت، نه InstructionError

    // ۸. 🔴 کنترلِ منفی — رفت‌وبرگشت موفق شد، ولی این هنوز اثبات نمی‌کند که
    // فروش از چیزی کار کرد که *همین* خرید تحویل داد؛ ممکن است فی‌پیر از قبل
    // خودِ این mint را داشته باشد — دقیقاً همان تله‌ای که چهار نتیجه‌ی اولِ
    // اسپایک را بی‌معنی کرده بود (یک کیف‌پولِ صرافی با میلیون‌ها USDC، جایی
    // که لگِ فروش از موجودیِ قبلی تامین می‌شد، نه از خروجیِ همین خرید).
    //
    // پس یک تراکنشِ دومِ مستقل می‌سازیم: فقط legِ فروش، بدونِ خرید. اگر
    // *همین* هم به‌تنهایی موفق شود، یعنی فروش نیازی به خریدِ همین تراکنش
    // نداشت → "payer-holds" (رفت‌وبرگشت هیچ چیزی اثبات نکرد، هرگز sell).
    // اگر شکست بخورد (InstructionError)، یعنی خرید واقعاً چیزی تحویل داد که
    // فروش را ممکن کرد → این‌بار sell واقعی است.
    //
    // 🔴 این شبیه‌سازیِ کنترل فقط رویِ مسیرِ موفقیت اجرا می‌شود — یک توکنِ
    // کلاهبردار (رایج‌ترین حالتِ همین قابلیت، چون رفت‌وبرگشت همان‌جا با
    // InstructionError رد می‌شود) هنوز فقط یک شبیه‌سازی هزینه دارد، نه دوتا.
    //
    // 🔴 یک verdictِ «sell» هرگز نباید برگردد مگر اینکه همین شبیه‌سازیِ کنترل
    // واقعاً اجرا و شکست خورده باشد. اگر مهلت پیش از رسیدن به آن تمام شود، یا
    // خودِ تماسِ RPCِ کنترل شکست بخورد، جواب باید null باشد ("deadline" یا
    // "rpc:simulateTransaction:<status>") — هرگز sell. یک «sell»ِ تاییدنشده روی یک
    // توکنِ کلاهبردار بدترین خروجیِ ممکنِ این سیستم است، بدتر از هیچ‌نگفتن.
    if (pastDeadline()) return unknown("deadline");
    let controlComposed;
    try { controlComposed = composeSellOnly(legSellRes.json); } catch { return unknown("internal"); }
    if (!controlComposed) return unknown("internal");

    // جدول‌های آدرسِ همین گام از قبل (بالا، برای رفت‌وبرگشت) واکشی شده‌اند —
    // altAddrs این کنترل زیرمجموعه‌ی همان‌هاست (فقط چیزی که legِ فروش نام
    // برده)، پس نیازی به یک getMultipleAccounts دوم نیست؛ compileV0Message
    // خودش فقط جدول‌هایی را که واقعاً استفاده می‌شوند نگه می‌دارد.
    let controlMessage;
    try { controlMessage = compileV0Message(payer, controlComposed.instructions, lookupTables); }
    catch { return unknown("internal"); }
    if (transactionWireSize(controlMessage) > TX_SIZE_LIMIT) return unknown("too-big");

    let controlWireBytes;
    try { controlWireBytes = serializeTransaction(controlMessage); } catch { return unknown("internal"); }
    const controlB64tx = bytesToBase64(controlWireBytes);

    const controlSimRes = await rpcCall(fetchImpl, rpc, "simulateTransaction",
      [controlB64tx, { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" }], timeoutMs);
    if (!controlSimRes.ok) return unknown(rpcFailReason("simulateTransaction", controlSimRes)); // هرگز sell بدونِ کنترلِ واقعاً اجراشده
    if (!controlSimRes.result || !controlSimRes.result.value ||
        !Object.prototype.hasOwnProperty.call(controlSimRes.result.value, "err")) return unknown("internal");
    const controlErr = controlSimRes.result.value.err;
    if (controlErr === null) return unknown("payer-holds"); // فروشِ تنها هم موفق شد → رفت‌وبرگشت چیزی اثبات نکرد
    if (controlErr && typeof controlErr === "object" &&
        Object.prototype.hasOwnProperty.call(controlErr, "InstructionError"))
      return { v: "sell" }; // فقط اینجا — بعدِ شکستِ واقعیِ کنترل
    return unknown("internal"); // شکلِ controlErr ناشناخته — نه موفقیت، نه InstructionError
  } catch {
    return { v: null, why: "internal" }; // این تابع هرگز نباید پرتاب کند
  }
}
