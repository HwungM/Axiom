import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './lib/fs-store.mjs';

const dataRoot = path.resolve(process.env.DATA_ROOT ?? 'data');
const config = JSON.parse(await fs.readFile(path.resolve(process.env.PAPER_CONFIG ?? 'config/paper.v4.json'), 'utf8'));
const paperRoot = path.join(dataRoot, config.dataDirectory ?? 'paper');
const safe = await readJson(path.join(paperRoot, 'state.json'), null);
const fast = await readJson(path.join(paperRoot, 'latency-account-state.json'), null);

if (!safe || !fast) {
  console.log(JSON.stringify({ status: 'NOT_STARTED', message: 'Matched latency accounts have not started.' }, null, 2));
  process.exit(0);
}

const account = (name, delayMs, state) => ({
  name,
  targetEntryExitDelayMs: delayMs,
  bankrollSol: state.availableBankrollSol,
  realizedPnlSol: state.realizedPnlSol,
  completedTrades: state.completedTrades,
  wins: state.wins,
  losses: state.losses,
  openPositions: Object.keys(state.openPositions ?? {}).length,
  entered: state.entered,
  skipped: state.skipped,
});

console.log(JSON.stringify({
  status: 'COLLECTING',
  version: config.version,
  warning: 'Target latency is compared with actual observable delay on every fill; a 170ms target is not assumed to have landed when authoritative data arrived later.',
  matchedQualifiedSignals: fast.matchedSignals,
  accounts: [
    account(config.latencyAccount.name, config.latencyAccount.entryTargetMs, fast),
    account('SAFE-1000', config.execution.simulatedLandingDelayMs, safe),
  ],
}, null, 2));
