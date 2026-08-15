#!/usr/bin/env bash
# Rebuild web/walletconnect.bundle.js from source.
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
# Usage:  ./scripts/build_walletconnect.sh
# Then:   sha256sum web/walletconnect.bundle.js
set -euo pipefail

WC_VERSION="2.23.10"
ESBUILD_VERSION="0.28.2"
EXPECTED_SHA="9d119cbe8dafaadf3964f897079d471fc7c4576ca06db0015b3e56cdda10b1a5"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/web/walletconnect.bundle.js"
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
  --outfile="$OUT"

ACTUAL="$(sha256sum "$OUT" | cut -d' ' -f1)"
echo
echo "built:    $OUT"
echo "sha256:   $ACTUAL"
echo "expected: $EXPECTED_SHA"
if [ "$ACTUAL" = "$EXPECTED_SHA" ]; then
  echo "MATCH - the committed bundle is reproducible."
else
  echo "MISMATCH - the bundle changed. Review before committing, then update"
  echo "EXPECTED_SHA in this script."
  exit 1
fi
