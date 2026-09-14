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

// فقط برای فهمیدنِ اینکه یک کلیدِ واقعیِ v4 اصلاً این توکن را در بر دارد یا
// نه (کدام ضدجفتش مجاز است تصمیمی است که همین‌جا، در VD_V4_STAGE_COUNTERS
// پایین‌تر گرفته می‌شود، نه در v4index.js) — worker/v4index.js خودش هیچ
// fetchی ندارد، پس این ایمپورت هیچ چیزی را از «خالص‌بودنِ» این ماژول کم
// نمی‌کند.
import { keyUsableFor } from "./v4index.js";

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
// quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
export const SEL_V4_SINGLE = "0xaa9d21cb";

export const WETH_ADDR = "0x4200000000000000000000000000000000000006";
export const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // ۶ رقم اعشار
export const NATIVE_ADDR = "0x0000000000000000000000000000000000000000"; // اتر بومی، currency0 همیشه در v4

/* در Uniswap v4 استخرِ WETH پوشیده وجود ندارد؛ ارزِ متقابلِ کانونیک اترِ
   بومی است که آدرسش address(0) است. پس وقتی outAddr مرحله WETH است، ردیفِ
   v4 باید به‌جای WETH با اترِ بومی کوت بگیرد. جدول بسته است تا هم این
   قاعده فقط همین‌جا نوشته شود، هم worker/test.mjs بتواند خودش را پین کند.
   مرحله‌ی USDC دست‌نخورده می‌ماند — USDC در v4 هم یک ERC-20 واقعی است، پس
   با نبودش در این جدول به خودش نگاشت می‌شود. */
export const VD_V4_COUNTER = Object.freeze({
  [WETH_ADDR.toLowerCase()]: NATIVE_ADDR,
});

/* حداکثر چند پروبِ کلید-واقعی به‌ازای هر مرحله (WETH/USDC) اضافه می‌شود —
   یک توکن با ده‌ها استخرِ واقعی نباید batch را باد کند؛ v4index.js خودش
   هم روی V4_MAX_KEYS سقف دارد، این یکی سقفِ *مصرفِ* آن‌جاست، نه سقفِ ذخیره. */
export const VD_V4_REAL_MAX = 4;

/* کلیدهای واقعی (opts.v4Keys در buildProbe) از رویِ لاگِ Initialize خودِ
   PoolManager آمده‌اند (worker/v4index.js) — یعنی یک استخرِ *واقعیِ* این
   توکن با یک ضدجفتِ مشخص. ولی یک استخرِ واقعی که توکن را با یک توکنِ کاملاً
   نامرتبط جفت کرده باشد، یک استخرِ واقعی *هست* ولی کوت‌گرفتن از آن هیچ‌چیز
   درباره‌ی «خروج» اثبات نمی‌کند — پس تنها وقتی این کلید پروب می‌شود که
   ضدجفتش یکی از همان ضدجفت‌هایی باشد که آن مرحله (VD_V4_COUNTER هم همین
   منطق را برای حدس‌ها دارد) از قبل به‌عنوانِ راهِ خروج می‌شناسد. در v4 سمتِ
   اتر می‌تواند بومی باشد یا پوشیده، برای همین مرحله‌ی WETH دو ورودی دارد.
   جدول بسته است تا هم این قاعده فقط همین‌جا نوشته شود، هم worker/test.mjs
   بتواند خودش را پین کند. */
export const VD_V4_STAGE_COUNTERS = Object.freeze({
  [WETH_ADDR.toLowerCase()]: [NATIVE_ADDR, WETH_ADDR],
  [USDC_ADDR.toLowerCase()]: [USDC_ADDR],
});

