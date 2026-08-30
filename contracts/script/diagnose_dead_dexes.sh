#!/usr/bin/env bash
# =============================================================================
# سه صرافیِ «مرده» واقعاً مرده‌اند، یا فقط آدرس روترشان کهنه است؟
#
# فقط می‌خواند. هیچ تراکنشی نمی‌فرستد.
#
# سوییت وب می‌گوید `[coverage] Routing through 3 of 6 Base DEXes` و برای
# BaseSwap و SushiSwap و Alien Base می‌نویسد «no contract at the router
# address». تا امروز آن را «این صرافی‌ها مرده‌اند» خوانده‌ایم. ولی «قراردادی
# در این آدرس نیست» دقیقاً همان چیزی نیست — یک آدرسِ اشتباه هم همین را
# می‌دهد. تفاوتش مهم است:
#
#   صرافی واقعاً مرده        → ردیفش را از DEXES بردار، تمام.
#   آدرس روتر کهنه است       → آدرس درست را پیدا کن و سه صرافی برمی‌گردند،
#                              **بدون هیچ تغییری در قرارداد** (KIND_V2 هست).
#
# روش تشخیص: به‌جای روتر، **فکتوری** را می‌پرسیم. فکتوری آدرسی است که
# استخرها را می‌سازد و تقریباً هرگز عوض نمی‌شود. اگر فکتوری کد دارد و برای
# WETH/USDC یک استخر واقعی برمی‌گرداند، آن صرافی زنده است و مشکل از آدرس
# روترِ ماست.
#
#   ./diagnose_dead_dexes.sh
# =============================================================================
set -uo pipefail

PRIVATE_RPC=""
[ -f "$(dirname "$0")/../.rpc" ] && PRIVATE_RPC=$(head -1 "$(dirname "$0")/../.rpc" | tr -d '[:space:]')
RPC="${RPC:-${PRIVATE_RPC:-https://base.drpc.org}}"
DELAY="${DELAY:-0.15}"
RETRIES="${RETRIES:-2}"

command -v cast >/dev/null 2>&1 || { echo "foundry's 'cast' is not installed - install it and run again." >&2; exit 1; }

WETH="0x4200000000000000000000000000000000000006"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# نام|روتر|فکتوری — همان مقادیری که امروز در web/index.html هستند.
# عمداً از آنجا خوانده نمی‌شوند: هدفِ این اسکریپت این است که بگوید همان
# مقادیر درست‌اند یا نه، پس باید دقیقاً همان‌ها را بسنجد.
DEXES=(
  "BaseSwap|0x327Df1E6de05895d2ab08513aaDD9313Fe505d86|0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB"
  "SushiSwap|0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891|0x71524B4f93c58fcbF659783284E38825f0622859"
  "Alien Base|0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7|0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7"
)

strip_sci() { sed -E 's/\[[0-9.]+e[0-9]+\]//g'; }
first_num() { printf '%s\n' "$1" | strip_sci | head -1 | tr -d '[:space:]' | sed -E 's/[^0-9].*$//'; }
self_test_parsers() {
  [ "$(first_num "122663778 [1.226e8]")" = "122663778" ] && [ "$(first_num "42")" = "42" ] || {
    echo "parser self-test failed - foundry's output format changed. Refusing to run." >&2; exit 4; }
}
self_test_parsers

# 📌 «نیست» فقط با revertِ صریح؛ هر چیز دیگری «نمی‌دانم» است و تلاش دوباره
#    می‌شود. یک throttle نباید یک صرافی سالم را مرده اعلام کند.
CALL_OUT=""; CALL_STATE=""
probe_call() {
  local err out rc attempt=0
  while :; do
    err=$(mktemp); out=$(cast "$@" 2>"$err"); rc=$?
    sleep "$DELAY"
    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then CALL_OUT="$out"; CALL_STATE="ok"; rm -f "$err"; return 0; fi
    if grep -qiE 'execution reverted|revert' "$err"; then CALL_STATE="nopool"; CALL_OUT=""; rm -f "$err"; return 1; fi
    rm -f "$err"; attempt=$((attempt+1))
    if [ "$attempt" -gt "$RETRIES" ]; then CALL_STATE="unknown"; CALL_OUT=""; return 1; fi
    sleep "$(awk -v a="$attempt" 'BEGIN{print a*0.8}')"
  done
}
ZERO="0x0000000000000000000000000000000000000000"
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

