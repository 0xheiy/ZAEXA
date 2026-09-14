/* =====================================================================
   کلیدِ واقعیِ استخرِ Uniswap v4 — استخراج از رویِ لاگِ Initialize
   =====================================================================
   ردیفِ uniswap-v4 در worker/verdict.js حدس می‌زند: چهار جفتِ استانداردِ
   (fee, tickSpacing) را با hooks=۰ امتحان می‌کند، چون V4Quoter یک PoolKey
   کامل می‌خواهد و آن از رویِ آدرسِ توکن قابلِ‌بازیابی نیست — id استخر هشِ
   خودِ PoolKey است. یک کوتِ مثبت آن‌جا اثباتِ واقعیِ فروش است، ولی یک
   ریوِرت هیچ‌چیز اثبات نمی‌کند: یا حدسمان غلط بود، یا استخر هوک دارد.

   این ماژول کلیدِ *واقعی* را از رویِ لاگِ Initialize خودِ PoolManager
   می‌خواند — این رویداد یک‌بار به‌ازای هر استخر منتشر می‌شود و کلِ PoolKey
   را اعلام می‌کند. id استخر topics[1] است، و GeckoTerminal همین id را
   مستقیم می‌دهد (برای صرافیِ uniswap-v4-base، attributes.address خودِ
   همین id سی‌ودو-بایتی است، نه یک آدرسِ قرارداد)، پس فیلترکردن رویِ id
   دقیق است — یک eth_getLogs باریک، نه یک اسکن.

   ⚠️ محدودیتِ شناخته‌شده و پذیرفته‌شده: اندپوینتِ pools فقط استخرهای برترِ
   توکن را می‌دهد. یک استخرِ v4 که در آن فهرست نباشد اصلاً ایندکس نمی‌شود.
   این «no-v4-pool» است و صادقانه — تلاشی برای دورزدنش در این تغییر نیست.

   ⚠️ خالص است، دقیقاً به همان دلیلِ worker/verdict.js و worker/report.js:
   هیچ fetchِ خودش، هیچ throw ای. rpcCall و pools هردو از بیرون تزریق
   می‌شوند تا worker/test.mjs بتواند این رفتار را بدونِ RPC یا GeckoTerminal
   واقعی بسنجد — این کانتینر اصلاً به هیچ‌کدام دسترسی ندارد. */

export const V4_POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";

/* keccak("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
   — در همین نشست، رویِ ethersِ وندورشده‌ی خودِ مخزن بازمحاسبه شد؛ اینجا
   دوباره حدس زده نمی‌شود. اندیس‌شده: id (topics[1])، currency0 (topics[2])،
   currency1 (topics[3]). داده دقیقاً پنج کلمه است: fee(uint24)،
   tickSpacing(int24)، hooks(address)، sqrtPriceX96(uint160)، tick(int24). */
export const V4_INITIALIZE_TOPIC =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

export const V4_GT_DEX_ID = "uniswap-v4-base";

export const V4_BLOCK_MS = 2000; // Base هر ۲ ثانیه یک بلاک می‌سازد، بدونِ اسلاتِ جامانده
/* 🔴 اندازه‌گیریِ ۱۴ سپتامبر، از ماشینِ حسام، با کنترلِ مثبت روی هر اندپوینت
   (eth_blockNumber اول، بعد همان eth_getLogs با سه بازه‌ی مختلف):

     base.drpc.org          ۶۰۰۰ → ۴۰۰ (code 35)   ۵۰۰ → ۴۰۰ (code 35)   ۱۰ → ok
     base.publicnode.com    ۶۰۰۰ → ok               ۵۰۰ → ok               ۱۰ → ok
     mainnet.base.org       ۶۰۰۰ → ۴۱۳ (-32614)     ۵۰۰ → ok               ۱۰ → ok

   دو چیز از همین جدول درآمد که هر دو خلافِ چیزی بودند که فرض شده بود:
   ۱. **ادعای «۱۰۰۰۰ بلاکِ رایگانِ drpc» غلط است.** خودش روی ۵۰۰ بلاک هم
      ۴۰۰ می‌دهد و در متنِ خطا همان جمله‌ی «ranges over 10000 blocks» را
      تکرار می‌کند — یعنی متنِ خطایش با رفتارش نمی‌خواند. به همین دلیل از
      فهرست بیرون رفت: اندپوینتی که دلیلِ ردش دروغ می‌گوید قابلِ‌استدلال نیست.
   ۲. **mainnet.base.org سقفِ صریحِ ۲۰۰۰ بلاکی دارد** (کدِ عددیِ -32614).

   پس پنجره ۱۰۰۰ بلاک است، نه ۶۰۰۰: زیرِ سقفِ صریحِ ۲۰۰۰، و آن‌قدر باریک که
   هیچ‌کدام از سقف‌های اندازه‌گیری‌شده را لمس نکند.
   ⚠️ این اندازه‌گیری از ویندوزِ حسام است، نه از داخلِ Worker — پس درباره‌ی
   اینکه کدام اندپوینت به *Worker* جواب می‌دهد هیچ‌چیزی اثبات نمی‌کند؛
   `?debug=1` روی /vd/v4 دقیقاً برای همین اضافه شد. */
