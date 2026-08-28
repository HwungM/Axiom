import assert from 'node:assert/strict';
import test from 'node:test';
import {
  corpusCurvePercent,
  curveMarketCapSol,
  paperBuy,
  paperPnlSol,
  paperSellAgainstExogenousState,
} from '../src/lib/pump-curve.mjs';

const state = {
  virtualSolRaw: 42_500_000_000n,
  virtualTokenRaw: 757_589_000_000_000n,
  realSolRaw: 12_500_000_000n,
  realTokenRaw: 477_689_000_000_000n,
  feeBasisPoints: 95,
  creatorFeeBasisPoints: 5,
  supplyRaw: 1_000_000_000_000_000n,
};

test('corpus curve percentage and market cap match the July feature definitions', () => {
  assert.equal(corpusCurvePercent(state), 50);
  assert.ok(Math.abs(curveMarketCapSol(state) - 56.098) < 0.01);
});

test('a round trip with no external flow loses fees and transaction overhead', () => {
  const entry = paperBuy(state, 0.5);
  const exit = paperSellAgainstExogenousState(state, entry);
  const pnl = paperPnlSol(entry, exit, 0.0032);
  assert.ok(entry.tokensRaw > 0n);
  assert.ok(pnl < -0.01 && pnl > -0.03);
});

