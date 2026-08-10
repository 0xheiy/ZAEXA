"""
اجرای سواپ — تبدیل برنامه‌ی مسیریابی به تراکنش.

⚠️ این ماژول پول واقعی جابه‌جا می‌کند. محافظت‌های چندلایه:
   ۱) حالت DRY_RUN پیش‌فرض روشن است — بدون تنظیم صریح، هیچ تراکنشی ارسال نمی‌شود
   ۲) قبل از ارسال، تراکنش با eth_call شبیه‌سازی می‌شود (رایگان)
   ۳) حداقل خروجی (minAmountOut) از برنامه محاسبه و به قرارداد پاس داده می‌شود
   ۴) بازبینی افت قیمت و رد کردن اگر بیش از حد مجاز باشد
   ۵) بررسی allowance و موجودی قبل از هر کاری
"""

import os
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import List, Optional, Tuple

from web3 import Web3

from chains import Chain, Token, KIND_V2, KIND_V3, KIND_SOLIDLY, ERC20_ABI
from router import SplitPlan, Route
from ratelimit import call_rpc, try_call

CONTRACT_KIND = {KIND_V2: 0, KIND_V3: 1, KIND_SOLIDLY: 2}

ZERO_ADDR = "0x0000000000000000000000000000000000000000"

SWAP_STEP_COMPONENTS = [
    {"name": "kind", "type": "uint8"},
    {"name": "router", "type": "address"},
    {"name": "tokenIn", "type": "address"},
    {"name": "tokenOut", "type": "address"},
    {"name": "feeTier", "type": "uint24"},
    {"name": "stable", "type": "bool"},
    {"name": "poolFactory", "type": "address"},
]

ROUTE_PART_COMPONENTS = [
    {"name": "steps", "type": "tuple[]", "components": SWAP_STEP_COMPONENTS},
    {"name": "amountIn", "type": "uint256"},
]

