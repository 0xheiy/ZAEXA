#!/usr/bin/env bash
# =============================================================================
# دیپلوی SwapExecutor روی Base + لیست سفید روترها، در یک مسیر.
#
#   ./script/deploy.sh
#
# قبل از خرج شدن هیچ گسی:
#   • تست‌های آفلاین اجرا می‌شوند و اگر قرمز باشند اسکریپت متوقف می‌شود
#   • آدرس‌ها و پارامترها نشان داده می‌شوند و از تو تأیید می‌گیرد
#
# بعد از دیپلوی:
#   • وجود کد در آدرس جدید چک می‌شود (forge create گاهی به‌غلط می‌گوید
#     «contract was not deployed» در حالی که واقعاً شده — این را جداگانه می‌سنجیم)
#   • روترها در یک تراکنش لیست سفید می‌شوند
#   • همه‌چیز در deployment.txt ذخیره می‌شود
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1


# --- RPC اختصاصی ---
# اگر فایل contracts/.rpc وجود داشته باشد، خط اولش به‌عنوان RPC اصلی استفاده
# می‌شود. عمداً فایل جداست و در .gitignore هست: کلید API نه در کد می‌ماند،
# نه در زیپ، نه در گیت.
PRIVATE_RPC=""
[ -f ".rpc" ] && PRIVATE_RPC=$(head -1 .rpc | tr -d '[:space:]')

# اگر RPC دستی داده شود اول امتحان می‌شود، بعد بقیه
RPC_CANDIDATES=(
  "${RPC:-}"
  "$PRIVATE_RPC"
  "https://base.drpc.org"
  "https://base.publicnode.com"
  "https://1rpc.io/base"
  "https://mainnet.base.org"
)
# ⚠️ آدرس RPC معمولاً کلید API دارد. هر جا چاپ می‌شود باید ماسک شود —
# یک بار همین اسکریپت کلید را در ترمینال چاپ کرد و کلید در یک چت لو رفت.
mask_rpc() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1/…#'; }

OWNER="${OWNER:-0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23}"
FEE_RECIPIENT="${FEE_RECIPIENT:-$OWNER}"
FEE_BPS="${FEE_BPS:-0}"
WETH_ADDR="${WETH_ADDR:-0x4200000000000000000000000000000000000006}"

# روترهایی که verify_dexes.sh تأییدشان کرده (کد دارند و سلکتور درست است).
# آخری PancakeSwap V3 است — نسل اول SwapRouter، با kind=3 در رابط.
ROUTERS="0x2626664c2603336E57B271c5C0b26F421741e481,\
0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43,\
0x327Df1E6de05895d2ab08513aaDD9313Fe505d86,\
0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891,\
0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7,\
0x1b81D678ffb9C0263b24A97847620C99d213eB14"

echo "==============================================================="
echo " دیپلوی SwapExecutor"
echo "==============================================================="

# --- انتخاب RPC سالم ---
# ⚠️ هیچ‌وقت خطای شبکه را «مقدار» حساب نمی‌کنیم. اگر RPCای جواب ندهد
#    می‌رویم سراغ بعدی؛ اگر هیچ‌کدام جواب ندادند، *می‌ایستیم* — نه اینکه
#    نتیجه‌ی نامعلوم را صفر بخوانیم.
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
# خروجی: عدد، یا رشته‌ی خالی اگر شبکه جواب نداد
read_uint() {
  local out
  out=$("$@" 2>/dev/null)
  [[ "$out" =~ ^[0-9]+$ ]] && echo "$out" || echo ""
}

# --- دروازه‌ی ۱: تست‌های آفلاین ---
echo
echo "[۱/۵] اجرای تست‌های آفلاین ..."
if ! forge test --no-match-path 'test/SwapExecutor.fork.t.sol' > /tmp/zaexa-test.log 2>&1; then
  echo "  تست‌ها قرمزند. دیپلوی متوقف شد."
  tail -30 /tmp/zaexa-test.log
  exit 1
fi
grep -E "tests passed|Suite result" /tmp/zaexa-test.log | tail -3
echo "  سبز."

# --- تأیید ---
echo
echo "[۲/۵] پارامترهای دیپلوی:"
echo "      شبکه          : Base  (RPC: $(mask_rpc "$RPC"))"
echo "      owner         : $OWNER"
echo "      feeRecipient  : $FEE_RECIPIENT"
echo "      کارمزد        : $FEE_BPS bps"
echo "      WETH          : $WETH_ADDR"
# شمارش واقعی، نه عدد هاردکدشده — عدد ثابت بعد از اضافه شدن پنکیک دروغ شد
ROUTER_COUNT=$(printf '%s' "$ROUTERS" | tr ',' '\n' | grep -c '^0x')
echo "      روترها        : $ROUTER_COUNT عدد (لیست سفید بعد از دیپلوی)"
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
forge create src/SwapExecutor.sol:SwapExecutor \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast \
  --constructor-args "$OWNER" "$FEE_RECIPIENT" "$FEE_BPS" "$WETH_ADDR" \
  > /tmp/zaexa-deploy.log 2>&1
DEPLOY_STATUS=$?

