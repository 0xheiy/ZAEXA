"""
کشف توکن‌های مرجع — با تفکیک «پیشنهاد» از «پذیرش».

⚠️ چرا این تفکیک حیاتی است:
   اگر ابزار خودکار هر توکنی را به فهرست مرجع اضافه کند، یک کلاهبردار می‌تواند
   استخری با نقدینگی ظاهراً بالا بسازد (با توکن بی‌ارزش خودش)، باعث شود ابزار
   آن را «معتبر» ببیند، و از آن به بعد قیمت‌گذاری‌های ما را دستکاری کند.
   توکن مرجع فقط یک گزینه‌ی سواپ نیست — پایه‌ی محاسبه‌ی قیمت همه‌چیز است.

   پس این ماژول *هرگز* چیزی را خودکار اضافه نمی‌کند. فقط گزارش می‌دهد،
   و تو تصمیم می‌گیری.

فیلترهای امنیتی (همه باید پاس شوند):
   ۱) نقدینگی بالا در برابر *چند* توکن مرجع موجود — نه فقط یکی
   ۲) حضور در *چند* صرافی مستقل — دستکاری در یکی راحت است، در همه سخت
   ۳) اسکن ایمنی کامل (همان اسکنر) بدون یافته‌ی بحرانی
   ۴) قیمت سازگار بین مسیرهای مختلف — اختلاف زیاد یعنی دستکاری
   ۵) عمر قرارداد: توکن تازه‌ساخته هرگز مرجع نمی‌شود
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from web3 import Web3

from chains import (Chain, Token, Venue, ERC20_ABI, ZERO,
                    KIND_V2, KIND_V3, KIND_SOLIDLY,
                    V3_FACTORY_ABI, V2_FACTORY_ABI, SOLIDLY_FACTORY_ABI)
from ratelimit import try_call
from scanner import quote_on_venue, scan_token, build_price_cache


# --- آستانه‌های سخت‌گیرانه ---
MIN_LIQUIDITY_USD = 500_000        # حداقل نقدینگی کل
MIN_VENUES = 3                     # حداقل تعداد مکان مستقل
MIN_REFERENCE_PAIRS = 2            # با حداقل چند توکن مرجع موجود جفت داشته باشد
MAX_PRICE_DEVIATION_PCT = 3.0      # حداکثر اختلاف قیمت بین مسیرها
MAX_RISK_SCORE = 25                # حداکثر امتیاز خطر قابل قبول از اسکنر


@dataclass
class Candidate:
    address: str
    symbol: str
    decimals: int
    liquidity_usd: Decimal = Decimal(0)
    venue_count: int = 0
    reference_pairs: List[str] = field(default_factory=list)
    price_usd: Optional[Decimal] = None
    price_deviation_pct: Optional[Decimal] = None
    risk_score: Optional[int] = None
    critical_findings: int = 0
    rejections: List[str] = field(default_factory=list)
    unknowns: List[str] = field(default_factory=list)
    failed_quotes: int = 0

    @property
    def accepted(self) -> bool:
        return not self.rejections and not self.unknowns

    @property
    def undecided(self) -> bool:
        """نه رد شد، نه پذیرفته شد — فقط نتوانستیم بسنجیمش."""
        return bool(self.unknowns) and not self.rejections

    def reject(self, reason: str):
        """توکن را *سنجیدیم* و شرط را رد کرد."""
        self.rejections.append(reason)

    def unknown(self, reason: str):
        """نتوانستیم بسنجیم. این با «رد شد» یکی نیست و نباید یکی گزارش شود."""
        self.unknowns.append(reason)


def _pool_address(w3: Web3, venue: Venue, a: str, b: str) -> Optional[str]:
    dex = venue.dex
    fac = Web3.to_checksum_address(dex.factory)
    ta, tb = Web3.to_checksum_address(a), Web3.to_checksum_address(b)
    if dex.kind == KIND_V3:
        f = w3.eth.contract(address=fac, abi=V3_FACTORY_ABI)
        q = lambda: f.functions.getPool(ta, tb, venue.fee_tier).call()
    elif dex.kind == KIND_SOLIDLY:
        f = w3.eth.contract(address=fac, abi=SOLIDLY_FACTORY_ABI)
        q = lambda: f.functions.getPool(ta, tb, bool(venue.stable)).call()
    else:
        f = w3.eth.contract(address=fac, abi=V2_FACTORY_ABI)
        q = lambda: f.functions.getPair(ta, tb).call()
    addr, st = try_call(q)
    return addr if st == "ok" and addr and addr != ZERO else None


def _all_venues(chain: Chain) -> List[Venue]:
    return [Venue(d, v["fee_tier"], v["stable"])
            for d in chain.dexes for v in d.variants()]


def evaluate_candidate(w3: Web3, chain: Chain, token_addr: str,
                       price_cache: Dict[str, Decimal],
                       verbose: bool = True) -> Candidate:
    """
    یک توکن را برای مرجع شدن ارزیابی می‌کند.
    هیچ‌چیز را تغییر نمی‌دهد — فقط گزارش می‌دهد.
    """
    addr = Web3.to_checksum_address(token_addr)
    erc = w3.eth.contract(address=addr, abi=ERC20_ABI)
    sym, sym_st = try_call(lambda: erc.functions.symbol().call(), default="?")
    dec, st = try_call(lambda: erc.functions.decimals().call())

    c = Candidate(address=addr, symbol=sym or "?", decimals=dec or 18)

    # ⚠️ «نخواندیم» با «نیست» یکی نیست. try_call همین حالا سه حالت برمی‌گرداند
    #    (ok / missing / rpc_error) و قبلاً هر دوی آخری به یک پیامِ «ERC20
    #    معتبر نیست یا خوانده نشد» تبدیل می‌شد. نتیجه‌اش این بود که USDbC و
    #    DEGEN — دو توکن کاملاً استاندارد Base — «نامعتبر» گزارش شدند، چون
    #    RPC آن لحظه جواب نداده بود.
    if st == "rpc_error":
        c.unknown("قرارداد خوانده نشد — شبکه جواب نداد، نه اینکه ERC-20 نباشد")
        return c
    if st != "ok" or dec is None:
        c.reject("ERC20 معتبر نیست")
        return c
    # نماد خوانده‌نشده «?» نیست — نامعلوم است. بدون این، wstETH در گزارش
    # با نام «?» می‌آمد انگار قرارداد نامش را ندارد.
    if sym_st == "rpc_error":
        c.unknown("نماد خوانده نشد — شبکه جواب نداد")

    # --- فیلتر ۱ و ۲: نقدینگی و تعداد مکان ---
    venues = _all_venues(chain)
    total_liq = Decimal(0)
    seen_venues = set()
    paired_with = []
    # مکان‌هایی که استخرشان *با همان توکن مرجعِ قیمت‌گذاری* عمق دارد.
    # این با seen_venues فرق می‌کند و فرقش مهم است: seen_venues روی همه‌ی
    # مرجع‌ها پر می‌شود، ولی کوت قیمت فقط در برابر chain.reference گرفته
    # می‌شود. یک فی‌تیر می‌تواند استخر عمیق TOKEN/WETH داشته باشد و استخر
    # خالی TOKEN/USDC — و همان استخر خالی بود که «۴۲۳٬۲۲۶٪ اختلاف» می‌ساخت.
    ref_venues = set()

    for sym_ref, ref in chain.tokens.items():
        if ref.address.lower() == addr.lower():
            continue
        price_ref = price_cache.get(sym_ref)
        if price_ref is None:
            continue
        found_pair = False
        for v in venues:
            pool = _pool_address(w3, v, addr, ref.address)
            if not pool:
                continue
            ref_erc = w3.eth.contract(address=Web3.to_checksum_address(ref.address),
                                      abi=ERC20_ABI)
            bal, bst = try_call(
                lambda: ref_erc.functions.balanceOf(Web3.to_checksum_address(pool)).call())
            # استخری که موجودی‌اش را نتوانستیم بخوانیم، «خالی» نیست — نامعلوم
            # است. قبلاً بی‌صدا صفر حساب می‌شد، پس «نقدینگی کم» می‌توانست
            # فقط یعنی «شبکه جواب نداد».
            if bst == "rpc_error":
                c.failed_quotes += 1
                continue
            if bst != "ok" or not bal:
                continue
            val = Decimal(bal) / (10 ** ref.decimals) * price_ref
            if val > Decimal(1000):        # استخرهای ناچیز شمرده نشوند
                total_liq += val
                seen_venues.add(v.name)
                if sym_ref == chain.reference:
                    ref_venues.add(v.name)
                found_pair = True
        if found_pair:
            paired_with.append(sym_ref)

    c.liquidity_usd = total_liq
    c.venue_count = len(seen_venues)
    c.reference_pairs = paired_with

    # اگر بخشی از استخرها اصلاً خوانده نشدند، عددهای زیر ناقص‌اند و ادعای
    # قطعی روی‌شان («نقدینگی کم») غلط است. هر شکستی ادعا را نامعلوم می‌کند.
    if c.failed_quotes:
        c.unknown(f"{c.failed_quotes} استخر خوانده نشد — نقدینگی و تعداد مکان ناقص است")
    elif total_liq < Decimal(MIN_LIQUIDITY_USD):
        c.reject(f"نقدینگی کم: ${float(total_liq):,.0f} < ${MIN_LIQUIDITY_USD:,}")
    if not c.failed_quotes:
        if len(seen_venues) < MIN_VENUES:
            c.reject(f"فقط در {len(seen_venues)} مکان (حداقل {MIN_VENUES} لازم است)")
        if len(paired_with) < MIN_REFERENCE_PAIRS:
            c.reject(f"فقط با {len(paired_with)} توکن مرجع جفت دارد "
                     f"(حداقل {MIN_REFERENCE_PAIRS} لازم است)")

    # --- فیلتر ۳: سازگاری قیمت بین مسیرهای مختلف ---
    ref_tok = chain.token(chain.reference)
    if ref_tok:
        probe = 10 ** c.decimals
        prices = []
        for v in venues:
            # ⚠️ فقط مکان‌هایی که در شمارش نقدینگی هم به حساب آمدند. قبلاً
            #    min/max روی *همه‌ی* مکان‌ها گرفته می‌شد، بدون هیچ کف نقدینگی؛
            #    یک استخر متروکِ چنددلاری با قیمت پرت، lo را نزدیک صفر می‌کرد
            #    و نسبت منفجر می‌شد. عددهایی مثل «۴۲۳٬۲۱۹٪ اختلاف» واقعیت
            #    بازار نبودند، همان استخر خالی بودند.
            if v.name not in ref_venues:
                continue
            out = quote_on_venue(w3, v, addr, ref_tok.address, probe)
            if out and out > 0:
                prices.append(Decimal(out) / (10 ** ref_tok.decimals))
        if len(prices) >= 2:
            lo, hi = min(prices), max(prices)
            c.price_usd = sum(prices) / len(prices)
            if lo > 0:
                dev = (hi - lo) / lo * 100
                c.price_deviation_pct = dev
                if dev > Decimal(str(MAX_PRICE_DEVIATION_PCT)):
                    c.reject(f"اختلاف قیمت بین مسیرها {dev:.1f}٪ "
                             f"(بیش از {MAX_PRICE_DEVIATION_PCT}٪ — نشانه‌ی دستکاری)")
        elif len(prices) == 1:
            c.price_usd = prices[0]
            # با یک قیمت نمی‌شود سازگاری را سنجید — نه تأیید، نه رد
            c.unknown("فقط یک مسیر قیمت داد؛ سازگاری قیمت سنجیده نشد")
        else:
            c.unknown("هیچ مسیری قیمت نداد؛ سازگاری قیمت سنجیده نشد")

    # --- فیلتر ۴: اسکن ایمنی کامل ---
    try:
        rep = scan_token(w3, chain, addr, price_cache, verbose=False)
        c.risk_score = rep.risk_score()
        c.critical_findings = rep.counts()["critical"]
        if c.critical_findings > 0:
            c.reject(f"{c.critical_findings} یافته‌ی بحرانی در اسکن ایمنی")
        elif c.risk_score > MAX_RISK_SCORE:
            c.reject(f"امتیاز خطر {c.risk_score} (حداکثر {MAX_RISK_SCORE})")
    except Exception as e:
        # اسکن ایمنی که *اجرا نشد* هیچ چیزی درباره‌ی توکن نمی‌گوید. قبلاً
        # همین به «رد شد» ترجمه می‌شد و یک قطعی موقت RPC یک توکن سالم را
        # مردود می‌کرد.
        c.unknown(f"اسکن ایمنی اجرا نشد: {type(e).__name__}")

    return c


def suggest_reference_tokens(w3: Web3, chain: Chain, candidates: List[str],
                             verbose: bool = True) -> List[Candidate]:
    """
    فهرستی از آدرس‌ها را ارزیابی و گزارش می‌کند.

    ⚠️ این تابع هیچ فایلی را تغییر نمی‌دهد. خروجی فقط پیشنهاد است.
    """
    if verbose:
        print("قیمت‌گذاری توکن‌های مرجع فعلی ...", end="\r")
    price_cache = build_price_cache(w3, chain)
    if verbose:
        print(" " * 45, end="\r")

    results = []
    for i, addr in enumerate(candidates, 1):
        if verbose:
            print(f"  ارزیابی {i}/{len(candidates)} ...", end="\r")
        try:
            results.append(evaluate_candidate(w3, chain, addr, price_cache, verbose))
        except Exception as e:
            if verbose:
                print(f"  ⚠️ {addr}: {type(e).__name__}")
    if verbose:
        print(" " * 45, end="\r")
    return results


def format_report(results: List[Candidate], chain: Chain) -> str:
    """گزارش خوانا از نتایج ارزیابی."""
    lines = []
    accepted = [c for c in results if c.accepted]
    # سه سطل، نه دو تا: «رد شد» یک ادعاست، «نامعلوم» اعتراف به ندانستن.
    # قاطی‌کردنشان باعث شد USDbC و DEGEN «نامعتبر» گزارش شوند.
    rejected = [c for c in results if c.rejections]
    undecided = [c for c in results if c.undecided]

    lines.append("=" * 78)
    lines.append(f"  ارزیابی {len(results)} توکن برای افزودن به فهرست مرجع")
    lines.append("=" * 78)

    if accepted:
        lines.append(f"\n  ✅ {len(accepted)} توکن همه‌ی فیلترها را پاس کرد:\n")
        for c in accepted:
            lines.append(f"     {c.symbol}  ({c.address})")
            lines.append(f"       نقدینگی : ${float(c.liquidity_usd):,.0f}")
            lines.append(f"       مکان‌ها  : {c.venue_count}")
            lines.append(f"       جفت با  : {', '.join(c.reference_pairs)}")
            if c.price_usd:
                lines.append(f"       قیمت    : ${float(c.price_usd):,.6f}"
                             f"  (اختلاف مسیرها: {float(c.price_deviation_pct or 0):.2f}٪)")
            lines.append(f"       امتیاز خطر: {c.risk_score}/100")
            lines.append("")

        lines.append("  برای افزودن، این خطوط را در chains.py داخل tokens بگذار:")
        lines.append("")
        for c in accepted:
            stable = ", is_stable=True" if c.symbol.upper() in (
                "USDT", "DAI", "USDC", "USDBC", "FRAX", "LUSD") else ""
            lines.append(f'            "{c.symbol}": Token("{c.symbol}", '
                         f'"{c.address}", {c.decimals}{stable}),')
        lines.append("")
        lines.append("  ⚠️ قبل از افزودن، خودت هم آدرس را روی اکسپلورر تأیید کن.")
    else:
        lines.append("\n  هیچ توکنی همه‌ی فیلترها را پاس نکرد.")

    if rejected:
        lines.append(f"\n  ❌ {len(rejected)} توکن رد شد:\n")
        for c in rejected:
            lines.append(f"     {c.symbol} ({c.address[:10]}...)")
            for r in c.rejections:
                lines.append(f"       • {r}")
            for r in c.unknowns:
                lines.append(f"       ? {r}")
        lines.append("")

    if undecided:
        lines.append(f"\n  ❓ {len(undecided)} توکن سنجیده نشد "
                     f"(این «رد شد» نیست — دوباره اجرا کن، ترجیحاً با --rate کمتر "
                     f"یا یک --rpc اختصاصی):\n")
        for c in undecided:
            lines.append(f"     {c.symbol} ({c.address[:10]}...)")
            for r in c.unknowns:
                lines.append(f"       ? {r}")
            if c.liquidity_usd:
                lines.append(f"       (تا جایی که دیدیم: نقدینگی "
                             f"${float(c.liquidity_usd):,.0f} در {c.venue_count} مکان)")
        lines.append("")

    lines.append("=" * 78)
    return "\n".join(lines)
