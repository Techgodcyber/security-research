# Case study: Firelight payout pricing (Immunefi audit competition)

| | |
|---|---|
| Program | Immunefi Audit Comp, Firelight (ended Sep 29, 2026) |
| Target | `contracts/core/IncidentManager.sol`, `contracts/core/FirelightVault.sol` |
| Submitted | Aug 16, 2026, as High |
| Outcome | Closed: out of scope (accepted collateral risk) |
| Code | https://github.com/immunefi-team/audit-comp-firelight (tag `v1_audit_ready`) |

I'm publishing this one because it was rejected. The review showed a mistake in my reasoning, and that is more useful to write up than a clean win.

## What Firelight does

Firelight is a cover (insurance) protocol. Depositors put an asset into `FirelightVault`, and the vault backs cover for incidents. When an incident is assessed, the loss is recorded in USD. On approval, `IncidentManager._executePayout()` converts that USD loss into vault asset units and calls `FirelightVault.payout()`.

## What I reported

Two things happen at different times:

1. **Conversion uses the live price at approval.** `_executePayout()` reads `priceFeedAdapter.getPrice()` when `approveCurrentAssessment` is called, then converts the remaining USD loss into asset units. The `Incident` struct stores no price from capture time.
2. **The vault caps payouts in asset units fixed at the start of the covered period.** `payout()` caps the amount at `totalAssetsAt(capturePeriodStart)`.

If the asset price falls between capture and approval, the requested units grow and hit the unit cap. In my Hardhat tests against the real vault:

| Price at approval | Units requested | Unit cap | Units paid | USD delivered |
|---|---|---|---|---|
| $1.00 | 1,000 | 1,000 | 1,000 | $1,000 (100%) |
| $0.50 | 2,000 | 1,000 | 1,000 | $500 (50%) |

I argued that payout should be priced at capture time, and I proposed storing `capturePriceUSD` on the incident and using it in `_executePayout()`.

The tests passed and the behaviour is real. The conclusion was wrong.

## Why it was rejected

The triager's key point: my own fix does not change the result.

With the price locked at $1.00, the vault requests $1,000 / $1.00 = 1,000 units. The cap is 1,000, so it pays 1,000 units. At the real market price of $0.50, those units are worth $500. The cover holder gets the same $500 either way.

The shortfall comes from the collateral itself losing value, which leaves the vault undercollateralized against its USD obligations. The program lists that as an accepted risk of the underlying asset, not a logic bug: a severe drawdown reduces coverage capacity and can cause shortfalls.

## What I got wrong

- **I didn't test my own fix.** If I had run the PoC a second time with the mitigation applied, I would have seen the same $500 and realised the timing of the price read was not the root cause. Now I always run the PoC against the proposed fix before submitting.
- **I mixed up an economic risk with a code bug.** Every asset-backed vault pays less in USD when its asset falls. Before calling something a bug, I now check whether the program's documented risks already cover it.
- **I overstated the impact.** I filed it under "direct theft of user funds". Nobody gains anything here, and no attacker action is involved. Even if it had been valid, the honest category was underpayment or protocol insolvency, not theft. Overstated severity makes triagers trust the rest of a report less.

## What still holds

- Pricing the payout at approval does make the USD amount depend on how quickly the approver acts, which is worth documenting even if it isn't a vulnerability.
- The existing tests used a fixed $1.00 price between capture and approval, so they never exercised volatility. Adding price-movement cases to the fixtures would have made the behaviour visible to the team before the competition.

## How I worked

- Read `IncidentManager` and `FirelightVault` end to end, following the payout path from `approveCurrentAssessment` through `_executePayout` into `payout`.
- Wrote Hardhat tests that deploy the real `FirelightVault` behind a proxy, wire it to `IncidentManager`, and run the full incident flow: create, confirm, assess, submit, approve.
- Compared outcomes with only one variable changed: the oracle price at approval.
- After the review, I added a third test that applies my own proposed fix. It confirms the triager's point: with the price locked at capture, the holder still receives $500.

## Proof of concept

[`firelight-poc/real_vault_payout_underpayment.test.js`](firelight-poc/real_vault_payout_underpayment.test.js)

Copy it into `test/findings/` in the competition repo at tag `v1_audit_ready`, then run:

```
npx hardhat test test/findings/real_vault_payout_underpayment.test.js
```

```
  Firelight payout pricing (real vault)
    ✔ price $1 at approve: holder receives the full $1000
      units requested / paid : 2000000000000000000000 / 1000000000000000000000
      USD received at $0.50  : 500000000000000000000
    ✔ price $0.50 at approve: vault requests 2000 units, pays 1000 (= $500)
      USD received with fix  : 500000000000000000000
    ✔ with the proposed fix (price locked at capture, $1) and market at $0.50: still $500

  3 passing
```