/* ⚠️ این فهرست فقط برای batchِ eth_call است، نه برای یک تماسِ تکی — یک
   اندپوینت فقط وقتی حق دارد این‌جا باشد که واقعاً batch را با موفقیت جواب
   داده باشد؛ جواب‌دادن به یک تماسِ تکی چیزی را اثبات نمی‌کند. اندازه‌گیریِ
   ۱۳ سپتامبر ۲۰۲۶ (control = ۱ تماس ×۳، batch = ۱۸ تماس ×۵، HTTP واقعی،
   user-agentِ مرورگر):
     https://base.publicnode.com         control 3/3   batch 5/5
     https://base.gateway.tenderly.co    control 3/3   batch 3/5
     https://base.meowrpc.com            control 1/3   batch 0/5
     https://base.drpc.org               control 3/3   batch 0/5
     https://mainnet.base.org            control 3/3   batch 0/5
   سه‌تای زیر عمداً بیرون‌اند، نه اینکه یادمان رفته باشد:
     - base.meowrpc.com   → batch 0/5 (و حتی control هم 1/3 بود؛ اندپوینتِ
       ناپایدار، نه فقط بدونِ batch)
     - base.drpc.org      → batch 0/5 (تماسِ تکی همیشه جواب داد، batch هرگز)
     - mainnet.base.org   → batch 0/5 (همان داستان؛ تماسِ تکی سالم، batch هیچ)
   این سه هرگز به این فهرست برنگردند مگر با یک اندازه‌گیریِ batch تازه که
   خلافِ همین جدول را نشان دهد — «تماسِ تکی جواب داد» کافی نیست.
   ⚠️ قبلاً این‌جا نوشته بود «همان فهرست و همان ترتیبِ CHAIN.rpcs در
   web/index.html». آن دیگر درست نیست و عمدی است، نه یک ناهماهنگیِ فراموش‌شده:
   مرورگر (web/index.html) هر تماس را تکی می‌زند، هرگز batch نمی‌سازد، پس
   فهرستِ آن‌جا این اندازه‌گیری را اصلاً نمی‌بیند و باید دست‌نخورده با هر پنج
   اندپوینت بماند. این‌جا (سمتِ Worker، جایی که buildProbe یک batchِ ۱۸تایی
   می‌سازد) تنها دو اندپوینتِ اثبات‌شده کافی است. */
export const VD_RPCS = [
  "https://base.publicnode.com",
  "https://base.gateway.tenderly.co",
];

/* سقفِ تعدادِ اندپوینتی که یک درخواستِ /vd می‌تواند امتحان کند — برای
   محدودکردنِ تأخیر، نه برای صرفه‌جویی؛ هر اندپوینتِ اضافه یک تایم‌اوتِ
   کامل (timeoutMs) دیگر به بدترین‌حالت اضافه می‌کند. باید همیشه *حداقل*
   به‌اندازه‌ی تعدادِ کاندیدهای batch-capable باشد — یعنی امروز حداقل ۳:
   دو تای VD_RPCS بالا، به‌علاوه‌ی env.BASE_RPC وقتی ست شده باشد (Change 3،
   baseRpcsFor در worker/index.js). اگر این عدد از تعدادِ کاندیدها کمتر
   شود، یک تک‌هیچکاپ می‌تواند کلِ فهرست را قبل از رسیدن به اندپوینتِ سالم
   تمام کند و verdict بی‌جهت به "نامعلوم" تنزل پیدا کند — دقیقاً همان
   باگی که این فایل امروز رفع کرد (توضیحِ بالای همین فایل). */
export const VD_MAX_ENDPOINTS = 3;

export const VD_NOTIONAL_USD = 100;

