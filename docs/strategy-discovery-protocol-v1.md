# Strategy discovery protocol v1

Frozen: 2026-08-28T15:50:00Z

This protocol exists to prevent a profitable-looking chart from being mistaken for an executable strategy. The research target is high net PnL from observable public behavior, not a high win rate. The aspirational target is $500 per day, but no result is promoted or altered to meet that number.

## Dataset and split

- Historical window: 2026-08-21T15:50:00Z through 2026-08-28T15:50:00Z.
- Training: first four chronological days.
- Validation: fifth chronological day.
- Untouched test: final two chronological days.
- Wallets are sampled from recent PumpSwap pools and transaction activity, not selected from an all-time leaderboard.
- Test-period outcomes cannot be used to add, remove, or tune a rule.
- The existing v4 forward collector remains append-only and is not modified by this research.

## Bankroll and sizing

- Starting bankroll: 3 SOL.
- Official order size: 0.5 SOL.
- Maximum open notional: 1.5 SOL across at most three positions.
- Shadow sizes of 1, 1.5, and 2 SOL are capacity diagnostics only. They do not replace the official account.
- A rejected or failed fill still pays any applicable attempted-transaction cost captured by the model.

## Information boundary

At decision time the strategy may use only events already observable on chain or through the stated public feed. It may not use:

- the final candle, future holder count, future volume, or a token's eventual maximum;
- a wallet label learned from test-period performance;
- the outcome of later transactions in the same second;
- metadata that was unavailable at the simulated decision timestamp.

Historical events with only second-level time are ordered by slot and transaction position where available. A signal cannot fill inside the same unresolved one-second bucket. This intentionally sacrifices some real opportunities rather than granting impossible look-ahead.

## Execution scenarios

Every candidate is replayed under all three scenarios:

1. Optimistic: 170 ms detection-to-landing sensitivity case.
2. Base: 670 ms detection-to-landing, representing feed/decision time plus network and leader scheduling.
3. Stress: 1,170 ms detection-to-landing.

When the source data cannot resolve those intervals, the fill occurs at the first observable event after the latency boundary, with all earlier events in the landing bucket placed ahead of our order.

Each fill uses event-native reserves and dynamic protocol/LP/creator fees when available, then applies our own AMM price impact. Fixed transaction overhead defaults to 0.0032 SOL per submitted side until measured production costs replace it. Failed fills, slippage caps, and insufficient bankroll are recorded rather than silently removed.

Observed future order flow is an exogenous replay, not a perfect counterfactual: our order might have changed later human behavior. Results must therefore be described as replay estimates and confirmed by forward paper trading.

## Competition and capacity

- Report the external SOL and number of distinct buyers ahead of each fill.
- Re-run with adverse ordering inside unresolved landing buckets.
- Reject a size if its own impact or exit depth materially destroys expectancy.
- Report concentration: no strategy is considered established when one trade supplies more than half of total net profit.
- Coordinated deployer/sniper clusters, wash-like flow, and creator-linked wallets are features for avoidance/detection, not instructions for deceptive trading.

## Search and promotion rules

Candidate hypotheses are derived from repeatable observable behavior, then parameterized on training only. A candidate advances only if it:

- is net positive after all modeled costs on validation and untouched test;
- remains positive in the base scenario and does not collapse under the stress scenario;
- has enough opportunities to distinguish a repeatable behavior from one anecdote;
- has acceptable drawdown for a 3 SOL account;
- does not depend on one token, one wallet, or a post-hoc label;
- has a causal timing story explaining why later participants may still arrive.

The final survivor is run in a separate forward-paper namespace. It cannot overwrite or contaminate the official v4 state. Live capital is outside the scope of this protocol.
