import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const config = JSON.parse(await fs.readFile(new URL('../config/paper.v0.json', import.meta.url), 'utf8'));
const livePaperConfig = JSON.parse(await fs.readFile(new URL('../config/paper.v1.json', import.meta.url), 'utf8'));

test('paper v0 preserves the agreed bankroll and risk experiment', () => {
  assert.equal(config.startingBankrollSol, 3);
  assert.equal(config.positionSizeSol, 0.5);
  assert.equal(config.takeProfitPct, 50);
  assert.equal(config.stopLossPct, 20);
  assert.equal(config.timeoutSeconds, 300);
});

test('paper v1 is enabled with the frozen first forward selector', () => {
  assert.equal(livePaperConfig.enabled, true);
  assert.equal(livePaperConfig.frozen, true);
  assert.equal(livePaperConfig.startingBankrollSol, 3);
  assert.equal(livePaperConfig.positionSizeSol, 0.5);
  assert.equal(livePaperConfig.observationWindowSeconds, 5);
  assert.equal(livePaperConfig.selector.maximumLargestOpeningSwapSol, 10);
  assert.equal(livePaperConfig.execution.chargeOwnPoolImpact, true);
});

test('paper v1 preserves the 0.5 SOL baseline and declares matched size shadows', () => {
  assert.equal(livePaperConfig.positionSizeSol, 0.5);
  assert.deepEqual(livePaperConfig.shadowPositionSizesSol, [1, 1.5, 2]);
  assert.equal(livePaperConfig.shadowComparison.minimumCompletedTrades, 50);
  assert.equal(livePaperConfig.shadowComparison.targetCompletedTrades, 100);
  assert.equal(livePaperConfig.shadowComparison.mode, 'matched-signals-unconstrained-capital');
});

test('paper v0 does not invent an unfinished selection rule', () => {
  assert.equal(config.frozen, true);
  assert.equal(config.selector.canonicalPumpMigration, true);
  assert.equal(config.selector.maximumLargestOpeningSwapSol, null);
  assert.equal(config.selector.minimumIndependentBuyers, null);
  assert.equal(config.selector.minimumNetOpeningFlowSol, null);
});
