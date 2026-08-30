#!/usr/bin/env bash
# =============================================================================
# چقدر داریم از دست می‌دهیم؟ — مقایسه‌ی مسیر فعلی ما با استخرهای Slipstream.
#
# این اسکریپت هیچ چیزی را عوض نمی‌کند. فقط می‌پرسد و مقایسه می‌کند.
#
# چرا لازم است: می‌دانیم Aerodrome Slipstream (نقدینگی متمرکز) را نداریم و
# می‌دانیم قرارداد v4 نمی‌تواند از آن سواپ کند — پس اضافه‌کردنش یعنی دیپلوی
# قرارداد تازه، یعنی مهاجرت approveهای کاربرها. آن تصمیم را نباید با حدس
# گرفت. این اسکریپت حدس را به عدد تبدیل می‌کند: روی توکن‌های واقعی، همین
# الان، ما چقدر کمتر تحویل می‌دهیم؟
#
# روش: برای هر توکن، مقدار ثابتی WETH می‌دهیم و می‌پرسیم چقدر توکن برمی‌گردد
#   الف) از بهترین جایی که *امروز* داریم — یونی‌سواپ V3 (چهار fee tier)،
#        پنکیک V3 (چهار tier)، آئرودروم نسل اول (stable و volatile)
#   ب)  از بهترین استخر Slipstream (هر tickSpacing که فکتوری اعلام کند)
# و اختلاف را درصدی چاپ می‌کند.
#
# ⚠️ خروجی «کمتر تحویل می‌دهیم» فقط وقتی معنی دارد که هر دو طرف *جواب داده*
#    باشند. هر جا نپرسیده‌ایم یا جواب نگرفته‌ایم، صریح `?` می‌آید و در
#    جمع‌بندی شمرده نمی‌شود. «نمی‌دانم» هرگز نباید «صفر» شود.
#
#   ./compare_slipstream.sh
#   AMOUNT_ETH=0.2 ./compare_slipstream.sh
#   TOKENS=0xabc…,0xdef… ./compare_slipstream.sh      # توکن‌های دلخواه
#   RPC=https://… ./compare_slipstream.sh
#
# نکته: با RPC عمومی و ~۱۷ پرسش برای هر توکن ممکن است rate limit بخوری.
# اگر ردیف‌ها پر از `?` شد، RPC اختصاصی بگذار (contracts/.rpc) و دوباره بزن.
# =============================================================================
set -uo pipefail

PRIVATE_RPC=""
[ -f "$(dirname "$0")/../.rpc" ] && PRIVATE_RPC=$(head -1 "$(dirname "$0")/../.rpc" | tr -d '[:space:]')
RPC="${RPC:-${PRIVATE_RPC:-https://base.drpc.org}}"

command -v cast >/dev/null 2>&1 || { echo "foundry's 'cast' is not installed - install it and run again." >&2; exit 1; }

WETH="0x4200000000000000000000000000000000000006"

# --- امروز ما اینها را داریم (از web/index.html، ردیف‌های زنده) ---
UNI_QUOTER="0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";  UNI_TIERS="100 500 3000 10000"
PCS_QUOTER="0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";  PCS_TIERS="100 500 2500 10000"
AERO_ROUTER="0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"
AERO_FACTORY="0x420DD381b31aEf6683db6B902084cB0FFECe40Da"

# --- Slipstream (هر هفت دروازه‌ی verify_slipstream.sh را رد کرده‌اند) ---
CL_FACTORY="0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"
CL_QUOTER="0x514c8B5f54112481E28028F1166Bd78501089259"

SIG_Q_V3="quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)"
SIG_Q_CL="quoteExactInputSingle((address,address,uint256,int24,uint160))(uint256,uint160,uint32,uint256)"
SIG_SOLIDLY="getAmountsOut(uint256,(address,address,bool,address)[])(uint256[])"

