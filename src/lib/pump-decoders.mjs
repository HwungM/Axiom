import { decode58 } from './base58.mjs';
import { getJson } from './http.mjs';
import { getConfirmedTransaction } from './solana-rpc.mjs';
import { getPumpAmmProgram } from '@pump-fun/pump-swap-sdk';
import { BorshCoder } from '@coral-xyz/anchor';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL = 'So11111111111111111111111111111111111111112';

const discriminatorKey = (bytes) => Buffer.from(bytes).toString('hex');
const pumpSwapEventCoder = getPumpAmmProgram(null).coder.events;
const number = (value) => value == null ? null : Number(value.toString(10));
const raw = (value) => value == null ? null : value.toString(10);

export function decodePumpSwapEvents(notification, received = {}) {
  const rows = [];
  for (const log of notification.value?.logs ?? []) {
    const match = /^Program data: (.+)$/.exec(log);
    if (!match) continue;
    let decoded;
    try { decoded = pumpSwapEventCoder.decode(match[1]); } catch { continue; }
    if (decoded?.name !== 'buyEvent' && decoded?.name !== 'sellEvent') continue;
    const data = decoded.data;
    const side = decoded.name === 'buyEvent' ? 'buy' : 'sell';
    rows.push({
      signature: notification.value.signature,
      slot: notification.context.slot,
      receivedAtMs: received.receivedAtMs ?? Date.now(),
      receivedSequence: received.receivedSequence ?? null,
      side,
      timestamp: number(data.timestamp),
      baseAmountRaw: raw(side === 'buy' ? data.baseAmountOut : data.baseAmountIn),
      baseReserveRaw: raw(data.poolBaseTokenReserves),
      quoteReserveRaw: raw(data.poolQuoteTokenReserves),
      quoteAmountRaw: raw(side === 'buy' ? data.quoteAmountIn : data.quoteAmountOut),
      quoteReserveDeltaRaw: raw(side === 'buy' ? data.quoteAmountInWithLpFee : data.quoteAmountOutWithoutLpFee),
      userQuoteAmountRaw: raw(side === 'buy' ? data.userQuoteAmountIn : data.userQuoteAmountOut),
      lpFeeBasisPoints: number(data.lpFeeBasisPoints) ?? 0,
      protocolFeeBasisPoints: number(data.protocolFeeBasisPoints) ?? 0,
      coinCreatorFeeBasisPoints: number(data.coinCreatorFeeBasisPoints) ?? 0,
      cashbackFeeBasisPoints: number(data.cashbackFeeBasisPoints) ?? 0,
      virtualQuoteReservesRaw: raw(data.virtualQuoteReserves) ?? '0',
      baseSupplyRaw: raw(data.baseSupply),
      pool: data.pool.toString(),
      user: data.user.toString(),
      coinCreator: data.coinCreator?.toString?.() ?? null,
    });
  }
  return rows;
}

export async function createPumpDecoders() {
  const pumpIdl = await getJson('https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json');
  const pumpEventCoder = new BorshCoder(pumpIdl).events;
  const migrationInstructions = new Map(pumpIdl.instructions
    .filter((instruction) => instruction.name === 'migrate' || instruction.name === 'migrate_v2')
    .map((instruction) => [discriminatorKey(instruction.discriminator), instruction]));
  function decodePumpTradeEvents(notification, received = {}) {
    const rows = [];
    for (const log of notification.value?.logs ?? []) {
      const match = /^Program data: (.+)$/.exec(log);
      if (!match) continue;
      let decoded;
      try { decoded = pumpEventCoder.decode(match[1]); } catch { continue; }
      if (decoded?.name !== 'TradeEvent') continue;
      const data = decoded.data;
      const field = (...names) => names.map((name) => data[name]).find((value) => value != null);
      rows.push({
        signature: notification.value.signature,
        slot: notification.context.slot,
        receivedAtMs: received.receivedAtMs ?? Date.now(),
        receivedSequence: received.receivedSequence ?? null,
        mint: data.mint.toString(),
        user: data.user.toString(),
        creator: data.creator?.toString?.() ?? null,
        quoteMint: field('quoteMint', 'quote_mint')?.toString?.() ?? null,
        isBuy: Boolean(field('isBuy', 'is_buy')),
        timestamp: number(data.timestamp),
        solAmountRaw: raw(field('solAmount', 'sol_amount')),
        quoteAmountRaw: raw(field('quoteAmount', 'quote_amount')),
        tokenAmountRaw: raw(field('tokenAmount', 'token_amount')),
        virtualSolReservesRaw: raw(field('virtualSolReserves', 'virtual_sol_reserves')),
        virtualTokenReservesRaw: raw(field('virtualTokenReserves', 'virtual_token_reserves')),
        realSolReservesRaw: raw(field('realSolReserves', 'real_sol_reserves')),
        realTokenReservesRaw: raw(field('realTokenReserves', 'real_token_reserves')),
        feeBasisPoints: number(field('feeBasisPoints', 'fee_basis_points')) ?? 0,
        creatorFeeBasisPoints: number(field('creatorFeeBasisPoints', 'creator_fee_basis_points')) ?? 0,
        cashbackFeeBasisPoints: number(field('cashbackFeeBasisPoints', 'cashback_fee_basis_points')) ?? 0,
        buybackFeeBasisPoints: number(field('buybackFeeBasisPoints', 'buyback_fee_basis_points')) ?? 0,
        mayhemMode: Boolean(field('mayhemMode', 'mayhem_mode')),
        ixName: field('ixName', 'ix_name') ?? null,
      });
    }
    return rows;
  }

  async function resolveMigration(signature, received = {}) {
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
      const resolvedAtMs = Date.now();
      return {
        signature,
        slot: transaction.slot,
        blockTime: transaction.blockTime,
        migrationLogReceivedAtMs: received.receivedAtMs ?? null,
        migrationLogReceivedSequence: received.receivedSequence ?? null,
        migrationResolvedAtMs: resolvedAtMs,
        migrationResolutionMs: received.receivedAtMs == null ? null : resolvedAtMs - received.receivedAtMs,
        instruction: definition.name,
        mint,
        quoteMint,
        pool: accounts.pool,
        name: null,
        symbol: null,
        creator: null,
        totalSupplyRaw: '1000000000000000',
        solUsd: null,
        tokenCreatedTimestamp: null,
      };
    }
    return null;
  }

  return { decodePumpSwapEvents, decodePumpTradeEvents, resolveMigration };
}
