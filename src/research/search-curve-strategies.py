import json
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
BARS = DATA_DIR / "curve-bars-1s.parquet"
MANIFEST = json.loads((DATA_DIR / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
OUT_JSON = ROOT / "reports" / "curve-strategy-screen-v1.json"
OUT_MD = ROOT / "reports" / "curve-strategy-screen-v1.md"

SIZE_SOL = 0.5
FEE_RATE = 0.0125
TX_COST_PER_SIDE_SOL = 0.0032
TP_RETURN = 0.50
SL_RETURN = -0.25
MAX_HOLD_SECONDS = 60


@dataclass(frozen=True)
class Config:
    name: str
    family: str
    parameters: dict


def configurations():
    result = []
    for buys_2s in (3, 5, 8):
        for buyers_5s in (6, 10):
            for buy_sol_5s in (0.25, 0.75):
                for pressure in (1.5, 3.0):
                    params = locals().copy()
                    params = {key: params[key] for key in ("buys_2s", "buyers_5s", "buy_sol_5s", "pressure")}
                    result.append(Config(f"crowd-{len(result):03d}", "crowd_acceleration", params))
    quiet_start = len(result)
    for buys_2s in (3, 5, 8):
        for prior_buys_max in (1, 3, 6):
            for buy_sol_2s in (0.15, 0.50):
                params = locals().copy()
                params = {key: params[key] for key in ("buys_2s", "prior_buys_max", "buy_sol_2s")}
                result.append(Config(f"quiet-{len(result)-quiet_start:03d}", "quiet_to_burst", params))
    reclaim_start = len(result)
    for drawdown in (-0.15, -0.25, -0.35):
        for bounce in (0.08, 0.15):
            for buys_2s in (3, 5):
                for pressure in (1.5, 3.0):
                    params = locals().copy()
                    params = {key: params[key] for key in ("drawdown", "bounce", "buys_2s", "pressure")}
                    result.append(Config(f"reclaim-{len(result)-reclaim_start:03d}", "pullback_reclaim", params))
    absorb_start = len(result)
    for sell_sol_5s in (0.25, 0.75):
        for buys_2s in (3, 5, 8):
            result.append(Config(
                f"absorb-{len(result)-absorb_start:03d}",
                "sell_absorption",
                {"sell_sol_5s": sell_sol_5s, "buys_2s": buys_2s},
            ))
    breadth_start = len(result)
    for current_buyers in (2, 4, 6):
        for return_5s in (0.05, 0.15):
            for buy_sol_2s in (0.15, 0.50):
                result.append(Config(
                    f"breadth-{len(result)-breadth_start:03d}",
                    "breadth_breakout",
                    {"current_buyers": current_buyers, "return_5s": return_5s, "buy_sol_2s": buy_sol_2s},
                ))
    manual_start = len(result)
    for age_max in (45, 120):
        for curve_min in (40, 55):
            for buys_2s in (5, 10):
                for buy_sol_5s in (3.0, 7.0, 12.0):
                    for pressure in (1.2, 2.5):
                        result.append(Config(
                            f"manual-{len(result)-manual_start:03d}",
                            "manual_state_anticipation",
                            {
                                "age_max": age_max,
                                "curve_min": curve_min,
                                "buys_2s": buys_2s,
                                "buy_sol_5s": buy_sol_5s,
                                "pressure": pressure,
                            },
                        ))
    return result


CONFIGS = configurations()


def common(row):
    return (
        8 <= row["age_seconds"] <= 240
        and 5 <= row["curve_close"] <= 82
        and row["mc_close"] > 0
        and row["return_5s"] is not None
        and row["return_5s"] <= 1.25
    )


def matches(config, row):
    if not common(row):
        return False
    p = config.parameters
    if config.family == "crowd_acceleration":
        return (
            row["buys_2s"] >= p["buys_2s"]
            and row["buyer_seconds_5s"] >= p["buyers_5s"]
            and row["buy_sol_5s"] >= p["buy_sol_5s"]
            and row["buy_sol_5s"] >= p["pressure"] * max(row["sell_sol_5s"], 0.03)
            and row["buys_5s"] > row["prior_buys_5_to_15s"] * 0.5
        )
    if config.family == "quiet_to_burst":
        return (
            row["buys_2s"] >= p["buys_2s"]
            and row["prior_buys_5_to_15s"] <= p["prior_buys_max"]
            and row["buy_sol_2s"] >= p["buy_sol_2s"]
            and row["buy_sol_2s"] >= 2 * max(row["sell_sol_2s"], 0.02)
        )
    if config.family == "pullback_reclaim":
        return (
            row["drawdown_from_60s_peak"] is not None
            and row["bounce_from_15s_low"] is not None
            and row["drawdown_from_60s_peak"] <= p["drawdown"]
            and row["drawdown_from_60s_peak"] >= -0.65
            and row["bounce_from_15s_low"] >= p["bounce"]
            and row["buys_2s"] >= p["buys_2s"]
            and row["buy_sol_2s"] >= p["pressure"] * max(row["sell_sol_2s"], 0.02)
        )
    if config.family == "sell_absorption":
        return (
            row["one_bar_return"] is not None
            and row["drawdown_from_60s_peak"] is not None
            and row["sell_sol_5s"] >= p["sell_sol_5s"]
            and row["buys_2s"] >= p["buys_2s"]
            and row["buy_sol_2s"] >= 0.15
            and row["one_bar_return"] >= -0.08
            and row["drawdown_from_60s_peak"] >= -0.40
        )
    if config.family == "breadth_breakout":
        return (
            row["buyers"] >= p["current_buyers"]
            and row["return_5s"] >= p["return_5s"]
            and row["buy_sol_2s"] >= p["buy_sol_2s"]
            and row["buy_sol_2s"] >= 1.5 * max(row["sell_sol_2s"], 0.02)
        )
    if config.family == "manual_state_anticipation":
        return (
            row["age_seconds"] <= p["age_max"]
            and row["curve_close"] >= p["curve_min"]
            and row["buys_2s"] >= p["buys_2s"]
            and row["buy_sol_5s"] >= p["buy_sol_5s"]
            and row["buy_sol_5s"] >= p["pressure"] * max(row["sell_sol_5s"], 0.10)
            and row["return_5s"] >= 0.02
            and row["return_5s"] <= 0.60
            and row["drawdown_from_60s_peak"] >= -0.20
        )
    return False


def reserves(row):
    return row["v_sol_close"] / 1e9, row["v_tokens_close"] / 1e6


def entry_position(row):
    quote_reserve, token_reserve = reserves(row)
    effective = SIZE_SOL * (1 - FEE_RATE)
    invariant = quote_reserve * token_reserve
    new_quote = quote_reserve + effective
    new_token = invariant / new_quote
    tokens_out = token_reserve - new_token
    if not all(map(math.isfinite, (quote_reserve, token_reserve, tokens_out))) or tokens_out <= 0:
        return None
    return {"effective": effective, "tokens": tokens_out}


def liquidation_pnl(position, row):
    actual_quote, actual_token = reserves(row)
    virtual_quote = actual_quote + position["effective"]
    virtual_token = actual_token - position["tokens"]
    if virtual_quote <= 0 or virtual_token <= 0:
        return None
    invariant = virtual_quote * virtual_token
    post_sell_token = virtual_token + position["tokens"]
    post_sell_quote = invariant / post_sell_token
    gross_quote_out = virtual_quote - post_sell_quote
    net_quote_out = gross_quote_out * (1 - FEE_RATE)
    pnl = net_quote_out - SIZE_SOL - 2 * TX_COST_PER_SIDE_SOL
    return pnl if math.isfinite(pnl) else None


def simulate_signal(rows, signal_index):
    signal_time = rows[signal_index]["bucket"]
    entry_index = next(
        (index for index in range(signal_index + 1, len(rows))
         if (rows[index]["bucket"] - signal_time).total_seconds() >= 1),
        None,
    )
    if entry_index is None or rows[entry_index]["curve_close"] >= 95:
        return None
    position = entry_position(rows[entry_index])
    if position is None:
        return None
    last = None
    peak_pnl = -math.inf
    trough_pnl = math.inf
    exit_reason = "TIMEOUT"
    for index in range(entry_index + 1, len(rows)):
        row = rows[index]
        elapsed = (row["bucket"] - rows[entry_index]["bucket"]).total_seconds()
        if row["curve_close"] >= 95:
            break
        pnl = liquidation_pnl(position, row)
        if pnl is None:
            continue
        last = (index, row, pnl)
        peak_pnl = max(peak_pnl, pnl)
        trough_pnl = min(trough_pnl, pnl)
        return_on_cost = pnl / (SIZE_SOL + TX_COST_PER_SIDE_SOL)
        if return_on_cost >= TP_RETURN:
            exit_reason = "TAKE_PROFIT"
            break
        if return_on_cost <= SL_RETURN:
            exit_reason = "STOP_LOSS"
            break
        if elapsed >= MAX_HOLD_SECONDS:
            break
    if last is None:
        return None
    _, exit_row, pnl = last
    return {
        "entryTime": rows[entry_index]["bucket"],
        "exitTime": exit_row["bucket"],
        "pnlSol": pnl,
        "returnPct": 100 * pnl / (SIZE_SOL + TX_COST_PER_SIDE_SOL),
        "peakPnlSol": peak_pnl,
        "troughPnlSol": trough_pnl,
        "exitReason": exit_reason,
        "entryMarketCapSol": rows[entry_index]["mc_close"],
        "exitMarketCapSol": exit_row["mc_close"],
    }


def summarize(trades):
    if not trades:
        return {"trades": 0, "pnlSol": 0, "winRate": None, "largestProfitShare": None, "maxDrawdownSol": 0}
    ordered = sorted(trades, key=lambda trade: trade["exitTime"])
    equity = 0
    peak = 0
    max_drawdown = 0
    for trade in ordered:
        equity += trade["pnlSol"]
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
    pnl = sum(trade["pnlSol"] for trade in trades)
    wins = sum(trade["pnlSol"] > 0 for trade in trades)
    largest = max(trade["pnlSol"] for trade in trades)
    return {
        "trades": len(trades),
        "pnlSol": pnl,
        "averagePnlSol": pnl / len(trades),
        "winRate": wins / len(trades),
        "largestProfitShare": largest / pnl if pnl > 0 else None,
        "maxDrawdownSol": max_drawdown,
        "takeProfits": sum(trade["exitReason"] == "TAKE_PROFIT" for trade in trades),
        "stopLosses": sum(trade["exitReason"] == "STOP_LOSS" for trade in trades),
    }


start = duckdb.connect().execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = start + timedelta(days=4)
validation_end = train_end + timedelta(days=1)
test_end = start + timedelta(days=7)


def split_name(timestamp):
    if timestamp < train_end:
        return "train"
    if timestamp < validation_end:
        return "validation"
    if timestamp <= test_end:
        return "test"
    return None


columns = [
    "mint", "bucket", "age_seconds", "buys", "sells", "buyers", "sellers", "buy_sol", "sell_sol",
    "mc_close", "curve_close", "v_tokens_close", "v_sol_close", "buys_2s", "sells_2s",
    "buyer_seconds_2s", "seller_seconds_2s", "buy_sol_2s", "sell_sol_2s", "buys_5s", "sells_5s",
    "buyer_seconds_5s", "seller_seconds_5s", "buy_sol_5s", "sell_sol_5s", "buys_15s", "sells_15s",
    "buyer_seconds_15s", "buy_sol_15s", "sell_sol_15s", "prior_buys_5_to_15s", "return_5s",
    "return_15s", "drawdown_from_60s_peak", "bounce_from_15s_low", "one_bar_return",
]
connection = duckdb.connect()
cursor = connection.execute(
    f"SELECT {','.join(columns)} FROM read_parquet(?) ORDER BY mint,bucket",
    [str(BARS)],
)
results = {config.name: {"config": config, "trades": defaultdict(list)} for config in CONFIGS}


def process_token(rows):
    if len(rows) < 3:
        return
    for config in CONFIGS:
        signal_index = next((index for index, row in enumerate(rows) if matches(config, row)), None)
        if signal_index is None:
            continue
        trade = simulate_signal(rows, signal_index)
        if trade is None:
            continue
        split = split_name(trade["entryTime"])
        if split:
            trade["mint"] = rows[signal_index]["mint"]
            results[config.name]["trades"][split].append(trade)


current_mint = None
token_rows = []
processed_tokens = 0
while True:
    batch = cursor.fetchmany(25_000)
    if not batch:
        break
    for values in batch:
        row = dict(zip(columns, values))
        if current_mint is None:
            current_mint = row["mint"]
        if row["mint"] != current_mint:
            process_token(token_rows)
            processed_tokens += 1
            token_rows = []
            current_mint = row["mint"]
        token_rows.append(row)
if token_rows:
    process_token(token_rows)
    processed_tokens += 1

rows = []
for config in CONFIGS:
    item = results[config.name]
    rows.append({
        "name": config.name,
        "family": config.family,
        "parameters": config.parameters,
        "train": summarize(item["trades"]["train"]),
        "validation": summarize(item["trades"]["validation"]),
        "test": summarize(item["trades"]["test"]),
    })

train_ranked = sorted(
    (row for row in rows if row["train"]["trades"] >= 20),
    key=lambda row: row["train"]["pnlSol"],
    reverse=True,
)
frozen_finalists = train_ranked[:15]
validation_survivors = [
    row for row in frozen_finalists
    if row["validation"]["trades"] >= 5
    and row["validation"]["pnlSol"] > 0
    and (row["validation"]["largestProfitShare"] or 0) <= 0.60
]

report = {
    "generatedAt": duckdb.connect().execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "protocol": {
        "sizeSol": SIZE_SOL,
        "feeRateEachSide": FEE_RATE,
        "txCostEachSideSol": TX_COST_PER_SIDE_SOL,
        "entryDelay": "next one-second bar (conservative screening proxy for 670ms base landing)",
        "takeProfitReturn": TP_RETURN,
        "stopLossReturn": SL_RETURN,
        "maxHoldSeconds": MAX_HOLD_SECONDS,
        "trainStart": start.isoformat(),
        "trainEnd": train_end.isoformat(),
        "validationEnd": validation_end.isoformat(),
        "testEnd": test_end.isoformat(),
    },
    "processedTokens": processed_tokens,
    "configurations": len(CONFIGS),
    "frozenFinalists": frozen_finalists,
    "validationSurvivors": validation_survivors,
    "allResults": rows,
    "warning": "This is a one-second-bar screen. Any survivor still requires raw microsecond event replay, bankroll concurrency, latency stress, and current forward validation.",
}
OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
OUT_JSON.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")

lines = [
    "# Curve strategy screen v1",
    "",
    report["warning"],
    "",
    f"Screened {len(CONFIGS)} configurations across {processed_tokens:,} tokens.",
    "",
    "## Frozen training finalists",
    "",
    "| Strategy | Family | Train trades | Train PnL | Validation PnL | Test PnL |",
    "|---|---:|---:|---:|---:|---:|",
]
for row in frozen_finalists:
    lines.append(
        f"| {row['name']} | {row['family']} | {row['train']['trades']} | "
        f"{row['train']['pnlSol']:.4f} | {row['validation']['pnlSol']:.4f} | {row['test']['pnlSol']:.4f} |"
    )
lines.extend(["", "## Validation survivors", ""])
if validation_survivors:
    for row in validation_survivors:
        lines.append(
            f"- {row['name']} ({row['family']}): validation {row['validation']['pnlSol']:.4f} SOL; "
            f"untouched test {row['test']['pnlSol']:.4f} SOL."
        )
else:
    lines.append("No configuration passed the frozen validation gate.")
OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(json.dumps({
    "output": str(OUT_JSON),
    "processedTokens": processed_tokens,
    "configurations": len(CONFIGS),
    "frozenFinalists": frozen_finalists,
    "validationSurvivors": validation_survivors,
}, indent=2, default=str))
