#!/usr/bin/env bash
# =============================================================================
# تأیید Aerodrome Slipstream (نقدینگی متمرکز) روی زنجیره — قبل از یک خط کد.
#
# چرا این اسکریپت قبل از هر تغییری در web/index.html اجرا می‌شود:
# ردیف Aerodrome فعلی ما نسل اول (Solidly، volatile/stable) است. توکن‌های
# تازه‌ی Base نقدینگی‌شان را در استخرهای CL آئرودروم باز می‌کنند، و ما آن
# لایه را اصلاً نداریم — روی ALIGN یونی‌سواپ ۴.۶ برابر بیشتر تحویل داد.
#
# Slipstream کلیدِ استخر را روی `tickSpacing` (int24) سوار می‌کند، نه روی
# `fee` (uint24). یعنی سلکتورِ سواپ و سلکتورِ کوت هر دو با V3 فرق دارند:
#
#   Slipstream  exactInputSingle((address,address,int24,...))   0xa026383e
#   Uniswap V3  exactInputSingle((address,address,uint24,...))  0x04e45aaf
#   Pancake     exactInputSingle((address,address,uint24,...))  0x414bf389
#
# اگر آدرس‌های Slipstream را زیر KIND.V3 بگذاریم، فراخوانی به تابعی می‌رود
# که وجود ندارد → revert بدون پیام → روی سایت «could not reach the network»
# برای مشکلی که اصلاً شبکه‌ای نیست. همان دامی که یک بار با SwapRouter02
# افتادیم.
#
# ⚠️ آدرس‌های زیر «کاندید» هستند، از مخزن رسمی aerodrome-finance/slipstream
#    برداشته شده‌اند و **هیچ‌کدام تا وقتی این اسکریپت PASS ندهد وارد کد
#    نمی‌شوند**. قاعده‌ی پروژه: هیچ آدرسی از حافظه یا از یک منبع وب نوشته
#    نمی‌شود.
#
# دو چکِ متقاطع این اسکریپت را خود-تصحیح می‌کند — یعنی اگر خودِ فهرست
# کاندیدها غلط باشد هم می‌فهمیم، نه اینکه فقط چیزی را که گفته‌ایم تأیید کند:
#   ۱) از روتر و کوتر می‌پرسیم factory()ِ خودشان کیست و با کاندید مقایسه
#      می‌کنیم. اگر به هم نخورند، این سه به یک دیپلوی تعلق ندارند.
#   ۲) از فکتوری استخر واقعی WETH/USDC و AERO/WETH را می‌خواهیم. اگر هیچ
#      استخری برنگردد، آن فکتوری هرچه باشد، فکتوریِ در استفاده نیست.
#
#   ./verify_slipstream.sh
#   SWAP_EXECUTOR=0x… RPC=https://… ./verify_slipstream.sh
#
# سه‌حالتی، مثل verify_dexes.sh — و همین سه‌حالتی بودن کل نکته است:
#   PASS     دیدیم و درست بود
#   FAIL     دیدیم و غلط بود
#   UNKNOWN  اصلاً ندیدیم (شبکه جواب نداد) — این *نه* نیست
# =============================================================================
set -uo pipefail

# --- RPC اختصاصی: کلید API نه در کد می‌ماند، نه در گیت ---
PRIVATE_RPC=""
[ -f "$(dirname "$0")/../.rpc" ] && PRIVATE_RPC=$(head -1 "$(dirname "$0")/../.rpc" | tr -d '[:space:]')
RPC="${RPC:-${PRIVATE_RPC:-https://base.drpc.org}}"

# آدرس اجراکننده از تنها منبع حقیقت خوانده می‌شود، نه هاردکد.
if [ -z "${SWAP_EXECUTOR:-}" ]; then
  _idx="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/web/index.html"
  SWAP_EXECUTOR="$(grep -o 'executor:"0x[0-9a-fA-F]\{40\}"' "$_idx" \
                   | head -1 | grep -o '0x[0-9a-fA-F]\{40\}')"
  if [ -z "$SWAP_EXECUTOR" ]; then
    echo "Could not read CHAIN.executor from $_idx - pass SWAP_EXECUTOR instead." >&2
    exit 1
  fi
