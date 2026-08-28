import json
import math
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
BARS = DATA_DIR / "curve-bars-1s.parquet"
SCREEN = json.loads((ROOT / "reports" / "curve-strategy-screen-v1.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((DATA_DIR / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
OUT = ROOT / "reports" / "curve-exit-grid-v1.json"

SIZE_SOL = 0.5
FEE_RATE = 0.0125
TX_COST = 0.0032
EXIT_GRID = [
    {"tp": tp, "sl": sl, "hold": hold}
    for tp in (0.15, 0.25, 0.40, 0.60, 1.00)
    for sl in (-0.10, -0.15, -0.25, -0.40)
    for hold in (10, 20, 40, 80, 150)
]
FINALISTS = [row for row in SCREEN["frozenFinalists"] if row["family"] == "manual_state_anticipation"][:12]


def signal_matches(parameters, row):
    return (
        8 <= row["age_seconds"] <= parameters["age_max"]
        and parameters["curve_min"] <= row["curve_close"] <= 82
        and row["buys_2s"] >= parameters["buys_2s"]
        and row["buy_sol_5s"] >= parameters["buy_sol_5s"]
        and row["buy_sol_5s"] >= parameters["pressure"] * max(row["sell_sol_5s"], 0.10)
        and row["return_5s"] is not None
        and 0.02 <= row["return_5s"] <= 0.60
        and row["drawdown_from_60s_peak"] is not None
        and row["drawdown_from_60s_peak"] >= -0.20
    )


def reserves(row):
    return row["v_sol_close"] / 1e9, row["v_tokens_close"] / 1e6


def position_at(row):
    quote, token = reserves(row)
    effective = SIZE_SOL * (1 - FEE_RATE)
    tokens = token - quote * token / (quote + effective)
    if not math.isfinite(tokens) or tokens <= 0:
        return None
    return effective, tokens


def pnl_at(position, row):
    effective, tokens = position
    quote, token = reserves(row)
    quote += effective
    token -= tokens
    if quote <= 0 or token <= 0:
        return None
    output = (quote - quote * token / (token + tokens)) * (1 - FEE_RATE)
    pnl = output - SIZE_SOL - 2 * TX_COST
    return pnl if math.isfinite(pnl) else None


def path_after_signal(rows, signal_index):
    signal_time = rows[signal_index]["bucket"]
    entry_index = next((index for index in range(signal_index + 1, len(rows))
                        if (rows[index]["bucket"] - signal_time).total_seconds() >= 1), None)
    if entry_index is None or rows[entry_index]["curve_close"] >= 95:
        return None
    position = position_at(rows[entry_index])
    if position is None:
        return None
    path = []
    for index in range(entry_index + 1, len(rows)):
        row = rows[index]
        elapsed = (row["bucket"] - rows[entry_index]["bucket"]).total_seconds()
        if elapsed > 180 or row["curve_close"] >= 95:
            break
        pnl = pnl_at(position, row)
        if pnl is not None:
            path.append((elapsed, pnl, row))
    if not path:
        return None
    return rows[entry_index], path


def apply_exit(entry_row, path, exit_config):
    selected = None
    reason = "TIMEOUT"
    for elapsed, pnl, row in path:
        selected = (elapsed, pnl, row)
        return_on_cost = pnl / (SIZE_SOL + TX_COST)
        if return_on_cost >= exit_config["tp"]:
            reason = "TAKE_PROFIT"
            break
        if return_on_cost <= exit_config["sl"]:
            reason = "STOP_LOSS"
            break
        if elapsed >= exit_config["hold"]:
            break
    if selected is None:
        return None
    _, pnl, exit_row = selected
    return {
        "entryTime": entry_row["bucket"],
        "exitTime": exit_row["bucket"],
        "pnlSol": pnl,
        "reason": reason,
    }


def metrics(trades):
    if not trades:
        return {"trades": 0, "pnlSol": 0, "winRate": None, "maxDrawdownSol": 0, "largestProfitShare": None}
    trades = sorted(trades, key=lambda trade: trade["exitTime"])
    pnl = sum(trade["pnlSol"] for trade in trades)
    equity = peak = drawdown = 0
    for trade in trades:
        equity += trade["pnlSol"]
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    largest = max(trade["pnlSol"] for trade in trades)
    return {
        "trades": len(trades),
        "pnlSol": pnl,
        "averagePnlSol": pnl / len(trades),
        "winRate": sum(trade["pnlSol"] > 0 for trade in trades) / len(trades),
        "maxDrawdownSol": drawdown,
        "largestProfitShare": largest / pnl if pnl > 0 else None,
    }


connection = duckdb.connect()
start = connection.execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = start + timedelta(days=4)
validation_end = train_end + timedelta(days=1)


def split(timestamp):
    if timestamp < train_end:
        return "train"
    if timestamp < validation_end:
        return "validation"
    return "test"


columns = [
    "mint", "bucket", "age_seconds", "curve_close", "buys_2s", "buy_sol_5s", "sell_sol_5s",
    "return_5s", "drawdown_from_60s_peak", "v_sol_close", "v_tokens_close",
]
cursor = connection.execute(
    f"SELECT {','.join(columns)} FROM read_parquet(?) ORDER BY mint,bucket",
    [str(BARS)],
)
trade_store = {
    finalist["name"]: {index: defaultdict(list) for index in range(len(EXIT_GRID))}
    for finalist in FINALISTS
}


def process(rows):
    if len(rows) < 3:
        return
    for finalist in FINALISTS:
        index = next((i for i, row in enumerate(rows) if signal_matches(finalist["parameters"], row)), None)
        if index is None:
            continue
        result = path_after_signal(rows, index)
        if result is None:
            continue
        entry_row, path = result
        partition = split(entry_row["bucket"])
        for exit_index, exit_config in enumerate(EXIT_GRID):
            trade = apply_exit(entry_row, path, exit_config)
            if trade:
                trade_store[finalist["name"]][exit_index][partition].append(trade)


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

rows = []
for finalist in FINALISTS:
    for index, exit_config in enumerate(EXIT_GRID):
        store = trade_store[finalist["name"]][index]
        rows.append({
            "signal": finalist["name"],
            "signalParameters": finalist["parameters"],
            "exit": exit_config,
            "train": metrics(store["train"]),
            "validation": metrics(store["validation"]),
            "test": metrics(store["test"]),
        })

frozen = sorted(
    (row for row in rows if row["train"]["trades"] >= 30),
    key=lambda row: row["train"]["pnlSol"],
    reverse=True,
)[:25]
survivors = [
    row for row in frozen
    if row["train"]["pnlSol"] > 0
    and row["validation"]["trades"] >= 5
    and row["validation"]["pnlSol"] > 0
    and (row["validation"]["largestProfitShare"] or 0) <= 0.60
]
payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "gridSize": len(rows),
    "screeningAssumptions": {
        "sizeSol": SIZE_SOL,
        "feeRateEachSide": FEE_RATE,
        "txCostEachSideSol": TX_COST,
        "entry": "next one-second bar",
        "ownImpact": True,
    },
    "frozenTrainingFinalists": frozen,
    "validationSurvivors": survivors,
    "warning": "Exit tuning is training-only; test results are reported only for configurations that survive validation.",
}
OUT.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps({"output": str(OUT), "gridSize": len(rows), "frozenTrainingFinalists": frozen, "validationSurvivors": survivors}, indent=2, default=str))
