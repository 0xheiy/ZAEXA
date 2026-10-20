#!/usr/bin/env bash
# =============================================================================
# لیست‌سفید کردن یک آداپتور (KIND_ADAPTER) روی SwapExecutor زنده (بدون دیپلوی جدید).
#
#   ./script/allow_adapter.sh <adapter-address>
#
# قبل از خرج شدن هیچ گسی:
#   • آداپتور باید کد داشته باشد و executor() آن همین SwapExecutor باشد
#   • allowedAdapter(adapter) خوانده می‌شود — اگر از قبل true بود، کاری
#     نمی‌کند و موفق خارج می‌شود
#   • فرستنده باید owner قرارداد باشد، وگرنه تراکنش اصلاً ارسال نمی‌شود
#
# بعد از ارسال:
#   • allowedAdapter از زنجیره دوباره خوانده می‌شود (با چند بار تلاش، چون
#     RPC ممکن است عقب باشد) و نتیجه‌ی نهایی روشن چاپ می‌شود
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ADAPTER="${1:-}"
if [ -z "$ADAPTER" ]; then
  echo "استفاده: ./script/allow_adapter.sh <adapter-address>"
  exit 1
fi
if [[ ! "$ADAPTER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "آدرس آداپتور معتبر نیست: $ADAPTER"
  exit 1
fi

EXECUTOR="0x15e511Bf2Ea1a0F50F25E973d57Dce0D01946b6d"

# ⚠️ این آدرس باید با CHAIN.executor در web/index.html یکی باشد، وگرنه
#    داریم قراردادِ اشتباهی را لیست‌سفید می‌کنیم.
WEB_EXEC=$(grep -oE 'executor:"0x[0-9a-fA-F]{40}"' ../web/index.html | head -1 | grep -oE '0x[0-9a-fA-F]{40}')
if [ -z "$WEB_EXEC" ]; then
  echo "نتوانستم CHAIN.executor را در web/index.html پیدا کنم — متوقف شد."
  exit 1
fi
if [ "${WEB_EXEC,,}" != "${EXECUTOR,,}" ]; then
  echo "آدرس اجراکننده در این اسکریپت ($EXECUTOR) با web/index.html ($WEB_EXEC) یکی نیست — متوقف شد."
  exit 1
fi

# --- RPC اختصاصی، دقیقاً مثل deploy.sh ---
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

# خواندن مقدار از زنجیره با تفکیک «نامعلوم» از «صفر/نادرست»
read_bool() {
  local out
  out=$("$@" 2>/dev/null)
  case "$out" in
    true|false) echo "$out" ;;
    *) echo "" ;;
  esac
}

echo "==============================================================="
echo " لیست‌سفید کردن آداپتور روی SwapExecutor"
echo "==============================================================="

echo
echo "[۱/۵] پیدا کردن RPC سالم ..."
RPC=""
for u in "${RPC_CANDIDATES[@]}"; do
  [ -z "$u" ] && continue
  ID=$(cast chain-id --rpc-url "$u" 2>/dev/null)
  if [ "$ID" = "8453" ]; then
    RPC="$u"; echo "      ✓ $(mask_rpc "$u")"; break
  fi
  echo "      ✗ $u"
done
[ -n "$RPC" ] || { echo "  هیچ RPCای جواب نداد. اتصال یا فیلترشکن را چک کن."; exit 1; }

echo
echo "[۲/۵] پیش‌بررسی‌ها ..."
CODE=$(cast code "$ADAPTER" --rpc-url "$RPC" 2>/dev/null)
if [ -z "$CODE" ] || [ "$CODE" = "0x" ]; then
  echo "      در $ADAPTER کدی پیدا نشد — شبکه جواب نداد یا آدرس اشتباه است. متوقف شد."
  exit 1
fi
echo "      آداپتور         : $ADAPTER (کد دارد)"

# 🔑 آداپتوری که executor() آن این SwapExecutor نباشد هیچ‌وقت نباید لیست‌سفید شود
ADAPTER_EXEC=$(cast call "$ADAPTER" "executor()(address)" --rpc-url "$RPC" 2>/dev/null)
if [ -z "$ADAPTER_EXEC" ]; then
  echo "      executor()   : نامعلوم — تماس شکست خورد (این آداپتور نیست؟). متوقف شد."
  exit 1
