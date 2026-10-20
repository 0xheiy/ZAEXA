#!/usr/bin/env bash
# =============================================================================
# دیپلوی آداپتور Uniswap v4 روی Base (بدون دیپلوی دوباره‌ی SwapExecutor).
#
#   ./script/deploy_v4_adapter.sh
#
# قبل از خرج شدن هیچ گسی:
#   • تست‌های آفلاین اجرا می‌شوند و اگر قرمز باشند اسکریپت متوقف می‌شود
#   • وجود کد در PoolManager و SwapExecutor روی زنجیره چک می‌شود
#   • آدرس‌ها و پارامترها نشان داده می‌شوند و از تو تأیید می‌گیرد
#
# بعد از دیپلوی:
#   • وجود کد در آدرس جدید چک می‌شود
#   • immutableهای آداپتور (executor / poolManager / weth) از زنجیره خوانده
#     و با مقدار مورد انتظار مقایسه می‌شوند
#   • لیست‌سفید کردن در SwapExecutor جداست و عمداً خودکار نیست:
#     ./script/allow_adapter.sh <آدرس جدید>
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# --- RPC اختصاصی ---
# اگر فایل contracts/.rpc وجود داشته باشد، خط اولش به‌عنوان RPC اصلی استفاده
# می‌شود. عمداً فایل جداست و در .gitignore هست: کلید API نه در کد می‌ماند،
# نه در زیپ، نه در گیت.
PRIVATE_RPC=""
[ -f ".rpc" ] && PRIVATE_RPC=$(head -1 .rpc | tr -d '[:space:]')

RPC_CANDIDATES=(
  "${RPC:-}"
  "$PRIVATE_RPC"
  "https://base.drpc.org"
  "https://base.publicnode.com"
  "https://1rpc.io/base"
  "https://mainnet.base.org"
)
# ⚠️ آدرس RPC معمولاً کلید API دارد. هر جا چاپ می‌شود باید ماسک شود.
mask_rpc() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1/…#'; }

# اجراکننده‌ی زنده (v5) — باید با CHAIN.executor در web/index.html یکی باشد
EXECUTOR="${EXECUTOR:-0x15e511Bf2Ea1a0F50F25E973d57Dce0D01946b6d}"
# Uniswap v4 PoolManager روی Base (docs.uniswap.org/contracts/v4/deployments)
POOL_MANAGER="${POOL_MANAGER:-0x498581fF718922c3f8e6A244956aF099B2652b2b}"
WETH_ADDR="${WETH_ADDR:-0x4200000000000000000000000000000000000006}"

echo "==============================================================="
echo " دیپلوی آداپتور Uniswap v4"
echo "==============================================================="

WEB_EXEC=$(grep -oE 'executor:"0x[0-9a-fA-F]{40}"' ../web/index.html 2>/dev/null | head -1 | grep -oE '0x[0-9a-fA-F]{40}')
if [ -z "$WEB_EXEC" ]; then
  echo "نتوانستم CHAIN.executor را در web/index.html پیدا کنم — متوقف شد."
  exit 1
fi
if [ "${WEB_EXEC,,}" != "${EXECUTOR,,}" ]; then
  echo "آدرس اجراکننده در این اسکریپت ($EXECUTOR) با web/index.html ($WEB_EXEC) یکی نیست — متوقف شد."
  exit 1
fi

# --- انتخاب RPC سالم ---
# ⚠️ هیچ‌وقت خطای شبکه را «مقدار» حساب نمی‌کنیم. اگر RPCای جواب ندهد
#    می‌رویم سراغ بعدی؛ اگر هیچ‌کدام جواب ندادند، *می‌ایستیم*.
RPC=""
echo
echo "[۰/۵] پیدا کردن RPC سالم ..."
for u in "${RPC_CANDIDATES[@]}"; do
  [ -z "$u" ] && continue
  ID=$(cast chain-id --rpc-url "$u" 2>/dev/null)
  if [ "$ID" = "8453" ]; then
    RPC="$u"; echo "      ✓ $(mask_rpc "$u")"; break
  fi
  echo "      ✗ $u"
