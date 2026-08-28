import { captureSnapshot } from './capture-snapshot.mjs';
import { sleep } from './lib/http.mjs';
import { postDiscord } from './lib/discord.mjs';

const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
let stopping = false;

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

console.log(`Forward collector started. Poll interval: ${intervalMs}ms`);
await postDiscord('botStatus', {
  title: 'Forward collector online',
  description: 'Observation-only mode is active. Candidate capture is enabled; paper entries remain disabled until exact opening-flow fields are implemented.',
  color: 0x45e6b0,
  fields: [{ name: 'Poll interval', value: `${intervalMs}ms`, inline: true }],
}).catch((error) => console.error(`Discord startup notification failed: ${error?.message ?? error}`));

let successfulCaptures = 0;
while (!stopping) {
  const startedAt = Date.now();
  try {
    const snapshot = await captureSnapshot();
    successfulCaptures += 1;
    console.log(JSON.stringify({
      capturedIso: snapshot.capturedIso,
      pools: snapshot.count,
      canonicalMigrations: snapshot.canonicalCount,
      firstSeenThisRun: snapshot.newPoolCount,
    }));
    if (successfulCaptures % 60 === 0) {
      await postDiscord('botStatus', {
        title: 'Collector heartbeat',
        description: 'Forward collection is healthy.',
        color: 0x45e6b0,
        fields: [
          { name: 'Successful captures', value: String(successfulCaptures), inline: true },
          { name: 'Latest pools', value: String(snapshot.count), inline: true },
          { name: 'Canonical migrations', value: String(snapshot.canonicalCount), inline: true },
        ],
      }).catch((error) => console.error(`Discord heartbeat failed: ${error?.message ?? error}`));
    }
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(error?.stack ?? error) }));
    await postDiscord('alerts', {
      title: 'Collector error',
      description: String(error?.message ?? error),
      color: 0xff5d73,
      fields: [{ name: 'Consequence', value: 'This interval may contain a collection gap.' }],
    }).catch(() => {});
  }
  const remaining = Math.max(1_000, intervalMs - (Date.now() - startedAt));
  if (!stopping) await sleep(remaining);
}
await postDiscord('botStatus', {
  title: 'Forward collector stopped',
  description: 'The process exited cleanly and is no longer collecting migrations.',
  color: 0xffc857,
}).catch(() => {});
console.log('Forward collector stopped cleanly.');
