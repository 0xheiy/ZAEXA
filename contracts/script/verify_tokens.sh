#!/usr/bin/env bash
# =============================================================================
# تأیید آدرس توکن‌ها روی زنجیره — قبل از اینکه به فهرست Zaexa اضافه شوند.
#
#   ./verify_tokens.sh 0xToken 0xToken ...
#
# چرا این اسکریپت وجود دارد: یک آدرس اشتباه در فهرست *ما* یعنی کاربر از
# رابط خودمان یک توکن جعلی می‌خرد. این بدتر از هر باگ فنی است، چون اعتماد
# مستقیم را خرج می‌کند و کاربر هیچ راهی برای تشخیصش ندارد.
#
# نماد به‌تنهایی هیچ چیزی را اثبات نمی‌کند — هر کسی می‌تواند توکنی بسازد که
# symbol() آن "DEGEN" برگرداند. پس عمق نقدینگی هم گزارش می‌شود: توکن واقعی
# میلیون‌ها دلار استخر دارد، تقلبی صفر.
#
# خروجی سه‌حالته است، مثل verify_dexes.sh:
#   PASS     دیدیم و معقول بود
#   FAIL     دیدیم و مشکل داشت
#   UNKNOWN  اصلاً ندیدیم (شبکه جواب نداد) — این *نه* نیست
#
# ⚠️ این اسکریپت نمی‌گوید «توکن سالم است». می‌گوید «آدرس یک ERC-20 با این
#    نماد و این عمق است». تصمیم نهایی با توست.
# =============================================================================
set -uo pipefail

PRIVATE_RPC=""
[ -f "$(dirname "$0")/../.rpc" ] && PRIVATE_RPC=$(head -1 "$(dirname "$0")/../.rpc" | tr -d '[:space:]')
RPC="${RPC:-${PRIVATE_RPC:-https://base.drpc.org}}"

USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH=0x4200000000000000000000000000000000000006

UNI_V3_FACTORY=0x33128a8fC17869897dcE68Ed026d694621f6FDfD
AERO_FACTORY=0x420DD381b31aEf6683db6B902084cB0FFECe40Da
PCS_V3_FACTORY=0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865

# هر چیزی که عدد نیست، صفر حساب می‌شود *و* جداگانه شمرده می‌شود — بدون این،
# یک جواب غیرمنتظره‌ی RPC کل اسکریپت را با «unbound variable» می‌شکست.
num_or_zero() {
  local v=${1%% *}
  case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
}
# آدرس معتبر و غیرصفر؟
is_pool() {
  case "$1" in
    0x0000000000000000000000000000000000000000) return 1 ;;
    0x[0-9a-fA-F][0-9a-fA-F]*) [ ${#1} -eq 42 ] && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}

try_cast() {
  local out rc
  out=$("$@" 2>/dev/null); rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then return 1; fi
  printf '%s' "$out"
  return 0
}

# عمق تقریبی: موجودی توکن *مرجع* داخل استخر، ضربدر ۲.
# از سمت مرجع می‌سنجیم چون قیمت خود توکن می‌تواند ساختگی باشد.
pool_depth() {
  local token=$1 ref=$2 refdec=$3 total=0 pool bal
  for fee in 100 500 3000 10000; do
    pool=$(try_cast cast call "$UNI_V3_FACTORY" "getPool(address,address,uint24)(address)" \
             "$token" "$ref" "$fee" --rpc-url "$RPC") || continue
    is_pool "$pool" || continue
    bal=$(try_cast cast call "$ref" "balanceOf(address)(uint256)" "$pool" --rpc-url "$RPC") || continue
    total=$(( total + $(num_or_zero "$bal") / (10 ** refdec) ))
  done
  for fee in 100 500 2500 10000; do
    pool=$(try_cast cast call "$PCS_V3_FACTORY" "getPool(address,address,uint24)(address)" \
             "$token" "$ref" "$fee" --rpc-url "$RPC") || continue
    is_pool "$pool" || continue
    bal=$(try_cast cast call "$ref" "balanceOf(address)(uint256)" "$pool" --rpc-url "$RPC") || continue
    total=$(( total + $(num_or_zero "$bal") / (10 ** refdec) ))
  done
  for st in true false; do
    pool=$(try_cast cast call "$AERO_FACTORY" "getPool(address,address,bool)(address)" \
             "$token" "$ref" "$st" --rpc-url "$RPC") || continue
    is_pool "$pool" || continue
    bal=$(try_cast cast call "$ref" "balanceOf(address)(uint256)" "$pool" --rpc-url "$RPC") || continue
    total=$(( total + $(num_or_zero "$bal") / (10 ** refdec) ))
  done
  echo $(( total * 2 ))
}

if [ "$#" -eq 0 ]; then
  echo "usage: ./verify_tokens.sh 0xTokenAddress [0xTokenAddress ...]"
  exit 1
fi

RPC_HOST=$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/]+).*#\1#')
echo "RPC : $RPC_HOST"
echo

printf '%-10s %-8s %-4s %-14s %-12s %s\n' "SYMBOL" "RESULT" "DEC" "USDC POOLS" "WETH POOLS" "ADDRESS"
printf '%s\n' "---------------------------------------------------------------------------------------"

UNSEEN=0
for TOKEN in "$@"; do
  if ! CODE=$(try_cast cast code "$TOKEN" --rpc-url "$RPC"); then
    printf '%-10s %-8s %s\n' "?" "UNKNOWN" "the RPC did not answer — we learned nothing about $TOKEN"
    UNSEEN=1; continue
  fi
  if [ "$CODE" = "0x" ]; then
    printf '%-10s %-8s %s\n' "?" "FAIL" "no contract at $TOKEN"
    continue
  fi

  SYM=$(try_cast cast call "$TOKEN" "symbol()(string)" --rpc-url "$RPC") || SYM=""
  DEC=$(try_cast cast call "$TOKEN" "decimals()(uint8)" --rpc-url "$RPC") || DEC=""
  if [ -z "$SYM" ] || [ -z "$DEC" ]; then
    printf '%-10s %-8s %s\n' "?" "FAIL" "not a standard ERC-20 (symbol/decimals missing) — $TOKEN"
    continue
  fi
  SYM=$(printf '%s' "$SYM" | tr -d '"')
  DEC=${DEC%% *}

  USDC_D=$(pool_depth "$TOKEN" "$USDC" 6)
  WETH_D=$(pool_depth "$TOKEN" "$WETH" 18)
  TOTAL=$(( USDC_D + WETH_D ))

  if [ "$TOTAL" -eq 0 ]; then
    RES="FAIL"        # هیچ استخری روی صرافی‌های ما — یا آدرس غلط است یا بی‌فایده
  elif [ "$USDC_D" -lt 10000 ] && [ "$WETH_D" -lt 3 ]; then
    RES="THIN"        # وجود دارد ولی کم‌عمق است
  else
    RES="PASS"
  fi

  printf '%-10s %-8s %-4s %-14s %-12s %s\n' \
    "$SYM" "$RES" "$DEC" "\$$USDC_D" "$WETH_D WETH" "$TOKEN"
done

echo
echo "PASS means: a real ERC-20 with pools on the DEXes we route through."
echo "It does NOT mean the token is safe. Check the symbol against a source you"
echo "trust before adding it to the list — a scam token can report any symbol."

if [ "$UNSEEN" -eq 1 ]; then
  echo
  echo "NOTE: this run was incomplete — some rows are UNKNOWN, which means the"
  echo "network did not answer, not that anything is wrong. Re-run."
  exit 3
fi
