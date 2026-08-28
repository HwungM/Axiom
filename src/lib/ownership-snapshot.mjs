import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PUMP_PROGRAM } from './pump-decoders.mjs';
import { solanaRpcAt } from './solana-rpc.mjs';

const PUMP = new PublicKey(PUMP_PROGRAM);

function gini(values) {
  if (values.length < 2) return null;
  const sorted = values.map(Number).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  const weighted = sorted.reduce((sum, value, index) => sum + (index + 1) * value, 0);
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

function percentage(amounts, supplyRaw, count) {
  const selected = amounts.slice(0, count).reduce((sum, amount) => sum + amount, 0n);
  return Number(selected * 10_000_000n / supplyRaw) / 100_000;
}

function curveTokenAccounts(mint) {
  const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP);
  return new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
    getAssociatedTokenAddressSync(mint, bondingCurve, true, programId, ASSOCIATED_TOKEN_PROGRAM_ID).toString()));
}

export async function captureOwnershipSnapshot(event) {
  const startedAtMs = Date.now();
  const mint = new PublicKey(event.mint);
  const curveAccounts = curveTokenAccounts(mint);
  const endpoint = process.env.OWNERSHIP_RPC_URL?.trim();
  if (!endpoint) throw new Error('OWNERSHIP_RPC_URL is required for holder snapshots');
  const largestResult = await solanaRpcAt(endpoint, 'getTokenLargestAccounts', [event.mint, { commitment: 'confirmed' }]);
  const supplyRaw = event.mayhemMode ? 2_000_000_000_000_000n : 1_000_000_000_000_000n;
  const allLargest = (largestResult?.value ?? []).filter((row) => BigInt(row.amount) > 0n);
  const humanBalances = allLargest
    .filter((row) => !curveAccounts.has(row.address))
    .map((row) => BigInt(row.amount))
    .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
  const creatorAccounts = event.creator
    ? new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      getAssociatedTokenAddressSync(mint, new PublicKey(event.creator), false, programId, ASSOCIATED_TOKEN_PROGRAM_ID).toString()))
    : new Set();
  const creatorBalanceRaw = allLargest
    .filter((row) => creatorAccounts.has(row.address))
    .reduce((sum, row) => sum + BigInt(row.amount), 0n);
  return {
    capturedAtMs: Date.now(),
    snapshotLatencyMs: Date.now() - startedAtMs,
    mint: event.mint,
    creator: event.creator,
    supplyRaw: supplyRaw.toString(),
    initial_holder_count: allLargest.length,
    initial_top1_pct_corrected: percentage(humanBalances, supplyRaw, 1),
    initial_top5_pct_corrected: percentage(humanBalances, supplyRaw, 5),
    initial_top10_pct_corrected: percentage(humanBalances, supplyRaw, 10),
    dev_buy_pct_corrected: Number(creatorBalanceRaw * 10_000_000n / supplyRaw) / 100_000,
    initial_gini: gini(humanBalances),
    largestAccountsReturned: allLargest.length,
    humanAccountsReturned: humanBalances.length,
    curveAccountExcluded: allLargest.some((row) => curveAccounts.has(row.address)),
  };
}
