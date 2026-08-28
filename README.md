# Axiom Forward Lab

An append-only research harness for discovering and forward-testing Solana memecoin methods. It starts with the observable Pump → PumpSwap migration hunting ground identified during CTfm wallet research. It does **not** submit transactions, request private keys, or pretend that historical wallet PnL is our executable PnL.

## Current phase

`paper-v0-observation-only` records the complete visible candidate universe before we finish the selector. This prevents hindsight: skipped migrations and failures are retained alongside winners.

Agreed experimental account:

- starting bankroll: 3 SOL
- proposed position size: 0.5 SOL
- delays to model: 0, 1, 2 and 5 seconds
- initial exit family: +50% take-profit / −20% stop / 300-second timeout
- pool impact, platform/pool fees, fixed transaction costs, failed entries and failed exits must be charged

Those exit values are hypotheses, not a live recommendation. The collector will not emit paper orders until exact on-chain opening-flow fields and executable reserve states are present.

## Run it

Requires Node.js 20 or newer and no npm dependencies.

```powershell
Copy-Item .env.example .env
npm test
npm run capture
npm run report
```

For continuous collection:

```powershell
npm run monitor
```

Stop it with `Ctrl+C`. Runtime data remains local under `data/` and is intentionally excluded from Git because it will become large.

## Data contract

- `data/snapshots.jsonl` — every collected universe snapshot
- `data/events/first-seen-pools.jsonl` — one immutable first observation per pool
- `data/events/canonical-migrations.jsonl` — first observations confirmed by Pump as the canonical migrated pool
- `data/state.json` — deduplication state; deleting this starts a new corpus

## Research tracks

1. **CTfm shadow benchmark:** determine whether our delayed, impacted fills on the same coins remain profitable.
2. **Independent migration selector:** infer a rule from opening liquidity, largest opening swap, independent buyer breadth, net flow, clustering, creator history, token age, global fees and competing-bot participation.
3. **OG/narrative lag:** a later separate feed pairing attention-triggering new coins with older related contracts, modeled after Ivan’s method.

The selector must be frozen before outcomes are scored. Development, validation and untouched forward holdout results remain separate.