RPC_HOST=$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/]+).*#\1#')
echo "RPC : $RPC_HOST"
echo "Question: are these three DEXes gone, or is our router address stale?"
echo

REVIVABLE=0; DEAD=0; UNSURE=0
for row in "${DEXES[@]}"; do
  IFS='|' read -r NAME ROUTER FACTORY <<< "$row"
  echo "--- $NAME"

  # ۱) روتری که ما در کد داریم
  if probe_call code "$ROUTER" --rpc-url "$RPC"; then
    if [ "$CALL_OUT" = "0x" ]; then R_STATE="empty"; else R_STATE="has code"; fi
  else
    R_STATE="unknown"
  fi
  echo "    our router  $ROUTER  -> $R_STATE"

  # ۲) فکتوری. این است که تکلیف را روشن می‌کند.
  if ! probe_call code "$FACTORY" --rpc-url "$RPC"; then
    echo "    factory     $FACTORY  -> could not read ($CALL_STATE)"
    echo "    VERDICT: UNKNOWN - the network did not answer. This is not evidence."
    UNSURE=$((UNSURE+1)); echo; continue
  fi
  if [ "$CALL_OUT" = "0x" ]; then
    echo "    factory     $FACTORY  -> empty"
    echo "    VERDICT: GONE - neither the router nor the factory exists at the addresses"
    echo "             we carry. Drop this row from DEXES rather than hunting a new router."
    DEAD=$((DEAD+1)); echo; continue
  fi
  echo "    factory     $FACTORY  -> has code"

  # ۳) آیا فکتوری استخر واقعی دارد؟ فکتوریِ بی‌استخر، فکتوریِ در استفاده نیست.
  if ! probe_call call "$FACTORY" "getPair(address,address)(address)" "$WETH" "$USDC" --rpc-url "$RPC"; then
    echo "    WETH/USDC pair -> could not read ($CALL_STATE)"
    echo "    VERDICT: UNKNOWN - re-run before acting."
    UNSURE=$((UNSURE+1)); echo; continue
  fi
  PAIR=$(printf '%s' "$CALL_OUT" | head -1 | tr -d '[:space:]')
  if [ "$(lower "$PAIR")" = "$ZERO" ]; then
    echo "    WETH/USDC pair -> none"
    echo "    VERDICT: LIKELY GONE - the factory is deployed but has no WETH/USDC pair,"
    echo "             which no live Base DEX would be missing."
    DEAD=$((DEAD+1)); echo; continue
  fi
  echo "    WETH/USDC pair -> $PAIR"

  # ۴) استخر واقعاً پول دارد؟
  if probe_call call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC"; then
    R0=$(first_num "$CALL_OUT")
    echo "    reserve0       -> ${R0:-unreadable}"
  fi

  echo "    VERDICT: ALIVE - the DEX exists and has a real WETH/USDC pool, so the row"
  echo "             in DEXES is not dead: OUR ROUTER ADDRESS IS STALE. Find the current"
  echo "             router for $NAME on Base, put it in the table, and this venue comes"
  echo "             back with NO contract change - KIND_V2 already handles it."
  REVIVABLE=$((REVIVABLE+1)); echo
done

echo "==============================================================="
echo "alive-but-wrong-router: $REVIVABLE   ·   gone: $DEAD   ·   unknown: $UNSURE"
if [ "$UNSURE" -gt 0 ]; then
  echo "Some rows are UNKNOWN, which means the network did not answer - not that"
  echo "anything is wrong. Re-run those before acting."
  exit 3
fi
if [ "$REVIVABLE" -gt 0 ]; then
  echo
  echo "Next step for the ALIVE ones: find their current Base router address, then run"
  echo "  ./script/verify_dexes.sh"
  echo "with the new address in web/index.html. That script checks the swap selector is"
  echo "really in the router's bytecode before we trust it."
fi
exit 0
