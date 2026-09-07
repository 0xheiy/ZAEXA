/* =====================================================================
   آیا هنوز صرافی‌ای این توکن را برای فروش قیمت می‌دهد؟
   =====================================================================
   این ماژول **خالص** است: هیچ چیزی را خودش fetch نمی‌کند مگر آنچه از بیرون
   به‌اش تزریق شده (`opts.fetchImpl`، `opts.now`، ...). دلیلش این نیست که
   fetch گران است؛ دلیلش این است که بدون تزریق، هیچ تستی نمی‌تواند رفتار
   این ماژول را در Node بدون شبکه‌ی واقعی بسنجد — و این کانتینر اصلاً به
   Base RPC دسترسی ندارد.

   ✅ وصل است و زنده: `worker/index.js` همین ماژول را import می‌کند و از دو
   جا صدایش می‌زند — اندپوینتِ `/vd/<آدرس>` و ساختِ کارتِ پیش‌نمایشِ
   `/t/<آدرس>` (که جمله‌ی حکم را از همین‌جا می‌گیرد). `worker/og.js` هم
   verdict را به‌عنوان آرگومان می‌گیرد.
   ⚠️ این‌جا قبلاً نوشته بود «هنوز به هیچ‌جا وصل نیست». آن جمله بعد از
   وصل‌شدن پاک نشد و **دو بار** خواننده را به این نتیجه رساند که کارت
   حکم را نشان نمی‌دهد. کامنتِ کهنه از کامنتِ نبوده بدتر است: خواننده به آن
   اعتماد می‌کند. اگر روزی اتصال عوض شد، همین‌جا هم عوض شود.

   ⚠️ در Workers کِکاک۲۵۶ نیست، پس چهار سلکتور تابع را نمی‌شود این‌جا
   محاسبه کرد — هرکدام دستی نوشته شده، کنار امضای کاملش. یک سلکتورِ
   دستیِ بی‌تست دقیقاً همان کلاس باگی است که این مخزن را یک بار گزیده؛
   worker/test.mjs همه را از رویِ امضا با ethers.id بازمحاسبه می‌کند.
   ===================================================================== */

// quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96))
export const SEL_CL_UINT24 = "0xc6a5026a";
// quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96))
// ⚠️ شکل تاپل با CL_UINT24 یکی به‌نظر می‌رسد، ولی چون نوعِ میدانِ چهارم فرق
// دارد (int24 به‌جای uint24) سلکتور هم فرق می‌کند — کپی از آن یکی اشتباه است.
export const SEL_CL_INT24 = "0x9e7defe6";
// getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes)
export const SEL_SOLIDLY = "0x5509a1ac";
// getAmountsOut(uint256 amountIn,address[] path)
export const SEL_V2 = "0xd06ca61f";

export const WETH_ADDR = "0x4200000000000000000000000000000000000006";
export const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // ۶ رقم اعشار

// همان فهرست و همان ترتیب CHAIN.rpcs در web/index.html — ترتیب عمدی است
// (mainnet.base.org آخر است چون زیر بار واقعی ۴۲۹ داد).
export const VD_RPCS = [
  "https://base.publicnode.com",
  "https://base.meowrpc.com",
  "https://base.drpc.org",
  "https://base.gateway.tenderly.co",
  "https://mainnet.base.org",
];

export const VD_NOTIONAL_USD = 100;

/* جدول صرافی‌ها — دقیقاً همین ردیف‌ها، نه بیشتر نه کمتر.
   کارمزدِ ۱۰۰۰۰ برای uniswap-v3 عمداً کنار گذاشته نشده (آن یکی که کنار
   گذاشته شده کارمزدِ ۱۰۰۰۰۰ نیست — این‌جا اصلاً چنین ردیفی وجود ندارد؛
   سطحِ استیبل-به-استیبلِ یونی‌سواپ که کنار گذاشته شده هرگز جزوِ این چهار
   کارمزد نبوده). جمعِ فراخوانی‌ها ۱۶ تاست: ۳+۳+۵+۲+۱+۱+۱. */
