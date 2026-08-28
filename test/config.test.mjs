import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const config = JSON.parse(await fs.readFile(new URL('../config/paper.v0.json', import.meta.url), 'utf8'));
const legacyPaperConfig = JSON.parse(await fs.readFile(new URL('../config/paper.v1.json', import.meta.url), 'utf8'));
const supersededPaperConfig = JSON.parse(await fs.readFile(new URL('../config/paper.v2.json', import.meta.url), 'utf8'));
const supersededPaperV3 = JSON.parse(await fs.readFile(new URL('../config/paper.v3.json', import.meta.url), 'utf8'));
const livePaperConfig = JSON.parse(await fs.readFile(new URL('../config/paper.v4.json', import.meta.url), 'utf8'));

test('paper v0 preserves the agreed bankroll and risk experiment', () => {
  assert.equal(config.startingBankrollSol, 3);
  assert.equal(config.positionSizeSol, 0.5);
  assert.equal(config.takeProfitPct, 50);
  assert.equal(config.stopLossPct, 20);
  assert.equal(config.timeoutSeconds, 300);
});

test('paper v4 is enabled with the frozen first forward selector', () => {
  assert.equal(livePaperConfig.enabled, true);
  assert.equal(livePaperConfig.frozen, true);
  assert.equal(livePaperConfig.startingBankrollSol, 3);
  assert.equal(livePaperConfig.positionSizeSol, 0.5);
  assert.equal(livePaperConfig.observationWindowSeconds, 1);
  assert.equal(livePaperConfig.selector.maximumLargestOpeningSwapSol, 10);
  assert.equal(livePaperConfig.execution.chargeOwnEntryAndExitImpact, true);
  assert.equal(livePaperConfig.execution.authoritativeEventReserves, true);
  assert.equal(livePaperConfig.execution.dynamicEventFees, true);
  assert.equal(livePaperConfig.execution.simulatedLandingDelayMs, 1000);
  assert.equal(livePaperConfig.execution.simulatedExitLandingDelayMs, 1000);
  assert.equal(livePaperConfig.execution.fastPathDiagnosticMs, 170);
  assert.equal(livePaperConfig.dumpGuard.enabled, true);
  assert.equal(livePaperConfig.dataDirectory, 'paper-v4');
});

test('paper v4 preserves the 0.5 SOL baseline and declares matched size shadows', () => {
  assert.equal(livePaperConfig.positionSizeSol, 0.5);
  assert.deepEqual(livePaperConfig.shadowPositionSizesSol, [1, 1.5, 2]);
  assert.equal(livePaperConfig.shadowComparison.minimumCompletedTrades, 50);
  assert.equal(livePaperConfig.shadowComparison.targetCompletedTrades, 100);
  assert.equal(livePaperConfig.shadowComparison.mode, 'matched-signals-authoritative-state');
});

test('paper v4 declares an independent matched FAST-170 account', () => {
  assert.equal(livePaperConfig.latencyAccount.enabled, true);
  assert.equal(livePaperConfig.latencyAccount.name, 'FAST-170');
  assert.equal(livePaperConfig.latencyAccount.startingBankrollSol, 3);
  assert.equal(livePaperConfig.latencyAccount.positionSizeSol, 0.5);
  assert.equal(livePaperConfig.latencyAccount.entryTargetMs, 170);
  assert.equal(livePaperConfig.latencyAccount.exitTargetMs, 170);
});

test('paper v3.1 is disabled after adding matched latency accounts', () => {
  assert.equal(supersededPaperV3.status, 'SUPERSEDED_BY_V4');
  assert.equal(supersededPaperV3.enabled, false);
});

test('paper v2 is disabled after the latency and competition audit', () => {
  assert.equal(supersededPaperConfig.status, 'SUPERSEDED_BY_V3');
  assert.equal(supersededPaperConfig.enabled, false);
});

test('paper v1 remains identifiable as legacy counterfactual replay', () => {
  assert.equal(legacyPaperConfig.version, 'paper-v1-canonical-migrations');
  assert.equal(legacyPaperConfig.status, 'RETIRED_INVALID_MODEL');
  assert.equal(legacyPaperConfig.enabled, false);
  assert.equal(legacyPaperConfig.execution.replayExternalSwapInputs, true);
});

test('paper v0 does not invent an unfinished selection rule', () => {
  assert.equal(config.frozen, true);
  assert.equal(config.selector.canonicalPumpMigration, true);
  assert.equal(config.selector.maximumLargestOpeningSwapSol, null);
  assert.equal(config.selector.minimumIndependentBuyers, null);
  assert.equal(config.selector.minimumNetOpeningFlowSol, null);
});
