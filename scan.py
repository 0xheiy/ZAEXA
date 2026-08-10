"""
اسکنر ایمنی توکن — رابط خط فرمان.

استفاده:
    python3 scan.py 0xTokenAddress
    python3 scan.py 0xToken1 0xToken2 --chain arbitrum
    python3 scan.py 0xToken --rpc https://base.drpc.org
"""

import argparse
import os
import sys

from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

from chains import CHAINS
from scanner import scan_token, build_price_cache, TokenReport

LEVEL_ICON = {
    "critical": "🔴",
    "high": "🟠",
    "medium": "🟡",
    "info": "🔵",
}
LEVEL_ORDER = {"critical": 0, "high": 1, "medium": 2, "info": 3}


def print_report(report: TokenReport, chain):
    line = "═" * 78
    print(f"\n{line}")
    verdict, icon = report.verdict()
    print(f"  {icon}  {report.symbol}  —  {report.name}")
    print(f"  {report.address}")
    print(line)

    if not report.is_contract:
        print("\n  ❌ این آدرس قرارداد نیست.\n")
        return

    # --- خلاصه ---
    print(f"\n  حکم کلی    : {verdict}")
    print(f"  امتیاز خطر : {report.risk_score()}/100")
    if report.decimals is not None:
        print(f"  اعشار      : {report.decimals}")
    if report.total_supply is not None and report.decimals is not None:
        supply = report.total_supply / (10 ** report.decimals)
        print(f"  کل عرضه    : {supply:,.0f}")
    print(f"  نقدینگی    : ${float(report.total_liquidity_usd):,.0f}")
    buy = "✓" if report.can_quote_buy else "✗"
    sell = "✓" if report.can_quote_sell else "✗"
    print(f"  خرید/فروش  : {buy} / {sell}")

    # --- استخرها ---
    if report.pools:
        print(f"\n  ── استخرها ({len(report.pools)}) " + "─" * 45)
        shown = sorted(report.pools,
                       key=lambda p: -(float(p.tvl_usd) if p.tvl_usd else 0))
        for p in shown[:10]:
            tvl = f"${float(p.tvl_usd):>12,.0f}" if p.tvl_usd else "            ?"
            print(f"     {tvl}   {p.venue_name:<26} با {p.paired_with}")
        if len(shown) > 10:
            print(f"     ... و {len(shown)-10} استخر دیگر")

    # --- یافته‌ها ---
    findings = sorted(report.findings, key=lambda f: LEVEL_ORDER.get(f.level, 9))
    if findings:
        print(f"\n  ── یافته‌ها " + "─" * 55)
        for f in findings:
            icon = LEVEL_ICON.get(f.level, "•")
            print(f"\n     {icon} {f.title}")
            for ln in f.detail.split("\n"):
                print(f"       {ln.strip()}")

    print(f"\n  🔗 {chain.explorer}/token/{report.address}")
    print(f"\n{line}\n")


def main():
    p = argparse.ArgumentParser(description="اسکنر ایمنی توکن")
    p.add_argument("tokens", nargs="+", help="آدرس یک یا چند توکن")
    p.add_argument("--chain", default="base", choices=list(CHAINS.keys()))
    p.add_argument("--rpc", default=None, help="آدرس RPC دلخواه")
    p.add_argument("--rate", type=float, default=None,
                   help="حداکثر درخواست در ثانیه (اگر خطای شبکه گرفتی کمش کن، مثلاً 3)")
    args = p.parse_args()

    if args.rate:
        from ratelimit import set_rate
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

    print(f"شبکه: {chain.name}")

    print("\nقیمت‌گذاری توکن‌های مرجع ...", end="\r")
    try:
        price_cache = build_price_cache(w3, chain)
        print(" " * 40, end="\r")
        prices = ", ".join(f"{k}=${float(v):,.2f}" for k, v in price_cache.items())
        print(f"قیمت‌های مرجع: {prices}")
    except Exception as e:
        print(f"⚠️ قیمت‌گذاری ناموفق: {e}")
        price_cache = {}

    for t in args.tokens:
        try:
            addr = Web3.to_checksum_address(t)
        except Exception:
            print(f"\n❌ آدرس نامعتبر: {t}")
            continue
        try:
            rep = scan_token(w3, chain, addr, price_cache)
            print_report(rep, chain)
        except Exception as e:
            print(f"\n❌ اسکن {t} ناموفق: {type(e).__name__}: {e}")

    print("یادآوری: این ابزار نشانه‌های خطر شناخته‌شده را پیدا می‌کند،")
    print("ولی «امن» بودن را تضمین نمی‌کند. همیشه خودت هم بررسی کن.\n")


if __name__ == "__main__":
    main()
