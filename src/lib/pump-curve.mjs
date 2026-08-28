const LAMPORTS_PER_SOL = 1_000_000_000n;
const TOKEN_SCALE = 1_000_000n;
const BPS = 10_000n;

const integer = (value) => BigInt(value?.toString?.() ?? value);

function feeAdjustedBuyInput(spendRaw, feeBasisPoints, creatorFeeBasisPoints) {
  const fees = BigInt(feeBasisPoints + creatorFeeBasisPoints);
  if (spendRaw <= 1n) return 0n;
  return (spendRaw - 1n) * BPS / (BPS + fees);
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function feeAmount(amount, basisPoints) {
  return ceilDiv(amount * BigInt(basisPoints), BPS);
}

export function curveStateAfterEvent(event) {
  return {
    virtualSolRaw: integer(event.virtualSolReservesRaw),
    virtualTokenRaw: integer(event.virtualTokenReservesRaw),
    realSolRaw: integer(event.realSolReservesRaw),
    realTokenRaw: integer(event.realTokenReservesRaw),
    feeBasisPoints: Number(event.feeBasisPoints ?? 0),
    creatorFeeBasisPoints: Number(event.creatorFeeBasisPoints ?? 0),
    supplyRaw: event.mayhemMode ? 2_000_000_000_000_000n : 1_000_000_000_000_000n,
  };
}

export function corpusCurvePercent(state) {
  // This intentionally matches the July-2026 corpus field rather than the
  // protocol's token-depletion percentage: curve_pct = virtual SOL / 85 SOL.
  return Number(state.virtualSolRaw) / 85_000_000_000 * 100;
}

export function curveMarketCapSol(state) {
  if (state.virtualTokenRaw <= 0n) return null;
  return Number(state.virtualSolRaw * state.supplyRaw / state.virtualTokenRaw) / Number(LAMPORTS_PER_SOL);
}

export function paperBuy(state, spendSol) {
  const spendRaw = BigInt(Math.floor(Number(spendSol) * Number(LAMPORTS_PER_SOL)));
  const internalSolRaw = feeAdjustedBuyInput(spendRaw, state.feeBasisPoints, state.creatorFeeBasisPoints);
  if (internalSolRaw <= 0n) throw new Error('Paper buy has no curve input after fees');
  let tokensRaw = internalSolRaw * state.virtualTokenRaw / (state.virtualSolRaw + internalSolRaw);
  if (tokensRaw > state.realTokenRaw) tokensRaw = state.realTokenRaw;
  if (tokensRaw <= 0n) throw new Error('Paper buy produced no tokens');
  return {
    spendRaw,
    spendSol: Number(spendRaw) / Number(LAMPORTS_PER_SOL),
    internalSolRaw,
    tokensRaw,
    fillMarketCapSol: Number(spendRaw) / (Number(tokensRaw) / Number(TOKEN_SCALE))
      * (Number(state.supplyRaw) / Number(TOKEN_SCALE)),
  };
}

export function paperSellAgainstExogenousState(state, entry) {
  const virtualSolRaw = state.virtualSolRaw + entry.internalSolRaw;
  const virtualTokenRaw = state.virtualTokenRaw - entry.tokensRaw;
  if (virtualSolRaw <= 0n || virtualTokenRaw <= 0n) throw new Error('Counterfactual curve state is invalid');
  const rawOutput = entry.tokensRaw * virtualSolRaw / (virtualTokenRaw + entry.tokensRaw);
  const protocolFee = feeAmount(rawOutput, state.feeBasisPoints);
  const creatorFee = feeAmount(rawOutput, state.creatorFeeBasisPoints);
  const proceedsRaw = rawOutput - protocolFee - creatorFee;
  return {
    proceedsRaw,
    proceedsSol: Number(proceedsRaw) / Number(LAMPORTS_PER_SOL),
    rawOutput,
    fillMarketCapSol: Number(proceedsRaw) / (Number(entry.tokensRaw) / Number(TOKEN_SCALE))
      * (Number(state.supplyRaw) / Number(TOKEN_SCALE)),
  };
}

export function paperPnlSol(entry, exit, transactionCostSol) {
  return exit.proceedsSol - entry.spendSol - 2 * Number(transactionCostSol);
}