done
[ -n "$RPC" ] || { echo "  هیچ RPCای جواب نداد. اتصال یا فیلترشکن را چک کن."; exit 1; }

# خواندن مقدار از زنجیره با تفکیک «نامعلوم» از «صفر»
read_uint() {
  local out
  out=$("$@" 2>/dev/null)
  [[ "$out" =~ ^[0-9]+$ ]] && echo "$out" || echo ""
}

# --- دروازه‌ی ۱: تست‌های آفلاین ---
echo
echo "[۱/۵] اجرای تست‌های آفلاین ..."
if ! forge test --no-match-path 'test/*.fork.t.sol' > /tmp/zaexa-test.log 2>&1; then
  echo "  تست‌ها قرمزند. دیپلوی متوقف شد."
  tail -30 /tmp/zaexa-test.log
  exit 1
fi
grep -E "tests passed|Suite result" /tmp/zaexa-test.log | tail -3
echo "  سبز."

# --- پیش‌بررسی زنجیره ---
for NAME_ADDR in "SwapExecutor:$EXECUTOR" "PoolManager:$POOL_MANAGER" "WETH:$WETH_ADDR"; do
  N="${NAME_ADDR%%:*}"; A="${NAME_ADDR#*:}"
  C=$(cast code "$A" --rpc-url "$RPC" 2>/dev/null)
  if [ -z "$C" ] || [ "$C" = "0x" ]; then
    echo "  در $N ($A) کدی پیدا نشد — شبکه جواب نداد یا آدرس اشتباه است. متوقف شد."
    exit 1
  fi
done

# --- تأیید ---
echo
echo "[۲/۵] پارامترهای دیپلوی:"
echo "      شبکه          : Base  (RPC: $(mask_rpc "$RPC"))"
echo "      executor      : $EXECUTOR"
echo "      poolManager   : $POOL_MANAGER"
echo "      WETH          : $WETH_ADDR"
echo "      (لیست‌سفید در SwapExecutor بعد از دیپلوی و جدا انجام می‌شود)"
echo
read -r -p "ادامه بدهم؟ این تراکنش واقعی است و گس خرج می‌کند. [yes/no] " OK
[ "$OK" = "yes" ] || { echo "لغو شد."; exit 0; }

# --- کلید خصوصی ---
echo
echo "[۳/۵] کلید خصوصی را وارد کن (چیزی روی صفحه نمایش داده نمی‌شود، بعد Enter):"
read -r -s PRIVATE_KEY
echo
[ -n "$PRIVATE_KEY" ] || { echo "کلید خالی بود."; exit 1; }
[[ "$PRIVATE_KEY" == 0x* ]] || PRIVATE_KEY="0x$PRIVATE_KEY"

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)
[ -n "$DEPLOYER" ] || { echo "کلید نامعتبر است."; exit 1; }
echo "      آدرس فرستنده : $DEPLOYER"

BAL=$(read_uint cast balance "$DEPLOYER" --rpc-url "$RPC")
if [ -z "$BAL" ]; then
  # 🔑 نتیجه نامعلوم است، نه صفر. تصمیم با کاربر.
  echo "      موجودی ETH   : نامعلوم — شبکه جواب نداد (این یعنی «نمی‌دانم»، نه «صفر»)"
  read -r -p "      با این حال ادامه بدهم؟ [yes/no] " GO
  [ "$GO" = "yes" ] || { echo "لغو شد. با RPC دیگری امتحان کن: RPC=https://base.publicnode.com $0"; exit 1; }
elif [ "$BAL" = "0" ]; then
  echo "      موجودی ETH   : 0 — واقعاً گس نداری."
  exit 1
else
  echo "      موجودی ETH   : $(cast from-wei "$BAL" 2>/dev/null || echo "$BAL wei")"
fi

# --- دیپلوی ---
echo
echo "[۴/۵] دیپلوی ..."
NONCE=$(read_uint cast nonce "$DEPLOYER" --rpc-url "$RPC")
[ -n "$NONCE" ] || { echo "  نتوانستم nonce را بخوانم — شبکه جواب نداد. دوباره امتحان کن."; exit 1; }
EXPECTED=$(cast compute-address "$DEPLOYER" --nonce "$NONCE" --rpc-url "$RPC" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)

