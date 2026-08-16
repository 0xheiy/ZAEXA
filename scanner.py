"""
اسکنر ایمنی توکن.

قبل از خرید یک توکن ناشناخته، این ابزار بررسی می‌کند:
  • آیا اصلاً قرارداد است؟ آیا ERC20 معتبر است؟
  • چه توابع خطرناکی در قراردادش وجود دارد؟ (mint، pause، blacklist، تغییر کارمزد)
  • مالکیت واگذار شده یا هنوز کسی کنترل دارد؟
  • قرارداد قابل ارتقاست؟ (proxy — یعنی کد می‌تواند بعداً عوض شود)
  • نقدینگی واقعی چقدر است و در چند استخر؟
  • آیا اصلاً می‌شود ازش کوت گرفت؟ (اگر نه، احتمالاً قابل فروش نیست)

⚠️ حدود صادقانه‌ی این ابزار:
   ۱) تشخیص کامل honeypot نیاز به شبیه‌سازی خرید و فروش واقعی دارد که
      قرارداد شبیه‌ساز می‌خواهد (فاز بعدی). این نسخه بر پایه‌ی تحلیل ایستا
      و نقدینگی کار می‌کند.
   ۲) «امن» بودن در این گزارش یعنی «نشانه‌ی خطر شناخته‌شده‌ای پیدا نشد»،
      نه تضمین. یک قرارداد می‌تواند تمیز باشد ولی تیمش نقدینگی را بکشد.
   ۳) هیچ ابزاری جای بررسی خودت را نمی‌گیرد.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import List, Optional, Dict, Tuple

from web3 import Web3

from ratelimit import call_rpc, try_call, RpcFailure
from chains import (
    Chain, Dex, Venue, Token, ZERO, DEAD,
    ERC20_ABI, OWNABLE_ABI, V3_QUOTER_ABI, V2_ROUTER_ABI, SOLIDLY_ROUTER_ABI,
    V3_FACTORY_ABI, V2_FACTORY_ABI, SOLIDLY_FACTORY_ABI,
    KIND_V2, KIND_V3, KIND_SOLIDLY,
)


# ---------------------------------------------------------------------------
# توابع خطرناک — با امضا تعریف می‌شوند و سلکتورشان محاسبه می‌شود
# ---------------------------------------------------------------------------

DANGEROUS_FUNCTIONS = {
    # --- ضرب سکه‌ی جدید: می‌تواند ارزش را رقیق کند ---
    "mint(address,uint256)": ("ضرب سکه", "critical",
                              "سازنده می‌تواند توکن جدید بسازد و ارزش را رقیق کند"),
    "mint(uint256)": ("ضرب سکه", "critical",
                      "سازنده می‌تواند توکن جدید بسازد"),
    # --- سوزاندن از حساب دیگران ---
    "burnFrom(address,uint256)": ("سوزاندن از حساب دیگران", "high",
                                  "ممکن است بتوانند توکن شما را بسوزانند"),
    # --- توقف انتقال: کلاسیک‌ترین حالت honeypot ---
    "pause()": ("توقف انتقال", "critical",
                "می‌توانند خرید و فروش را کاملاً متوقف کنند"),
    "setPaused(bool)": ("توقف انتقال", "critical",
                        "می‌توانند معاملات را متوقف کنند"),
    "setTradingEnabled(bool)": ("کنترل معاملات", "critical",
                                "معاملات فقط با اجازه‌ی سازنده ممکن است"),
    "enableTrading()": ("کنترل معاملات", "high",
                        "معاملات تا اجازه‌ی سازنده بسته است"),
    # --- لیست سیاه: می‌توانند شما را از فروش منع کنند ---
    "blacklist(address)": ("لیست سیاه", "critical",
                           "می‌توانند آدرس شما را از فروش منع کنند"),
    "addBlackList(address)": ("لیست سیاه", "critical",
                              "می‌توانند آدرس شما را مسدود کنند"),
    "setBlacklist(address,bool)": ("لیست سیاه", "critical",
                                   "می‌توانند آدرس شما را مسدود کنند"),
    "isBlackListed(address)": ("لیست سیاه", "high",
                               "سیستم لیست سیاه وجود دارد"),
    "setBots(address[],bool)": ("علامت‌گذاری ربات", "high",
                                "می‌توانند آدرس شما را «ربات» علامت بزنند و مسدود کنند"),
    # --- تغییر کارمزد: می‌توانند کارمزد فروش را ۱۰۰٪ کنند ---
    "setFee(uint256)": ("تغییر کارمزد", "critical",
                        "می‌توانند کارمزد فروش را هر لحظه بالا ببرند"),
    "setFees(uint256,uint256)": ("تغییر کارمزد", "critical",
                                 "کارمزد قابل تغییر است"),
    "setTaxFee(uint256)": ("تغییر کارمزد", "critical",
                           "کارمزد قابل تغییر است"),
    "setSellFee(uint256)": ("تغییر کارمزد فروش", "critical",
                            "کارمزد فروش قابل تغییر است"),
    "setBuyFee(uint256)": ("تغییر کارمزد خرید", "high",
                           "کارمزد خرید قابل تغییر است"),
    # --- محدودیت مقدار معامله ---
    "setMaxTxAmount(uint256)": ("سقف معامله", "medium",
                                "می‌توانند سقف مقدار هر معامله را محدود کنند"),
    "setMaxWalletAmount(uint256)": ("سقف کیف پول", "medium",
                                    "می‌توانند سقف موجودی هر کیف پول را محدود کنند"),
    # --- برداشت اضطراری ---
    "withdrawToken(address,uint256)": ("برداشت توکن", "medium",
                                       "سازنده می‌تواند توکن‌های داخل قرارداد را بردارد"),
    "rescueTokens(address,uint256)": ("برداشت توکن", "medium",
                                      "سازنده می‌تواند توکن‌ها را خارج کند"),
}

# توابع مالکیت (برای بررسی، نه لزوماً خطر)
OWNERSHIP_FUNCTIONS = {
    "owner()": "owner",
    "getOwner()": "getOwner",
    "renounceOwnership()": "renounceOwnership",
    "transferOwnership(address)": "transferOwnership",
}

# اسلات استاندارد EIP-1967 برای قراردادهای قابل ارتقا
EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"


def selector(signature: str) -> str:
    """۴ بایت اول keccak امضای تابع — همان چیزی که در بایت‌کد ظاهر می‌شود."""
    return Web3.keccak(text=signature)[:4].hex()


# ---------------------------------------------------------------------------

@dataclass
class Finding:
    level: str       # critical | high | medium | info
    title: str
    detail: str


@dataclass
class PoolInfo:
    venue_name: str
    address: str
    paired_with: str
    tvl_usd: Optional[Decimal] = None


@dataclass
class TokenReport:
    address: str
    is_contract: bool = False
    name: str = "?"
    symbol: str = "?"
    decimals: Optional[int] = None
    total_supply: Optional[int] = None

    owner: Optional[str] = None
    ownership_renounced: bool = False
    is_proxy: bool = False

    findings: List[Finding] = field(default_factory=list)
    pools: List[PoolInfo] = field(default_factory=list)
    total_liquidity_usd: Decimal = Decimal(0)

    can_quote_buy: bool = False
    can_quote_sell: bool = False

    def add(self, level: str, title: str, detail: str):
        self.findings.append(Finding(level, title, detail))

    def counts(self) -> Dict[str, int]:
        c = {"critical": 0, "high": 0, "medium": 0, "info": 0}
        for f in self.findings:
            c[f.level] = c.get(f.level, 0) + 1
        return c

    def risk_score(self) -> int:
        """۰ (امن‌تر) تا ۱۰۰ (خطرناک‌تر). صرفاً یک خلاصه، نه حکم قطعی."""
        c = self.counts()
        score = c["critical"] * 25 + c["high"] * 12 + c["medium"] * 5
        if not self.can_quote_sell:
            score += 40          # نتوانستن فروش، جدی‌ترین نشانه است
        if self.total_liquidity_usd < 10_000:
            score += 20
        elif self.total_liquidity_usd < 50_000:
            score += 10
        if not self.ownership_renounced and self.owner not in (None, ZERO, DEAD):
            score += 10
        if self.is_proxy:
            score += 10
        return min(100, score)

    def verdict(self) -> Tuple[str, str]:
        c = self.counts()
        s = self.risk_score()
        # 🔑 قانون: وجود حتی یک یافته‌ی بحرانی، هیچ‌وقت نباید «سبز» بدهد.
        #    قبلاً امتیاز عددی می‌توانست یک یافته‌ی بحرانی را زیر آستانه نگه دارد
        #    که تناقض‌آمیز و گمراه‌کننده بود.
        if c["critical"] >= 2 or s >= 60:
            return ("خطر بالا", "🔴")
        if c["critical"] >= 1 or c["high"] >= 2 or s >= 30:
            return ("احتیاط", "🟡")
        if c["high"] >= 1 or s >= 15:
            return ("قابل قبول با ملاحظه", "🟡")
        return ("نشانه‌ی خطر آشکاری پیدا نشد", "🟢")


# ---------------------------------------------------------------------------
# بررسی‌ها
# ---------------------------------------------------------------------------

def _safe_call(fn, default=None):
    """سازگاری با کد قدیمی — ترجیحاً از try_call استفاده کن."""
    val, _ = try_call(fn, default=default)
    return val


def check_basics(w3: Web3, report: TokenReport, addr: str):
    """آیا قرارداد است و اطلاعات پایه‌ی ERC20 دارد؟"""
    code = call_rpc(lambda: w3.eth.get_code(Web3.to_checksum_address(addr)))
    if not code or len(code) <= 2:
        report.is_contract = False
        report.add("critical", "قرارداد نیست",
                   "این آدرس هیچ کدی ندارد — یعنی یک کیف پول عادی است، نه توکن.")
        return None

    report.is_contract = True
    c = w3.eth.contract(address=Web3.to_checksum_address(addr), abi=ERC20_ABI)

    report.name, _ = try_call(lambda: c.functions.name().call(), default="?")
    report.symbol, _ = try_call(lambda: c.functions.symbol().call(), default="?")
    report.decimals, dec_status = try_call(lambda: c.functions.decimals().call())
    report.total_supply, sup_status = try_call(lambda: c.functions.totalSupply().call())

    # 🔑 تفکیک «تابع وجود ندارد» از «شبکه جواب نداد»
    if dec_status == "missing":
        report.add("critical", "ERC20 معتبر نیست",
                   "تابع decimals() وجود ندارد — این توکن استاندارد نیست.")
    elif dec_status == "rpc_error":
        report.add("info", "decimals خوانده نشد (خطای شبکه)",
                   "این نتیجه نامعلوم است، نه لزوماً مشکل توکن.")

    if sup_status == "missing":
        report.add("medium", "totalSupply وجود ندارد",
                   "تابع totalSupply() در قرارداد نیست.")
    elif sup_status == "rpc_error":
        report.add("info", "totalSupply خوانده نشد (خطای شبکه)",
                   "این نتیجه نامعلوم است، نه لزوماً مشکل توکن.")

    return code


def adjust_severity_by_ownership(report: TokenReport):
    """
    شدت یافته‌ها را با توجه به وضعیت مالکیت تنظیم می‌کند.

    چرا لازم است؟ وجود تابع mint به‌تنهایی لزوماً کلاهبرداری نیست — خیلی از
    پروتکل‌های معتبر (مثل توکن‌های انتشاری) عمداً mint دارند و کنترلش دست یک
    قرارداد حاکمیتی است. چیزی که واقعاً خطرناک است، ترکیب «تابع خطرناک» با
    «یک مالک فعال که می‌تواند صدایش بزند» است.

    پس اگر مالکیت واگذار شده یا تابع owner وجود ندارد، شدت را یک پله کم می‌کنیم
    و دلیلش را شفاف می‌نویسیم.
    """
    owner_active = (report.owner is not None
                    and report.owner.lower() not in (ZERO.lower(), DEAD.lower()))
    if owner_active:
        return          # خطر کامل سر جایش می‌ماند

    downgrade = {"critical": "high", "high": "medium", "medium": "info"}
    note = "  ⓘ چون مالک فعالی پیدا نشد، شدت یک پله کم شد (ولی کنترل ممکن است دست قرارداد دیگری باشد)."
    for f in report.findings:
        if f.level in downgrade and f.title not in (
                "قرارداد نیست", "ERC20 معتبر نیست", "هیچ استخری پیدا نشد",
                # ⚠️ عنوان «کوت فروش نگرفت» به «کوت فروش رد شد» تغییر کرد؛
                #    اگر اینجا به‌روز نشود، یک یافته‌ی honeypot بی‌صدا تنزل
                #    پیدا می‌کند چون توکن مالک فعال ندارد.
                "نقدینگی بسیار کم", "کوت فروش رد شد", "کوت خرید نگرفت",
                "افت شدید در رفت‌وبرگشت"):
            f.level = downgrade[f.level]
            f.detail = f.detail + "\n" + note


def check_bytecode(report: TokenReport, code: bytes):
    """
    جستجوی سلکتور توابع خطرناک در بایت‌کد.

    چرا کار می‌کند: هر تابع عمومی در قرارداد، سلکتور ۴ بایتی‌اش در بایت‌کد
    ظاهر می‌شود (برای مسیریابی فراخوانی‌ها). پس بدون داشتن سورس هم می‌شود
    فهمید چه توابعی وجود دارد.

    ⚠️ محدودیت: ممکن است سلکتوری تصادفاً در داده‌ها ظاهر شود (مثبت کاذب)،
    یا قرارداد از الگوی غیرعادی استفاده کند (منفی کاذب).
    """
    hex_code = code.hex().lower()
    if not hex_code.startswith("0x"):
        hex_code = "0x" + hex_code

    seen_titles = set()
    for sig, (title, level, detail) in DANGEROUS_FUNCTIONS.items():
        sel = selector(sig).lower().replace("0x", "")
        if sel in hex_code:
            if title in seen_titles:
                continue
            seen_titles.add(title)
            report.add(level, title, f"{detail}  ({sig})")


def check_ownership(w3: Web3, report: TokenReport, addr: str):
    """آیا مالکیت واگذار شده؟"""
    c = w3.eth.contract(address=Web3.to_checksum_address(addr), abi=OWNABLE_ABI)
    owner = _safe_call(lambda: c.functions.owner().call())
    report.owner = owner

    if owner is None:
        report.add("info", "تابع owner ندارد",
                   "قرارداد تابع owner() استاندارد ندارد — ممکن است مالکیت نداشته باشد یا با نام دیگری باشد.")
        return

    if owner.lower() in (ZERO.lower(), DEAD.lower()):
        report.ownership_renounced = True
        report.add("info", "مالکیت واگذار شده ✓",
                   "مالک به آدرس صفر منتقل شده — یعنی دیگر کسی کنترل ویژه ندارد.")
    else:
        report.add("high", "مالکیت واگذار نشده",
                   f"مالک هنوز فعال است: {owner}\n"
                   f"       یعنی می‌تواند از توابع مدیریتی (اگر باشد) استفاده کند.")


def check_proxy(w3: Web3, report: TokenReport, addr: str):
    """آیا قرارداد قابل ارتقاست؟ (کدش می‌تواند بعداً عوض شود)"""
    a = Web3.to_checksum_address(addr)
    impl = _safe_call(lambda: w3.eth.get_storage_at(a, EIP1967_IMPL_SLOT))
    if impl and int(impl.hex(), 16) != 0:
        report.is_proxy = True
        impl_addr = "0x" + impl.hex()[-40:]
        report.add("high", "قرارداد قابل ارتقا (proxy)",
                   f"کد این قرارداد می‌تواند بعداً کاملاً عوض شود.\n"
                   f"       پیاده‌سازی فعلی: {impl_addr}\n"
                   f"       یعنی حتی اگر الان امن باشد، فردا ممکن است نباشد.")


def find_pools(w3: Web3, chain: Chain, token_addr: str) -> List[PoolInfo]:
    """همه‌ی استخرهای این توکن با توکن‌های شناخته‌شده را پیدا می‌کند."""
    pools = []
    t = Web3.to_checksum_address(token_addr)

    for dex in chain.dexes:
        for v in dex.variants():
            venue = Venue(dex=dex, fee_tier=v["fee_tier"], stable=v["stable"])
            for sym, known in chain.tokens.items():
                k = Web3.to_checksum_address(known.address)
                if k.lower() == t.lower():
                    continue
                fac = Web3.to_checksum_address(dex.factory)
                if dex.kind == KIND_V3:
                    f = w3.eth.contract(address=fac, abi=V3_FACTORY_ABI)
                    q = lambda: f.functions.getPool(t, k, venue.fee_tier).call()
                elif dex.kind == KIND_SOLIDLY:
                    f = w3.eth.contract(address=fac, abi=SOLIDLY_FACTORY_ABI)
                    q = lambda: f.functions.getPool(t, k, bool(venue.stable)).call()
                else:
                    f = w3.eth.contract(address=fac, abi=V2_FACTORY_ABI)
                    q = lambda: f.functions.getPair(t, k).call()
                pool, status = try_call(q)
                if status != "ok" or not pool:
                    continue

                if pool and pool != ZERO:
                    pools.append(PoolInfo(venue_name=venue.name, address=pool,
                                          paired_with=sym))
    return pools


def measure_pool_liquidity(w3: Web3, chain: Chain, pool: PoolInfo,
                           token_addr: str, price_cache: Dict[str, Decimal]) -> Optional[Decimal]:
    """
    نقدینگی استخر را از سمت توکن *شناخته‌شده* می‌سنجد.

    چرا فقط یک سمت؟ چون ارزش توکن ناشناخته را نمی‌دانیم (و اتفاقاً قیمتش
    ممکن است ساختگی باشد). ولی مقدار USDC یا WETH داخل استخر، نقدینگی
    واقعی قابل خروج را نشان می‌دهد. این محافظه‌کارانه‌تر و صادقانه‌تر است.
    """
    known = chain.token(pool.paired_with)
    if known is None:
        return None
    erc = w3.eth.contract(address=Web3.to_checksum_address(known.address), abi=ERC20_ABI)
    bal, status = try_call(
        lambda: erc.functions.balanceOf(Web3.to_checksum_address(pool.address)).call())
    if status != "ok" or bal is None:
        return None
    amount = Decimal(bal) / (10 ** known.decimals)
    price = price_cache.get(pool.paired_with, Decimal(0))
    return amount * price


def quote_on_venue(w3: Web3, venue: Venue, token_in: str, token_out: str,
                   amount_in: int) -> Optional[int]:
    """یک کوت از یک مکان مشخص. None یعنی نشد — بدون اینکه بگوید چرا."""
    val, _ = quote_on_venue_st(w3, venue, token_in, token_out, amount_in)
    return val


def quote_on_venue_st(w3: Web3, venue: Venue, token_in: str, token_out: str,
                      amount_in: int):
    """
    مثل quote_on_venue ولی *دلیل* نشدن را هم برمی‌گرداند: (مقدار، وضعیت)
    وضعیت یکی از "ok" | "missing" | "rpc_error" است.

    ⚠️ چرا این تفکیک لازم شد: تابع بالا هر دو حالت را None می‌کرد، و
    check_tradability آن None را «نشانه‌ی جدی honeypot» می‌خواند. نتیجه‌اش
    این بود که cbETH — توکن استیکینگ کوین‌بیس — یافته‌ی بحرانی honeypot
    گرفت، فقط چون کوت فروشش در برابر USDC جواب نداده بود.

    «قرارداد revert کرد» شاهد است. «نتوانستیم بپرسیم» شاهد نیست.
    """
    dex = venue.dex
    ti = Web3.to_checksum_address(token_in)
    to = Web3.to_checksum_address(token_out)
    if dex.kind == KIND_V3:
        c = w3.eth.contract(address=Web3.to_checksum_address(dex.quoter),
                            abi=V3_QUOTER_ABI)
        q = lambda: c.functions.quoteExactInputSingle(
            (ti, to, amount_in, venue.fee_tier, 0)).call()[0]
    elif dex.kind == KIND_SOLIDLY:
        c = w3.eth.contract(address=Web3.to_checksum_address(dex.router),
                            abi=SOLIDLY_ROUTER_ABI)
        routes = [(ti, to, bool(venue.stable),
                   Web3.to_checksum_address(dex.factory))]
        q = lambda: c.functions.getAmountsOut(amount_in, routes).call()[-1]
    else:
        c = w3.eth.contract(address=Web3.to_checksum_address(dex.router),
                            abi=V2_ROUTER_ABI)
        q = lambda: c.functions.getAmountsOut(amount_in, [ti, to]).call()[-1]
    val, status = try_call(q)
    return (val if status == "ok" else None), status


def check_tradability(w3: Web3, chain: Chain, report: TokenReport,
                      token_addr: str, price_cache: Dict[str, Decimal]):
    """
    آیا می‌شود خرید؟ آیا می‌شود فروخت؟

    ⚠️ این کوت است، نه شبیه‌سازی کامل. یعنی می‌گوید «استخر ریاضیاً جواب می‌دهد»،
    نه «انتقال توکن واقعاً موفق می‌شود». یک honeypot که در تابع transfer
    شرط می‌گذارد، از این آزمون رد می‌شود. تشخیص کاملش نیاز به شبیه‌سازی دارد.
    """
    ref = chain.token(chain.reference)
    if ref is None:
        return

    # خرید: ۱۰۰ واحد ارز مرجع → توکن
    amount_in = 100 * (10 ** ref.decimals)
    best_out = None
    best_venue = None
    buy_unreachable = 0          # چند مکان اصلاً جواب ندادند (نه اینکه رد کردند)

    for dex in chain.dexes:
        for v in dex.variants():
            venue = Venue(dex, v["fee_tier"], v["stable"])
            out, st = quote_on_venue_st(w3, venue, ref.address, token_addr, amount_in)
            if st == "rpc_error":
                buy_unreachable += 1
                continue
            if out and out > 0 and (best_out is None or out > best_out):
                best_out, best_venue = out, venue

    if best_out:
        report.can_quote_buy = True
        # فروش: همان مقداری که خریدیم را برگردانیم
        back, back_st = quote_on_venue_st(w3, best_venue, token_addr, ref.address, best_out)
        if back_st == "rpc_error":
            # نتوانستیم بپرسیم. این هیچ چیزی درباره‌ی توکن نمی‌گوید و
            # نباید امتیاز خطر بگیرد.
            report.add("info", "کوت فروش سنجیده نشد",
                       "شبکه به کوت فروش جواب نداد، پس درباره‌ی فروش‌پذیری\n"
                       "       این توکن چیزی نمی‌دانیم — نه خوب، نه بد. دوباره تلاش کن.")
        elif back and back > 0:
            report.can_quote_sell = True
            ratio = Decimal(back) / Decimal(amount_in)
            loss_pct = (1 - ratio) * 100
            if loss_pct > 25:
                report.add("critical", "افت شدید در رفت‌وبرگشت",
                           f"خرید و فروش فوری {loss_pct:.1f}٪ از ارزش را می‌خورد.\n"
                           f"       این معمولاً یعنی کارمزد پنهان سنگین یا نقدینگی بسیار کم.")
            elif loss_pct > 10:
                report.add("high", "افت قابل توجه در رفت‌وبرگشت",
                           f"خرید و فروش فوری {loss_pct:.1f}٪ ضرر می‌دهد.")
            else:
                report.add("info", "رفت‌وبرگشت طبیعی ✓",
                           f"افت خرید و فروش فوری: {loss_pct:.1f}٪ (در حد کارمزد معمول)")
        else:
            report.add("critical", "کوت فروش رد شد",
                       "می‌شود خرید ولی قرارداد کوت فروش را رد کرد — نشانه‌ی جدی honeypot.")
    elif buy_unreachable:
        # همه‌ی مکان‌هایی که ممکن بود جواب بدهند، اصلاً پاسخ ندادند
        report.add("info", "خرید و فروش سنجیده نشد",
                   f"{buy_unreachable} مکان به کوت جواب ندادند، پس نه خرید و نه\n"
                   "       فروش آزموده شد. این «نمی‌شود خرید» نیست.")
    else:
        report.add("critical", "کوت خرید نگرفت",
                   "هیچ استخری برای خرید این توکن پیدا نشد یا نقدینگی صفر است.")


def build_price_cache(w3: Web3, chain: Chain) -> Dict[str, Decimal]:
    """قیمت توکن‌های شناخته‌شده به دلار (برای سنجش نقدینگی)."""
    cache: Dict[str, Decimal] = {}
    ref = chain.token(chain.reference)
    for sym, tok in chain.tokens.items():
        if tok.is_stable:
            cache[sym] = Decimal(1)
            continue
        if ref is None:
            continue
        probe = 10 ** tok.decimals
        best = None
        for dex in chain.dexes:
            for v in dex.variants():
                venue = Venue(dex, v["fee_tier"], v["stable"])
                out = quote_on_venue(w3, venue, tok.address, ref.address, probe)
                if out and (best is None or out > best):
                    best = out
        if best:
            cache[sym] = Decimal(best) / (10 ** ref.decimals)
    return cache


# ---------------------------------------------------------------------------

def scan_token(w3: Web3, chain: Chain, token_addr: str,
               price_cache: Optional[Dict[str, Decimal]] = None,
               verbose: bool = True) -> TokenReport:
    """اسکن کامل یک توکن."""
    addr = Web3.to_checksum_address(token_addr)
    report = TokenReport(address=addr)

    if verbose:
        print(f"  بررسی قرارداد ...", end="\r")
    code = check_basics(w3, report, addr)
    if code is None:
        return report

    check_bytecode(report, code)
    check_ownership(w3, report, addr)
    check_proxy(w3, report, addr)
    adjust_severity_by_ownership(report)

    if price_cache is None:
        if verbose:
            print("  قیمت‌گذاری توکن‌های مرجع ...", end="\r")
        price_cache = build_price_cache(w3, chain)

    if verbose:
        print("  جستجوی استخرها ...            ", end="\r")
    report.pools = find_pools(w3, chain, addr)

    total = Decimal(0)
    for p in report.pools:
        tvl = measure_pool_liquidity(w3, chain, p, addr, price_cache)
        p.tvl_usd = tvl
        if tvl:
            total += tvl
    report.total_liquidity_usd = total

    if not report.pools:
        report.add("critical", "هیچ استخری پیدا نشد",
                   "این توکن با هیچ‌کدام از توکن‌های شناخته‌شده استخر ندارد.")
    elif total < 5_000:
        report.add("critical", "نقدینگی بسیار کم",
                   f"مجموع نقدینگی قابل خروج: ${float(total):,.0f}\n"
                   f"       با این عمق، فروش مقدار قابل توجه تقریباً ناممکن است.")
    elif total < 50_000:
        report.add("high", "نقدینگی کم",
                   f"مجموع نقدینگی: ${float(total):,.0f} — اسلیپیج بالا خواهد بود.")
    else:
        report.add("info", "نقدینگی قابل قبول ✓",
                   f"مجموع نقدینگی قابل خروج: ${float(total):,.0f}")

    if verbose:
        print("  آزمون خرید و فروش ...        ", end="\r")
    check_tradability(w3, chain, report, addr, price_cache)

    if verbose:
        print(" " * 50, end="\r")
    return report
