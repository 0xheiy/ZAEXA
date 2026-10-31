"""
روتر هوشمند — بهترین قیمت را بین همه‌ی صرافی‌ها پیدا می‌کند.

سه لایه:
  ۱) مسیر مستقیم    — A → B روی هر مکان ممکن
  ۲) مسیر چندمرحله‌ای — A → WETH → B یا A → USDC → B
                       (وقتی استخر مستقیم کم‌عمق است، عبور از یک توکن پرنقدینگ
                        می‌تواند نتیجه‌ی بهتری بدهد)
  ۳) تقسیم سفارش     — معامله بین چند استخر تقسیم می‌شود

چرا تقسیم کمک می‌کند؟
   در AMM، هرچه بیشتر بخری قیمت بدتر می‌شود (افت قیمت). اگر ۱۰۰۰۰ دلار را
   یکجا در یک استخر بزنی، آخرین دلارها با قیمت خیلی بدتری معامله می‌شوند.
   ولی اگر همان مبلغ بین دو استخر تقسیم شود، هیچ‌کدام تا آن حد فشرده نمی‌شوند.
   این دقیقاً کاری است که روترهای حرفه‌ای (1inch، Matcha) می‌کنند.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import List, Optional, Tuple, Dict

from web3 import Web3

from chains import (Chain, Dex, Venue, Token, KIND_V2, KIND_V3, KIND_SOLIDLY,
                    V3_QUOTER_ABI, V2_ROUTER_ABI, SOLIDLY_ROUTER_ABI)
from scanner import quote_on_venue
from ratelimit import try_call


@dataclass
class Hop:
    venue: Venue
    token_in: Token
    token_out: Token
    amount_in: int
    amount_out: int


@dataclass
class Route:
    hops: List[Hop]
    amount_in: int
    amount_out: int

    @property
    def path_label(self) -> str:
        if not self.hops:
            return "?"
        parts = [self.hops[0].token_in.symbol]
        for h in self.hops:
            parts.append(h.token_out.symbol)
        return " → ".join(parts)

    @property
    def venue_label(self) -> str:
        return " + ".join(h.venue.name for h in self.hops)


@dataclass
class SplitPlan:
    """برنامه‌ی نهایی: یک یا چند مسیر با سهم مشخص."""
    parts: List[Tuple[Route, int]] = field(default_factory=list)  # (مسیر، مبلغ ورودی)
    total_in: int = 0
    total_out: int = 0
    best_single_out: int = 0

    @property
    def improvement_bps(self) -> Decimal:
        if self.best_single_out <= 0:
            return Decimal(0)
        return (Decimal(self.total_out - self.best_single_out)
                / Decimal(self.best_single_out) * 10_000)


# ---------------------------------------------------------------------------

@dataclass
class QuoteStats:
    """آمار کوت‌گیری — برای تشخیص اینکه چرا مسیری پیدا نشد."""
    attempted: int = 0
    succeeded: int = 0
    no_pool: int = 0        # استخر وجود ندارد (revert) — نتیجه‌ی واقعی
    rpc_failed: int = 0     # شبکه جواب نداد — نتیجه نامعلوم

    @property
    def unreliable(self) -> bool:
        """اگر بخش زیادی از درخواست‌ها شکست خورده، نتیجه قابل اتکا نیست."""
        return self.attempted > 0 and self.rpc_failed / self.attempted > 0.25


def quote_tracked(w3: Web3, venue: Venue, token_in: str, token_out: str,
                  amount_in: int, stats: Optional[QuoteStats] = None) -> Optional[int]:
    """
    مثل quote_on_venue ولی آمار نگه می‌دارد.

    ⚠️ چرا لازم است: اگر خطای شبکه را از «استخر وجود ندارد» تفکیک نکنیم،
    ابزار در زمان قطعی RPC می‌گوید «هیچ مسیری نیست» — که غلط و گمراه‌کننده است.
    همان درسی که در اسکنر گرفتیم.
    """
    if stats is not None:
        stats.attempted += 1

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
    if stats is not None:
        if status == "ok" and val:
            stats.succeeded += 1
        elif status == "rpc_error":
            stats.rpc_failed += 1
        else:
            stats.no_pool += 1
    return val if status == "ok" else None


def all_venues(chain: Chain) -> List[Venue]:
    return [Venue(d, v["fee_tier"], v["stable"])
            for d in chain.dexes for v in d.variants()]


def direct_routes(w3: Web3, chain: Chain, token_in: Token, token_out: Token,
                  amount_in: int, stats: Optional[QuoteStats] = None) -> List[Route]:
    """همه‌ی مسیرهای مستقیم A → B."""
    routes = []
    for venue in all_venues(chain):
        out = quote_tracked(w3, venue, token_in.address, token_out.address,
                            amount_in, stats)
        if out and out > 0:
            hop = Hop(venue, token_in, token_out, amount_in, out)
            routes.append(Route([hop], amount_in, out))
    return routes


def multihop_routes(w3: Web3, chain: Chain, token_in: Token, token_out: Token,
                    amount_in: int, intermediates: Optional[List[str]] = None,
                    stats: Optional[QuoteStats] = None) -> List[Route]:
    """
    مسیرهای دو مرحله‌ای A → X → B.

    فقط از توکن‌های پرنقدینگ به‌عنوان واسط استفاده می‌کنیم (WETH، USDC)،
    چون عبور از توکن کم‌عمق نتیجه را بدتر می‌کند نه بهتر.
    """
    if intermediates is None:
        intermediates = [chain.wrapped_native, chain.reference]

    routes = []
    for mid_sym in intermediates:
        mid = chain.token(mid_sym)
        if mid is None:
            continue
        if mid.address.lower() in (token_in.address.lower(), token_out.address.lower()):
            continue

        # مرحله‌ی اول: بهترین مکان برای A → X
        best1, v1 = None, None
        for venue in all_venues(chain):
            out = quote_tracked(w3, venue, token_in.address, mid.address, amount_in, stats)
            if out and (best1 is None or out > best1):
                best1, v1 = out, venue
        if not best1:
            continue

        # مرحله‌ی دوم: بهترین مکان برای X → B با خروجی مرحله‌ی اول
        best2, v2 = None, None
        for venue in all_venues(chain):
            out = quote_tracked(w3, venue, mid.address, token_out.address, best1, stats)
            if out and (best2 is None or out > best2):
                best2, v2 = out, venue
        if not best2:
            continue

        hops = [Hop(v1, token_in, mid, amount_in, best1),
                Hop(v2, mid, token_out, best1, best2)]
        routes.append(Route(hops, amount_in, best2))

    return routes


def quote_route_at(w3: Web3, chain: Chain, route: Route, amount_in: int) -> Optional[int]:
    """همان مسیر را با مبلغ متفاوت دوباره کوت می‌گیرد (برای جستجوی تقسیم)."""
    amt = amount_in
    for hop in route.hops:
        out = quote_on_venue(w3, hop.venue, hop.token_in.address,
                             hop.token_out.address, amt)
        if not out or out <= 0:
            return None
        amt = out
    return amt


def find_best_split(w3: Web3, chain: Chain, routes: List[Route],
                    amount_in: int, max_parts: int = 2,
                    steps: int = 4) -> SplitPlan:
    """
    بهترین تقسیم بین دو مسیر برتر را پیدا می‌کند.

    روش: چند نسبت تقسیم را امتحان می‌کنیم (مثلاً ۱۰۰/۰، ۷۵/۲۵، ۵۰/۵۰، ...)
    و بهترین را برمی‌داریم.

    ⚠️ چرا فقط دو مسیر و چند نسبت؟ هر ترکیب نیاز به کوت جدید از شبکه دارد.
       جستجوی کامل ده‌ها درخواست می‌خواهد که با RPC عمومی عملی نیست.
       دو مسیر برتر معمولاً بیشتر فایده را می‌گیرند.
    """
    routes = sorted(routes, key=lambda r: -r.amount_out)
    plan = SplitPlan(total_in=amount_in)
    if not routes:
        return plan

    best = routes[0]
    plan.best_single_out = best.amount_out
    plan.parts = [(best, amount_in)]
    plan.total_out = best.amount_out

    if len(routes) < 2 or max_parts < 2:
        return plan

    second = routes[1]
    # فقط اگر مسیر دوم رقابتی باشد ارزش تقسیم دارد
    if second.amount_out < best.amount_out * 0.80:
        return plan

    for i in range(1, steps):
        frac = i / steps                      # سهم مسیر دوم
        a2 = int(amount_in * frac)
        a1 = amount_in - a2
        if a1 <= 0 or a2 <= 0:
            continue
        o1 = quote_route_at(w3, chain, best, a1)
        o2 = quote_route_at(w3, chain, second, a2)
        if o1 is None or o2 is None:
            continue
        total = o1 + o2
        if total > plan.total_out:
            plan.total_out = total
            plan.parts = [(best, a1), (second, a2)]

    return plan


def find_best_price(w3: Web3, chain: Chain, token_in: Token, token_out: Token,
                    amount_in: int, allow_multihop: bool = True,
                    allow_split: bool = True, verbose: bool = True) -> SplitPlan:
    """پیدا کردن بهترین قیمت با همه‌ی روش‌ها."""
    stats = QuoteStats()

    if verbose:
        print("  بررسی مسیرهای مستقیم ...          ", end="\r")
    routes = direct_routes(w3, chain, token_in, token_out, amount_in, stats)

    if allow_multihop:
        if verbose:
            print("  بررسی مسیرهای چندمرحله‌ای ...      ", end="\r")
        routes += multihop_routes(w3, chain, token_in, token_out, amount_in, stats=stats)

    if not routes:
        if verbose:
            print(" " * 50, end="\r")
        empty = SplitPlan(total_in=amount_in)
        empty.stats = stats
        return empty

    if allow_split:
        if verbose:
            print("  جستجوی بهترین تقسیم ...      ", end="\r")
        plan = find_best_split(w3, chain, routes, amount_in)
    else:
        best = max(routes, key=lambda r: r.amount_out)
        plan = SplitPlan(parts=[(best, amount_in)], total_in=amount_in,
                         total_out=best.amount_out, best_single_out=best.amount_out)

    if verbose:
        print(" " * 45, end="\r")
    plan.all_routes = sorted(routes, key=lambda r: -r.amount_out)
    plan.stats = stats
    return plan


def price_impact(w3: Web3, chain: Chain, token_in: Token, token_out: Token,
                 amount_in: int, plan: SplitPlan,
                 allow_multihop: bool = True) -> Optional[Decimal]:
    """
    افت قیمت: چقدر نرخ این معامله از نرخ یک معامله‌ی خیلی کوچک بدتر است.

    ⚠️ نکته‌ای که در نسخه‌ی اول اشتباه بود:
       معیار مقایسه باید از *همان مجموعه مسیرها* گرفته شود که برنامه‌ی نهایی
       از آن استفاده کرده. اگر معیار را فقط از مسیرهای مستقیم بگیریم ولی
       برنامه از مسیر چندمرحله‌ای استفاده کند، ممکن است افت *منفی* بدهد —
       که بی‌معناست و کاربر را گمراه می‌کند.
    """
    small = max(1, amount_in // 1000)

    small_routes = direct_routes(w3, chain, token_in, token_out, small)
    if allow_multihop:
        small_routes += multihop_routes(w3, chain, token_in, token_out, small)

    small_routes = [r for r in small_routes if r.amount_out > 0]
    if not small_routes:
        return None

    best_small = max(small_routes, key=lambda r: r.amount_out)
    rate_small = Decimal(best_small.amount_out) / Decimal(small)
    rate_big = Decimal(plan.total_out) / Decimal(amount_in)
    if rate_small <= 0:
        return None

    impact = (1 - rate_big / rate_small) * 100
    # افت منفی معنا ندارد؛ مقدار خیلی کوچک منفی فقط خطای گِردکردن است
    return max(Decimal(0), impact)
