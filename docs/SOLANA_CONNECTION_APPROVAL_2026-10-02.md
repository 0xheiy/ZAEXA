# Fresh Solana connection approval — 2026-10-02

Previously a remembered wallet could return its address from `standard:connect` without opening an approval prompt. ZAEXA immediately treated that address as connected, even while the extension was locked.

Every explicit connection now requests a fresh message signature before setting `solAccount` or `solWalletApi`. The message identifies the website and account, includes a random nonce and timestamp, and explicitly states that it is not a transaction, has no network fee, and grants no spending permission. The exact returned message, account/public key and Ed25519 signature are verified locally. No proof is stored or reused. A wallet without message approval support remains disconnected with an explanation.

The header remains in “Approve in wallet…” state while waiting. Rejection, cancellation, expiration, wrong account, invalid signature, or a delayed response after disconnect cannot connect the site. Account changes retire the approved connection. Reload does not silently reconnect. WalletConnect requests and verifies `solana_signMessage` using its documented base58 message/signature format.

Validation: 41 unit/server regression tests passed, including 10 actual Ed25519 approval tests. Dedicated browser checks passed for pending header state, rejection, cancellation, delayed approval, fresh reconnect, and the WalletConnect adapter. Mobile layouts remain within the viewport at 360/375/390/430/768/1280 in both themes. Test keys were generated locally; no real wallet signature or transaction was requested. The complete browser regression suite also passed with no console errors. Public deployment results are recorded separately.

The broader transaction browser fixtures use fixed non-signing keys and stub only connection confirmation, because transaction bytes depend on those keys. Dedicated approval tests exercise the actual production confirmation and cryptographic verification.

Sources: https://docs.phantom.com/solana/signing-a-message and https://docs.reown.com/advanced/multichain/rpc-reference/solana-rpc.