# ⚠️ --constructor-args باید آخرین آرگومان باشد، وگرنه بقیه را می‌بلعد
forge create src/UniswapV4Adapter.sol:UniswapV4Adapter \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast \
  --constructor-args "$POOL_MANAGER" "$WETH_ADDR" "$EXECUTOR" \
  > /tmp/zaexa-deploy-v4.log 2>&1
DEPLOY_STATUS=$?
PRIVATE_KEY=""

NEW=$(grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' /tmp/zaexa-deploy-v4.log | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
[ -z "$NEW" ] && NEW="$EXPECTED"

# 🔑 حرف آخر را زنجیره می‌زند، نه خروجی forge
sleep 5
CODE=$(cast code "$NEW" --rpc-url "$RPC" 2>/dev/null)
if [ -z "$CODE" ] || [ "$CODE" = "0x" ]; then
  echo "  در $NEW کدی پیدا نشد. لاگ دیپلوی:"
  tail -25 /tmp/zaexa-deploy-v4.log
  echo
  echo "  اگر تراکنش ارسال شده بود، ممکن است هنوز تأیید نشده باشد."
  echo "  چند ثانیه صبر کن و این را بزن:  cast code $NEW --rpc-url \$RPC"
  exit 1
fi
echo "      آداپتور جدید : $NEW"
[ $DEPLOY_STATUS -ne 0 ] && echo "      (forge خطا داد ولی کد روی زنجیره هست)"

# --- خواندن immutableها از زنجیره ---
echo
echo "[۵/۵] تطبیق immutableها با زنجیره ..."
BAD=0
check_imm() {  # نام تابع، مقدار مورد انتظار
  local got
  got=$(cast call "$NEW" "$1()(address)" --rpc-url "$RPC" 2>/dev/null)
  if [ -z "$got" ]; then
    echo "      $1() : نامعلوم — شبکه جواب نداد"; BAD=1
  elif [ "${got,,}" = "${2,,}" ]; then
    echo "      $1() : $got ✓"
  else
    echo "      $1() : $got ≠ $2 ✗"; BAD=1
  fi
}
check_imm executor    "$EXECUTOR"
check_imm poolManager "$POOL_MANAGER"
check_imm weth        "$WETH_ADDR"
if [ $BAD -ne 0 ]; then
  echo "  ❌ immutableها با مقدار مورد انتظار نمی‌خوانند. لیست‌سفید نکن."
  exit 1
fi

{
  echo "Zaexa — UniswapV4Adapter"
  echo "deployed_at : $(date -u +%FT%TZ)"
  echo "address     : $NEW"
  echo "executor    : $EXECUTOR"
  echo "poolManager : $POOL_MANAGER"
  echo "explorer    : https://basescan.org/address/$NEW"
} > deployment-v4-adapter.txt

echo
echo "==============================================================="
echo " آدرس جدید: $NEW"
echo " https://basescan.org/address/$NEW"
echo "==============================================================="
echo
echo "دو کار مانده:"
echo
echo "۱) لیست‌سفید در SwapExecutor (فقط owner می‌تواند):"
echo "   ./script/allow_adapter.sh $NEW"
echo
echo "۲) تأیید سورس روی BaseScan:"
if [ -z "${ETHERSCAN_API_KEY:-}" ]; then
  echo "   ⚠️  ETHERSCAN_API_KEY تنظیم نیست؛ بدون آن تأیید روی Sourcify می‌رود نه BaseScan."
  echo "       export ETHERSCAN_API_KEY='...'"
fi
echo "   forge verify-contract $NEW src/UniswapV4Adapter.sol:UniswapV4Adapter \\"
echo "     --chain base --watch --etherscan-api-key \"\$ETHERSCAN_API_KEY\" \\"
echo "     --constructor-args \$(cast abi-encode 'c(address,address,address)' $POOL_MANAGER $WETH_ADDR $EXECUTOR)"
echo
echo "جزئیات در deployment-v4-adapter.txt ذخیره شد."
