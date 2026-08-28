import json
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "research-corpus"
TRADES = DATA_DIR / "curve-window-7d.parquet"
TOKENS = DATA_DIR / "tokens-window.parquet"
WALLETS = DATA_DIR / "manual-wallet-sample.parquet"
FIRST_BUYS = DATA_DIR / "manual-wallet-first-buys.parquet"
REPORT = ROOT / "reports" / "manual-wallet-behavior-v1.json"
MANIFEST = json.loads((DATA_DIR / "curve-window-7d.manifest.json").read_text(encoding="utf-8"))
REMOTE_TOKENS = "https://huggingface.co/datasets/Slinky21/Pumpfun_Memecoin_Corpus/resolve/main/tokens.parquet"


def sql_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace("'", "''")


connection = duckdb.connect(str(DATA_DIR / "research.duckdb"))
connection.execute("SET threads=8")
connection.execute("SET preserve_insertion_order=false")
start = connection.execute("SELECT ?::TIMESTAMPTZ", [MANIFEST["sourceWindowStart"]]).fetchone()[0]
train_end = connection.execute("SELECT ?::TIMESTAMPTZ + INTERVAL 4 DAY", [start]).fetchone()[0]
trade_path = sql_path(TRADES)

connection.execute(
    f"""
    COPY (
      SELECT
        mint, detected_at, name, symbol, is_mayhem_mode, creator,
        creator_past_tokens, creator_past_rugs, initial_buy_sol,
        initial_market_cap_sol, initial_holder_count,
        initial_top1_pct_corrected, initial_top5_pct_corrected,
        initial_top10_pct_corrected, dev_buy_pct_corrected, initial_gini,
        is_cashback_enabled
      FROM read_parquet('{REMOTE_TOKENS}')
      WHERE NOT coalesce(top10_pct_suspect, false)
        AND mint IN (SELECT DISTINCT mint FROM read_parquet('{trade_path}'))
    ) TO '{sql_path(TOKENS)}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """
)

connection.execute(
    f"""
    COPY (
      WITH positions AS (
        SELECT
          user_wallet AS wallet,
          mint,
          min(event_time) FILTER (WHERE is_buy) AS first_buy_at,
          max(event_time) FILTER (WHERE NOT is_buy) AS last_sell_at,
          sum(sol_amount) FILTER (WHERE is_buy) AS buy_sol,
          sum(sol_amount) FILTER (WHERE NOT is_buy) AS sell_sol,
          sum(token_amount) FILTER (WHERE is_buy) AS bought_tokens,
          sum(token_amount) FILTER (WHERE NOT is_buy) AS sold_tokens,
          count(*) FILTER (WHERE is_buy) AS buys,
          count(*) FILTER (WHERE NOT is_buy) AS sells,
          stddev_samp(sol_amount) FILTER (WHERE is_buy) AS buy_size_std,
          avg(sol_amount) FILTER (WHERE is_buy) AS average_buy_sol
        FROM read_parquet('{trade_path}')
        WHERE event_time < ?::TIMESTAMPTZ
        GROUP BY wallet, mint
      ), closed AS (
        SELECT
          *,
          sell_sol - buy_sol - (buys + sells) * 0.0032 AS pnl_sol,
          extract(epoch FROM last_sell_at - first_buy_at) AS hold_seconds,
          sold_tokens / nullif(bought_tokens, 0) AS closure_ratio
        FROM positions
        WHERE first_buy_at IS NOT NULL
          AND last_sell_at > first_buy_at
          AND sold_tokens / nullif(bought_tokens, 0) BETWEEN 0.75 AND 1.30
      ), wallet_rollup AS (
        SELECT
          wallet,
          count(*) AS closed_positions,
          sum(pnl_sol) AS pnl_sol,
          avg((pnl_sol > 0)::INT) AS win_rate,
          median(hold_seconds) AS median_hold_seconds,
          median(average_buy_sol) AS median_buy_sol,
          avg(coalesce(buy_size_std / nullif(average_buy_sol, 0), 0)) AS mean_buy_size_cv,
          max(pnl_sol) AS largest_position_pnl,
          sum(greatest(pnl_sol, 0)) AS gross_profit,
          sum(least(pnl_sol, 0)) AS gross_loss,
          count(DISTINCT mint) AS distinct_mints
        FROM closed
        GROUP BY wallet
      )
      SELECT
        *,
        largest_position_pnl / nullif(gross_profit, 0) AS largest_profit_share,
        gross_profit / nullif(abs(gross_loss), 0) AS profit_factor
      FROM wallet_rollup
      WHERE closed_positions BETWEEN 10 AND 250
        AND pnl_sol > 0
        AND median_hold_seconds BETWEEN 3 AND 900
        AND mean_buy_size_cv >= 0.10
        AND largest_position_pnl / nullif(gross_profit, 0) <= 0.60
      ORDER BY pnl_sol DESC
      LIMIT 250
    ) TO '{sql_path(WALLETS)}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """,
    [train_end],
)

