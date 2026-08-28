# Axiom Forward Lab

An append-only research harness for discovering and forward-testing Solana memecoin methods. It starts with the observable Pump → PumpSwap migration hunting ground identified during CTfm wallet research. It does **not** submit transactions, request private keys, or pretend that historical wallet PnL is our executable PnL.

## Current phase

`paper-v2-authoritative-landing` is the active frozen forward hypothesis. A live Solana WebSocket watches Pump migrations and PumpSwap events, records every decision, and maintains a fresh 3 SOL paper account under `data/paper-v2/`.

The official baseline remains fixed at 0.5 SOL. Every baseline entry also starts matched 1.0, 1.5 and 2.0 SOL size shadows from the identical confirmed post-delay pool state. Each shadow pays its own modeled price impact and exits independently at its own take-profit, stop-loss or timeout. These are unconstrained comparison cohorts—not recommendations to fund those sizes from the 3 SOL baseline wallet.

Agreed experimental account:

- starting bankroll: 3 SOL
- proposed position size: 0.5 SOL
- modeled landing delay: 1 second, followed by a required authoritative PumpSwap event within 5 seconds
- initial exit family: +50% take-profit / −20% stop / 300-second timeout
- pool impact, platform/pool fees, fixed transaction costs, failed entries and failed exits must be charged

Those exit values are hypotheses, not a live recommendation. Paper entries wait for a confirmed post-delay event, use the event's effective reserves (including virtual quote reserves) and dynamic fee fields, charge their own entry/exit impact and fixed costs, and never submit a transaction. Case studies report average executable-fill market cap at entry and exit, not a stale chart candle value.

`paper-v1-canonical-migrations` is retired. Its single blocking event queue, stale reconstructed reserve path and fixed-fee CPMM could credit same-second flow that occurred before a realistically executable entry. Its 19 historical closes and headline PnL are invalid research artifacts and are not carried into v2. See [the model audit](docs/model-audit-2026-08-28.md).

## Run it

Requires Node.js 20 or newer.

```powershell
Copy-Item .env.example .env
npm test
npm run capture
npm run report
npm run paper:shadow-report
```

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
- `data/paper-v2/state.json` — current authoritative baseline paper account
- `data/paper-v2/entries.jsonl` / `exits.jsonl` — append-only baseline fills with entry and exit market caps
- `data/paper-v2/size-shadow-state.json` — current matched size-cohort totals and open positions
- `data/paper-v2/size-shadow-entries.jsonl` / `size-shadow-exits.jsonl` — append-only independent paths for the 1.0, 1.5 and 2.0 SOL cohorts

## Research tracks

1. **Independent migration selector:** infer a rule from opening liquidity, largest opening swap, independent buyer breadth, net flow, clustering, creator history, token age, global fees and competing-bot participation.
2. **Size shadows:** determine whether larger positions preserve the baseline's edge after their own price impact.
3. **Separate future hypotheses:** build and validate them independently instead of contaminating this baseline.

The selector must be frozen before outcomes are scored. Development, validation and untouched forward holdout results remain separate.

Migration pools are permanently deduplicated. `npm run paper:reconcile` rebuilds headline PnL from the first decision per pool and refuses to run while a position is open.
