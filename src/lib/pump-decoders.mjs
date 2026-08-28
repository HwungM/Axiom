import { decode58, encode58 } from './base58.mjs';
import { getJson } from './http.mjs';
import { getConfirmedTransaction } from './solana-rpc.mjs';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL = 'So11111111111111111111111111111111111111112';

const discriminatorKey = (bytes) => Buffer.from(bytes).toString('hex');

export async function createPumpDecoders() {
  const [pumpIdl, ammIdl] = await Promise.all([
    getJson('https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json'),
    getJson('https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json'),
  ]);
  const migrationInstructions = new Map(pumpIdl.instructions
    .filter((instruction) => instruction.name === 'migrate' || instruction.name === 'migrate_v2')
    .map((instruction) => [discriminatorKey(instruction.discriminator), instruction]));
  const buyEvent = ammIdl.events.find((event) => event.name === 'BuyEvent');
  const sellEvent = ammIdl.events.find((event) => event.name === 'SellEvent');
  const buyDiscriminator = discriminatorKey(buyEvent.discriminator);
  const sellDiscriminator = discriminatorKey(sellEvent.discriminator);

  function decodePumpSwapEvents(notification) {
    const rows = [];
    for (const log of notification.value?.logs ?? []) {
      const match = /^Program data: (.+)$/.exec(log);
      if (!match) continue;
      let bytes;
      try { bytes = Buffer.from(match[1], 'base64'); } catch { continue; }
      if (bytes.length < 184) continue;
      const discriminator = bytes.subarray(0, 8).toString('hex');
      if (discriminator !== buyDiscriminator && discriminator !== sellDiscriminator) continue;
      const readUnsigned = (offset) => Number(bytes.readBigUInt64LE(offset));
      const readSigned = (offset) => Number(bytes.readBigInt64LE(offset));
      rows.push({
        signature: notification.value.signature,
        slot: notification.context.slot,
        side: discriminator === buyDiscriminator ? 'buy' : 'sell',
        timestamp: readSigned(8),
        baseAmountRaw: readUnsigned(16),
        baseReserveRaw: readUnsigned(48),
        quoteReserveRaw: readUnsigned(56),
        quoteAmountRaw: readUnsigned(64),
        pool: encode58(bytes.subarray(120, 152)),
        user: encode58(bytes.subarray(152, 184)),
      });
    }
    return rows;
  }

  async function resolveMigration(signature) {
    const transaction = await getConfirmedTransaction(signature);
    const top = transaction?.transaction?.message?.instructions ?? [];
    const inner = (transaction?.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []);
    for (const instruction of [...top, ...inner]) {
      const programId = typeof instruction.programId === 'string'
        ? instruction.programId
        : instruction.programId?.toString?.();
      if (programId !== PUMP_PROGRAM || !instruction.data || !Array.isArray(instruction.accounts)) continue;
      let bytes;
      try { bytes = decode58(instruction.data); } catch { continue; }
      const definition = migrationInstructions.get(bytes.subarray(0, 8).toString('hex'));
      if (!definition) continue;
      const accounts = Object.fromEntries(definition.accounts.map((account, index) => [account.name, instruction.accounts[index]]));
      const mint = accounts.mint ?? accounts.base_mint;
      const quoteMint = accounts.wsol_mint ?? accounts.quote_mint;
      if (!mint || !accounts.pool || quoteMint !== WSOL) continue;
      let coin = null;
      try {
        coin = await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`, { attempts: 3, baseDelayMs: 500 });
      } catch {}
      return {
        signature,
        slot: transaction.slot,
        blockTime: transaction.blockTime,
        instruction: definition.name,
        mint,
        quoteMint,
        pool: accounts.pool,
        name: coin?.name ?? null,
        symbol: coin?.symbol ?? null,
        creator: coin?.creator ?? null,
        tokenCreatedTimestamp: coin?.created_timestamp ?? null,
      };
    }
    return null;
  }

  return { decodePumpSwapEvents, resolveMigration };
}

