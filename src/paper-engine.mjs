import fs from 'node:fs/promises';
import path from 'node:path';
import { appendJsonl, readJson, writeJsonAtomic } from './lib/fs-store.mjs';
import { getJson } from './lib/http.mjs';
import { postDiscord } from './lib/discord.mjs';
import { fillMarketCap, marketStateAfterEvent, quoteBuyWithSol, quoteSellTokens, spotMarketCapSol } from './lib/pumpswap-quote.mjs';

const round = (value, places = 6) => Number(Number(value).toFixed(places));
const formatSol = (value) => `${Number(value).toFixed(4)} SOL`;
const eventQuoteSol = (event) => Number(event.userQuoteAmountRaw ?? event.quoteAmountRaw) / 1e9;
const formatMarketCap = (usd, sol) => {
  const compact = (value, prefix = '') => {
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(2)}M`;
    if (Math.abs(value) >= 1_000) return `${prefix}${(value / 1_000).toFixed(1)}K`;
    return `${prefix}${value.toFixed(2)}`;
  };
  const usdText = compact(usd, '$');
  const solText = compact(sol);
  return usdText ? `${usdText}${solText ? ` (${solText} SOL)` : ''}` : solText ? `${solText} SOL` : 'Unavailable';
};
const formatCompetition = (competition) => competition
  ? `${competition.observedBuys} buys / ${Number(competition.buySol).toFixed(3)} SOL · ${competition.observedSells} sells / ${Number(competition.sellSol).toFixed(3)} SOL`
  : 'Unavailable';
const formatTopWallets = (rows) => rows?.length
  ? rows.map(({ wallet, sol }) => `\`${wallet}\` · ${Number(sol).toFixed(3)} SOL`).join('\n')
  : 'None observed';

export class PaperEngine {
  static async create(options = {}) {
    const configPath = path.resolve(process.env.PAPER_CONFIG ?? 'config/paper.v4.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const engine = new PaperEngine(config, options);
    await engine.restore();
    return engine;
  }

  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.dataRoot = path.resolve(process.env.DATA_ROOT ?? 'data');
    this.paperRoot = path.join(this.dataRoot, config.dataDirectory ?? 'paper');
    this.stateFile = path.join(this.paperRoot, 'state.json');
    this.shadowStateFile = path.join(this.paperRoot, 'size-shadow-state.json');
    this.latencyStateFile = path.join(this.paperRoot, 'latency-account-state.json');
    this.latencyAccount = config.latencyAccount?.enabled ? config.latencyAccount : null;
    this.shadowSizes = [...new Set(config.shadowPositionSizesSol ?? [])]
      .map(Number).filter((size) => Number.isFinite(size) && size > 0 && size !== config.positionSizeSol)
      .sort((a, b) => a - b);
    this.candidates = new Map();
    this.preMigrationEvents = new Map();
    this.preMigrationDropped = new Map();
    this.eventJournalQueue = Promise.resolve();
    this.lastDailyReportDate = null;
    this.solUsd = null;
  }

  async restore() {
    this.state = await readJson(this.stateFile, {
      version: this.config.version, startedAt: Date.now(), startingBankrollSol: this.config.startingBankrollSol,
      availableBankrollSol: this.config.startingBankrollSol, realizedPnlSol: 0, openPositions: {}, completedTrades: 0,
      wins: 0, losses: 0, decisions: 0, entered: 0, skipped: 0, invalidatedTrades: 0, seenMigrations: {},
    });
    this.state.openPositions ??= {};
    this.state.seenMigrations ??= {};
    this.state.invalidatedTrades ??= 0;
    this.shadowState = await readJson(this.shadowStateFile, {
      version: `${this.config.version}-size-shadows-v1`, startedAt: Date.now(), baselineSizeSol: this.config.positionSizeSol,
      matchedSignals: 0, cohorts: {},
    });
    this.shadowState.cohorts ??= {};
    this.shadowState.matchedSignals ??= 0;
    for (const sizeSol of this.shadowSizes) {
      this.shadowState.cohorts[String(sizeSol)] ??= {
        sizeSol, realizedPnlSol: 0, completedTrades: 0, wins: 0, losses: 0, invalidatedTrades: 0, openPositions: {},
      };
    }
    this.latencyState = await readJson(this.latencyStateFile, {
      version: `${this.config.version}-${this.latencyAccount?.name ?? 'FAST'}`,
      startedAt: Date.now(), startingBankrollSol: this.latencyAccount?.startingBankrollSol ?? 3,
      availableBankrollSol: this.latencyAccount?.startingBankrollSol ?? 3, realizedPnlSol: 0,
      openPositions: {}, matchedSignals: 0, entered: 0, skipped: 0, completedTrades: 0,
      wins: 0, losses: 0, invalidatedTrades: 0,
    });
    this.latencyState.openPositions ??= {};
    if (Object.keys(this.state.openPositions).length) await this.invalidateOpenPositions('PROCESS_RESTART_DATA_GAP');
    if (this.shadowOpenPositionCount()) await this.invalidateShadowOpenPositions('PROCESS_RESTART_DATA_GAP');
    if (Object.keys(this.latencyState.openPositions).length) await this.invalidateLatencyOpenPositions('PROCESS_RESTART_DATA_GAP');
    await Promise.all([this.persist(), this.persistShadows(), this.persistLatency(), this.refreshSolPrice()]);
    this.timer = setInterval(() => this.tick().catch((error) => this.options.onError?.(error)), 1_000);
    this.priceTimer = setInterval(() => this.refreshSolPrice().catch((error) => this.options.onError?.(error)), 15_000);
    this.timer.unref();
    this.priceTimer.unref();
  }

