import heapq
import json
import math
import sys
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
TRADES = DATA_DIR / "curve-window-7d.parquet"
report_name = sys.argv[1] if len(sys.argv) > 1 else "selective-entry-model-v1.json"
report_path = ROOT / "reports" / report_name
MODEL_REPORT = json.loads(report_path.read_text(encoding="utf-8"))
OUT = ROOT / "reports" / f"{report_path.stem}-stress-v1.json"

SIZE_SOL = 0.5
STARTING_BANKROLL = 3.0
MAX_POSITIONS = 3
TAKE_PROFIT = 0.40
STOP_LOSS = -0.25
MAX_HOLD_SECONDS = 20
SCENARIOS = [
    {"name": "optimistic-170", "latencyMs": 170, "feeRate": 0.0125, "txCost": 0.0032, "aheadBuySol": 0},
    {"name": "base-670", "latencyMs": 670, "feeRate": 0.0125, "txCost": 0.0032, "aheadBuySol": 0},
    {"name": "safe-1170", "latencyMs": 1170, "feeRate": 0.0125, "txCost": 0.0032, "aheadBuySol": 0},
    {"name": "fee-stress-670", "latencyMs": 670, "feeRate": 0.025, "txCost": 0.0064, "aheadBuySol": 0},
    {"name": "hostile-1170", "latencyMs": 1170, "feeRate": 0.025, "txCost": 0.0064, "aheadBuySol": 1.0},
    {"name": "crowded-3170", "latencyMs": 3170, "feeRate": 0.025, "txCost": 0.0064, "aheadBuySol": 2.0},
    {"name": "broken-7170", "latencyMs": 7170, "feeRate": 0.025, "txCost": 0.0064, "aheadBuySol": 2.0},
]


signals = {}
for trade in MODEL_REPORT["testTrades"]:
    signals[trade["mint"]] = {
        "mint": trade["mint"],
        "signalBucket": duckdb.connect().execute("SELECT ?::TIMESTAMPTZ", [trade["signalTime"]]).fetchone()[0],
        "prediction": trade["prediction"],
    }


def reserves(row):
    return float(row["v_sol_bonding_curve"]) / 1e9, float(row["v_tokens_bonding_curve"]) / 1e6


def replay(rows, signal, scenario):
    observation_time = signal["signalBucket"] + timedelta(seconds=1)
    target = observation_time + timedelta(milliseconds=scenario["latencyMs"])
    entry_index = next((index for index, row in enumerate(rows) if row["event_time"] >= target), None)
    if entry_index is None or rows[entry_index]["curve_pct_depleted"] >= 95:
        return None
    quote, token = reserves(rows[entry_index])
    ahead_effective = scenario["aheadBuySol"] * (1 - scenario["feeRate"])
    if ahead_effective > 0:
        invariant = quote * token
        quote += ahead_effective
        token = invariant / quote
    effective = SIZE_SOL * (1 - scenario["feeRate"])
    tokens = token - quote * token / (quote + effective)
    if not math.isfinite(tokens) or tokens <= 0:
        return None
    selected = None
    reason = "TIMEOUT"
    peak_pnl = -math.inf
    trough_pnl = math.inf
    for row in rows[entry_index + 1:]:
        elapsed = (row["event_time"] - rows[entry_index]["event_time"]).total_seconds()
        if row["curve_pct_depleted"] >= 95:
            break
        actual_quote, actual_token = reserves(row)
        virtual_quote = actual_quote + effective
        virtual_token = actual_token - tokens
        if virtual_quote <= 0 or virtual_token <= 0:
            continue
        output = (virtual_quote - virtual_quote * virtual_token / (virtual_token + tokens)) * (1 - scenario["feeRate"])
        pnl = output - SIZE_SOL - 2 * scenario["txCost"]
        if not math.isfinite(pnl):
            continue
        peak_pnl = max(peak_pnl, pnl)
        trough_pnl = min(trough_pnl, pnl)
        selected = (row, pnl)
        return_on_cost = pnl / (SIZE_SOL + scenario["txCost"])
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
    return {
        "mint": signal["mint"],
        "prediction": signal["prediction"],
        "signalBucket": signal["signalBucket"],
        "observationTime": observation_time,
        "targetLandingTime": target,
        "entryTime": rows[entry_index]["event_time"],
        "exitTime": exit_row["event_time"],
        "pnlSol": pnl,
        "peakPnlSol": peak_pnl,
        "troughPnlSol": trough_pnl,
        "exitReason": reason,
        "entryMarketCapSol": rows[entry_index]["market_cap_sol"],
        "exitMarketCapSol": exit_row["market_cap_sol"],
    }


def portfolio(trades, scenario):
    available = STARTING_BANKROLL
    realized = 0
    peak = STARTING_BANKROLL
    max_drawdown = 0
    exits = []
    accepted = []
    required = SIZE_SOL + scenario["txCost"]
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
    largest = max((trade["pnlSol"] for trade in accepted), default=0)
    return {
        "candidateSignals": len(signals),
        "replayable": len(trades),
        "acceptedTrades": len(accepted),
        "pnlSol": realized,
        "endingBankrollSol": STARTING_BANKROLL + realized,
        "winRate": sum(trade["pnlSol"] > 0 for trade in accepted) / len(accepted) if accepted else None,
        "maxDrawdownSol": max_drawdown,
        "largestProfitShare": largest / realized if realized > 0 else None,
        "takeProfits": sum(trade["exitReason"] == "TAKE_PROFIT" for trade in accepted),
        "stopLosses": sum(trade["exitReason"] == "STOP_LOSS" for trade in accepted),
        "timeouts": sum(trade["exitReason"] == "TIMEOUT" for trade in accepted),
    }


connection = duckdb.connect()
placeholders = ",".join("?" for _ in signals)
columns = [
    "mint", "event_time", "id", "curve_pct_depleted", "v_sol_bonding_curve", "v_tokens_bonding_curve", "market_cap_sol"
]
cursor = connection.execute(
    f"SELECT {','.join(columns)} FROM read_parquet(?) WHERE mint IN ({placeholders}) ORDER BY mint,event_time,id",
    [str(TRADES), *signals.keys()],
)
scenario_trades = defaultdict(list)


def process(mint, rows):
    signal = signals.get(mint)
    if not signal:
        return
    for scenario in SCENARIOS:
        trade = replay(rows, signal, scenario)
        if trade:
            scenario_trades[scenario["name"]].append(trade)


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
for scenario in SCENARIOS:
    results.append({
        **scenario,
        **portfolio(scenario_trades[scenario["name"]], scenario),
    })
payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "signalThreshold": MODEL_REPORT["chosenOnValidation"]["threshold"],
    "signalReport": str(report_path),
    "method": "Signals frozen by the validation-selected model; raw microsecond event replay begins after the complete signal second plus scenario latency.",
    "execution": {"sizeSol": SIZE_SOL, "startingBankrollSol": STARTING_BANKROLL, "maxPositions": MAX_POSITIONS, "takeProfit": TAKE_PROFIT, "stopLoss": STOP_LOSS, "maxHoldSeconds": MAX_HOLD_SECONDS, "ownImpact": True},
    "scenarios": results,
    "warning": "Observed future trades remain an exogenous counterfactual replay; current forward paper trading is still required.",
}
OUT.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps(payload, indent=2, default=str))
