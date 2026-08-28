import path from 'node:path';
import { appendJsonl, readJson, writeJsonAtomic } from './lib/fs-store.mjs';
import { getJson, sleep } from './lib/http.mjs';

const DATA_ROOT = path.resolve(process.env.DATA_ROOT ?? 'data');
const WSOL = 'So11111111111111111111111111111111111111112';
const pageCount = Number(process.env.GECKO_PAGES ?? 3);
const pagePauseMs = Number(process.env.GECKO_PAGE_PAUSE_MS ?? 7_000);
const capturedAt = Date.now();

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchNewPumpSwapPools() {
  const pools = new Map();
  for (let page = 1; page <= pageCount; page += 1) {
    const endpoint = `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}&include=base_token,quote_token,dex`;
    const payload = await getJson(endpoint);
    for (const item of payload.data ?? []) {
      if (item.relationships?.dex?.data?.id !== 'pumpswap') continue;
      const mint = item.relationships?.base_token?.data?.id?.replace(/^solana_/, '');
      const quoteMint = item.relationships?.quote_token?.data?.id?.replace(/^solana_/, '');
      if (!mint || mint === WSOL || quoteMint !== WSOL) continue;
      const createdAt = Date.parse(item.attributes.pool_created_at);
      pools.set(item.attributes.address, {
        capturedAt,
        capturedIso: new Date(capturedAt).toISOString(),
        pool: item.attributes.address,
        mint,
        quoteMint,
        poolCreatedAt: createdAt,
        poolCreatedIso: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : null,
        ageSeconds: Number.isFinite(createdAt) ? (capturedAt - createdAt) / 1_000 : null,
        priceSol: finiteNumber(item.attributes.base_token_price_native_currency),
        fdvUsd: finiteNumber(item.attributes.fdv_usd),
        reserveUsd: finiteNumber(item.attributes.reserve_in_usd),
        priceChange: item.attributes.price_change_percentage ?? {},
        transactions: item.attributes.transactions ?? {},
        volumeUsd: item.attributes.volume_usd ?? {},
      });
    }
    if (page < pageCount) await sleep(pagePauseMs);
  }
  return [...pools.values()];
}

async function enrichWithPumpState(pool) {
  try {
    const coin = await getJson(`https://frontend-api-v3.pump.fun/coins/${pool.mint}`, {
      attempts: 3,
      baseDelayMs: 1_000,
    });
    return {
      ...pool,
      coin: {
        name: coin.name ?? null,
        symbol: coin.symbol ?? null,
        creator: coin.creator ?? null,
        createdTimestamp: coin.created_timestamp ?? null,
        lastTradeTimestamp: coin.last_trade_timestamp ?? null,
        marketCapSol: finiteNumber(coin.market_cap),
        usdMarketCap: finiteNumber(coin.usd_market_cap),
        complete: Boolean(coin.complete),
        poolAddress: coin.pool_address ?? null,
        isCashbackCoin: Boolean(coin.is_cashback_coin),
        replyCount: finiteNumber(coin.reply_count) ?? 0,
        canonicalPumpMigration: Boolean(coin.complete && coin.pool_address === pool.pool),
      },
    };
  } catch (error) {
    return { ...pool, coinError: String(error?.message ?? error) };
  }
}

export async function captureSnapshot() {
  const pools = await fetchNewPumpSwapPools();
  const entries = [];
  for (let index = 0; index < pools.length; index += 10) {
    entries.push(...await Promise.all(pools.slice(index, index + 10).map(enrichWithPumpState)));
    if (index + 10 < pools.length) await sleep(300);
  }

  const stateFile = path.join(DATA_ROOT, 'state.json');
  const state = await readJson(stateFile, { firstSeenPools: {} });
  const newPools = [];
  for (const entry of entries) {
    if (!state.firstSeenPools[entry.pool]) {
      state.firstSeenPools[entry.pool] = capturedAt;
      newPools.push(entry);
      await appendJsonl(path.join(DATA_ROOT, 'events', 'first-seen-pools.jsonl'), entry);
      if (entry.coin?.canonicalPumpMigration) {
        await appendJsonl(path.join(DATA_ROOT, 'events', 'canonical-migrations.jsonl'), entry);
      }
    }
  }
  state.lastCaptureAt = capturedAt;
  state.lastCaptureIso = new Date(capturedAt).toISOString();
  await writeJsonAtomic(stateFile, state);

  const snapshot = {
    capturedAt,
    capturedIso: new Date(capturedAt).toISOString(),
    source: 'GeckoTerminal new Solana pools filtered to PumpSwap/WSOL, enriched with Pump public coin state',
    pageCount,
    count: entries.length,
    canonicalCount: entries.filter((entry) => entry.coin?.canonicalPumpMigration).length,
    newPoolCount: newPools.length,
    entries,
  };
  await appendJsonl(path.join(DATA_ROOT, 'snapshots.jsonl'), snapshot);
  return snapshot;
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  const snapshot = await captureSnapshot();
  console.log(JSON.stringify({
    capturedIso: snapshot.capturedIso,
    pools: snapshot.count,
    canonicalMigrations: snapshot.canonicalCount,
    firstSeenThisRun: snapshot.newPoolCount,
  }, null, 2));
}

