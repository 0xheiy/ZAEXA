#!/usr/bin/env bash
# =============================================================================
# دیپلوی Zaexa روی Robinhood Chain (chain id 4663) — همه در یک مسیر:
#   SwapExecutor (همان سورسِ v6ِ Base، بی‌تغییر) → لیست‌سفیدِ روترها →
#   UniswapV4Adapter (قفل به همین اجراکننده) → لیست‌سفیدِ آداپتور.
#
#   ./script/deploy_robinhood.sh
#
# عمداً جدا از deploy.sh است: دستورهای «بعد از دیپلوی»ِ آن اسکریپت آدرسِ
# اجراکننده‌ی Base را در web/index.html عوض می‌کنند — روی این زنجیره همان
# دستورها اجراکننده‌ی زنده‌ی Base را خراب می‌کردند.
#
# آدرس‌ها ۲۳ نوامبر ۲۰۲۶ روی خودِ زنجیره سنجیده شدند (eth_getCode و eth_call):
#   WETH            0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73  (WETH9() ِ روتر همین را می‌دهد)
#   Uniswap SwapRouter02  0xcaf681a66d020601342297493863e78c959e5cb2  (kind=1، سلکتورِ 04e45aaf در کد)
#   Slipstream router     0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418  (kind=4، factory()=CLFactory
#                         0xc63d…e136، سلکتورِ a026383e در کد — همان آدرسِ Base)
#   v4 PoolManager        0x8366a39cc670b4001a1121b8f6a443a643e40951  (V4Quoter.poolManager() همین را می‌دهد)
# این سه صرافی ~۹۱٪ِ حجمِ ۱۰۰ استخرِ برترِ GeckoTerminal روی این زنجیره‌اند.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

CHAIN_ID="4663"
EXPLORER="https://robinhoodchain.blockscout.com"

PRIVATE_RPC=""
[ -f ".rpc-robinhood" ] && PRIVATE_RPC=$(head -1 .rpc-robinhood | tr -d '[:space:]')
RPC_CANDIDATES=(
  "${RPC:-}"
  "$PRIVATE_RPC"
  "https://rpc.mainnet.chain.robinhood.com"
)
mask_rpc() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1/…#'; }

OWNER="${OWNER:-0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23}"
FEE_RECIPIENT="${FEE_RECIPIENT:-$OWNER}"
FEE_BPS="${FEE_BPS:-0}"
WETH_ADDR="0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
POOL_MANAGER="0x8366a39cc670b4001a1121b8f6a443a643e40951"
# USDG — استیبل‌کوینِ اصلیِ این زنجیره (جفتِ استخرِ WETH/USDGِ نمودار). owner بعداً با setFeeToken عوضش می‌کند.
FEE_TOKENS="${FEE_TOKENS:-0x5fc5360d0400a0fd4f2af552add042d716f1d168}"
ROUTERS="0xcaf681a66d020601342297493863e78c959e5cb2,0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418"

