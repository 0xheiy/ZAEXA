#!/usr/bin/env bash
# =============================================================================
# نقدینگیِ یک توکن کجاست؟ — همه‌ی استخرهای ممکن، روی همه‌ی جفت‌های مرجع.
#
# فقط می‌خواند. هیچ تراکنشی نمی‌فرستد.
#
# چرا لازم شد: ۲۰ آگوست ۲۰۲۶ روی ALIGN، یونی‌سواپ ۱۴۰٫۲۴ USDC داد و ما
# ۳۰٫۱۷ — و سایت ما گفت «0 LIVE · 13 EMPTY»، یعنی هیچ استخر مستقیمی نبود
# و خروجی از یک مسیر چندپله آمد. این اسکریپت می‌گوید نقدینگیِ آن توکن
# واقعاً کجاست، تا معلوم شود مسئله «صرافیِ غایب» است یا «مسیرِ بد».
#
#   TOKEN=0x53f3… AMOUNT=6382 ./probe_token_pools.sh
#   TOKEN=0x53f3… REFS=0xUSDC ./probe_token_pools.sh
#   TOKEN=0x53f3… DELAY=0.4 ./probe_token_pools.sh     # اگر RPC سخت می‌گیرد
#
# جهت: توکن را *می‌فروشیم* (TOKEN → مرجع)، چون موردِ گزارش‌شده همین بود.
#
# ⚠️ سه قاعده‌ای که نسخه‌ی اول این اسکریپت هر سه را شکست و خروجی بی‌معنی داد:
#   ۱) اگر `decimals()` یک توکن خوانده نشد، **حدس نزن**. نسخه‌ی اول ۱۸
#      می‌گذاشت؛ روی USDC که ۶ است، مبلغ ۱۰¹² برابر کوچک شد و «0.000000»
#      چاپ کرد — یعنی «استخر خالی» به نظر رسید در حالی که پر بود.
#   ۲) عدد خام را هم چاپ کن، نه فقط شکل انسانی‌اش. اگر روزی تبدیل خراب
#      شود، خام کنارش لوش می‌دهد.
#   ۳) شکستِ فراخوانی دو معنی دارد: «استخر نیست» یا «شبکه جواب نداد».
#      یکی‌گرفتنشان یعنی throttleِ RPC به‌صورت «نقدینگی ندارد» گزارش شود.
# =============================================================================
set -uo pipefail

PRIVATE_RPC=""
[ -f "$(dirname "$0")/../.rpc" ] && PRIVATE_RPC=$(head -1 "$(dirname "$0")/../.rpc" | tr -d '[:space:]')
RPC="${RPC:-${PRIVATE_RPC:-https://base.drpc.org}}"
DELAY="${DELAY:-0.15}"
# 📌 فقط حالتِ «نمی‌دانم» دوباره تلاش می‌شود، هرگز «استخر نیست».
#    یک تماسِ بدشانس نباید یک جفتِ کامل را از تحلیل حذف کند — یک بار
#    همین اتفاق افتاد و جفت ALIGN/USDC، یعنی دقیقاً همان چیزی که
#    دنبالش بودیم، بی‌سروصدا کنار گذاشته شد.
RETRIES="${RETRIES:-2}"

command -v cast >/dev/null 2>&1 || { echo "foundry's 'cast' is not installed - install it and run again." >&2; exit 1; }
[ -n "${TOKEN:-}" ] || { echo "Set TOKEN=0x… (the token to probe)." >&2; exit 1; }

WETH="0x4200000000000000000000000000000000000006"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
AERO="0x940181a94A35A4569E4529A3CDfB74e38FD98631"
REFS="${REFS:-$WETH,$USDC,$AERO}"

UNI_QUOTER="0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";  UNI_TIERS="100 500 3000 10000"
PCS_QUOTER="0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";  PCS_TIERS="100 500 2500 10000"
AERO_ROUTER="0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"
AERO_FACTORY="0x420DD381b31aEf6683db6B902084cB0FFECe40Da"
CL_FACTORY="0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"
CL_QUOTER="0x514c8B5f54112481E28028F1166Bd78501089259"