export const V4_WINDOW_BACK = 900; // بلاک، پیش از تخمین
export const V4_WINDOW_FWD = 100;  // بلاک، پس از تخمین — جمعاً ۱۰۰۰
/* اگر تکه‌ی اول با آرایه‌ی خالیِ خوش‌شکل برگردد، یک تکه‌ی ۱۰۰۰بلاکیِ
   *قبل‌تر* هم امتحان می‌شود — یعنی جمعاً حدودِ ۶۶ دقیقه پوشش، با دو تماسی
   که هر دو زیرِ سقف‌اند. باریک‌کردنِ پنجره بدونِ این تکه‌ی دوم یعنی یک
   تخمینِ کمی پرت، به‌جای «نامعلوم»، یک میسِ ذخیره‌شده‌ی شش‌ساعته می‌سازد —
   همان تبدیلِ نامعلوم به «نه» که کلِ این پروژه علیه آن نوشته شده. */
export const V4_WINDOW_CHUNKS = 2;
export const V4_MAX_POOLS = 3; // حداکثر چند استخرِ v4 به‌ازای هر توکن بررسی می‌شود
export const V4_MAX_KEYS = 6;  // حداکثر چند کلید به‌ازای هر توکن ذخیره می‌شود
export const V4_KEY_TTL_S = 2592000; // ۳۰ روز — یک PoolKey هرگز عوض نمی‌شود
export const V4_MISS_TTL_S = 21600;  // ۶ ساعت — فقط برای یک نتیجه‌ی *اثبات‌شده‌یِ* خالی

/* ⚠️ عمداً فهرستی جدا از VD_RPCS در worker/verdict.js: VD_RPCS فقط دو
   اندپوینتی است که اثبات‌شده batchِ eth_call را جواب می‌دهند — eth_getLogs
   یک تماسِ تکی است، پس آن اندازه‌گیری اصلاً به‌کارش نمی‌آید.
   ترتیب از رویِ جدولِ اندازه‌گیری‌شده‌ی بالای V4_WINDOW_BACK است:
   publicnode تنها اندپوینتی بود که هر سه بازه را قبول کرد، پس اول است؛
   tenderly همان اندپوینتِ دومِ VD_RPCS است و برای getLogs هنوز اندازه‌گیری
   نشده — سوم نیست بلکه دوم است چون یک کاندیدِ مستقل لازم داریم، و اگر جواب
   ندهد `?debug=1` خودش می‌گویدش؛ mainnet.base.org آخر است چون سقفِ صریحِ
   ۲۰۰۰ بلاکی دارد و پنجره‌ی ۱۰۰۰بلاکیِ امروز زیرِ آن می‌ماند، ولی حاشیه‌اش
   از بقیه کمتر است.
   🔴 base.drpc.org عمداً حذف شد — روی ۵۰۰ بلاک هم رد می‌کند در حالی که
   متنِ خطایش از ۱۰۰۰۰ حرف می‌زند (اندازه‌گیریِ بالا). هر کس خواست برش
   گرداند، اول همان اندازه‌گیری را دوباره بگیرد.
   env.BASE_RPC (Alchemyِ رایگان) عمداً غایب است: eth_getLogs روی آن به
   بازه‌ی خیلی باریکی محدود است. ⚠️ این یکی *اندازه‌گیری‌نشده* است، از
   حافظه آمده — اگر روزی لازم شد، اول بسنجش. */
