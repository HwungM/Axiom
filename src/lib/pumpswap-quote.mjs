const BPS_DENOMINATOR = 10_000n;
const BASE_DECIMALS = 1_000_000n;
const QUOTE_DECIMALS = 1_000_000_000n;
const DEFAULT_SUPPLY_RAW = 1_000_000_000_000_000n;

const integer = (value, fallback = 0n) => {
  if (value == null || value === '') return fallback;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value.toString());
};

const ceilDiv = (a, b) => {
  if (b === 0n) throw new Error('Cannot divide by zero');
  return (a + b - 1n) / b;
};

const fee = (amount, basisPoints) => ceilDiv(amount * basisPoints, BPS_DENOMINATOR);

function feeBps(state) {
  return [
    integer(state.lpFeeBasisPoints),
    integer(state.protocolFeeBasisPoints),
    integer(state.coinCreatorFeeBasisPoints),
    integer(state.cashbackFeeBasisPoints),
  ];
}

export function marketStateAfterEvent(event, fallbackSupplyRaw = Number(DEFAULT_SUPPLY_RAW)) {
  const side = event.side;
  const baseAmount = integer(event.baseAmountRaw);
  const quoteDelta = integer(event.quoteReserveDeltaRaw ?? event.quoteAmountRaw);
  const baseReserveBefore = integer(event.baseReserveRaw);
  const quoteReserveBefore = integer(event.quoteReserveRaw);
  return {
    baseReserveRaw: (side === 'buy' ? baseReserveBefore - baseAmount : baseReserveBefore + baseAmount).toString(),
    quoteReserveRaw: (side === 'buy' ? quoteReserveBefore + quoteDelta : quoteReserveBefore - quoteDelta).toString(),
    virtualQuoteReservesRaw: integer(event.virtualQuoteReservesRaw).toString(),
    baseSupplyRaw: integer(event.baseSupplyRaw, integer(fallbackSupplyRaw, DEFAULT_SUPPLY_RAW)).toString(),
    lpFeeBasisPoints: event.lpFeeBasisPoints ?? 0,
    protocolFeeBasisPoints: event.protocolFeeBasisPoints ?? 0,
    coinCreatorFeeBasisPoints: event.coinCreatorFeeBasisPoints ?? 0,
    cashbackFeeBasisPoints: event.cashbackFeeBasisPoints ?? 0,
    sourceSlot: event.slot,
    sourceSignature: event.signature,
    sourceTimestamp: event.timestamp,
    sourceReceivedAtMs: event.receivedAtMs,
    sourceReceivedSequence: event.receivedSequence,
  };
}

export function marketStateBeforeEvent(event, fallbackSupplyRaw = Number(DEFAULT_SUPPLY_RAW)) {
  return {
    baseReserveRaw: integer(event.baseReserveRaw).toString(),
    quoteReserveRaw: integer(event.quoteReserveRaw).toString(),
    virtualQuoteReservesRaw: integer(event.virtualQuoteReservesRaw).toString(),
    baseSupplyRaw: integer(event.baseSupplyRaw, integer(fallbackSupplyRaw, DEFAULT_SUPPLY_RAW)).toString(),
    lpFeeBasisPoints: event.lpFeeBasisPoints ?? 0,
    protocolFeeBasisPoints: event.protocolFeeBasisPoints ?? 0,
    coinCreatorFeeBasisPoints: event.coinCreatorFeeBasisPoints ?? 0,
    cashbackFeeBasisPoints: event.cashbackFeeBasisPoints ?? 0,
    sourceSlot: event.slot,
    sourceSignature: event.signature,
    sourceTimestamp: event.timestamp,
    sourceReceivedAtMs: event.receivedAtMs,
    sourceReceivedSequence: event.receivedSequence,
  };
}

export function quoteBuyWithSol(state, spendSol) {
  const userQuote = BigInt(Math.floor(Number(spendSol) * Number(QUOTE_DECIMALS)));
  const baseReserve = BigInt(state.baseReserveRaw);
  const effectiveQuoteReserve = BigInt(state.quoteReserveRaw) + BigInt(state.virtualQuoteReservesRaw ?? 0);
  const bps = feeBps(state);
  const totalFeeBps = bps.reduce((sum, value) => sum + value, 0n);
  let internalQuote = userQuote * BPS_DENOMINATOR / (BPS_DENOMINATOR + totalFeeBps);
  const totalWithFees = (amount) => amount + bps.reduce((sum, value) => sum + fee(amount, value), 0n);
  if (totalWithFees(internalQuote) > userQuote) internalQuote -= totalWithFees(internalQuote) - userQuote;
  while (totalWithFees(internalQuote + 1n) <= userQuote) internalQuote += 1n;
  const invariantInput = internalQuote - 1n;
  if (invariantInput <= 0n) throw new Error('Quote input is too small after fees');
  const baseOut = baseReserve * invariantInput / (effectiveQuoteReserve + invariantInput);
  if (baseOut <= 0n || baseOut >= baseReserve) throw new Error('Buy quote produced an invalid base output');
  return {
    tokensRaw: baseOut.toString(),
    tokens: Number(baseOut) / Number(BASE_DECIMALS),
    spendSol: Number(userQuote) / Number(QUOTE_DECIMALS),
    internalQuoteRaw: internalQuote.toString(),
    totalFeeBasisPoints: Number(totalFeeBps),
  };
}

export function quoteSellTokens(state, tokensRaw) {
  const base = BigInt(tokensRaw);
  const baseReserve = BigInt(state.baseReserveRaw);
  const effectiveQuoteReserve = BigInt(state.quoteReserveRaw) + BigInt(state.virtualQuoteReservesRaw ?? 0);
  const rawQuote = effectiveQuoteReserve * base / (baseReserve + base);
  const fees = feeBps(state).map((basisPoints) => fee(rawQuote, basisPoints));
  const userQuote = rawQuote - fees.reduce((sum, value) => sum + value, 0n);
  if (userQuote < 0n) throw new Error('Sell fees exceed quote output');
  return {
    proceedsRaw: userQuote.toString(),
    proceedsSol: Number(userQuote) / Number(QUOTE_DECIMALS),
    internalQuoteRaw: rawQuote.toString(),
    totalFeeBasisPoints: Number(feeBps(state).reduce((sum, value) => sum + value, 0n)),
  };
}

export function spotMarketCapSol(state) {
  const baseReserve = BigInt(state.baseReserveRaw);
  if (baseReserve <= 0n) return null;
  const effectiveQuoteReserve = BigInt(state.quoteReserveRaw) + BigInt(state.virtualQuoteReservesRaw ?? 0);
  const supply = BigInt(state.baseSupplyRaw ?? DEFAULT_SUPPLY_RAW);
  const marketCapLamports = effectiveQuoteReserve * supply / baseReserve;
  return Number(marketCapLamports) / Number(QUOTE_DECIMALS);
}

export function fillMarketCap({ quoteSol, tokensRaw, supplyRaw = DEFAULT_SUPPLY_RAW, solUsd = null }) {
  const tokens = Number(BigInt(tokensRaw)) / Number(BASE_DECIMALS);
  const supply = Number(BigInt(supplyRaw)) / Number(BASE_DECIMALS);
  if (!(tokens > 0) || !(supply > 0)) return { sol: null, usd: null };
  const sol = Number(quoteSol) / tokens * supply;
  return { sol, usd: Number.isFinite(solUsd) ? sol * solUsd : null };
}
