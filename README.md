# Zaexa

**A DEX aggregator for Base that shows you the way out before you go in.**

Live contract: [`0xE980825d4B3911e35Be5804349be26eBBe93BcC6`](https://basescan.org/address/0xe980825d4b3911e35be5804349be26ebbe93bcc6#code) — source verified on BaseScan.

---

## Why this exists

Every aggregator will tell you the price. None of them will tell you whether you
can sell the token back.

Liquidity scores come from pool-depth math, so they cannot see three things that
only appear when a trade actually executes: a tax that switches on only when you
sell, a blacklist applied after you buy, and a honeypot whose sell path reverts.

**Exit check** runs the full round trip — buy and sell — inside a single
simulated transaction against the live chain. No gas, no transaction sent. The
token really moves through the contract, so a sell-side tax or block shows
itself.

Three states, and the difference between them is the whole point:

| State | Meaning |
|---|---|
| `verified` | The round trip executed. This is proof, not an estimate. |
| `estimated` | Figures from quotes. Your wallet lacked the balance or approval to run the live test. |
| `unknown` | The network did not answer. **We do not know** — which is not the same as "no". |

That last row is a rule the whole codebase follows: *"I don't know" must never
behave like "no."*

## What else is in here

- **Every pool on Base, side by side** — six DEXes quoted at once through
  Multicall3. Empty pools show as `no pool`; an unresponsive RPC shows as
  `unknown`. Two different facts, never merged.
- **Real routing** — direct, two-hop via WETH/USDC, and order splitting across
  the two best paths. A `vs Uniswap direct` figure says plainly how much the
  route beats going straight to Uniswap, or says `same` when it doesn't.
- **Token safety scan** — bytecode, ownership, proxy slot, liquidity, sellability.
  Heuristics on public bytecode, not an audit.
- **Portfolio and money flow** — read from `eth_getLogs` on V3 `Swap` events. No
  third-party data service.
- **Reverse quoting** — type what you want to receive, get the input required.
- **Shareable quote links** — the whole state lives in the URL hash.

## Architecture

No backend. The application runs in your browser and signs with your own wallet.
Nothing is stored, nothing is proxied, and there is no server of ours to trust
or to go down. It can be hosted on IPFS.

**No third-party code, either.** `ethers` is vendored rather than pulled from a
CDN, with no remote fallback. A swap page that loads its crypto library from
someone else's server is one compromised CDN away from rerouting your funds —
and "no backend" means little if three other origins can still ship you code.

```
web/index.html            the whole app
web/ethers.umd.min.js     vendored — no third-party script is ever loaded
web/test/run.py           Playwright suite, builds its harness from index.html
web/test/stub-ethers.js   fake ethers + synthetic AMM, no network
contracts/src/            SwapExecutor.sol
contracts/test/           57 tests: unit, selector, and fork against live Base
contracts/script/         deploy, fork test, on-chain DEX and token verification
```

### Contract design

- **No arbitrary calldata.** The contract builds every router call itself, which
  closes the classic aggregator theft vector against users who have approved it.
- **Router allow-list**, enforced on chain.
- **Fee taken from the input token**, so a swap into a worthless token cannot
  leave us holding worthless fees.
- **1% hard fee cap** — a `constant`; the owner cannot raise it.
- **Not upgradeable.** No proxy. A bug means a new deployment, not a silent
  rewrite under your feet.
- **Holds nothing between transactions.**

## Running it

```bash
# the app — no build step
open web/index.html

# offline UI suite (needs playwright + chromium)
cd web/test && python3 run.py

# contracts
cd contracts
forge install foundry-rs/forge-std   # not vendored in this repo
forge test
./script/fork_test.sh                # fork tests against real Base
./script/verify_dexes.sh             # check every DEX address on chain
```

## Status

Deployed and working on Base. Not audited. Fee is currently 0.

---

© 2026 — published for transparency, not licensed for reuse. You are welcome to
read, audit, and learn from this code. It is not open source: no license is
granted to copy, modify, or redistribute it.