NEW=$(grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' /tmp/zaexa-deploy.log | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
[ -z "$NEW" ] && NEW="$EXPECTED"

# 🔑 حرف آخر را زنجیره می‌زند، نه خروجی forge
sleep 5
CODE=$(cast code "$NEW" --rpc-url "$RPC" 2>/dev/null)
if [ -z "$CODE" ] || [ "$CODE" = "0x" ]; then
  echo "  در $NEW کدی پیدا نشد. لاگ دیپلوی:"
  tail -25 /tmp/zaexa-deploy.log
  echo
  echo "  اگر تراکنش ارسال شده بود، ممکن است هنوز تأیید نشده باشد."
  echo "  چند ثانیه صبر کن و این را بزن:  cast code $NEW --rpc-url $RPC"
  exit 1
fi
echo "      قرارداد جدید : $NEW"
[ $DEPLOY_STATUS -ne 0 ] && echo "      (forge خطا داد ولی کد روی زنجیره هست — همان چیزی که قبلاً هم دیدیم)"

# --- لیست سفید ---
echo
echo "[۵/۵] لیست سفید روترها (یک تراکنش) ..."
if cast send "$NEW" "setRoutersAllowed(address[],bool)" "[$ROUTERS]" true \
     --rpc-url "$RPC" --private-key "$PRIVATE_KEY" > /tmp/zaexa-wl.log 2>&1; then
  echo "      انجام شد."
else
  echo "      ناموفق. بعداً دستی بزن:"
  echo "      cast send $NEW \"setRoutersAllowed(address[],bool)\" \"[$ROUTERS]\" true --rpc-url \$RPC --private-key \$PRIVATE_KEY"
  tail -10 /tmp/zaexa-wl.log
fi

{
  echo "Zaexa — SwapExecutor"
  echo "deployed_at : $(date -u +%FT%TZ)"
  echo "address     : $NEW"
  echo "owner       : $OWNER"
  echo "feeBps      : $FEE_BPS"
  echo "explorer    : https://basescan.org/address/$NEW"
} > deployment.txt

echo
echo "==============================================================="
echo " آدرس جدید: $NEW"
echo " https://basescan.org/address/$NEW"
echo "==============================================================="
echo
echo "چهار کار مانده:"
echo
echo "۱) آدرس را در رابط وب عوض کن:"
echo "   sed -i -E 's/(executor:\")0x[0-9a-fA-F]{40}/\\1$NEW/' ../web/index.html"
echo "   (و همین‌طور در web/test/stub-ethers.js، وگرنه دروازه‌ی سوم در تست‌ها"
echo "    بی‌صدا از کار می‌افتد چون آدرس‌ها دیگر match نمی‌شوند)"
echo "   sed -i -E 's/(EXEC   = \")0x[0-9a-fA-F]{40}/\\1$NEW/' ../web/test/stub-ethers.js"
echo
echo "۲) اسناد را هم عوض کن — وگرنه سوییت وب می‌افتد، و این عمدی است."
echo "   نگهبان [one address] در web/test/run.py می‌سنجد که هیچ سندی قرارداد"
echo "   بازنشسته را «Live contract» نخواند. یک بار همین اتفاق افتاد: هر دو"
echo "   README قرارداد v2 را زنده معرفی می‌کردند و verify_dexes.sh حتی v1 را."
echo "   سه کار:"
echo "     الف) خط Live contract در README.md و contracts/README.md → \$NEW"
echo "     ب)  آدرس قبلی را به جدول «Retired deployments» در README.md اضافه کن"
echo "         (با کلمه‌ی retired روی همان خط — نگهبان همان را می‌بیند)"
echo "     ج)  همان آدرس قبلی را به RETIRED_EXECUTORS در web/test/run.py اضافه کن"
echo
echo "۳) تأیید نهایی صرافی‌ها روی قرارداد جدید:"
echo "   (verify_dexes.sh حالا خودش آدرس را از CHAIN.executor می‌خواند، پس"
echo "    اگر مرحله‌ی ۱ را انجام داده‌ای، بدون متغیر هم درست کار می‌کند)"
echo "   ./script/verify_dexes.sh"
echo
echo "۴) تأیید سورس روی BaseScan — برای این پروژه اختیاری نیست:"
# بدون کلید، forge بی‌صدا می‌رود سراغ Sourcify و «موفق» می‌گوید — ولی README
# به basescan.org/…#code لینک می‌دهد و آن لینک همچنان سورس نشان نمی‌دهد. یک بار
# همین شد و سند تا نیم‌ساعت چیزی می‌گفت که کاربر با کلیک نمی‌دید.
if [ -z "${ETHERSCAN_API_KEY:-}" ]; then
  echo "   ⚠️  ETHERSCAN_API_KEY تنظیم نیست. اگر بدون آن اجرا کنی، تأیید روی"
  echo "       Sourcify انجام می‌شود نه BaseScan، و لینک #code در README"
  echo "       همچنان سورس نشان نمی‌دهد. کلید رایگان: etherscan.io/myapikey"
  echo "       export ETHERSCAN_API_KEY='...'"
fi
echo "   forge verify-contract $NEW src/SwapExecutor.sol:SwapExecutor \\"
echo "     --chain base --watch --etherscan-api-key \"\$ETHERSCAN_API_KEY\" \\"
echo "     --constructor-args \$(cast abi-encode 'c(address,address,uint256,address)' $OWNER $FEE_RECIPIENT $FEE_BPS $WETH_ADDR)"
echo "   بعدش با چشم خودت ببین، به پیام forge بسنده نکن:"
echo "   curl -s 'https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getsourcecode&address=$NEW&apikey='\"\$ETHERSCAN_API_KEY\" | head -c 120"
echo
echo "جزئیات در deployment.txt ذخیره شد."
