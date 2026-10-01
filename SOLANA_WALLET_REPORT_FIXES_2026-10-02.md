# Wallet and token-report corrections — 2026-10-02

Implementation is local until deployment is verified.

- Token reports for Solana now share the Base structure: identity, price, Trade/Copy link, exit check, chart/market data, and a safety panel. The swap form, duplicate wallet button and indexed-pool list are hidden in the report; Trade opens the existing /app Solana swap without carrying a reference-test amount.
- Token addresses determine the report's network. Opening a Base report after selecting Solana shows Base in the header; opening a Solana report shows the Solana wallet. Changing networks from a report navigates to the matching app rather than relabelling a token from the other chain.
- New pages do not silently connect a remembered Solana wallet. Disconnect clears local wallet/account/quote/balances, forgets the remembered name, calls the wallet disconnect API where available, and prevents an immediate reconnect from racing that disconnect. A disconnected WalletConnect session is replaced before reconnecting.
- Mobile connection shows Phantom and Solflare options that open the current page inside the wallet on the same phone. WalletConnect is a separate QR option with a visible icon. Installed Wallet Standard wallets remain selectable.
- Unavailable market statistics do not leave a permanent loading skeleton.

The connection behavior described above was subsequently strengthened: every explicit connection requires fresh, verified message approval inside the wallet before the site shows connected. See SOLANA_CONNECTION_APPROVAL_2026-10-02.md.

Sources:
- https://docs.phantom.com/solana/establishing-a-connection
- https://raw.githubusercontent.com/phantom/docs/master/phantom-deeplinks/other-methods/browse.md
- https://docs.solflare.com/solflare/technical/deeplinks/other-methods/browse

Validation: 38 regression/server tests and dedicated report/mobile/portfolio/flow browser checks passed. Full browser regression suite passed with no console errors. Wallet browse-link destinations are checked; opening an installed wallet on a physical phone remains a device check. No real wallet transaction was sent.