fi
EXECUTOR="$SWAP_EXECUTOR"

# --- کاندیدها (aerodrome-finance/slipstream، بخش دیپلوی Base) ---
CL_FACTORY="0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"
CL_ROUTER="0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F"
CL_QUOTER="0x514c8B5f54112481E28028F1166Bd78501089259"

# توکن‌ها از فهرست تأییدشده‌ی خودمان (کاوشگر [checksum] در run.py می‌سنجدشان)
WETH="0x4200000000000000000000000000000000000006"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
AERO="0x940181a94A35A4569E4529A3CDfB74e38FD98631"

SIG_SWAP="exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"
SIG_QUOTE="quoteExactInputSingle((address,address,uint256,int24,uint160))"
SIG_GETPOOL="getPool(address,address,int24)"

command -v cast >/dev/null 2>&1 || { echo "foundry's 'cast' is not installed - install it and run again." >&2; exit 1; }

# «پرسیدیم و این جواب بود» را از «اصلاً نپرسیدیم» جدا می‌کند.
try_cast() {
  local out rc
  out=$("$@" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then return 1; fi
  printf '%s' "$out"
  return 0
}
row()  { printf '%-34s %-9s %s\n' "$1" "$2" "$3"; }
lower(){ printf '%s' "$1" | tr 'A-Z' 'a-z'; }

RPC_HOST=$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/]+).*#\1#')
echo "Executor : $EXECUTOR"
echo "RPC      : $RPC_HOST"
echo "Checking Aerodrome Slipstream (concentrated liquidity) candidates."
echo
row "CHECK" "RESULT" "DETAIL"
printf '%s\n' "---------------------------------------------------------------------------"

FAILED=0; UNSEEN=0
fail()    { row "$1" "FAIL"    "$2"; FAILED=1; }
unknown() { row "$1" "UNKNOWN" "$2"; UNSEEN=1; }

# --- دروازه ۰: خودِ شبکه. بدون این، هر «خالی» زیر به‌غلط «نیست» خوانده می‌شود.
if ! _probe=$(try_cast cast code "$WETH" --rpc-url "$RPC"); then
  echo "The RPC did not answer even for WETH. Nothing below would be trustworthy,"
  echo "so this run stops here. Try again, or set RPC to another endpoint."
  exit 2
fi

# --- دروازه ۱: کد در هر سه آدرس هست؟
for pair in "CL factory|$CL_FACTORY" "CL router|$CL_ROUTER" "CL quoter|$CL_QUOTER"; do
  NAME="${pair%%|*}"; ADDR="${pair##*|}"
  if ! CODE=$(try_cast cast code "$ADDR" --rpc-url "$RPC"); then
    unknown "$NAME has code" "the RPC did not answer for $ADDR"; continue
  fi
  if [ "$CODE" = "0x" ]; then
    fail "$NAME has code" "no contract at $ADDR"; continue
  fi
  row "$NAME has code" "PASS" "$ADDR"
  case "$NAME" in
    "CL router") ROUTER_CODE="$CODE" ;;
    "CL quoter") QUOTER_CODE="$CODE" ;;
    "CL factory") FACTORY_CODE="$CODE" ;;
  esac
done

