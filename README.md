# Zaexa

**A DEX aggregator for Base that shows you the way out before you go in.**

Live contract: [`0x76082b0fbd0a29C236dD2ae2B2F47BFD96d7F455`](https://basescan.org/address/0x76082b0fbd0a29c236dd2ae2b2f47bfd96d7f455#code) — source verified on BaseScan.

The single source of truth for this address is `CHAIN.executor` in `web/index.html`.
The UI suite fails if any document here names a retired deployment as the live one.

**Retired deployments — do not use, do not approve:**

| Address | Why it was replaced |
|---|---|
| `0x6443C06bb117223DC818df54A09A642696D0489c` | retired — no native ETH, a swap needed two signatures |
| `0x9fc4608fA104b032B902650A4D12E0CA51a2F684` | retired — wrong SwapRouter02 selector |
| `0xC261E57cF5739A8a538884405600E4e45dF24802` | retired — took the fee from the output token |
| `0x2fea35aaDae6Cbf9b9481B06164907ccF95DB081` | retired — v1, superseded |
| `0xE980825d4B3911e35Be5804349be26eBBe93BcC6` | retired — v2, superseded by v3 |
| `0xb6AE1C7157f877854C498C44ab5ea3d6742416DC` | retired — v3; the delivered-amount subtraction underflowed for a recipient that moves the payout onward in its own hook |

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

**Swap execution has no backend.** Routing, quoting, simulation and signing all
happen in your browser against public RPCs and your own wallet. There is no
server of ours in the path of a trade, and nothing about your trade is stored.

**Price data and page counts do go through two routes on our own origin**, and
the earlier version of this section wrongly said they did not:

| Route | What it does | What it never does |
|---|---|---|
| `/gt/*` | Cached proxy to the price API, so the rate limit sits on our key instead of your IP. Only four path shapes are allowed; the query string is rebuilt from an allow-list; no header of yours is forwarded; the key never appears in a URL or a response. | Touch a swap, a signature, or a balance |
| `/ev` | Counts page opens and view changes. Records the event name, mobile/desktop, and the country code Cloudflare supplies. | Record a wallet address, an amount, a token, an IP, or any session or visitor id — and it stays silent when Global Privacy Control is set |

Both live in `worker/index.js` on Cloudflare Workers, next to the static files.
Events are kept for three months and then expire. If you host this yourself
without a Worker, set `GT_PROXY_ENABLED` and `EV_ENABLED` to `false` in
`web/index.html` and the page runs with no origin of ours involved at all.

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
contracts/test/           unit, selector, v2/v3/v4 regression, fork against live Base
worker/index.js           the /gt price proxy and the /ev event counter
worker/test.mjs           worker tests, run by run.py before the browser suite
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

**What the owner key can still do** — this list used to read as a complete
account of the trust model, and without these three it was not:

- `_ensureApproval` grants an allow-listed router an unlimited allowance on a
  token. The bound is real: the contract holds nothing between calls, and a
  router's allowance cannot reach your approval to the executor. But inside a
  single transaction, an allow-listed router that is later compromised can take
  the in-flight amount — your `minAmountOut` is the only backstop, because every
  individual step passes `amountOutMinimum: 0` by design.
- `setRouterAllowed` is a single call from one key, with no timelock. The
  allow-list is exactly as strong as that key.
- `rescue` / `rescueETH` move whatever the contract is holding to the owner.
  From v4 they emit events, so the action is at least observable on chain.

Ownership transfer is two-step (`transferOwnership` then `acceptOwnership`), so
the key cannot be handed to an address that cannot accept it.

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

A code review on 18 August 2026 (source reading, no execution) found eight
things worth fixing; all eight are addressed. Two were in this file: it named a
retired contract as the live one, and it denied the existence of the two routes
described under Architecture.

Two of the eight were in the contract, which is not upgradeable, so they needed
a new deployment — the v4 address above. The bug: for a recipient that forwards
the payout onward inside its own hook, the delivered-amount subtraction
underflowed and the swap died with an arithmetic panic instead of a message.
Before shipping the fix, the three tests that cover it were run against v3 and
confirmed to fail there with exactly that panic; a test that passes on the
broken version proves nothing.

---

© 2026 — published for transparency, not licensed for reuse. You are welcome to
read, audit, and learn from this code. It is not open source: no license is
granted to copy, modify, or redistribute it.
