#!/usr/bin/env bash
# =============================================================================
# اجرای تست‌های fork بدون خوردن به سقف RPC عمومی.
#
#   ./script/fork_test.sh
#
# چه می‌کند:
#   ۱) یک شماره‌ی بلاک انتخاب و در .fork-block ذخیره می‌کند — و از آن به بعد
#      همیشه همان را استفاده می‌کند. اگر بلاک هر بار عوض شود، کش فورج هر بار
#      از صفر شروع می‌شود و دقیقاً به همان 429 می‌خوریم.
#   ۲) یک anvil محلی روی همان بلاک بالا می‌آورد. همه‌ی تست‌ها از *یک* نود
#      می‌خوانند، پس به‌جای پنج فورک موازی که هم‌زمان به RPC عمومی فشار
#      می‌آورند، فقط یک مصرف‌کننده داریم.
#   ۳) تست‌ها را مقابل anvil اجرا می‌کند و آخرش anvil را می‌بندد.
#
# اگر بار اول بعضی تست‌ها به خطای شبکه خوردند، دوباره اجرا کن: anvil و فورج
# هر دو کش دارند و دفعه‌ی بعد بخش بیشتری محلی جواب داده می‌شود.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1


# --- RPC اختصاصی ---
# اگر فایل contracts/.rpc وجود داشته باشد، خط اولش به‌عنوان RPC اصلی استفاده
# می‌شود. عمداً فایل جداست و در .gitignore هست: کلید API نه در کد می‌ماند،
# نه در زیپ، نه در گیت.
PRIVATE_RPC=""
[ -f ".rpc" ] && PRIVATE_RPC=$(head -1 .rpc | tr -d '[:space:]')

UPSTREAM="${UPSTREAM_RPC:-${PRIVATE_RPC:-https://base.drpc.org}}"
PORT="${ANVIL_PORT:-8545}"
LOCAL="http://127.0.0.1:${PORT}"
BLOCK_FILE=".fork-block"

command -v anvil >/dev/null || { echo "anvil پیدا نشد. foundryup را اجرا کن."; exit 1; }

# --- ۱) بلاک ثابت ---
if [ -s "$BLOCK_FILE" ]; then
  BLOCK=$(cat "$BLOCK_FILE")
  echo "استفاده از بلاک ذخیره‌شده: $BLOCK   (برای انتخاب بلاک تازه: rm $BLOCK_FILE)"
else
  echo "گرفتن شماره‌ی بلاک از $UPSTREAM ..."
  BLOCK=$(cast block-number --rpc-url "$UPSTREAM" 2>/dev/null)
  if ! [[ "$BLOCK" =~ ^[0-9]+$ ]]; then
    echo "نتوانستم شماره‌ی بلاک را بگیرم. RPC دیگری امتحان کن:"
    echo "  UPSTREAM_RPC=https://base.publicnode.com $0"
    exit 1
  fi
  # چند بلاک عقب‌تر: ریسک reorg و «بلاک هنوز منتشر نشده» را حذف می‌کند
  BLOCK=$((BLOCK - 20))
  echo "$BLOCK" > "$BLOCK_FILE"
  echo "بلاک انتخاب شد و ذخیره شد: $BLOCK"
fi

# --- ۲) anvil ---
if cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1; then
  echo "anvil از قبل روی $LOCAL بالاست — از همان استفاده می‌کنم."
  STARTED_HERE=0
else
  echo "بالا آوردن anvil روی پورت $PORT (fork از بلاک $BLOCK) ..."
  anvil --fork-url "$UPSTREAM" --fork-block-number "$BLOCK" \
        --port "$PORT" --silent > /tmp/anvil-zaexa.log 2>&1 &
  ANVIL_PID=$!
  STARTED_HERE=1
  trap 'kill $ANVIL_PID 2>/dev/null' EXIT

  READY=0
  for i in $(seq 1 60); do
    if cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1; then READY=1; break; fi
    sleep 1
  done
  if [ "$READY" -ne 1 ]; then
    echo "anvil بالا نیامد. لاگ:"
    tail -20 /tmp/anvil-zaexa.log
    exit 1
  fi
  echo "anvil آماده است."
fi

# --- ۳) تست‌ها ---
echo
echo "اجرای تست‌های fork مقابل نود محلی ..."
echo "---------------------------------------------------------------"
BASE_RPC_URL="$LOCAL" FORK_BLOCK="$BLOCK" \
  forge test --match-path 'test/SwapExecutor.fork.t.sol' -vv
STATUS=$?

echo "---------------------------------------------------------------"
if [ $STATUS -eq 0 ]; then
  echo "همه‌ی تست‌های fork سبز شدند."
else
  echo "بعضی تست‌ها شکست خوردند."
  echo "اگر دلیلش خطای شبکه بود، همین اسکریپت را دوباره اجرا کن —"
  echo "کش anvil و فورج پر شده و بار دوم معمولاً کامل رد می‌شود."
fi
exit $STATUS
