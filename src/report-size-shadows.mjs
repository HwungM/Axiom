import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './lib/fs-store.mjs';

const dataRoot = path.resolve(process.env.DATA_ROOT ?? 'data');
const config = JSON.parse(await fs.readFile(path.resolve(process.env.PAPER_CONFIG ?? 'config/paper.v1.json'), 'utf8'));
const state = await readJson(path.join(dataRoot, 'paper', 'size-shadow-state.json'), null);

if (!state) {
  console.log(JSON.stringify({
    status: 'NOT_STARTED',
    message: 'Size shadows begin collecting after the upgraded monitor receives its first baseline entry.',
  }, null, 2));
  process.exit(0);
}

const minimum = config.shadowComparison?.minimumCompletedTrades ?? 50;
const target = config.shadowComparison?.targetCompletedTrades ?? 100;
const cohorts = Object.values(state.cohorts ?? {})
  .sort((a, b) => a.sizeSol - b.sizeSol)
  .map((cohort) => ({
    sizeSol: cohort.sizeSol,
    completedTrades: cohort.completedTrades,
    openPositions: Object.keys(cohort.openPositions ?? {}).length,
    wins: cohort.wins,
    losses: cohort.losses,
    winRatePct: cohort.completedTrades ? 100 * cohort.wins / cohort.completedTrades : null,
    realizedPnlSol: cohort.realizedPnlSol,
    averagePnlSol: cohort.completedTrades ? cohort.realizedPnlSol / cohort.completedTrades : null,
    invalidatedTrades: cohort.invalidatedTrades,
    minimumSampleProgressPct: Math.min(100, 100 * cohort.completedTrades / minimum),
    targetSampleProgressPct: Math.min(100, 100 * cohort.completedTrades / target),
  }));

console.log(JSON.stringify({
  status: cohorts.every((cohort) => cohort.completedTrades >= target)
    ? 'TARGET_REACHED'
    : cohorts.every((cohort) => cohort.completedTrades >= minimum) ? 'MINIMUM_REACHED' : 'COLLECTING',
  methodology: 'Each cohort enters only when the frozen 0.5 SOL baseline enters, uses the same decision-time pool state and external swaps, then exits independently at its own TP, SL or timeout.',
  capitalModel: 'Unconstrained matched cohorts isolate position-size effects. They are not permission to deploy the same sizes from a 3 SOL live wallet.',
  startedAt: new Date(state.startedAt).toISOString(),
  matchedSignals: state.matchedSignals,
  cohorts,
}, null, 2));
