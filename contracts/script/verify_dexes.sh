#!/usr/bin/env bash
# =============================================================================
# تأیید آدرس صرافی‌ها روی زنجیره — قبل از اینکه به Zaexa اضافه‌شان کنی.
#
# همان تکنیکی که باگ SwapRouter02 را گرفت: سلکتور تابعی که *واقعاً* صدا
# می‌زنیم را در بایت‌کد روتر می‌گردیم. اگر نبود، آن روتر آن تابع را ندارد و
# فراخوانی ما بدون هیچ پیامی revert می‌شود.
#
#   ./verify_dexes.sh
#   SWAP_EXECUTOR=0x… ./verify_dexes.sh
#
# خروجی برای هر صرافی یکی از سه حالت است — و سه‌حالتی بودنش کل نکته است:
#   PASS     دیدیم و درست بود
#   FAIL     دیدیم و غلط بود
#   UNKNOWN  اصلاً ندیدیم (شبکه جواب نداد) — این *نه* نیست
#
# نسخه‌ی قبلی `2>/dev/null` می‌زد و رشته‌ی خالی را «قراردادی آنجا نیست»
# می‌خواند. یعنی یک قطعی RPC، صرافی سالم را حذف‌شده نشان می‌داد و بدتر:
# روتری که همین حالا لیست‌سفید بود در فهرست «نیاز به لیست‌سفید» می‌رفت و
# یک `cast send` بی‌دلیل پیشنهاد می‌شد. گس واقعی برای هیچ.
# =============================================================================
set -uo pipefail

# --- RPC اختصاصی ---
# اگر فایل contracts/.rpc وجود داشته باشد، خط اولش به‌عنوان RPC اصلی استفاده
# می‌شود. عمداً فایل جداست و در .gitignore هست: کلید API نه در کد می‌ماند،
# نه در زیپ، نه در گیت.
PRIVATE_RPC=""
[ -f "$(dirname "$0")/../.rpc" ] && PRIVATE_RPC=$(head -1 "$(dirname "$0")/../.rpc" | tr -d '[:space:]')

RPC="${RPC:-${PRIVATE_RPC:-https://base.drpc.org}}"

# قرارداد فعال (ETH بومی، دیپلوی ۹ آگوست). پیش‌فرض قبلی `0x9fc4608f…` بود —
# یعنی قرارداد رهاشده‌ی باگ‌دار. یک بار یادت می‌رفت SWAP_EXECUTOR را ست کنی و
# اسکریپت بی‌صدا قرارداد اشتباه را گزارش می‌داد.
# آدرس پیش‌فرض از تنها منبع حقیقت خوانده می‌شود: CHAIN.executor در
# web/index.html. قبلاً اینجا v1 هاردکد بود — دو نسل عقب‌تر از قرارداد زنده،
# و کسی که اسکریپت را بی‌متغیر اجرا می‌کرد قرارداد اشتباه را می‌سنجید.
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

SIG_V3="exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
SIG_V3_LEGACY="exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"
SIG_V2="swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"
SIG_SOLIDLY="swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)"
# تابعی که برای کوت صدا می‌زنیم (QuoterV2). قبلاً فقط *وجود* قرارداد کوتر
# چک می‌شد — همان شکافی که یک قدم آن‌طرف‌تر باگ SwapRouter02 را ساخت.
SIG_QUOTER="quoteExactInputSingle((address,address,uint256,uint24,uint160))"

# نام|نوع|روتر|کوتر (کوتر فقط برای V3)
DEXES=(
  "Uniswap V3|v3|0x2626664c2603336E57B271c5C0b26F421741e481|0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"
  "Aerodrome|solidly|0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43|"
  "BaseSwap|v2|0x327Df1E6de05895d2ab08513aaDD9313Fe505d86|"
  "SushiSwap|v2|0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891|"
  "Alien Base|v2|0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7|"
  # روی زنجیره بررسی شد: بایت‌کد این روتر 0x414bf389 دارد و 0x04e45aaf ندارد،
  # یعنی نسل اول SwapRouter است. کوترش اما QuoterV2 است (0xc6a5026a).
  "PancakeSwap V3|v3legacy|0x1b81D678ffb9C0263b24A97847620C99d213eB14|0xB048Bbc1Ee6b733FFfCFb9e9cEF7375518e25997"
)

sig_for() {
  case "$1" in
    v3)        echo "$SIG_V3" ;;
    v3legacy)  echo "$SIG_V3_LEGACY" ;;
    solidly)   echo "$SIG_SOLIDLY" ;;
    *)         echo "$SIG_V2" ;;
  esac
}

# «پرسیدیم و این جواب بود» را از «اصلاً نپرسیدیم» جدا می‌کند.
# جواب روی stdout، وضعیت روی کد بازگشتی: 0 یعنی جواب گرفتیم، 1 یعنی نگرفتیم.
# خروجی خالی هم شکست حساب می‌شود؛ «0x» جواب معتبری است، خالی نیست.
try_cast() {
  local out rc
  out=$("$@" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then return 1; fi
  printf '%s' "$out"
  return 0
}

row() { printf '%-18s %-10s %s\n' "$1" "$2" "$3"; }

# آدرس RPC ممکن است کلید API داشته باشد — فقط میزبان را چاپ کن، نه کل URL.
RPC_HOST=$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/]+).*#\1#')