FEE_TOKENS_ARR=""
IFS=',' read -r -a _FT <<< "$FEE_TOKENS"
for t in "${_FT[@]}"; do
  t=$(printf '%s' "$t" | tr -d '[:space:]')
  [ -z "$t" ] && continue
  [[ "$t" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "Bad address in FEE_TOKENS: $t"; exit 1; }
  FEE_TOKENS_ARR="${FEE_TOKENS_ARR:+$FEE_TOKENS_ARR,}$t"
done
FEE_TOKENS_ARG="[$FEE_TOKENS_ARR]"

read_uint() { local out; out=$("$@" 2>/dev/null); [[ "$out" =~ ^[0-9]+$ ]] && echo "$out" || echo ""; }
read_addr() { local out; out=$("$@" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | head -1); echo "$out"; }
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

echo "==============================================================="
echo " Zaexa deploy on Robinhood Chain ($CHAIN_ID)"
echo "==============================================================="

# --- [0/7] RPC ---
RPC=""
echo
echo "[0/7] Finding a working RPC ..."
for u in "${RPC_CANDIDATES[@]}"; do
  [ -z "$u" ] && continue
  ID=$(cast chain-id --rpc-url "$u" 2>/dev/null)
  if [ "$ID" = "$CHAIN_ID" ]; then RPC="$u"; echo "      OK $(mask_rpc "$u")"; break; fi
  echo "      no answer / wrong chain ($ID): $(mask_rpc "$u")"
done
[ -n "$RPC" ] || { echo "  No RPC answered with chain id $CHAIN_ID. Check the connection / VPN and retry."; exit 1; }

# --- [1/7] every address we depend on must have code (unknown = stop, never zero) ---
echo
echo "[1/7] Checking contracts on chain ..."
for NA in "WETH:$WETH_ADDR" "PoolManager:$POOL_MANAGER" $(printf '%s' "$ROUTERS" | tr ',' '\n' | sed 's/^/Router:/') $(printf '%s' "$FEE_TOKENS_ARR" | tr ',' '\n' | sed 's/^/FeeToken:/'); do
  N="${NA%%:*}"; A="${NA#*:}"
  C=$(cast code "$A" --rpc-url "$RPC" 2>/dev/null)
  if [ -z "$C" ]; then echo "      $N $A : UNKNOWN (RPC did not answer) - stopping"; exit 1; fi
  if [ "$C" = "0x" ]; then echo "      $N $A : NO CODE - stopping"; exit 1; fi
  echo "      $N $A : code OK"
done
R02_WETH=$(read_addr cast call 0xcaf681a66d020601342297493863e78c959e5cb2 "WETH9()(address)" --rpc-url "$RPC")
[ "$(lc "$R02_WETH")" = "$(lc "$WETH_ADDR")" ] || { echo "      SwapRouter02.WETH9() = '$R02_WETH' != WETH - stopping"; exit 1; }
echo "      SwapRouter02.WETH9() matches WETH"

# --- [2/7] offline tests + size gate (executor profile, same as Base v6) ---
echo
echo "[2/7] Offline tests (FOUNDRY_PROFILE=executor) ..."
if ! FOUNDRY_PROFILE=executor forge test --no-match-path 'test/*.fork.t.sol' > /tmp/zaexa-rh-test.log 2>&1; then
  echo "  Tests are red. Deploy stopped."; tail -30 /tmp/zaexa-rh-test.log; exit 1
fi
grep -E "tests passed|Suite result" /tmp/zaexa-rh-test.log | tail -2
EXEC_HEX=$(FOUNDRY_PROFILE=executor forge inspect src/SwapExecutor.sol:SwapExecutor deployedBytecode 2>/dev/null | tr -d '[:space:]')
EXEC_BYTES=$(( (${#EXEC_HEX} - 2) / 2 ))
if [ "$EXEC_BYTES" -le 0 ] || [ "$EXEC_BYTES" -gt 24576 ]; then echo "  SwapExecutor size $EXEC_BYTES bytes is not deployable. Stopped."; exit 1; fi
echo "  green. SwapExecutor runtime: $EXEC_BYTES bytes"

# --- [3/7] parameters + confirmation ---
echo
echo "[3/7] Parameters:"
echo "      owner         : $OWNER"
echo "      feeRecipient  : $FEE_RECIPIENT"
echo "      fee bps       : $FEE_BPS"
echo "      WETH          : $WETH_ADDR"
echo "      feeTokens     : WETH + $FEE_TOKENS_ARG"
echo "      routers       : $(printf '%s' "$ROUTERS" | tr ',' ' ')"
echo "      v4 PoolManager: $POOL_MANAGER"
echo "      4 transactions: executor, routers, adapter, adapter allow"
echo
read -r -p "Continue? These are real transactions and spend gas. [yes/no] " OK
[ "$OK" = "yes" ] || { echo "Cancelled."; exit 0; }

echo
echo "Private key (nothing is shown while typing, then Enter):"
read -r -s PRIVATE_KEY
echo
[ -n "$PRIVATE_KEY" ] || { echo "Empty key."; exit 1; }
[[ "$PRIVATE_KEY" == 0x* ]] || PRIVATE_KEY="0x$PRIVATE_KEY"
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)
[ -n "$DEPLOYER" ] || { echo "Invalid key."; exit 1; }
echo "      sender : $DEPLOYER"
if [ "$(lc "$DEPLOYER")" != "$(lc "$OWNER")" ]; then
  echo "      WARNING: sender is not OWNER. setRoutersAllowed/setAdapterAllowed will fail (onlyOwner)."
  read -r -p "      Continue anyway? [yes/no] " GO; [ "$GO" = "yes" ] || { echo "Cancelled."; exit 0; }
fi
BAL=$(read_uint cast balance "$DEPLOYER" --rpc-url "$RPC")
if [ -z "$BAL" ]; then
  echo "      ETH balance : UNKNOWN (RPC did not answer) - this means 'do not know', not zero"
  read -r -p "      Continue anyway? [yes/no] " GO; [ "$GO" = "yes" ] || { echo "Cancelled."; exit 1; }
elif [ "$BAL" = "0" ]; then
  echo "      ETH balance : 0 on Robinhood Chain - bridge a little ETH first."; exit 1
else
  echo "      ETH balance : $(cast from-wei "$BAL" 2>/dev/null || echo "$BAL wei")"
fi

# deploy helper: forge output is not trusted - the chain has the last word
deployed_at() { # $1 log, $2 expected
  local a; a=$(grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' "$1" | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
  [ -z "$a" ] && a="$2"; echo "$a"
}
has_code() { local c; for _ in 1 2 3 4 5 6; do c=$(cast code "$1" --rpc-url "$RPC" 2>/dev/null); [ -n "$c" ] && [ "$c" != "0x" ] && return 0; sleep 3; done; return 1; }

# --- [4/7] SwapExecutor ---
echo
echo "[4/7] Deploying SwapExecutor ..."
NONCE=$(read_uint cast nonce "$DEPLOYER" --rpc-url "$RPC")
[ -n "$NONCE" ] || { echo "  Could not read nonce (RPC did not answer). Retry."; exit 1; }
EXPECTED=$(cast compute-address "$DEPLOYER" --nonce "$NONCE" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
FOUNDRY_PROFILE=executor forge create src/SwapExecutor.sol:SwapExecutor \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast \
  --constructor-args "$OWNER" "$FEE_RECIPIENT" "$FEE_BPS" "$WETH_ADDR" "$FEE_TOKENS_ARG" \
  > /tmp/zaexa-rh-deploy.log 2>&1
EXEC=$(deployed_at /tmp/zaexa-rh-deploy.log "$EXPECTED")
if ! has_code "$EXEC"; then echo "  No code at $EXEC. Log:"; tail -25 /tmp/zaexa-rh-deploy.log; PRIVATE_KEY=""; exit 1; fi
GOT_WETH=$(read_addr cast call "$EXEC" "WETH()(address)" --rpc-url "$RPC")
GOT_OWNER=$(read_addr cast call "$EXEC" "owner()(address)" --rpc-url "$RPC")
if [ "$(lc "$GOT_WETH")" != "$(lc "$WETH_ADDR")" ] || [ "$(lc "$GOT_OWNER")" != "$(lc "$OWNER")" ]; then
  echo "  Executor at $EXEC reads WETH='$GOT_WETH' owner='$GOT_OWNER' - not what we deployed. Stopping, nothing whitelisted."
  PRIVATE_KEY=""; exit 1
fi
echo "      SwapExecutor: $EXEC (WETH and owner checked on chain)"

# --- [5/7] routers ---
echo
echo "[5/7] Whitelisting routers ..."
cast send "$EXEC" "setRoutersAllowed(address[],bool)" "[$ROUTERS]" true \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" > /tmp/zaexa-rh-routers.log 2>&1
R_OK=1
for r in $(printf '%s' "$ROUTERS" | tr ',' ' '); do
  V=$(cast call "$EXEC" "allowedRouter(address)(bool)" "$r" --rpc-url "$RPC" 2>/dev/null)
  echo "      allowedRouter($r) = ${V:-UNKNOWN}"
  [ "$V" = "true" ] || R_OK=0
done

# --- [6/7] UniswapV4Adapter (default profile, same as the Base adapter) ---
echo
echo "[6/7] Deploying UniswapV4Adapter ..."
NONCE=$(read_uint cast nonce "$DEPLOYER" --rpc-url "$RPC")
[ -n "$NONCE" ] || { echo "  Could not read nonce. Executor is live at $EXEC; rerun the adapter part later."; PRIVATE_KEY=""; exit 1; }
EXPECTED=$(cast compute-address "$DEPLOYER" --nonce "$NONCE" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
FOUNDRY_PROFILE=default forge create src/UniswapV4Adapter.sol:UniswapV4Adapter \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast \
  --constructor-args "$POOL_MANAGER" "$WETH_ADDR" "$EXEC" \
  > /tmp/zaexa-rh-adapter.log 2>&1
ADAPTER=$(deployed_at /tmp/zaexa-rh-adapter.log "$EXPECTED")
A_OK=0
if has_code "$ADAPTER"; then
  I_EX=$(read_addr cast call "$ADAPTER" "executor()(address)" --rpc-url "$RPC")
  I_PM=$(read_addr cast call "$ADAPTER" "poolManager()(address)" --rpc-url "$RPC")
  I_WE=$(read_addr cast call "$ADAPTER" "weth()(address)" --rpc-url "$RPC")
  if [ "$(lc "$I_EX")" = "$(lc "$EXEC")" ] && [ "$(lc "$I_PM")" = "$(lc "$POOL_MANAGER")" ] && [ "$(lc "$I_WE")" = "$(lc "$WETH_ADDR")" ]; then
    echo "      UniswapV4Adapter: $ADAPTER (executor, poolManager, weth checked on chain)"
    # --- [7/7] adapter allow ---
    echo
    echo "[7/7] Whitelisting the adapter ..."
    cast send "$EXEC" "setAdapterAllowed(address,bool)" "$ADAPTER" true \
      --rpc-url "$RPC" --private-key "$PRIVATE_KEY" > /tmp/zaexa-rh-allow.log 2>&1
    V=$(cast call "$EXEC" "allowedAdapter(address)(bool)" "$ADAPTER" --rpc-url "$RPC" 2>/dev/null)
    echo "      allowedAdapter($ADAPTER) = ${V:-UNKNOWN}"
    [ "$V" = "true" ] && A_OK=1
  else
    echo "      Adapter immutables do not match (executor=$I_EX poolManager=$I_PM weth=$I_WE). NOT whitelisted."
  fi
else
  echo "      No code at $ADAPTER. Log:"; tail -15 /tmp/zaexa-rh-adapter.log
fi
PRIVATE_KEY=""

{
  echo "chain       : robinhood ($CHAIN_ID)"
  echo "date        : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "executor    : $EXEC"
  echo "adapter     : $ADAPTER"
  echo "owner       : $OWNER"
  echo "weth        : $WETH_ADDR"
  echo "feeTokens   : WETH + $FEE_TOKENS_ARG"
  echo "routers     : $ROUTERS"
  echo "routers_ok  : $R_OK"
  echo "adapter_ok  : $A_OK"
} > deployment_robinhood.txt

echo
echo "==============================================================="
echo " executor : $EXEC"
echo " adapter  : $ADAPTER"
echo " routers whitelisted : $([ $R_OK = 1 ] && echo yes || echo NO)"
echo " adapter whitelisted : $([ $A_OK = 1 ] && echo yes || echo NO)"
echo " $EXPLORER/address/$EXEC"
echo "==============================================================="
echo "Saved to contracts/deployment_robinhood.txt - paste this whole block back into the chat."
echo
echo "Source verification on Blockscout (no API key needed). Both profiles write to the same out/ folder,"
echo "so each verify rebuilds with its own profile first. If Blockscout answers with a Cloudflare"
echo "'Just a moment...' page, the CLI is blocked from this network - verify from a browser instead."
echo "  FOUNDRY_PROFILE=executor forge build && FOUNDRY_PROFILE=executor forge verify-contract $EXEC src/SwapExecutor.sol:SwapExecutor --verifier blockscout --verifier-url $EXPLORER/api/ --chain-id $CHAIN_ID --watch --constructor-args \$(cast abi-encode 'c(address,address,uint256,address,address[])' $OWNER $FEE_RECIPIENT $FEE_BPS $WETH_ADDR '$FEE_TOKENS_ARG')"
echo "  FOUNDRY_PROFILE=default forge build && FOUNDRY_PROFILE=default forge verify-contract $ADAPTER src/UniswapV4Adapter.sol:UniswapV4Adapter --verifier blockscout --verifier-url $EXPLORER/api/ --chain-id $CHAIN_ID --watch --constructor-args \$(cast abi-encode 'c(address,address,address)' $POOL_MANAGER $WETH_ADDR $EXEC)"
[ $R_OK = 1 ] && [ $A_OK = 1 ] || exit 2
