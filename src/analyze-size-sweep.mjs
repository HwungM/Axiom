import fs from 'node:fs/promises';
import path from 'node:path';

const dataRoot = path.resolve(process.env.DATA_ROOT ?? 'data');
const config = JSON.parse(await fs.readFile(path.resolve(process.env.PAPER_CONFIG ?? 'config/paper.v1.json'), 'utf8'));
const sizes = (process.env.SIZE_SWEEP_SOL ?? '0.25,0.5,0.75,1,1.5,2').split(',').map(Number);

async function readJsonl(filename) {
  try {
    return (await fs.readFile(filename, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function buy(state, quoteInput) {
  const effective = quoteInput * (1 - config.poolFeeRate);
  const baseOutput = state.base * effective / (state.quote + effective);
  state.base -= baseOutput;
  state.quote += effective;
  return baseOutput;
}

function sell(state, baseInput) {
  const effective = baseInput * (1 - config.poolFeeRate);
  const quoteOutput = state.quote * effective / (state.base + effective);
  state.base += effective;
  state.quote -= quoteOutput;
  return quoteOutput;
}

function apply(state, event) {
  if (event.side === 'buy') buy(state, event.quoteAmountRaw / 1e9);
  else sell(state, event.baseAmountRaw / 1e6);
}

const [entries, exits, events, corrections] = await Promise.all([
  readJsonl(path.join(dataRoot, 'paper', 'entries.jsonl')),
  readJsonl(path.join(dataRoot, 'paper', 'exits.jsonl')),
  readJsonl(path.join(dataRoot, 'events', 'pumpswap-swaps.jsonl')),
  readJsonl(path.join(dataRoot, 'paper', 'corrections.jsonl')),
]);
const excluded = new Set(corrections.filter((row) => row.type === 'EXCLUDED_EXIT').map((row) => row.id));
const entriesById = new Map(entries.map((row) => [row.id, row]));
const validExits = exits.filter((row) => !excluded.has(row.id));
const rows = [];

for (const exit of validExits) {
  const entry = entriesById.get(exit.id);
  if (!entry?.poolState || !Number.isFinite(entry.tokens)) continue;
  const postEntryEvents = events
    .filter((event) => event.pool === exit.pool && event.timestamp >= exit.entryTimestamp && event.timestamp <= exit.exitTimestamp)
    .slice(-exit.externalSwaps);
  if (postEntryEvents.length !== exit.externalSwaps) continue;
  const originalEffectiveQuote = entry.sizeSol * (1 - config.poolFeeRate);
  const preEntryState = {
    base: entry.poolState.base + entry.tokens,
    quote: entry.poolState.quote - originalEffectiveQuote,
  };
  const outcomes = {};
  for (const sizeSol of sizes) {
    const state = { ...preEntryState };
    const tokens = buy(state, sizeSol);
    for (const event of postEntryEvents) apply(state, event);
    const proceeds = sell(state, tokens);
    const pnlSol = proceeds - sizeSol - 2 * config.fixedCostPerTransactionSol;
    outcomes[sizeSol] = {
      pnlSol,
      returnPct: 100 * pnlSol / sizeSol,
      proceedsSol: proceeds,
    };
  }
  rows.push({
    id: exit.id,
    symbol: exit.symbol,
    holdSeconds: exit.holdSeconds,
    externalSwaps: exit.externalSwaps,
    recordedPnlSol: exit.pnlSol,
    baselineReplayErrorSol: outcomes[entry.sizeSol]?.pnlSol - exit.pnlSol,
    outcomes,
  });
}

const summary = sizes.map((sizeSol) => {
  const values = rows.map((row) => row.outcomes[sizeSol].pnlSol);
  const totalPnlSol = values.reduce((total, value) => total + value, 0);
  return {
    sizeSol,
    trades: values.length,
    totalPnlSol,
    averagePnlSol: values.length ? totalPnlSol / values.length : null,
    averageReturnPct: values.length ? rows.reduce((total, row) => total + row.outcomes[sizeSol].returnPct, 0) / values.length : null,
    wins: values.filter((value) => value > 0).length,
    noBestTradePnlSol: [...values].sort((a, b) => b - a).slice(1).reduce((total, value) => total + value, 0),
  };
});

const output = {
  generatedAt: new Date().toISOString(),
  method: 'Replays the exact external swap inputs recorded during each valid 0.5 SOL paper trade, changes only our size, and exits at the baseline bot exit time.',
  limitation: 'Diagnostic capacity curve, not a new strategy backtest. Larger positions can alter other traders’ behavior, and size-specific TP/SL timing requires longer paths than the baseline recorder currently retains.',
  validClosedTrades: validExits.length,
  reconstructedTrades: rows.length,
  maximumBaselineReplayErrorSol: Math.max(0, ...rows.map((row) => Math.abs(row.baselineReplayErrorSol))),
  summary,
  rows,
};
await fs.mkdir(path.resolve('reports'), { recursive: true });
await fs.writeFile(path.resolve('reports', 'size-sweep-latest.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  method: output.method,
  limitation: output.limitation,
  validClosedTrades: output.validClosedTrades,
  reconstructedTrades: output.reconstructedTrades,
  maximumBaselineReplayErrorSol: output.maximumBaselineReplayErrorSol,
  summary,
}, null, 2));
