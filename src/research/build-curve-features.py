import json
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
TRADES = DATA_DIR / "curve-window-7d.parquet"
BARS = DATA_DIR / "curve-bars-1s.parquet"
TOKENS = DATA_DIR / "tokens-window.parquet"
MANIFEST = DATA_DIR / "curve-bars-1s.manifest.json"


def sql_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace("'", "''")


connection = duckdb.connect(str(DATA_DIR / "research.duckdb"))
connection.execute("SET threads=8")
connection.execute("SET preserve_insertion_order=false")

trade_path = sql_path(TRADES)
bar_path = sql_path(BARS)
query = f"""
WITH seconds AS (
  SELECT
    mint,
    date_trunc('second', event_time) AS bucket,
    min(seconds_since_launch) AS age_seconds,
    count(*) FILTER (WHERE is_buy) AS buys,
    count(*) FILTER (WHERE NOT is_buy) AS sells,
    count(DISTINCT user_wallet) FILTER (WHERE is_buy) AS buyers,
    count(DISTINCT user_wallet) FILTER (WHERE NOT is_buy) AS sellers,
    sum(sol_amount) FILTER (WHERE is_buy) AS buy_sol,
    sum(sol_amount) FILTER (WHERE NOT is_buy) AS sell_sol,
    max(sol_amount) FILTER (WHERE is_buy) AS largest_buy_sol,
    max(sol_amount) FILTER (WHERE NOT is_buy) AS largest_sell_sol,
    arg_min(market_cap_sol, struct_pack(t := event_time, id := id)) AS mc_open,
    arg_max(market_cap_sol, struct_pack(t := event_time, id := id)) AS mc_close,
    max(market_cap_sol) AS mc_high,
    min(market_cap_sol) AS mc_low,
    arg_max(curve_pct_depleted, struct_pack(t := event_time, id := id)) AS curve_close,
    arg_max(v_tokens_bonding_curve, struct_pack(t := event_time, id := id)) AS v_tokens_close,
    arg_max(v_sol_bonding_curve, struct_pack(t := event_time, id := id)) AS v_sol_close,
    max(event_time) AS last_event_time
  FROM read_parquet('{trade_path}')
  WHERE seconds_since_launch <= 900
  GROUP BY mint, bucket
), features AS (
  SELECT
    *,
    sum(buys) OVER w2 AS buys_2s,
    sum(sells) OVER w2 AS sells_2s,
    sum(buyers) OVER w2 AS buyer_seconds_2s,
    sum(sellers) OVER w2 AS seller_seconds_2s,
    sum(coalesce(buy_sol, 0)) OVER w2 AS buy_sol_2s,
    sum(coalesce(sell_sol, 0)) OVER w2 AS sell_sol_2s,
    sum(buys) OVER w5 AS buys_5s,
    sum(sells) OVER w5 AS sells_5s,
    sum(buyers) OVER w5 AS buyer_seconds_5s,
    sum(sellers) OVER w5 AS seller_seconds_5s,
    sum(coalesce(buy_sol, 0)) OVER w5 AS buy_sol_5s,
    sum(coalesce(sell_sol, 0)) OVER w5 AS sell_sol_5s,
    sum(buys) OVER w15 AS buys_15s,
    sum(sells) OVER w15 AS sells_15s,
    sum(buyers) OVER w15 AS buyer_seconds_15s,
    sum(coalesce(buy_sol, 0)) OVER w15 AS buy_sol_15s,
    sum(coalesce(sell_sol, 0)) OVER w15 AS sell_sol_15s,
    max(mc_high) OVER w60 AS peak_mc_60s,
    min(mc_low) OVER w15 AS low_mc_15s,
    first_value(mc_open) OVER w5 AS mc_5s_ago,
    first_value(mc_open) OVER w15 AS mc_15s_ago,
    lag(mc_close) OVER (PARTITION BY mint ORDER BY bucket) AS previous_mc_close
  FROM seconds
  WINDOW
    w2 AS (PARTITION BY mint ORDER BY bucket RANGE BETWEEN INTERVAL 1 SECOND PRECEDING AND CURRENT ROW),
    w5 AS (PARTITION BY mint ORDER BY bucket RANGE BETWEEN INTERVAL 4 SECOND PRECEDING AND CURRENT ROW),
    w15 AS (PARTITION BY mint ORDER BY bucket RANGE BETWEEN INTERVAL 14 SECOND PRECEDING AND CURRENT ROW),
    w60 AS (PARTITION BY mint ORDER BY bucket RANGE BETWEEN INTERVAL 59 SECOND PRECEDING AND CURRENT ROW)
)
SELECT
  features.*,
  tokens.is_mayhem_mode,
  tokens.creator_past_tokens,
  tokens.creator_past_rugs,
  tokens.initial_buy_sol,
  tokens.initial_market_cap_sol,
  tokens.initial_holder_count,
  tokens.initial_top1_pct_corrected,
  tokens.initial_top5_pct_corrected,
  tokens.initial_top10_pct_corrected,
  tokens.dev_buy_pct_corrected,
  tokens.initial_gini,
  tokens.is_cashback_enabled,
  buys_15s - buys_5s AS prior_buys_5_to_15s,
  buyer_seconds_15s - buyer_seconds_5s AS prior_buyer_seconds_5_to_15s,
  buy_sol_15s - buy_sol_5s AS prior_buy_sol_5_to_15s,
  sell_sol_15s - sell_sol_5s AS prior_sell_sol_5_to_15s,
  mc_close / nullif(mc_5s_ago, 0) - 1 AS return_5s,
  mc_close / nullif(mc_15s_ago, 0) - 1 AS return_15s,
  mc_close / nullif(peak_mc_60s, 0) - 1 AS drawdown_from_60s_peak,
  mc_close / nullif(low_mc_15s, 0) - 1 AS bounce_from_15s_low,
  mc_close / nullif(previous_mc_close, 0) - 1 AS one_bar_return
FROM features
LEFT JOIN read_parquet('{sql_path(TOKENS)}') tokens USING (mint)
ORDER BY mint, bucket
"""

connection.execute(f"COPY ({query}) TO '{bar_path}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)")
stats = connection.execute(
    f"SELECT count(*), count(DISTINCT mint), min(bucket), max(bucket) FROM read_parquet('{bar_path}')"
).fetchone()
manifest = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "source": str(TRADES),
    "rows": stats[0],
    "mints": stats[1],
    "start": stats[2].isoformat(),
    "end": stats[3].isoformat(),
    "notes": [
        "buyer_seconds is a sum of per-second distinct buyers, not exact distinct wallets across the whole rolling window",
        "features use only the current and earlier buckets",
        "bars stop at 900 seconds since launch to focus on observable early crowd behavior",
    ],
}
MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
