# Phantom connection output compatibility

The initial fresh-approval implementation incorrectly required an account in the signMessage output. The Wallet Standard output contains signedMessage, signature, and optional signatureType; it has no account field. This made an otherwise valid Phantom approval fail with “Wallet did not approve this connection message”.

The fix verifies the signature against the selected account public key, without requiring a nonstandard output account. An extra account, if supplied, is still checked. Exact message, fresh nonce, cancellation, expiration and changed-wallet protections are retained. The regression fixtures now use the documented output without an account; a signature by a different key is rejected.

Primary specification: https://github.com/solana-labs/wallet-standard/blob/master/packages/core/features/src/signMessage.ts
