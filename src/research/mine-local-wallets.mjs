import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const inputPath = path.resolve(process.argv[2] ?? 'data/events/pumpswap-swaps.jsonl');
const outputPath = path.resolve(process.argv[3] ?? 'reports/research-local-wallets.json');
const TX_COST_SOL = Number(process.env.RESEARCH_TX_COST_SOL ?? 0.0032);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function entropy(values) {
  if (!values.length) return 0;
  const counts = new Map();
  for (const value of values) {
    const bucket = Math.round(value * 100) / 100;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

const rows = [];
const stream = fs.createReadStream(inputPath, 'utf8');
const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
for await (const line of reader) {
  if (!line.trim()) continue;
  try {
    const row = JSON.parse(line);
    if (!row.user || !row.pool || !row.side || row.quoteAmountRaw == null) continue;
    rows.push({
      ...row,
      sequence: row.receivedSequence ?? rows.length,
      observedMs: row.receivedAtMs ?? Number(row.timestamp) * 1000,
      quoteSol: Number(row.quoteAmountRaw) / 1e9,
    });
  } catch {}
}

rows.sort((a, b) => a.observedMs - b.observedMs || a.slot - b.slot || a.sequence - b.sequence);
const poolBuyRanks = new Map();
const poolFirstMs = new Map();
for (const row of rows) {
  if (!poolFirstMs.has(row.pool)) poolFirstMs.set(row.pool, row.observedMs);
  if (row.side !== 'buy') continue;
  if (!poolBuyRanks.has(row.pool)) poolBuyRanks.set(row.pool, new Map());
  const ranks = poolBuyRanks.get(row.pool);
  if (!ranks.has(row.user)) ranks.set(row.user, ranks.size + 1);
}

const wallets = new Map();
for (const row of rows) {
  if (!wallets.has(row.user)) wallets.set(row.user, { rows: [], pools: new Map() });
  const wallet = wallets.get(row.user);
  wallet.rows.push(row);
  if (!wallet.pools.has(row.pool)) wallet.pools.set(row.pool, []);
  wallet.pools.get(row.pool).push(row);
}

const summaries = [];
for (const [wallet, data] of wallets) {
  const buys = data.rows.filter((row) => row.side === 'buy');
  const sells = data.rows.filter((row) => row.side === 'sell');
  const buySizes = buys.map((row) => row.quoteSol).filter(Number.isFinite);
  const firstBuyRanks = [];
  const firstBuyDelaysMs = [];
  const holdSeconds = [];
  let grossQuoteFlowSol = 0;
  let roundTrips = 0;
  for (const [pool, poolRows] of data.pools) {
    const firstBuy = poolRows.find((row) => row.side === 'buy');
    const lastSell = [...poolRows].reverse().find((row) => row.side === 'sell');
    if (firstBuy) {
      const rank = poolBuyRanks.get(pool)?.get(wallet);
      if (rank != null) firstBuyRanks.push(rank);
      firstBuyDelaysMs.push(firstBuy.observedMs - poolFirstMs.get(pool));
    }
    if (firstBuy && lastSell && lastSell.observedMs >= firstBuy.observedMs) {
      roundTrips += 1;
      holdSeconds.push((lastSell.observedMs - firstBuy.observedMs) / 1000);
    }
  }
  for (const row of data.rows) grossQuoteFlowSol += row.side === 'sell' ? row.quoteSol : -row.quoteSol;
  const estimatedNetFlowSol = grossQuoteFlowSol - data.rows.length * TX_COST_SOL;
  const earlyPools = firstBuyRanks.filter((rank) => rank <= 20).length;
  const sizeEntropyBits = entropy(buySizes);
  const manualLikelihood = Math.max(0, Math.min(1,
    0.45 * Math.min(1, sizeEntropyBits / 2.5)
      + 0.25 * Math.min(1, (median(holdSeconds) ?? 0) / 90)
      + 0.15 * Math.min(1, roundTrips / Math.max(1, data.pools.size))
      + 0.15 * (buySizes.length >= 3 ? 1 : 0),
  ));
  summaries.push({
    wallet,
    events: data.rows.length,
    distinctPools: data.pools.size,
    buys: buys.length,
    sells: sells.length,
    roundTrips,
    earlyPools,
    earlyPoolRate: buys.length ? earlyPools / data.pools.size : 0,
    medianFirstBuyRank: median(firstBuyRanks),
    medianFirstBuyDelayMs: median(firstBuyDelaysMs),
    medianBuySol: median(buySizes),
    buySizeEntropyBits: sizeEntropyBits,
    medianHoldSeconds: median(holdSeconds),
    grossQuoteFlowSol,
    estimatedNetFlowSol,
    manualLikelihood,
  });
}

const eligible = summaries
  .filter((row) => row.distinctPools >= 2 && row.buys >= 2)
  .sort((a, b) =>
    b.earlyPools - a.earlyPools
      || b.distinctPools - a.distinctPools
      || b.manualLikelihood - a.manualLikelihood,
  );

const report = {
  generatedAt: new Date().toISOString(),
  inputPath,
  eventCount: rows.length,
  observedStart: rows.length ? new Date(rows[0].observedMs).toISOString() : null,
  observedEnd: rows.length ? new Date(rows.at(-1).observedMs).toISOString() : null,
  walletCount: wallets.size,
  eligibleCount: eligible.length,
  caveats: [
    'Quote flow is a candidate-discovery heuristic, not realized wallet PnL; open token inventory is not marked to market.',
    'Manual-likelihood is only a sampling heuristic based on size variation and holds, not a wallet label.',
    'The live local tape is shorter than the frozen seven-day research window.',
  ],
  candidates: eligible.slice(0, 250),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  outputPath,
  eventCount: report.eventCount,
  walletCount: report.walletCount,
  eligibleCount: report.eligibleCount,
  topCandidates: report.candidates.slice(0, 12),
}, null, 2));