/* جدول صرافی‌ها — دقیقاً همین ردیف‌ها، نه بیشتر نه کمتر.
   کارمزدِ ۱۰۰۰۰ برای uniswap-v3 عمداً کنار گذاشته نشده (آن یکی که کنار
   گذاشته شده کارمزدِ ۱۰۰۰۰۰ نیست — این‌جا اصلاً چنین ردیفی وجود ندارد؛
   سطحِ استیبل-به-استیبلِ یونی‌سواپ که کنار گذاشته شده هرگز جزوِ این چهار
   کارمزد نبوده). جمعِ فراخوانی‌ها بدونِ کلیدهای واقعی همیشه ۲۱ تاست:
   ۳+۳+۵+۲+۱+۱+۱+۱+۴. با کلیدهای واقعی (opts.v4Keys در buildProbe) تا
   VD_V4_REAL_MAX=۴ تای دیگر به‌ازای هر مرحله اضافه می‌شود، یعنی حداکثر ۲۵.
   ⚠️ این کامنت یک‌بار کهنه ماند و همین‌جا («۲۱ تاست»، بدونِ قیدِ «بدون
   کلیدهای واقعی») یک روزِ تمام هزینه داشت — با هر تغییرِ این عدد، همین‌جا
   هم عوض شود.
   ⚠️ هر ردیفی که این‌جا اضافه شود باید در GT_DEX_TO_VENUE در
   worker/index.js هم شناسه‌ی دکسش بیاید، وگرنه گاردِ پوشش هرگز آن صرافی را
   نمی‌بیند و حکمِ منفی برایش بی‌صدا غیرممکن می‌شود. تست هر دو سو را می‌پیماید.
   ⚠️ استثنا: یک ردیفِ positive-only (VD_POSITIVE_ONLY) اصلاً حکمِ منفی
   نمی‌سازد، پس نه لازم دارد در آن جدول باشد و نه *مجاز* است باشد — تست
   همین را هم می‌پیماید. امروز فقط uniswap-v4 این‌طور است. */
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
  /* روترِ خودِ Uniswap نسخه‌ی ۲ روی Base. تا امشب در فهرست نبود و همین یکی
     از هفت توکنِ اولین گزارش را بی‌دلیل «نامعلوم» می‌کرد: استخر داشت، ما
     جایی برای پرسیدن نداشتیم. آدرس از صفحه‌ی رسمیِ استقرارهای Uniswap
     نسخه‌ی ۲ خوانده شد، نه حدس. کارخانه‌اش
     0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6 است و اینجا لازم نیست —
     getAmountsOut خودش از روترِ خودش کارخانه را می‌شناسد. */
  { id: "uniswap-v2", kind: "V2", to: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", keys: [null] },
  /* Uniswap v4 روی Base — آدرسِ V4Quoter از Uniswap/contracts/deployments/8453.md
     و برچسبِ تأییدشده‌ی BaseScan «Uniswap V4: Quoter» خوانده شد. کوتر id
     استخر می‌خواهد، نه آدرسِ توکن؛ id هشِ PoolKey است، پس از رویِ آدرسِ توکن
     قابلِ‌بازیابی نیست — این چهار جفتِ (fee, tickSpacing) چهار PoolKeyِ
     استانداردِ بدونِ هوک‌اند که فقط *حدس* می‌زنیم؛ استخرهای هوک‌دار عمداً
     در دسترسِ این ردیف نیستند. یک کوتِ مثبت اینجا اثباتِ واقعیِ فروش است،
     ولی یک ریوِرت فقط یعنی حدسِ ما غلط بود یا استخر هوک دارد — هیچ‌چیزی
     اثبات نمی‌کند. به همین دلیل این ردیف positive-only است (VD_POSITIVE_ONLY)
     و هرگز، تحتِ هیچ شرایطی، نباید در GT_DEX_TO_VENUE در worker/index.js
     ظاهر شود — برخلافِ هر ردیفِ دیگرِ این جدول. */
  { id: "uniswap-v4", kind: "V4_SINGLE",
    to: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    keys: [[100, 1], [500, 10], [3000, 60], [10000, 200]] },
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

/* quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) — امضای
   V4_SINGLE. PoolKey کاملاً ایستاست، پس مستقیم داخلِ سرِ تاپلِ بیرونی جا
   می‌شود و آفستِ جداگانه‌ی خودش را نمی‌گیرد؛ فقط hookData که bytes است
   دینامیک است و آفستش نسبت‌به شروعِ خودِ تاپل حساب می‌شود (۸ کلمه‌ی سر).
   exactAmount اینجا uint128 است، نه uint256 — یک مقدارِ بزرگ‌تر باید ردیف
   را حذف کند، نه اینکه بی‌صدا بریده شود و کوتِ توکنِ دیگری را بپرسد.

   ⚠️ این نسخه یک PoolKeyِ *کامل* می‌گیرد (currency0/currency1/fee/
   tickSpacing/hooks آماده)، نه اینکه خودش جفت را مرتب کند یا hooks را حدس
   بزند — با یک کلیدِ واقعی (worker/v4index.js) ترتیب و hooks از قبل معلوم
   و داده‌شده‌اند، نه چیزی که این‌جا از رویِ آدرس دوباره ساخته شود.
   zeroForOne از رویِ tokenIn === currency0 گرفته می‌شود، *نه* از رویِ
   مقایسه‌ی عددیِ آدرس — با یک کلیدِ واقعی ترتیب را خودِ رویدادِ Initialize
   گفته، نه چیزی که این‌جا دوباره از رویِ بزرگی/کوچکیِ آدرس استنتاج شود. */
export function encodeV4QuoteExactInputSingleKey(key, tokenIn, amountIn) {
  if (BigInt(amountIn) >= 2n ** 128n) return null; // بیش از ظرفیتِ uint128 — هرگز ماسک/برش
  if (!key) return null;

  const t = String(tokenIn).toLowerCase();
  const c0 = String(key.currency0).toLowerCase();
  const c1 = String(key.currency1).toLowerCase();
  if (t !== c0 && t !== c1) return null; // tokenIn اصلاً در این کلید نیست
  const zeroForOne = t === c0;

  const head =
    wordUint(0x20) +           // آفستِ تاپل؛ چون hookData بایتی درونش هست، تاپل دینامیک است
    wordAddr(key.currency0) +  // به همان ترتیبی که خودِ کلید می‌گوید — این‌جا دوباره مرتب نمی‌شود
    wordAddr(key.currency1) +
    wordUint(key.fee) +        // uint24
    wordUint(key.tickSpacing) + // int24؛ decodeInitializeLog همیشه مثبت می‌دهد، پس چپ‌چینِ صفر درست است
    wordAddr(key.hooks) +
    wordBool(zeroForOne) +
    wordUint(amountIn) +
    wordUint(0x100) +          // آفستِ hookData، نسبت‌به شروعِ تاپل = ۸ کلمه‌ی سر
    wordUint(0);               // طولِ hookData

  return "0x" + SEL_V4_SINGLE.slice(2) + head;
}

/* نسخه‌ی حدسی — همان امضای صادرشده و همان بایت‌های خروجیِ امروز، حالا فقط
   با مرتب‌کردنِ جفت و delegate به تابعِ بالا با hooks=NATIVE_ADDR (همان
   حدسِ «بدونِ هوک»ِ همیشگی). worker/test.mjs این را بایت‌به‌بایت پین می‌کند،
   پس این تغییر نباید حتی یک بایتِ خروجی را عوض کند. */
export function encodeV4QuoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, tickSpacing) {
  const a = BigInt(String(tokenIn).toLowerCase());
  const b = BigInt(String(tokenOut).toLowerCase());
  const currency0 = a < b ? tokenIn : tokenOut;
  const currency1 = a < b ? tokenOut : tokenIn;

  return encodeV4QuoteExactInputSingleKey(
    { currency0, currency1, fee, tickSpacing, hooks: NATIVE_ADDR },
    tokenIn,
    amountIn,
  );
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
const V4_ROW = VD_VENUES.find((r) => r.id === "uniswap-v4");

/* فقط ردیف‌های کلیدِ *واقعیِ* v4 برای این مرحله — جدا از buildProbe، چون دو
   جا لازمش داریم و قاعده‌ی «کدام ضدجفت مجاز است» باید فقط یک‌بار نوشته شود:
   یکی داخلِ خودِ buildProbe (ته جدول)، و یکی در گذرِ اثباتِ مثبتِ
   fetchVerdict وقتی مرحله‌ی WETH مبهم مانده.
   ⚠️ خالی‌بودنِ v4Keys باید دقیقاً آرایه‌ی خالی بدهد، نه چیزِ دیگر — همین
   است که «بدونِ کلیدِ واقعی، رفتار بایت‌به‌بایت همان دیروز است» را تضمین
   می‌کند. */
export function buildRealV4Probe(tokenAddr, outAddr, amountIn, v4Keys) {
  const out = [];
  const keys = Array.isArray(v4Keys) ? v4Keys : [];
  if (keys.length === 0 || !V4_ROW) return out;

  const allowed = VD_V4_STAGE_COUNTERS[String(outAddr).toLowerCase()];
  if (!allowed) return out;
  const allowedSet = new Set(allowed.map((a) => String(a).toLowerCase()));

  let appended = 0;
  for (const key of keys) {
    if (appended >= VD_V4_REAL_MAX) break;
    const counter = keyUsableFor(key, tokenAddr);
    if (!counter) continue; // این کلید اصلاً این توکن را ندارد
    if (!allowedSet.has(String(counter).toLowerCase())) continue; // ضدجفتِ این مرحله نیست
    const data = encodeV4QuoteExactInputSingleKey(key, tokenAddr, amountIn);
    if (data == null) continue; // بیش از ظرفیتِ uint128 — ردیف حذف می‌شود، بریده نمی‌شود
    out.push({
      id: "uniswap-v4", // positive-only همچنان از همین‌جا اعمال می‌شود
      key: "real:" + key.fee + ":" + key.tickSpacing,
      to: V4_ROW.to,
      data,
    });
    appended++;
  }
  return out;
}

export function buildProbe(tokenAddr, outAddr, amountIn, opts) {
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
    } else if (row.kind === "V4_SINGLE") {
      const counter = VD_V4_COUNTER[String(outAddr).toLowerCase()] || outAddr;
      for (const [fee, tickSpacing] of row.keys) {
        const data = encodeV4QuoteExactInputSingle(tokenAddr, counter, amountIn, fee, tickSpacing);
        if (data == null) continue;   // بیش از ظرفیتِ uint128 — ردیف حذف می‌شود، بریده نمی‌شود
        out.push({ id: row.id, key: fee + ":" + tickSpacing, to: row.to, data });
      }
    }
  }

  /* --- کلیدهای واقعیِ v4، پس از همه‌ی حدس‌ها ---
     ⚠️ opts غایب یا opts.v4Keys خالی یعنی خروجی باید بایت‌به‌بایت همان چیزی
     بماند که امروز است — همین شرط دقیقاً همان چیزی است که «۲۱ تای امروز
     دست‌نخورده می‌ماند» را تضمین می‌کند، نه یک قرارداد.
     هر کلید فقط وقتی پروب می‌شود که ضدجفتش (keyUsableFor) یکی از
     ضدجفت‌های مجازِ همین مرحله در VD_V4_STAGE_COUNTERS باشد — این تابع
     خودش هرگز روی «کدام ضدجفت» تصمیم نمی‌گیرد، فقط همان جدول را می‌خواند. */
  for (const item of buildRealV4Probe(tokenAddr, outAddr, amountIn, opts && opts.v4Keys)) {
    out.push(item);
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

/* بازگشتِ (uint256 amountOut,uint256 gasEstimate) — v4 فقط دو کلمه برمی‌گرداند،
   نه چهار. decodeStatic4 این را رد می‌کرد چون کوتاه‌تر از ظرفیتِ آن است، در
   حالی که یک بازگشتِ v4 معتبر است. کلمه‌ی *اول* amountOut است؛ کلمه‌ی آخر
   gasEstimate است و اینجا هرگز نباید گرفته شود. */
function decodeStatic2(hex) {
  if (!isHexData(hex) || hex === "0x") return null;
  const body = hex.slice(2);
  if (body.length < 128) return null; // کوتاه‌تر از ۲ کلمه → ناقص برای این شکل
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
  if (kind === "V4_SINGLE") return decodeStatic2(hex);
  return null; // نوعِ ناشناخته → نمی‌دانیم، نه صفر
}

/* ---------------------------------------------------------------------
   verdictFrom — قلبِ تصمیم. هرگز از رویِ error.message تصمیم نمی‌گیریم،
   فقط از رویِ کد و شکل.
   canary: { result?, error?:{code} } — همیشه شکلِ CL_UINT24.
   items: هرکدام { kind, result?, error?:{code} }.
   --------------------------------------------------------------------- */
const PROVEN_NEGATIVE_CODES = new Set([3, -32000]); // بازگشتِ ریوِرت JSON-RPC

/* آیا یک صفر (رمزگشایی‌شده یا "0x" خالی) برای این kind اثباتِ «هیچ استخری
   نیست» است؟ برای کوترهای شکلِ CL_UINT24/CL_INT24 و روترهای V2، عدم‌وجودِ
   استخر همیشه ریوِرت می‌کند، پس یک بازگشتِ *موفق* با مقدارِ صفر یا "0x"
   خودش یعنی «این مسیر امتحان شد و صفر داد» — اثباتی.
   ولی getAmountsOut به‌سبکِ Solidly (Aerodrome) وقتی استخر وجود ندارد
   ریوِرت *نمی‌کند*؛ آرامآرام صفر برمی‌گرداند. یعنی «صفر» اینجا با «هیچ‌کاری
   نکردم» از بیرون یک شکل است — دقیقاً همان تله‌ای که یک توکنِ واقعاً
   قابلِ‌فروش را روی مسیرِ زنده‌ی سایت «nosell» کرد: هر پروبِ aerodrome
   (چه key:false چه key:true) روی آن توکن صفرِ رمزگشایی‌شده داد، و کدِ قدیم
   هر دو را «اثباتِ منفی» می‌شمرد. برای SOLIDLY، صفر/​"0x" هرگز به‌تنهایی
   اثبات نیست — فقط یک ریوِرتِ کدِ اثباتی (که برای این قرارداد اصلاً معمول
   نیست، ولی اگر پیش بیاید هنوز اثبات است) کل نتیجه را منفی می‌کند.
   نگاشت بسته است تا هم این قاعده جایی جز اینجا حدس زده نشود، هم
   worker/test.mjs بتواند خودِ همین شیء را پین کند. */
export const VD_ZERO_IS_PROOF = Object.freeze({
  CL_UINT24: true, CL_INT24: true, V2: true, SOLIDLY: false, V4_SINGLE: false,
});

/* v4 را حدس می‌زنیم: چهار PoolKeyِ استاندارد را امتحان می‌کنیم، نه استخرِ
   واقعیِ توکن را. یک کوتِ مثبت اثباتِ واقعیِ فروش است، ولی یک ریوِرت یا
   صفر فقط یعنی حدسِ ما غلط بود یا استخر هوک دارد — هیچ‌چیزی درباره‌ی نبودِ
   فروش اثبات نمی‌کند. پس v4 (و هر venueِ positive-only دیگری) هرگز نباید
   در حلقه‌ی منفیِ verdictFrom شمرده شود؛ فقط رد می‌شود (continue)، نه رد
   می‌شود و اثبات هم می‌کند. جدول بسته است تا این قاعده هم فقط همین‌جا
   نوشته شود، هم worker/test.mjs بتواند خودش را پین کند. */
export const VD_POSITIVE_ONLY = Object.freeze({
  CL_UINT24: false, CL_INT24: false, V2: false, SOLIDLY: false, V4_SINGLE: true,
});

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
  // نتیجه را نامعلوم می‌کند. اثباتی یعنی: ریوِرتِ کدِ ۳ یا -۳۲۰۰۰، یا (فقط
  // وقتی VD_ZERO_IS_PROOF[kind] راست باشد) "0x" خالی یا رمزگشاییِ صفر.
  // کدِ دیگرِ خطا، رمزگشاییِ ناموفق، یا صفرِ یک kindِ zero-is-not-proof
  // اثباتی نیست. یک kindِ غایب/ناشناخته هم هرگز حدس زده نمی‌شود — نامعلوم.
  // شمارشِ آیتم‌های non-positive-only که واقعاً از حلقه گذشتند (یعنی اثباتِ
  // منفی دادند، نه اینکه حدس زده شده باشند) — اگر صفر باشد، فهرست فقط از
  // ردیف‌های positive-only ساخته شده و "nosell" دادن دقیقاً همان باگِ
  // ۷ سپتامبر است، فقط این‌بار با صفر شاهد به‌جای شاهدِ ناقص.
  let negativeProofCount = 0;
  for (const it of list) {
    const kind = it && it.kind;
    const zeroIsProof = Object.prototype.hasOwnProperty.call(VD_ZERO_IS_PROOF, kind)
      ? VD_ZERO_IS_PROOF[kind] : null;
    if (zeroIsProof === null) return null; // kindِ نامعتبر → هرگز حدس نزن

    const positiveOnly = Object.prototype.hasOwnProperty.call(VD_POSITIVE_ONLY, kind)
      ? VD_POSITIVE_ONLY[kind] : null;
    if (positiveOnly === null) return null; // kindِ نامعتبر → هرگز حدس نزن
    if (positiveOnly) continue;             // نه اثباتِ منفی می‌دهد نه مانعش می‌شود

    negativeProofCount++;
    if (it && it.error) {
      if (PROVEN_NEGATIVE_CODES.has(it.error.code)) continue;
      return null;
    }
    if (!it || typeof it.result !== "string") return null; // نه نتیجه نه خطا → شکلِ نامعتبر
    if (it.result === "0x") {
      if (zeroIsProof) continue;
      return null; // SOLIDLY: "0x" اینجا هم می‌تواند یعنی «هیچ استخری نیست» باشد
    }
    const v = decodeQuote(it.kind, it.result);
    if (v === 0n) {
      if (zeroIsProof) continue;
      return null; // SOLIDLY: صفرِ بی‌صدا اثباتِ «فروش نمی‌رود» نیست
    }
    if (v == null) return null; // رمزگشایی نشد → اثبات نشده
    // v>0 این‌جا دیگر ممکن نیست؛ حلقه‌ی بالا قبلاً بازگشته بود
  }
  // 🔴 گاردِ کوروم: اگر هیچ آیتمِ non-positive-onlyای این حلقه را طی نکرده
  // باشد (فهرست فقط از v4 یا هر venueِ positive-only دیگری ساخته شده)،
  // هیچ شاهدی برای "nosell" نداریم — بدون این گارد یک فهرستِ صرفاً v4 با
  // صفر شاهدِ واقعی از هر continue رد می‌شد و بی‌صدا "nosell" می‌گرفت.
  if (negativeProofCount === 0) return null;
  return "nosell";
}

