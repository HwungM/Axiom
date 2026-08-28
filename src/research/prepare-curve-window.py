import json
import os
from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "research-corpus"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PARQUET = OUT_DIR / "curve-window-7d.parquet"
OUT_MANIFEST = OUT_DIR / "curve-window-7d.manifest.json"
BASE = "https://huggingface.co/datasets/Slinky21/Pumpfun_Memecoin_Corpus/resolve/main/trades/trades-{index:05d}.parquet"
SYSTEM_WALLET = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s"


def sql_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace("'", "''")


urls = [BASE.format(index=index) for index in range(12, 17)]
url_sql = "[" + ",".join(f"'{url}'" for url in urls) + "]"
connection = duckdb.connect(str(OUT_DIR / "research.duckdb"))
connection.execute("SET threads=8")
connection.execute("SET preserve_insertion_order=false")

end_time = connection.execute(
    f"SELECT max(event_time) FROM read_parquet({url_sql}, union_by_name=true)"
).fetchone()[0]
start_time = connection.execute("SELECT ?::TIMESTAMPTZ - INTERVAL 7 DAY", [end_time]).fetchone()[0]

query = f"""
SELECT
  id,
  mint,
  tx_signature,
  event_time,
  seconds_since_launch,
  is_buy,
  sol_amount,
  token_amount,
  user_wallet,
  v_tokens_bonding_curve,
  v_sol_bonding_curve,
  market_cap_sol,
  price_sol,
  curve_pct_depleted,
  source
FROM read_parquet({url_sql}, union_by_name=true)
WHERE event_time >= ?::TIMESTAMPTZ
  AND event_time <= ?::TIMESTAMPTZ
  AND user_wallet <> '{SYSTEM_WALLET}'
  AND sol_amount IS NOT NULL
  AND price_sol IS NOT NULL
  AND token_amount IS NOT NULL
  AND sol_amount > 0
  AND token_amount > 0
  AND price_sol > 0
  AND sol_amount / NULLIF(token_amount * price_sol, 0) BETWEEN 0.01 AND 100
  AND curve_pct_depleted BETWEEN 0 AND 100
  AND seconds_since_launch >= 0
ORDER BY mint, event_time, id
"""

if OUT_PARQUET.exists() and os.environ.get("RESEARCH_REBUILD") != "1":
    print(json.dumps({"cached": True, "path": str(OUT_PARQUET), "start": str(start_time), "end": str(end_time)}))
else:
    escaped = sql_path(OUT_PARQUET)
    connection.execute(
        f"COPY ({query}) TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)",
        [start_time, end_time],
    )

stats = connection.execute(
    f"""
    SELECT
      count(*) AS trades,
      count(DISTINCT mint) AS mints,
      count(DISTINCT user_wallet) AS wallets,
      min(event_time) AS observed_start,
      max(event_time) AS observed_end,
      sum(CASE WHEN is_buy THEN 1 ELSE 0 END) AS buys,
      sum(CASE WHEN NOT is_buy THEN 1 ELSE 0 END) AS sells
    FROM read_parquet('{sql_path(OUT_PARQUET)}')
    """
).fetchone()

manifest = {
    "generatedAt": connection.execute("SELECT current_timestamp").fetchone()[0].isoformat(),
    "source": "Slinky21/Pumpfun_Memecoin_Corpus (CC BY 4.0)",
    "sourceWindowStart": start_time.isoformat(),
    "sourceWindowEnd": end_time.isoformat(),
    "files": urls,
    "filters": {
        "excludedSystemWallet": SYSTEM_WALLET,
        "excludedMissingSolOrPrice": True,
        "solConsistencyRatio": [0.01, 100],
        "curvePctDepleted": [0, 100],
    },
    "rows": stats[0],
    "mints": stats[1],
    "wallets": stats[2],
    "observedStart": stats[3].isoformat(),
    "observedEnd": stats[4].isoformat(),
    "buys": stats[5],
    "sells": stats[6],
    "limitations": [
        "This is a June-July 2026 bonding-curve discovery window, not the current August PumpSwap forward tape.",
        "Rows with documented SOL/price corruption and the System Program pseudo-wallet are excluded.",
        "Final strategy claims require exact replay plus current forward-paper confirmation.",
    ],
}
OUT_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