# --- دروازه ۲: سلکتورِ تابعی که *واقعاً* صدا می‌زنیم در بایت‌کد هست؟
#     این همان چکی است که باگ SwapRouter02 را گرفت.
check_selector() {
  local label="$1" sig="$2" code="${3:-}"
  if [ -z "$code" ]; then unknown "$label" "no bytecode read earlier"; return; fi
  local sel
  if ! sel=$(try_cast cast sig "$sig"); then
    unknown "$label" "could not compute the selector locally"; return
  fi
  sel="${sel#0x}"
  if grep -qi "$sel" <<< "$code"; then
    row "$label" "PASS" "0x$sel present"
  else
    fail "$label" "0x$sel missing - wrong generation, the call would revert with no message"
  fi
}
check_selector "router has Slipstream swap"  "$SIG_SWAP"    "${ROUTER_CODE:-}"
check_selector "quoter has Slipstream quote" "$SIG_QUOTE"   "${QUOTER_CODE:-}"
check_selector "factory keys pools on ticks" "$SIG_GETPOOL" "${FACTORY_CODE:-}"

# --- دروازه ۳ (چک متقاطع): آیا این سه به یک دیپلوی تعلق دارند؟
#     اگر فهرست کاندیدها غلط باشد، اینجا لو می‌رود.
for pair in "router|$CL_ROUTER" "quoter|$CL_QUOTER"; do
  NAME="${pair%%|*}"; ADDR="${pair##*|}"
  if ! F=$(try_cast cast call "$ADDR" "factory()(address)" --rpc-url "$RPC"); then
    unknown "$NAME points at our factory" "the RPC did not answer"; continue
  fi
  F=$(printf '%s' "$F" | tr -d '[:space:]')
  if [ "$(lower "$F")" = "$(lower "$CL_FACTORY")" ]; then
    row "$NAME points at our factory" "PASS" "factory() == $CL_FACTORY"
  else
    fail "$NAME points at our factory" "factory() == $F, not $CL_FACTORY - these are not one deployment"
  fi
done

# --- دروازه ۴: tickSpacingهای واقعی. هرگز از حافظه ننویس‌شان.
SPACINGS=""
if ! TS=$(try_cast cast call "$CL_FACTORY" "tickSpacings()(int24[])" --rpc-url "$RPC"); then
  unknown "factory lists its tick spacings" "the RPC did not answer"
else
  SPACINGS=$(printf '%s' "$TS" | tr -d '[]' | tr ',' ' ')
  if [ -z "$(printf '%s' "$SPACINGS" | tr -d '[:space:]')" ]; then
    fail "factory lists its tick spacings" "tickSpacings() came back empty"
  else
    row "factory lists its tick spacings" "PASS" "$SPACINGS"
  fi
fi

# --- دروازه ۵: استخر واقعی هست؟ فکتوری‌ای که هیچ استخری ندارد، فکتوریِ در
#     استفاده نیست - هرچقدر هم که کد و سلکتور درست داشته باشد.
POOL_FOUND=0
FIRST_POOL=""; FIRST_SPACING=""
if [ -n "$SPACINGS" ]; then
  for duo in "WETH/USDC|$WETH|$USDC" "AERO/WETH|$AERO|$WETH"; do
    IFS='|' read -r PNAME A B <<< "$duo"
    HITS=""
    for s in $SPACINGS; do
      P=$(try_cast cast call "$CL_FACTORY" "getPool(address,address,int24)(address)" "$A" "$B" "$s" --rpc-url "$RPC") || continue
      P=$(printf '%s' "$P" | head -1 | tr -d '[:space:]')
      # آدرس صفر یعنی «چنین استخری نیست» — نه خطا، فقط نبود.
      [ "$(lower "$P")" = "0x0000000000000000000000000000000000000000" ] && continue
      case "$P" in 0x????????????????????????????????????????) ;; *) continue ;; esac
      HITS="$HITS tick=$s"
      if [ -z "$FIRST_POOL" ]; then FIRST_POOL="$P"; FIRST_SPACING="$s"; fi
    done
    if [ -n "$HITS" ]; then
      row "live pool $PNAME" "PASS" "$HITS"; POOL_FOUND=1
    else
      fail "live pool $PNAME" "the factory returned no pool at any tick spacing"
    fi
  done
else
  unknown "live pool lookup" "no tick spacings to try"
