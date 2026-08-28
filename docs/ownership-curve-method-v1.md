# Ownership-Quality Curve Anticipation v1

Status: historical survivor; forward paper validation required; no live orders.

## The method in plain English

Most manual traders see a coin accelerating, open it, inspect the holder panel or bubbles, decide whether the ownership looks real, and then buy. Generic momentum automation is not enough: all 132 rule-based momentum, quiet-to-burst, reclaim, absorption, and breadth configurations tested here lost after costs.

Ownership-Quality Curve Anticipation (OQCA) automates the slower judgment instead:

1. Observe a minimal ignition state: 8–180 seconds old, 35–82% through the bonding curve, at least three buys in two seconds, at least 1 SOL of five-second buy flow, and no absurd five-second move.
2. At the first qualifying moment, score only features already observable at that time: curve position, age, initial holder count, top-1/top-5/top-10 ownership, dev ownership, and Gini concentration.
3. Enter 0.5 SOL only when the frozen ownership model's predicted net outcome exceeds `0.027644479879636794` SOL.
4. Paper exit at +40%, -25%, or 20 seconds, whichever occurs first.
5. Permit at most three simultaneous positions from a 3 SOL bankroll.

The hypothesis is not “high holder count is good” or “low concentration is always good.” The interaction matters. Certain distributions look decentralized because related wallets are split; some concentrated launches still attract durable demand. The fitted model represents the nonlinear interaction rather than a single threshold.

The historical corpus's `curve_pct_depleted` field is not literal token depletion. It equals virtual SOL reserves divided by 85 SOL, expressed as a percentage. A new classic curve therefore begins near 35%, and the field can exceed 100%. The forward collector intentionally reproduces this odd historical definition so the model receives the same feature it was trained on.

## Frozen research design

- Source window: 2026-07-07 13:21:20Z through 2026-07-14 13:21:20Z.
- Training: first four chronological days.
- Validation: fifth day.
- Untouched test: final two chronological days. July 12 has no captured rows, so this is only about 1.3 active days of tape despite spanning two dates.
- Clean sample: 5,165,227 trades, 86,310 launches, and 239,535 wallets.
- The corpus contained a source outage inside the seven-day window, so elapsed-day averages are more honest than pretending every day had equal opportunity flow.
- Corrupted SOL/price rows, impossible curve values, suspect concentration rows, and the System Program pseudo-wallet were excluded according to the corpus audit.
- Entry occurs only after a complete one-second observation bucket; raw replay then adds 170–7,170 ms of landing delay.
- Replay pays both-side fees and fixed transaction overhead, applies the simulated order's own curve impact, limits open positions, and never tunes on the final two days.

