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
DATA = ROOT / "data" / "research-corpus"
TRADES = DATA / "curve-window-7d.parquet"
CANDIDATES = DATA / "selective-entry-candidates-v1.parquet"
TOKENS = DATA / "tokens-window.parquet"
ENRICHED = DATA / "event-ownership-candidates-v1.parquet"
MANIFEST = json.loads((DATA / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
MODEL = ROOT / "models" / "event-ownership-v1.joblib"
CONFIG = ROOT / "models" / "event-ownership-v1.json"
REPORT = ROOT / "reports" / "event-ownership-v1.json"

FEATURES = [
    "age_seconds", "curve_close", "event_holder_count", "event_top1_pct",
    "event_top5_pct", "event_top10_pct", "event_dev_pct", "event_gini",
]
SIZE_SOL = 0.5
TX_COST = 0.0032
STARTING_BANKROLL = 3.0


def sql_path(path):
    return str(path).replace("\\", "/").replace("'", "''")


def portfolio(records):
    required = SIZE_SOL + TX_COST
    available = STARTING_BANKROLL
    realized = 0.0
    exits = []
    accepted = []
    peak = STARTING_BANKROLL
    drawdown = 0.0
    for trade in sorted(records, key=lambda row: row["entryTime"]):
        while exits and exits[0][0] <= trade["entryTime"]:
            _, _, closing = heapq.heappop(exits)
            available += required + closing["pnlSol"]
            realized += closing["pnlSol"]
            peak = max(peak, STARTING_BANKROLL + realized)
            drawdown = max(drawdown, peak - (STARTING_BANKROLL + realized))
        if len(exits) >= 3 or available < required:
            continue
        available -= required
        accepted.append(trade)
        heapq.heappush(exits, (trade["exitTime"], len(accepted), trade))
    while exits:
        _, _, closing = heapq.heappop(exits)
        available += required + closing["pnlSol"]
        realized += closing["pnlSol"]
        peak = max(peak, STARTING_BANKROLL + realized)
        drawdown = max(drawdown, peak - (STARTING_BANKROLL + realized))
    largest = max((row["pnlSol"] for row in accepted), default=0.0)
    return {
        "trades": len(accepted),
        "pnlSol": realized,
        "endingBankrollSol": STARTING_BANKROLL + realized,
        "winRate": sum(row["pnlSol"] > 0 for row in accepted) / len(accepted) if accepted else None,
        "maxDrawdownSol": drawdown,
        "largestProfitShare": largest / realized if realized > 0 else None,
    }


connection = duckdb.connect(str(DATA / "research.duckdb"))
connection.execute("SET threads=8")
connection.execute("SET preserve_insertion_order=false")

if not ENRICHED.exists():
    query = f"""
    WITH candidate AS (
      SELECT c.*, t.creator,
        CASE WHEN coalesce(c.is_mayhem_mode, 0) > 0 THEN 2000000000.0 ELSE 1000000000.0 END AS supply
      FROM read_parquet('{sql_path(CANDIDATES)}') c
      LEFT JOIN read_parquet('{sql_path(TOKENS)}') t USING (mint)
    ), balances AS (
      SELECT c.mint, c.signalTime, c.creator, c.supply, tr.user_wallet,
        sum(CASE WHEN tr.is_buy THEN tr.token_amount ELSE -tr.token_amount END) AS balance
      FROM candidate c
      JOIN read_parquet('{sql_path(TRADES)}') tr
        ON tr.mint = c.mint AND tr.event_time <= c.signalTime
      GROUP BY c.mint, c.signalTime, c.creator, c.supply, tr.user_wallet
    ), positive AS (
      SELECT *,
        row_number() OVER (PARTITION BY mint ORDER BY balance DESC) AS rank_desc,
        row_number() OVER (PARTITION BY mint ORDER BY balance ASC) AS rank_asc,
        count(*) OVER (PARTITION BY mint) AS n,
        sum(balance) OVER (PARTITION BY mint) AS total_balance
      FROM balances
      WHERE balance > 0
    ), ownership AS (
      SELECT mint,
        max(n) AS event_holder_count,
        100 * max(balance) / max(supply) AS event_top1_pct,
        100 * sum(balance) FILTER (WHERE rank_desc <= 5) / max(supply) AS event_top5_pct,
        100 * sum(balance) FILTER (WHERE rank_desc <= 10) / max(supply) AS event_top10_pct,
        100 * sum(balance) FILTER (WHERE user_wallet = creator) / max(supply) AS event_dev_pct,
        2 * sum(rank_asc * balance) / (max(n) * max(total_balance)) - (max(n) + 1.0) / max(n) AS event_gini
      FROM positive
      GROUP BY mint
    )
    SELECT c.*,
      o.event_holder_count, o.event_top1_pct, o.event_top5_pct, o.event_top10_pct,
      coalesce(o.event_dev_pct, 0) AS event_dev_pct, o.event_gini
    FROM candidate c
    JOIN ownership o USING (mint)
    WHERE o.event_holder_count >= 2 AND o.event_gini IS NOT NULL
    """
    connection.execute(
        f"COPY ({query}) TO '{sql_path(ENRICHED)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)"
    )

frame = pd.read_parquet(ENRICHED)
start = connection.execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = start + timedelta(days=4)
validation_end = train_end + timedelta(days=1)
train = frame[frame["entryTime"] < train_end].copy()
validation = frame[(frame["entryTime"] >= train_end) & (frame["entryTime"] < validation_end)].copy()
test = frame[frame["entryTime"] >= validation_end].copy()

model = HistGradientBoostingRegressor(
    learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
    min_samples_leaf=40, l2_regularization=2.0, random_state=20260828,
)
model.fit(train[FEATURES], train["pnlSol"])
train_predictions = model.predict(train[FEATURES])
validation_predictions = model.predict(validation[FEATURES])
test_predictions = model.predict(test[FEATURES])
thresholds = sorted(set(float(np.quantile(train_predictions, quantile)) for quantile in np.linspace(0.80, 0.995, 30)))
grid = []
for threshold in thresholds:
    result = portfolio(validation[validation_predictions >= threshold].to_dict(orient="records"))
    grid.append({"threshold": threshold, **result})
eligible = [row for row in grid if row["trades"] >= 10 and row["pnlSol"] > 0
            and (row["largestProfitShare"] or 0) <= 0.60 and row["maxDrawdownSol"] <= 1.5]
chosen = max(eligible, key=lambda row: row["pnlSol"], default=None)
test_result = None
if chosen:
    test_result = portfolio(test[test_predictions >= chosen["threshold"]].to_dict(orient="records"))
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, MODEL)
    config = {
        "version": "event-ownership-v1",
        "features": FEATURES,
        "threshold": chosen["threshold"],
        "baseGate": {
            "ageSeconds": [8, 180], "curvePct": [35, 82],
            "minimumBuys2s": 3, "minimumBuySol5s": 1.0, "return5s": [-0.2, 0.8],
        },
        "paperExecution": {
            "sizeSol": 0.5, "takeProfit": 0.4, "stopLoss": -0.25,
            "maxHoldSeconds": 20, "maxPositions": 3,
        },
        "researchOnly": True,
        "featureSource": "TradeEvent-derived running wallet balances; no holder RPC required",
    }
    CONFIG.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "candidateRows": len(frame),
    "splitRows": {"train": len(train), "validation": len(validation), "test": len(test)},
    "features": FEATURES,
    "chosenOnValidation": chosen,
    "untouchedTest": test_result,
    "thresholdGrid": grid,
    "warning": "Event-native feature parity is improved, but current forward paper validation remains mandatory.",
}
REPORT.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps({key: value for key, value in payload.items() if key != "thresholdGrid"}, indent=2, default=str))