connection.execute(
    f"""
    COPY (
      SELECT
        t.user_wallet AS wallet,
        t.mint,
        min(t.event_time) AS first_buy_at,
        arg_min(t.sol_amount, struct_pack(t := t.event_time, id := t.id)) AS first_buy_sol
      FROM read_parquet('{trade_path}') t
      JOIN read_parquet('{sql_path(WALLETS)}') w ON w.wallet = t.user_wallet
      WHERE t.is_buy
      GROUP BY t.user_wallet, t.mint
    ) TO '{sql_path(FIRST_BUYS)}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """
)

wallet_rows = connection.execute(
    f"SELECT * FROM read_parquet('{sql_path(WALLETS)}') ORDER BY pnl_sol DESC"
).fetchdf()
behavior = connection.execute(
    f"""
    SELECT
      count(*) AS first_buys,
      median(b.age_seconds) AS median_age_seconds,
      median(b.curve_close) AS median_curve,
      median(b.buys_2s) AS median_buys_2s,
      median(b.buyer_seconds_5s) AS median_buyer_seconds_5s,
      median(b.buy_sol_5s) AS median_buy_sol_5s,
      median(b.return_5s) AS median_return_5s,
      median(b.drawdown_from_60s_peak) AS median_drawdown,
      quantile_cont(b.age_seconds, [0.1,0.25,0.5,0.75,0.9]) AS age_quantiles,
      quantile_cont(b.curve_close, [0.1,0.25,0.5,0.75,0.9]) AS curve_quantiles,
      quantile_cont(b.buys_2s, [0.1,0.25,0.5,0.75,0.9]) AS buys_2s_quantiles,
      quantile_cont(b.buy_sol_5s, [0.1,0.25,0.5,0.75,0.9]) AS buy_sol_5s_quantiles
    FROM read_parquet('{sql_path(FIRST_BUYS)}') f
    ASOF JOIN read_parquet('{sql_path(DATA_DIR / 'curve-bars-1s.parquet')}') b
      ON f.mint = b.mint AND f.first_buy_at >= b.bucket
    WHERE f.first_buy_at - b.bucket <= INTERVAL 2 SECOND
    """
).fetchdf().iloc[0].to_dict()

payload = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "trainStart": start.isoformat(),
    "trainEnd": train_end.isoformat(),
    "selection": {
        "source": "recent-window wallets only; no platform leaderboard",
        "closedPositions": [10, 250],
        "positiveTrainingPnl": True,
        "medianHoldSeconds": [3, 900],
        "meanBuySizeCvMinimum": 0.10,
        "largestProfitShareMaximum": 0.60,
    },
    "selectedWallets": len(wallet_rows),
    "topWallets": wallet_rows.head(25).to_dict(orient="records"),
    "preBuyBehavior": behavior,
    "warning": "These wallets are training labels for behavior discovery, not a copy-trading recommendation or proof of future profitability.",
}
REPORT.parent.mkdir(parents=True, exist_ok=True)
REPORT.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
print(json.dumps(payload, indent=2, default=str))
