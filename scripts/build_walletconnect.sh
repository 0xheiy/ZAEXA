#!/usr/bin/env bash
# Rebuild web/walletconnect.bundle.<hash>.js from source.
#
# WalletConnect does not ship a self-contained browser build: its own UMD file
# expects viem, lit, bs58, valtio, qrcode and big.js to already exist as globals
# on the page. So we bundle it ourselves.
#
# The committed bundle is a build artefact — 2 MB of minified code nobody can
# read. This script exists so it does not have to be trusted: run it, compare
# the hash, and you know the file in the repo is exactly what these pinned
# versions produce.
#
# The file name carries the first 8 hex characters of its own sha256 (content
# addressing), which is what lets web/_headers cache it forever without ever
# serving a stale copy — see web/_headers for why. If EXPECTED_SHA below no
# longer matches what this script produces, this script itself renames the
# output file to match; you still have to `git mv` the old one away and fix
# the two literal "./walletconnect.bundle.<hash>.js" references in
# web/index.html by hand (run.py's `check_asset_cache_headers` will catch it
# if you forget).
#
# Usage:  ./scripts/build_walletconnect.sh
# Then:   sha256sum web/walletconnect.bundle.*.js
set -euo pipefail

WC_VERSION="2.23.10"
ESBUILD_VERSION="0.28.2"
EXPECTED_SHA="9d119cbe8dafaadf3964f897079d471fc7c4576ca06db0015b3e56cdda10b1a5"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund \
  "@walletconnect/ethereum-provider@$WC_VERSION" "esbuild@$ESBUILD_VERSION" >/dev/null

printf 'import { EthereumProvider } from "@walletconnect/ethereum-provider";\nexport { EthereumProvider };\n' > entry.js

npx esbuild entry.js \
  --bundle --format=iife --global-name=WCProvider \
  --minify --target=es2020 --legal-comments=none \
  --outfile="$WORK/out.js"

ACTUAL="$(sha256sum "$WORK/out.js" | cut -d' ' -f1)"
OUT="$ROOT/web/walletconnect.bundle.${ACTUAL:0:8}.js"
cp "$WORK/out.js" "$OUT"

echo
echo "built:    $OUT"
echo "sha256:   $ACTUAL"
echo "expected: $EXPECTED_SHA"
if [ "$ACTUAL" = "$EXPECTED_SHA" ]; then
  echo "MATCH - the committed bundle is reproducible."
else
  echo "MISMATCH - the bundle changed. The new file is $OUT (named from its own"
  echo "hash). Review it, remove the old web/walletconnect.bundle.*.js, update the"
  echo "two references in web/index.html, and update EXPECTED_SHA in this script."
  exit 1
fi
