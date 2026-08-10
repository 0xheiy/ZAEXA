"""
ارزیابی توکن‌ها برای افزودن به فهرست مرجع.

⚠️ این ابزار هیچ‌وقت خودکار چیزی اضافه نمی‌کند — فقط گزارش می‌دهد.
   تصمیم و ویرایش chains.py با خودت است. این عمدی است: فهرست مرجع
   پایه‌ی قیمت‌گذاری همه‌چیز است و اگر یک توکن دستکاری‌شده واردش شود،
   همه‌ی محاسبات را خراب می‌کند.

استفاده:
    python3 suggest_tokens.py 0xToken1 0xToken2
    python3 suggest_tokens.py 0xToken --chain arbitrum
    python3 suggest_tokens.py --file tokens.txt
"""

import argparse
import os
import sys

from web3 import Web3

from chains import CHAINS
from discover_tokens import suggest_reference_tokens, format_report
from ratelimit import set_rate


def main():
    p = argparse.ArgumentParser()
    p.add_argument("tokens", nargs="*", help="آدرس یک یا چند توکن")
    p.add_argument("--file", default=None, help="فایل متنی، هر خط یک آدرس")
    p.add_argument("--chain", default="base", choices=list(CHAINS.keys()))
    p.add_argument("--rpc", default=None)
    p.add_argument("--rate", type=float, default=None)
    args = p.parse_args()

    if args.rate:
        set_rate(args.rate)

    addresses = list(args.tokens)
    if args.file:
        try:
            with open(args.file, encoding="utf-8") as f:
                for line in f:
                    line = line.split("#")[0].strip()
                    if line:
                        addresses.append(line)
        except Exception as e:
            print(f"❌ خواندن فایل ناموفق: {e}")
            sys.exit(1)

    if not addresses:
        print("❌ هیچ آدرسی داده نشد.")
        sys.exit(1)

    valid = []
    for a in addresses:
        try:
            valid.append(Web3.to_checksum_address(a))
        except Exception:
            print(f"⚠️ آدرس نامعتبر، رد شد: {a}")
    if not valid:
        sys.exit(1)

    chain = CHAINS[args.chain]

    from multirpc import MultiRPC
    mrpc = MultiRPC(chain.key, custom=args.rpc, env_var=chain.rpc_env)
    print("\nجستجوی RPC سالم ...")
    if not mrpc.probe():
        print("  ❌ هیچ RPC ای جواب نداد.")
        sys.exit(1)
    w3 = mrpc.web3()

    print(f"شبکه: {chain.name}")
    print(f"توکن‌های مرجع فعلی: {', '.join(chain.tokens.keys())}\n")

    results = suggest_reference_tokens(w3, chain, valid)
    print(format_report(results, chain))


if __name__ == "__main__":
    main()
