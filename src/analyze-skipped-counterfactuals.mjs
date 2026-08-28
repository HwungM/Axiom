import fs from 'node:fs';
import path from 'node:path';

import {
  fillMarketCap,
  marketStateAfterEvent,
  quoteBuyWithSol,
  quoteSellTokens,
  spotMarketCapSol,
} from './lib/pumpswap-quote.mjs';

const root = path.resolve(process.cwd());
const paperRoot = path.join(root, 'data', 'paper-v4');
const eventsFile = path.join(root, 'data', 'events', 'pumpswap-swaps.jsonl');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'paper.v4.json'), 'utf8'));

const readJsonl = (file) => {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
};

const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const decisions = readJsonl(path.join(paperRoot, 'decisions.jsonl'));
const executionSkips = readJsonl(path.join(paperRoot, 'execution-skips.jsonl'));
const latencySkips = readJsonl(path.join(paperRoot, 'latency-account-skips.jsonl'));
const baselineEntries = readJsonl(path.join(paperRoot, 'entries.jsonl'));
const latencyEntries = readJsonl(path.join(paperRoot, 'latency-account-entries.jsonl'));
const migrationRows = readJsonl(path.join(paperRoot, 'migrations.jsonl'));
const allEvents = readJsonl(eventsFile);
const captureEndMs = Math.max(Date.now(), ...allEvents.map((event) => event.receivedAtMs ?? 0));

const eventsByPool = new Map();
for (const event of allEvents) {
  if (!eventsByPool.has(event.pool)) eventsByPool.set(event.pool, []);
  eventsByPool.get(event.pool).push(event);
}
for (const events of eventsByPool.values()) {
  events.sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.receivedSequence - b.receivedSequence);
}

const enteredPools = new Set(baselineEntries.map((row) => row.pool));
const latencyEnteredPools = new Set(latencyEntries.map((row) => row.pool));
const observedSymbolByPool = new Map([...baselineEntries, ...latencyEntries]
  .filter((row) => row.symbol)
  .map((row) => [row.pool, row.symbol]));
const executionSkipByPool = new Map(executionSkips.map((row) => [row.pool, row]));
const latencySkipByPool = new Map(latencySkips.map((row) => [row.pool, row]));
const migrationByPool = new Map(migrationRows.map((row) => [row.pool, row]));
const decisionByPool = new Map(decisions.map((row) => [row.pool, row]));

const candidates = [];
for (const decision of decisions) {
  const executionSkip = executionSkipByPool.get(decision.pool);
  const latencySkip = latencySkipByPool.get(decision.pool);
  const skippedBySafe = !enteredPools.has(decision.pool);
  const skippedByFast = !latencyEnteredPools.has(decision.pool);
  if (!skippedBySafe && !skippedByFast) continue;
  candidates.push({
    pool: decision.pool,
    mint: decision.mint,
    symbol: executionSkip?.symbol ?? observedSymbolByPool.get(decision.pool)
      ?? decision.symbol ?? migrationByPool.get(decision.pool)?.symbol ?? decision.mint?.slice(0, 8),
    skippedBySafe,
    skippedByFast,
    safeSkipStage: executionSkip ? 'LANDING_GUARD' : 'SELECTOR',
    safeSkipReason: executionSkip?.reason ?? decision.reasons?.join('; ') ?? 'unknown',
    fastSkipStage: latencySkip ? 'LANDING_GUARD' : 'SELECTOR',
    fastSkipReason: latencySkip?.reason ?? decision.reasons?.join('; ') ?? 'unknown',
    signalAtMs: executionSkip?.submittedAtMs ?? latencySkip?.submittedAtMs ?? decision.submittedAtMs ?? decision.at,
    decision,
  });
}

function mark(state, tokensRaw, sizeSol) {
  const quote = quoteSellTokens(state, tokensRaw);
  const pnlSol = quote.proceedsSol - sizeSol - 2 * config.fixedCostPerTransactionSol;
  return {
    proceedsSol: quote.proceedsSol,
    pnlSol,
    returnPct: 100 * pnlSol / sizeSol,
    spotMarketCapSol: spotMarketCapSol(state),
    fillMarketCapSol: fillMarketCap({ quoteSol: quote.proceedsSol, tokensRaw }).sol,
  };
}

function latestAtOrBefore(events, atMs, fallback) {
  let latest = fallback;
  for (const event of events) {
    if (event.receivedAtMs > atMs) break;
    latest = event;
  }
  return latest;
}