/* ---------------------------------------------------------------------
   لاگِ پروب — فقط برای تشخیص (`opts.collect` در fetchVerdict)، اثری روی
   verdict ندارد. واژه‌نامه بسته است و از رویِ status/شکل تعیین می‌شود، هرگز
   از رویِ error.message؛ دقیقاً همان قاعده‌ای که verdictFrom خودش رعایت
   می‌کند. اگر روزی از رویِ متن تصمیم بگیریم، یک تغییرِ متنِ خطا در سمتِ RPC
   بی‌آنکه هیچ کدی عوض شود می‌تواند خروجیِ این ابزار را خراب کند — دقیقاً
   همان تله‌ای که verdictFrom را هم مجبور به «فقط کد، نه متن» کرده.
   --------------------------------------------------------------------- */
export const VD_PROBE_OUT = Object.freeze([
  "quoted", "zero", "empty", "undecodable", "revert", "no-answer", "batch-failed", "deadline",
]);

/* entry همان چیزی است که pick(id) در callBatch برمی‌گرداند: {result} یا
   {error}. code === -1 یعنی «هیچ ورودی‌ای برای این id نیامد» (شکلِ ساختگیِ
   خودِ pick، نه یک کدِ واقعیِ JSON-RPC) — این یکی «no-answer» است، نه
   "revert:-1"؛ آن دو معنیِ کاملاً متفاوتی دارند و قاطی‌کردنشان یعنی «اندپوینت
   اصلاً جواب نداد» با «اندپوینت جواب داد و رد کرد» یکی شود. */
