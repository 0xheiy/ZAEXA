# Zaexa contracts

`SwapExecutor` is the only contract. It executes a route that the front end has
already planned: one or more parts, each a chain of swap steps across whitelisted
routers, all inside a single transaction.

Live contract: [`0x5f3FCcfF3339DAa9eA7D2EBC3f77017D65467132`](https://basescan.org/address/0x5f3fccff3339daa9ea7d2ebc3f77017d65467132#code)
— deployed on Base, source verified on BaseScan and Sourcify.

The address above is a copy of `CHAIN.executor` in `web/index.html`, which is the
single source of truth. The UI suite fails if the two drift apart, or if any
document here presents a retired deployment as the live one — both happened, and
that is why the check exists. Retired addresses are listed in the root README.

```
constructor(address owner, address feeRecipient, uint256 feeBps, address weth,
            address[] feeTokens)   // v6
```

### v6 (live at the address above since 10 Nov 2026; v5 is retired)

`executeSwap` keeps its signature, so the
web client's calls are unchanged — but it is **not** only an address swap:
the constructor gained `feeTokens`, the `Swapped` event gained a trailing
`feeToken` field (so its signature and **topic0 changed** — any log filter or
indexer keyed on the v5 `Swapped` must be updated), and there are new events
`FeeTokenSet`, `FeeTaken`, `FeeSkipped`, `Refunded`. Quotes for a swap whose
fee is taken mid-route or on the output must subtract the fee once it is above
0 bps.

- **Fee-token allowlist.** `feeToken(address)` is owner-managed
  (`setFeeToken`, event `FeeTokenSet`), seeded from the constructor's
  `feeTokens`. WETH is always on it and cannot be removed; no stablecoin
  address is hardcoded. `feeRecipient` can never be the contract itself.
- **Fee rule.** Charged once per leg, at the first point the leg's value is
  in a fee token: on the input, up front, when the input is one (buys, as v5);
  otherwise on the output of the leg's first fee-token hop, in flight (sells,
  and unknown → USDC → token); a leg that never touches a fee token pays from
  its input share; when no leg touches one, the input pays up front (v5
  fallback). `minAmountOut` is checked against what reaches the user, net of
  the fee and any transfer tax. Refunds after a leg's fee point are not charged
  again. Two shapes revert instead of leaving value uncharged: an intermediate
  left over before its leg's fee point (`leftover before fee point`), and the
  output token produced before the leg's fee point (`output before fee point`).
  One `FeeTaken` per fee transfer; `Swapped.fee`/`feeToken` are the total and
  its token, or `0`/`address(0)` when legs paid in different tokens.
- **A failing fee transfer never blocks a swap.** The amount taken is the
  contract's balance delta around the transfer — its return value is ignored —
  with gas capped at 150k and no return data copied. Nothing moved (revert,
  `false`, out of gas) → `FeeSkipped`, the user keeps it.
- **Unspent input and intermediate tokens are refunded** to the caller
  (`Refunded`) after the output has been delivered and checked, measured as
  balance growth over a snapshot taken at the start of the call, so balances
  the contract already held are never paid out. Native-ETH input is refunded as
  WETH. On a loop route the input is the output token, so unspent input is
  delivered as output rather than refunded. A refund that cannot be delivered
  reverts the swap.

**Accepted limits** (documented, not fixed):

- *Value injected from outside.* A caller who brings their own value into the
  route — a pool they control and price, or a tiny fee-token input that a
  manipulated pool inflates — can still steer around the fee. That cannot be
  closed on-chain without prices, it was equally true of v5, and such a caller
  could skip the executor and call the routers directly anyway. The fee rule
  above closes the bypasses that use only the executor's own accounting.
- *Input-side fee on a partial fill.* When the fee is taken on the input up
  front, it is charged on the whole input before the route runs: a 60% fill
  pays the fee on 100%. The unspent 40% is refunded fee-free. (A fee taken in
  flight is charged only on what actually reached the fee point.)

`./script/deploy.sh` reads the list from `FEE_TOKENS` (comma-separated, no
default), checks every entry has code, and prints each `symbol()` before
asking for confirmation.

**v6 must be built with `FOUNDRY_PROFILE=executor`** (solc 0.8.33, evm
cancun, optimizer 200 runs — pinned in `foundry.toml`). Unoptimized, its runtime
is 29,816 bytes, over the 24,576-byte EIP-170 limit (v5 fit with 196 bytes to
spare). Under the executor profile: **16,561 bytes runtime, 8,015 bytes of
margin**. The default profile is unchanged. `deploy.sh` and `fork_test.sh`
export the profile, so the test gate, fork tests, `forge create` and the
printed verify command all use the same bytecode; `deploy.sh` also gates on
SwapExecutor's own runtime size. Verifying with any other settings will not
match.
Tests: `test/SwapExecutor.v6.t.sol`.

## Design decisions

**No arbitrary calldata.** The caller passes a structured plan — router, token
pair, fee tier, factory — and the contract encodes the router call itself. An
aggregator that forwards caller-supplied calldata can be told to move tokens
from anyone who has approved it. This one cannot.
Test: `testCannotStealApprovedFunds`

**Router allow-list**, enforced on chain, owner-managed.
Test: `testRejectsUnknownRouter`

**Fee is taken in the token that is worth something.** If a user swaps into a
scam token, our fee is still denominated in something real. Up to v5 that meant
"always the input"; v6 picks the side from the fee-token allowlist (see above),
so a sell into a stablecoin pays its fee in the stablecoin, not the scam token.
Tests: `testFeeNotExposedToRiskyOutputToken`, `testSellTakesFeeFromOutput`

**1% hard fee cap.** A `constant`, not a stored value. The owner cannot raise it.

**Not upgradeable.** No proxy, no admin slot. Fixing a bug means deploying a new
contract and pointing the front end at it — visibly, not silently.

**Holds nothing between transactions.** Every path ends with the contract's
balance of both tokens at zero — since v6 that includes partial fills, whose
unspent input and intermediate tokens are refunded. Anything sent in by accident — including ETH
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

164 offline tests across 9 suites (v6 adds 45 in `SwapExecutor.v6.t.sol`,
one of them a fuzzed balance invariant); run them under both profiles,
plus 13 fork tests against live Base (`*.fork.t.sol`, run only via
`fork_test.sh`).

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

## Uniswap v4 adapter

`src/UniswapV4Adapter.sol` routes Uniswap v4 pools through the existing executor
(`KIND_ADAPTER = 5`), so the live executor is not redeployed. It only becomes
usable after the owner allow-lists it (`script/deploy_v4_adapter.sh`, then
`script/allow_adapter.sh <adapter>`). The adapter's PoolManager is Base
`0x498581fF718922c3f8e6A244956aF099B2652b2b`.

SwapStep fields are reused as the v4 PoolKey: `feeTier` = fee, `tickSpacing` =
tickSpacing, `poolFactory` = hooks (zero = hookless), `stable` = "the WETH side
of this pool is native ETH". Currencies are sorted by address after mapping
WETH to `address(0)` when `stable` is true.

Exact-input only. The input delta must equal exactly the amount traded and the
output must be positive, otherwise it reverts; the adapter must end with no
tokenIn and unchanged WETH/ETH balances. Only the executor can call `swap`;
only the PoolManager can call the callback, and only during our own swap.
`script/fork_test.sh` also runs `test/UniswapV4Adapter.fork.t.sol`
(native ETH/USDC pool, keys 500/10 and 3000/60, skipped if not initialised).

## Status

Deployed, verified, and in use. Fee is currently 0 bps. Not audited.