SIG_Q_V3="quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)"
SIG_Q_CL="quoteExactInputSingle((address,address,uint256,int24,uint160))(uint256,uint160,uint32,uint256)"
SIG_SOLIDLY="getAmountsOut(uint256,(address,address,bool,address)[])(uint256[])"

# ⚠️ foundry اعداد بزرگ را با پسوند علمی چاپ می‌کند: `122663778 [1.226e8]`.
strip_sci() { sed -E 's/\[[0-9.]+e[0-9]+\]//g'; }
first_num()     { printf '%s\n' "$1" | strip_sci | head -1 | tr -d '[:space:]' | sed -E 's/[^0-9].*$//'; }
last_of_array() { printf '%s\n' "$1" | strip_sci | tr -d '[]' | tr ',' '\n' | tail -1 | tr -d '[:space:]' | sed -E 's/[^0-9].*$//'; }

self_test_parsers() {
  local bad=0 got
  got=$(first_num "122663778 [1.226e8]");                   [ "$got" = "122663778" ] || bad=1
  got=$(first_num "122663778");                              [ "$got" = "122663778" ] || bad=1
  got=$(last_of_array "[5000 [5e3], 122663778 [1.226e8]]");  [ "$got" = "122663778" ] || bad=1
  got=$(last_of_array "[5000, 122663778]");                  [ "$got" = "122663778" ] || bad=1
  [ "$bad" -eq 0 ] || {
    echo "parser self-test failed - foundry's output format changed. A mis-parsed amount" >&2
    echo "looks exactly like a market finding, so this refuses to run." >&2; exit 4; }
}
self_test_parsers

# --- لایه‌ی فراخوانی: سه‌حالته ---------------------------------------------
# CALL_OUT جواب، CALL_STATE یکی از ok | nopool | unknown
#
# 📌 «استخر نیست» فقط وقتی گفته می‌شود که پیام خطا *صریحاً* revert باشد.
#    هر چیز دیگری — 429، timeout، قطعی، پیام ناشناخته — «نمی‌دانم» است.
#    این عمداً یک‌طرفه است: بدترین حالتِ محافظه‌کاری یک `?` اضافه است،
#    بدترین حالتِ خوش‌بینی این است که throttleِ RPC را «نقدینگی ندارد»
#    گزارش کنیم و یک صرافی سالم را حذف کنیم.
CALL_OUT=""; CALL_STATE=""
probe_call() {
  local err out rc attempt=0
  while :; do
    err=$(mktemp); out=$(cast "$@" 2>"$err"); rc=$?
    sleep "$DELAY"
    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
      CALL_OUT="$out"; CALL_STATE="ok"; rm -f "$err"; return 0
    fi
    if grep -qiE 'execution reverted|revert' "$err"; then
      CALL_STATE="nopool"; CALL_OUT=""; rm -f "$err"; return 1
    fi
    rm -f "$err"
    attempt=$((attempt+1))
    if [ "$attempt" -gt "$RETRIES" ]; then
      CALL_STATE="unknown"; CALL_OUT=""; return 1
    fi
    sleep "$(awk -v a="$attempt" 'BEGIN{print a*0.8}')"
  done
}

RPC_HOST=$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/]+).*#\1#')

# --- خودِ توکن. اگر این خوانده نشود، هیچ ردیفی معنی ندارد. ---
probe_call call "$TOKEN" "symbol()(string)" --rpc-url "$RPC" \
  && SYM=$(printf '%s' "$CALL_OUT" | tr -d '"' | tr -d '[:space:]') || SYM=""
[ -z "$SYM" ] && SYM="${TOKEN:0:10}"
if ! probe_call call "$TOKEN" "decimals()(uint8)" --rpc-url "$RPC"; then
  echo "Could not read decimals() from $TOKEN ($CALL_STATE)." >&2
  echo "Without decimals every amount below would be meaningless, so this stops here." >&2
  exit 2
fi
DEC=$(first_num "$CALL_OUT")
[ -n "$DEC" ] || { echo "decimals() came back unparseable for $TOKEN." >&2; exit 2; }

AMOUNT="${AMOUNT:-1000}"
AMOUNT_RAW=$(awk -v a="$AMOUNT" -v d="$DEC" 'BEGIN{printf "%.0f", a*(10^d)}')