export const VD_VENUES = [
  { id: "uniswap-v3", kind: "CL_UINT24",
    to: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", keys: [500, 3000, 10000] },
  { id: "pancake-v3", kind: "CL_UINT24",
    to: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", keys: [500, 2500, 10000] },
  { id: "aerodrome-cl", kind: "CL_INT24",
    to: "0x514c8B5f54112481E28028F1166Bd78501089259", keys: [1, 50, 100, 200, 2000] },
  { id: "aerodrome", kind: "SOLIDLY",
    to: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", keys: [false, true] },
  { id: "baseswap", kind: "V2", to: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86", keys: [null] },
  { id: "sushiswap", kind: "V2", to: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891", keys: [null] },
  { id: "alienbase", kind: "V2", to: "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7", keys: [null] },
];

const VENUE_KIND_BY_ID = new Map(VD_VENUES.map((v) => [v.id, v.kind]));

/* ---------------------------------------------------------------------
   رمزگذاریِ دستیِ ABI — بدون هیچ کتابخانه‌ای (Workers چیزی مثل ethers را
   بارگذاری‌شده ندارد و این ماژول باید خودکفا باشد).
   هرچهار شکل در worker/test.mjs بایت‌به‌بایت با ethers.Interface سنجیده
   می‌شوند؛ خودِ این رمزگذاری «طلای» تست است.
   --------------------------------------------------------------------- */
const WORD = 64; // یک کلمه‌ی ABI = ۳۲ بایت = ۶۴ نویسه‌ی هگز

function wordAddr(addr) {
  return String(addr).toLowerCase().replace(/^0x/, "").padStart(WORD, "0");
}

function wordUint(n) {
  return BigInt(n).toString(16).padStart(WORD, "0");
}

function wordBool(b) {
  return wordUint(b ? 1 : 0);
}

/* تاپلِ (tokenIn,tokenOut,amountIn,fee|tickSpacing,sqrtPriceLimitX96) کاملاً
   ایستا است، پس کالدیتا فقط سلکتور + پنج کلمه است — هیچ آفستی لازم نیست.
   میدانِ چهارم برای CL_INT24 در واقع int24 امضادار است؛ همه‌ی tickSpacing
   هایی که می‌فرستیم مثبت‌اند، پس چپ‌چینِ صفر درست است — برای یک مقدارِ
   منفی باید علامت را با تکرارِ بیتِ نشانه چپ‌چین می‌کردیم (sign extension)
   که این‌جا هرگز رخ نمی‌دهد. */
function encodeQuoteSingle(selector, tokenIn, tokenOut, amountIn, feeOrTickSpacing) {
  return (
    "0x" + selector.slice(2) +
    wordAddr(tokenIn) + wordAddr(tokenOut) + wordUint(amountIn) +
    wordUint(feeOrTickSpacing) + wordUint(0) // sqrtPriceLimitX96 = بدون محدودیت
  );
}

/* getAmountsOut(uint256,address[]) — امضای V2. آرایه پویاست: بعد از دو
   کلمه‌ی سر (amountIn، آفستِ آرایه) بدنه با طولِ آرایه شروع می‌شود. چون
   آدرس نوعِ ایستاست، هر عضو فقط یک کلمه است — نه یک آفستِ دیگر. */
function encodeV2GetAmountsOut(amountIn, path) {
  const head = wordUint(amountIn) + wordUint(0x40);
  const body = wordUint(path.length) + path.map(wordAddr).join("");
  return "0x" + SEL_V2.slice(2) + head + body;
}

/* getAmountsOut(uint256,(address,address,bool,address)[]) — امضای SOLIDLY.
   هر عضوِ آرایه یک تاپلِ کاملاً ایستاست (۴ میدانِ ایستا)، پس مثل V2 هر عضو
   فقط چهار کلمه‌ی پشتِ‌سرهم است، بدون آفستِ جداگانه برای خودِ تاپل. */
function encodeSolidlyGetAmountsOut(amountIn, routes) {
  const head = wordUint(amountIn) + wordUint(0x40);
  const body =
    wordUint(routes.length) +
    routes.map((r) => wordAddr(r.from) + wordAddr(r.to) + wordBool(r.stable) + wordAddr(r.factory)).join("");
  return "0x" + SEL_SOLIDLY.slice(2) + head + body;
}

/* ---------------------------------------------------------------------
   sellAmountFrom — قیمتِ دلاری → مقدارِ خامِ توکن معادلِ VD_NOTIONAL_USD.
   با اعداد اعشاری کار نمی‌کنیم (سرریز/گردشِ کف‌شناور برای قیمت‌های خیلی
   ریز یا خیلی بزرگ واقعی است)؛ رشته‌ی اعشاری را دستی به BigIntِ مقیاس‌شده
   تبدیل می‌کنیم و همه‌جا تقسیمِ صحیح انجام می‌دهیم.
   --------------------------------------------------------------------- */
const PRICE_PREC = 18; // تعداد رقمِ اعشاریِ نگه‌داشته‌شده از قیمت، قبل از تقسیم

function priceToDecimalString(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null; // NaN یا بی‌نهایت
    return v.toFixed(30); // toFixed نمادِ علمی نمی‌دهد؛ برای این مقیاس کافی است
  }
  return null;
}

/* رشته‌ی اعشاری → BigIntِ مقیاس‌شده با PRICE_PREC رقمِ اعشار، یا null.
   اعشارِ بیشتر از PRICE_PREC رقم فقط بریده می‌شود (نه گرد به بالا) — یعنی
   نتیجه کمی کوچک‌تر از واقعی، هرگز بزرگ‌تر؛ برای «آیا صفر شد» امن‌تر است. */
function parsePriceToScaled(s) {
  if (!s) return null; // رشته‌ی خالی هم این‌جا رد می‌شود
  const m = /^([+-]?)(\d+)?(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] === undefined && m[3] === undefined)) return null;
  const negative = m[1] === "-";
  const intPart = m[2] || "0";
  const fracPart = (m[3] || "").slice(0, PRICE_PREC).padEnd(PRICE_PREC, "0");
  const scaled = BigInt(intPart + fracPart);
  return negative ? -scaled : scaled;
}

export function sellAmountFrom(priceUsd, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const s = priceToDecimalString(priceUsd);
  if (s == null) return null;
  const scaled = parsePriceToScaled(s);
  if (scaled == null || scaled <= 0n) return null;

  const numerator = BigInt(VD_NOTIONAL_USD) * 10n ** BigInt(decimals) * 10n ** BigInt(PRICE_PREC);
  const amount = numerator / scaled; // تقسیمِ صحیح؛ کف می‌گیرد، سرریز نمی‌کند
  return amount > 0n ? amount : null;
}

/* ---------------------------------------------------------------------
   buildProbe / canaryCall
   --------------------------------------------------------------------- */
export function buildProbe(tokenAddr, outAddr, amountIn) {
  const out = [];
  for (const row of VD_VENUES) {
    if (row.kind === "CL_UINT24" || row.kind === "CL_INT24") {
      const sel = row.kind === "CL_UINT24" ? SEL_CL_UINT24 : SEL_CL_INT24;
      for (const key of row.keys) {
        out.push({
          id: row.id, key, to: row.to,
          data: encodeQuoteSingle(sel, tokenAddr, outAddr, amountIn, key),
        });
      }
    } else if (row.kind === "SOLIDLY") {
      for (const stable of row.keys) {
        out.push({
          id: row.id, key: stable, to: row.to,
          data: encodeSolidlyGetAmountsOut(amountIn, [
            { from: tokenAddr, to: outAddr, stable, factory: row.factory },
          ]),
        });
      }
    } else if (row.kind === "V2") {
      out.push({
        id: row.id, key: null, to: row.to,
        data: encodeV2GetAmountsOut(amountIn, [tokenAddr, outAddr]),
      });
    }
  }
  return out;
}

/* پروبِ زنده‌بودنِ اندپوینت: یک کوتِ WETH→USDC روی uniswap-v3، همیشه همان
   مقدار. اگر این یکی هم جواب نداد، اندپوینت را «مرده» می‌دانیم — نه توکن را
   «غیرقابل‌فروش». */
export function canaryCall() {
  const amountIn = 10000000000000000n; // ۰٫۰۱ WETH
  return {
    to: VD_VENUES[0].to, // آدرسِ کوترِ uniswap-v3، همان ردیفِ اول جدول
    data: encodeQuoteSingle(SEL_CL_UINT24, WETH_ADDR, USDC_ADDR, amountIn, 500),
  };
}

/* ---------------------------------------------------------------------
   رمزگشایی
   --------------------------------------------------------------------- */
function isHexData(hex) {
  return typeof hex === "string" && /^0x([0-9a-fA-F]{2})*$/.test(hex);
}

function hexWordAt(bodyNoPrefix, wordIndex) {
  const start = wordIndex * 64;
  if (bodyNoPrefix.length < start + 64) return null;
  return bodyNoPrefix.slice(start, start + 64);
}

/* بازگشتِ (uint256 amountOut,uint160,uint32,uint256) — تاپلِ ایستا، ۴ کلمه.
   فقط کلمه‌ی *اول* لازم است؛ کلمه‌ی آخر چیزِ دیگری‌ست (نه amountOut) — پس
   اینجا هرگز نباید «آخرین کلمه» گرفت، برخلافِ شکلِ آرایه‌ای زیر. */
function decodeStatic4(hex) {
  if (!isHexData(hex) || hex === "0x") return null;
  const body = hex.slice(2);
  if (body.length < 256) return null; // کوتاه‌تر از ۴ کلمه → ناقص برای این شکل
  return BigInt("0x" + hexWordAt(body, 0));
}

/* بازگشتِ uint256[] — طول متغیر است، پس برخلافِ static4 این‌جا *آخرین* عضو
   درست است، نه دومی و نه اولی. آفست و طول را واقعی می‌خوانیم، فرض نمی‌کنیم
   آرایه دقیقاً دو عضو دارد. */
function decodeDynamicUintArray(hex) {
  if (!isHexData(hex) || hex === "0x") return null;
  const body = hex.slice(2);
  const offW = hexWordAt(body, 0);
  if (offW == null) return null;
  const offsetBytes = BigInt("0x" + offW);
  if (offsetBytes < 0n || offsetBytes % 32n !== 0n) return null;
  if (offsetBytes > BigInt(body.length / 2)) return null; // آفست بیرون از بدنه
  const offsetWordIdx = Number(offsetBytes / 32n);
  const lenW = hexWordAt(body, offsetWordIdx);
  if (lenW == null) return null;
  const len = BigInt("0x" + lenW);
  if (len <= 0n || len > 100000n) return null; // طولِ نامعقول → زباله، نه یک آرایه‌ی واقعی
  const lastWordIdx = offsetWordIdx + 1 + Number(len) - 1;
  const lastW = hexWordAt(body, lastWordIdx);
  if (lastW == null) return null; // ادعای طول از چیزی که واقعاً رسیده بزرگ‌تر است
  return BigInt("0x" + lastW);
}

export function decodeQuote(kind, hex) {
  if (kind === "CL_UINT24" || kind === "CL_INT24") return decodeStatic4(hex);
  if (kind === "SOLIDLY" || kind === "V2") return decodeDynamicUintArray(hex);
  return null; // نوعِ ناشناخته → نمی‌دانیم، نه صفر
}

/* ---------------------------------------------------------------------
   verdictFrom — قلبِ تصمیم. هرگز از رویِ error.message تصمیم نمی‌گیریم،
   فقط از رویِ کد و شکل.
   canary: { result?, error?:{code} } — همیشه شکلِ CL_UINT24.
   items: هرکدام { kind, result?, error?:{code} }.
   --------------------------------------------------------------------- */
const PROVEN_NEGATIVE_CODES = new Set([3, -32000]); // بازگشتِ ریوِرت JSON-RPC

function decodeItemValue(item) {
  if (!item || item.error || typeof item.result !== "string") return null;
  return decodeQuote(item.kind, item.result);
}

export function verdictFrom({ canary, items }) {
  const list = items || [];

  // مثبت همیشه برنده است — مستقل از وضعیتِ کاناری یا هر چیزِ دیگر.
  for (const it of list) {
    const v = decodeItemValue(it);
    if (v != null && v > 0n) return "sell";
  }

  // کاناری باید ثابت کند اندپوینت زنده است؛ وگرنه هیچ ردی معنا ندارد —
  // یک توکن هرگز روی اندپوینتی که حتی WETH→USDC را قیمت نداد «غیرقابل‌فروش» نیست.
  const canaryVal =
    canary && !canary.error && typeof canary.result === "string"
      ? decodeQuote("CL_UINT24", canary.result)
      : null;
  if (canaryVal == null || canaryVal <= 0n) return null;

  // فهرستِ پروبِ خالی هیچ چیزی را اثبات نمی‌کند — نه اینکه فروشی هست، نه
  // اینکه نیست. اگر اینجا "nosell" برمی‌گرداندیم، «هیچ صرافی‌ای پرسیده
  // نشد» با «همه‌ی صرافی‌ها رد کردند» یکی می‌شد؛ اولی نامعلوم است.
  if (list.length === 0) return null;

  // با کاناریِ زنده و بدون هیچ مثبتی: هرچیزی که «اثبات‌شده منفی» نباشد کل
  // نتیجه را نامعلوم می‌کند. اثباتی یعنی: ریوِرتِ کدِ ۳ یا -۳۲۰۰۰، یا "0x"
  // خالی، یا رمزگشاییِ صفر. کدِ دیگرِ خطا یا رمزگشاییِ ناموفق اثباتی نیست.
  for (const it of list) {
    if (it && it.error) {
      if (PROVEN_NEGATIVE_CODES.has(it.error.code)) continue;
      return null;
    }
    if (!it || typeof it.result !== "string") return null; // نه نتیجه نه خطا → شکلِ نامعتبر
    if (it.result === "0x") continue;
    const v = decodeQuote(it.kind, it.result);
    if (v === 0n) continue;
    if (v == null) return null; // رمزگشایی نشد → اثبات نشده
    // v>0 این‌جا دیگر ممکن نیست؛ حلقه‌ی بالا قبلاً بازگشته بود
  }
  return "nosell";
}

/* ---------------------------------------------------------------------
   fetchVerdict — ارکستراسیون. همه‌چیز تزریق‌شدنی، هیچ‌وقت پرتاب نمی‌کند.
   --------------------------------------------------------------------- */
async function callBatch(fetchImpl, rpcUrl, canary, probeItems, timeoutMs) {
  const requests = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: canary.to, data: canary.data }, "latest"] },
    ...probeItems.map((p, i) => ({
      jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: p.to, data: p.data }, "latest"],
    })),
  ];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requests),
      signal: ac.signal,
    });
  } catch {
    return null; // پرتابِ شبکه‌ای → این اندپوینت نامعلوم
  } finally {
    clearTimeout(timer);
  }
  if (!res || res.status !== 200) return null; // غیر ۲۰۰ → نامعلوم

  let body;
  try {
    body = await res.json();
  } catch {
    return null; // بدنه‌ی غیرقابل‌پارس → نامعلوم
  }
  if (!Array.isArray(body)) return null; // شکلِ غیرآرایه → کلِ تلاش نامعلوم

  // تطبیق با id، نه با موقعیتِ آرایه — یک batch می‌تواند جابه‌جا برگردد.
  const byId = new Map();
  for (const entry of body) {
    if (!entry || typeof entry !== "object" || entry.id === undefined || entry.id === null) {
      return null; // یک ورودیِ بدونِ id → کلِ پاسخ نامعتبر است
    }
    byId.set(entry.id, entry);
  }

  function pick(id) {
    const e = byId.get(id);
    if (!e) return { error: { code: -1 } }; // پاسخی برای این id نیامد؛ نه اثباتی نه مثبت
    return e.error ? { error: e.error } : { result: e.result };
  }

  return {
    canary: pick(0),
    items: probeItems.map((p, i) => Object.assign({ kind: VENUE_KIND_BY_ID.get(p.id) }, pick(i + 1))),
  };
}

