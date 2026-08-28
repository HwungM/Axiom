import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const config = JSON.parse(await fs.readFile(new URL('../config/paper.v0.json', import.meta.url), 'utf8'));

test('paper v0 preserves the agreed bankroll and risk experiment', () => {
  assert.equal(config.startingBankrollSol, 3);
  assert.equal(config.positionSizeSol, 0.5);
  assert.equal(config.takeProfitPct, 50);
  assert.equal(config.stopLossPct, 20);
  assert.equal(config.timeoutSeconds, 300);
});

test('paper v0 does not invent an unfinished selection rule', () => {
  assert.equal(config.frozen, true);
  assert.equal(config.selector.canonicalPumpMigration, true);
  assert.equal(config.selector.maximumLargestOpeningSwapSol, null);
  assert.equal(config.selector.minimumIndependentBuyers, null);
  assert.equal(config.selector.minimumNetOpeningFlowSol, null);
});

