import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const atomicWriteQueues = new Map();

export async function ensureParent(filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
}

export async function appendJsonl(filename, value) {
  await ensureParent(filename);
  await fs.appendFile(filename, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function readJson(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function writeJsonAtomic(filename, value) {
  const snapshot = `${JSON.stringify(value, null, 2)}\n`;
  const previous = atomicWriteQueues.get(filename) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await ensureParent(filename);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, snapshot, 'utf8');
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  });
  atomicWriteQueues.set(filename, operation);
  void operation.finally(() => {
    if (atomicWriteQueues.get(filename) === operation) atomicWriteQueues.delete(filename);
  }).catch(() => {});
  return operation;
}
