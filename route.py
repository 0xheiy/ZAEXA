"""
روتر هوشمند — رابط خط فرمان.

استفاده:
    python3 route.py 1000 USDC WETH
    python3 route.py 0.5 WETH AERO --chain base
    python3 route.py 1000 USDC 0xTokenAddress      # آدرس خام هم قبول است
    python3 route.py 5000 USDC WETH --no-split     # بدون تقسیم، برای مقایسه
"""

import argparse
import os
import sys
from decimal import Decimal

from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

from chains import CHAINS, Token, ERC20_ABI
from router import find_best_price, price_impact
from ratelimit import try_call, set_rate


def resolve_token(w3, chain, ident: str):
    """نماد یا آدرس را به Token تبدیل می‌کند."""
    t = chain.token(ident.upper()) or chain.token(ident)
    if t:
        return t
    # اگر آدرس است، اطلاعاتش را از زنجیره بخوان
    try:
        addr = Web3.to_checksum_address(ident)
    except Exception:
        return None
    c = w3.eth.contract(address=addr, abi=ERC20_ABI)
    sym, _ = try_call(lambda: c.functions.symbol().call(), default="?")
    dec, st = try_call(lambda: c.functions.decimals().call())
    if dec is None:
        # تفکیک «توکن نیست» از «شبکه جواب نداد»
        if st == "rpc_error":
            print(f"  ⚠️ خواندن اطلاعات {addr} به خطای شبکه خورد (نه اینکه توکن نباشد).")
            print(f"     امتحان کن: --rate 3  یا  --rpc آدرس_دیگر")
        return None
    return Token(symbol=sym or "?", address=addr, decimals=dec)


def fmt(amount: int, decimals: int, places: int = 6) -> str:
    v = Decimal(amount) / (10 ** decimals)
    return f"{v:,.{places}f}".rstrip("0").rstrip(".")


def diagnose_no_route(plan, tin, tout, chain):
    """وقتی مسیری پیدا نشد، بگو چرا — RPC یا واقعاً نبود استخر."""
    st = getattr(plan, "stats", None)
    print("\n  ❌ هیچ مسیری پیدا نشد.")
    if st is None:
        return
    print(f"     {st.attempted} کوت امتحان شد:")
    print(f"       • {st.no_pool} مورد: استخر وجود ندارد (نتیجه‌ی واقعی)")
    print(f"       • {st.rpc_failed} مورد: شبکه جواب نداد (نامعلوم)")
    if st.rpc_failed > 0:
        print(f"\n     ⚠️ {st.rpc_failed} درخواست به خطای شبکه خورد.")
        print(f"        یعنی این نتیجه قابل اتکا نیست. امتحان کن:")
        print(f"          --rate 3                 (کند کردن درخواست‌ها)")
        print(f"          --rpc https://base-rpc.publicnode.com")
    else:
        print(f"\n     این دو توکن روی {chain.name} استخر مشترکی ندارند.")