  async refreshSolPrice() {
    const payload = await getJson('https://frontend-api-v3.pump.fun/sol-price', { attempts: 2, baseDelayMs: 250 });
    const value = Number(payload.solPrice);
    if (Number.isFinite(value) && value > 0) this.solUsd = value;
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

  async persistLatency() {
    this.latencyState.updatedAt = Date.now();
    this.latencyState.updatedIso = new Date(this.latencyState.updatedAt).toISOString();
    await writeJsonAtomic(this.latencyStateFile, this.latencyState);
  }

  shadowCohorts() { return Object.values(this.shadowState.cohorts).sort((a, b) => a.sizeSol - b.sizeSol); }
  shadowOpenPositionCount() { return this.shadowCohorts().reduce((sum, cohort) => sum + Object.keys(cohort.openPositions ?? {}).length, 0); }
  shadowPositionsForPool(pool) {
    return this.shadowCohorts().map((cohort) => ({ cohort, position: cohort.openPositions?.[pool] })).filter((row) => row.position);
  }

  async onMigration(migration) {
    if (!this.config.enabled || this.state.seenMigrations[migration.pool] || this.candidates.has(migration.pool)) return;
    this.state.seenMigrations[migration.pool] = migration.blockTime;
    const seenRows = Object.entries(this.state.seenMigrations);
    if (seenRows.length > 10_000) this.state.seenMigrations = Object.fromEntries(seenRows.sort((a, b) => a[1] - b[1]).slice(-8_000));
    const detectedAtMs = migration.migrationResolvedAtMs ?? Date.now();
    const candidate = {
      ...migration, migrationTime: migration.blockTime, detectedAtMs,
      decisionAtMs: Math.max(migration.blockTime * 1_000 + this.config.observationWindowSeconds * 1_000, detectedAtMs),
      events: [], droppedEvents: 0, preMigrationDroppedEvents: this.preMigrationDropped.get(migration.pool) ?? 0,
      actualState: null, buyers: new Set(), openingBuysSol: 0, openingSellsSol: 0,
      largestOpeningSwapSol: 0, peakSpotMarketCapSol: null, currentSpotMarketCapSol: null,
      currentDrawdownPct: 0, decided: false, approved: false, fastPathDiagnostic: null, fastPathComplete: false,
    };
    this.candidates.set(migration.pool, candidate);
    for (const event of this.preMigrationEvents.get(migration.pool) ?? []) this.observeCandidate(candidate, event);
    this.preMigrationEvents.delete(migration.pool);
    this.preMigrationDropped.delete(migration.pool);
    await appendJsonl(path.join(this.paperRoot, 'migrations.jsonl'), migration);
    await this.persist();
    void this.enrichCandidate(candidate).catch((error) => this.options.onError?.(error));
    void postDiscord('migrationFeed', {
      title: `${migration.symbol ?? 'UNKNOWN'} canonical migration`, description: migration.name ?? 'Unnamed Pump token', color: 0x45e6b0,
      fields: [
        { name: 'Mint', value: `\`${migration.mint}\`` }, { name: 'Pool', value: `\`${migration.pool}\`` },
        { name: 'Detected', value: new Date(detectedAtMs).toISOString(), inline: true },
        { name: 'Resolve latency', value: migration.migrationResolutionMs == null ? 'Unavailable' : `${migration.migrationResolutionMs}ms`, inline: true },
        { name: 'Decision model', value: `${this.config.observationWindowSeconds}s opening window`, inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
    setTimeout(() => this.decide(migration.pool).catch((error) => this.options.onError?.(error)), Math.max(0, candidate.decisionAtMs - Date.now())).unref();
  }

  async enrichCandidate(candidate) {
    const coin = await getJson(`https://frontend-api-v3.pump.fun/coins/${candidate.mint}`, { attempts: 2, baseDelayMs: 250 });
    candidate.name = coin?.name ?? candidate.name;
    candidate.symbol = coin?.symbol ?? candidate.symbol;
    candidate.creator = coin?.creator ?? candidate.creator;
    candidate.totalSupplyRaw = coin?.total_supply != null ? String(coin.total_supply) : candidate.totalSupplyRaw;
    candidate.tokenCreatedTimestamp = coin?.created_timestamp ?? candidate.tokenCreatedTimestamp;
    if (Number(coin?.usd_market_cap) > 0 && Number(coin?.market_cap) > 0) {
      candidate.solUsd = Number(coin.usd_market_cap) / Number(coin.market_cap);
    }
  }

  bufferPreMigration(event) {
    const rows = this.preMigrationEvents.get(event.pool) ?? [];
    rows.push(event);
    if (rows.length > 500) this.preMigrationDropped.set(event.pool, (this.preMigrationDropped.get(event.pool) ?? 0) + 1);
    this.preMigrationEvents.set(event.pool, rows.slice(-500));
    if (this.preMigrationEvents.size > 1_000) {
      const oldest = this.preMigrationEvents.keys().next().value;
      this.preMigrationEvents.delete(oldest);
      this.preMigrationDropped.delete(oldest);
    }
  }

  observeCandidate(candidate, event) {
    if (event.timestamp < candidate.migrationTime - 2) return;
    candidate.events.push(event);
    if (candidate.events.length > 5_000) {
      candidate.events.shift();
      candidate.droppedEvents += 1;
    }
    candidate.actualState = marketStateAfterEvent(event, candidate.totalSupplyRaw);
    candidate.latestEvent = event;
    const observedSpotMarketCapSol = spotMarketCapSol(candidate.actualState);
    if (event.timestamp >= candidate.migrationTime && Number.isFinite(observedSpotMarketCapSol)) {
      candidate.currentSpotMarketCapSol = observedSpotMarketCapSol;
      candidate.peakSpotMarketCapSol = Math.max(candidate.peakSpotMarketCapSol ?? observedSpotMarketCapSol, observedSpotMarketCapSol);
      candidate.currentDrawdownPct = candidate.peakSpotMarketCapSol > 0
        ? 100 * (candidate.peakSpotMarketCapSol - observedSpotMarketCapSol) / candidate.peakSpotMarketCapSol : 0;
    }
    if (event.timestamp < candidate.migrationTime) return;
    if (event.timestamp > candidate.migrationTime + this.config.observationWindowSeconds) return;
    const amountSol = eventQuoteSol(event);
    candidate.largestOpeningSwapSol = Math.max(candidate.largestOpeningSwapSol, amountSol);
    if (event.side === 'buy') { candidate.openingBuysSol += amountSol; candidate.buyers.add(event.user); }
    else candidate.openingSellsSol += amountSol;
  }

  competitionStats(candidate, throughSequence) {
    const events = (candidate.events ?? []).filter((event) => event.receivedSequence > (candidate.decisionReceivedSequence ?? 0)
      && event.receivedSequence <= throughSequence);
    const buyers = new Map();
    const sellers = new Map();
    let buySol = 0;
    let sellSol = 0;
    let largestBuySol = 0;
    let largestSellSol = 0;
    for (const event of events) {
      const amountSol = eventQuoteSol(event);
      if (event.side === 'buy') {
        buySol += amountSol;
        largestBuySol = Math.max(largestBuySol, amountSol);
        buyers.set(event.user, (buyers.get(event.user) ?? 0) + amountSol);
      } else {
        sellSol += amountSol;
        largestSellSol = Math.max(largestSellSol, amountSol);
        sellers.set(event.user, (sellers.get(event.user) ?? 0) + amountSol);
      }
    }
    return {
      observedEvents: events.length,
      observedBuys: events.filter((event) => event.side === 'buy').length,
      observedSells: events.filter((event) => event.side === 'sell').length,
      independentBuyers: buyers.size,
      buySol: round(buySol),
      sellSol: round(sellSol),
      largestBuySol: round(largestBuySol),
      largestSellSol: round(largestSellSol),
      estimatedPositionBehindObservedBuys: events.filter((event) => event.side === 'buy').length + 1,
      topObservedBuyers: [...buyers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([wallet, sol]) => ({ wallet, sol: round(sol) })),
      topObservedSellers: [...sellers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([wallet, sol]) => ({ wallet, sol: round(sol) })),
      observedSignatures: events.slice(0, 50).map((event) => event.signature),
    };
  }

  dumpMetrics(candidate, atMs) {
    const guard = this.config.dumpGuard ?? {};
    const windowMs = guard.windowMs ?? 1_000;
    const recent = (candidate.events ?? []).filter((event) => event.receivedAtMs >= atMs - windowMs && event.receivedAtMs <= atMs);
    const buySol = recent.filter((event) => event.side === 'buy').reduce((sum, event) => sum + eventQuoteSol(event), 0);
    const sellSol = recent.filter((event) => event.side === 'sell').reduce((sum, event) => sum + eventQuoteSol(event), 0);
    const sellToBuyRatio = buySol > 0 ? sellSol / buySol : sellSol > 0 ? null : 0;
    const reasons = [];
    const drawdown = candidate.currentDrawdownPct ?? 0;
    if (guard.enabled && drawdown >= guard.maximumPeakDrawdownPct && sellSol > buySol) {
      reasons.push(`active dump: ${drawdown.toFixed(1)}% below observed post-migration peak with net selling`);
    }
    if (guard.enabled && sellSol >= guard.minimumSellPressureSol
      && (buySol === 0 || sellSol / buySol >= guard.maximumSellToBuyRatio)) {
      reasons.push(`active dump: ${sellSol.toFixed(3)} SOL sold vs ${buySol.toFixed(3)} SOL bought in ${windowMs}ms`);
    }
    return {
      windowMs,
      buySol: round(buySol),
      sellSol: round(sellSol),
      sellToBuyRatio: sellToBuyRatio == null ? null : round(sellToBuyRatio, 3),
      peakDrawdownPct: round(drawdown, 3),
      peakSpotMarketCapSol: candidate.peakSpotMarketCapSol,
      currentSpotMarketCapSol: candidate.currentSpotMarketCapSol,
      reasons,
    };
  }

  captureFastPathDiagnostic(candidate, event) {
    try {
      const quote = quoteBuyWithSol(candidate.actualState, this.config.positionSizeSol);
      const solUsd = this.solUsd ?? candidate.solUsd ?? null;
      const marketCap = fillMarketCap({
        quoteSol: quote.spendSol,
        tokensRaw: quote.tokensRaw,
        supplyRaw: candidate.actualState.baseSupplyRaw,
        solUsd,
      });
      candidate.fastPathDiagnostic = {
        targetMs: candidate.fastPathNotBeforeMs,
        observedAtMs: event.receivedAtMs,
        observedSequence: event.receivedSequence,
        observedDelayMs: event.receivedAtMs - candidate.submittedAtMs,
        averageFillMarketCapSol: marketCap.sol,
        averageFillMarketCapUsd: marketCap.usd,
        competition: this.competitionStats(candidate, event.receivedSequence),
      };
    } catch {}
  }

  async onSwap(event) {
    let relevant = false;
    const position = this.state.openPositions[event.pool];
    if (position && event.receivedSequence > position.entryReceivedSequence) {
      relevant = true;
      position.marketState = marketStateAfterEvent(event, position.supplyRaw);
      position.lastSwapTimestamp = event.timestamp;
      position.lastSwapReceivedAtMs = event.receivedAtMs;
      position.externalSwaps += 1;
      this.recordPositionFlow(position, event);
      await this.evaluate(position, event.receivedAtMs, 'swap');
    }
    const shadows = this.shadowPositionsForPool(event.pool);
    for (const { cohort, position: shadow } of shadows) {
      if (event.receivedSequence <= shadow.entryReceivedSequence) continue;
      relevant = true;
      shadow.marketState = marketStateAfterEvent(event, shadow.supplyRaw);
      shadow.lastSwapTimestamp = event.timestamp;
      shadow.lastSwapReceivedAtMs = event.receivedAtMs;
      shadow.externalSwaps += 1;
      this.recordPositionFlow(shadow, event);
      await this.evaluateShadow(cohort, shadow, event.receivedAtMs, 'swap');
    }
    const latencyPosition = this.latencyState.openPositions[event.pool];
    if (latencyPosition && event.receivedSequence > latencyPosition.entryReceivedSequence) {
      relevant = true;
      latencyPosition.marketState = marketStateAfterEvent(event, latencyPosition.supplyRaw);
      latencyPosition.lastSwapTimestamp = event.timestamp;
      latencyPosition.lastSwapReceivedAtMs = event.receivedAtMs;
      latencyPosition.externalSwaps += 1;
      this.recordPositionFlow(latencyPosition, event);
      await this.evaluateLatency(latencyPosition, event.receivedAtMs, 'swap');
    }
    const candidate = this.candidates.get(event.pool);
    if (candidate) {
      relevant = true;
      this.observeCandidate(candidate, event);
      if (candidate.approved && !candidate.fastPathDiagnostic && event.receivedAtMs >= candidate.fastPathNotBeforeMs) {
        this.captureFastPathDiagnostic(candidate, event);
      }
      if (candidate.approved && !candidate.fastPathComplete && event.receivedAtMs >= candidate.fastPathNotBeforeMs) {
        await this.executeLatencyCandidate(candidate, event);
      }
      if (candidate.approved && event.receivedAtMs >= candidate.landingNotBeforeMs) await this.executeCandidate(candidate, event);
    } else if (!position && !latencyPosition && shadows.length === 0) this.bufferPreMigration(event);
    if (relevant) {
      this.eventJournalQueue = this.eventJournalQueue
        .then(() => appendJsonl(path.join(this.dataRoot, 'events', 'pumpswap-swaps.jsonl'), event))
        .catch((error) => this.options.onError?.(error));
    }
  }

  recordPositionFlow(position, event) {
    const amountSol = eventQuoteSol(event);
    if (event.side === 'buy') {
      position.externalBuySol = (position.externalBuySol ?? 0) + amountSol;
      position.largestExternalBuySol = Math.max(position.largestExternalBuySol ?? 0, amountSol);
    } else {
      position.externalSellSol = (position.externalSellSol ?? 0) + amountSol;
      position.largestExternalSellSol = Math.max(position.largestExternalSellSol ?? 0, amountSol);
    }
    if (position.pendingExit && event.receivedSequence > position.pendingExit.triggerReceivedSequence) {
      const competition = position.pendingExit.competition;
      competition.observedEvents += 1;
      if (event.side === 'buy') {
        competition.observedBuys += 1;
        competition.buySol += amountSol;
        competition.largestBuySol = Math.max(competition.largestBuySol, amountSol);
      } else {
        competition.observedSells += 1;
        competition.sellSol += amountSol;
        competition.largestSellSol = Math.max(competition.largestSellSol, amountSol);
      }
    }
  }

  decisionReasons(candidate) {
    const selector = this.config.selector;
    const reasons = [];
    const opening = candidate.events.filter((event) => event.timestamp >= candidate.migrationTime
      && event.timestamp <= candidate.migrationTime + this.config.observationWindowSeconds);
    const quoteReserveSol = opening[0]?.quoteReserveRaw / 1e9;
    if (!candidate.actualState || !Number.isFinite(quoteReserveSol)) reasons.push('no authoritative executable reserve state');
    if (candidate.preMigrationDroppedEvents > 0 || candidate.droppedEvents > 0) {
      reasons.push(`incomplete competition tape: ${candidate.preMigrationDroppedEvents + candidate.droppedEvents} event(s) dropped`);
    }
    if (Number.isFinite(quoteReserveSol) && quoteReserveSol < selector.minimumQuoteReserveSol) reasons.push(`quote reserve below ${selector.minimumQuoteReserveSol} SOL`);
    if (Number.isFinite(quoteReserveSol) && quoteReserveSol > selector.maximumQuoteReserveSol) reasons.push(`quote reserve above ${selector.maximumQuoteReserveSol} SOL`);
    if (candidate.largestOpeningSwapSol > selector.maximumLargestOpeningSwapSol) reasons.push(`opening swap ${candidate.largestOpeningSwapSol.toFixed(2)} SOL exceeds ${selector.maximumLargestOpeningSwapSol}`);
    if (candidate.buyers.size < selector.minimumIndependentBuyers) reasons.push(`only ${candidate.buyers.size} opening buyer(s)`);
    if (opening.length < selector.minimumOpeningSwaps) reasons.push(`only ${opening.length} opening swap(s)`);
    return { reasons, quoteReserveSol, openingSwaps: opening.length };
  }

  async decide(pool) {
    const candidate = this.candidates.get(pool);
    if (!candidate || candidate.decided) return;
    candidate.decided = true;
    candidate.decidedAtMs = Date.now();
    const { reasons, quoteReserveSol, openingSwaps } = this.decisionReasons(candidate);
    const decision = reasons.length ? 'SKIP' : 'QUALIFY';
    candidate.decisionReceivedSequence = candidate.latestEvent?.receivedSequence ?? candidate.migrationLogReceivedSequence ?? 0;
    if (decision === 'QUALIFY') {
      candidate.submittedAtMs = Date.now();
      candidate.fastPathNotBeforeMs = candidate.submittedAtMs + this.config.execution.fastPathDiagnosticMs;
      candidate.landingNotBeforeMs = candidate.submittedAtMs + this.config.execution.simulatedLandingDelayMs;
    }
    const row = {
      at: candidate.decidedAtMs, version: this.config.version, decision, reasons, pool, mint: candidate.mint,
      name: candidate.name, symbol: candidate.symbol, migrationTime: candidate.migrationTime, detectedAtMs: candidate.detectedAtMs,
      migrationBlockTimeMs: candidate.migrationTime * 1_000,
      migrationLogReceivedAtMs: candidate.migrationLogReceivedAtMs,
      migrationResolvedAtMs: candidate.migrationResolvedAtMs,
      migrationResolutionMs: candidate.migrationResolutionMs,
      decisionReceivedSequence: candidate.decisionReceivedSequence,
      submittedAtMs: candidate.submittedAtMs ?? null,
      fastPathTargetAtMs: candidate.fastPathNotBeforeMs ?? null,
      conservativeLandingTargetAtMs: candidate.landingNotBeforeMs ?? null,
      quoteReserveSol, openingSwaps, independentBuyers: candidate.buyers.size,
      largestOpeningSwapSol: candidate.largestOpeningSwapSol, openingNetFlowSol: candidate.openingBuysSol - candidate.openingSellsSol,
    };
    this.state.decisions += 1;
    await appendJsonl(path.join(this.paperRoot, 'decisions.jsonl'), row);
    if (decision === 'SKIP') {
      this.state.skipped += 1;
      this.candidates.delete(pool);
    } else {
      candidate.approved = true;
      if (this.latencyAccount) this.latencyState.matchedSignals += 1;
      const expiresAt = candidate.landingNotBeforeMs + this.config.execution.maximumLandingWaitMs;
      setTimeout(() => this.expireCandidate(pool).catch((error) => this.options.onError?.(error)), Math.max(0, expiresAt - Date.now())).unref();
    }
    await Promise.all([this.persist(), this.persistLatency()]);
    void postDiscord('decisionLog', {
      title: `${decision}: ${candidate.symbol ?? candidate.mint.slice(0, 8)}`,
      description: decision === 'QUALIFY'
        ? `Selector passed. FAST-170 and SAFE-1000 accounts are independently waiting for their authoritative post-target states.`
        : reasons.join('\n'),
      color: decision === 'QUALIFY' ? 0x45e6b0 : 0xffc857,
      fields: [
        { name: 'Opening reserve', value: quoteReserveSol == null ? 'Unavailable' : formatSol(quoteReserveSol), inline: true },
        { name: 'Largest opening swap', value: formatSol(candidate.largestOpeningSwapSol), inline: true },
        { name: 'Independent buyers', value: String(candidate.buyers.size), inline: true },
        { name: 'Migration resolve latency', value: candidate.migrationResolutionMs == null ? 'Unavailable' : `${candidate.migrationResolutionMs}ms`, inline: true },
        { name: 'Strategy', value: this.config.version },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  async expireCandidate(pool) {
    const candidate = this.candidates.get(pool);
    if (!candidate?.approved) return;
    if (!candidate.fastPathComplete) await this.skipLatencyCandidate(candidate, 'no authoritative event arrived inside the FAST-170 landing window');
    if (this.candidates.has(pool)) await this.skipExecution(candidate, 'no confirmed post-delay swap arrived inside the SAFE-1000 landing window');
  }

  async skipExecution(candidate, reason) {
    this.state.skipped += 1;
    this.candidates.delete(candidate.pool);
    await appendJsonl(path.join(this.paperRoot, 'execution-skips.jsonl'), {
      at: Date.now(), version: this.config.version, pool: candidate.pool, mint: candidate.mint, symbol: candidate.symbol, reason,
      migrationBlockTimeMs: candidate.migrationTime * 1_000,
      migrationLogReceivedAtMs: candidate.migrationLogReceivedAtMs,
      migrationResolvedAtMs: candidate.migrationResolvedAtMs,
      submittedAtMs: candidate.submittedAtMs ?? null,
      dumpMetrics: candidate.dumpMetricsAtEntry ?? null,
      competition: candidate.latestEvent ? this.competitionStats(candidate, candidate.latestEvent.receivedSequence) : null,
    });
    await this.persist();
    void postDiscord('decisionLog', {
      title: `NO FILL: ${candidate.symbol ?? candidate.mint.slice(0, 8)}`, description: reason, color: 0xffc857,
    }).catch((error) => this.options.onError?.(error));
  }

  createPosition(candidate, event, sizeSol, label, evidence = {}) {
    const marketState = { ...candidate.actualState };
    const quote = quoteBuyWithSol(marketState, sizeSol);
    const supplyRaw = marketState.baseSupplyRaw;
    const solUsd = this.solUsd ?? candidate.solUsd ?? null;
    const entryMarketCap = fillMarketCap({ quoteSol: quote.spendSol, tokensRaw: quote.tokensRaw, supplyRaw, solUsd });
    const entrySpotMarketCapSol = spotMarketCapSol(marketState);
    return {
      id: `${candidate.pool}:${event.receivedSequence}:${label}`, cohort: label, pool: candidate.pool, mint: candidate.mint,
      name: candidate.name, symbol: candidate.symbol, entryTimestamp: event.timestamp, entryAtMs: event.receivedAtMs,
      entryIso: new Date(event.receivedAtMs).toISOString(), entrySlot: event.slot, entryAfterSignature: event.signature,
      migrationBlockTimeMs: candidate.migrationTime * 1_000,
      migrationLogReceivedAtMs: candidate.migrationLogReceivedAtMs,
      migrationResolvedAtMs: candidate.migrationResolvedAtMs,
      migrationResolutionMs: candidate.migrationResolutionMs,
      decisionAtMs: candidate.decidedAtMs,
      submittedAtMs: candidate.submittedAtMs,
      fastPathTargetAtMs: candidate.fastPathNotBeforeMs,
      conservativeLandingTargetAtMs: candidate.landingNotBeforeMs,
      entryReceivedSequence: event.receivedSequence, simulatedLandingDelayMs: event.receivedAtMs - candidate.submittedAtMs,
      modeledEntryTargetMs: evidence.entryTargetMs ?? this.config.execution.simulatedLandingDelayMs,
      modeledExitTargetMs: evidence.exitTargetMs ?? this.config.execution.simulatedExitLandingDelayMs,
      executionModel: evidence.executionModel ?? 'SAFE-1000',
      competitionBeforeEntry: evidence.competition ?? candidate.competitionAtEntry,
      fastPathDiagnostic: evidence.fastPathDiagnostic ?? candidate.fastPathDiagnostic,
      dumpMetricsAtEntry: evidence.dumpMetrics ?? candidate.dumpMetricsAtEntry,
      sizeSol, tokensRaw: quote.tokensRaw, tokens: quote.tokens, supplyRaw, solUsdAtEntry: solUsd,
      entryAveragePriceSol: quote.spendSol / quote.tokens, entryMarketCapSol: entryMarketCap.sol,
      entryMarketCapUsd: entryMarketCap.usd, entrySpotMarketCapSol,
      entrySpotMarketCapUsd: Number.isFinite(solUsd) ? entrySpotMarketCapSol * solUsd : null,
      marketState, entryFeeBasisPoints: quote.totalFeeBasisPoints, externalSwaps: 0,
      externalBuySol: 0, externalSellSol: 0, largestExternalBuySol: 0, largestExternalSellSol: 0,
      lastSwapTimestamp: event.timestamp, lastSwapReceivedAtMs: event.receivedAtMs, status: 'OPEN',
    };
  }

  async skipLatencyCandidate(candidate, reason, evidence = {}) {
    if (candidate.fastPathComplete) return;
    candidate.fastPathComplete = true;
    this.latencyState.skipped += 1;
    await appendJsonl(path.join(this.paperRoot, 'latency-account-skips.jsonl'), {
      at: Date.now(), version: this.config.version, account: this.latencyAccount.name,
      pool: candidate.pool, mint: candidate.mint, symbol: candidate.symbol, reason, ...evidence,
    });
    await this.persistLatency();
  }

  async executeLatencyCandidate(candidate, event) {
    if (!this.latencyAccount || candidate.fastPathComplete) return;
    const reasons = [];
    if (Object.keys(this.latencyState.openPositions).length >= this.config.maxConcurrentPositions) {
      reasons.push('maximum FAST-170 concurrent positions reached');
    }
    if (this.latencyState.availableBankrollSol < this.latencyAccount.positionSizeSol + this.config.fixedCostPerTransactionSol) {
      reasons.push('insufficient FAST-170 bankroll at landing');
    }
    const dumpMetrics = this.dumpMetrics(candidate, event.receivedAtMs);
    reasons.push(...dumpMetrics.reasons);
    const competition = this.competitionStats(candidate, event.receivedSequence);
    if (!candidate.fastPathDiagnostic) this.captureFastPathDiagnostic(candidate, event);
    if (reasons.length) return this.skipLatencyCandidate(candidate, reasons.join('; '), { dumpMetrics, competition });
    let position;
    try {
      position = this.createPosition(candidate, event, this.latencyAccount.positionSizeSol, this.latencyAccount.name, {
        entryTargetMs: this.latencyAccount.entryTargetMs,
        exitTargetMs: this.latencyAccount.exitTargetMs,
        executionModel: this.latencyAccount.name,
        competition,
        dumpMetrics,
        fastPathDiagnostic: candidate.fastPathDiagnostic,
      });
    } catch (error) {
      return this.skipLatencyCandidate(candidate, `FAST-170 authoritative quote failed: ${error.message}`, { dumpMetrics, competition });
    }
    candidate.fastPathComplete = true;
    this.latencyState.availableBankrollSol -= position.sizeSol + this.config.fixedCostPerTransactionSol;
    this.latencyState.openPositions[candidate.pool] = position;
    this.latencyState.entered += 1;
    await appendJsonl(path.join(this.paperRoot, 'latency-account-entries.jsonl'), position);
    await this.persistLatency();
    void postDiscord('paperTrades', {
      title: `${this.latencyAccount.name} PAPER ENTRY: ${candidate.symbol ?? candidate.mint.slice(0, 8)}`,
      description: `Independent ${this.latencyAccount.entryTargetMs}ms-target account entered at the first authoritative state observable after its target.`,
      color: 0x9b7cff,
      fields: [
        { name: 'Size', value: formatSol(position.sizeSol), inline: true },
        { name: 'Average fill MC', value: formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol), inline: true },
        { name: 'Target → observed', value: `${position.modeledEntryTargetMs}ms → ${position.simulatedLandingDelayMs}ms`, inline: true },
        { name: 'Observed ahead', value: formatCompetition(position.competitionBeforeEntry) },
        { name: 'Account bankroll', value: formatSol(this.latencyState.availableBankrollSol), inline: true },
        { name: 'Mint', value: `\`${candidate.mint}\`` },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  async executeCandidate(candidate, event) {
    if (!this.candidates.has(candidate.pool)) return;
    const reasons = [];
    if (Object.keys(this.state.openPositions).length >= this.config.maxConcurrentPositions) reasons.push('maximum concurrent positions reached at landing');
    if (this.state.availableBankrollSol < this.config.positionSizeSol + this.config.fixedCostPerTransactionSol) reasons.push('insufficient baseline bankroll at landing');
    candidate.dumpMetricsAtEntry = this.dumpMetrics(candidate, event.receivedAtMs);
    reasons.push(...candidate.dumpMetricsAtEntry.reasons);
    if (reasons.length) return this.skipExecution(candidate, reasons.join('; '));
    candidate.competitionAtEntry = this.competitionStats(candidate, event.receivedSequence);
    if (!candidate.fastPathDiagnostic) this.captureFastPathDiagnostic(candidate, event);
    let position;
    let shadows;
    try {
      position = this.createPosition(candidate, event, this.config.positionSizeSol, 'baseline');
      shadows = this.shadowSizes.map((size) => this.createPosition(candidate, event, size, `${size}-SOL`));
    } catch (error) { return this.skipExecution(candidate, `authoritative quote failed: ${error.message}`); }
    this.state.availableBankrollSol -= position.sizeSol + this.config.fixedCostPerTransactionSol;
    this.state.openPositions[candidate.pool] = position;
    this.state.entered += 1;
    this.shadowState.matchedSignals += 1;
    for (const shadow of shadows) this.shadowState.cohorts[String(shadow.sizeSol)].openPositions[candidate.pool] = shadow;
    this.candidates.delete(candidate.pool);
    await appendJsonl(path.join(this.paperRoot, 'entries.jsonl'), position);
    for (const shadow of shadows) await appendJsonl(path.join(this.paperRoot, 'size-shadow-entries.jsonl'), shadow);
    await Promise.all([this.persist(), this.persistShadows()]);
    void postDiscord('paperTrades', {
      title: `PAPER ENTRY: ${candidate.symbol ?? candidate.mint.slice(0, 8)}`,
      description: 'Confirmed post-delay PumpSwap state quoted with event-native reserves and fees.', color: 0x4da3ff,
      fields: [
        { name: 'Size', value: formatSol(position.sizeSol), inline: true },
        { name: 'Average fill MC', value: formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol), inline: true },
        { name: 'Spot MC before fill', value: formatMarketCap(position.entrySpotMarketCapUsd, position.entrySpotMarketCapSol), inline: true },
        { name: 'Landing delay', value: `${position.simulatedLandingDelayMs}ms`, inline: true },
        { name: 'Observed ahead of us', value: `${position.competitionBeforeEntry.observedBuys} buys · ${position.competitionBeforeEntry.buySol.toFixed(3)} SOL`, inline: true },
        { name: '170ms diagnostic MC', value: formatMarketCap(position.fastPathDiagnostic?.averageFillMarketCapUsd, position.fastPathDiagnostic?.averageFillMarketCapSol), inline: true },
        { name: 'Bankroll available', value: formatSol(this.state.availableBankrollSol), inline: true },
        { name: 'Size shadows', value: this.shadowSizes.map((size) => `${size} SOL`).join(' · ') },
        { name: 'Mint', value: `\`${candidate.mint}\`` },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  mark(position) {
    const quote = quoteSellTokens(position.marketState, position.tokensRaw);
    const pnlSol = quote.proceedsSol - position.sizeSol - 2 * this.config.fixedCostPerTransactionSol;
    const solUsd = this.solUsd ?? position.solUsdAtEntry ?? null;
    const marketCap = fillMarketCap({ quoteSol: quote.proceedsSol, tokensRaw: position.tokensRaw, supplyRaw: position.supplyRaw, solUsd });
    const exitSpotMarketCapSol = spotMarketCapSol(position.marketState);
    return {
      proceeds: quote.proceedsSol, pnlSol, returnPct: 100 * pnlSol / position.sizeSol,
      exitFeeBasisPoints: quote.totalFeeBasisPoints, exitAveragePriceSol: quote.proceedsSol / position.tokens,
      exitMarketCapSol: marketCap.sol, exitMarketCapUsd: marketCap.usd, exitSpotMarketCapSol,
      exitSpotMarketCapUsd: Number.isFinite(solUsd) ? exitSpotMarketCapSol * solUsd : null, solUsdAtExit: solUsd,
    };
  }

  async evaluate(position, atMs, source) {
    if (position.closing || position.pendingExit) return;
    let mark;
    try { mark = this.mark(position); } catch { return; }
    const ageSeconds = (atMs - position.entryAtMs) / 1_000;
    let reason = null;
    if (mark.returnPct >= this.config.takeProfitPct) reason = 'TAKE_PROFIT';
    else if (mark.returnPct <= -this.config.stopLossPct) reason = 'STOP_LOSS';
    else if (ageSeconds >= this.config.timeoutSeconds) reason = 'TIMEOUT';
    if (reason) await this.beginExit(position, atMs, reason, source, mark);
  }

  async evaluateShadow(cohort, position, atMs, source) {
    if (position.closing || position.pendingExit) return;
    let mark;
    try { mark = this.mark(position); } catch { return; }
    const ageSeconds = (atMs - position.entryAtMs) / 1_000;
    let reason = null;
    if (mark.returnPct >= this.config.takeProfitPct) reason = 'TAKE_PROFIT';
    else if (mark.returnPct <= -this.config.stopLossPct) reason = 'STOP_LOSS';
    else if (ageSeconds >= this.config.timeoutSeconds) reason = 'TIMEOUT';
    if (reason) await this.beginShadowExit(cohort, position, atMs, reason, source, mark);
  }

  async evaluateLatency(position, atMs, source) {
    if (position.closing || position.pendingExit) return;
    let mark;
    try { mark = this.mark(position); } catch { return; }
    const ageSeconds = (atMs - position.entryAtMs) / 1_000;
    let reason = null;
    if (mark.returnPct >= this.config.takeProfitPct) reason = 'TAKE_PROFIT';
    else if (mark.returnPct <= -this.config.stopLossPct) reason = 'STOP_LOSS';
    else if (ageSeconds >= this.config.timeoutSeconds) reason = 'TIMEOUT';
    if (reason) await this.beginLatencyExit(position, atMs, reason, source, mark);
  }

  pendingExit(reason, source, atMs, position, mark) {
    return {
      reason,
      source,
      triggerAtMs: atMs,
      triggerIso: new Date(atMs).toISOString(),
      triggerReceivedSequence: position.marketState.sourceReceivedSequence ?? position.entryReceivedSequence,
      triggerReturnPct: round(mark.returnPct, 3),
      landingTargetAtMs: atMs + (position.modeledExitTargetMs ?? this.config.execution.simulatedExitLandingDelayMs),
      competition: {
        observedEvents: 0, observedBuys: 0, observedSells: 0,
        buySol: 0, sellSol: 0, largestBuySol: 0, largestSellSol: 0,
      },
    };
  }

  async beginExit(position, atMs, reason, source, mark) {
    position.pendingExit = this.pendingExit(reason, source, atMs, position, mark);
    await this.persist();
    const delay = Math.max(0, position.pendingExit.landingTargetAtMs - Date.now());
    setTimeout(() => this.finalizeExit(position.pool, position.id).catch((error) => this.options.onError?.(error)), delay).unref();
  }

  async beginShadowExit(cohort, position, atMs, reason, source, mark) {
    position.pendingExit = this.pendingExit(reason, source, atMs, position, mark);
    await this.persistShadows();
    const delay = Math.max(0, position.pendingExit.landingTargetAtMs - Date.now());
    setTimeout(() => this.finalizeShadowExit(cohort.sizeSol, position.pool, position.id).catch((error) => this.options.onError?.(error)), delay).unref();
  }

  async beginLatencyExit(position, atMs, reason, source, mark) {
    position.pendingExit = this.pendingExit(reason, source, atMs, position, mark);
    await this.persistLatency();
    const delay = Math.max(0, position.pendingExit.landingTargetAtMs - Date.now());
    setTimeout(() => this.finalizeLatencyExit(position.pool, position.id).catch((error) => this.options.onError?.(error)), delay).unref();
  }

  async finalizeExit(pool, id) {
    const position = this.state.openPositions[pool];
    if (!position || position.id !== id || !position.pendingExit) return;
    const mark = this.mark(position);
    await this.closePosition(position, Date.now(), position.pendingExit.reason, 'modeled-exit-landing', mark);
  }

  async finalizeShadowExit(sizeSol, pool, id) {
    const cohort = this.shadowState.cohorts[String(sizeSol)];
    const position = cohort?.openPositions?.[pool];
    if (!position || position.id !== id || !position.pendingExit) return;
    const mark = this.mark(position);
    await this.closeShadowPosition(cohort, position, Date.now(), position.pendingExit.reason, 'modeled-exit-landing', mark);
  }

  async finalizeLatencyExit(pool, id) {
    const position = this.latencyState.openPositions[pool];
    if (!position || position.id !== id || !position.pendingExit) return;
    const mark = this.mark(position);
    await this.closeLatencyPosition(position, Date.now(), position.pendingExit.reason, 'modeled-fast-exit-landing', mark);
  }

  resultFrom(position, atMs, reason, source, mark) {
    const pendingExit = position.pendingExit ?? null;
    return {
      ...position, marketState: undefined, status: 'CLOSED', exitAtMs: atMs,
      exitTimestamp: position.marketState.sourceTimestamp, exitIso: new Date(atMs).toISOString(),
      exitSlot: position.marketState.sourceSlot, exitAfterSignature: position.marketState.sourceSignature,
      exitReason: reason, exitSource: source, holdSeconds: round((atMs - position.entryAtMs) / 1_000, 3),
      exitTriggeredAtMs: pendingExit?.triggerAtMs ?? atMs,
      exitTriggeredIso: pendingExit?.triggerIso ?? new Date(atMs).toISOString(),
      exitLandingTargetAtMs: pendingExit?.landingTargetAtMs ?? atMs,
      simulatedExitLandingDelayMs: pendingExit ? atMs - pendingExit.triggerAtMs : 0,
      competitionBeforeExit: pendingExit?.competition ?? null,
      grossProceedsSol: round(mark.proceeds), pnlSol: round(mark.pnlSol), returnPct: round(mark.returnPct, 3),
      exitAveragePriceSol: mark.exitAveragePriceSol, exitMarketCapSol: mark.exitMarketCapSol,
      exitMarketCapUsd: mark.exitMarketCapUsd, exitSpotMarketCapSol: mark.exitSpotMarketCapSol,
      exitSpotMarketCapUsd: mark.exitSpotMarketCapUsd, exitFeeBasisPoints: mark.exitFeeBasisPoints, solUsdAtExit: mark.solUsdAtExit,
    };
  }

  async closePosition(position, atMs, reason, source, mark = this.mark(position)) {
    position.closing = true;
    this.state.availableBankrollSol += mark.proceeds - this.config.fixedCostPerTransactionSol;
    this.state.realizedPnlSol += mark.pnlSol;
    this.state.completedTrades += 1;
    this.state[mark.pnlSol > 0 ? 'wins' : 'losses'] += 1;
    delete this.state.openPositions[position.pool];
    const result = { ...this.resultFrom(position, atMs, reason, source, mark), bankrollSol: round(this.state.availableBankrollSol) };
    await appendJsonl(path.join(this.paperRoot, 'exits.jsonl'), result);
    await this.persist();
    const won = result.pnlSol > 0;
    void postDiscord('paperTrades', {
      title: `PAPER EXIT: ${position.symbol ?? position.mint.slice(0, 8)} · ${reason}`,
      description: won ? 'Authoritative-state paper trade closed profitably.' : 'Authoritative-state paper trade closed at a loss.',
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Net PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Return', value: `${result.returnPct >= 0 ? '+' : ''}${result.returnPct.toFixed(2)}%`, inline: true },
        { name: 'Entry fill MC', value: formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol), inline: true },
        { name: 'Exit fill MC', value: formatMarketCap(result.exitMarketCapUsd, result.exitMarketCapSol), inline: true },
        { name: 'Hold', value: `${result.holdSeconds}s`, inline: true }, { name: 'Bankroll', value: formatSol(result.bankrollSol), inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
    void postDiscord('pnl', {
      title: '0.5 SOL BASELINE PNL', description: `${position.symbol ?? position.mint.slice(0, 8)} closed · ${reason}`,
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Trade PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Cumulative PnL', value: `${this.state.realizedPnlSol >= 0 ? '+' : ''}${formatSol(this.state.realizedPnlSol)}`, inline: true },
        { name: 'Entry → Exit MC', value: `${formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol)} → ${formatMarketCap(result.exitMarketCapUsd, result.exitMarketCapSol)}` },
        { name: 'Record', value: `${this.state.wins}W · ${this.state.losses}L`, inline: true },
        { name: 'Completed', value: String(this.state.completedTrades), inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
    void postDiscord('caseStudies', {
      threadName: `${position.symbol ?? position.mint.slice(0, 8)} · ${reason} · ${result.exitIso.slice(11, 19)}`,
      title: `${position.name ?? position.symbol ?? 'Token'} paper case study`,
      description: `Qualified signal → delayed confirmed-state fill → event-native quote → ${reason}.`, color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Mint', value: `\`${position.mint}\`` }, { name: 'Entry', value: position.entryIso, inline: true },
        { name: 'Exit', value: result.exitIso, inline: true },
        { name: 'Entry average-fill MC', value: formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol), inline: true },
        { name: 'Exit average-fill MC', value: formatMarketCap(result.exitMarketCapUsd, result.exitMarketCapSol), inline: true },
        { name: 'Observed spot MC before entry', value: formatMarketCap(position.entrySpotMarketCapUsd, position.entrySpotMarketCapSol), inline: true },
        { name: 'Observed spot MC before exit', value: formatMarketCap(result.exitSpotMarketCapUsd, result.exitSpotMarketCapSol), inline: true },
        { name: 'Outcome', value: `${result.pnlSol >= 0 ? '+' : ''}${result.pnlSol.toFixed(4)} SOL (${result.returnPct.toFixed(2)}%)` },
        { name: 'Lifecycle timestamps', value: [
          `Migration block (coarse): ${new Date(position.migrationBlockTimeMs).toISOString()}`,
          `Migration log received: ${position.migrationLogReceivedAtMs ? new Date(position.migrationLogReceivedAtMs).toISOString() : 'Unavailable'}`,
          `Migration resolved: ${position.migrationResolvedAtMs ? new Date(position.migrationResolvedAtMs).toISOString() : 'Unavailable'}`,
          `Signal/submission: ${new Date(position.submittedAtMs).toISOString()}`,
          `Modeled entry fill: ${position.entryIso}`,
          `Exit triggered: ${result.exitTriggeredIso}`,
          `Modeled exit fill: ${result.exitIso}`,
        ].join('\n') },
        { name: 'Pipeline latency', value: [
          `Block→log: ~${position.migrationLogReceivedAtMs == null ? '?' : position.migrationLogReceivedAtMs - position.migrationBlockTimeMs}ms (block time is second-granularity)`,
          `Log→resolved: ${position.migrationResolutionMs ?? '?'}ms`,
          `Resolved→signal: ${position.migrationResolvedAtMs == null ? '?' : position.submittedAtMs - position.migrationResolvedAtMs}ms`,
          `Signal→entry: ${position.simulatedLandingDelayMs}ms`,
          `Exit trigger→fill: ${result.simulatedExitLandingDelayMs}ms`,
        ].join('\n') },
        { name: 'Execution evidence', value: `Entry after slot ${position.entrySlot} · entry ${position.simulatedLandingDelayMs}ms · exit ${result.simulatedExitLandingDelayMs}ms · ${position.externalSwaps} later swaps` },
        { name: 'Competition before entry', value: `${formatCompetition(position.competitionBeforeEntry)} · estimated buy position #${position.competitionBeforeEntry?.estimatedPositionBehindObservedBuys ?? '?'}` },
        { name: 'Top wallets buying ahead', value: formatTopWallets(position.competitionBeforeEntry?.topObservedBuyers) },
        { name: 'Competition before exit', value: formatCompetition(result.competitionBeforeExit) },
        { name: 'Dump guard at entry', value: `${position.dumpMetricsAtEntry?.peakDrawdownPct?.toFixed?.(1) ?? '0.0'}% off observed peak · ${Number(position.dumpMetricsAtEntry?.sellSol ?? 0).toFixed(3)} SOL sold in ${position.dumpMetricsAtEntry?.windowMs ?? 1000}ms` },
        { name: 'FAST-170 observed entry state', value: `${formatMarketCap(position.fastPathDiagnostic?.averageFillMarketCapUsd, position.fastPathDiagnostic?.averageFillMarketCapSol)} observed after ${position.fastPathDiagnostic?.observedDelayMs ?? '?'}ms; matched account tracked separately` },
        { name: 'MC method', value: Number.isFinite(position.solUsdAtEntry) && Number.isFinite(result.solUsdAtExit)
          ? `Average executable fill × supply · SOL/USD entry $${Number(position.solUsdAtEntry).toFixed(2)}, exit $${Number(result.solUsdAtExit).toFixed(2)}`
          : 'Average executable fill × supply (SOL-denominated; USD conversion unavailable)' },
        { name: 'Method version', value: this.config.version },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  async closeShadowPosition(cohort, position, atMs, reason, source, mark = this.mark(position)) {
    position.closing = true;
    cohort.realizedPnlSol += mark.pnlSol;
    cohort.completedTrades += 1;
    cohort[mark.pnlSol > 0 ? 'wins' : 'losses'] += 1;
    delete cohort.openPositions[position.pool];
    const result = { ...this.resultFrom(position, atMs, reason, source, mark), cohortRealizedPnlSol: round(cohort.realizedPnlSol) };
    await appendJsonl(path.join(this.paperRoot, 'size-shadow-exits.jsonl'), result);
    await this.persistShadows();
    const won = result.pnlSol > 0;
    void postDiscord('pnl', {
      title: `${position.sizeSol} SOL SHADOW PNL`, description: `${position.symbol ?? position.mint.slice(0, 8)} closed · ${reason}`,
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Trade PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Cumulative PnL', value: `${cohort.realizedPnlSol >= 0 ? '+' : ''}${formatSol(cohort.realizedPnlSol)}`, inline: true },
        { name: 'Entry → Exit MC', value: `${formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol)} → ${formatMarketCap(result.exitMarketCapUsd, result.exitMarketCapSol)}` },
        { name: 'Record', value: `${cohort.wins}W · ${cohort.losses}L`, inline: true },
        { name: 'Completed', value: String(cohort.completedTrades), inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  async closeLatencyPosition(position, atMs, reason, source, mark = this.mark(position)) {
    position.closing = true;
    this.latencyState.availableBankrollSol += mark.proceeds - this.config.fixedCostPerTransactionSol;
    this.latencyState.realizedPnlSol += mark.pnlSol;
    this.latencyState.completedTrades += 1;
    this.latencyState[mark.pnlSol > 0 ? 'wins' : 'losses'] += 1;
    delete this.latencyState.openPositions[position.pool];
    const result = {
      ...this.resultFrom(position, atMs, reason, source, mark),
      accountBankrollSol: round(this.latencyState.availableBankrollSol),
      accountRealizedPnlSol: round(this.latencyState.realizedPnlSol),
    };
    await appendJsonl(path.join(this.paperRoot, 'latency-account-exits.jsonl'), result);
    await this.persistLatency();
    const won = result.pnlSol > 0;
    void postDiscord('pnl', {
      title: `${this.latencyAccount.name} PNL`,
      description: `${position.symbol ?? position.mint.slice(0, 8)} closed · ${reason}`,
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Trade PnL', value: `${result.pnlSol >= 0 ? '+' : ''}${formatSol(result.pnlSol)}`, inline: true },
        { name: 'Cumulative PnL', value: `${this.latencyState.realizedPnlSol >= 0 ? '+' : ''}${formatSol(this.latencyState.realizedPnlSol)}`, inline: true },
        { name: 'Entry → Exit MC', value: `${formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol)} → ${formatMarketCap(result.exitMarketCapUsd, result.exitMarketCapSol)}` },
        { name: 'Entry target → observed', value: `${position.modeledEntryTargetMs}ms → ${position.simulatedLandingDelayMs}ms`, inline: true },
        { name: 'Exit target → observed', value: `${position.modeledExitTargetMs}ms → ${result.simulatedExitLandingDelayMs}ms`, inline: true },
        { name: 'Record', value: `${this.latencyState.wins}W · ${this.latencyState.losses}L`, inline: true },
      ],
    }).catch((error) => this.options.onError?.(error));
    void postDiscord('caseStudies', {
      threadName: `${position.symbol ?? position.mint.slice(0, 8)} · ${this.latencyAccount.name} · ${result.exitIso.slice(11, 19)}`,
      title: `${position.name ?? position.symbol ?? 'Token'} ${this.latencyAccount.name} case study`,
      description: `Independent ${position.modeledEntryTargetMs}ms entry / ${position.modeledExitTargetMs}ms exit account.`,
      color: won ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Mint', value: `\`${position.mint}\`` },
        { name: 'Entry average-fill MC', value: formatMarketCap(position.entryMarketCapUsd, position.entryMarketCapSol), inline: true },
        { name: 'Exit average-fill MC', value: formatMarketCap(result.exitMarketCapUsd, result.exitMarketCapSol), inline: true },
        { name: 'Outcome', value: `${result.pnlSol >= 0 ? '+' : ''}${result.pnlSol.toFixed(4)} SOL (${result.returnPct.toFixed(2)}%)` },
        { name: 'Signal → entry', value: `${new Date(position.submittedAtMs).toISOString()} → ${position.entryIso}\nTarget ${position.modeledEntryTargetMs}ms · observed ${position.simulatedLandingDelayMs}ms` },
        { name: 'Exit trigger → fill', value: `${result.exitTriggeredIso} → ${result.exitIso}\nTarget ${position.modeledExitTargetMs}ms · observed ${result.simulatedExitLandingDelayMs}ms` },
        { name: 'Competition before entry', value: formatCompetition(position.competitionBeforeEntry) },
        { name: 'Top wallets buying ahead', value: formatTopWallets(position.competitionBeforeEntry?.topObservedBuyers) },
        { name: 'Competition before exit', value: formatCompetition(result.competitionBeforeExit) },
        { name: 'Method version', value: this.config.version },
      ],
    }).catch((error) => this.options.onError?.(error));
  }

  async tick() {
    const now = Date.now();
    for (const position of Object.values(this.state.openPositions)) await this.evaluate(position, now, 'clock');
    for (const cohort of this.shadowCohorts()) for (const position of Object.values(cohort.openPositions)) await this.evaluateShadow(cohort, position, now, 'clock');
    for (const position of Object.values(this.latencyState.openPositions)) await this.evaluateLatency(position, now, 'clock');
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
      title: 'Authoritative paper account report', description: `Strategy: ${this.config.version}`,
      color: this.state.realizedPnlSol >= 0 ? 0x45e6b0 : 0xff5d73,
      fields: [
        { name: 'Bankroll', value: formatSol(this.state.availableBankrollSol), inline: true },
        { name: 'Realized PnL', value: formatSol(this.state.realizedPnlSol), inline: true },
        { name: 'Open positions', value: String(Object.keys(this.state.openPositions).length), inline: true },
        { name: 'Completed', value: String(completed), inline: true }, { name: 'Win rate', value: `${winRate.toFixed(1)}%`, inline: true },
        { name: 'Signals', value: `${this.state.entered} filled · ${this.state.skipped} skipped/unfilled` }, ...shadowFields,
        { name: `${this.latencyAccount?.name ?? 'FAST'} account`, value: `${this.latencyState.completedTrades} closed · ${this.latencyState.realizedPnlSol >= 0 ? '+' : ''}${this.latencyState.realizedPnlSol.toFixed(4)} SOL · ${Object.keys(this.latencyState.openPositions).length} open` },
      ],
    });
  }

  summary() {
    return {
      version: this.config.version, enabled: this.config.enabled, bankrollSol: round(this.state.availableBankrollSol),
      realizedPnlSol: round(this.state.realizedPnlSol), openPositions: Object.keys(this.state.openPositions).length,
      completedTrades: this.state.completedTrades, decisions: this.state.decisions, invalidatedTrades: this.state.invalidatedTrades,
      solUsd: this.solUsd,
      latencyAccount: {
        name: this.latencyAccount?.name ?? 'FAST', bankrollSol: round(this.latencyState.availableBankrollSol),
        realizedPnlSol: round(this.latencyState.realizedPnlSol), openPositions: Object.keys(this.latencyState.openPositions).length,
        completedTrades: this.latencyState.completedTrades, matchedSignals: this.latencyState.matchedSignals,
      },
      sizeShadows: this.shadowCohorts().map((cohort) => ({
        sizeSol: cohort.sizeSol, realizedPnlSol: round(cohort.realizedPnlSol),
        openPositions: Object.keys(cohort.openPositions).length, completedTrades: cohort.completedTrades,
      })),
    };
  }

  async invalidateOpenPositions(reason) {
    const positions = Object.values(this.state.openPositions);
    this.candidates.clear();
    this.preMigrationEvents.clear();
    for (const position of positions) {
      this.state.availableBankrollSol += position.sizeSol + this.config.fixedCostPerTransactionSol;
      this.state.invalidatedTrades += 1;
      await appendJsonl(path.join(this.paperRoot, 'invalidated.jsonl'), {
        ...position, marketState: undefined, status: 'INVALIDATED', invalidatedAt: Date.now(), reason,
      });
      delete this.state.openPositions[position.pool];
    }
    if (positions.length) await this.persist();
  }

  async invalidateShadowOpenPositions(reason) {
    let count = 0;
    for (const cohort of this.shadowCohorts()) {
      for (const position of Object.values(cohort.openPositions)) {
        cohort.invalidatedTrades += 1;
        count += 1;
        await appendJsonl(path.join(this.paperRoot, 'size-shadow-invalidated.jsonl'), {
          ...position, marketState: undefined, status: 'INVALIDATED', invalidatedAt: Date.now(), reason,
        });
        delete cohort.openPositions[position.pool];
      }
    }
    if (count) await this.persistShadows();
  }

  async invalidateLatencyOpenPositions(reason) {
    const positions = Object.values(this.latencyState.openPositions);
    for (const position of positions) {
      this.latencyState.availableBankrollSol += position.sizeSol + this.config.fixedCostPerTransactionSol;
      this.latencyState.invalidatedTrades += 1;
      await appendJsonl(path.join(this.paperRoot, 'latency-account-invalidated.jsonl'), {
        ...position, marketState: undefined, status: 'INVALIDATED', invalidatedAt: Date.now(), reason,
      });
      delete this.latencyState.openPositions[position.pool];
    }
    if (positions.length) await this.persistLatency();
  }

  stop() { clearInterval(this.timer); clearInterval(this.priceTimer); }
}