/* 🔴 ترتیبِ زیر از اندازه‌گیریِ **داخلِ خودِ Worker** آمد (۱۴ سپتامبر،
   `?debug=1` روی سایتِ زنده)، نه از ویندوز:

     base.publicnode.com   eth_getBlockByNumber  200
     base.publicnode.com   eth_getLogs           403   ← فقط همین یک متد
     base.gateway.tenderly.co  eth_getLogs       200

   یعنی publicnode که از ویندوزِ حسام بازه‌ی ۶۰۰۰ بلاکی را بی‌مشکل می‌داد،
   از کلادفلر روی eth_getLogs مشخصاً ۴۰۳ می‌دهد — در حالی که همان اندپوینت
   تماسِ دیگر را ۲۰۰ جواب می‌دهد. پس نه سقفِ بازه بود نه قطعی: بلاکِ
   هدفمندِ یک متد، فقط از سمتِ سرور. tenderly اول است چون *از همین‌جا*
   جواب داد؛ publicnode دوم می‌ماند چون انکر را می‌دهد و ممکن است رفتارش
   عوض شود. */
export const V4_LOG_RPCS = [
  "https://base.gateway.tenderly.co",
  "https://base.publicnode.com",
  "https://mainnet.base.org",
];

/* واژه‌نامه‌ی بسته‌ی دلیل — ساختاری، هرگز متنِ پیام. جدا نگه‌داشتنِ
   rpc-down از no-log دقیقاً همان قاعده‌ای است که کلِ این پروژه رویش
   ساخته شده: no-log یعنی یک اندپوینت با یک آرایه‌ی خالیِ خوش‌شکل جواب داد —
   یک منفیِ واقعی. rpc-down یعنی هیچ اندپوینتی جوابِ خوش‌شکل نداد — یعنی
   نامعلوم، و هرگز نباید به‌عنوانِ میس ذخیره شود. اشتباه‌گرفتنِ این دو یعنی
   «نتوانستیم نگاه کنیم» را «چیزی آن‌جا نیست» جا زدن — دقیقاً همان کلاسِ
   شکستی که این پروژه پیش‌تر دوبار برایش هزینه داده. */
export const V4_REASONS = Object.freeze([
  "ok", "no-kv", "no-pools", "no-v4-pool", "no-pool-id", "no-created-at", "no-anchor",
  "rpc-down", "no-log",
]);

/* ⚠️ دو عضوِ این فهرست را خودِ indexV4Keys هرگز نمی‌سازد، چون هر دو پیش از
   رسیدن به آن رخ می‌دهند و سیم‌کشیِ worker/index.js آن‌ها را می‌سازد:
     no-kv    — بایندینگِ KV اصلاً نیست، پس هیچ تماسی زده نمی‌شود.
     no-pools — خودِ فهرستِ استخرهای GeckoTerminal به‌دست نیامد.
   no-pools عمداً از rpc-down جدا است: rpc-down یعنی آرپی‌سیِ زنجیره جواب
   نداد، no-pools یعنی بالادستِ قیمت جواب نداد. هر دو «نامعلوم»اند و هیچ‌کدام
   ذخیره نمی‌شوند، ولی یک اندپوینتِ تشخیصی که این دو را یکی گزارش کند دقیقاً
   همان چیزی را پنهان می‌کند که برای دیدنش ساخته شده — «کجا ایستاد» کلِ
   دلیلِ وجودِ این واژه‌نامه است. */

/* کلیدِ KV — یک کلید برای هم موفقیت هم میس (بدنه با reason فرق می‌کند، نه
   خودِ کلید)؛ دو کلیدِ جدا یعنی دو نوشتنِ ناهم‌زمان که می‌توانند از هم جدا
   بیفتند. */
export function v4KvKey(chain, addr) {
  return "v4key:" + chain + ":" + String(addr).toLowerCase();
}

/* ---------------------------------------------------------------------
   estimateBlock — تخمینِ شماره‌بلاک از رویِ زمان، با یک انکرِ واقعی
   --------------------------------------------------------------------- */
/* anchor = { number, timestampMs } — یک بلاکِ *واقعی*، تازه از زنجیره
   خوانده‌شده؛ اگر به‌جایش یک ثابتِ هاردکدشده به‌کار می‌رفت، هرچه از تاریخِ
   نوشتنِ کد دورتر می‌شدیم رانشِ تاریخی بیشتر جمع می‌شد. */
