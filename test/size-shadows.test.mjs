import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PaperEngine } from '../src/paper-engine.mjs';

const config = JSON.parse(await fs.readFile(new URL('../config/paper.v1.json', import.meta.url), 'utf8'));

test('matched size shadows enter together and can exit on different swaps', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-size-shadows-'));
  const previousDataRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dataRoot;
  const engine = new PaperEngine(config, { onError: (error) => { throw error; } });

  try {
    await engine.restore();
    const candidate = {
      pool: 'pool-one',
      mint: 'mint-one',
      name: 'Test token',
      symbol: 'TEST',
      migrationTime: Math.floor(Date.now() / 1_000) - 10,
      actualState: { base: 1_000_000, quote: 100 },
    };
    await engine.openPosition(candidate, { quoteReserveSol: 100 });

    assert.equal(engine.state.openPositions['pool-one'].sizeSol, 0.5);
    assert.deepEqual(
      engine.shadowCohorts().map((cohort) => cohort.openPositions['pool-one'].sizeSol),
      [1, 1.5, 2],
    );

    const entryTimestamp = engine.state.openPositions['pool-one'].entryTimestamp;
    await engine.onSwap({
      pool: 'pool-one',
      side: 'buy',
      quoteAmountRaw: 25_100_000_000,
      baseAmountRaw: 0,
      timestamp: entryTimestamp + 1,
      user: 'external-buyer-one',
    });

    assert.equal(engine.state.completedTrades, 1);
    assert.equal(engine.shadowState.cohorts['1'].completedTrades, 1);
    assert.equal(engine.shadowState.cohorts['1.5'].completedTrades, 1);
    assert.equal(engine.shadowState.cohorts['2'].completedTrades, 0);
    assert.ok(engine.shadowState.cohorts['2'].openPositions['pool-one']);

    await engine.onSwap({
      pool: 'pool-one',
      side: 'buy',
      quoteAmountRaw: 1_000_000_000,
      baseAmountRaw: 0,
      timestamp: entryTimestamp + 2,
      user: 'external-buyer-two',
    });

    assert.equal(engine.shadowState.cohorts['2'].completedTrades, 1);
    assert.equal(engine.shadowOpenPositionCount(), 0);
  } finally {
    engine.stop();
    if (previousDataRoot == null) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