fi
echo "      executor()   : $ADAPTER_EXEC"
if [ "${ADAPTER_EXEC,,}" != "${EXECUTOR,,}" ]; then
  echo "      executor() این آداپتور با SwapExecutor یکی نیست — متوقف شد."
  exit 1
fi

CURRENT=$(read_bool cast call "$EXECUTOR" "allowedAdapter(address)(bool)" "$ADAPTER" --rpc-url "$RPC")
if [ -z "$CURRENT" ]; then
  echo "      نتوانستم allowedAdapter فعلی را بخوانم — شبکه جواب نداد. متوقف شد."
  exit 1
fi
echo "      allowedAdapter فعلی : $CURRENT"
if [ "$CURRENT" = "true" ]; then
  echo "      این آداپتور از قبل لیست‌سفید است — کاری لازم نیست."
  exit 0
fi

OWNER=$(cast call "$EXECUTOR" "owner()(address)" --rpc-url "$RPC" 2>/dev/null)
if [ -z "$OWNER" ]; then
  echo "      نتوانستم owner قرارداد را بخوانم — شبکه جواب نداد. متوقف شد."
  exit 1
fi
echo "      owner قرارداد : $OWNER"

echo
echo "[۳/۵] چیزی که ارسال می‌شود:"
echo "      شبکه          : Base  (RPC: $(mask_rpc "$RPC"))"
echo "      قرارداد       : $EXECUTOR"
echo "      تابع          : setAdapterAllowed($ADAPTER, true)"
echo
read -r -p "ادامه بدهم؟ این تراکنش واقعی است و گس خرج می‌کند. [yes/no] " OK
[ "$OK" = "yes" ] || { echo "لغو شد."; exit 0; }

echo
echo "[۴/۵] کلید خصوصی را وارد کن (چیزی روی صفحه نمایش داده نمی‌شود، بعد Enter):"
read -r -s PRIVATE_KEY
echo
[ -n "$PRIVATE_KEY" ] || { echo "کلید خالی بود."; exit 1; }
[[ "$PRIVATE_KEY" == 0x* ]] || PRIVATE_KEY="0x$PRIVATE_KEY"

SENDER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)
[ -n "$SENDER" ] || { echo "کلید نامعتبر است."; PRIVATE_KEY=""; exit 1; }
echo "      آدرس فرستنده : $SENDER"

if [ "${SENDER,,}" != "${OWNER,,}" ]; then
  echo "      فرستنده owner قرارداد نیست ($SENDER != $OWNER). متوقف شد — چیزی ارسال نشد."
  PRIVATE_KEY=""
  exit 1
fi

echo
echo "[۵/۵] ارسال تراکنش ..."
if cast send "$EXECUTOR" "setAdapterAllowed(address,bool)" "$ADAPTER" true \
     --rpc-url "$RPC" --private-key "$PRIVATE_KEY" > /tmp/zaexa-allow-adapter.log 2>&1; then
  echo "      تراکنش ارسال شد."
else
  echo "      ارسال ناموفق بود. لاگ:"
  tail -15 /tmp/zaexa-allow-adapter.log
  PRIVATE_KEY=""
  exit 1
fi
PRIVATE_KEY=""

# 🔑 حرف آخر را زنجیره می‌زند، نه خروجی cast send — RPC ممکن است عقب باشد
echo
echo "خواندن دوباره‌ی allowedAdapter از زنجیره ..."
FINAL=""
for i in 1 2 3 4 5; do
  sleep 4
  FINAL=$(read_bool cast call "$EXECUTOR" "allowedAdapter(address)(bool)" "$ADAPTER" --rpc-url "$RPC")
  [ "$FINAL" = "true" ] && break
  echo "      تلاش $i: هنوز $([ -z "$FINAL" ] && echo "نامعلوم" || echo "$FINAL") ..."
done

echo
if [ "$FINAL" = "true" ]; then
  echo "✅ allowedAdapter($ADAPTER) = true"
else
  echo "❌ هنوز true نشده (آخرین مقدار: $([ -z "$FINAL" ] && echo "نامعلوم — شبکه جواب نداد" || echo "$FINAL"))."
  echo "   چند دقیقه صبر کن و دوباره بزن:"
  echo "   cast call $EXECUTOR \"allowedAdapter(address)(bool)\" $ADAPTER --rpc-url \$RPC"
fi
