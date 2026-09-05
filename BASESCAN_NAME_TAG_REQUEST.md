# BaseScan public name tag — record and playbook

## What is tagged today

| Address | Tag | Status | Granted |
|---|---|---|---|
| `0x15e511Bf2Ea1a0F50F25E973d57Dce0D01946b6d` | `Zaexa: Swap Executor` | live — v5, the current executor | 4 September 2026 |

Confirmed on the address page itself, not only from the approval email.

---

## 🔴 Read this before deploying a new executor

**A name tag belongs to one address and does not follow a redeploy.** Deploy a
v6 and it starts life unlabeled, exactly as v5 did. That much is expected.

The part that is easy to miss: **the retired contract keeps its tag.** So the
day after a redeploy, BaseScan would show the *dead* contract as
`Zaexa: Swap Executor` and the *live* one as nothing — an unnamed address next
to a named one that no longer settles anything. Anyone checking an approval
would be reading the wrong contract with our name on it. That is worse than
having no tag at all, and it is the same failure the repo already guards
against elsewhere: both READMEs once called a retired contract "Live contract"
and linked to it with `#code`.

So a redeploy is **two** requests, not one:

1. **Tag the new address** — the template below, with the new address.
2. **Remove the tag from the old one** — BaseScan Contact Us, *Option #9,
   Request Removal of Name Tag*. Only the owner or the contract's deployer may
   ask, and it needs a message signed by the **deploying address**, with a
   `dd/mm/yyyy hh:mm:ss` timestamp in their template. Removal can be refused
   if they judge the tag to be in the public interest, so send it early rather
   than after the old contract has been sitting there labeled for months.

Then update the table above: add the new row, and mark the old row
**retired** — do not delete it. `check_one_executor_address` in
`web/test/run.py` walks the docs looking for retired addresses presented as
live, and an unlabeled leftover row is exactly what it exists to catch.

---

## The request template

Send to: BaseScan → Contact Us, category
**"Address Related — Update Public Name Tag / Label"**:

```
https://basescan.org/contactus?id=5&a=<ADDRESS>
```

Sign in to a BaseScan account first — the reply comes to that account's email.
Replace `<ADDRESS>` and `<SHORT>` (first six and last four characters) below.

```
Subject: Public name tag request — Zaexa: Swap Executor (<SHORT>)

Hello,

I am requesting a public name tag for a verified contract we own and operate
on Base.

Address:        <ADDRESS>
Requested tag:  Zaexa: Swap Executor
Contract name:  SwapExecutor
Network:        Base mainnet
Category:       DeFi

What it is
This is the settlement contract behind Zaexa, a DEX aggregator on Base at
https://zaexa.com. A user's swap is routed across several Base DEXes and
executed through this contract in a single transaction, with a minimum-output
check that reverts the whole transaction if the delivered amount falls short.
It holds no user funds between transactions.

Why the tag matters
Because the address carries no public label, wallet security tools and token
approval managers display our contract as "Unknown" when a user reviews or
revokes an approval. Users are being asked to judge an unnamed address, which
is exactly the situation those tools exist to warn about. A public name tag
lets an ordinary user match what they see in their wallet to the site they are
actually on.

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
Zaexa
```

---

## What the first request actually taught us

- **The signature is not optional.** The old note here said they *may* ask for
  one. They did: the approval came back carrying
  `***MESSAGE SIGNATURE IS VALID***` and named the required signer. Have
  `0x8A0Dcb…7e23` reachable before you send, not after.
- It was granted the day after sending, with the site live and the source
  verified. Curators weigh "the owner's interest in displaying the address
  publicly" and "whether the address is of public interest", so a request sent
  before there is a working site is the weaker version of this request.
- **It does not fix the wallet warnings.** Rabby and Pocket Universe keep their
  own label databases and do not read BaseScan, so Rabby's
  "Unknown Signature Type" (bug 11) survives this tag. The FAQ answer that says
  so is still correct and should not be edited.

## Sources

- [Public Name Tags, Labels & Public Notes — Etherscan Information Center](https://info.etherscan.com/public-name-tags-labels/)
- [Public Name Tag Removal — Etherscan Information Center](https://info.etherscan.com/public-name-tag-removal/)
- [Label Word Cloud — BaseScan](https://basescan.org/labelcloud)