fi

# --- دروازه ۶: کوتر واقعاً عدد می‌دهد؟ وجود قرارداد کافی نیست.
if [ -n "$FIRST_SPACING" ]; then
  ONE_ETH="1000000000000000000"
  if ! Q=$(try_cast cast call "$CL_QUOTER" \
        "quoteExactInputSingle((address,address,uint256,int24,uint160))(uint256,uint160,uint32,uint256)" \
        "($WETH,$USDC,$ONE_ETH,$FIRST_SPACING,0)" --rpc-url "$RPC"); then
    unknown "quoter answers a real quote" "the call did not come back"
  else
    OUT=$(printf '%s\n' "$Q" | head -1 | tr -d '[:space:]')
    if [ -z "$OUT" ] || [ "$OUT" = "0" ]; then
      fail "quoter answers a real quote" "1 WETH -> USDC priced at 0 through tick=$FIRST_SPACING"
    else
      HUMAN=$(awk -v v="$OUT" 'BEGIN{printf "%.2f", v/1000000}' 2>/dev/null)
      row "quoter answers a real quote" "PASS" "1 WETH = $HUMAN USDC (tick=$FIRST_SPACING)"
    fi
  fi
else
  unknown "quoter answers a real quote" "no pool found to quote through"
fi

# --- دروازه ۷: آیا روتر تازه روی اجراکننده لیست‌سفید است؟
#     «نمی‌دانم» هرگز نباید به «نه» ترجمه شود - «نه» یعنی برو گس خرج کن.
NEEDS_ALLOW=0
if ! EXEC_CODE=$(try_cast cast code "$EXECUTOR" --rpc-url "$RPC"); then
  unknown "router is allow-listed" "the RPC did not answer for the executor"
elif [ "$EXEC_CODE" = "0x" ]; then
  fail "router is allow-listed" "no contract at the executor $EXECUTOR"
elif ! ALLOWED=$(try_cast cast call "$EXECUTOR" "allowedRouter(address)(bool)" "$CL_ROUTER" --rpc-url "$RPC"); then
  unknown "router is allow-listed" "the allow-list could not be read - not suggesting a transaction"
else
  case "$(printf '%s' "$ALLOWED" | tr -d '[:space:]')" in
    true)  row "router is allow-listed" "PASS" "already allowed" ;;
    false) row "router is allow-listed" "PASS" "not yet allowed - see the command below"; NEEDS_ALLOW=1 ;;
    *)     unknown "router is allow-listed" "answered '$ALLOWED', neither true nor false - not suggesting a transaction" ;;
  esac
fi

echo
echo "==========================================================================="
if [ "$FAILED" -eq 1 ]; then
  echo "VERDICT: FAIL - do NOT add these addresses to web/index.html."
  echo "At least one gate above says FAIL. Send this whole output back; the"
  echo "candidate list is wrong and has to be corrected before any code changes."
  exit 1
fi
if [ "$UNSEEN" -eq 1 ]; then
  echo "VERDICT: INCOMPLETE - some gates are UNKNOWN, which means the network did"
  echo "not answer, not that anything is wrong. Re-run before acting on this."
  exit 3
fi
echo "VERDICT: PASS - every gate answered and every answer was correct."
echo "Slipstream is real, in use, and safe to wire up as a new KIND."
if [ -n "$FIRST_POOL" ]; then
  echo "Sample live pool: $FIRST_POOL (tick spacing $FIRST_SPACING)"
fi
echo "Tick spacings to put in the DEXES row: $SPACINGS"
if [ "$NEEDS_ALLOW" -eq 1 ]; then
  echo
  echo "The router still needs allow-listing on the executor (owner only):"
  echo
  echo "  cast send $EXECUTOR \"setRoutersAllowed(address[],bool)\" \\"
  echo "    \"[$CL_ROUTER]\" true --rpc-url \$RPC --private-key \$PRIVATE_KEY"
fi
exit 0
