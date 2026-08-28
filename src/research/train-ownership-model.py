import heapq
import json
from datetime import timedelta
from pathlib import Path

import duckdb
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
INPUT = DATA_DIR / "selective-entry-candidates-v1.parquet"
MANIFEST = json.loads((DATA_DIR / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
MODEL_DIR = ROOT / "models"
MODEL_PATH = MODEL_DIR / "ownership-curve-v1.joblib"
CONFIG_PATH = MODEL_DIR / "ownership-curve-v1.json"
REPORT_PATH = ROOT / "reports" / "ownership-entry-model-v1.json"

FEATURES = [
    "age_seconds", "curve_close", "initial_holder_count", "initial_top1_pct_corrected",
    "initial_top5_pct_corrected", "initial_top10_pct_corrected", "dev_buy_pct_corrected", "initial_gini",
]
SIZE_SOL = 0.5
TX_COST = 0.0032
STARTING_BANKROLL = 3.0


def portfolio(records, include_trades=False):
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
    result = {
        "trades": len(accepted),
        "pnlSol": realized,
        "endingBankrollSol": STARTING_BANKROLL + realized,
        "winRate": sum(row["pnlSol"] > 0 for row in accepted) / len(accepted) if accepted else None,
        "maxDrawdownSol": drawdown,
        "largestProfitShare": largest / realized if realized > 0 else None,
    }
    if include_trades:
        result["accepted"] = accepted
    return result


connection = duckdb.connect()
start = connection.execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = start + timedelta(days=4)
validation_end = train_end + timedelta(days=1)
frame = pd.read_parquet(INPUT)
train = frame[frame["entryTime"] < train_end].copy()
validation = frame[(frame["entryTime"] >= train_end) & (frame["entryTime"] < validation_end)].copy()
test = frame[frame["entryTime"] >= validation_end].copy()

model = HistGradientBoostingRegressor(
    learning_rate=0.05,
    max_iter=250,
    max_leaf_nodes=15,
    min_samples_leaf=40,
    l2_regularization=2.0,
    random_state=20260828,
)
model.fit(train[FEATURES], train["pnlSol"])
train_prediction = model.predict(train[FEATURES])
validation_prediction = model.predict(validation[FEATURES])
test_prediction = model.predict(test[FEATURES])
thresholds = sorted(set(float(np.quantile(train_prediction, quantile)) for quantile in np.linspace(0.80, 0.995, 30)))
grid = []
for threshold in thresholds:
    result = portfolio(validation[validation_prediction >= threshold].to_dict(orient="records"))
    grid.append({"threshold": threshold, **result})
eligible = [
    row for row in grid
    if row["trades"] >= 10 and row["pnlSol"] > 0
    and (row["largestProfitShare"] or 0) <= 0.60 and row["maxDrawdownSol"] <= 1.5
]
chosen = max(eligible, key=lambda row: row["pnlSol"], default=None)
if chosen is None:
    raise RuntimeError("Ownership model did not pass the frozen validation gate")

test = test.copy()
test["prediction"] = test_prediction
test_result = portfolio(test[test["prediction"] >= chosen["threshold"]].to_dict(orient="records"), include_trades=True)
test_trades = [
    {
        "mint": row["mint"],
        "signalTime": row["signalTime"],
        "entryTime": row["entryTime"],
        "exitTime": row["exitTime"],
        "pnlSol": row["pnlSol"],
        "exitReason": row["exitReason"],
        "entryMarketCapSol": row["entryMarketCapSol"],
        "exitMarketCapSol": row["exitMarketCapSol"],
        "prediction": row["prediction"],
    }
    for row in test_result.pop("accepted")
]

MODEL_DIR.mkdir(parents=True, exist_ok=True)
joblib.dump(model, MODEL_PATH)
config = {
    "version": "ownership-curve-v1",
    "features": FEATURES,
    "threshold": chosen["threshold"],
    "baseGate": {
        "ageSeconds": [8, 180],
        "curvePct": [35, 82],
        "minimumBuys2s": 3,
        "minimumBuySol5s": 1.0,
        "return5s": [-0.20, 0.80],
    },
    "paperExecution": {
        "sizeSol": 0.5,
        "takeProfit": 0.40,
        "stopLoss": -0.25,
        "maxHoldSeconds": 20,
        "maxPositions": 3,
    },
    "researchOnly": True,
}
CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "model": str(MODEL_PATH),
    "config": config,
    "chosenOnValidation": chosen,
    "untouchedTest": test_result,
    "testTrades": test_trades,
    "warning": "Research-only model. Historical out-of-sample success does not authorize live orders; forward paper validation is required.",
}
REPORT_PATH.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps({key: value for key, value in payload.items() if key != "testTrades"}, indent=2, default=str))
