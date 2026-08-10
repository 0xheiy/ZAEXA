# Zaexa — web app

One file. No server, no build step, no install.

```
web/
  index.html          the entire application (HTML + CSS + JS)
  test/
    run.py            Playwright suite; builds its own harness from index.html
    stub-ethers.js    fake ethers + a synthetic Base network, no sockets
```

## Running locally

```bash
cd web
python3 -m http.server 8000
# then open http://localhost:8000
```

It also opens over `file://`, but some wallets do not inject there — use the
local server when testing with MetaMask.

## Publishing

Any static host works, because there is no backend:

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
| `vs uniswap` | a zero edge reads as `same`, never as `+0.00%` |
| `vs uniswap:uniswap-silent` | with no Uniswap quote we claim no edge at all |
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

There is no server. The browser talks to public Base RPCs directly and the user
signs with their own wallet. No private key ever leaves the wallet.

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
- **No `localStorage`.** Theme and imported tokens live in the tab only.
- **Token error strings are escaped** before display, so a malicious token
  cannot inject markup through its revert reason.

## Renaming

One line, near the top of the script:

```js
const BRAND = "Zaexa";
```