echo "Executor : $EXECUTOR"
echo "RPC      : $RPC_HOST"
echo

# --- دروازه: اول خود اجراکننده ---
# اگر این را چک نکنیم، آدرس غلط یا قطعی شبکه باعث می‌شود allowedRouter برای
# *همه* خالی برگردد و اسکریپت با اطمینان بگوید هیچ‌کدام لیست‌سفید نیستند.
if ! EXEC_CODE=$(try_cast cast code "$EXECUTOR" --rpc-url "$RPC"); then
  echo "The RPC did not answer while reading the executor. Nothing below would be"
  echo "trustworthy, so this run stops here. Try again, or set RPC to another endpoint."
  exit 2
fi
if [ "$EXEC_CODE" = "0x" ]; then
  echo "No contract at the executor address $EXECUTOR."
  echo "Set SWAP_EXECUTOR to the deployed address and run again."
  exit 2
fi

row "DEX" "RESULT" "DETAIL"
printf '%s\n' "-------------------------------------------------------------------------"

PASSED=()
UNSEEN=0          # آیا چیزی هست که نتوانستیم ببینیم؟

for entry in "${DEXES[@]}"; do
  IFS='|' read -r NAME KIND ROUTER QUOTER <<< "$entry"

  if ! CODE=$(try_cast cast code "$ROUTER" --rpc-url "$RPC"); then
    row "$NAME" "UNKNOWN" "the RPC did not answer — we learned nothing about $ROUTER"
    UNSEEN=1; continue
  fi
  if [ "$CODE" = "0x" ]; then
    row "$NAME" "FAIL" "no contract at $ROUTER"
    continue
  fi

  SIG=$(sig_for "$KIND")
  if ! SEL=$(try_cast cast sig "$SIG"); then
    row "$NAME" "UNKNOWN" "could not compute the selector locally — is foundry installed?"
    UNSEEN=1; continue
  fi
  SEL="${SEL#0x}"
  if ! grep -qi "$SEL" <<< "$CODE"; then
    row "$NAME" "FAIL" "selector 0x$SEL not in bytecode — wrong router generation"
    continue
  fi

  if [ "$KIND" = "v3" ] || [ "$KIND" = "v3legacy" ]; then
    if ! QCODE=$(try_cast cast code "$QUOTER" --rpc-url "$RPC"); then
      row "$NAME" "UNKNOWN" "the RPC did not answer for quoter $QUOTER"
      UNSEEN=1; continue
    fi
    if [ "$QCODE" = "0x" ]; then
      row "$NAME" "FAIL" "no contract at quoter $QUOTER"
      continue
    fi
    if ! QSEL=$(try_cast cast sig "$SIG_QUOTER"); then
      row "$NAME" "UNKNOWN" "could not compute the quoter selector locally"
      UNSEEN=1; continue
    fi
    QSEL="${QSEL#0x}"
    if ! grep -qi "$QSEL" <<< "$QCODE"; then
      row "$NAME" "FAIL" "quoter lacks 0x$QSEL — wrong quoter generation"
      continue
    fi
  fi

  if ! ALLOWED=$(try_cast cast call "$EXECUTOR" "allowedRouter(address)(bool)" "$ROUTER" --rpc-url "$RPC"); then
    row "$NAME" "PARTIAL" "router verified, but the allow-list could not be read — not suggesting a transaction"
    UNSEEN=1; continue
  fi
  case "$ALLOWED" in
    true)
      row "$NAME" "PASS" "verified and allow-listed" ;;
    false)
      row "$NAME" "PASS" "verified — still needs allow-listing"
      PASSED+=("$ROUTER") ;;
    *)
      # نه true نه false. یعنی نفهمیدیم — و «نفهمیدیم» هرگز نباید «false» شود،
      # چون false اینجا یعنی «برو گس خرج کن».
      row "$NAME" "PARTIAL" "allow-list answered '$ALLOWED', which is neither true nor false — not suggesting a transaction"
      UNSEEN=1 ;;
  esac
done

if [ "${#PASSED[@]}" -gt 0 ]; then
  echo
  echo "These routers are verified but not yet allow-listed on the executor."
  echo "To enable them (owner only):"
  echo
  JOINED=$(IFS=,; echo "${PASSED[*]}")
  echo "  cast send $EXECUTOR \"setRoutersAllowed(address[],bool)\" \\"
  echo "    \"[$JOINED]\" true --rpc-url \$RPC --private-key \$PRIVATE_KEY"
  echo
  echo "After that the web app picks them up on the next load."
fi

if [ "$UNSEEN" -eq 1 ]; then
  echo
  echo "NOTE: this run was incomplete — some rows are UNKNOWN or PARTIAL, which"
  echo "means the network did not answer, not that anything is wrong. Re-run"
  echo "before acting on the list above."
  exit 3
fi