function classifyProbeOut(kind, entry) {
  if (entry && entry.error) {
    const code = entry.error.code;
    if (code === -1) return "no-answer";
    return "revert:" + (Number.isInteger(code) ? code : "unknown");
  }
  if (!entry || typeof entry.result !== "string") return "revert:unknown"; // شکلی که pick هرگز نمی‌دهد؛ فقط احتیاط
  if (entry.result === "0x") return "empty";
  const v = decodeQuote(kind, entry.result);
  if (v == null) return "undecodable";
  return v > 0n ? "quoted" : "zero";
}

/* ---------------------------------------------------------------------
   fetchVerdict — ارکستراسیون. همه‌چیز تزریق‌شدنی، هیچ‌وقت پرتاب نمی‌کند.
   --------------------------------------------------------------------- */
async function callBatch(fetchImpl, rpcUrl, canary, probeItems, timeoutMs, collect, stage) {
  const requests = [
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: canary.to, data: canary.data }, "latest"] },
    ...probeItems.map((p, i) => ({
      jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: p.to, data: p.data }, "latest"],
    })),
  ];

  // شکستِ کلِ batch (نه یک آیتم) — یک ردِ تک‌شیءِ "batch-failed:<status>"، نه
  // یک ردیف به‌ازای هر آیتمی که هرگز واقعاً پرسیده نشد؛ چون در این حالت‌ها
  // اصلاً معلوم نیست کدام آیتم پرسیده شد و کدام نه.
  // ⚠️ status همیشه از کدِ HTTP واقعی می‌آید (یا صفر وقتی خودِ fetch پرتاب
  // کرد)، دقیقاً همان قراردادِ "rpc:<method>:<status>" در worker/verdict_sol.js
  // — هرگز از رویِ error.message: یک تغییرِ متنِ خطا در سمتِ RPC بی‌آنکه هیچ
  // کدی عوض شود نباید این خروجی را خراب کند. قبلاً "batch-failed" بی‌هیچ
  // عددی ثبت می‌شد و همین چیزی بود که این باگ را یک روزِ تمام مخفی نگه
  // داشت: نمی‌شد فهمید یک ۴۰۰ (batch رد شد) با یک تایم‌اوت (پرتابِ شبکه‌ای)
  // یکی نیستند.
  function failed(status) {
    if (collect) collect.push({ venue: null, key: null, out: "batch-failed:" + status, stage });
    return null;
  }

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
    return failed(0); // پرتابِ شبکه‌ای → این اندپوینت نامعلوم، وضعیتِ ۰ یعنی خودِ fetch پرتاب کرد
  } finally {
    clearTimeout(timer);
  }
  // ⚠️ status یک‌بار همین‌جا محاسبه می‌شود و از این به بعد برای هر شکستِ
  // پایین‌تر (بدنه‌ی غیرقابل‌پارس، شکلِ غیرآرایه، ورودیِ بدونِ id) هم به کار
  // می‌رود — همان‌ها همه زیرِ همان res.status===200 هستند، پس status همیشه
  // ۲۰۰ می‌ماند، ولی از رویِ همان res واقعی خوانده می‌شود، نه فرض.
  const status = res ? res.status : 0;
  if (!res || status !== 200) return failed(status); // غیر ۲۰۰ → نامعلوم

  let body;
  try {
    body = await res.json();
  } catch {
    return failed(status); // بدنه‌ی غیرقابل‌پارس → نامعلوم
  }
  if (!Array.isArray(body)) return failed(status); // شکلِ غیرآرایه → کلِ تلاش نامعلوم

  // تطبیق با id، نه با موقعیتِ آرایه — یک batch می‌تواند جابه‌جا برگردد.
  const byId = new Map();
  for (const entry of body) {
    if (!entry || typeof entry !== "object" || entry.id === undefined || entry.id === null) {
      return failed(status); // یک ورودیِ بدونِ id → کلِ پاسخ نامعتبر است
    }
    byId.set(entry.id, entry);
  }

  function pick(id) {
    const e = byId.get(id);
    if (!e) return { error: { code: -1 } }; // پاسخی برای این id نیامد؛ نه اثباتی نه مثبت
    return e.error ? { error: e.error } : { result: e.result };
  }

  const pickedCanary = pick(0);
  const pickedItems = probeItems.map((p, i) => Object.assign({ kind: VENUE_KIND_BY_ID.get(p.id) }, pick(i + 1)));

  // این batch واقعاً اجرا شد؛ کاناری اول (همان ترتیبِ id=0)، بعد هر آیتم
  // به همان ترتیبی که buildProbe ساخته — نه ترتیبِ برگشتیِ RPC.
  if (collect) {
    collect.push({ venue: "canary", key: null, out: classifyProbeOut("CL_UINT24", pickedCanary), stage });
    for (let i = 0; i < probeItems.length; i++) {
      collect.push({ venue: probeItems[i].id, key: probeItems[i].key, out: classifyProbeOut(pickedItems[i].kind, pickedItems[i]), stage });
    }
  }

  return {
    canary: pickedCanary,
    items: pickedItems,
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
    // opts.collect فقط وقتی آرایه است فعال می‌شود — نبودنش رفتار و هزینه
    // را دقیقاً همان چیزی نگه می‌دارد که امروز است؛ این تابع «مشاهده‌گر»
    // است، هرگز خودش تصمیمی از رویِ همین آرایه نمی‌گیرد.
    const collect = Array.isArray(o.collect) ? o.collect : null;

    // یک چکِ مهلت که پیش از مرحله‌ای که هنوز اجرا نشده رد می‌شود؛ اگر بزند
    // خودش یک رکوردِ "deadline" برای همان مرحله ثبت می‌کند — نه اینکه پروب
    // بی‌صدا از خروجیِ collect بیفتد.
    function deadlineHit(stage) {
      if (deadlineAt != null && (now() >= deadlineAt || deadlineAt - now() < 400)) {
        if (collect) collect.push({ venue: null, key: null, out: "deadline", stage });
        return true;
      }
      return false;
    }

    const canary = canaryCall();
    let endpointsTried = 0;

    for (const rpc of rpcs) {
      if (endpointsTried >= VD_MAX_ENDPOINTS) break;
      if (deadlineHit("weth")) return null;
      endpointsTried++;

      const itemsWeth = buildProbe(tokenAddr, WETH_ADDR, amt, { v4Keys: o.v4Keys });
      const batchA = await callBatch(fetchImpl, rpc, canary, itemsWeth, timeoutMs, collect, "weth");
      if (batchA == null) continue; // نامعلومِ سطحِ اتصال (پرتاب/غیر۲۰۰/ناپارس) → اندپوینتِ بعدی

      const canaryAlive =
        batchA.canary && !batchA.canary.error && typeof batchA.canary.result === "string" &&
        (() => { const v = decodeQuote("CL_UINT24", batchA.canary.result); return v != null && v > 0n; })();
      if (!canaryAlive) continue; // کاناریِ مرده → این اندپوینت هم قابلِ‌اعتماد نیست، بعدی

      const verdictA = verdictFrom(batchA);
      if (verdictA === "sell") return "sell";
      if (verdictA !== "nosell") {
        /* ابهامِ ردیف‌ها با کاناریِ زنده — دلیلِ عوض‌کردنِ اندپوینت نیست، و
           تا امروز همین‌جا با null تمام می‌شد.

           🔴 چرا حالا یک گذرِ دیگر هست: مرحله‌ی USDC فقط پشتِ یک «nosell»ِ
           تمیزِ مرحله‌ی WETH اجرا می‌شود، چون کلِ هدفش *تأییدِ یک منفی* بود.
           ولی یک کلیدِ واقعیِ v4 که ضدجفتش USDC است می‌تواند یک **مثبت**
           اثبات کند، و مثبت به ابهامِ مرحله‌ی قبل هیچ ربطی ندارد. اندازه‌گیریِ
           زنده‌ی ۱۴ سپتامبر یک نمونه‌ی واقعی داد: توکنی با استخرِ USDCِ نسخه ۴
           که معادلِ صد دلار را با ۹۹٫۷۵ دلار خروجی کوت می‌دهد، و ما هرگز
           نمی‌پرسیدیم چون صفرِ aerodrome مرحله‌ی WETH را مبهم کرده بود.

           این گذر فقط و فقط می‌تواند null را به "sell" تبدیل کند:
           - فقط ردیف‌های کلیدِ واقعی فرستاده می‌شوند (buildRealV4Probe)، که
             همگی positive-only‌اند، پس verdictFrom از این دسته هرگز
             نمی‌تواند "nosell" بسازد؛
           - و هر نتیجه‌ای جز "sell" همان null می‌شود.
           بدونِ کلیدِ واقعیِ USDC حتی یک فراخوانی هم اضافه نمی‌شود. */
        const proofItems = buildRealV4Probe(tokenAddr, USDC_ADDR, amt, o.v4Keys);
        if (proofItems.length === 0) return null;
        if (deadlineHit("usdc-proof")) return null;
        const batchP = await callBatch(fetchImpl, rpc, canary, proofItems, timeoutMs, collect, "usdc-proof");
        if (batchP == null) return null;
        return verdictFrom(batchP) === "sell" ? "sell" : null;
      }

      if (deadlineHit("usdc")) return null;
      const itemsUsdc = buildProbe(tokenAddr, USDC_ADDR, amt, { v4Keys: o.v4Keys });
      const batchB = await callBatch(fetchImpl, rpc, canary, itemsUsdc, timeoutMs, collect, "usdc");
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