export function estimateBlock(tsMs, anchor) {
  if (!Number.isFinite(tsMs)) return null;
  if (!anchor || !Number.isFinite(anchor.number) || !Number.isFinite(anchor.timestampMs)) return null;

  const raw = anchor.number - Math.round((anchor.timestampMs - tsMs) / V4_BLOCK_MS);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(anchor.number, raw));
}

/* ---------------------------------------------------------------------
   v4PoolsFromGt — ردیف‌های v4 را از پاسخِ /tokens/<addr>/pools بیرون می‌کشد
   --------------------------------------------------------------------- */
/* یک ردیف فقط وقتی واجدِ شرایط است که هر سه‌ی این‌ها برقرار باشد؛ رد
   هرکدام یعنی آن ردیف کنار گذاشته می‌شود، نه اینکه حدس زده شود:
     • relationships.dex.data.id === V4_GT_DEX_ID
     • attributes.address شکلِ ۰x+۶۴هگز دارد (id سی‌ودو-بایتیِ استخر، نه
       یک آدرسِ ۲۰-بایتیِ قرارداد مثلِ بقیه‌ی صرافی‌های همین فهرست)
     • attributes.pool_created_at یک تاریخِ قابلِ‌پارس است
   sawV4/sawId جدا برگردانده می‌شوند تا indexV4Keys بتواند no-v4-pool را از
   no-pool-id و no-created-at تشخیص بدهد — سه دلیلِ متفاوت که همه‌شان از
   بیرون فقط «هیچ کلیدی پیدا نشد» به‌نظر می‌رسند. */
export function v4PoolsFromGt(pools) {
  const list = Array.isArray(pools) ? pools : [];
  let sawV4 = false;
  let sawId = false;
  const rows = [];

  for (const row of list) {
    const dexId = row && row.relationships && row.relationships.dex &&
      row.relationships.dex.data && row.relationships.dex.data.id;
    if (dexId !== V4_GT_DEX_ID) continue;
    sawV4 = true;

    // ⚠️ هر عددِ این پاسخِ زنده به‌صورتِ رشته می‌آید، ولی آدرس خودش از اول
    // رشته است — این‌جا Number() لازم نیست، فقط شکل (regex) سنجیده می‌شود.
    const rawAddr = row.attributes && row.attributes.address;
    if (typeof rawAddr !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(rawAddr)) continue;
    sawId = true;
    const poolId = rawAddr.toLowerCase();

    const createdAtRaw = row.attributes && row.attributes.pool_created_at;
    const createdAtMs = typeof createdAtRaw === "string" ? Date.parse(createdAtRaw) : NaN;
    if (!Number.isFinite(createdAtMs)) continue;

    rows.push({ poolId, createdAtMs });
  }

  rows.sort((a, b) => b.createdAtMs - a.createdAtMs); // تازه‌ترین اول
  return { rows: rows.slice(0, V4_MAX_POOLS), sawV4, sawId };
}

/* ---------------------------------------------------------------------
   windowFor — بازه‌ی بلاکِ جست‌وجو، حولِ تخمین
   --------------------------------------------------------------------- */
export function windowFor(createdAtMs, anchor, chunk) {
  const est = estimateBlock(createdAtMs, anchor);
  if (est === null) return null;
  const c = chunk == null ? 0 : chunk;
  if (!Number.isInteger(c) || c < 0 || c >= V4_WINDOW_CHUNKS) return null;

  /* تکه‌ی صفر دقیقاً حولِ تخمین است؛ هر تکه‌ی بعدی یک پنجره‌ی کاملِ دیگر
     *عقب‌تر* — نه گشادتر. گشادکردنِ پنجره یعنی دوباره خوردن به همان سقفی
     که اندازه‌گیری نشانش داد؛ تکه‌کردن یعنی همان پوشش با تماس‌هایی که همه
     زیرِ سقف می‌مانند. */
  /* ⚠️ مرزها *شاملِ* خودشان‌اند (eth_getLogs هر دو سر را می‌گیرد)، پس
     پهنای هر تکه span+1 بلاک است و گامِ بینِ تکه‌ها هم باید span+1 باشد،
     نه span — وگرنه تکه‌ها دقیقاً یک بلاک روی هم می‌افتند. همان یک بلاک را
     پروبِ «تکه‌ی ۱ باید بی‌فاصله پیش از تکه‌ی ۰ باشد» گرفت. */
  const step = V4_WINDOW_BACK + V4_WINDOW_FWD + 1;
  const to = Math.min(anchor.number, est + V4_WINDOW_FWD) - c * step;
  const from = to - (step - 1);
  if (to < 0) return null;
  return [Math.max(0, from), to];
}

