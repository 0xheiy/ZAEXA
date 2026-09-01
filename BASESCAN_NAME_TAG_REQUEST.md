# BaseScan public name tag — submission text

**Where to send it:** BaseScan → Contact Us, category **"Address Related — Update Public Name Tag / Label"**.
Direct link (address pre-filled):

https://basescan.org/contactus?id=5&a=0x76082b0fbd0a29C236dD2ae2B2F47BFD96d7F455

You need to be signed in to a BaseScan account, and the reply comes to that
account's email. Submitting from an address you control is not required, but
declaring ownership is — that is the part their curators actually check.

---

## Paste this into the message field

```
Subject: Public name tag request — ZAEXA: Swap Executor (0x76082b0f...F455)

Hello,

I am requesting a public name tag for a verified contract we own and operate
on Base.

Address:        0x76082b0fbd0a29C236dD2ae2B2F47BFD96d7F455
Requested tag:  ZAEXA: Swap Executor
Contract name:  SwapExecutor
Network:        Base mainnet

What it is
This is the settlement contract behind ZAEXA, a DEX aggregator on Base at
https://zaexa.com. A user's swap is routed across several Base DEXes and
executed through this contract in a single transaction, with a minimum-output
check that reverts the whole transaction if the delivered amount falls short.
It holds no user funds between transactions.

Why the tag matters
Because the address carries no public label, wallet security tools and token
approval managers (Revoke.cash and similar) display our contract as "Unknown"
when a user reviews or revokes an approval. Users are being asked to judge an
unnamed address, which is exactly the situation those tools exist to warn
about. A public name tag lets an ordinary user match what they see in their
wallet to the site they are actually on.

Ownership
The contract's owner() is 0x8A0Dcb583C8CAdc481E34487c34f1B856fe97e23, an
address we control. We publicly declare ownership of both the contract and the
owner address.

Verification and references
- Source code verified on BaseScan and on Sourcify.
- Website:  https://zaexa.com
- X:        https://x.com/zaexadex
- Email:    zaexadex@gmail.com
- Source:   https://github.com/0xheiy/ZAEXA

Happy to provide a signed message from the owner address, or any other proof
of control you need.

Thank you,
ZAEXA
```

---

## Two things worth knowing before you send

- Etherscan-family curators weigh "owner's interest in displaying the address
  publicly" and "whether the address is of public interest". A live site with
  real traffic and verified source is the strongest part of this request, so
  it is worth sending **after** the site has some visible activity rather than
  before.
- They may ask you to sign a message from `0x8A0Dcb…7e23` to prove control.
  Have that wallet reachable when you reply.

## Sources

- [Public Name Tags, Labels & Public Notes — Etherscan Information Center](https://info.etherscan.com/public-name-tags-labels/)
- [BaseScan Contact Us](https://basescan.org/contactus?id=5&a=0x71c7656ec7ab88b098defb751b7401b5f6d8976f)
- [Label Word Cloud — BaseScan](https://basescan.org/labelcloud)