echo "RPC     : $RPC_HOST"
echo "Token   : $SYM ($TOKEN, $DEC decimals)"
echo "Selling : $AMOUNT $SYM into each reference token below"
echo

if ! probe_call call "$CL_FACTORY" "tickSpacings()(int24[])" --rpc-url "$RPC"; then
  echo "The RPC did not answer for tickSpacings() ($CALL_STATE)."
  echo "Slipstream rows would be blank for the wrong reason, so this stops here."
  exit 2
fi
SPACINGS=$(printf '%s' "$CALL_OUT" | strip_sci | tr -d '[]' | tr ',' ' ')

human() { awk -v v="$1" -v d="$2" 'BEGIN{printf "%.8f", v/(10^d)}'; }

printf '%-8s %-26s %-16s %s\n' "REF" "VENUE" "YOU GET" "RAW"
printf '%s\n' "-------------------------------------------------------------------------------"

FOUND=0; CL_FOUND=0; ASKED=0; ANSWERED=0; NOPOOL=0; UNSEEN=0; REF_SKIPPED=0
BEST=""; BEST_LABEL=""; BEST_REF=""; BEST_DEC=""
BEST_CL=""; BEST_CL_LABEL=""; BEST_CL_REF=""; BEST_CL_DEC=""

note_result() {   # $1 state
  ASKED=$((ASKED+1))
  case "$1" in
    ok)      ANSWERED=$((ANSWERED+1)) ;;
    nopool)  NOPOOL=$((NOPOOL+1)) ;;
    *)       UNSEEN=$((UNSEEN+1)) ;;
  esac
}

IFS=',' read -ra REF_LIST <<< "$REFS"
for REF in "${REF_LIST[@]}"; do
  REF=$(printf '%s' "$REF" | tr -d '[:space:]')
  [ -z "$REF" ] && continue
  [ "$(printf '%s' "$REF" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$TOKEN" | tr 'A-Z' 'a-z')" ] && continue

  # 🔑 بدون decimalsِ *واقعی*، هر عددی که برای این مرجع چاپ کنیم دروغ است.
  #    پس اگر خوانده نشد، کل این مرجع کنار گذاشته می‌شود — نه اینکه ۱۸ فرض شود.
  if ! probe_call call "$REF" "decimals()(uint8)" --rpc-url "$RPC"; then
    printf '%-8s %-26s %s\n' "${REF:0:8}" "-" "SKIPPED: decimals() did not come back ($CALL_STATE)"
    REF_SKIPPED=$((REF_SKIPPED+1)); continue
  fi
  RDEC=$(first_num "$CALL_OUT")
  if [ -z "$RDEC" ]; then
    printf '%-8s %-26s %s\n' "${REF:0:8}" "-" "SKIPPED: decimals() unparseable"
    REF_SKIPPED=$((REF_SKIPPED+1)); continue
  fi
  probe_call call "$REF" "symbol()(string)" --rpc-url "$RPC" \
    && RSYM=$(printf '%s' "$CALL_OUT" | tr -d '"' | tr -d '[:space:]') || RSYM=""
  [ -z "$RSYM" ] && RSYM="${REF:0:8}"

  record() {   # $1 amount  $2 label  $3 class
    FOUND=$((FOUND+1))
    if [ -z "$BEST" ] || [ "$(awk -v a="$1" -v b="$BEST" 'BEGIN{print (a>b)?1:0}')" = "1" ]; then
      BEST="$1"; BEST_LABEL="$2"; BEST_REF="$RSYM"; BEST_DEC="$RDEC"
    fi
    if [ "$3" = "cl" ]; then
      CL_FOUND=$((CL_FOUND+1))
      if [ -z "$BEST_CL" ] || [ "$(awk -v a="$1" -v b="$BEST_CL" 'BEGIN{print (a>b)?1:0}')" = "1" ]; then
        BEST_CL="$1"; BEST_CL_LABEL="$2"; BEST_CL_REF="$RSYM"; BEST_CL_DEC="$RDEC"
      fi
    fi
    printf '%-8s %-26s %-16s %s\n' "$RSYM" "$2" "$(human "$1" "$RDEC") $RSYM" "$1"
  }

  for duo in "Uniswap V3|$UNI_QUOTER|$UNI_TIERS" "PancakeSwap V3|$PCS_QUOTER|$PCS_TIERS"; do
    IFS='|' read -r QNAME QADDR QTIERS <<< "$duo"
    for f in $QTIERS; do
      probe_call call "$QADDR" "$SIG_Q_V3" "($TOKEN,$REF,$AMOUNT_RAW,$f,0)" --rpc-url "$RPC"
      note_result "$CALL_STATE"
      [ "$CALL_STATE" = "ok" ] || continue
      N=$(first_num "$CALL_OUT"); { [ -z "$N" ] || [ "$N" = "0" ]; } && continue
      record "$N" "$(awk -v n="$QNAME" -v f="$f" 'BEGIN{printf "%s %.2f%%", n, f/10000}')" "v3"
    done
  done
  for st in false true; do
    probe_call call "$AERO_ROUTER" "$SIG_SOLIDLY" "$AMOUNT_RAW" "[($TOKEN,$REF,$st,$AERO_FACTORY)]" --rpc-url "$RPC"
    note_result "$CALL_STATE"
    [ "$CALL_STATE" = "ok" ] || continue
    N=$(last_of_array "$CALL_OUT"); { [ -z "$N" ] || [ "$N" = "0" ]; } && continue
    record "$N" "Aerodrome $([ "$st" = "true" ] && echo stable || echo volatile)" "sol"
  done
  for s in $SPACINGS; do
    probe_call call "$CL_QUOTER" "$SIG_Q_CL" "($TOKEN,$REF,$AMOUNT_RAW,$s,0)" --rpc-url "$RPC"
    note_result "$CALL_STATE"
    [ "$CALL_STATE" = "ok" ] || continue
    N=$(first_num "$CALL_OUT"); { [ -z "$N" ] || [ "$N" = "0" ]; } && continue
    record "$N" "Slipstream tick=$s" "cl"
  done