function toMinimalHex(n) {
  return "0x" + n.toString(16); // n=0 → "0x0"، هرگز صفرِ ابتداییِ اضافه
}

/* ---------------------------------------------------------------------
   getLogsParams — پارامترِ یک eth_getLogs، فیلترشده رویِ خودِ id استخر
   --------------------------------------------------------------------- */
/* ⚠️ فیلترکردن رویِ poolId دقیقاً همان دلیلی است که این یک تماسِ باریک است
   نه یک اسکن — بدونِ topics[1]، باید کلِ بازه برای *هر* Initializeای پیمایش
   می‌شد و کدام رویداد مالِ کدام توکن است را خودمان تشخیص می‌دادیم. */
export function getLogsParams(window, poolId) {
  if (!Array.isArray(window) || window.length !== 2) return null;
  const [from, to] = window;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  if (typeof poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) return null;

  return {
    address: V4_POOL_MANAGER,
    fromBlock: toMinimalHex(from),
    toBlock: toMinimalHex(to),
    topics: [V4_INITIALIZE_TOPIC, poolId],
  };
}

/* ---------------------------------------------------------------------
   decodeInitializeLog — رمزگشاییِ سخت‌گیرانه، هرگز حدس
   --------------------------------------------------------------------- */
function isHex64(s) {
  return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);
}

/* یک کلمه‌ی ABI که یک آدرس را در ۲۰ بایتِ پایینی حمل می‌کند — ۲۴ نویسه‌ی
   هگزِ بالایی باید صفر باشند؛ هرچیزِ دیگر یعنی این کلمه اصلاً یک آدرسِ
   چپ‌چین‌شده نیست و بریدنِ کورِ ۴۰ نویسه‌ی آخر یک آدرسِ ساختگی می‌ساخت. */
function addrFromHex64(hex) {
  if (!isHex64(hex)) return null;
  if (!/^0{24}/.test(hex)) return null;
  return "0x" + hex.slice(24).toLowerCase();
}

/* یک کلمه‌ی ۳۲-بایتی را به‌عنوانِ int256 با علامت (دو-مکمل) می‌خواند. ABI
   یک int24 امضادار را با چپ‌چینِ *بیتِ‌علامت* تا کلِ کلمه رمز می‌کند، نه با
   چپ‌چینِ صفر — پس تنها راهِ درستِ خواندنِ یک tickSpacing منفیِ واقعی همین
   است؛ فرض‌کردنِ چپ‌چینِ صفر یک مقدارِ منفی را به یک عددِ مثبتِ غول‌پیکر
   تبدیل می‌کرد. */
function decodeSignedWord(hex64) {
  const raw = BigInt("0x" + hex64);
  return raw >= (1n << 255n) ? raw - (1n << 256n) : raw;
}

/* log = { topics, data } — همان شکلِ خامِ خروجیِ eth_getLogs.
   poolId همان idای است که این تماس برایش پرسیده شده؛ رمزگشایی بدونِ تطبیقِ
   دوباره‌ی این id قبول نمی‌شود — یک اندپوینتی که فیلترِ topics را نادیده
   بگیرد نباید بتواند کلیدِ یک استخرِ دیگر را قالب کند. */