SWAP_EXECUTOR_ABI = [
    {
        "inputs": [
            {"name": "tokenIn", "type": "address"},
            {"name": "tokenOut", "type": "address"},
            {"name": "totalAmountIn", "type": "uint256"},
            {"name": "minAmountOut", "type": "uint256"},
            {"name": "parts", "type": "tuple[]", "components": ROUTE_PART_COMPONENTS},
            {"name": "deadline", "type": "uint256"},
        ],
        "name": "executeSwap",
        "outputs": [{"name": "amountOut", "type": "uint256"}],
        "stateMutability": "nonpayable", "type": "function",
    },
    {
        "inputs": [{"name": "", "type": "address"}],
        "name": "allowedRouter",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view", "type": "function",
    },
    {"inputs": [], "name": "feeBps",
     "outputs": [{"name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "owner",
     "outputs": [{"name": "", "type": "address"}],
     "stateMutability": "view", "type": "function"},
]

ERC20_FULL_ABI = ERC20_ABI + [
    {"constant": False,
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "name": "approve", "outputs": [{"name": "", "type": "bool"}], "type": "function"},
    {"constant": True,
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
     "name": "allowance", "outputs": [{"name": "", "type": "uint256"}], "type": "function"},
]


@dataclass
class ExecutionPlan:
    token_in: Token
    token_out: Token
    amount_in: int
    min_amount_out: int
    expected_out: int
    parts: list
    deadline: int
    slippage_bps: int


def build_steps(route: Route) -> list:
    """یک مسیر را به آرایه‌ی SwapStep برای قرارداد تبدیل می‌کند."""
    steps = []
    for hop in route.hops:
        v = hop.venue
        steps.append((
            CONTRACT_KIND[v.dex.kind],
            Web3.to_checksum_address(v.dex.router),
            Web3.to_checksum_address(hop.token_in.address),
            Web3.to_checksum_address(hop.token_out.address),
            v.fee_tier or 0,
            bool(v.stable) if v.stable is not None else False,
            Web3.to_checksum_address(v.dex.factory),
        ))
    return steps


def build_execution_plan(plan: SplitPlan, token_in: Token, token_out: Token,
                         slippage_bps: int = 50,
                         deadline_seconds: int = 120,
                         fee_bps: int = 0) -> ExecutionPlan:
    """
    برنامه‌ی مسیریابی را به ورودی قرارداد تبدیل می‌کند.

    ⚠️ نکته‌ی مهم درباره‌ی کارمزد:
       قرارداد کارمزد را از توکن *ورودی* کم می‌کند، پس مبلغی که واقعاً سواپ
       می‌شود کمتر از مبلغ اولیه است و خروجی هم به همان نسبت کمتر خواهد بود.
       اگر این را در minAmountOut لحاظ نکنیم، تراکنش بی‌دلیل revert می‌شود.
    """
    parts = []
    for route, amount in plan.parts:
        parts.append((build_steps(route), amount))

    # خروجی مورد انتظار پس از کسر کارمزد از ورودی
    expected_after_fee = plan.total_out * (10_000 - fee_bps) // 10_000
    min_out = expected_after_fee * (10_000 - slippage_bps) // 10_000

    return ExecutionPlan(
        token_in=token_in,
        token_out=token_out,
        amount_in=plan.total_in,
        min_amount_out=min_out,
        expected_out=expected_after_fee,
        parts=parts,
        deadline=int(time.time()) + deadline_seconds,
        slippage_bps=slippage_bps,
    )


# ---------------------------------------------------------------------------
# بررسی‌های پیش از اجرا
# ---------------------------------------------------------------------------

def read_fee_bps(w3: Web3, executor_addr: str) -> int:
    """کارمزد فعلی قرارداد را می‌خواند تا محاسبات با آن هماهنگ باشد."""
    ex = Web3.to_checksum_address(executor_addr)
    c = w3.eth.contract(address=ex, abi=SWAP_EXECUTOR_ABI)
    val, st = try_call(lambda: c.functions.feeBps().call())
    return int(val) if st == "ok" and val is not None else 0


def preflight_checks(w3: Web3, chain: Chain, executor_addr: str,
                     account_addr: str, ep: ExecutionPlan) -> List[str]:
    """
    همه‌ی چیزهایی که می‌تواند اشتباه برود را *قبل* از خرج کردن گس بررسی می‌کند.
    خروجی: فهرست مشکلات. خالی یعنی آماده‌ی اجراست.
    """
    problems = []
    ex = Web3.to_checksum_address(executor_addr)
    acct = Web3.to_checksum_address(account_addr)

    # ۱) قرارداد وجود دارد؟
    code, st = try_call(lambda: w3.eth.get_code(ex))
    if st != "ok" or not code or len(code) <= 2:
        problems.append(f"قراردادی در آدرس {ex} وجود ندارد")
        return problems

    executor = w3.eth.contract(address=ex, abi=SWAP_EXECUTOR_ABI)

    # ۲) همه‌ی روترهای برنامه در لیست سفید هستند؟
    routers = set()
    for steps, _ in ep.parts:
        for s in steps:
            routers.add(s[1])
    for r in routers:
        allowed, st = try_call(lambda: executor.functions.allowedRouter(r).call())
        if st != "ok":
            problems.append(f"بررسی لیست سفید روتر {r} ناموفق")
        elif not allowed:
            problems.append(
                f"روتر {r} در لیست سفید قرارداد نیست.\n"
                f"       owner باید setRouterAllowed را برایش صدا بزند.")

    # ۳) موجودی کافی است؟
    erc = w3.eth.contract(address=Web3.to_checksum_address(ep.token_in.address),
                          abi=ERC20_FULL_ABI)
    bal, st = try_call(lambda: erc.functions.balanceOf(acct).call())
    if st != "ok":
        problems.append("خواندن موجودی ناموفق")
    elif bal < ep.amount_in:
        have = Decimal(bal) / (10 ** ep.token_in.decimals)
        need = Decimal(ep.amount_in) / (10 ** ep.token_in.decimals)
        problems.append(f"موجودی کافی نیست: {have:,.6f} < {need:,.6f} {ep.token_in.symbol}")

    # ۴) allowance کافی است؟
    allw, st = try_call(lambda: erc.functions.allowance(acct, ex).call())
    if st != "ok":
        problems.append("خواندن allowance ناموفق")
    elif allw < ep.amount_in:
        problems.append(
            f"allowance کافی نیست: باید اول به قرارداد اجازه بدهی.\n"
            f"       approve({ex}, {ep.amount_in}) روی توکن {ep.token_in.symbol}")

    # ۵) موجودی گس
    nat, st = try_call(lambda: w3.eth.get_balance(acct))
    if st == "ok" and nat == 0:
        problems.append("موجودی توکن بومی (برای گس) صفر است")

    return problems


def simulate(w3: Web3, executor_addr: str, account_addr: str,
             ep: ExecutionPlan) -> Tuple[bool, str]:
    """
    شبیه‌سازی رایگان با eth_call.
    اگر اینجا شکست بخورد، تراکنش واقعی هم شکست می‌خورد — و گس هدر نمی‌رود.
    """
    ex = Web3.to_checksum_address(executor_addr)
    executor = w3.eth.contract(address=ex, abi=SWAP_EXECUTOR_ABI)
    fn = executor.functions.executeSwap(
        Web3.to_checksum_address(ep.token_in.address),
        Web3.to_checksum_address(ep.token_out.address),
        ep.amount_in,
        ep.min_amount_out,
        ep.parts,
        ep.deadline,
    )
    try:
        result = fn.call({"from": Web3.to_checksum_address(account_addr)})
        return True, f"شبیه‌سازی موفق — خروجی تخمینی: {result}"
    except Exception as e:
        return False, str(e)


def execute(w3: Web3, chain: Chain, executor_addr: str, account,
            ep: ExecutionPlan, dry_run: bool = True,
            gas_buffer_pct: int = 25) -> Optional[str]:
    """
    اجرای واقعی سواپ.

    dry_run=True (پیش‌فرض): همه‌ی بررسی‌ها و شبیه‌سازی انجام می‌شود ولی
    هیچ تراکنشی ارسال نمی‌شود.
    """
    ex = Web3.to_checksum_address(executor_addr)

    problems = preflight_checks(w3, chain, ex, account.address, ep)
    if problems:
        print("\n  ❌ بررسی‌های پیش از اجرا شکست خورد:")
        for p in problems:
            print(f"     • {p}")
        return None
    print("  ✓ بررسی‌های پیش از اجرا پاس شد")

    ok, msg = simulate(w3, ex, account.address, ep)
    if not ok:
        print(f"\n  ❌ شبیه‌سازی شکست خورد — تراکنش ارسال نشد (گس هدر نرفت)")
        print(f"     دلیل: {msg}")
        return None
    print(f"  ✓ {msg}")

    if dry_run:
        print("\n  🧪 حالت DRY RUN — تراکنشی ارسال نشد.")
        print("     برای اجرای واقعی: DRY_RUN=false")
        return None

    executor = w3.eth.contract(address=ex, abi=SWAP_EXECUTOR_ABI)
    fn = executor.functions.executeSwap(
        Web3.to_checksum_address(ep.token_in.address),
        Web3.to_checksum_address(ep.token_out.address),
        ep.amount_in, ep.min_amount_out, ep.parts, ep.deadline,
    )

    try:
        gas = fn.estimate_gas({"from": account.address})
        gas_limit = int(gas * (100 + gas_buffer_pct) / 100)
    except Exception as e:
        print(f"  ⚠️ تخمین گس ناموفق: {e}")
        return None

    try:
        base = w3.eth.get_block("latest").get("baseFeePerGas")
        params = {
            "from": account.address,
            "gas": gas_limit,
            "chainId": w3.eth.chain_id,
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
        }
        if base is not None:
            prio = w3.to_wei(0.005, "gwei")
            params["maxPriorityFeePerGas"] = prio
            params["maxFeePerGas"] = int(base * 2) + prio
        else:
            params["gasPrice"] = w3.eth.gas_price

        tx = fn.build_transaction(params)
        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    except Exception as e:
        print(f"  ❌ ارسال تراکنش ناموفق: {e}")
        return None

    # 🔑 از اینجا به بعد تراکنش *ارسال شده است*.
    #    هر خطایی که پیش بیاید فقط مربوط به خواندن نتیجه است، نه خود تراکنش.
    #    یک بار در عمل پیش آمد که RPC موقع خواندن رسید 403 داد و ابزار
    #    طوری رفتار کرد که انگار سواپ شکست خورده — در حالی که موفق بود.
    h = tx_hash.hex()
    if not h.startswith("0x"):
        h = "0x" + h

    print(f"\n  📤 ارسال شد: {h}")
    print(f"     {chain.explorer}/tx/{h}")

    try:
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    except Exception as e:
        print(f"\n  ⚠️ خواندن رسید ناموفق بود — ولی تراکنش ارسال شده است.")
        print(f"     دلیل: {type(e).__name__}")
        print(f"     وضعیت را خودت چک کن:")
        print(f"       cast receipt {h} --rpc-url https://1rpc.io/base")
        print(f"     یا در مرورگر: {chain.explorer}/tx/{h}")
        return h          # تراکنش واقعاً ارسال شده، پس هش را برمی‌گردانیم

    if receipt.status == 1:
        print(f"  ✅ موفق | گس مصرفی: {receipt.gasUsed:,}")
        return h
    print(f"  ❌ تراکنش revert شد | {chain.explorer}/tx/{h}")
    return None
