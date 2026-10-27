# Solana wallet on New pairs

New pairs previously displayed or connected the Base/EVM wallet even when the Solana tab was selected. Solana now has its own Wallet Standard picker, address menu, copy/disconnect actions, same-phone Phantom/Solflare options and WalletConnect QR. The selected network controls the header; Base wallet restoration cannot overwrite a Solana address. No EVM wallet request is made when opening the Solana pairs page.

Connection message verification is shared by the app and pairs page through scripts/solana-wallet/connection.js in the locally bundled library. It preserves the corrected Phantom/Wallet Standard output format. Every connection requires a fresh verified message approval; cancellation, stale approval, manual disconnect, reload, or a network change during approval cannot silently connect. The pairs page has no transaction action.

Validation: 43 unit/server tests and the app/report/mobile parity browser suite passed. Dedicated pairs browser checks passed for valid approval, rejection, cancel followed by late approval, fresh reconnect, reload, Base/Solana wallet separation, mobile browse options and real QR rendering against a fake provider. No page errors or horizontal overflow at 360/390/430/1280. No real wallet signatures or transactions were requested. The complete regression suite also passed with no browser console errors; deployment checks are recorded separately.

The new pairs script and shared library have content hashes for cache-safe publication. The existing static JSON-path check now examines same-quote single-line literals, avoiding a false match across unrelated JavaScript statements while also checking single-quoted paths.
