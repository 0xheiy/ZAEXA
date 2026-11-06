#!/usr/bin/env bash
# =============================================================================
# ساخت دوباره‌ی worker/v4_roundtrip_code.js از روی src/V4RoundTrip.sol
#
#   ./script/build_roundtrip.sh            # فایل worker/v4_roundtrip_code.js را می‌نویسد
#   ./script/build_roundtrip.sh --print    # فقط بایت‌کدِ runtime را چاپ می‌کند (برای تست)
#
# بایت‌کد باید قطعی باشد: solc پین‌شده (SOLC، پیش‌فرض 0.8.33)، evm=cancun،
# بهینه‌ساز ۲۰۰، بدونِ متادیتا. با solc دیگر خروجی فرق می‌کند و تستِ worker قرمز می‌شود.
# در کانتینر که binaries.soliditylang.org بسته است: SOLC=/مسیر/solc-static-linux
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

command -v forge >/dev/null || { echo "forge پیدا نشد."; exit 1; }
SOLC="${SOLC:-0.8.33}"
WANT_SOLC=0.8.33
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FOUNDRY_EVM_VERSION=cancun FOUNDRY_OPTIMIZER=true FOUNDRY_OPTIMIZER_RUNS=200 \
FOUNDRY_BYTECODE_HASH=none FOUNDRY_CBOR_METADATA=false FOUNDRY_OUT="$TMP/out" FOUNDRY_CACHE_PATH="$TMP/cache" \
  forge build --use "$SOLC" --silent src/V4RoundTrip.sol >&2

JSON="$TMP/out/V4RoundTrip.sol/V4RoundTrip.json"
# نسخه‌ی واقعیِ کامپایلر از خودِ خروجی خوانده می‌شود، نه از نامِ فایل
GOT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["metadata"]["compiler"]["version"])' "$JSON")
[[ "$GOT" == "$WANT_SOLC"* ]] || { echo "solc باید $WANT_SOLC باشد، شد $GOT"; exit 1; }
CODE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deployedBytecode"]["object"])' "$JSON")
[[ "$CODE" =~ ^0x[0-9a-f]+$ ]] || { echo "بایت‌کد نامعتبر"; exit 1; }

if [ "${1:-}" = "--print" ]; then echo "$CODE"; exit 0; fi

OUT="../worker/v4_roundtrip_code.js"
cat > "$OUT" <<JS
/* تولیدشده با contracts/script/build_roundtrip.sh از contracts/src/V4RoundTrip.sol — دست نزن.
   solc ${WANT_SOLC}، evm=cancun، optimizer 200، بدونِ متادیتا. worker/v4_roundtrip_code.test.mjs
   تساویِ این ثابت با یک ساختِ تازه را می‌سنجد. */
// آدرسِ دلخواه و بی‌کد؛ فقط در stateOverride کد می‌گیرد، هرگز دیپلوی نمی‌شود.
export const V4RT_ADDRESS = "0x5a45584152540000000000000000000000000001";
export const V4RT_CODE = "${CODE}";
JS
echo "نوشته شد: $OUT (${#CODE} نویسه)" >&2
