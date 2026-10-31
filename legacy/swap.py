"""
سواپ کامل — اسکن ایمنی، مسیریابی، و اجرا در یک دستور.

استفاده:
    # فقط نمایش (بدون ارسال تراکنش)
    python3 swap.py 100 USDC WETH

    # با اسکن ایمنی توکن مقصد
    python3 swap.py 100 USDC 0xNewToken --scan

    # اجرای واقعی (نیاز به کلید خصوصی و قرارداد دیپلوی‌شده)
    export ARBI_PRIVATE_KEY=0x...
    export SWAP_EXECUTOR=0x...
    DRY_RUN=false python3 swap.py 100 USDC WETH --execute

⚠️ بدون --execute هیچ‌وقت تراکنشی ارسال نمی‌شود.
⚠️ حتی با --execute، تا وقتی DRY_RUN=false نباشد فقط شبیه‌سازی می‌شود.
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
    t = chain.token(ident.upper()) or chain.token(ident)
    if t:
        return t
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
    s = f"{v:,.{places}f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


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
    p = argparse.ArgumentParser(description="سواپ کامل")
    p.add_argument("amount", type=float)
    p.add_argument("token_in")
    p.add_argument("token_out")
    p.add_argument("--chain", default="base", choices=list(CHAINS.keys()))
    p.add_argument("--rpc", default=None)
    p.add_argument("--rate", type=float, default=None)
    p.add_argument("--slippage", type=int, default=50,
                   help="حداکثر اسلیپیج مجاز به bps (پیش‌فرض ۵۰ = ۰.۵٪)")
    p.add_argument("--max-impact", type=float, default=5.0,
                   help="اگر افت قیمت از این درصد بیشتر بود، لغو کن")
    p.add_argument("--scan", action="store_true", help="اسکن ایمنی توکن مقصد")
    p.add_argument("--execute", action="store_true", help="آماده‌سازی برای اجرای واقعی")
    p.add_argument("--no-split", action="store_true")
    p.add_argument("--no-multihop", action="store_true")
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
    if tin is None or tout is None:
        print(f"❌ توکن شناخته نشد: {args.token_in if tin is None else args.token_out}")
        sys.exit(1)

    # ---------- مرحله ۱: اسکن ایمنی ----------
    if args.scan:
        from scanner import scan_token, build_price_cache
        print("\n── مرحله ۱: اسکن ایمنی " + "─" * 48)
        pc = build_price_cache(w3, chain)
        rep = scan_token(w3, chain, tout.address, pc, verbose=False)
        verdict, icon = rep.verdict()
        c = rep.counts()
        print(f"  {icon} {rep.symbol}: {verdict}")
        print(f"     امتیاز خطر {rep.risk_score()}/100 | "
              f"بحرانی={c['critical']} بالا={c['high']} | "
              f"نقدینگی ${float(rep.total_liquidity_usd):,.0f}")
        for f in rep.findings:
            if f.level in ("critical", "high"):
                print(f"     • {f.title}")
        if c["critical"] > 0:
            print(f"\n  ⚠️ یافته‌ی بحرانی وجود دارد.")
            print(f"     جزئیات کامل: python3 scan.py {tout.address}")
            try:
                ans = input("     ادامه می‌دهی؟ (y/n) ").strip().lower()
            except EOFError:
                ans = "n"
            if ans != "y":
                print("  لغو شد.")
                return

    # ---------- مرحله ۲: مسیریابی ----------
    amount_in = int(Decimal(str(args.amount)) * (10 ** tin.decimals))
    print(f"\n── مرحله ۲: مسیریابی " + "─" * 50)
    print(f"  {fmt(amount_in, tin.decimals)} {tin.symbol} → {tout.symbol}")

    plan = find_best_price(w3, chain, tin, tout, amount_in,
                           allow_multihop=not args.no_multihop,
                           allow_split=not args.no_split)
    if plan.total_out <= 0:
        diagnose_no_route(plan, tin, tout, chain)
        return

    print(f"\n  ✅ {fmt(plan.total_out, tout.decimals)} {tout.symbol}")
    impact = price_impact(w3, chain, tin, tout, amount_in, plan,
                          allow_multihop=not args.no_multihop)
    if impact is not None:
        icon = "🔴" if impact > 5 else ("🟡" if impact > 1 else "🟢")
        print(f"     افت قیمت: {icon} {impact:.2f}%")
        if float(impact) > args.max_impact:
            print(f"\n  ❌ افت قیمت از حد مجاز ({args.max_impact}%) بیشتر است — لغو شد.")
            print(f"     برای ادامه: --max-impact {float(impact)+1:.0f}")
            return

    for route, amt in plan.parts:
        pct = Decimal(amt) / Decimal(plan.total_in) * 100
        print(f"     {pct:5.1f}%  {route.path_label}  ({route.venue_label})")

    if len(plan.parts) > 1 and plan.improvement_bps > 0:
        print(f"     💡 تقسیم سفارش {plan.improvement_bps:.1f} bps بهتر بود")

    # ---------- مرحله ۳: اجرا ----------
    if not args.execute:
        print(f"\n  ℹ️ برای اجرا: --execute اضافه کن")
        print(f"     (حتی آن‌وقت هم تا DRY_RUN=false نباشد فقط شبیه‌سازی می‌شود)\n")
        return

    print(f"\n── مرحله ۳: اجرا " + "─" * 54)

    executor_addr = os.environ.get("SWAP_EXECUTOR")
    pk = os.environ.get("ARBI_PRIVATE_KEY")
    dry_run = os.environ.get("DRY_RUN", "true").lower() != "false"

    if not executor_addr:
        print("  ❌ متغیر SWAP_EXECUTOR تنظیم نشده (آدرس قرارداد دیپلوی‌شده)")
        return
    if not pk:
        print("  ❌ متغیر ARBI_PRIVATE_KEY تنظیم نشده")
        return

    from executor import build_execution_plan, execute, read_fee_bps
    account = w3.eth.account.from_key(pk)
    print(f"  کیف پول: {account.address}")
    print(f"  قرارداد: {executor_addr}")
    print(f"  حالت   : {'🧪 شبیه‌سازی (DRY RUN)' if dry_run else '⚠️  اجرای واقعی'}")

    fee_bps = read_fee_bps(w3, executor_addr)
    if fee_bps > 0:
        fee_amt = Decimal(amount_in) * fee_bps / 10_000
        print(f"  کارمزد : {fee_bps} bps = {fmt(int(fee_amt), tin.decimals)} {tin.symbol}"
              f"  (از توکن ورودی کسر می‌شود)")

    ep = build_execution_plan(plan, tin, tout, slippage_bps=args.slippage,
                              fee_bps=fee_bps)
    print(f"  حداقل خروجی قابل قبول: {fmt(ep.min_amount_out, tout.decimals)} {tout.symbol}"
          f"  (اسلیپیج {args.slippage} bps)")

    execute(w3, chain, executor_addr, account, ep, dry_run=dry_run)
    print()


if __name__ == "__main__":
    main()
