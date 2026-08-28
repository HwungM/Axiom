import fs from 'node:fs/promises';
import path from 'node:path';
import { appendJsonl, readJson, writeJsonAtomic } from './lib/fs-store.mjs';
import { postDiscord } from './lib/discord.mjs';

const round = (value, places = 6) => Number(Number(value).toFixed(places));
const formatSol = (value) => `${Number(value).toFixed(4)} SOL`;

function stateFromEvent(event) {
  return { base: event.baseReserveRaw / 1e6, quote: event.quoteReserveRaw / 1e9 };
}

function buy(state, quoteInput, feeRate) {
  const effective = quoteInput * (1 - feeRate);
  const baseOutput = state.base * effective / (state.quote + effective);
  state.base -= baseOutput;
  state.quote += effective;
  return baseOutput;
}

function sell(state, baseInput, feeRate) {
  const effective = baseInput * (1 - feeRate);
  const quoteOutput = state.quote * effective / (state.base + effective);
  state.base += effective;
  state.quote -= quoteOutput;
  return quoteOutput;
}

function applyExternalSwap(state, event, feeRate) {
  return event.side === 'buy'
    ? buy(state, event.quoteAmountRaw / 1e9, feeRate)
    : sell(state, event.baseAmountRaw / 1e6, feeRate);
}

