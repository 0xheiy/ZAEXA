# Zaexa contracts

`SwapExecutor` is the only contract. It executes a route that the front end has
already planned: one or more parts, each a chain of swap steps across whitelisted
routers, all inside a single transaction.

Live contract: [`0x76082b0fbd0a29C236dD2ae2B2F47BFD96d7F455`](https://basescan.org/address/0x76082b0fbd0a29c236dd2ae2b2f47bfd96d7f455#code)
— deployed on Base, source verified on BaseScan and Sourcify.

The address above is a copy of `CHAIN.executor` in `web/index.html`, which is the
single source of truth. The UI suite fails if the two drift apart, or if any
document here presents a retired deployment as the live one — both happened, and
that is why the check exists. Retired addresses are listed in the root README.

```
constructor(address owner, address feeRecipient, uint256 feeBps, address weth)
```

## Design decisions

**No arbitrary calldata.** The caller passes a structured plan — router, token
pair, fee tier, factory — and the contract encodes the router call itself. An
aggregator that forwards caller-supplied calldata can be told to move tokens
from anyone who has approved it. This one cannot.
Test: `testCannotStealApprovedFunds`

**Router allow-list**, enforced on chain, owner-managed.
Test: `testRejectsUnknownRouter`

**Fee is taken from the input token.** If a user swaps into a scam token, our
fee is still denominated in something real.
Test: `testFeeNotExposedToRiskyOutputToken`

**1% hard fee cap.** A `constant`, not a stored value. The owner cannot raise it.

**Not upgradeable.** No proxy, no admin slot. Fixing a bug means deploying a new
contract and pointing the front end at it — visibly, not silently.

**Holds nothing between transactions.** Every path ends with the contract's
balance of both tokens at zero. Anything sent in by accident — including ETH
forced in via `selfdestruct` — can be recovered with `rescue` / `rescueETH`.

**Every hop is measured, not trusted.** `_swap` reads the contract's balance
before and after calling the router and ignores the router's return value. For
a fee-on-transfer token those two numbers differ, and trusting the router makes
the next hop ask for tokens that never arrived.

**Ownership transfers in two steps.** `transferOwnership` then
`acceptOwnership` from the new address. A mistyped address cannot freeze a
contract that has no upgrade path.

**Router approvals can be revoked.** Removing a router from the allow-list
stops it being *used*; `revokeApprovals` closes the allowance it already holds.

**Native ETH is wrapped and unwrapped inside the contract.** `tokenIn` or
`tokenOut` set to `address(0)` means native. `receive()` accepts ETH only from
the WETH contract, so nobody else can push ETH in.
Test: `testOnlyWethCanSendEth`

**`tokenIn == tokenOut` is allowed.** The front end's exit check needs a full
round trip in one simulated call. Accounting is corrected with
`outBefore -= swapAmount` so the input leg is not counted as output.

### Router generations

`kind` selects how a step is encoded. Getting this wrong produces an empty
revert with no reason string, because the function simply does not exist on the
target:

| kind | router | selector |
|---|---|---|
| 0 | Uniswap V2 style | `swapExactTokensForTokens(uint256,uint256,address[],address,uint256)` |
| 1 | Uniswap SwapRouter02 (7-field struct) | `0x04e45aaf` |
| 2 | Solidly / Aerodrome | `swapExactTokensForTokens(...,(address,address,bool,address)[],...)` |
| 3 | SwapRouter 1st generation (8-field, with `deadline`) | `0x414bf389` |

Base uses SwapRouter02 for Uniswap V3, but PancakeSwap V3 on Base is still the
first generation — hence kind 3. Both are covered by fork tests, in both
directions: the right kind succeeds and the wrong kind reverts.

## Running

`forge-std` is not vendored in this repository:

```bash
forge install foundry-rs/forge-std
forge test
```

57 tests: 33 unit, 11 covering the v2 changes, 5 selector (offline,
milliseconds), and 8 fork against live Base.

```bash
./script/fork_test.sh      # local anvil on a pinned block, then the fork tests
./script/verify_dexes.sh   # check every DEX router and quoter on chain
./script/deploy.sh         # deploy and allow-list, gated on the test suite
```

All three read `contracts/.rpc` first — one line, your RPC URL, `chmod 600`, git
ignored — and fall back to public endpoints.

### Notes that cost us time

- A fork test that passes with ~2400 gas was **skipped**, not run. Check the gas
  number before believing a green fork test.
- Pin the fork block (`.fork-block`). Without it, forge's cache is invalidated
  on every run and public RPCs start returning 429 mid-suite.
- `forge create` sometimes reports "contract was not deployed" when it was.
  Verify with `cast compute-address` and `cast code`.
- `--constructor-args` must be the last argument to `forge create`, or it
  swallows the ones after it.
- If a new local variable triggers `Stack too deep`, extract an internal
  function — as `_validatePlan` and `_runParts` already do. Do not enable
  `via_ir`.

## Status

Deployed, verified, and in use. Fee is currently 0 bps. Not audited.