done

echo
echo "==============================================================================="
echo "Asked $ASKED pools:  $ANSWERED answered  ·  $NOPOOL empty  ·  $UNSEEN never answered"
[ "$REF_SKIPPED" -gt 0 ] && echo "$REF_SKIPPED reference token(s) skipped because their decimals could not be read."

# --- دروازه‌ی صداقت: با نرخ جوابِ پایین هیچ حکمی داده نمی‌شود. ---
if [ "$ASKED" -gt 0 ] && [ "$((UNSEEN * 4))" -gt "$ASKED" ]; then
  echo
  echo "VERDICT: INCOMPLETE - more than a quarter of the calls never came back."
  echo "That is almost always the public RPC rate-limiting us, and an unanswered call"
  echo "looks exactly like an empty pool. Nothing above is evidence yet."
  echo "Re-run with a private endpoint in contracts/.rpc, or DELAY=0.5 to go slower."
  exit 3
fi

if [ "$FOUND" -eq 0 ]; then
  echo
  echo "VERDICT: no direct pool anywhere for $SYM against any reference token."
  echo "That is exactly what '0 LIVE - 13 EMPTY' on the site means: every direct venue"
  echo "was empty, so the only way through is a multi-hop route. If a competitor still"
  echo "quoted this token well, the difference is in ROUTING, not in a missing venue -"
  echo "look at the hop path, not at the DEX list."
  exit 0
fi
echo
echo "Best anywhere      : $(human "$BEST" "$BEST_DEC") $BEST_REF  via $BEST_LABEL   (raw $BEST)"
if [ "$CL_FOUND" -eq 0 ]; then
  echo "Slipstream         : no pool at all for $SYM - adding it would not have helped."
else
  echo "Best on Slipstream : $(human "$BEST_CL" "$BEST_CL_DEC") $BEST_CL_REF  via $BEST_CL_LABEL   (raw $BEST_CL)"
  if [ "$BEST_CL_REF" = "$BEST_REF" ]; then
    PCT=$(awk -v c="$BEST_CL" -v o="$BEST" 'BEGIN{ if(o==0){print "0"} else {printf "%.2f", (c-o)/o*100} }')
    echo "Difference         : $PCT% (same reference token, so directly comparable)"
  else
    echo "Difference         : not directly comparable - the two pools pay out in"
    echo "                     different tokens."
  fi
fi
exit 0
