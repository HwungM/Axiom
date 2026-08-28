import { captureSnapshot } from './capture-snapshot.mjs';
import { sleep } from './lib/http.mjs';

const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
let stopping = false;

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

console.log(`Forward collector started. Poll interval: ${intervalMs}ms`);
while (!stopping) {
  const startedAt = Date.now();
  try {
    const snapshot = await captureSnapshot();
    console.log(JSON.stringify({
      capturedIso: snapshot.capturedIso,
      pools: snapshot.count,
      canonicalMigrations: snapshot.canonicalCount,
      firstSeenThisRun: snapshot.newPoolCount,
    }));
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(error?.stack ?? error) }));
  }
  const remaining = Math.max(1_000, intervalMs - (Date.now() - startedAt));
  if (!stopping) await sleep(remaining);
}
console.log('Forward collector stopped cleanly.');