export function decodeInitializeLog(log, poolId) {
  try {
    if (typeof poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) return null;
    const wantId = poolId.toLowerCase();

    if (!log || !Array.isArray(log.topics) || log.topics.length !== 4) return null;
    if (!log.topics.every((t) => typeof t === "string")) return null;

    if (log.topics[0].toLowerCase() !== V4_INITIALIZE_TOPIC.toLowerCase()) return null;

    const gotId = log.topics[1];
    if (!/^0x[0-9a-fA-F]{64}$/.test(gotId)) return null;
    if (gotId.toLowerCase() !== wantId) return null; // 🔴 نتیجه‌ی استخرِ دیگر — قالب‌کردن ممنوع

    const t2 = log.topics[2], t3 = log.topics[3];
    if (t2.slice(0, 2).toLowerCase() !== "0x" || t3.slice(0, 2).toLowerCase() !== "0x") return null;
    const currency0 = addrFromHex64(t2.slice(2));
    const currency1 = addrFromHex64(t3.slice(2));
    if (!currency0 || !currency1) return null;

    // دقیقاً ۵ کلمه — «حداقل» کافی نیست؛ یک طولِ دیگر یعنی شکلِ رویدادِ
    // دیگری است و باید رد شود، نه اینکه با کلماتِ اضافی/ناقص کار کند.
    if (typeof log.data !== "string" || log.data.slice(0, 2).toLowerCase() !== "0x") return null;
    const body = log.data.slice(2);
    if (body.length !== 320 || !/^[0-9a-fA-F]{320}$/.test(body)) return null;

    const feeWord = body.slice(0, 64);
    const feeBig = BigInt("0x" + feeWord);
    if (feeBig >= (1n << 24n)) return null; // ⚠️ 0x800000 (پرچمِ کارمزدِ پویا) هنوز مجاز است، ویژه‌اش نکن
    const fee = Number(feeBig);

    const tsWord = body.slice(64, 128);
    const tsSigned = decodeSignedWord(tsWord);
    if (tsSigned < -(1n << 23n) || tsSigned >= (1n << 23n)) return null; // خارج از بازه‌ی int24 → داده‌ی خراب
    if (tsSigned <= 0n) return null; // صفر یا منفی — رمزگذارِ خودمان نمی‌تواند منفی بسازد، پس صادقانه رد می‌شود
    const tickSpacing = Number(tsSigned);

    const hooksWord = body.slice(128, 192);
    const hooks = addrFromHex64(hooksWord);
    if (!hooks) return null;

    return { poolId: wantId, currency0, currency1, fee, tickSpacing, hooks };
  } catch (e) {
    return null; // این تابع هرگز نباید پرتاب کند
  }
}

/* ---------------------------------------------------------------------
   keyUsableFor — آیا این کلید اصلاً این توکن را دارد؟
   --------------------------------------------------------------------- */
/* فقط می‌گوید «توکن در این کلید هست یا نه»؛ *کدام* ضدجفت مجاز است تصمیمی
   است که در worker/verdict.js (VD_V4_STAGE_COUNTERS) گرفته می‌شود — همان‌جا
   تنها جایی است که آن قاعده نوشته می‌شود. */
export function keyUsableFor(key, tokenAddr) {
  if (!key || typeof tokenAddr !== "string") return null;
  const t = tokenAddr.toLowerCase();
  if (typeof key.currency0 === "string" && key.currency0.toLowerCase() === t) return key.currency1;
  if (typeof key.currency1 === "string" && key.currency1.toLowerCase() === t) return key.currency0;
  return null; // این کلید اصلاً این توکن را در بر ندارد
}

/* ---------------------------------------------------------------------
   mergeV4Keys — ادغام، بدونِ تکرار، بدونِ جهش
   --------------------------------------------------------------------- */
export function mergeV4Keys(existing, found) {
  const out = [];
  const seen = new Set();
  for (const k of (Array.isArray(existing) ? existing : [])) {
    if (k && typeof k.poolId === "string" && !seen.has(k.poolId)) {
      seen.add(k.poolId);
      out.push(k);
    }
  }
  for (const k of (Array.isArray(found) ? found : [])) {
    if (k && typeof k.poolId === "string" && !seen.has(k.poolId)) {
      seen.add(k.poolId);
      out.push(k);
    }
  }
  return out.slice(0, V4_MAX_KEYS);
}

/* ---------------------------------------------------------------------
   indexV4Keys — ارکستراسیون
   --------------------------------------------------------------------- */
