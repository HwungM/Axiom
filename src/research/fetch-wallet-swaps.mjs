import fs from 'node:fs';
import path from 'node:path';
import { decodePumpSwapEvents } from '../lib/pump-decoders.mjs';
import { sleep } from '../lib/http.mjs';
import { solanaRpc } from '../lib/solana-rpc.mjs';

const FROZEN_END_MS = Date.parse(process.env.RESEARCH_END_ISO ?? '2026-08-28T15:50:00.000Z');
const FROZEN_START_MS = Date.parse(process.env.RESEARCH_START_ISO ?? '2026-08-21T15:50:00.000Z');
const outputDirectory = path.resolve(process.env.RESEARCH_DATA_DIR ?? 'data/research-v1/wallets');
const concurrency = Number(process.env.RESEARCH_RPC_CONCURRENCY ?? 8);
const wallets = process.argv.slice(2).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);

if (!wallets.length) {
  console.error('Usage: node src/research/fetch-wallet-swaps.mjs <wallet> [wallet ...]');
  process.exitCode = 1;
} else {
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const wallet of wallets) await fetchWallet(wallet);
}

async function fetchWallet(wallet) {
  const outputPath = path.join(outputDirectory, `${wallet}.json`);
  const progressPath = path.join(outputDirectory, `${wallet}.progress.json`);
  const cached = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null;
  if (cached?.complete && cached?.window?.startMs === FROZEN_START_MS && cached?.window?.endMs === FROZEN_END_MS) {
    console.log(JSON.stringify({ wallet, cached: true, signatures: cached.signatures.length, swaps: cached.swaps.length }));
    return;
  }

  const signatures = [];
  let before;
  let reachedStart = false;
  while (!reachedStart) {
    const options = { limit: 1_000, commitment: 'confirmed' };
    if (before) options.before = before;
    const page = await solanaRpc('getSignaturesForAddress', [wallet, options], 5);
    if (!page.length) break;
    for (const signature of page) {
      const eventMs = Number(signature.blockTime) * 1000;
      if (Number.isFinite(eventMs) && eventMs < FROZEN_START_MS) {
        reachedStart = true;
        break;
      }
      if (!Number.isFinite(eventMs) || eventMs > FROZEN_END_MS) continue;
      signatures.push(signature);
    }
    before = page.at(-1)?.signature;
    if (page.length < 1_000) break;
    await sleep(250);
  }

  const progress = fs.existsSync(progressPath)
    ? JSON.parse(fs.readFileSync(progressPath, 'utf8'))
    : { processed: [], swaps: [], errors: [] };
  const processed = new Set(progress.processed ?? []);
  const swaps = progress.swaps ?? [];
  const errors = progress.errors ?? [];
  const pending = signatures
    .map((signature, index) => ({ signature, index }))
    .filter(({ signature }) => !processed.has(signature.signature));
  let completedThisRun = 0;
  for (let offset = 0; offset < pending.length; offset += concurrency) {
    const chunk = pending.slice(offset, offset + concurrency);
    await Promise.all(chunk.map(async ({ signature, index }) => {
    try {
      const transaction = await solanaRpc('getTransaction', [signature.signature, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }], 5);
      const logs = transaction?.meta?.logMessages ?? [];
      const decoded = decodePumpSwapEvents({
        context: { slot: transaction?.slot ?? signature.slot },
        value: { signature: signature.signature, logs },
      }, {
        receivedAtMs: Number(transaction?.blockTime ?? signature.blockTime) * 1000,
        receivedSequence: index,
      }).filter((row) => row.user === wallet);
      for (const row of decoded) swaps.push({
        ...row,
        blockTime: transaction?.blockTime ?? signature.blockTime,
        confirmationStatus: signature.confirmationStatus,
        transactionError: signature.err,
      });
    } catch (error) {
      errors.push({ signature: signature.signature, message: error.message });
    }
      processed.add(signature.signature);
      completedThisRun += 1;
    }));
    if (completedThisRun % 200 < concurrency || offset + concurrency >= pending.length) {
      const checkpoint = { processed: [...processed], swaps, errors };
      fs.writeFileSync(progressPath, `${JSON.stringify(checkpoint)}\n`);
      console.log(JSON.stringify({ wallet, progress: processed.size, total: signatures.length, swaps: swaps.length, errors: errors.length }));
    }
    await sleep(40);
  }

  swaps.sort((a, b) => a.blockTime - b.blockTime || a.slot - b.slot || a.receivedSequence - b.receivedSequence);
  const payload = {
    generatedAt: new Date().toISOString(),
    wallet,
    window: { startMs: FROZEN_START_MS, endMs: FROZEN_END_MS },
    complete: errors.length === 0,
    signatures,
    swaps,
    errors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (errors.length === 0) fs.rmSync(progressPath, { force: true });
  console.log(JSON.stringify({ wallet, outputPath, signatures: signatures.length, swaps: swaps.length, errors: errors.length }));
}