# --- توکن‌های پیش‌فرض: مستقیم از فهرست خودِ اپ خوانده می‌شوند ---
# عمداً هیچ آدرسی اینجا هاردکد نیست. هر آدرسی که از حافظه نوشته شود یک
# چک‌سام غلط یا یک توکن اشتباه است که منتظر نشسته؛ فهرست index.html همان
# چیزی است که کاوشگر [checksum] در run.py می‌سنجد، پس تنها منبع درست است.
# اضافه‌شدن توکن تازه به اپ خودبه‌خود اینجا هم اضافه می‌شود.
if [ -z "${TOKENS:-}" ]; then
  _IDX="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/web/index.html"
  if [ ! -f "$_IDX" ]; then
    echo "Could not find $_IDX to read the token list from - pass TOKENS=0x…,0x… instead." >&2
    exit 1
  fi
  TOKENS=$(grep -o 'address:"0x[0-9a-fA-F]\{40\}",decimals:' "$_IDX" \
           | grep -o '0x[0-9a-fA-F]\{40\}' | sort -u | paste -sd, -)
  if [ -z "$TOKENS" ]; then
    echo "Read no token addresses out of $_IDX - pass TOKENS=0x…,0x… instead." >&2
    exit 1
  fi
fi

AMOUNT_ETH="${AMOUNT_ETH:-0.05}"
AMOUNT_WEI=$(cast to-wei "$AMOUNT_ETH" ether 2>/dev/null) || {
  echo "Could not convert AMOUNT_ETH=$AMOUNT_ETH to wei." >&2; exit 1; }
# مبلغ تقریباً هم‌ارز به دلار، برای اینکه دو مرجع قابل مقایسه بمانند.
AMOUNT_USD="${AMOUNT_USD:-120}"
USDC_ADDR="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
AMOUNT_USDC=$(awk -v a="$AMOUNT_USD" 'BEGIN{printf "%.0f", a*1000000}')
# قالب هر ردیف: آدرس؛نام؛مقدار
REF_SPECS="$WETH;WETH;$AMOUNT_WEI|$USDC_ADDR;USDC;$AMOUNT_USDC"