export async function fetchVerdict(tokenAddr, meta, opts) {
  try {
    const amt = sellAmountFrom(meta && meta.priceUsd, meta && meta.decimals);
    if (amt == null) return null; // بدونِ مقدار معنادار حتی یک fetch هم لازم نیست

    const o = opts || {};
    const fetchImpl = o.fetchImpl || fetch;
    const now = o.now || Date.now;
    const deadlineAt = o.deadlineAt;
    const rpcs = o.rpcs || VD_RPCS;
    const timeoutMs = o.timeoutMs || 900;

    const canary = canaryCall();
    let endpointsTried = 0;

    for (const rpc of rpcs) {
      if (endpointsTried >= 2) break;
      if (deadlineAt != null && (now() >= deadlineAt || deadlineAt - now() < 400)) return null;
      endpointsTried++;

      const itemsWeth = buildProbe(tokenAddr, WETH_ADDR, amt);
      const batchA = await callBatch(fetchImpl, rpc, canary, itemsWeth, timeoutMs);
      if (batchA == null) continue; // نامعلومِ سطحِ اتصال (پرتاب/غیر۲۰۰/ناپارس) → اندپوینتِ بعدی

      const canaryAlive =
        batchA.canary && !batchA.canary.error && typeof batchA.canary.result === "string" &&
        (() => { const v = decodeQuote("CL_UINT24", batchA.canary.result); return v != null && v > 0n; })();
      if (!canaryAlive) continue; // کاناریِ مرده → این اندپوینت هم قابلِ‌اعتماد نیست، بعدی

      const verdictA = verdictFrom(batchA);
      if (verdictA === "sell") return "sell";
      if (verdictA !== "nosell") return null; // ابهامِ ردیف‌ها با کاناریِ زنده — دلیلِ عوض‌کردنِ اندپوینت نیست

      if (deadlineAt != null && (now() >= deadlineAt || deadlineAt - now() < 400)) return null;
      const itemsUsdc = buildProbe(tokenAddr, USDC_ADDR, amt);
      const batchB = await callBatch(fetchImpl, rpc, canary, itemsUsdc, timeoutMs);
      if (batchB == null) return null; // ابهامِ مرحله‌ی B هم اندپوینتِ بعدی را صدا نمی‌زند

      const verdictB = verdictFrom(batchB);
      if (verdictB === "sell") return "sell";
      if (verdictB === "nosell") return "nosell";
      return null;
    }
    return null;
  } catch {
    return null; // این تابع هرگز نباید پرتاب کند
  }
}
