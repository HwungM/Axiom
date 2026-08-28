import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendJsonl, writeJsonAtomic } from './lib/fs-store.mjs';
import { postDiscord } from './lib/discord.mjs';
import { LiveChain } from './lib/live-chain.mjs';
import { captureOwnershipSnapshot } from './lib/ownership-snapshot.mjs';
import {
  corpusCurvePercent,
  curveMarketCapSol,
  curveStateAfterEvent,
  paperBuy,
  paperPnlSol,
  paperSellAgainstExogenousState,
} from './lib/pump-curve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'data', 'ownership-v1');
const CONFIG = JSON.parse(await readFile(path.join(ROOT, 'models', 'ownership-curve-v1.json'), 'utf8'));
const PYTHON = process.env.PYTHON_PATH
  ?? 'C:\\Users\\Hwung\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const SYSTEM_PSEUDO_WALLET = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s';
const SOL_QUOTE = '11111111111111111111111111111111';
const TRANSACTION_COST_SOL = 0.0032;
const ACCOUNTS = [
  { name: 'base-670ms', delayMs: 670 },
  { name: 'shadow-1170ms', delayMs: 1_170 },
];

if (!process.env.OWNERSHIP_RPC_URL?.trim()) {
  throw new Error('OWNERSHIP_RPC_URL is not configured. Use a holder-capable RPC endpoint; the engine will not guess ownership features.');
}

