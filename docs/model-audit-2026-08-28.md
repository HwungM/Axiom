# Paper model audit — 2026-08-28

## Finding

The v1 paper results are invalid. They must not be presented as executable PnL or used to select position size.

The audit was triggered by the `67` case study, which reported a 36–37K implied entry market cap and +66.24%. Axiom showed the observable market around 44.3K–48.5K near the would-be entry.

## Root causes

1. Migration transaction and metadata lookups blocked the same message queue that processed swaps. When the migration resolved, the engine could enter from an old reserve state while more recent swaps were waiting in the queue.
2. Those already-received swaps were subsequently replayed as if they occurred after entry, crediting the paper account with flow it could not have beaten.
3. v1 treated PumpSwap as a fixed-fee physical-reserve CPMM. Current PumpSwap events expose virtual quote reserves and dynamic LP, protocol, creator and cashback fee fields that materially affect executable output.
4. Second-level timestamps cannot establish a realistic fill by themselves. Receipt order, observed state, own impact and a landing delay are required.

## `67` reconstruction

Using the first authoritative reserve event available around the entry, a conservative reconstruction places a 0.5 SOL average fill near **$45.2K market cap**, not 36–37K. Replaying the later observed path with executable impact produces approximately **−21%**, not +66%.

This reconstruction is deliberately labeled approximate because the v1 archive did not retain enough receipt-order and dynamic-fee evidence to produce a fully auditable historical fill. The correct response is to invalidate the trade, not to replace one false precision number with another.

## v2 correction

`paper-v2-authoritative-landing` starts from a fresh 3 SOL bankroll and separate data directory. It:

- separates migration-resolution work from PumpSwap event processing;
- records local receipt time and sequence;
- waits one modeled second after qualification;
- requires a confirmed post-delay pool event before quoting entry;
- quotes from event-native effective reserves, including virtual quote reserves;
- uses the event's dynamic fee fields;
- charges the paper order's own entry and exit impact and fixed costs;
- records entry and exit average-fill market caps in trade, PnL and case-study messages.

This is still a paper model, not a promise of live execution. A live bot can land later, fail or receive a worse position within the ordering than the modeled fill. The forward sample must therefore be treated as an upper-bound research result until it is compared with real tiny-size fills.

## Authoritative reference

Pump's official PumpSwap documentation describes effective quote reserves as raw quote reserves plus virtual quote reserves and exposes the current event and fee fields used by v2:

https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
