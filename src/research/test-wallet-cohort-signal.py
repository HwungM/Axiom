import json
import math
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
BARS = DATA_DIR / "curve-bars-1s.parquet"
WALLETS = DATA_DIR / "manual-wallet-sample.parquet"
FIRST_BUYS = DATA_DIR / "manual-wallet-first-buys.parquet"
MANIFEST = json.loads((DATA_DIR / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
OUT = ROOT / "reports" / "wallet-cohort-signal-v1.json"

SIZE_SOL = 0.5
FEE_RATE = 0.0125
TX_COST = 0.0032
COHORT_CONFIGS = []
for top_n in (10, 25, 50, 100, 250):
    COHORT_CONFIGS.append({"topN": top_n, "confirmations": 1, "windowSeconds": None})
    for confirmations in (2, 3):
        for window_seconds in (3, 10, 30):
            COHORT_CONFIGS.append({"topN": top_n, "confirmations": confirmations, "windowSeconds": window_seconds})
EXIT_GRID = [
    {"tp": tp, "sl": sl, "hold": hold}
    for tp in (0.15, 0.25, 0.40, 0.60, 1.00)
    for sl in (-0.10, -0.15, -0.25, -0.40)
    for hold in (10, 20, 40, 80, 150)
]


def reserves(row):
    return row["v_sol_close"] / 1e9, row["v_tokens_close"] / 1e6


def build_path(rows, signal_time):
    signal_index = next((i for i, row in enumerate(rows) if row["bucket"] >= signal_time), None)
    if signal_index is None:
        return None
    entry_index = next((i for i in range(signal_index + 1, len(rows))
                        if (rows[i]["bucket"] - signal_time).total_seconds() >= 1), None)
    if entry_index is None or rows[entry_index]["curve_close"] >= 95:
        return None
    quote, token = reserves(rows[entry_index])
    effective = SIZE_SOL * (1 - FEE_RATE)
    tokens = token - quote * token / (quote + effective)
    if not math.isfinite(tokens) or tokens <= 0:
        return None
    path = []
    for row in rows[entry_index + 1:]:
        elapsed = (row["bucket"] - rows[entry_index]["bucket"]).total_seconds()
        if elapsed > 180 or row["curve_close"] >= 95:
            break
        actual_quote, actual_token = reserves(row)
        virtual_quote = actual_quote + effective
        virtual_token = actual_token - tokens
        if virtual_quote <= 0 or virtual_token <= 0:
            continue
        output = (virtual_quote - virtual_quote * virtual_token / (virtual_token + tokens)) * (1 - FEE_RATE)
        pnl = output - SIZE_SOL - 2 * TX_COST
        if math.isfinite(pnl):
            path.append((elapsed, pnl, row["bucket"]))
    return (rows[entry_index]["bucket"], path) if path else None


def exit_trade(entry_time, path, config):
    selected = None
    reason = "TIMEOUT"
    for elapsed, pnl, timestamp in path:
        selected = (pnl, timestamp)
        return_on_cost = pnl / (SIZE_SOL + TX_COST)
        if return_on_cost >= config["tp"]:
            reason = "TAKE_PROFIT"
            break
        if return_on_cost <= config["sl"]:
            reason = "STOP_LOSS"
            break
        if elapsed >= config["hold"]:
            break
    if selected is None:
        return None
    return {"entryTime": entry_time, "exitTime": selected[1], "pnlSol": selected[0], "reason": reason}


def metrics(trades):
    if not trades:
        return {"trades": 0, "pnlSol": 0, "winRate": None, "maxDrawdownSol": 0, "largestProfitShare": None}
    ordered = sorted(trades, key=lambda trade: trade["exitTime"])
    pnl = sum(trade["pnlSol"] for trade in ordered)
    equity = peak = drawdown = 0
    for trade in ordered:
        equity += trade["pnlSol"]
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    largest = max(trade["pnlSol"] for trade in ordered)
    return {
        "trades": len(ordered),
        "pnlSol": pnl,
        "averagePnlSol": pnl / len(ordered),
        "winRate": sum(trade["pnlSol"] > 0 for trade in ordered) / len(ordered),
        "maxDrawdownSol": drawdown,
        "largestProfitShare": largest / pnl if pnl > 0 else None,
    }


connection = duckdb.connect()
start = connection.execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = start + timedelta(days=4)
validation_end = train_end + timedelta(days=1)


def partition(timestamp):
    if timestamp < train_end:
        return "train"
    if timestamp < validation_end:
        return "validation"
    return "test"


ranked_buys = connection.execute(
    """
    WITH ranked AS (
      SELECT wallet, row_number() OVER (ORDER BY pnl_sol DESC) AS wallet_rank
      FROM read_parquet(?)
    )
    SELECT f.mint, f.wallet, f.first_buy_at, r.wallet_rank
    FROM read_parquet(?) f
    JOIN ranked r USING (wallet)
    ORDER BY f.mint, f.first_buy_at, r.wallet_rank
    """,
    [str(WALLETS), str(FIRST_BUYS)],
).fetchall()
by_mint = defaultdict(list)
for mint, wallet, first_buy_at, wallet_rank in ranked_buys:
    by_mint[mint].append({"wallet": wallet, "time": first_buy_at, "rank": wallet_rank})

signals = {index: {} for index in range(len(COHORT_CONFIGS))}
for mint, buys in by_mint.items():
    for config_index, config in enumerate(COHORT_CONFIGS):
        eligible = [buy for buy in buys if buy["rank"] <= config["topN"]]
        if len(eligible) < config["confirmations"]:
            continue
        chosen = eligible[:config["confirmations"]]
        if config["confirmations"] > 1:
            span = (chosen[-1]["time"] - chosen[0]["time"]).total_seconds()
            if span > config["windowSeconds"]:
                continue
        signals[config_index][mint] = chosen[-1]["time"]

columns = ["mint", "bucket", "curve_close", "v_sol_close", "v_tokens_close"]
cursor = connection.execute(
    f"SELECT {','.join(columns)} FROM read_parquet(?) ORDER BY mint,bucket",
    [str(BARS)],
)
store = {
    config_index: {exit_index: defaultdict(list) for exit_index in range(len(EXIT_GRID))}
    for config_index in range(len(COHORT_CONFIGS))
}


def process(mint, rows):
    for config_index in range(len(COHORT_CONFIGS)):
        signal_time = signals[config_index].get(mint)
        if signal_time is None:
            continue
        result = build_path(rows, signal_time)
        if result is None:
            continue
        entry_time, path = result
        split = partition(entry_time)
        for exit_index, exit_config in enumerate(EXIT_GRID):
            trade = exit_trade(entry_time, path, exit_config)
            if trade:
                trade["mint"] = mint
                store[config_index][exit_index][split].append(trade)


current_mint = None
rows = []
while True:
    batch = cursor.fetchmany(25_000)
    if not batch:
        break
    for values in batch:
        row = dict(zip(columns, values))
        if current_mint is None:
            current_mint = row["mint"]
        if row["mint"] != current_mint:
            process(current_mint, rows)
            rows = []
            current_mint = row["mint"]
        rows.append(row)
if rows:
    process(current_mint, rows)

results = []
for config_index, cohort_config in enumerate(COHORT_CONFIGS):
    for exit_index, exit_config in enumerate(EXIT_GRID):
        result_store = store[config_index][exit_index]
        results.append({
            "cohort": cohort_config,
            "exit": exit_config,
            "train": metrics(result_store["train"]),
            "validation": metrics(result_store["validation"]),
            "test": metrics(result_store["test"]),
        })

frozen = sorted(
    (row for row in results if row["train"]["trades"] >= 20),
    key=lambda row: row["train"]["pnlSol"],
    reverse=True,
)[:30]
survivors = [
    row for row in frozen
    if row["train"]["pnlSol"] > 0
    and row["validation"]["trades"] >= 5
    and row["validation"]["pnlSol"] > 0
    and (row["validation"]["largestProfitShare"] or 0) <= 0.60
]
payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "gridSize": len(results),
    "walletSelection": "Top-N is ranked only on the first four training days from the non-leaderboard recent-wallet sample.",
    "execution": {"sizeSol": SIZE_SOL, "entry": "next one-second bar", "ownImpact": True, "feeRateEachSide": FEE_RATE, "txCostEachSideSol": TX_COST},
    "frozenTrainingFinalists": frozen,
    "validationSurvivors": survivors,
    "warning": "This tests a training-defined wallet-cohort signal. It is not evidence that blindly copying any wallet is profitable.",
}
OUT.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps({"output": str(OUT), "gridSize": len(results), "frozenTrainingFinalists": frozen, "validationSurvivors": survivors}, indent=2, default=str))
