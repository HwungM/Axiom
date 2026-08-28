import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteBuyWithSol, quoteSellTokens } from '../src/lib/pumpswap-quote.mjs';

const audited67State = {
  baseReserveRaw: '189203138900111',
  quoteReserveRaw: '75565184691',
  virtualQuoteReservesRaw: '17584505455',
  baseSupplyRaw: '1000000000000000',
  lpFeeBasisPoints: 20,
  protocolFeeBasisPoints: 5,
  coinCreatorFeeBasisPoints: 0,
  cashbackFeeBasisPoints: 95,
};

test('event-native sell quote exactly reproduces the audited 67 on-chain user output', () => {
  const quote = quoteSellTokens(audited67State, '154879823962');
  assert.equal(quote.internalQuoteRaw, '76189050');
  assert.equal(quote.proceedsRaw, '75274780');
  assert.equal(quote.totalFeeBasisPoints, 120);
});

test('event-native buy quote reproduces the audited 67 fill within event rounding', () => {
  const state = {
    ...audited67State,
    baseReserveRaw: '191426938573151',
    quoteReserveRaw: '74485229760',
  };
  const quote = quoteBuyWithSol(state, 0.940652722);
  assert.equal(quote.internalQuoteRaw, '929498736');
  const delta = BigInt(quote.tokensRaw) - 1913253364686n;
  assert.ok(delta > -1_000n && delta < 1_000n);
});