try_cast() {
  local out rc
  out=$("$@" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then return 1; fi
  printf '%s' "$out"
  return 0
}
# ⚠️ foundry اعداد بزرگ را با یک پسوند علمی چاپ می‌کند:
#     122663778 [1.226e8]
# اولین نسخه‌ی این اسکریپت اول `[` و `]` را حذف می‌کرد و بعد رقم‌ها را
# برمی‌داشت — یعنی همان `1` ابتدای `1.226e8` به ته عدد می‌چسبید و خروجی
# ۱۰ برابر می‌شد. نتیجه‌اش این بود که پنج توکنِ بی‌ربط همگی دقیقاً ≈۹۰٪
# اختلاف نشان دادند و آن عدد شبیه یک کشف به نظر می‌رسید. نبود.
# پس اول پسوند علمی حذف می‌شود، بعد براکت آرایه.
strip_sci() { sed -E 's/\[[0-9.]+e[0-9]+\]//g'; }

# اولین مقدارِ یک خروجی چندخطی (کوترها چهار مقدار برمی‌گردانند).
first_num() { printf '%s\n' "$1" | strip_sci | head -1 | tr -d '[:space:]' | sed -E 's/[^0-9].*$//'; }

# آخرین عضو یک آرایه‌ی uint256 — مقدار نهایی مسیر در getAmountsOut.
last_of_array() {
  printf '%s\n' "$1" | strip_sci | tr -d '[]' | tr ',' '\n' \
    | tail -1 | tr -d '[:space:]' | sed -E 's/[^0-9].*$//'
}

# --- خودآزمون پارسرها ---
# چند میلی‌ثانیه، بدون شبکه. اگر روزی قالب خروجی foundry عوض شود، اسکریپت
# صریح می‌ایستد به‌جای اینکه عددهای ۱۰ برابر را با اطمینان چاپ کند.
self_test_parsers() {
  local bad=0 got
  got=$(first_num "122663778 [1.226e8]");        [ "$got" = "122663778" ] || { echo "parser self-test: first_num with a scientific suffix gave '$got'" >&2; bad=1; }
  got=$(first_num "122663778");                   [ "$got" = "122663778" ] || { echo "parser self-test: first_num plain gave '$got'" >&2; bad=1; }
  got=$(first_num $'122663778 [1.226e8]\n79228\n3'); [ "$got" = "122663778" ] || { echo "parser self-test: first_num multiline gave '$got'" >&2; bad=1; }
  got=$(last_of_array "[50000000000000000 [5e16], 122663778 [1.226e8]]"); [ "$got" = "122663778" ] || { echo "parser self-test: last_of_array with suffixes gave '$got'" >&2; bad=1; }
  got=$(last_of_array "[50000000000000000, 122663778]");                  [ "$got" = "122663778" ] || { echo "parser self-test: last_of_array plain gave '$got'" >&2; bad=1; }
  if [ "$bad" -ne 0 ]; then
    echo "Refusing to run: foundry's output format is not what these parsers expect," >&2
    echo "and a mis-parsed amount looks exactly like a market finding. Fix the parsers first." >&2
    exit 4
  fi
}
self_test_parsers

DELAY="${DELAY:-0.15}"
# 📌 فقط حالتِ «نمی‌دانم» دوباره تلاش می‌شود، هرگز «استخر نیست».
#    یک تماسِ بدشانس نباید یک جفتِ کامل را از تحلیل حذف کند — یک بار
#    همین اتفاق افتاد و جفت ALIGN/USDC، یعنی دقیقاً همان چیزی که
#    دنبالش بودیم، بی‌سروصدا کنار گذاشته شد.
RETRIES="${RETRIES:-2}"
# --- لایه‌ی فراخوانی سه‌حالته ------------------------------------------------
# 📌 «استخر نیست» فقط وقتی گفته می‌شود که خطا *صریحاً* revert باشد. هر چیز
#    دیگری (429، timeout، پیام ناشناخته) «نمی‌دانم» است. یکی‌گرفتنِ این دو
#    یعنی throttleِ RPC به‌صورت «این توکن استخر Slipstream ندارد» گزارش شود —
#    و کل نتیجه‌گیریِ این اسکریپت روی همان ردیف‌ها بنا می‌شود.
CALL_OUT=""; CALL_STATE=""
ASKED=0; ANSWERED=0; NOPOOL=0; UNSEEN=0
probe_call() {
  local err out rc attempt=0
  while :; do
    err=$(mktemp); out=$(cast "$@" 2>"$err"); rc=$?
    sleep "$DELAY"
    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
      ASKED=$((ASKED+1)); ANSWERED=$((ANSWERED+1))
      CALL_OUT="$out"; CALL_STATE="ok"; rm -f "$err"; return 0
    fi
    if grep -qiE 'execution reverted|revert' "$err"; then
      ASKED=$((ASKED+1)); NOPOOL=$((NOPOOL+1))
      CALL_STATE="nopool"; CALL_OUT=""; rm -f "$err"; return 1
    fi
    rm -f "$err"
    attempt=$((attempt+1))
    if [ "$attempt" -gt "$RETRIES" ]; then
      ASKED=$((ASKED+1)); UNSEEN=$((UNSEEN+1))
      CALL_STATE="unknown"; CALL_OUT=""; return 1
    fi
    sleep "$(awk -v a="$attempt" 'BEGIN{print a*0.8}')"
  done
}

RPC_HOST=$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/]+).*#\1#')
echo "RPC     : $RPC_HOST"
echo "Spending: $AMOUNT_ETH WETH  and  $AMOUNT_USD USDC  into each token below"
echo "Question: does an Aerodrome Slipstream pool return more than anything we route through today?"
echo

# tickSpacingها از زنجیره، نه از حافظه.
if ! TS=$(try_cast cast call "$CL_FACTORY" "tickSpacings()(int24[])" --rpc-url "$RPC"); then
  echo "The RPC did not answer for tickSpacings(). Nothing below would be trustworthy."
  exit 2
fi
SPACINGS=$(printf '%s' "$TS" | strip_sci | tr -d '[]' | tr ',' ' ')
echo "Slipstream tick spacings on chain: $SPACINGS"
echo

printf '%-10s %22s %-22s %22s %-9s %s\n' "TOKEN" "OURS TODAY" "VIA" "SLIPSTREAM" "TICK" "DIFFERENCE"
printf '%s\n' "--------------------------------------------------------------------------------------------------------"

