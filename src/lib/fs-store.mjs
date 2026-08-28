import fs from 'node:fs/promises';
import path from 'node:path';

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

export async function writeJsonAtomic(filename, value) {
  await ensureParent(filename);
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

