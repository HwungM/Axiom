import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJson, writeJsonAtomic } from '../src/lib/fs-store.mjs';

test('concurrent atomic writes to one state file are serialized without temp-file races', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-atomic-state-'));
  const filename = path.join(directory, 'state.json');
  try {
    await Promise.all(Array.from({ length: 25 }, (_, sequence) => writeJsonAtomic(filename, { sequence })));
    assert.deepEqual(await readJson(filename, null), { sequence: 24 });
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