WINS=0; COMPARED=0; SKIPPED=0; WORST=""; WORST_PCT="0"; ONLY_CL=0; ONLY_LIST=""

IFS=',' read -ra TOKEN_LIST <<< "$TOKENS"
for T in "${TOKEN_LIST[@]}"; do
  T=$(printf '%s' "$T" | tr -d '[:space:]')
  [ -z "$T" ] && continue
  [ "$(printf '%s' "$T" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$WETH" | tr 'A-Z' 'a-z')" ] && continue

  # مکث کوتاه: با RPC عمومی و ~۱۷ پرسش برای هر توکن، بدون این کل ردیف‌ها
  # پر از `?` می‌شوند و آن `?` شبیه «استخری نیست» به نظر می‌رسد، که نیست.
  sleep 0.2
  SYM=$(try_cast cast call "$T" "symbol()(string)" --rpc-url "$RPC" | tr -d '"' | tr -d '[:space:]')
  [ -z "$SYM" ] && SYM="${T:0:8}"

  # --- الف) بهترین چیزی که امروز داریم ---
  # 🔴 چرا روی چند مرجع حلقه می‌زنیم: نسخه‌ی اول فقط جفت TOKEN/WETH را
  #    می‌سنجید و برای هر توکنی که استخر CL نداشت می‌نوشت «we lose nothing
  #    here». آن جمله غلط بود. ALIGN روی WETH هیچ استخری ندارد ولی کل
  #    نقدینگی‌اش یک استخر Slipstream روی **USDC** است — یعنی دقیقاً همان
  #    چیزی که از دستش می‌دادیم، از دید آن نسخه نامرئی بود.
  BEST_OURS=""; BEST_VIA=""; BEST_CL=""; BEST_TICK=""
  IFS='|' read -ra REF_ROWS <<< "$REF_SPECS"
  for row in "${REF_ROWS[@]}"; do
    IFS=';' read -r REF RNAME RAMT <<< "$row"
    [ "$(printf '%s' "$REF" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$T" | tr 'A-Z' 'a-z')" ] && continue

    for duo in "Uniswap V3|$UNI_QUOTER|$UNI_TIERS" "PancakeSwap V3|$PCS_QUOTER|$PCS_TIERS"; do
      IFS='|' read -r QNAME QADDR QTIERS <<< "$duo"
      for f in $QTIERS; do
        probe_call call "$QADDR" "$SIG_Q_V3" "($REF,$T,$RAMT,$f,0)" --rpc-url "$RPC" || continue
        N=$(first_num "$CALL_OUT"); { [ -z "$N" ] || [ "$N" = "0" ]; } && continue
        if [ -z "$BEST_OURS" ] || [ "$(awk -v a="$N" -v b="$BEST_OURS" 'BEGIN{print (a>b)?1:0}')" = "1" ]; then
          BEST_OURS="$N"; BEST_VIA=$(awk -v n="$QNAME" -v f="$f" -v r="$RNAME" 'BEGIN{printf "%s %.2f%%/%s", n, f/10000, r}')
        fi
      done
    done
    for st in false true; do
      probe_call call "$AERO_ROUTER" "$SIG_SOLIDLY" "$RAMT" "[($REF,$T,$st,$AERO_FACTORY)]" --rpc-url "$RPC" || continue
      N=$(last_of_array "$CALL_OUT"); { [ -z "$N" ] || [ "$N" = "0" ]; } && continue
      if [ -z "$BEST_OURS" ] || [ "$(awk -v a="$N" -v b="$BEST_OURS" 'BEGIN{print (a>b)?1:0}')" = "1" ]; then
        BEST_OURS="$N"; BEST_VIA="Aerodrome $([ "$st" = "true" ] && echo stable || echo volatile)/$RNAME"
      fi
    done
    for s in $SPACINGS; do
      probe_call call "$CL_QUOTER" "$SIG_Q_CL" "($REF,$T,$RAMT,$s,0)" --rpc-url "$RPC" || continue
      N=$(first_num "$CALL_OUT"); { [ -z "$N" ] || [ "$N" = "0" ]; } && continue
      if [ -z "$BEST_CL" ] || [ "$(awk -v a="$N" -v b="$BEST_CL" 'BEGIN{print (a>b)?1:0}')" = "1" ]; then
        BEST_CL="$N"; BEST_TICK="$s/$RNAME"
      fi
    done
  done

  # --- مقایسه. اگر یک طرف جواب نداده، مقایسه‌ای در کار نیست. ---
  if [ -z "$BEST_OURS" ] && [ -z "$BEST_CL" ]; then
    printf '%-10s %22s %-22s %22s %-9s %s\n' "$SYM" "?" "-" "?" "-" "neither side answered"
    SKIPPED=$((SKIPPED+1)); continue
  fi
  if [ -z "$BEST_OURS" ]; then
    printf '%-10s %22s %-22s %22s %-9s %s\n' "$SYM" "?" "no route today" "$BEST_CL" "$BEST_TICK" \
      "ONLY Slipstream has this token"
    WINS=$((WINS+1)); COMPARED=$((COMPARED+1))
    ONLY_CL=$((ONLY_CL+1)); ONLY_LIST="$ONLY_LIST $SYM"; continue
  fi
  if [ -z "$BEST_CL" ]; then
    printf '%-10s %22s %-22s %22s %-9s %s\n' "$SYM" "$BEST_OURS" "$BEST_VIA" "?" "-" "no Slipstream pool on either reference pair"
    COMPARED=$((COMPARED+1)); continue
  fi

  PCT=$(awk -v c="$BEST_CL" -v o="$BEST_OURS" 'BEGIN{ if(o==0){print "0"} else {printf "%.2f", (c-o)/o*100} }')
  COMPARED=$((COMPARED+1))
  MARK=""
  if [ "$(awk -v p="$PCT" 'BEGIN{print (p>0.5)?1:0}')" = "1" ]; then
    MARK="<-- Slipstream pays +$PCT% MORE"
    WINS=$((WINS+1))
    if [ "$(awk -v p="$PCT" -v w="$WORST_PCT" 'BEGIN{print (p>w)?1:0}')" = "1" ]; then
      WORST_PCT="$PCT"; WORST="$SYM"
    fi
  else
    MARK="$PCT%"
  fi
  printf '%-10s %22s %-22s %22s %-9s %s\n' "$SYM" "$BEST_OURS" "$BEST_VIA" "$BEST_CL" "$BEST_TICK" "$MARK"
