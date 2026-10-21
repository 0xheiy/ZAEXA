# Zaexa — project status

The detailed working notes (open work, decisions, history) are kept privately by the
maintainer and are no longer published in this repository.

## Active contract

The only valid SwapExecutor on Base is the one shown on the site footer and in
`web/index.html` (`CHAIN.executor`). Never approve tokens to any other address.

## Tests

- Web UI: `python3 web/test/run.py` (about 20 minutes; run it in the background)
- Worker: `node worker/test.mjs`
- Security: `npm run test:security`
- Solana: `node --test web/test/solana-*.test.mjs` and `node --test scripts/solana-wallet/intent.test.mjs`
- Contracts: `forge test` in `contracts/`

The `[report body unchanged]` probe compares against commit `6944652`, so a shallow
clone needs `git fetch --unshallow` first.
