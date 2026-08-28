import fs from 'node:fs/promises';
import path from 'node:path';
import { appendJsonl, readJson, writeJsonAtomic } from './lib/fs-store.mjs';

const dataRoot = path.resolve(process.env.DATA_ROOT ?? 'data');
const config = JSON.parse(await fs.readFile(path.resolve(process.env.PAPER_CONFIG ?? 'config/paper.v4.json'), 'utf8'));
const paperRoot = path.join(dataRoot, config.dataDirectory ?? 'paper');
const stateFile = path.join(paperRoot, 'state.json');
const state = await readJson(stateFile, null);
if (!state) {
  console.log(JSON.stringify({ status: 'NOT_STARTED', message: `No ${config.version} paper state exists yet.` }, null, 2));
  process.exit(0);
}
if (Object.keys(state.openPositions ?? {}).length > 0) throw new Error('Refusing to reconcile while paper positions are open');
const latencyStateFile = path.join(paperRoot, 'latency-account-state.json');
const initialLatencyState = await readJson(latencyStateFile, null);
if (Object.keys(initialLatencyState?.openPositions ?? {}).length > 0) throw new Error('Refusing to reconcile while FAST-170 positions are open');

async function readJsonl(filename) {
  try {
    return (await fs.readFile(filename, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const decisions = await readJsonl(path.join(paperRoot, 'decisions.jsonl'));
const entries = await readJsonl(path.join(paperRoot, 'entries.jsonl'));
const exits = await readJsonl(path.join(paperRoot, 'exits.jsonl'));
const invalidated = await readJsonl(path.join(paperRoot, 'invalidated.jsonl'));
const executionSkips = await readJsonl(path.join(paperRoot, 'execution-skips.jsonl'));
const firstDecisionByPool = new Map();
const duplicateDecisions = [];
for (const decision of decisions) {
  if (firstDecisionByPool.has(decision.pool)) duplicateDecisions.push(decision);
  else firstDecisionByPool.set(decision.pool, decision);
}
const invalidatedIds = new Set(invalidated.map((row) => row.id));
const entryIds = new Set(entries.map((row) => row.id));
const validExits = [];
const excludedExits = [];
for (const exit of exits) {
  const firstDecision = firstDecisionByPool.get(exit.pool);
  if (firstDecision?.decision === 'QUALIFY' && entryIds.has(exit.id) && !invalidatedIds.has(exit.id)) validExits.push(exit);
  else excludedExits.push(exit);
}

const realizedPnlSol = validExits.reduce((total, row) => total + row.pnlSol, 0);
const uniqueDecisions = [...firstDecisionByPool.values()];
state.version = config.version;
state.availableBankrollSol = state.startingBankrollSol + realizedPnlSol;
state.realizedPnlSol = realizedPnlSol;
state.completedTrades = validExits.length;
state.wins = validExits.filter((row) => row.pnlSol > 0).length;
state.losses = validExits.filter((row) => row.pnlSol <= 0).length;
state.decisions = uniqueDecisions.length;
state.entered = new Set(entries.map((row) => row.pool)).size;
state.skipped = uniqueDecisions.filter((row) => row.decision === 'SKIP').length + executionSkips.length;
state.invalidatedTrades = new Set([...invalidatedIds, ...excludedExits.map((row) => row.id)]).size;
state.seenMigrations = Object.fromEntries(uniqueDecisions.map((row) => [row.pool, row.migrationTime]));
state.reconciledAt = Date.now();
state.updatedAt = state.reconciledAt;
state.updatedIso = new Date(state.updatedAt).toISOString();

for (const exit of excludedExits) {
  await appendJsonl(path.join(paperRoot, 'corrections.jsonl'), {
    at: state.reconciledAt,
    type: 'EXCLUDED_EXIT',
    id: exit.id,
    pool: exit.pool,
    pnlSol: exit.pnlSol,
    reason: 'DUPLICATE_MIGRATION_REDECISION',
  });
}
await writeJsonAtomic(stateFile, state);
const latencyState = initialLatencyState;
let latencySummary = { status: 'NOT_STARTED' };
if (latencyState) {
  const latencyEntries = await readJsonl(path.join(paperRoot, 'latency-account-entries.jsonl'));
  const latencyExits = await readJsonl(path.join(paperRoot, 'latency-account-exits.jsonl'));
  const latencyInvalidated = await readJsonl(path.join(paperRoot, 'latency-account-invalidated.jsonl'));
  const latencySkips = await readJsonl(path.join(paperRoot, 'latency-account-skips.jsonl'));
  const validEntryIds = new Set(latencyEntries.map((row) => row.id));
  const invalidEntryIds = new Set(latencyInvalidated.map((row) => row.id));
  const validLatencyExits = latencyExits.filter((row) => validEntryIds.has(row.id) && !invalidEntryIds.has(row.id));
  const latencyPnl = validLatencyExits.reduce((sum, row) => sum + row.pnlSol, 0);
  latencyState.availableBankrollSol = latencyState.startingBankrollSol + latencyPnl;
  latencyState.realizedPnlSol = latencyPnl;
  latencyState.entered = new Set(latencyEntries.map((row) => row.pool)).size;
  latencyState.skipped = latencySkips.length;
  latencyState.completedTrades = validLatencyExits.length;
  latencyState.wins = validLatencyExits.filter((row) => row.pnlSol > 0).length;
  latencyState.losses = validLatencyExits.filter((row) => row.pnlSol <= 0).length;
  latencyState.invalidatedTrades = invalidEntryIds.size;
  latencyState.reconciledAt = Date.now();
  await writeJsonAtomic(latencyStateFile, latencyState);
  latencySummary = {
    account: config.latencyAccount?.name,
    validExits: validLatencyExits.length,
    realizedPnlSol: latencyPnl,
    bankrollSol: latencyState.availableBankrollSol,
    invalidatedTrades: latencyState.invalidatedTrades,
  };
}
console.log(JSON.stringify({
  uniqueDecisions: uniqueDecisions.length,
  duplicateDecisions: duplicateDecisions.length,
  validExits: validExits.length,
  excludedExits: excludedExits.length,
  realizedPnlSol,
  bankrollSol: state.availableBankrollSol,
  invalidatedTrades: state.invalidatedTrades,
  latencyAccount: latencySummary,
}, null, 2));