done

echo
echo "========================================================================================================"
echo "Pool queries: $ASKED asked  ·  $ANSWERED answered  ·  $NOPOOL empty  ·  $UNSEEN never answered"
if [ "$ASKED" -gt 0 ] && [ "$((UNSEEN * 4))" -gt "$ASKED" ]; then
  echo
  echo "VERDICT: INCOMPLETE - more than a quarter of the calls never came back."
  echo "An unanswered call looks exactly like an empty pool, so every '?' above may be"
  echo "rate-limiting rather than a missing pool. Nothing here is evidence yet."
  echo "Re-run with a private endpoint in contracts/.rpc, or DELAY=0.5 to go slower."
  exit 3
fi
if [ "$COMPARED" -eq 0 ]; then
  echo "VERDICT: nothing could be compared - the RPC answered for none of these tokens."
  echo "This is not evidence that Slipstream does not matter. Re-run with a private RPC."
  exit 3
fi
echo "Compared $COMPARED token(s). Slipstream paid materially more on $WINS of them."
[ "$SKIPPED" -gt 0 ] && echo "$SKIPPED token(s) could not be priced on either side and are NOT counted."
if [ "$ONLY_CL" -gt 0 ]; then
  echo "Slipstream is the ONLY venue that trades:$ONLY_LIST"
  echo "For those tokens we do not deliver a worse price - we cannot route them at all."
fi
if [ "$WINS" -gt 0 ]; then
  [ -n "$WORST" ] && echo "Biggest gap where both sides quote: $WORST, Slipstream returns $WORST_PCT% more."
  echo
  echo "That gap is the case for deploying a v5 executor with a Slipstream kind."
else
  echo
  echo "On these tokens Slipstream is not ahead. That is a real answer too - it means the"
  echo "ALIGN case was about a token we did not sample, so re-run with TOKENS=<those addresses>"
  echo "before concluding either way."
fi
exit 0