export class PaperEngine {
  static async create(options = {}) {
    const configPath = path.resolve(process.env.PAPER_CONFIG ?? 'config/paper.v1.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const engine = new PaperEngine(config, options);
    await engine.restore();
    return engine;
  }

  constructor(config, options) {
    this.config = config;
    this.dataRoot = path.resolve(process.env.DATA_ROOT ?? 'data');
    this.stateFile = path.join(this.dataRoot, 'paper', 'state.json');
    this.shadowStateFile = path.join(this.dataRoot, 'paper', 'size-shadow-state.json');
    this.shadowSizes = [...new Set(config.shadowPositionSizesSol ?? [])]
      .map(Number)
      .filter((size) => Number.isFinite(size) && size > 0 && size !== config.positionSizeSol)
      .sort((a, b) => a - b);
    this.candidates = new Map();
    this.preMigrationEvents = new Map();
    this.options = options;
    this.lastDailyReportDate = null;
  }

  async restore() {
    this.state = await readJson(this.stateFile, {
      version: this.config.version,
      startedAt: Date.now(),
      startingBankrollSol: this.config.startingBankrollSol,
      availableBankrollSol: this.config.startingBankrollSol,
      realizedPnlSol: 0,
      openPositions: {},
      completedTrades: 0,
      wins: 0,
      losses: 0,
      decisions: 0,
      entered: 0,
      skipped: 0,
      invalidatedTrades: 0,
      seenMigrations: {},
    });
    this.state.invalidatedTrades ??= 0;
    this.state.seenMigrations ??= {};
    this.shadowState = await readJson(this.shadowStateFile, {
      version: `${this.config.version}-size-shadows-v1`,
      startedAt: Date.now(),
      baselineSizeSol: this.config.positionSizeSol,
      matchedSignals: 0,
      cohorts: {},
    });
    this.shadowState.cohorts ??= {};
    this.shadowState.matchedSignals ??= 0;
    for (const sizeSol of this.shadowSizes) {
      const key = String(sizeSol);
      this.shadowState.cohorts[key] ??= {
        sizeSol,
        realizedPnlSol: 0,
        completedTrades: 0,
        wins: 0,
        losses: 0,
        invalidatedTrades: 0,
        openPositions: {},
      };
      this.shadowState.cohorts[key].openPositions ??= {};
      this.shadowState.cohorts[key].invalidatedTrades ??= 0;
    }
    if (Object.keys(this.state.openPositions).length > 0) {
      await this.invalidateOpenPositions('PROCESS_RESTART_DATA_GAP');
    }
    if (this.shadowOpenPositionCount() > 0) {
      await this.invalidateShadowOpenPositions('PROCESS_RESTART_DATA_GAP');
    }
    await this.persist();
    await this.persistShadows();
    this.timer = setInterval(() => this.tick().catch((error) => this.options.onError?.(error)), 1_000);
    this.timer.unref();
  }

  async persist() {
    this.state.updatedAt = Date.now();
    this.state.updatedIso = new Date(this.state.updatedAt).toISOString();
    await writeJsonAtomic(this.stateFile, this.state);
  }

  async persistShadows() {
    this.shadowState.updatedAt = Date.now();
    this.shadowState.updatedIso = new Date(this.shadowState.updatedAt).toISOString();
    await writeJsonAtomic(this.shadowStateFile, this.shadowState);
  }

  shadowCohorts() {
    return Object.values(this.shadowState?.cohorts ?? {}).sort((a, b) => a.sizeSol - b.sizeSol);
  }

  shadowOpenPositionCount() {
    return this.shadowCohorts()
      .reduce((total, cohort) => total + Object.keys(cohort.openPositions ?? {}).length, 0);
  }

  shadowPositionsForPool(pool) {
    const positions = [];
    for (const cohort of this.shadowCohorts()) {
      const position = cohort.openPositions?.[pool];
      if (position) positions.push({ cohort, position });
    }
    return positions;
  }

  async onMigration(migration) {
    if (!this.config.enabled || this.state.seenMigrations[migration.pool] || this.candidates.has(migration.pool) || this.state.openPositions[migration.pool]) return;
    this.state.seenMigrations[migration.pool] = migration.blockTime;
    const seenRows = Object.entries(this.state.seenMigrations);
    if (seenRows.length > 10_000) {
      this.state.seenMigrations = Object.fromEntries(seenRows.sort((a, b) => a[1] - b[1]).slice(-8_000));
    }
    const candidate = {
      ...migration,
      migrationTime: migration.blockTime,
      observedAt: Date.now(),
      events: [],
      actualState: null,
      buyers: new Set(),
      openingBuysSol: 0,
      openingSellsSol: 0,
      largestOpeningSwapSol: 0,
      decided: false,
    };
    this.candidates.set(migration.pool, candidate);
    for (const event of this.preMigrationEvents.get(migration.pool) ?? []) this.observeCandidate(candidate, event);
    this.preMigrationEvents.delete(migration.pool);
    await appendJsonl(path.join(this.dataRoot, 'paper', 'migrations.jsonl'), migration);
    await this.persist();
    void postDiscord('migrationFeed', {
      title: `${migration.symbol ?? 'UNKNOWN'} canonical migration`,
      description: migration.name ?? 'Unnamed Pump token',
      color: 0x45e6b0,
      fields: [
        { name: 'Mint', value: `\`${migration.mint}\`` },
        { name: 'Pool', value: `\`${migration.pool}\`` },
        { name: 'Detected', value: new Date().toISOString(), inline: true },
        { name: 'Observation window', value: `${this.config.observationWindowSeconds}s`, inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
    const decisionAt = migration.blockTime * 1_000 + this.config.observationWindowSeconds * 1_000;
    setTimeout(() => this.decide(migration.pool).catch((error) => this.options.onError?.(error)), Math.max(0, decisionAt - Date.now())).unref();
  }

  async onSwap(event) {
    let relevant = false;
    const position = this.state.openPositions[event.pool];
    if (position && event.timestamp >= position.entryTimestamp) {
      relevant = true;
      applyExternalSwap(position.poolState, event, this.config.poolFeeRate);
      position.lastSwapTimestamp = event.timestamp;
      position.externalSwaps += 1;
      await this.evaluate(position, event.timestamp, 'swap');
    }
    const shadowPositions = this.shadowPositionsForPool(event.pool);
    for (const { cohort, position: shadow } of shadowPositions) {
      if (event.timestamp < shadow.entryTimestamp) continue;
      relevant = true;
      applyExternalSwap(shadow.poolState, event, this.config.poolFeeRate);
      shadow.lastSwapTimestamp = event.timestamp;
      shadow.externalSwaps += 1;
      await this.evaluateShadow(cohort, shadow, event.timestamp, 'swap');
    }
    const candidate = this.candidates.get(event.pool);
    if (candidate && !candidate.decided) {
      relevant = true;
      this.observeCandidate(candidate, event);
    } else if (!candidate && !position && shadowPositions.length === 0) {
      const rows = this.preMigrationEvents.get(event.pool) ?? [];
      rows.push(event);
      this.preMigrationEvents.set(event.pool, rows.slice(-10));
      if (this.preMigrationEvents.size > 500) this.preMigrationEvents.delete(this.preMigrationEvents.keys().next().value);
    }
    if (relevant) await appendJsonl(path.join(this.dataRoot, 'events', 'pumpswap-swaps.jsonl'), event);
  }

  observeCandidate(candidate, event) {
    if (event.timestamp < candidate.migrationTime - 2) return;
    candidate.events.push(event);
    if (!candidate.actualState) candidate.actualState = stateFromEvent(event);
    applyExternalSwap(candidate.actualState, event, this.config.poolFeeRate);
    const amountSol = event.quoteAmountRaw / 1e9;
    if (event.timestamp <= candidate.migrationTime + this.config.observationWindowSeconds) {
      candidate.largestOpeningSwapSol = Math.max(candidate.largestOpeningSwapSol, amountSol);
      if (event.side === 'buy') {
        candidate.openingBuysSol += amountSol;
        candidate.buyers.add(event.user);
      } else {
        candidate.openingSellsSol += amountSol;
      }
    }
  }

  decisionReasons(candidate) {
    const selector = this.config.selector;
    const reasons = [];
    const first = candidate.events[0];
    const quoteReserveSol = first?.quoteReserveRaw / 1e9;
    if (!candidate.actualState || !Number.isFinite(quoteReserveSol)) reasons.push('no exact executable reserve state');
    if (Number.isFinite(quoteReserveSol) && quoteReserveSol < selector.minimumQuoteReserveSol) reasons.push(`quote reserve below ${selector.minimumQuoteReserveSol} SOL`);
    if (Number.isFinite(quoteReserveSol) && quoteReserveSol > selector.maximumQuoteReserveSol) reasons.push(`quote reserve above ${selector.maximumQuoteReserveSol} SOL`);
    if (candidate.largestOpeningSwapSol > selector.maximumLargestOpeningSwapSol) reasons.push(`opening swap ${candidate.largestOpeningSwapSol.toFixed(2)} SOL exceeds ${selector.maximumLargestOpeningSwapSol}`);
    if (candidate.buyers.size < selector.minimumIndependentBuyers) reasons.push(`only ${candidate.buyers.size} opening buyer(s)`);
    if (candidate.events.length < selector.minimumOpeningSwaps) reasons.push(`only ${candidate.events.length} opening swap(s)`);
    return { reasons, quoteReserveSol };
  }

  async decide(pool) {
    const candidate = this.candidates.get(pool);
    if (!candidate || candidate.decided) return;
    candidate.decided = true;
    const { reasons, quoteReserveSol } = this.decisionReasons(candidate);
    if (Object.keys(this.state.openPositions).length >= this.config.maxConcurrentPositions) reasons.push('maximum concurrent positions reached');
    const required = this.config.positionSizeSol + this.config.fixedCostPerTransactionSol;
    if (this.state.availableBankrollSol < required) reasons.push('insufficient available paper bankroll');
    const decision = reasons.length === 0 ? 'ENTER' : 'SKIP';
    const row = {
      at: Date.now(),
      version: this.config.version,
      decision,
      reasons,
      pool,
      mint: candidate.mint,
      name: candidate.name,
      symbol: candidate.symbol,
      migrationTime: candidate.migrationTime,
      quoteReserveSol,
      openingSwaps: candidate.events.length,
      independentBuyers: candidate.buyers.size,
      largestOpeningSwapSol: candidate.largestOpeningSwapSol,
      openingNetFlowSol: candidate.openingBuysSol - candidate.openingSellsSol,
    };
    this.state.decisions += 1;
    this.state[decision === 'ENTER' ? 'entered' : 'skipped'] += 1;
    await appendJsonl(path.join(this.dataRoot, 'paper', 'decisions.jsonl'), row);
    void postDiscord('decisionLog', {
      title: `${decision}: ${candidate.symbol ?? candidate.mint.slice(0, 8)}`,
      description: decision === 'ENTER' ? 'Frozen paper-v1 selector passed.' : reasons.join('\n'),
      color: decision === 'ENTER' ? 0x45e6b0 : 0xffc857,
      fields: [
        { name: 'Opening reserve', value: quoteReserveSol == null ? 'Unavailable' : formatSol(quoteReserveSol), inline: true },
        { name: 'Largest opening swap', value: formatSol(candidate.largestOpeningSwapSol), inline: true },
        { name: 'Independent buyers', value: String(candidate.buyers.size), inline: true },
        { name: 'Net opening flow', value: formatSol(row.openingNetFlowSol), inline: true },
        { name: 'Strategy', value: this.config.version },
      ],
    }).catch((error) => this.options.onError?.(error));
    if (decision === 'ENTER') await this.openPosition(candidate, row);
    this.candidates.delete(pool);
    await this.persist();
  }

  async openPosition(candidate, decision) {
    const decisionState = { ...candidate.actualState };
    const poolState = { ...decisionState };
    const tokens = buy(poolState, this.config.positionSizeSol, this.config.poolFeeRate);
    const entryTimestamp = Math.max(Math.floor(Date.now() / 1_000), candidate.migrationTime + this.config.observationWindowSeconds);
    const position = {
      id: `${candidate.pool}:${entryTimestamp}`,
      pool: candidate.pool,
      mint: candidate.mint,
      name: candidate.name,
      symbol: candidate.symbol,
      entryTimestamp,
      entryIso: new Date(entryTimestamp * 1_000).toISOString(),
      sizeSol: this.config.positionSizeSol,
      tokens,
      poolState,
      entryQuoteReserveSol: decision.quoteReserveSol,
      entryAveragePriceSol: this.config.positionSizeSol / tokens,
      externalSwaps: 0,
      lastSwapTimestamp: entryTimestamp,
      status: 'OPEN',
    };
    this.state.availableBankrollSol -= this.config.positionSizeSol + this.config.fixedCostPerTransactionSol;
    this.state.openPositions[candidate.pool] = position;
    const shadowEntries = this.openShadowPositions(candidate, decision, decisionState, entryTimestamp);
    await appendJsonl(path.join(this.dataRoot, 'paper', 'entries.jsonl'), position);
    for (const shadow of shadowEntries) {
      await appendJsonl(path.join(this.dataRoot, 'paper', 'size-shadow-entries.jsonl'), shadow);
    }
    await this.persist();
    await this.persistShadows();
    void postDiscord('paperTrades', {
      title: `PAPER ENTRY: ${candidate.symbol ?? candidate.mint.slice(0, 8)}`,
      description: 'Counterfactual position entered using the exact observed pool state plus our own modeled price impact.',
      color: 0x4da3ff,
      fields: [
        { name: 'Size', value: formatSol(position.sizeSol), inline: true },
        { name: 'Bankroll available', value: formatSol(this.state.availableBankrollSol), inline: true },
        { name: 'Opening reserve', value: formatSol(position.entryQuoteReserveSol), inline: true },
        { name: 'Matched size shadows', value: this.shadowSizes.map((size) => `${size} SOL`).join(' · ') || 'Disabled' },
        { name: 'Exit plan', value: `TP +${this.config.takeProfitPct}% · SL −${this.config.stopLossPct}% · ${this.config.timeoutSeconds}s timeout` },
        { name: 'Mint', value: `\`${candidate.mint}\`` },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  openShadowPositions(candidate, decision, decisionState, entryTimestamp) {
    const entries = [];
    this.shadowState.matchedSignals += 1;
    for (const sizeSol of this.shadowSizes) {
      const cohort = this.shadowState.cohorts[String(sizeSol)];
      const poolState = { ...decisionState };
      const tokens = buy(poolState, sizeSol, this.config.poolFeeRate);
      const position = {
        id: `${candidate.pool}:${entryTimestamp}:shadow:${sizeSol}`,
        cohort: `${sizeSol}-SOL`,
        pool: candidate.pool,
        mint: candidate.mint,
        name: candidate.name,
        symbol: candidate.symbol,
        entryTimestamp,
        entryIso: new Date(entryTimestamp * 1_000).toISOString(),
        sizeSol,
        tokens,
        poolState,
        entryQuoteReserveSol: decision.quoteReserveSol,
        entryAveragePriceSol: sizeSol / tokens,
        externalSwaps: 0,
        lastSwapTimestamp: entryTimestamp,
        status: 'OPEN',
      };
      cohort.openPositions[candidate.pool] = position;
      entries.push(position);
    }
    return entries;
  }

  mark(position) {
    const shadow = { ...position.poolState };
    const proceeds = sell(shadow, position.tokens, this.config.poolFeeRate);
    const pnlSol = proceeds - position.sizeSol - 2 * this.config.fixedCostPerTransactionSol;
    return { proceeds, pnlSol, returnPct: 100 * pnlSol / position.sizeSol };
  }

  async evaluate(position, timestamp, source) {
    if (position.closing) return;
    const mark = this.mark(position);
    const ageSeconds = timestamp - position.entryTimestamp;
    let reason = null;
    if (mark.returnPct >= this.config.takeProfitPct) reason = 'TAKE_PROFIT';
    else if (mark.returnPct <= -this.config.stopLossPct) reason = 'STOP_LOSS';
    else if (ageSeconds >= this.config.timeoutSeconds) reason = 'TIMEOUT';
    if (reason) await this.closePosition(position, timestamp, reason, source, mark);
  }

  markShadow(position) {
    const state = { ...position.poolState };
    const proceeds = sell(state, position.tokens, this.config.poolFeeRate);
    const pnlSol = proceeds - position.sizeSol - 2 * this.config.fixedCostPerTransactionSol;
    return { proceeds, pnlSol, returnPct: 100 * pnlSol / position.sizeSol };
  }

  async evaluateShadow(cohort, position, timestamp, source) {
    if (position.closing) return;
    const mark = this.markShadow(position);
    const ageSeconds = timestamp - position.entryTimestamp;
    let reason = null;
    if (mark.returnPct >= this.config.takeProfitPct) reason = 'TAKE_PROFIT';
    else if (mark.returnPct <= -this.config.stopLossPct) reason = 'STOP_LOSS';
    else if (ageSeconds >= this.config.timeoutSeconds) reason = 'TIMEOUT';
    if (reason) await this.closeShadowPosition(cohort, position, timestamp, reason, source, mark);
  }

  async closeShadowPosition(cohort, position, timestamp, reason, source, mark = this.markShadow(position)) {
    position.closing = true;
    cohort.realizedPnlSol += mark.pnlSol;
    cohort.completedTrades += 1;
    cohort[mark.pnlSol > 0 ? 'wins' : 'losses'] += 1;
    delete cohort.openPositions[position.pool];
    const result = {
      ...position,
      poolState: undefined,
      tokens: round(position.tokens),
      status: 'CLOSED',
      exitTimestamp: timestamp,
      exitIso: new Date(timestamp * 1_000).toISOString(),
      exitReason: reason,
      exitSource: source,
      holdSeconds: timestamp - position.entryTimestamp,
      grossProceedsSol: round(mark.proceeds),
      pnlSol: round(mark.pnlSol),
      returnPct: round(mark.returnPct, 3),
      cohortRealizedPnlSol: round(cohort.realizedPnlSol),
    };
    await appendJsonl(path.join(this.dataRoot, 'paper', 'size-shadow-exits.jsonl'), result);
    await this.persistShadows();
    const won = result.pnlSol > 0;
    void postDiscord('paperTrades', {
      title: `SIZE SHADOW ${position.sizeSol} SOL: ${position.symbol ?? position.mint.slice(0, 8)} · ${reason}`,
      description: 'Matched-signal shadow closed using its own fill, price impact and exit threshold.',
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Net PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Return', value: `${result.returnPct >= 0 ? '+' : ''}${result.returnPct.toFixed(2)}%`, inline: true },
        { name: 'Hold', value: `${result.holdSeconds}s`, inline: true },
        { name: 'Cohort total', value: `${result.cohortRealizedPnlSol >= 0 ? '+' : ''}${formatSol(result.cohortRealizedPnlSol)}`, inline: true },
        { name: 'Matched baseline signal', value: `0.5 SOL · ${position.entryIso}` },
      ],
    }).catch((error) => this.options.onError?.(error));
    void postDiscord('pnl', {
      title: `${position.sizeSol} SOL SHADOW PNL`,
      description: `${position.symbol ?? position.mint.slice(0, 8)} closed · ${reason}`,
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Trade PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Cumulative PnL', value: `${cohort.realizedPnlSol >= 0 ? '+' : ''}${formatSol(cohort.realizedPnlSol)}`, inline: true },
        { name: 'Return', value: `${result.returnPct >= 0 ? '+' : ''}${result.returnPct.toFixed(2)}%`, inline: true },
        { name: 'Record', value: `${cohort.wins}W · ${cohort.losses}L`, inline: true },
        { name: 'Completed', value: String(cohort.completedTrades), inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  async closePosition(position, timestamp, reason, source, mark = this.mark(position)) {
    position.closing = true;
    const exitCost = this.config.fixedCostPerTransactionSol;
    this.state.availableBankrollSol += mark.proceeds - exitCost;
    this.state.realizedPnlSol += mark.pnlSol;
    this.state.completedTrades += 1;
    this.state[mark.pnlSol > 0 ? 'wins' : 'losses'] += 1;
    delete this.state.openPositions[position.pool];
    const result = {
      ...position,
      poolState: undefined,
      tokens: round(position.tokens),
      status: 'CLOSED',
      exitTimestamp: timestamp,
      exitIso: new Date(timestamp * 1_000).toISOString(),
      exitReason: reason,
      exitSource: source,
      holdSeconds: timestamp - position.entryTimestamp,
      grossProceedsSol: round(mark.proceeds),
      pnlSol: round(mark.pnlSol),
      returnPct: round(mark.returnPct, 3),
      bankrollSol: round(this.state.availableBankrollSol),
    };
    await appendJsonl(path.join(this.dataRoot, 'paper', 'exits.jsonl'), result);
    await this.persist();
    const won = result.pnlSol > 0;
    void postDiscord('paperTrades', {
      title: `PAPER EXIT: ${position.symbol ?? position.mint.slice(0, 8)} · ${reason}`,
      description: won ? 'Paper trade closed profitably.' : 'Paper trade closed at a loss.',
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Net PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Return', value: `${result.returnPct >= 0 ? '+' : ''}${result.returnPct.toFixed(2)}%`, inline: true },
        { name: 'Hold', value: `${result.holdSeconds}s`, inline: true },
        { name: 'Bankroll', value: formatSol(result.bankrollSol), inline: true },
        { name: 'External swaps replayed', value: String(result.externalSwaps), inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
    void postDiscord('pnl', {
      title: '0.5 SOL BASELINE PNL',
      description: `${position.symbol ?? position.mint.slice(0, 8)} closed · ${reason}`,
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Trade PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Cumulative PnL', value: `${this.state.realizedPnlSol >= 0 ? '+' : ''}${formatSol(this.state.realizedPnlSol)}`, inline: true },
        { name: 'Return', value: `${result.returnPct >= 0 ? '+' : ''}${result.returnPct.toFixed(2)}%`, inline: true },
        { name: 'Record', value: `${this.state.wins}W · ${this.state.losses}L`, inline: true },
        { name: 'Completed', value: String(this.state.completedTrades), inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
    void postDiscord('caseStudies', {
      threadName: `${position.symbol ?? position.mint.slice(0, 8)} · ${reason} · ${result.exitIso.slice(11, 19)}`,
      title: `${position.name ?? position.symbol ?? 'Token'} paper case study`,
      description: `Decision → exact-state entry → external-flow replay → ${reason}.`,
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Mint', value: `\`${position.mint}\`` },
        { name: 'Entry', value: position.entryIso, inline: true },
        { name: 'Exit', value: result.exitIso, inline: true },
        { name: 'Outcome', value: `${result.pnlSol >= 0 ? '+' : ''}${result.pnlSol.toFixed(4)} SOL (${result.returnPct.toFixed(2)}%)` },
        { name: 'Method version', value: this.config.version },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  async tick() {
    const now = Math.floor(Date.now() / 1_000);
    for (const position of Object.values(this.state.openPositions)) await this.evaluate(position, now, 'clock');
    for (const cohort of this.shadowCohorts()) {
      for (const position of Object.values(cohort.openPositions)) await this.evaluateShadow(cohort, position, now, 'clock');
    }
    const date = new Date().toISOString().slice(0, 10);
    if (new Date().getUTCHours() === 0 && this.lastDailyReportDate !== date) {
      this.lastDailyReportDate = date;
      await this.sendDailyReport();
    }
  }

  async sendDailyReport() {
    const completed = this.state.completedTrades;
    const winRate = completed ? 100 * this.state.wins / completed : 0;
    const shadowFields = this.shadowCohorts().map((cohort) => ({
      name: `${cohort.sizeSol} SOL shadow`,
      value: `${cohort.completedTrades} closed · ${cohort.realizedPnlSol >= 0 ? '+' : ''}${cohort.realizedPnlSol.toFixed(4)} SOL · ${Object.keys(cohort.openPositions).length} open`,
    }));
    await postDiscord('dailyReports', {
      title: 'Paper account report',
      description: `Frozen strategy: ${this.config.version}`,
      color: this.state.realizedPnlSol >= 0 ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Bankroll', value: formatSol(this.state.availableBankrollSol), inline: true },
        { name: 'Realized PnL', value: formatSol(this.state.realizedPnlSol), inline: true },
        { name: 'Open positions', value: String(Object.keys(this.state.openPositions).length), inline: true },
        { name: 'Completed', value: String(completed), inline: true },
        { name: 'Win rate', value: `${winRate.toFixed(1)}%`, inline: true },
        { name: 'Decisions', value: `${this.state.entered} entered · ${this.state.skipped} skipped` },
        { name: 'Invalidated by data gaps', value: String(this.state.invalidatedTrades) },
        ...shadowFields,
      ],
    });
  }

  summary() {
    return {
      version: this.config.version,
      enabled: this.config.enabled,
      bankrollSol: round(this.state.availableBankrollSol),
      realizedPnlSol: round(this.state.realizedPnlSol),
      openPositions: Object.keys(this.state.openPositions).length,
      completedTrades: this.state.completedTrades,
      decisions: this.state.decisions,
      invalidatedTrades: this.state.invalidatedTrades,
      sizeShadows: this.shadowCohorts().map((cohort) => ({
        sizeSol: cohort.sizeSol,
        realizedPnlSol: round(cohort.realizedPnlSol),
        openPositions: Object.keys(cohort.openPositions).length,
        completedTrades: cohort.completedTrades,
      })),
    };
  }

  async invalidateOpenPositions(reason) {
    const positions = Object.values(this.state.openPositions);
    this.candidates.clear();
    this.preMigrationEvents.clear();
    if (positions.length === 0) return;
    for (const position of positions) {
      this.state.availableBankrollSol += position.sizeSol + this.config.fixedCostPerTransactionSol;
      this.state.invalidatedTrades += 1;
      const row = {
        ...position,
        poolState: undefined,
        tokens: round(position.tokens),
        status: 'INVALIDATED',
        invalidatedAt: Date.now(),
        reason,
      };
      await appendJsonl(path.join(this.dataRoot, 'paper', 'invalidated.jsonl'), row);
      delete this.state.openPositions[position.pool];
      void postDiscord('alerts', {
        title: `Paper trade invalidated: ${position.symbol ?? position.mint.slice(0, 8)}`,
        description: 'A complete event path was unavailable, so this position is excluded from strategy PnL rather than assigned an invented exit.',
        color: 0xffc857,
        fields: [{ name: 'Reason', value: reason }],
      }).catch(() => {});
    }
    await this.persist();
  }

  async invalidateShadowOpenPositions(reason) {
    const invalidated = [];
    for (const cohort of this.shadowCohorts()) {
      for (const position of Object.values(cohort.openPositions)) {
        cohort.invalidatedTrades += 1;
        const row = {
          ...position,
          poolState: undefined,
          tokens: round(position.tokens),
          status: 'INVALIDATED',
          invalidatedAt: Date.now(),
          reason,
        };
        await appendJsonl(path.join(this.dataRoot, 'paper', 'size-shadow-invalidated.jsonl'), row);
        delete cohort.openPositions[position.pool];
        invalidated.push(row);
      }
    }
    if (invalidated.length === 0) return;
    await this.persistShadows();
    void postDiscord('alerts', {
      title: `${invalidated.length} size-shadow trade(s) invalidated`,
      description: 'Their complete event paths were unavailable, so they are excluded from the matched size comparison.',
      color: 0xffc857,
      fields: [{ name: 'Reason', value: reason }],
    }).catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
  }
}
