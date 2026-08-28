import heapq
import json
import math
from datetime import timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
BARS = DATA_DIR / "curve-bars-1s.parquet"
MANIFEST = json.loads((DATA_DIR / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
OUT = ROOT / "reports" / "selective-entry-model-v1.json"
CANDIDATES_OUT = DATA_DIR / "selective-entry-candidates-v1.parquet"

SIZE_SOL = 0.5
FEE_RATE = 0.0125
TX_COST = 0.0032
TAKE_PROFIT = 0.40
STOP_LOSS = -0.25
MAX_HOLD_SECONDS = 20
STARTING_BANKROLL = 3.0
MAX_POSITIONS = 3

FEATURES = [
    "age_seconds", "curve_close", "buys_2s", "sells_2s", "buyer_seconds_2s", "seller_seconds_2s",
    "buy_sol_2s", "sell_sol_2s", "buys_5s", "sells_5s", "buyer_seconds_5s", "seller_seconds_5s",
    "buy_sol_5s", "sell_sol_5s", "buys_15s", "sells_15s", "buyer_seconds_15s",
    "buy_sol_15s", "sell_sol_15s", "prior_buys_5_to_15s", "return_5s", "return_15s",
    "drawdown_from_60s_peak", "bounce_from_15s_low", "one_bar_return", "largest_buy_sol", "largest_sell_sol",
    "is_mayhem_mode", "creator_past_tokens", "creator_past_rugs", "initial_buy_sol", "initial_market_cap_sol",
    "initial_holder_count", "initial_top1_pct_corrected", "initial_top5_pct_corrected",
    "initial_top10_pct_corrected", "dev_buy_pct_corrected", "initial_gini", "is_cashback_enabled",
]


def reserves(row):
    return float(row["v_sol_close"]) / 1e9, float(row["v_tokens_close"]) / 1e6


def outcome(rows, signal_index):
    signal_time = rows[signal_index]["bucket"]
    entry_index = next((index for index in range(signal_index + 1, len(rows))
                        if (rows[index]["bucket"] - signal_time).total_seconds() >= 1), None)
    if entry_index is None or rows[entry_index]["curve_close"] >= 95:
        return None
    quote, token = reserves(rows[entry_index])
    effective = SIZE_SOL * (1 - FEE_RATE)
    tokens = token - quote * token / (quote + effective)
    if not math.isfinite(tokens) or tokens <= 0:
        return None
    selected = None
    reason = "TIMEOUT"
    for row in rows[entry_index + 1:]:
        elapsed = (row["bucket"] - rows[entry_index]["bucket"]).total_seconds()
        if row["curve_close"] >= 95:
            break
        actual_quote, actual_token = reserves(row)
        virtual_quote = actual_quote + effective
        virtual_token = actual_token - tokens
        if virtual_quote <= 0 or virtual_token <= 0:
            continue
        output = (virtual_quote - virtual_quote * virtual_token / (virtual_token + tokens)) * (1 - FEE_RATE)
        pnl = output - SIZE_SOL - 2 * TX_COST
        if not math.isfinite(pnl):
            continue
        selected = (row, pnl)
        return_on_cost = pnl / (SIZE_SOL + TX_COST)
        if return_on_cost >= TAKE_PROFIT:
            reason = "TAKE_PROFIT"
            break
        if return_on_cost <= STOP_LOSS:
            reason = "STOP_LOSS"
            break
        if elapsed >= MAX_HOLD_SECONDS:
            break
    if selected is None:
        return None
    exit_row, pnl = selected
    signal = rows[signal_index]
    return {
        "mint": signal["mint"],
        "signalTime": signal_time,
        "entryTime": rows[entry_index]["bucket"],
        "exitTime": exit_row["bucket"],
        "pnlSol": pnl,
        "exitReason": reason,
        "entryMarketCapSol": rows[entry_index]["mc_close"],
        "exitMarketCapSol": exit_row["mc_close"],
        **{feature: signal.get(feature) for feature in FEATURES},
    }


def base_gate(row):
    return (
        8 <= row["age_seconds"] <= 180
        and 35 <= row["curve_close"] <= 82
        and row["buys_2s"] >= 3
        and row["buy_sol_5s"] >= 1.0
        and row["return_5s"] is not None
        and -0.20 <= row["return_5s"] <= 0.80
        and row["initial_top10_pct_corrected"] is not None
        and row["dev_buy_pct_corrected"] is not None
    )


def portfolio(trades):
    accepted = []
    exits = []
    available = STARTING_BANKROLL
    realized = 0
    peak = STARTING_BANKROLL
    max_drawdown = 0
    required = SIZE_SOL + TX_COST
    for trade in sorted(trades, key=lambda item: item["entryTime"]):
        while exits and exits[0][0] <= trade["entryTime"]:
            _, _, closing = heapq.heappop(exits)
            available += required + closing["pnlSol"]
            realized += closing["pnlSol"]
            equity = STARTING_BANKROLL + realized
            peak = max(peak, equity)
            max_drawdown = max(max_drawdown, peak - equity)
        if len(exits) >= MAX_POSITIONS or available < required:
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
        max_drawdown = max(max_drawdown, peak - equity)
    wins = sum(trade["pnlSol"] > 0 for trade in accepted)
    largest = max((trade["pnlSol"] for trade in accepted), default=0)
    return {
        "trades": len(accepted),
        "pnlSol": realized,
        "endingBankrollSol": STARTING_BANKROLL + realized,
        "winRate": wins / len(accepted) if accepted else None,
        "maxDrawdownSol": max_drawdown,
        "largestProfitShare": largest / realized if realized > 0 else None,
        "accepted": accepted,
    }


connection = duckdb.connect()
start = connection.execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = start + timedelta(days=4)
validation_end = train_end + timedelta(days=1)

columns = [
    "mint", "bucket", "mc_close", "curve_close", "v_sol_close", "v_tokens_close",
    "largest_buy_sol", "largest_sell_sol", *FEATURES,
]
columns = list(dict.fromkeys(columns))
cursor = connection.execute(
    f"SELECT {','.join(columns)} FROM read_parquet(?) ORDER BY mint,bucket",
    [str(BARS)],
)
candidates = []


def process(rows):
    signal_index = next((index for index, row in enumerate(rows) if base_gate(row)), None)
    if signal_index is None:
        return
    trade = outcome(rows, signal_index)
    if trade:
        candidates.append(trade)


current_mint = None
token_rows = []
while True:
    batch = cursor.fetchmany(25_000)
    if not batch:
        break
    for values in batch:
        row = dict(zip(columns, values))
        if current_mint is None:
            current_mint = row["mint"]
        if row["mint"] != current_mint:
            process(token_rows)
            token_rows = []
            current_mint = row["mint"]
        token_rows.append(row)
if token_rows:
    process(token_rows)

frame = pd.DataFrame(candidates)
for feature in FEATURES:
    if frame[feature].dtype == bool:
        frame[feature] = frame[feature].astype(float)
    else:
        frame[feature] = pd.to_numeric(frame[feature], errors="coerce")
frame.to_parquet(CANDIDATES_OUT, index=False)
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
for split_frame in (train, validation, test):
    split_frame["prediction"] = model.predict(split_frame[FEATURES])

thresholds = sorted(set(float(np.quantile(train["prediction"], quantile)) for quantile in np.linspace(0.80, 0.995, 30)))
validation_grid = []
for threshold in thresholds:
    selected = validation[validation["prediction"] >= threshold].to_dict(orient="records")
    result = portfolio(selected)
    validation_grid.append({
        "threshold": threshold,
        **{key: value for key, value in result.items() if key != "accepted"},
    })
eligible = [
    row for row in validation_grid
    if row["trades"] >= 10
    and row["pnlSol"] > 0
    and (row["largestProfitShare"] or 0) <= 0.60
    and row["maxDrawdownSol"] <= 1.5
]
chosen = max(eligible, key=lambda row: row["pnlSol"], default=None)

importance = permutation_importance(
    model,
    validation[FEATURES],
    validation["pnlSol"],
    n_repeats=3,
    random_state=20260828,
    scoring="neg_mean_squared_error",
)
feature_importance = sorted(
    ({"feature": feature, "importance": float(value)} for feature, value in zip(FEATURES, importance.importances_mean)),
    key=lambda row: row["importance"],
    reverse=True,
)

test_result = None
if chosen:
    test_selected = test[test["prediction"] >= chosen["threshold"]].to_dict(orient="records")
    test_result = portfolio(test_selected)
    test_result["accepted"] = [
        {key: value for key, value in trade.items() if key not in FEATURES}
        for trade in test_result["accepted"]
    ]

payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "candidateDefinition": "First qualifying 1-second bar per token; current/earlier information only.",
    "candidates": {"train": len(train), "validation": len(validation), "test": len(test)},
    "execution": {
        "sizeSol": SIZE_SOL,
        "feeRateEachSide": FEE_RATE,
        "txCostEachSideSol": TX_COST,
        "entry": "next one-second bar",
        "ownImpact": True,
        "takeProfit": TAKE_PROFIT,
        "stopLoss": STOP_LOSS,
        "maxHoldSeconds": MAX_HOLD_SECONDS,
        "startingBankrollSol": STARTING_BANKROLL,
        "maxPositions": MAX_POSITIONS,
    },
    "validationThresholdGrid": validation_grid,
    "chosenOnValidation": chosen,
    "untouchedTest": {key: value for key, value in test_result.items() if key != "accepted"} if test_result else None,
    "testTrades": test_result["accepted"] if test_result else [],
    "featureImportance": feature_importance[:15],
    "warning": "A positive test is still a historical replay estimate. A negative or absent test result is not replaced with a more flattering threshold.",
}
OUT.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps(payload, indent=2, default=str))
