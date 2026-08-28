import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PaperEngine } from '../src/paper-engine.mjs';

const config = JSON.parse(await fs.readFile(new URL('../config/paper.v3.json', import.meta.url), 'utf8'));

test('authoritative baseline and size shadows enter the identical confirmed state', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-size-shadows-v2-'));
  const previousDataRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dataRoot;
  const engine = new PaperEngine(config);
  engine.solUsd = 100;
  engine.state = {
    version: config.version, startingBankrollSol: 3, availableBankrollSol: 3, realizedPnlSol: 0,
    openPositions: {}, completedTrades: 0, wins: 0, losses: 0, decisions: 1, entered: 0, skipped: 0,
    invalidatedTrades: 0, seenMigrations: {},
  };
  engine.shadowState = {
    version: `${config.version}-size-shadows-v1`, startedAt: Date.now(), baselineSizeSol: 0.5, matchedSignals: 0,
    cohorts: Object.fromEntries(engine.shadowSizes.map((sizeSol) => [String(sizeSol), {
      sizeSol, realizedPnlSol: 0, completedTrades: 0, wins: 0, losses: 0, invalidatedTrades: 0, openPositions: {},
    }])),
  };
  const state = {
    baseReserveRaw: '190000000000000', quoteReserveRaw: '75000000000', virtualQuoteReservesRaw: '17500000000',
    baseSupplyRaw: '1000000000000000', lpFeeBasisPoints: 20, protocolFeeBasisPoints: 5,
    coinCreatorFeeBasisPoints: 0, cashbackFeeBasisPoints: 95,
    sourceSlot: 10, sourceSignature: 'prior-swap', sourceTimestamp: 100, sourceReceivedAtMs: 10_000, sourceReceivedSequence: 5,
  };
  const candidate = {
    pool: 'pool-one', mint: 'mint-one', name: 'Test token', symbol: 'TEST', actualState: state,
    migrationTime: 9, migrationLogReceivedAtMs: 9_100, migrationResolvedAtMs: 9_200, migrationResolutionMs: 100,
    decidedAtMs: 8_500, submittedAtMs: 8_500, fastPathNotBeforeMs: 8_670, landingNotBeforeMs: 9_500,
    decisionReceivedSequence: 4, events: [], currentDrawdownPct: 0,
    totalSupplyRaw: 1_000_000_000_000_000, solUsd: 100,
  };
  const event = {
    pool: 'pool-one', timestamp: 100, receivedAtMs: 10_000, receivedSequence: 5, slot: 10,
    signature: 'prior-swap', side: 'buy', user: 'buyer-one', userQuoteAmountRaw: '200000000',
  };
  candidate.events.push(event);
  engine.candidates.set(candidate.pool, candidate);

  try {
    await engine.executeCandidate(candidate, event);
    const baseline = engine.state.openPositions['pool-one'];
    assert.equal(baseline.sizeSol, 0.5);
    assert.equal(baseline.entryReceivedSequence, 5);
    assert.ok(baseline.entryMarketCapUsd > 0);
    assert.equal(baseline.competitionBeforeEntry.observedBuys, 1);
    assert.equal(baseline.competitionBeforeEntry.buySol, 0.2);
    assert.equal(baseline.fastPathDiagnostic.observedDelayMs, 1_500);
    assert.deepEqual(engine.shadowCohorts().map((cohort) => cohort.openPositions['pool-one'].sizeSol), [1, 1.5, 2]);
    assert.deepEqual(engine.shadowCohorts().map((cohort) => cohort.openPositions['pool-one'].entryReceivedSequence), [5, 5, 5]);
    assert.equal(engine.shadowState.matchedSignals, 1);

    baseline.marketState = {
      ...baseline.marketState,
      quoteReserveRaw: '200000000000',
      sourceTimestamp: 101,
      sourceReceivedAtMs: 11_000,
      sourceReceivedSequence: 6,
    };
    await engine.evaluate(baseline, 11_000, 'swap');
    assert.ok(baseline.pendingExit);
    assert.equal(baseline.pendingExit.landingTargetAtMs, 12_000);
    assert.ok(engine.state.openPositions['pool-one']);
    await engine.finalizeExit('pool-one', baseline.id);
    assert.equal(engine.state.openPositions['pool-one'], undefined);
  } finally {
    if (previousDataRoot == null) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test('dump guard detects one-second migration sell pressure', () => {
  const engine = new PaperEngine(config);
  const atMs = 10_000;
  const metrics = engine.dumpMetrics({
    events: [
      { side: 'buy', receivedAtMs: 9_500, userQuoteAmountRaw: '100000000' },
      { side: 'sell', receivedAtMs: 9_700, userQuoteAmountRaw: '600000000' },
    ],
    currentDrawdownPct: 25,
    peakSpotMarketCapSol: 500,
    currentSpotMarketCapSol: 375,
  }, atMs);

  assert.equal(metrics.buySol, 0.1);
  assert.equal(metrics.sellSol, 0.6);
  assert.ok(metrics.reasons.length >= 1);
});

test('candidate observation calculates spot market cap without shadowing the quote helper', () => {
  const engine = new PaperEngine(config);
  const candidate = {
    migrationTime: 100,
    totalSupplyRaw: '1000000000000000',
    events: [], droppedEvents: 0, buyers: new Set(), openingBuysSol: 0, openingSellsSol: 0,
    largestOpeningSwapSol: 0, peakSpotMarketCapSol: null, currentSpotMarketCapSol: null,
  };
  engine.observeCandidate(candidate, {
    side: 'buy', timestamp: 100, receivedAtMs: 100_500, receivedSequence: 1,
    signature: 'observation', slot: 1, pool: 'pool', user: 'buyer',
    baseAmountRaw: '1000000000', baseReserveRaw: '190000000000000',
    quoteReserveRaw: '75000000000', quoteReserveDeltaRaw: '100000000',
    userQuoteAmountRaw: '101000000', virtualQuoteReservesRaw: '17500000000',
    baseSupplyRaw: '1000000000000000', lpFeeBasisPoints: 20, protocolFeeBasisPoints: 5,
    coinCreatorFeeBasisPoints: 0, cashbackFeeBasisPoints: 95,
  });

  assert.ok(candidate.currentSpotMarketCapSol > 0);
  assert.equal(candidate.peakSpotMarketCapSol, candidate.currentSpotMarketCapSol);
});