function parseHexInt(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

function parseAnchor(res) {
  if (!res || res.ok !== true || !res.result || typeof res.result !== "object") return null;
  const number = parseHexInt(res.result.number);
  const timestampS = parseHexInt(res.result.timestamp);
  if (number === null || timestampS === null) return null;
  return { number, timestampMs: timestampS * 1000 };
}

/* rpcCall(method, params) → { ok, result } — تزریق‌شده؛ failover بینِ
   V4_LOG_RPCS کارِ کالر است (worker/index.js)، نه این ماژول — این ماژول
   هیچ fetchی ندارد.
   pools همان آرایه‌ی خامِ data از /networks/base/tokens/<addr>/pools است. */
export async function indexV4Keys({ tokenAddr, pools, rpcCall, now, collect }) {
  try {
    void now; // برای تزریق‌پذیریِ یک‌دست با بقیه‌ی ماژول‌ها نگه داشته شده؛ امروز مصرفی ندارد

    const { rows, sawV4, sawId } = v4PoolsFromGt(pools);
    if (rows.length === 0) {
      if (!sawV4) return { keys: [], reason: "no-v4-pool" };
      if (!sawId) return { keys: [], reason: "no-pool-id" };
      return { keys: [], reason: "no-created-at" };
    }

    // انکر: یک بلاکِ واقعی، نه یک ثابتِ هاردکد — تا رانشِ تاریخی جمع نشود.
    // شکستِ همین یک تماس «no-anchor» است، نه «rpc-down»؛ این دو مرحله‌ی
    // جدا از هم‌اند و گفتنِ کدام‌یک شکست خورد کلِ نکته‌ی این واژه‌نامه است.
    const anchorRes = await rpcCall("eth_getBlockByNumber", ["latest", false]);
    const anchor = parseAnchor(anchorRes);
    if (!anchor) return { keys: [], reason: "no-anchor" };

    let answered = 0; // چند eth_getLogs با آرایه‌ی خوش‌شکل جواب داد
    let failed = 0;   // چند تا شکست خورد (پرتاب/غیرِ۲۰۰/بدنه‌ی بد/آرایه نبود)
    const found = [];

    /* collect فقط وقتی آرایه است فعال می‌شود — همان الگوی opts.collect در
       worker/verdict.js: یک مشاهده‌گرِ محض که هیچ تصمیمی از رویش گرفته
       نمی‌شود و نبودنش هزینه و رفتار را بایت‌به‌بایت همان نگه می‌دارد. */
    const log_ = Array.isArray(collect) ? collect : null;

    for (const row of rows) {
      for (let chunk = 0; chunk < V4_WINDOW_CHUNKS; chunk++) {
        const window = windowFor(row.createdAtMs, anchor, chunk);
        const params = window ? getLogsParams(window, row.poolId) : null;
        if (!params) { failed++; break; } // با rowهای عبورکرده عملاً نمی‌افتد؛ فقط احتیاط

        const res = await rpcCall("eth_getLogs", [params]);
        const okShape = !!(res && res.ok === true && Array.isArray(res.result));
        if (log_) log_.push({ poolId: row.poolId, chunk, from: window[0], to: window[1],
                              answered: okShape, logs: okShape ? res.result.length : null });
        if (!okShape) {
          failed++;
          break; // این اندپوینت‌ها همین حالا رد کردند؛ تکه‌ی بعدی هم همان را می‌گیرد
        }
        answered++;

        let hitHere = 0;
        for (const log of res.result) {
          const key = decodeInitializeLog(log, row.poolId);
          if (!key) continue;
          if (!keyUsableFor(key, tokenAddr)) continue; // کلیدی که اصلاً این توکن را ندارد
          found.push(key);
          hitHere++;
        }
        if (hitHere > 0) break; // کلیدِ این استخر پیدا شد — تکه‌ی عقب‌تر لازم نیست
      }
    }

    // 🔴 گاردِ اصلی: صفر پاسخِ خوش‌شکل یعنی نامعلوم (rpc-down)، نه میس. فقط
    // وقتی دست‌کم یک اندپوینت واقعاً جواب داد و هیچ کلیدی از آن درنیامد
    // no-log معنا دارد — یک منفیِ اثبات‌شده، نه یک حدس از رویِ سکوت.
    if (answered === 0) return { keys: [], reason: "rpc-down" };
    if (found.length === 0) return { keys: [], reason: "no-log" };

    return { keys: mergeV4Keys([], found), reason: "ok" };
  } catch (e) {
    // این تابع هرگز نباید پرتاب کند — یک استثنای پیش‌بینی‌نشده هم باید
    // نامعلوم بماند (rpc-down)، نه اینکه بی‌صدا به یک میسِ ذخیره‌شدنی بیفتد.
    return { keys: [], reason: "rpc-down" };
  }
}
