# Axiom Forward Lab

An append-only research harness for discovering and forward-testing Solana memecoin methods. It starts with the observable Pump → PumpSwap migration hunting ground identified during CTfm wallet research. It does **not** submit transactions, request private keys, or pretend that historical wallet PnL is our executable PnL.

## Current phase

`paper-v4-matched-latency-accounts` is the active frozen forward hypothesis. A live Solana WebSocket watches Pump migrations and PumpSwap events, records every decision, and maintains two independent 3 SOL paper accounts under `data/paper-v4/`.

- `FAST-170`: 0.5 SOL positions targeting 170ms entry and exit.
- `SAFE-1000`: 0.5 SOL positions targeting 1,000ms entry and exit, plus the existing 1.0/1.5/2.0 SOL size shadows.

Both accounts receive the same qualified signals. Each pays its own impact, dynamic fees and fixed costs and exits independently. A target is never treated as an achieved fill: each record stores the first authoritative state actually observable after the target and reports target versus observed latency.

The official baseline remains fixed at 0.5 SOL. Every baseline entry also starts matched 1.0, 1.5 and 2.0 SOL size shadows from the identical confirmed post-delay pool state. Each shadow pays its own modeled price impact and exits independently at its own take-profit, stop-loss or timeout. These are unconstrained comparison cohorts—not recommendations to fund those sizes from the 3 SOL baseline wallet.

Agreed experimental account:

- starting bankroll: 3 SOL
- proposed position size: 0.5 SOL
- SAFE-1000 modeled entry and exit target: 1 second
- opening signal window: 1 second (not the retired five-second wait)
- FAST-170 modeled entry and exit target: 170ms, with its own complete PnL account
- initial exit family: +50% take-profit / −20% stop / 300-second timeout
- pool impact, platform/pool fees, fixed transaction costs, failed entries and failed exits must be charged

Those exit values are hypotheses, not a live recommendation. Paper entries wait for a confirmed post-delay event, use the event's effective reserves (including virtual quote reserves) and dynamic fee fields, charge their own entry/exit impact and fixed costs, and never submit a transaction. Exits also wait a modeled second after their trigger so intervening flow can worsen the fill. Case studies report average executable-fill and observed spot market caps, millisecond lifecycle timestamps, migration-resolution time, and buy/sell competition observed before entry and exit.

The dump guard rejects an entry when the token is at least 20% below its observed post-migration peak with net selling, or when the latest 1,000ms contains at least 0.5 SOL of sells at a 2:1 or worse sell-to-buy ratio. These thresholds are a frozen hypothesis and must be evaluated rather than assumed optimal.

`paper-v1-canonical-migrations` is retired. Its single blocking event queue, stale reconstructed reserve path and fixed-fee CPMM could credit same-second flow that occurred before a realistically executable entry. Its 19 historical closes and headline PnL are invalid research artifacts. V2 was a zero-trade transitional run. V3.1 remains preserved with its first valid SAFE-1000 trade but is superseded by the clean matched v4 comparison. See [the model audit](docs/model-audit-2026-08-28.md).

## Run it

Requires Node.js 20 or newer.

```powershell
Copy-Item .env.example .env
npm test
npm run capture
npm run report
npm run paper:shadow-report
npm run paper:latency-report
npm run paper:skipped-report
```

`paper:skipped-report` counterfactually replays rejected signals without changing either account. It only scores a skipped trade when the captured event tape contains an authoritative post-target entry state and enough forward data to model the configured exit; unobservable skips remain unscored.

For continuous collection:

```powershell
npm run monitor
```

Stop it with `Ctrl+C`. Runtime data remains local under `data/` and is intentionally excluded from Git because it will become large.

## Discord control room

Eight destinations are supported: bot status, migration feed, decision log, paper trades, alerts, daily reports, case studies and a close-only PnL feed. Webhook URLs are credentials and belong only in the ignored `.env` file.

After regenerating the webhooks in Discord, copy `.env.example` to `.env`, paste the replacement URLs there, then validate without sending anything:

```powershell
npm run discord:check
```

An intentionally guarded smoke test can send one clearly labeled connection message to each channel:

```powershell
npm run discord:smoke -- --send
```

The monitor posts startup/shutdown/heartbeat status, exact migration events, every selector decision, paper entries/exits, collection failures, daily reports and closed-trade case studies.

## Data contract

- `data/snapshots.jsonl` — every collected universe snapshot
- `data/events/first-seen-pools.jsonl` — one immutable first observation per pool
- `data/events/canonical-migrations.jsonl` — first observations confirmed by Pump as the canonical migrated pool
- `data/state.json` — deduplication state; deleting this starts a new corpus
- `data/paper-v4/state.json` — SAFE-1000 baseline account
- `data/paper-v4/latency-account-state.json` — FAST-170 account
- `data/paper-v4/latency-account-entries.jsonl` / `latency-account-exits.jsonl` — complete FAST-170 fills and outcomes
- `data/paper-v4/entries.jsonl` / `exits.jsonl` — SAFE-1000 fills and outcomes
- `data/paper-v4/size-shadow-state.json` — current matched size-cohort totals and open positions

## Research tracks

1. **Independent migration selector:** infer a rule from opening liquidity, largest opening swap, independent buyer breadth, net flow, clustering, creator history, token age, global fees and competing-bot participation.
2. **Size shadows:** determine whether larger positions preserve the baseline's edge after their own price impact.
3. **Separate future hypotheses:** build and validate them independently instead of contaminating this baseline.

The selector must be frozen before outcomes are scored. Development, validation and untouched forward holdout results remain separate.

Migration pools are permanently deduplicated. `npm run paper:reconcile` rebuilds headline PnL from the first decision per pool and refuses to run while a position is open.