The source corpus is public and documents both its useful fields and its serious data-quality problems. It covers 33.58 million bonding-curve trades across 39 days and explicitly warns that several naive fields can silently corrupt a backtest: [PumpFun Launch-to-Graduation Corpus](https://huggingface.co/datasets/Slinky21/Pumpfun_Memecoin_Corpus).

## What failed first

| Experiment | Best training result | Validation | Decision |
|---|---:|---:|---|
| 84 generic chart/flow rules | Negative | Negative | Rejected |
| 48 stricter states copied from profitable-wallet behavior | Negative | Negative | Rejected |
| 1,200 exit combinations on the best strict states | Negative | Negative | Rejected |
| Training-ranked wallet cohort following | +4.53 SOL | -0.32 SOL | Rejected |
| Flow-only model | No qualifying validation threshold | — | Rejected |
| Curve phase only | No qualifying validation threshold | — | Rejected |
| Creator history only | No qualifying validation threshold | — | Rejected |
| TradeEvent-only reconstructed ownership | No qualifying validation threshold | — | Rejected |
| TradeEvent flow plus reconstructed ownership | No qualifying validation threshold | — | Rejected |
| Ownership-quality model | +10.99 SOL on validation | +42.12 SOL on untouched bar test | Advanced to raw replay |

The wallet-cohort failure agrees with larger outside work: a raw tracked-wallet touch is noisy, and which wallet leads plus its stable follow-on behavior matters more than aggregate win rate. A 491,000-trade study found that the raw signal often went nowhere and that small wallet samples were unstable: [first-KOL-touch study](https://madeonsol.com/blog/scout-signal-first-kol-touch-backtest-solana).

## Untouched-test replay

The test signals were frozen before microsecond replay. The raw replay waits until the complete signal second is over, adds scenario latency, places every earlier external transaction ahead of our order, then executes our 0.5 SOL against the resulting reserves.

| Scenario | Delay | Extra queue ahead | Fee / tx stress | Trades | Net PnL | Ending 3 SOL | Win rate | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Optimistic | 170 ms | 0 SOL | 1.25%, 0.0032 SOL/side | 445 | +43.96 SOL | 46.96 SOL | 70.3% | 0.85 SOL |
| Base | 670 ms | 0 SOL | 1.25%, 0.0032 SOL/side | 445 | +37.99 SOL | 40.99 SOL | 67.9% | 0.82 SOL |
| Safe | 1,170 ms | 0 SOL | 1.25%, 0.0032 SOL/side | 445 | +36.43 SOL | 39.43 SOL | 67.2% | 0.78 SOL |
| Fee stress | 670 ms | 0 SOL | 2.50%, 0.0064 SOL/side | 445 | +27.03 SOL | 30.03 SOL | 61.6% | 0.82 SOL |
| Hostile | 1,170 ms | 1 SOL | 2.50%, 0.0064 SOL/side | 445 | +10.19 SOL | 13.19 SOL | 50.6% | 1.76 SOL |
| Crowded | 3,170 ms | 2 SOL | 2.50%, 0.0064 SOL/side | 67 accepted before bankroll collapse | -2.60 SOL | 0.40 SOL | 29.9% | 2.64 SOL |
| Broken | 7,170 ms | 2 SOL | 2.50%, 0.0064 SOL/side | 44 accepted before bankroll collapse | -2.52 SOL | 0.48 SOL | 22.7% | 2.52 SOL |

This is the most important practical result: the historical edge is not “be first at any cost,” but it does have a hard latency/crowding boundary. It survived 1.17 seconds plus a hypothetical 1 SOL buyer ahead. It failed with roughly three seconds plus 2 SOL ahead.

At the current SOL reference price of about $77.97, $500 is roughly 6.4 SOL. The base historical replay averaged far more than that per elapsed day; the hostile replay averaged about 5.1 SOL per elapsed day. Those are research observations, not an earnings forecast.

## Why the hypothesis is credible

- Academic work on Pump.fun finds that conditioning on both structural and behavioral variables materially improves launch-success prediction, while successful launches are highly momentum-driven and rare: [Marino et al., 2026](https://arxiv.org/abs/2602.14860).
- A separate seven-day, 138,481-launch study found early landing-fee competition correlated strongly with later maximum price, but warned that observing too many slots makes the trader late: [Onchain Divers](https://blog.onchaindivers.com/posts/priority-fee-price-impact).
- Experienced builders independently report that the difficult problem is distinguishing real holders from bundles, wash flow, and low-quality ownership—not merely shaving milliseconds: [Solana developer discussion](https://www.reddit.com/r/solanadev/comments/1uozsr2/spent_months_building_a_solana_memecoin_trading/).
- A trader's anecdotal “wait for 40–60% bonding plus sustained volume” rule aligns with the model's selected region, though this is supporting context rather than proof: [Reddit discussion](https://www.reddit.com/r/SolanaMemeCoins/comments/1o5ia3g/3_mistakes_that_killed_my_first_500_in_memecoin/).
- Pump's fees are contract-defined, may change, and exclude third-party interface/network costs; that is why the replay includes doubled-fee stress rather than relying on one advertised number: [official Pump fee documentation](https://pump.fun/docs/fees).

## What this does not prove

- The test is July 2026 bonding-curve data. The current August regime may have changed.
- Observed future order flow is replayed as exogenous. Our real order could alter later behavior.
- Holder features must be reproduced exactly enough in production. If the live top-holder and Gini calculation differs from the training corpus, the score is not comparable.
- Rebuilding ownership solely from buy/sell events was tested as a free-RPC fallback and failed the frozen validation gate. The forward process therefore requires a real `getTokenLargestAccounts` snapshot and refuses to invent missing values.
- The model does not yet detect linked wallets. A cluster can look distributed across individual addresses. Cluster intelligence should become a later rejection layer, not be assumed solved.
- Historical positive PnL does not justify live capital. The first deployment is a separate forward-paper account with no live transaction construction.

## Forward gate

Before considering any live order, the separate account must collect at least 200 current signals and demonstrate all of the following:

- positive net PnL at the measured end-to-end landing delay;
- positive PnL under a shadow delay at least 500 ms worse;
- holder-feature parity checks against the historical schema;
- no single trade contributing more than 25% of net profit;
- acceptable drawdown for the 3 SOL account;
- explicit rejection accounting, including what skipped tokens later did;
- zero data gaps while a position is open.

If it fails, it remains a useful historical finding and is not promoted. If it passes, size still begins at the frozen 0.5 SOL baseline.

The current public Solana endpoints rate-limit or reject `getTokenLargestAccounts`. A holder-capable RPC is therefore a data dependency, not an execution-speed purchase. Helius documents a free plan with 1 million monthly credits and 10 standard RPC requests per second, and this standard RPC costs one credit. That is enough for a development forward test if launch volume is controlled: [Helius plans](https://www.helius.dev/docs/billing/plans), [Helius credits](https://www.helius.dev/docs/billing/credits), and [`getTokenLargestAccounts`](https://www.helius.dev/docs/api-reference/rpc/http/gettokenlargestaccounts).