function replay(candidate, delayMs) {
  const events = eventsByPool.get(candidate.pool) ?? [];
  const entryTargetAtMs = candidate.signalAtMs + delayMs;
  const entryEvent = events.find((event) => event.receivedAtMs >= entryTargetAtMs);
  if (!entryEvent) {
    return { status: 'NO_EXECUTABLE_POST_TARGET_EVENT', entryTargetAtMs };
  }

  let state;
  let buy;
  try {
    state = marketStateAfterEvent(entryEvent);
    buy = quoteBuyWithSol(state, config.positionSizeSol);
  } catch (error) {
    return { status: 'UNQUOTABLE_ENTRY', entryTargetAtMs, error: error.message };
  }

  const entryMarketCapSol = fillMarketCap({
    quoteSol: buy.spendSol,
    tokensRaw: buy.tokensRaw,
    supplyRaw: state.baseSupplyRaw,
  }).sol;
  const timeoutAtMs = entryEvent.receivedAtMs + config.timeoutSeconds * 1_000;
  const postEntry = events.filter((event) => event.receivedSequence > entryEvent.receivedSequence
    && event.receivedAtMs <= timeoutAtMs);
  let trigger = null;
  let maximumReturnPct = mark(state, buy.tokensRaw, config.positionSizeSol).returnPct;
  let lastEvent = entryEvent;

  for (const event of postEntry) {
    state = marketStateAfterEvent(event);
    lastEvent = event;
    const current = mark(state, buy.tokensRaw, config.positionSizeSol);
    maximumReturnPct = Math.max(maximumReturnPct, current.returnPct);
    if (current.returnPct >= config.takeProfitPct) {
      trigger = { atMs: event.receivedAtMs, reason: 'TAKE_PROFIT', mark: current };
      break;
    }
    if (current.returnPct <= -config.stopLossPct) {
      trigger = { atMs: event.receivedAtMs, reason: 'STOP_LOSS', mark: current };
      break;
    }
  }

  if (!trigger) {
    if (captureEndMs < timeoutAtMs + delayMs) {
      return {
        status: 'INCOMPLETE_FORWARD_WINDOW',
        entryAtMs: entryEvent.receivedAtMs,
        entryDelayMs: entryEvent.receivedAtMs - candidate.signalAtMs,
        entryMarketCapSol: round(entryMarketCapSol, 3),
        maximumReturnPct: round(maximumReturnPct, 3),
      };
    }
    const timeoutStateEvent = latestAtOrBefore(events, timeoutAtMs, lastEvent);
    state = marketStateAfterEvent(timeoutStateEvent);
    trigger = {
      atMs: timeoutAtMs,
      reason: 'TIMEOUT',
      mark: mark(state, buy.tokensRaw, config.positionSizeSol),
    };
  }

  const exitTargetAtMs = trigger.atMs + delayMs;
  if (captureEndMs < exitTargetAtMs) {
    return {
      status: 'INCOMPLETE_EXIT_WINDOW',
      entryAtMs: entryEvent.receivedAtMs,
      entryDelayMs: entryEvent.receivedAtMs - candidate.signalAtMs,
      entryMarketCapSol: round(entryMarketCapSol, 3),
      triggerReason: trigger.reason,
      triggerReturnPct: round(trigger.mark.returnPct, 3),
      maximumReturnPct: round(maximumReturnPct, 3),
    };
  }

  const exitStateEvent = latestAtOrBefore(events, exitTargetAtMs, lastEvent);
  const exitState = marketStateAfterEvent(exitStateEvent);
  const exit = mark(exitState, buy.tokensRaw, config.positionSizeSol);
  return {
    status: 'CLOSED',
    entryAtMs: entryEvent.receivedAtMs,
    entryDelayMs: entryEvent.receivedAtMs - candidate.signalAtMs,
    entryMarketCapSol: round(entryMarketCapSol, 3),
    triggerReason: trigger.reason,
    triggerReturnPct: round(trigger.mark.returnPct, 3),
    exitAtMs: exitTargetAtMs,
    exitMarketCapSol: round(exit.fillMarketCapSol, 3),
    pnlSol: round(exit.pnlSol),
    returnPct: round(exit.returnPct, 3),
    maximumReturnPct: round(maximumReturnPct, 3),
  };
}

const rows = candidates.map((candidate) => ({
  symbol: candidate.symbol,
  pool: candidate.pool,
  skippedBySafe: candidate.skippedBySafe,
  skippedByFast: candidate.skippedByFast,
  safeSkipStage: candidate.safeSkipStage,
  safeSkipReason: candidate.safeSkipReason,
  fastSkipStage: candidate.fastSkipStage,
  fastSkipReason: candidate.fastSkipReason,
  fast170: candidate.skippedByFast ? replay(candidate, config.latencyAccount.entryTargetMs) : { status: 'ACTUALLY_ENTERED' },
  safe1000: candidate.skippedBySafe ? replay(candidate, config.execution.simulatedLandingDelayMs) : { status: 'ACTUALLY_ENTERED' },
}));

function summarize(key) {
  const applicable = rows.filter((row) => key === 'fast170' ? row.skippedByFast : row.skippedBySafe);
  const closed = applicable.filter((row) => row[key].status === 'CLOSED');
  const wins = closed.filter((row) => row[key].pnlSol > 0);
  const statusCounts = {};
  for (const row of applicable) statusCounts[row[key].status] = (statusCounts[row[key].status] ?? 0) + 1;
  return {
    skippedCandidates: applicable.length,
    honestlyReplayableAndClosed: closed.length,
    counterfactualWins: wins.length,
    counterfactualLosses: closed.length - wins.length,
    totalPnlSol: round(closed.reduce((sum, row) => sum + row[key].pnlSol, 0)),
    wins: wins.map((row) => ({
      symbol: row.symbol,
      skipStage: key === 'fast170' ? row.fastSkipStage : row.safeSkipStage,
      skipReason: key === 'fast170' ? row.fastSkipReason : row.safeSkipReason,
      pnlSol: row[key].pnlSol,
      returnPct: row[key].returnPct,
      entryDelayMs: row[key].entryDelayMs,
      triggerReason: row[key].triggerReason,
    })),
    notClosed: applicable.length - closed.length,
    statusCounts,
  };
}

console.log(JSON.stringify({
  methodology: 'Independent counterfactual 0.5 SOL trades. Entry uses the first authoritative pool event observed after the account latency target. Quotes use event-native reserves and fees plus own price impact and fixed costs. TP, SL, timeout and exit latency match paper-v4. This is diagnostic replay, not executable PnL.',
  capturedThrough: new Date(captureEndMs).toISOString(),
  fast170: summarize('fast170'),
  safe1000: summarize('safe1000'),
  replayedRows: rows.filter((row) => row.fast170.status === 'CLOSED' || row.safe1000.status === 'CLOSED'),
}, null, 2));
