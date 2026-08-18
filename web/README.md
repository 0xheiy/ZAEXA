# Zaexa — web app

One file. No server, no build step, no install.

```
web/
  index.html               the entire application (HTML + CSS + JS)
  ethers.umd.min.js        vendored, not loaded from a CDN — see below
  walletconnect.bundle.js  vendored too, built by scripts/build_walletconnect.sh
  test/
    run.py                 Playwright suite; builds its own harness from index.html
    stub-ethers.js         fake ethers + a synthetic Base network, no sockets
```

## Running locally

```bash
cd web
python3 -m http.server 8000
# then open http://localhost:8000
```

It also opens over `file://`, but some wallets do not inject there — use the
local server when testing with MetaMask.

That path is tested, not assumed. Enforcing the `integrity` attribute once broke
it completely: a page opened from disk has an opaque origin, Chromium refuses
CORS for the `file` scheme, and the script was blocked before the hash was ever
compared — so the app did not start at all, and said so in a way that blamed the
user's connection. Integrity is now applied only over `http`/`https`, and the
`[file://]` check in `run.py` opens the real `index.html` from disk to confirm it
still starts.

## Publishing

Swap execution has no backend, so the app itself runs from any static host.
Two routes on our own origin are not part of a trade but do exist:

- `/gt/*` — cached proxy to the price API, so the rate limit sits on our key
  instead of the visitor's IP
- `/ev` — counts page opens and view changes; no address, amount, token, IP or
  visitor id, and silent under Global Privacy Control

Both live in `worker/index.js` on Cloudflare Workers. On a host without that
Worker, set `GT_PROXY_ENABLED` and `EV_ENABLED` to `false` near the top of
`index.html`; the app then runs with no origin of ours involved at all, and
falls back to direct price requests.

```bash
npx vercel deploy --prod
npx netlify deploy --prod --dir .
# or pin index.html to IPFS
```

## Tests

The suite runs with no network at all. `stub-ethers.js` plays both the library
and the Base chain, with a constant-product AMM and deliberately lopsided pools
so that order splitting has something real to decide.

```bash
pip install playwright --break-system-packages
playwright install chromium
cd web/test && python3 run.py
```

What it proves:

| Test | What it locks down |
|---|---|
| 1,000 USDC → WETH | direct route, rate, price impact and minimum received |
| 900,000 USDC | order splitting engages and reports what it gains |
| cbBTC → DAI | with no direct pool, the two-hop route via USDC is found |
| **RPC outage** | **the app says "the network did not answer", never "no route"** |
| `exit:no-approval` | a missing approval is not reported as a verdict on the token |
| `exit:honeypot` | a genuine sell-side revert still reads as blocked |
| `exit:hostile-msg` | a revert message that *looks* like ours does not excuse the token |
| `exit:rpc-down` | an outage during the sell simulation reads as `unknown` |
| `exit:split-precondition` | the precondition is measured against the simulated leg, not the whole order |
| `vs uniswap` | a zero edge reads as `same`, never as `+0.00%` |
| `vs uniswap:uniswap-silent` | with no Uniswap quote we claim no edge at all |
| `fallback floor` | the minimum on screen is the minimum that gets signed |
| `recipient sweep` | a forwarding wallet is not told to raise slippage, which could never help |
| `file://` | the real page still starts when opened from disk |
| `one address` | no document names a retired executor as the live one |
| `supply chain` | no remote script, and the integrity hash matches the vendored file |
| share link | state round-trips through the URL |
| hostile share link | a link with an unverifiable token says so instead of falling back |
| DEX gates | both V3 generations route; a wrong-generation quoter is rejected |
| native ETH | ETH is selectable and routes via WETH, with its own safety panel |
| light / dark theme | the toggle works and follows the system setting |
| slippage | 0.5% → 1% updates the minimum received immediately |

The outage rows matter most. That class of bug — treating "I don't know" as
"no" — has appeared seven times in this project's history, and each of those
tests is a headstone for one of them.

## Architecture

There is no server in the path of a trade. The browser talks to public Base RPCs
directly and the user signs with their own wallet. No private key ever leaves the
wallet.

**Quotes go through Multicall3.** Instead of ~45 requests, four:

| Round | What |
|---|---|
| 1 | every direct route, plus leg one of every two-hop route |
| 2 | leg two of the two-hop routes |
| 3 | leg one of each split ratio |
| 4 | leg two of the same |

This is not only a speed optimisation. It separates "no pool" from "the network
did not answer" for free: inside `aggregate3` a failing sub-call is
`success:false`, while a real outage drops the whole request. Same distinction
`try_call` makes on the Python side.

## Implementation notes

- **Native ETH is supported.** The executor wraps and unwraps internally, so
  USDC → ETH needs one signature, not two.
- **The fee comes out of the input token**, so `minAmountOut` is multiplied by
  `(1 − fee)` before slippage — otherwise the transaction reverts for no reason.
- **Every send is preceded by a `staticCall`.** If the simulation fails, nothing
  is broadcast and no gas is spent.
- **After a transaction is sent**, any error concerns *reading* the result. The
  user is told "sent, but we could not read the receipt" — never "failed".
- **ethers is vendored, deliberately.** It used to load from three CDNs with
  fallback. That meant every visitor executed code from a third party — code
  that builds the wallet, signs the transaction, and knows the destination
  address. A compromised CDN could reroute a swap or coax an unlimited approval,
  invisibly. The file now sits next to `index.html`, taken from the npm registry
  (`npm pack ethers@6.13.4`). There is **no CDN fallback**: a fallback to an
  untrusted origin restores the same risk through the back door. If the local
  file is missing the app fails loudly, which is far better than running code
  nobody vetted. A test in `run.py` fails if a remote origin ever reappears.
- **`localStorage` is used, and this file used to claim it was not.** Five
  things persist, all of them the user's own choices or a cache of public data,
  and none of them a wallet address or an amount:

  | Key | What | Why it survives a reload |
  |---|---|---|
  | custom RPC | only ever written by the user typing one | otherwise it has to be re-entered every visit |
  | token logo / pool cache | public metadata, with a TTL | keeps the price API under its rate limit |
  | disconnect flag | "do not auto-reconnect" | a disconnect that undoes itself is not a disconnect |
  | selected pair | the two tokens, **never the amount** | the amount is deliberately dropped, so a stale number cannot be signed |
  | WalletConnect session | written by their SDK, not by us | we only read it to detect a live session |

  Everything read back out is treated as untrusted and re-validated before use —
  a poisoned entry is discarded, not displayed.
- **Token error strings are escaped** before display, so a malicious token
  cannot inject markup through its revert reason.

## Renaming

One line, near the top of the script:

```js
const BRAND = "Zaexa";
```
