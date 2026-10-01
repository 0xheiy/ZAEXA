# Solana parity — 21-item checklist (2026-10-01)

Status: implementation and validation complete; deployment verification is recorded separately. Preserve drafts/.

| # | Implementation |
|---|---|
| 1 | Chain-aware quote sharing, both token addresses, amount and ExactOut mode; matching URL reader. |
| 2 | Solana wallet connection in portfolio; existing published fix retained. |
| 3 | Solana flow state isolated from Base; existing published fix retained. |
| 4 | Header/footer new-pairs links preserve Solana. |
| 5 | Yellow price-impact warning above 1.5%, red above 5%; resets with quote. |
| 6 | Protocol fee from quote.platformFee.feeBps; absent fee means zero; malformed fee unknown. |
| 7 | Independent selection of both swap legs, balances/decimals, exact raw amount parsing, output-amount budget. |
| 8 | Native/legacy/Token-2022 portfolio, known USD value, total, percentages and logos. |
| 9 | Top buyers and sellers grouped by reported sender, with explicit 300-trade, single-pool sample coverage. |
| 10 | Token-page Solana chart, selected token's side of the pool, stale-result guards. |
| 11 | Mint/freeze authority, epoch-specific transfer fee/cap, largest-20-account share, additional extensions; unknown stays unknown. |
| 12 | Separately fetched direct-only quote comparison, ExactIn/ExactOut semantics, no guaranteed savings claim. |
| 13 | Indexed pools with liquidity, volume and DEX; additional pages loaded on demand. Index coverage is not all on-chain liquidity. |
| 14 | Locally bundled WalletConnect Universal Provider, QR, cancel/reconnect, mainnet and account checks, unchanged-message signing adapter. |
| 15 | Trade action for Solana pairs rows with chain-aware link. |
| 16 | Solana funnel events and closed network dimension; no token/address/amount in event payload. |
| 17 | Base and Solana sitemap entries; independent upstream failure handling and new cache key. |
| 18 | Hourly follow-up/recheck selection includes valid Solana addresses under existing age/cap budgets. Negative publication guard retained. |
| 19 | Empty-pool cause only when all returned matching indexed pools explicitly report zero; missing data or no pools is unknown. No unsupported drained-pool claim. |
| 20 | Malformed address error card/404 and unreadable on-chain mint card; transport errors remain unknown. |
| 21 | Landing page and FAQ describe both chains, custody/server roles and actual quote fees. |

Validation completed so far: 30 unit/regression tests; 7 new server tests; complete Worker suite; portfolio/flow browser suite; new parity browser suite including real QR rendering against a fake wallet. Full browser suite passed, including Base and Solana regressions. No real wallet transaction sent.

Build mobile bundle: `cd scripts/solana-wallet && npm ci --ignore-scripts && node build.mjs`. Dependencies pinned with package-lock.json. WalletConnect session storage is managed by the SDK; pairing codes are never sent to analytics.

Logs: /home/hesam/zaexa-parity-{all-unit,worker,features,browser,full-browser}.log.
Sources: https://docs.reown.com/advanced/providers/universal ; https://docs.reown.com/advanced/multichain/rpc-reference/solana-rpc ; https://solana.com/docs/rpc/http/gettokenlargestaccounts


## Mobile and Base layout parity

Solana now uses the same hero and lower-panel grid as Base. The swap precedes the chart on mobile; pools and the combined exit/safety panel follow. On desktop, pools and safety share the lower row rather than appearing as separate full-width cards. The direct-route comparison is inside the same facts section; route/notices share a reserved status area.

Browser checks passed at 360, 375, 390, 430, 768 and 1280 pixels in light and dark themes. Assertions compare swap position, width and input-leg height directly against Base, check panel order/alignment and reject horizontal page overflow. Reviewed rendered 390-pixel screenshot. Solana-specific network fee and account-rent disclosures remain visible.

Final verification logs: /home/hesam/zaexa-mobile-{unit,layout,compare,worker,views,full}.log. Full suite completed successfully before publishing. No real wallet transaction or real mobile-wallet pairing has been performed.

Final passing full-browser log: /home/hesam/zaexa-complete-browser.log. Main-card Connect wallet opens the Solana picker; a failed sell-back check keeps its explicit blocked reason.