def main():
    p = argparse.ArgumentParser(description="روتر هوشمند")
    p.add_argument("amount", type=float, help="مقدار ورودی")
    p.add_argument("token_in", help="نماد یا آدرس توکن ورودی")
    p.add_argument("token_out", help="نماد یا آدرس توکن خروجی")
    p.add_argument("--chain", default="base", choices=list(CHAINS.keys()))
    p.add_argument("--rpc", default=None)
    p.add_argument("--rate", type=float, default=None)
    p.add_argument("--no-split", action="store_true", help="بدون تقسیم سفارش")
    p.add_argument("--no-multihop", action="store_true", help="فقط مسیر مستقیم")
    p.add_argument("--scan", action="store_true",
                   help="قبل از مسیریابی، توکن مقصد را از نظر ایمنی اسکن کن")
    args = p.parse_args()

    if args.rate:
        set_rate(args.rate)

    chain = CHAINS[args.chain]
    rpc = args.rpc or os.environ.get(chain.rpc_env) or chain.default_rpc

    from multirpc import MultiRPC
    mrpc = MultiRPC(chain.key, custom=args.rpc, env_var=chain.rpc_env)
    print("\nجستجوی RPC سالم ...")
    if not mrpc.probe():
        print("\n  ❌ هیچ‌کدام از RPCها جواب ندادند.")
        print("     اتصال اینترنتت را چک کن، یا با --rpc یک آدرس دیگر بده.")
        sys.exit(1)
    w3 = mrpc.web3()
    rpc = mrpc.current_url

    print(f"\nشبکه: {chain.name}  |  RPC: {rpc}")

    tin = resolve_token(w3, chain, args.token_in)
    tout = resolve_token(w3, chain, args.token_out)
    if tin is None:
        print(f"❌ توکن ورودی شناخته نشد: {args.token_in}")
        sys.exit(1)
    if tout is None:
        print(f"❌ توکن خروجی شناخته نشد: {args.token_out}")
        sys.exit(1)

    # --- اسکن ایمنی اختیاری ---
    if args.scan:
        from scanner import scan_token, build_price_cache
        print("\nاسکن ایمنی توکن مقصد ...")
        pc = build_price_cache(w3, chain)
        rep = scan_token(w3, chain, tout.address, pc, verbose=False)
        verdict, icon = rep.verdict()
        c = rep.counts()
        print(f"  {icon} {rep.symbol}: {verdict}  "
              f"(بحرانی={c['critical']} بالا={c['high']})")
        if c["critical"] > 0:
            print("  ⚠️ یافته‌ی بحرانی وجود دارد. برای جزئیات:")
            print(f"     python3 scan.py {tout.address}")
            ans = input("\n  با این حال ادامه می‌دهی؟ (y/n) ").strip().lower()
            if ans != "y":
                print("  لغو شد.")
                return

    amount_in = int(Decimal(str(args.amount)) * (10 ** tin.decimals))

    print(f"\n{'═'*78}")
    print(f"  {fmt(amount_in, tin.decimals)} {tin.symbol}  →  {tout.symbol}")
    print(f"{'═'*78}")

    plan = find_best_price(w3, chain, tin, tout, amount_in,
                           allow_multihop=not args.no_multihop,
                           allow_split=not args.no_split)

    if plan.total_out <= 0:
        diagnose_no_route(plan, tin, tout, chain)
        return

    # --- نتیجه ---
    out_str = fmt(plan.total_out, tout.decimals)
    rate = (Decimal(plan.total_out) / 10**tout.decimals) / (Decimal(amount_in) / 10**tin.decimals)
    print(f"\n  ✅ بهترین نتیجه: {out_str} {tout.symbol}")
    print(f"     نرخ: 1 {tin.symbol} = {rate:,.8f}".rstrip("0").rstrip(".") + f" {tout.symbol}")

    impact = price_impact(w3, chain, tin, tout, amount_in, plan,
                          allow_multihop=not args.no_multihop)
    if impact is not None:
        icon = "🔴" if impact > 5 else ("🟡" if impact > 1 else "🟢")
        print(f"     افت قیمت: {icon} {impact:.2f}%")
        if impact > 5:
            print(f"     ⚠️ افت قیمت بالاست — اندازه‌ی معامله نسبت به عمق استخر بزرگ است.")

    # --- برنامه‌ی اجرا ---
    print(f"\n  ── برنامه‌ی اجرا " + "─"*50)
    for route, amt in plan.parts:
        pct = Decimal(amt) / Decimal(plan.total_in) * 100
        out = route.amount_out if len(plan.parts) == 1 else None
        print(f"     {pct:5.1f}%  {fmt(amt, tin.decimals):>14} {tin.symbol}")
        print(f"            مسیر : {route.path_label}")
        print(f"            مکان : {route.venue_label}")

    if len(plan.parts) > 1 and plan.improvement_bps > 0:
        print(f"\n  💡 تقسیم سفارش {plan.improvement_bps:.1f} bps بهتر از یک استخر تنها بود")
        gain = Decimal(plan.total_out - plan.best_single_out) / (10**tout.decimals)
        print(f"     یعنی حدود {gain:,.6f} {tout.symbol} بیشتر".rstrip("0").rstrip("."))

    # --- بقیه‌ی مسیرها برای مقایسه ---
    others = getattr(plan, "all_routes", [])
    if len(others) > 1:
        print(f"\n  ── مقایسه‌ی مسیرها " + "─"*48)
        best_out = others[0].amount_out
        for r in others[:6]:
            diff = (Decimal(r.amount_out - best_out) / Decimal(best_out) * 100) if best_out else 0
            mark = "◆" if r is others[0] else " "
            print(f"   {mark} {fmt(r.amount_out, tout.decimals):>16} {tout.symbol}  "
                  f"({diff:+6.2f}%)  {r.path_label:<22} {r.venue_label}")
        if len(others) > 6:
            print(f"     ... و {len(others)-6} مسیر دیگر")

    print(f"\n{'═'*78}\n")
    print("یادآوری: این فقط محاسبه‌ی قیمت است، نه اجرای معامله.")
    print("قیمت‌ها لحظه‌ای‌اند و تا زمان اجرا ممکن است تغییر کنند.\n")


if __name__ == "__main__":
    main()