class Scorer {
  constructor() {
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = spawn(PYTHON, ['-u', path.join(ROOT, 'src', 'research', 'ownership-scorer.py')], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (data) => console.error(`scorer: ${data.toString().trim()}`));
    this.child.once('error', (error) => this.rejectReady(error));
    this.child.once('exit', (code) => {
      const error = new Error(`Ownership scorer exited with code ${code}`);
      this.rejectReady(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.ready) {
      this.resolveReady(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message);
  }

  async score(features) {
    await this.ready;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, ...features })}\n`);
    });
  }

  stop() { this.child.kill(); }
}

const scorer = new Scorer();
const scorerHealth = await scorer.ready;
const tokens = new Map();
const portfolios = new Map(ACCOUNTS.map((account) => [account.name, {
  ...account,
  bankrollSol: 3,
  realizedPnlSol: 0,
  pending: new Map(),
  positions: new Map(),
  closedTrades: 0,
}]));
let stopping = false;
let received = 0;
let snapshotsComplete = 0;
let snapshotErrors = 0;
let candidates = 0;
let passes = 0;

function tokenState(event) {
  let token = tokens.get(event.mint);
  if (!token) {
    token = {
      mint: event.mint,
      creator: event.creator,
      firstReceivedAtMs: event.receivedAtMs,
      events: [],
      evaluated: false,
      ownership: null,
      lastEvent: null,
    };
    tokens.set(event.mint, token);
    token.snapshotPromise = captureOwnershipSnapshot(event).then(async (snapshot) => {
      token.ownership = snapshot;
      snapshotsComplete += 1;
      await appendJsonl(path.join(DATA, 'ownership-snapshots.jsonl'), snapshot);
      return snapshot;
    }).catch(async (error) => {
      snapshotErrors += 1;
      token.snapshotError = error.message;
      await appendJsonl(path.join(DATA, 'errors.jsonl'), {
        at: new Date().toISOString(), type: 'OWNERSHIP_SNAPSHOT', mint: event.mint, error: error.message,
      });
      return null;
    });
  }
  return token;
}

function eventFeatures(token, event) {
  const now = event.receivedAtMs;
  token.events = token.events.filter((row) => now - row.receivedAtMs < 15_000);
  const state = curveStateAfterEvent(event);
  const marketCapSol = curveMarketCapSol(state);
  const row = {
    receivedAtMs: now,
    isBuy: event.isBuy,
    sol: Number(event.solAmountRaw) / 1e9,
    marketCapSol,
  };
  token.events.push(row);
  const within = (milliseconds) => token.events.filter((item) => now - item.receivedAtMs < milliseconds);
  const two = within(2_000);
  const five = within(5_000);
  const firstFive = five[0];
  return {
    age_seconds: (now - token.firstReceivedAtMs) / 1_000,
    curve_close: corpusCurvePercent(state),
    buys_2s: two.filter((item) => item.isBuy).length,
    buy_sol_5s: five.filter((item) => item.isBuy).reduce((sum, item) => sum + item.sol, 0),
    return_5s: firstFive?.marketCapSol > 0 ? marketCapSol / firstFive.marketCapSol - 1 : null,
    marketCapSol,
  };
}

function baseGate(features) {
  const gate = CONFIG.baseGate;
  return features.age_seconds >= gate.ageSeconds[0]
    && features.age_seconds <= gate.ageSeconds[1]
    && features.curve_close >= gate.curvePct[0]
    && features.curve_close <= gate.curvePct[1]
    && features.buys_2s >= gate.minimumBuys2s
    && features.buy_sol_5s >= gate.minimumBuySol5s
    && features.return_5s != null
    && features.return_5s >= gate.return5s[0]
    && features.return_5s <= gate.return5s[1];
}

async function evaluate(token, event, dynamic) {
  token.evaluated = true;
  candidates += 1;
  const signalAtMs = event.receivedAtMs;
  const ownership = await token.snapshotPromise;
  if (!ownership) {
    await appendJsonl(path.join(DATA, 'decisions.jsonl'), {
      at: new Date().toISOString(), mint: token.mint, decision: 'SKIP_SNAPSHOT_UNAVAILABLE', dynamic,
    });
    return;
  }
  if (ownership.initial_gini == null) {
    await appendJsonl(path.join(DATA, 'decisions.jsonl'), {
      at: new Date().toISOString(), mint: token.mint, decision: 'SKIP_FEATURE_INCOMPLETE', dynamic, ownership,
    });
    return;
  }
  const features = Object.fromEntries(CONFIG.features.map((name) => [name, dynamic[name] ?? ownership[name]]));
  const scoreStartedAtMs = Date.now();
  const result = await scorer.score(features);
  const decisionReadyAtMs = Date.now();
  const decision = {
    at: new Date(decisionReadyAtMs).toISOString(),
    mint: token.mint,
    signalAtMs,
    decisionReadyAtMs,
    featureAcquisitionMs: decisionReadyAtMs - signalAtMs,
    scoringMs: decisionReadyAtMs - scoreStartedAtMs,
    decision: result.passed ? 'PASS' : 'REJECT_MODEL',
    score: result.score,
    threshold: result.threshold,
    features,
    dynamic,
    ownership,
  };
  await appendJsonl(path.join(DATA, 'decisions.jsonl'), decision);
  if (!result.passed) return;
  passes += 1;
  for (const account of portfolios.values()) {
    account.pending.set(token.mint, {
      ...decision,
      targetLandingAtMs: decisionReadyAtMs + account.delayMs,
    });
  }
  await postDiscord('decisionLog', {
    title: 'OQCA paper signal passed',
    description: `${token.mint}\nOwnership score passed; waiting for event-native delayed paper fills.`,
    color: 0x7c5cff,
    fields: [
      { name: 'Score', value: `${result.score.toFixed(4)} / ${result.threshold.toFixed(4)}`, inline: true },
      { name: 'Curve', value: `${dynamic.curve_close.toFixed(1)}%`, inline: true },
      { name: 'Feature latency', value: `${decision.featureAcquisitionMs} ms`, inline: true },
    ],
  }).catch(() => {});
}

async function tryEntry(account, event, state) {
  const pending = account.pending.get(event.mint);
  if (!pending || event.receivedAtMs < pending.targetLandingAtMs) return;
  account.pending.delete(event.mint);
  const required = CONFIG.paperExecution.sizeSol + TRANSACTION_COST_SOL;
  if (account.positions.size >= CONFIG.paperExecution.maxPositions || account.bankrollSol < required) {
    await appendJsonl(path.join(DATA, 'fills.jsonl'), {
      at: new Date().toISOString(), account: account.name, mint: event.mint, side: 'SKIP_CAPACITY',
      bankrollSol: account.bankrollSol, openPositions: account.positions.size,
    });
    return;
  }
  if (state.realTokenRaw <= 0n) return;
  let fill;
  try { fill = paperBuy(state, CONFIG.paperExecution.sizeSol); } catch { return; }
  const position = {
    account: account.name,
    mint: event.mint,
    score: pending.score,
    signalAtMs: pending.signalAtMs,
    decisionReadyAtMs: pending.decisionReadyAtMs,
    targetLandingAtMs: pending.targetLandingAtMs,
    entryReceivedAtMs: event.receivedAtMs,
    entryLatencyFromSignalMs: event.receivedAtMs - pending.signalAtMs,
    entryLatencyFromDecisionMs: event.receivedAtMs - pending.decisionReadyAtMs,
    entrySignature: event.signature,
    entryMarketCapSol: fill.fillMarketCapSol,
    entrySpotMarketCapSol: curveMarketCapSol(state),
    entry: fill,
    lastEvent: event,
  };
  account.bankrollSol -= required;
  account.positions.set(event.mint, position);
  await appendJsonl(path.join(DATA, 'fills.jsonl'), { at: new Date().toISOString(), side: 'BUY', ...serializablePosition(position) });
  setTimeout(() => void closePosition(account, event.mint, 'TIMEOUT').catch(onError), CONFIG.paperExecution.maxHoldSeconds * 1_000).unref();
}

function serializablePosition(position) {
  return {
    ...position,
    entry: {
      ...position.entry,
      spendRaw: position.entry.spendRaw.toString(),
      internalSolRaw: position.entry.internalSolRaw.toString(),
      tokensRaw: position.entry.tokensRaw.toString(),
    },
    lastEvent: undefined,
  };
}

async function closePosition(account, mint, reason, event = null, quotedExit = null) {
  const position = account.positions.get(mint);
  if (!position) return;
  const exitEvent = event ?? position.lastEvent;
  if (!exitEvent) return;
  const state = curveStateAfterEvent(exitEvent);
  let exit;
  try { exit = quotedExit ?? paperSellAgainstExogenousState(state, position.entry); } catch { return; }
  const pnlSol = paperPnlSol(position.entry, exit, TRANSACTION_COST_SOL);
  account.positions.delete(mint);
  account.realizedPnlSol += pnlSol;
  account.bankrollSol += exit.proceedsSol - TRANSACTION_COST_SOL;
  account.closedTrades += 1;
  const closed = {
    at: new Date().toISOString(),
    account: account.name,
    mint,
    reason,
    pnlSol,
    returnPct: pnlSol / (position.entry.spendSol + TRANSACTION_COST_SOL) * 100,
    entryMarketCapSol: position.entryMarketCapSol,
    exitMarketCapSol: exit.fillMarketCapSol,
    signalAtMs: position.signalAtMs,
    entryReceivedAtMs: position.entryReceivedAtMs,
    exitReceivedAtMs: exitEvent.receivedAtMs,
    holdMs: exitEvent.receivedAtMs - position.entryReceivedAtMs,
    entryLatencyFromSignalMs: position.entryLatencyFromSignalMs,
    entryLatencyFromDecisionMs: position.entryLatencyFromDecisionMs,
    entrySignature: position.entrySignature,
    exitSignature: exitEvent.signature,
    bankrollSol: account.bankrollSol,
    realizedPnlSol: account.realizedPnlSol,
  };
  await appendJsonl(path.join(DATA, 'closed-trades.jsonl'), closed);
  if (account.name === 'base-670ms') {
    await postDiscord('pnl', {
      title: `OQCA paper close: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`,
      description: `${mint}\n${reason} · PAPER ONLY`,
      color: pnlSol >= 0 ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Entry MC', value: `${position.entryMarketCapSol.toFixed(2)} SOL`, inline: true },
        { name: 'Exit MC', value: `${exit.fillMarketCapSol.toFixed(2)} SOL`, inline: true },
        { name: 'Return', value: `${closed.returnPct.toFixed(2)}%`, inline: true },
        { name: 'Measured latency', value: `${position.entryLatencyFromSignalMs} ms`, inline: true },
        { name: 'Paper bankroll', value: `${account.bankrollSol.toFixed(4)} SOL`, inline: true },
      ],
    }).catch(() => {});
  }
}

async function managePositions(account, event, state) {
  const position = account.positions.get(event.mint);
  if (!position) return;
  position.lastEvent = event;
  let exit;
  try { exit = paperSellAgainstExogenousState(state, position.entry); } catch { return; }
  const pnlSol = paperPnlSol(position.entry, exit, TRANSACTION_COST_SOL);
  const returnOnCost = pnlSol / (position.entry.spendSol + TRANSACTION_COST_SOL);
  if (returnOnCost >= CONFIG.paperExecution.takeProfit) await closePosition(account, event.mint, 'TAKE_PROFIT', event, exit);
  else if (returnOnCost <= CONFIG.paperExecution.stopLoss) await closePosition(account, event.mint, 'STOP_LOSS', event, exit);
}

async function persistHealth() {
  const health = {
    at: new Date().toISOString(),
    model: scorerHealth,
    receivedEvents: received,
    tokensObserved: tokens.size,
    snapshotsComplete,
    snapshotErrors,
    candidates,
    passes,
    portfolios: Object.fromEntries([...portfolios].map(([name, account]) => [name, {
      bankrollSol: account.bankrollSol,
      realizedPnlSol: account.realizedPnlSol,
      pending: account.pending.size,
      positions: account.positions.size,
      closedTrades: account.closedTrades,
    }])),
  };
  await writeJsonAtomic(path.join(DATA, 'health.json'), health);
}

async function onPumpTrade(event) {
  if (event.user === SYSTEM_PSEUDO_WALLET || (event.quoteMint && event.quoteMint !== SOL_QUOTE)) return;
  if (!event.virtualSolReservesRaw || !event.virtualTokenReservesRaw || !event.realTokenReservesRaw) return;
  received += 1;
  const token = tokenState(event);
  token.lastEvent = event;
  const dynamic = eventFeatures(token, event);
  const state = curveStateAfterEvent(event);
  await appendJsonl(path.join(DATA, 'events.jsonl'), { ...event, dynamic });
  for (const account of portfolios.values()) {
    await managePositions(account, event, state);
    await tryEntry(account, event, state);
  }
  if (!token.evaluated && baseGate(dynamic)) void evaluate(token, event, dynamic).catch(onError);
}

function onError(error) {
  console.error(error?.stack ?? error);
  void appendJsonl(path.join(DATA, 'errors.jsonl'), { at: new Date().toISOString(), type: 'ENGINE', error: error.message });
}

const chain = new LiveChain({
  onPumpTrade,
  onError,
  onHealth: (event) => {
    console.log(JSON.stringify({ ownershipForward: event.type, at: new Date(event.at).toISOString(), endpoint: event.endpoint }));
    if (event.type === 'disconnected') {
      for (const account of portfolios.values()) {
        account.pending.clear();
        for (const position of account.positions.values()) position.invalidatedByDataGap = true;
      }
    }
  },
});

process.on('SIGINT', () => { stopping = true; chain.stop(); scorer.stop(); });
process.on('SIGTERM', () => { stopping = true; chain.stop(); scorer.stop(); });

await chain.start();
await postDiscord('botStatus', {
  title: 'OQCA forward paper online',
  description: 'A separate bonding-curve ownership-quality paper test is collecting exact TradeEvents. No live orders exist in this process.',
  color: 0x45e6b0,
  fields: [
    { name: 'Model', value: CONFIG.version, inline: true },
    { name: 'Accounts', value: ACCOUNTS.map((row) => row.name).join(', '), inline: true },
    { name: 'Starting bankroll', value: '3 SOL each', inline: true },
  ],
}).catch(() => {});
const healthTimer = setInterval(() => void persistHealth().catch(onError), 10_000);
healthTimer.unref();
while (!stopping) await new Promise((resolve) => setTimeout(resolve, 60_000));
