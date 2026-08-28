import heapq
import json
from datetime import timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
INPUT = DATA_DIR / "selective-entry-candidates-v1.parquet"
MANIFEST = json.loads((DATA_DIR / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
OUT = ROOT / "reports" / "selective-entry-ablation-v1.json"
SIZE_SOL = 0.5
TX_COST = 0.0032
STARTING_BANKROLL = 3.0

DYNAMIC = [
    "age_seconds", "curve_close", "buys_2s", "sells_2s", "buyer_seconds_2s", "seller_seconds_2s",
    "buy_sol_2s", "sell_sol_2s", "buys_5s", "sells_5s", "buyer_seconds_5s", "seller_seconds_5s",
    "buy_sol_5s", "sell_sol_5s", "buys_15s", "sells_15s", "buyer_seconds_15s", "buy_sol_15s",
    "sell_sol_15s", "prior_buys_5_to_15s", "return_5s", "return_15s", "drawdown_from_60s_peak",
    "bounce_from_15s_low", "one_bar_return", "largest_buy_sol", "largest_sell_sol",
]
STATIC = [
    "is_mayhem_mode", "creator_past_tokens", "creator_past_rugs", "initial_buy_sol", "initial_market_cap_sol",
    "initial_holder_count", "initial_top1_pct_corrected", "initial_top5_pct_corrected",
    "initial_top10_pct_corrected", "dev_buy_pct_corrected", "initial_gini", "is_cashback_enabled",
]
FEATURE_SETS = {
    "phase_only": ["age_seconds", "curve_close"],
    "ownership_only": [
        "age_seconds", "curve_close", "initial_holder_count", "initial_top1_pct_corrected",
        "initial_top5_pct_corrected", "initial_top10_pct_corrected", "dev_buy_pct_corrected", "initial_gini",
    ],
    "creator_only": [
        "age_seconds", "curve_close", "is_mayhem_mode", "creator_past_tokens", "creator_past_rugs",
        "initial_buy_sol", "initial_market_cap_sol", "is_cashback_enabled",
    ],
    "flow_only": DYNAMIC,
    "structure_only": ["age_seconds", "curve_close", *STATIC],
    "combined": [*DYNAMIC, *STATIC],
}


def portfolio(records):
    required = SIZE_SOL + TX_COST
    available = STARTING_BANKROLL
    realized = 0
    exits = []
    accepted = []
    peak = STARTING_BANKROLL
    drawdown = 0
    for trade in sorted(records, key=lambda row: row["entryTime"]):
        while exits and exits[0][0] <= trade["entryTime"]:
            _, _, closing = heapq.heappop(exits)
            available += required + closing["pnlSol"]
            realized += closing["pnlSol"]
            equity = STARTING_BANKROLL + realized
            peak = max(peak, equity)
            drawdown = max(drawdown, peak - equity)
        if len(exits) >= 3 or available < required:
            continue
        available -= required
        accepted.append(trade)
        heapq.heappush(exits, (trade["exitTime"], len(accepted), trade))
    while exits:
        _, _, closing = heapq.heappop(exits)
        available += required + closing["pnlSol"]
        realized += closing["pnlSol"]
        equity = STARTING_BANKROLL + realized
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    largest = max((row["pnlSol"] for row in accepted), default=0)
    return {
        "trades": len(accepted),
        "pnlSol": realized,
        "endingBankrollSol": STARTING_BANKROLL + realized,
        "winRate": sum(row["pnlSol"] > 0 for row in accepted) / len(accepted) if accepted else None,
        "maxDrawdownSol": drawdown,
        "largestProfitShare": largest / realized if realized > 0 else None,
    }


connection = duckdb.connect()
start = connection.execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = start + timedelta(days=4)
validation_end = train_end + timedelta(days=1)
frame = pd.read_parquet(INPUT)
train = frame[frame["entryTime"] < train_end].copy()
validation = frame[(frame["entryTime"] >= train_end) & (frame["entryTime"] < validation_end)].copy()
test = frame[frame["entryTime"] >= validation_end].copy()

results = []
for name, features in FEATURE_SETS.items():
    model = HistGradientBoostingRegressor(
        learning_rate=0.05,
        max_iter=250,
        max_leaf_nodes=15,
        min_samples_leaf=40,
        l2_regularization=2.0,
        random_state=20260828,
    )
    model.fit(train[features], train["pnlSol"])
    train_prediction = model.predict(train[features])
    validation_prediction = model.predict(validation[features])
    test_prediction = model.predict(test[features])
    thresholds = sorted(set(float(np.quantile(train_prediction, quantile)) for quantile in np.linspace(0.80, 0.995, 30)))
    candidates = []
    for threshold in thresholds:
        records = validation[validation_prediction >= threshold].to_dict(orient="records")
        result = portfolio(records)
        candidates.append({"threshold": threshold, **result})
    eligible = [
        row for row in candidates
        if row["trades"] >= 10 and row["pnlSol"] > 0
        and (row["largestProfitShare"] or 0) <= 0.60 and row["maxDrawdownSol"] <= 1.5
    ]
    chosen = max(eligible, key=lambda row: row["pnlSol"], default=None)
    test_result = None
    if chosen:
        test_result = portfolio(test[test_prediction >= chosen["threshold"]].to_dict(orient="records"))
    results.append({
        "featureSet": name,
        "features": features,
        "chosenOnValidation": chosen,
        "untouchedTest": test_result,
    })

payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "results": results,
    "interpretation": "If flow-only and structure-only both retain signal, the combined result is less likely to be a single contaminated column. This is still not a substitute for forward validation.",
}
OUT.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps(payload, indent=2, default=str))
