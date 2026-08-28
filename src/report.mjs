import fs from 'node:fs/promises';
import path from 'node:path';
import { postDiscord } from './lib/discord.mjs';

const dataRoot = path.resolve(process.env.DATA_ROOT ?? 'data');

async function readJsonl(filename) {
  try {
    return (await fs.readFile(filename, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const firstSeen = await readJsonl(path.join(dataRoot, 'events', 'first-seen-pools.jsonl'));
const canonical = await readJsonl(path.join(dataRoot, 'events', 'canonical-migrations.jsonl'));
const snapshots = await readJsonl(path.join(dataRoot, 'snapshots.jsonl'));

const report = {
  generatedAt: new Date().toISOString(),
  snapshots: snapshots.length,
  uniqueFirstSeenPools: firstSeen.length,
  canonicalPumpMigrations: canonical.length,
  firstCapture: snapshots.at(0)?.capturedIso ?? null,
  latestCapture: snapshots.at(-1)?.capturedIso ?? null,
  note: 'Observation corpus only. Paper PnL remains disabled until exact on-chain opening-flow and executable fill states are recorded.',
};
console.log(JSON.stringify(report, null, 2));

if (process.argv.includes('--discord')) {
  await postDiscord('dailyReports', {
    title: 'Forward research report',
    description: report.note,
    color: 0x7c5cff,
    fields: [
      { name: 'Snapshots', value: String(report.snapshots), inline: true },
      { name: 'Unique pools', value: String(report.uniqueFirstSeenPools), inline: true },
      { name: 'Canonical migrations', value: String(report.canonicalPumpMigrations), inline: true },
      { name: 'Coverage', value: `${report.firstCapture ?? '—'} → ${report.latestCapture ?? '—'}` },
    ],
  });
  console.log('Daily report delivered to Discord.');
}
