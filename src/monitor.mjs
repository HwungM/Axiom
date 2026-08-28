import { captureSnapshot } from './capture-snapshot.mjs';
import { sleep } from './lib/http.mjs';
import { postDiscord } from './lib/discord.mjs';
import { LiveChain } from './lib/live-chain.mjs';
import { PaperEngine } from './paper-engine.mjs';

const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
let stopping = false;

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

console.log(`Forward collector started. Poll interval: ${intervalMs}ms`);
const paper = await PaperEngine.create({
  onError: (error) => {
    console.error(`Paper engine error: ${error?.stack ?? error}`);
    void postDiscord('alerts', {
      title: 'Paper engine error',
      description: String(error?.message ?? error),
      color: 0xff5d73,
    }).catch(() => {});
  },
});
const chain = new LiveChain({
  onMigration: (migration) => paper.onMigration(migration),
  onSwap: (event) => paper.onSwap(event),
  onError: (error) => {
    console.error(`Live chain error: ${error?.stack ?? error}`);
    void postDiscord('alerts', {
      title: 'Live chain error',
      description: String(error?.message ?? error),
      color: 0xff5d73,
    }).catch(() => {});
  },
  onHealth: (event) => {
    console.log(JSON.stringify({ liveChain: event.type, at: new Date(event.at).toISOString() }));
    if (event.type === 'disconnected') {
      void paper.invalidateOpenPositions('SOLANA_WEBSOCKET_DATA_GAP').catch((error) => console.error(error));
    }
  },
});
await chain.start();
await postDiscord('botStatus', {
  title: 'Forward paper engine online',
  description: 'Live Pump migration detection, exact PumpSwap event capture, decision logging and counterfactual paper execution are active.',
  color: 0x45e6b0,
  fields: [
    { name: 'Snapshot interval', value: `${intervalMs}ms`, inline: true },
    { name: 'Strategy', value: paper.summary().version, inline: true },
    { name: 'Paper bankroll', value: `${paper.summary().bankrollSol.toFixed(4)} SOL`, inline: true },
  ],
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
          { name: 'Paper state', value: JSON.stringify(paper.summary()), inline: false },
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
chain.stop();
paper.stop();
await postDiscord('botStatus', {
  title: 'Forward collector stopped',
  description: 'The process exited cleanly and is no longer collecting migrations.',
  color: 0xffc857,
}).catch(() => {});
console.log('Forward collector stopped cleanly.');
