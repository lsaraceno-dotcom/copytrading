import { randomBytes, randomUUID } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { INVO_REFRESH_TOKEN, INVO_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from './env.js';
import * as invo from './invo-client.js';
import * as hl from './hl-client.js';

interface Rules {
  maxLeverage: number;
  balanceFraction: number;
  maxPositionUsd: number;
  maxPriceDriftPct: number;
  copyIncreases: boolean;
}

interface TraderRules extends Partial<Rules> {
  enabled: boolean;
  sizeMultiplier?: number;
}

interface Config {
  pollIntervalMs: number;
  dryRun: boolean;
  tradingEnabled: boolean;
  allowedCoins: string[];
  maxOpenTrades: number;
  maxTotalExposureUsd: number;
  maxSignalAgeMs: number;
  minOpenNotionalUsd: number;
  protectiveOrdersEnabled: boolean;
  sizingMode: 'sourceAllocation' | 'fixedBalanceFraction';
  defaultRules: Rules;
  traders: Record<string, TraderRules>;
}

interface CopiedTrade {
  sourceBaseId: string;
  sourceBaseShortId?: string;
  invoBaseShortId?: string;
  postId: string;
  portfolioId: string;
  coin: string;
  side: 'long' | 'short';
  size: string;
  sourcePositionSize: number;
  sourceAllocationFraction: number;
  sourceUpdatedAt: string;
  leverage: number;
  priceTarget?: number;
  stopLoss?: number;
  tpCloid?: string;
  slCloid?: string;
  openedAt: string;
  status: 'open' | 'closed';
  dryRun: boolean;
  closedAt?: string;
}

interface State {
  schemaVersion: number;
  initialized: boolean;
  signals: Record<string, { status: string; at: string; reason?: string }>;
  trades: Record<string, CopiedTrade>;
  ignoredSourceTrades: Record<string, boolean>;
}

interface Signal {
  key: string;
  postId: string;
  isOpen: boolean;
  timestamp?: number;
  portfolioId: string;
  ownerId: string;
  coin: string;
  side: 'long' | 'short';
  leverage: number;
  entryPrice?: number;
  entrySizePercent?: number;
  positionSize: number;
  priceTarget?: number;
  stopLoss?: number;
  updatedAt: string;
  sourceBaseId: string;
  sourceBaseShortId?: string;
}

const configPath = resolve(process.env.TRADER_CONFIG ?? 'trader-config.json');
const statePath = resolve(process.env.TRADER_STATE ?? 'data/trader-state.json');
let stopping = false;

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
}

async function loadConfig(): Promise<Config> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Config;
  assertPositive('pollIntervalMs', config.pollIntervalMs);
  assertPositive('maxOpenTrades', config.maxOpenTrades);
  assertPositive('maxTotalExposureUsd', config.maxTotalExposureUsd);
  assertPositive('maxSignalAgeMs', config.maxSignalAgeMs);
  assertPositive('minOpenNotionalUsd', config.minOpenNotionalUsd);
  assertPositive('defaultRules.maxLeverage', config.defaultRules.maxLeverage);
  assertPositive('defaultRules.balanceFraction', config.defaultRules.balanceFraction);
  assertPositive('defaultRules.maxPositionUsd', config.defaultRules.maxPositionUsd);
  if (!['sourceAllocation', 'fixedBalanceFraction'].includes(config.sizingMode)) {
    throw new Error('sizingMode must be sourceAllocation or fixedBalanceFraction');
  }
  if (!Object.values(config.traders).some(t => t.enabled)) {
    throw new Error('No enabled portfolio IDs in trader-config.json');
  }
  return config;
}

async function loadState(): Promise<State> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as State;
    if (state.schemaVersion !== 4) {
      const legacyLiveTrades = Object.values(state.trades ?? {}).filter(trade => trade.status === 'open' && !trade.dryRun);
      if (legacyLiveTrades.length) {
        throw new Error('Legacy live trades require manual reconciliation before upgrading daemon state');
      }
      return { schemaVersion: 4, initialized: false, signals: {}, trades: {}, ignoredSourceTrades: {} };
    }
    state.signals ??= {};
    state.trades ??= {};
    state.ignoredSourceTrades ??= {};
    return state;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    return { schemaVersion: 4, initialized: false, signals: {}, trades: {}, ignoredSourceTrades: {} };
  }
}

async function saveState(state: State) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporaryPath, statePath);
}

function parseTimestamp(post: any): number | undefined {
  const value = post.createdAt ?? post.publishedAt ?? post.update?.createdAt;
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSignal(post: any): Signal | null {
  const update = post.update;
  if (!post.id || !update?.ticker || update.verifiedTrade !== true) return null;

  const portfolioId = update.portfolio?.id;
  const ownerId = update.owner?.id ?? post.owner?.id;
  const sourceBaseId = update.baseId;
  if (!portfolioId || !ownerId || !sourceBaseId) return null;

  const isOpen = update.isOpen === true;
  const updatedAt = String(update.closedAt ?? update.updatedAt ?? post.updatedAt ?? post.createdAt ?? new Date().toISOString());
  const positionSize = Math.abs(Number(update.positionSize ?? 0));
  const priceTarget = Number(update.priceTarget);
  const stopLoss = Number(update.stopLoss);
  const entrySizePercent = Number(update.entrySize);
  return {
    key: `${sourceBaseId}:${updatedAt}:${isOpen}:${Number(update.leverage) || 1}:${priceTarget || 0}:${stopLoss || 0}`,
    postId: post.id,
    isOpen,
    timestamp: Number.isFinite(new Date(updatedAt).getTime()) ? new Date(updatedAt).getTime() : parseTimestamp(post),
    portfolioId,
    ownerId,
    coin: String(update.ticker).toUpperCase(),
    side: update.directionLong ? 'long' : 'short',
    leverage: Number(update.leverage) || 1,
    entryPrice: Number(update.entryPrice) || undefined,
    entrySizePercent: entrySizePercent > 0 ? entrySizePercent : undefined,
    positionSize,
    priceTarget: priceTarget > 0 ? priceTarget : undefined,
    stopLoss: stopLoss > 0 ? stopLoss : undefined,
    updatedAt,
    sourceBaseId,
    sourceBaseShortId: update.baseShortId,
  };
}

function parsePortfolioInvestment(investment: any, observedAt: number): Signal | null {
  if (!investment?.id || !investment?.ticker || investment.verifiedTrade !== true) return null;
  const portfolioId = investment.portfolio?.id;
  const ownerId = investment.owner?.id;
  const sourceBaseId = investment.baseId;
  if (!portfolioId || !ownerId || !sourceBaseId) return null;

  const isOpen = investment.isOpen === true && investment.active !== false;
  const updatedAt = String(investment.closedAt ?? investment.updatedAt ?? investment.createdAt ?? new Date(observedAt).toISOString());
  const positionSize = Math.abs(Number(investment.positionSize ?? 0));
  const priceTarget = Number(investment.priceTarget);
  const stopLoss = Number(investment.stopLoss);
  const entrySizePercent = Number(investment.entrySize);
  return {
    key: `${sourceBaseId}:${updatedAt}:${isOpen}:${Number(investment.leverage) || 1}:${priceTarget || 0}:${stopLoss || 0}`,
    postId: investment.id,
    isOpen,
    timestamp: observedAt,
    portfolioId,
    ownerId,
    coin: String(investment.ticker).toUpperCase(),
    side: investment.directionLong ? 'long' : 'short',
    leverage: Number(investment.leverage) || 1,
    entryPrice: Number(investment.entryPrice) || undefined,
    entrySizePercent: entrySizePercent > 0 ? entrySizePercent : undefined,
    positionSize,
    priceTarget: priceTarget > 0 ? priceTarget : undefined,
    stopLoss: stopLoss > 0 ? stopLoss : undefined,
    updatedAt,
    sourceBaseId,
    sourceBaseShortId: investment.baseShortId,
  };
}

function mergedRules(config: Config, portfolioId: string): Rules & { sizeMultiplier: number } {
  const trader = config.traders[portfolioId];
  return {
    ...config.defaultRules,
    ...trader,
    sizeMultiplier: trader.sizeMultiplier ?? 1,
  };
}

function findBaseShortId(value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.baseShortId === 'string') return value.baseShortId;
  for (const child of Object.values(value)) {
    const found = findBaseShortId(child);
    if (found) return found;
  }
  return undefined;
}

function newCloid(): string {
  return `0x${randomBytes(16).toString('hex')}`;
}

async function cancelProtectiveOrders(trade: CopiedTrade) {
  for (const cloid of [trade.tpCloid, trade.slCloid]) {
    if (!cloid) continue;
    try {
      await hl.cancelOrderByCloid(trade.coin, cloid);
    } catch (error: any) {
      log('protective_cancel_failed', { baseId: trade.sourceBaseId, cloid, error: error.message });
    }
  }
  trade.tpCloid = undefined;
  trade.slCloid = undefined;
}

async function syncProtectiveOrders(config: Config, trade: CopiedTrade) {
  if (!config.protectiveOrdersEnabled || config.dryRun || trade.dryRun) return;
  await cancelProtectiveOrders(trade);
  if (trade.priceTarget) {
    trade.tpCloid = newCloid();
    await hl.placeProtectiveOrder(trade.coin, trade.side, trade.size, trade.priceTarget, 'tp', trade.tpCloid);
  }
  if (trade.stopLoss) {
    trade.slCloid = newCloid();
    await hl.placeProtectiveOrder(trade.coin, trade.side, trade.size, trade.stopLoss, 'sl', trade.slCloid);
  }
}

async function reconcileProtectiveOrders(state: State) {
  for (const trade of Object.values(state.trades)) {
    if (trade.status !== 'open' || trade.dryRun) continue;
    for (const [kind, cloid] of [['tp', trade.tpCloid], ['sl', trade.slCloid]] as const) {
      if (!cloid) continue;
      try {
        const response: any = await hl.getOrderStatus(WALLET_ADDRESS, cloid);
        const status = response?.status === 'order' ? response.order?.status : undefined;
        if (status === 'filled' || status === 'triggered') {
          const sibling = kind === 'tp' ? trade.slCloid : trade.tpCloid;
          if (sibling) {
            try { await hl.cancelOrderByCloid(trade.coin, sibling); }
            catch (error: any) { log('protective_sibling_cancel_failed', { baseId: trade.sourceBaseId, error: error.message }); }
          }
          trade.status = 'closed';
          trade.closedAt = new Date().toISOString();
          trade.tpCloid = undefined;
          trade.slCloid = undefined;
          state.ignoredSourceTrades[trade.sourceBaseId] = true;
          await saveState(state);
          log('protective_exit_detected', { baseId: trade.sourceBaseId, coin: trade.coin, kind, status });
          break;
        }
      } catch (error: any) {
        log('protective_status_failed', { baseId: trade.sourceBaseId, cloid, error: error.message });
      }
    }
  }
}

async function getAccountValue(): Promise<number> {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_ADDRESS }),
  });
  if (!response.ok) throw new Error(`Hyperliquid account request failed: ${response.status}`);
  const data: any = await response.json();
  return Number(data.marginSummary?.accountValue ?? 0);
}

async function reject(state: State, signal: Signal, reason: string) {
  state.signals[signal.key] = { status: 'rejected', at: new Date().toISOString(), reason };
  await saveState(state);
  log('signal_rejected', {
    signal: signal.key,
    sourceBaseId: signal.sourceBaseId,
    portfolioId: signal.portfolioId,
    coin: signal.coin,
    reason,
  });
}

async function openTrade(config: Config, state: State, signal: Signal) {
  const rules = mergedRules(config, signal.portfolioId);
  if (state.trades[signal.sourceBaseId]?.status === 'open') return reject(state, signal, 'source trade already copied');
  if (!(signal.positionSize > 0)) return reject(state, signal, 'source position size unavailable');
  if (config.sizingMode === 'sourceAllocation' && !(signal.entrySizePercent && signal.entrySizePercent <= 100)) {
    return reject(state, signal, 'source allocation percentage unavailable or invalid');
  }

  const openTrades = Object.values(state.trades).filter(t =>
    t.status === 'open' && t.dryRun === config.dryRun);
  if (openTrades.length >= config.maxOpenTrades) return reject(state, signal, 'maximum open trades reached');

  const [meta, mids, equity, localPositions] = await Promise.all([
    hl.getMeta(),
    hl.getAllMids(),
    getAccountValue(),
    hl.getPositions(WALLET_ADDRESS),
  ]);
  const assetIndex = meta.universe.findIndex(asset => asset.name === signal.coin);
  if (assetIndex < 0) return reject(state, signal, 'unknown Hyperliquid asset');
  const mid = Number(mids[signal.coin]);
  if (!mid) return reject(state, signal, 'market price unavailable');
  const localPosition = localPositions.find((position: any) => position.coin === signal.coin);
  if (localPosition && (Number(localPosition.szi) > 0) !== (signal.side === 'long')) {
    return reject(state, signal, 'local net position is in the opposite direction');
  }

  if (signal.entryPrice && Math.abs(mid - signal.entryPrice) / signal.entryPrice > rules.maxPriceDriftPct) {
    return reject(state, signal, 'price moved beyond configured drift');
  }

  const existingExposure = openTrades.reduce((sum, trade) => sum + Math.abs(Number(trade.size)) * Number(mids[trade.coin] ?? 0), 0);
  const maxRemaining = config.maxTotalExposureUsd - existingExposure;
  const leverage = Math.max(1, Math.min(Math.floor(signal.leverage), rules.maxLeverage, meta.universe[assetIndex].maxLeverage));
  const exchangeLeverage = Math.max(leverage, ...openTrades.filter(t => t.coin === signal.coin).map(t => t.leverage));
  const allocationFraction = config.sizingMode === 'sourceAllocation'
    ? signal.entrySizePercent! / 100
    : rules.balanceFraction;
  const desiredNotional = Math.min(equity * allocationFraction * leverage, rules.maxPositionUsd) * rules.sizeMultiplier;
  const maxAllowedNotional = Math.min(maxRemaining, rules.maxPositionUsd);
  if (maxAllowedNotional < config.minOpenNotionalUsd) {
    return reject(state, signal, 'insufficient exposure allowance for minimum order');
  }
  const minimumApplied = desiredNotional < config.minOpenNotionalUsd;
  const notional = Math.min(Math.max(desiredNotional, config.minOpenNotionalUsd), maxAllowedNotional);

  const decimals = meta.universe[assetIndex].szDecimals;
  const factor = 10 ** decimals;
  const rawSizeUnits = (notional / mid) * factor;
  const size = ((minimumApplied ? Math.ceil(rawSizeUnits) : Math.floor(rawSizeUnits)) / factor).toFixed(decimals);
  if (Number(size) <= 0) return reject(state, signal, 'calculated size is below asset minimum precision');
  if (Number(size) * mid > maxAllowedNotional + 1e-9) {
    return reject(state, signal, 'asset precision would exceed configured exposure limit');
  }

  state.signals[signal.key] = { status: 'executing', at: new Date().toISOString() };
  await saveState(state);

  let invoResult: any;
  if (!config.dryRun) {
    await hl.setLeverage(signal.coin, exchangeLeverage);
    const before = await hl.getPositions(WALLET_ADDRESS);
    const qtyBefore = before.find((p: any) => p.coin === signal.coin)?.szi ?? '0';
    const nonceMs = Date.now();
    const orderResult = await hl.placeMarketOrder(signal.coin, signal.side === 'long', size);
    const after = await hl.getPositions(WALLET_ADDRESS);
    const qtyAfter = after.find((p: any) => p.coin === signal.coin)?.szi ?? '0';
    if (qtyBefore === qtyAfter) throw new Error('Hyperliquid position did not change after order');

    try {
      invoResult = await invo.recordOpen({
        clientTxId: randomUUID(),
        coin: signal.coin,
        assetIndex,
        entry: { side: signal.side, marginMode: 'isolated', leverage, tpPx: null, slPx: null },
        submission: { hlOrder: orderResult, nonceMs, hlResponse: orderResult },
        summary: { qtyBefore, qtyAfter, intendedLeverage: leverage },
        mimicMeta: {
          portfolioId: signal.portfolioId,
          creatorInvoUserId: signal.ownerId,
          initialSourcePaperUpdateId: signal.postId,
          sourcePaperTradeBaseId: signal.sourceBaseId,
        },
      });
    } catch (error: any) {
      log('invo_record_open_failed', { signal: signal.key, error: error.message });
    }
  }

  state.trades[signal.sourceBaseId] = {
    sourceBaseId: signal.sourceBaseId,
    sourceBaseShortId: signal.sourceBaseShortId,
    invoBaseShortId: findBaseShortId(invoResult),
    postId: signal.postId,
    portfolioId: signal.portfolioId,
    coin: signal.coin,
    side: signal.side,
    size,
    sourcePositionSize: signal.positionSize,
    sourceAllocationFraction: allocationFraction,
    sourceUpdatedAt: signal.updatedAt,
    leverage,
    priceTarget: signal.priceTarget,
    stopLoss: signal.stopLoss,
    openedAt: new Date().toISOString(),
    status: 'open',
    dryRun: config.dryRun,
  };
  try {
    await syncProtectiveOrders(config, state.trades[signal.sourceBaseId]);
  } catch (error: any) {
    log('protective_sync_failed', { signal: signal.key, error: error.message });
  }
  state.signals[signal.key] = { status: config.dryRun ? 'dry_run' : 'executed', at: new Date().toISOString() };
  await saveState(state);
  log(config.dryRun ? 'open_dry_run' : 'open_executed', {
    signal: signal.key,
    coin: signal.coin,
    side: signal.side,
    size,
    leverage,
    sourceAllocationPct: allocationFraction * 100,
    desiredNotionalUsd: desiredNotional,
    finalNotionalUsd: Number(size) * mid,
    minimumApplied,
    priceTarget: signal.priceTarget,
    stopLoss: signal.stopLoss,
  });
}

async function updateTrade(config: Config, state: State, signal: Signal, trade: CopiedTrade) {
  if (trade.side !== signal.side) return reject(state, signal, 'source direction changed for an existing base ID');
  if (!(signal.positionSize > 0) || !(trade.sourcePositionSize > 0)) {
    return reject(state, signal, 'source position size unavailable for proportional update');
  }

  const rules = mergedRules(config, signal.portfolioId);
  if (signal.positionSize > trade.sourcePositionSize && !rules.copyIncreases) {
    return reject(state, signal, 'position increases disabled');
  }
  const [meta, mids, equity] = await Promise.all([hl.getMeta(), hl.getAllMids(), getAccountValue()]);
  const asset = meta.universe.find(item => item.name === signal.coin);
  if (!asset) return reject(state, signal, 'unknown Hyperliquid asset');
  const mid = Number(mids[signal.coin]);
  if (!mid) return reject(state, signal, 'market price unavailable');

  const oldSourceSize = trade.sourcePositionSize;
  const oldLocalSize = Number(trade.size);
  const leverage = Math.max(1, Math.min(Math.floor(signal.leverage), rules.maxLeverage, asset.maxLeverage));
  const sourceFraction = signal.entrySizePercent && signal.entrySizePercent <= 100
    ? signal.entrySizePercent / 100
    : undefined;
  const desiredLocalSize = config.sizingMode === 'sourceAllocation' && sourceFraction
    ? equity * sourceFraction * leverage / mid
    : oldLocalSize * (signal.positionSize / oldSourceSize);
  const otherTrades = Object.values(state.trades).filter(t =>
    t.status === 'open' && t.dryRun === config.dryRun && t.sourceBaseId !== trade.sourceBaseId);
  const otherExposure = otherTrades.reduce((sum, item) => sum + Number(item.size) * Number(mids[item.coin] ?? 0), 0);
  const maxByExposure = Math.max(0, config.maxTotalExposureUsd - otherExposure) / mid;
  const maxByTrade = rules.maxPositionUsd / mid;
  const factor = 10 ** asset.szDecimals;
  const targetLocalSize = Math.floor(Math.min(desiredLocalSize, maxByExposure, maxByTrade) * factor) / factor;
  const delta = targetLocalSize - oldLocalSize;
  const exchangeLeverage = Math.max(leverage, ...otherTrades.filter(t => t.coin === signal.coin).map(t => t.leverage));

  state.signals[signal.key] = { status: 'executing', at: new Date().toISOString() };
  await saveState(state);

  if (!config.dryRun && !trade.dryRun) {
    await hl.setLeverage(signal.coin, exchangeLeverage);
    if (Math.abs(delta) >= 1 / factor) {
      if (delta > 0) await hl.placeMarketOrder(signal.coin, signal.side === 'long', delta.toFixed(asset.szDecimals));
      else await hl.closePositionSize(signal.coin, WALLET_ADDRESS, Math.abs(delta).toFixed(asset.szDecimals), signal.side);
    }
  }

  trade.size = targetLocalSize.toFixed(asset.szDecimals);
  trade.sourcePositionSize = signal.positionSize;
  if (sourceFraction) trade.sourceAllocationFraction = sourceFraction;
  trade.sourceUpdatedAt = signal.updatedAt;
  trade.leverage = leverage;
  trade.priceTarget = signal.priceTarget;
  trade.stopLoss = signal.stopLoss;
  try {
    await syncProtectiveOrders(config, trade);
  } catch (error: any) {
    log('protective_sync_failed', { signal: signal.key, error: error.message });
  }

  state.signals[signal.key] = { status: config.dryRun ? 'dry_run' : 'executed', at: new Date().toISOString() };
  await saveState(state);
  log(config.dryRun ? 'update_dry_run' : 'update_executed', {
    signal: signal.key,
    coin: signal.coin,
    sourceSizeBefore: oldSourceSize,
    sourceSizeAfter: signal.positionSize,
    localSizeBefore: oldLocalSize,
    localSizeAfter: targetLocalSize,
    delta,
    leverage,
    exchangeLeverage,
    sourceAllocationPct: (sourceFraction ?? trade.sourceAllocationFraction) * 100,
    priceTarget: signal.priceTarget,
    stopLoss: signal.stopLoss,
    capped: targetLocalSize < desiredLocalSize,
  });
}

async function closeTrade(config: Config, state: State, signal: Signal) {
  const trade = state.trades[signal.sourceBaseId]?.status === 'open'
    ? state.trades[signal.sourceBaseId]
    : undefined;
  if (!trade) return reject(state, signal, 'no matching copied trade');
  if (config.dryRun && !trade.dryRun) {
    state.signals[signal.key] = {
      status: 'blocked',
      at: new Date().toISOString(),
      reason: 'live copied trade cannot be closed while daemon is in dry-run mode',
    };
    await saveState(state);
    log('close_blocked', { signal: signal.key, reason: state.signals[signal.key].reason });
    return;
  }
  state.signals[signal.key] = { status: 'executing', at: new Date().toISOString() };
  await saveState(state);

  if (!config.dryRun && !trade.dryRun) {
    await cancelProtectiveOrders(trade);
    const meta = await hl.getMeta();
    const assetIndex = meta.universe.findIndex(asset => asset.name === trade.coin);
    const positions = await hl.getPositions(WALLET_ADDRESS);
    const qtyBefore = positions.find((p: any) => p.coin === trade.coin)?.szi;
    if (!qtyBefore) throw new Error(`No local ${trade.coin} position to close`);
    const nonceMs = Date.now();
    const closeResult = await hl.closePositionSize(trade.coin, WALLET_ADDRESS, trade.size, trade.side);
    const after = await hl.getPositions(WALLET_ADDRESS);
    const qtyAfter = after.find((p: any) => p.coin === trade.coin)?.szi ?? '0';
    if (qtyBefore === qtyAfter) throw new Error('Hyperliquid position did not change after close order');

    if (trade.invoBaseShortId) {
      try {
        await invo.recordClose({
          clientTxId: randomUUID(),
          baseShortId: trade.invoBaseShortId,
          assetIndex,
          submission: { hlOrder: closeResult, nonceMs, hlResponse: closeResult },
          summary: { qtyBefore, qtyAfter },
        });
      } catch (error: any) {
        log('invo_record_close_failed', { signal: signal.key, error: error.message });
      }
    }
  }

  trade.status = 'closed';
  trade.closedAt = new Date().toISOString();
  state.signals[signal.key] = { status: config.dryRun ? 'dry_run' : 'executed', at: new Date().toISOString() };
  await saveState(state);
  log(config.dryRun ? 'close_dry_run' : 'close_executed', { signal: signal.key, coin: trade.coin, size: trade.size });
}

async function processSignal(config: Config, state: State, signal: Signal) {
  const prior = state.signals[signal.key];
  if (prior && prior.status !== 'blocked') return;
  // Compatibility with keys written before positionSize was removed from the
  // key. Those keys share this stable prefix but end with a fluctuating size.
  const legacyPrefix = `${signal.sourceBaseId}:${signal.updatedAt}:${signal.isOpen}:`;
  const legacyPrior = Object.entries(state.signals).find(([key, value]) =>
    key.startsWith(legacyPrefix) && value.status !== 'blocked');
  if (legacyPrior) return;
  const trader = config.traders[signal.portfolioId];
  if (!trader?.enabled) return reject(state, signal, 'portfolio not allowlisted');
  if (!config.allowedCoins.includes('*') && !config.allowedCoins.includes(signal.coin)) {
    return reject(state, signal, 'coin not allowlisted');
  }
  if (signal.timestamp && Date.now() - signal.timestamp > config.maxSignalAgeMs) return reject(state, signal, 'signal is stale');
  if (state.ignoredSourceTrades[signal.sourceBaseId]) {
    state.signals[signal.key] = { status: 'ignored_preexisting', at: new Date().toISOString() };
    if (!signal.isOpen) delete state.ignoredSourceTrades[signal.sourceBaseId];
    await saveState(state);
    return;
  }
  const trade = state.trades[signal.sourceBaseId]?.status === 'open'
    ? state.trades[signal.sourceBaseId]
    : undefined;
  if (!signal.isOpen || signal.positionSize === 0) return closeTrade(config, state, signal);
  if (trade) return updateTrade(config, state, signal, trade);
  return openTrade(config, state, signal);
}

async function getPortfolioSignals(config: Config): Promise<{
  signals: Signal[];
  successfulPortfolioIds: Set<string>;
}> {
  const observedAt = Date.now();
  const portfolioIds = Object.entries(config.traders)
    .filter(([, rules]) => rules.enabled)
    .map(([portfolioId]) => portfolioId);
  const signals: Signal[] = [];
  const successfulPortfolioIds = new Set<string>();
  // Keep concurrency low; Invo occasionally drops bursts of portfolio calls.
  for (let index = 0; index < portfolioIds.length; index += 2) {
    const batch = portfolioIds.slice(index, index + 2);
    const results = await Promise.allSettled(batch.map(async portfolioId => {
      const data = await invo.getPortfolioInvestments(portfolioId, true, 1, 100);
      if (data.success !== true) throw new Error(`Invo returned unsuccessful portfolio response: ${JSON.stringify(data.error)}`);
      const investments = Array.isArray(data.investmentsTicker) ? data.investmentsTicker : [];
      return investments
        .map((investment: any) => parsePortfolioInvestment(investment, observedAt))
        .filter((signal: Signal | null): signal is Signal => signal !== null);
    }));
    results.forEach((result, batchIndex) => {
      if (result.status === 'fulfilled') {
        successfulPortfolioIds.add(batch[batchIndex]);
        signals.push(...result.value);
      }
      else log('portfolio_poll_error', {
        portfolioId: batch[batchIndex],
        error: String(result.reason?.message ?? result.reason),
      });
    });
  }
  return { signals, successfulPortfolioIds };
}

async function main() {
  const config = await loadConfig();
  if (!INVO_TOKEN && !INVO_REFRESH_TOKEN) throw new Error('INVO_TOKEN or INVO_REFRESH_TOKEN is required');
  if (!WALLET_ADDRESS) throw new Error('WALLET_ADDRESS is required');
  if (!config.dryRun && !config.tradingEnabled) throw new Error('Live mode requires tradingEnabled=true');
  if (!config.dryRun && !HL_AGENT_KEY) throw new Error('HL_AGENT_KEY is required for live mode');

  if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
  if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);
  if (!config.dryRun) await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);

  const state = await loadState();
  let consecutivePollErrors = 0;
  let lastHeartbeatAt = 0;
  const missingOpenCounts = new Map<string, number>();
  log('daemon_started', { dryRun: config.dryRun, pollIntervalMs: config.pollIntervalMs, traders: Object.values(config.traders).filter(t => t.enabled).length });

  while (!stopping) {
    const startedAt = Date.now();
    try {
      if (!config.dryRun && config.protectiveOrdersEnabled) await reconcileProtectiveOrders(state);
      const [data, portfolioSnapshot] = await Promise.all([
        invo.getFeed('following', null, 50),
        getPortfolioSignals(config),
      ]);
      const feedSignals = (data.items ?? []).map(parseSignal).filter((signal: Signal | null): signal is Signal => signal !== null);
      const snapshotOpenBaseIds = new Set(portfolioSnapshot.signals.map(signal => signal.sourceBaseId));
      const snapshotCloseSignals: Signal[] = [];
      for (const trade of Object.values(state.trades)) {
        if (trade.status !== 'open' || !portfolioSnapshot.successfulPortfolioIds.has(trade.portfolioId)) continue;
        if (snapshotOpenBaseIds.has(trade.sourceBaseId)) {
          missingOpenCounts.delete(trade.sourceBaseId);
          continue;
        }
        const missingCount = (missingOpenCounts.get(trade.sourceBaseId) ?? 0) + 1;
        missingOpenCounts.set(trade.sourceBaseId, missingCount);
        if (missingCount < 2) continue;
        const observedAt = Date.now();
        const updatedAt = new Date(observedAt).toISOString();
        snapshotCloseSignals.push({
          key: `${trade.sourceBaseId}:${updatedAt}:false:${trade.leverage}:0:0`,
          postId: trade.postId,
          isOpen: false,
          timestamp: observedAt,
          portfolioId: trade.portfolioId,
          ownerId: '',
          coin: trade.coin,
          side: trade.side,
          leverage: trade.leverage,
          positionSize: 0,
          updatedAt,
          sourceBaseId: trade.sourceBaseId,
          sourceBaseShortId: trade.sourceBaseShortId,
        });
        missingOpenCounts.delete(trade.sourceBaseId);
      }
      const parsedSignals = [...feedSignals, ...portfolioSnapshot.signals, ...snapshotCloseSignals];
      // A feed item is mutable. If several versions are returned together, act
      // only on the latest target state for each source trade.
      const latestByBaseId = new Map<string, Signal>();
      for (const signal of parsedSignals) {
        const previous = latestByBaseId.get(signal.sourceBaseId);
        if (!previous || signal.updatedAt >= previous.updatedAt) latestByBaseId.set(signal.sourceBaseId, signal);
      }
      const signals = Array.from(latestByBaseId.values()).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

      if (!state.initialized) {
        for (const signal of signals) {
          state.signals[signal.key] = { status: 'baseline', at: new Date().toISOString() };
          if (signal.isOpen) state.ignoredSourceTrades[signal.sourceBaseId] = true;
        }
        state.initialized = true;
        await saveState(state);
        log('sources_baselined', {
          signals: signals.length,
          openPositions: signals.filter(signal => signal.isOpen).map(signal => ({
            portfolioId: signal.portfolioId,
            coin: signal.coin,
            side: signal.side,
            leverage: signal.leverage,
            sourceAllocationPct: signal.entrySizePercent,
          })),
        });
      } else {
        for (const signal of signals) {
          try {
            await processSignal(config, state, signal);
          } catch (error: any) {
            state.signals[signal.key] = { status: 'error', at: new Date().toISOString(), reason: error.message };
            await saveState(state);
            log('signal_error', { signal: signal.key, error: error.message });
          }
        }
      }
      if (consecutivePollErrors > 0) {
        log('poll_recovered', { previousErrors: consecutivePollErrors });
        consecutivePollErrors = 0;
      }
      if (Date.now() - lastHeartbeatAt >= 60_000) {
        const trackedOpenTrades = Object.values(state.trades).filter(trade =>
          trade.status === 'open' && trade.dryRun === config.dryRun);
        log('daemon_heartbeat', {
          status: 'healthy',
          pollDurationMs: Date.now() - startedAt,
          sourceSignals: signals.length,
          trackedOpenSourceTrades: trackedOpenTrades.length,
          trackedOpenAssets: new Set(trackedOpenTrades.map(trade => trade.coin)).size,
          ignoredOppositeModeRecords: Object.values(state.trades).filter(trade =>
            trade.status === 'open' && trade.dryRun !== config.dryRun).length,
        });
        lastHeartbeatAt = Date.now();
      }
    } catch (error: any) {
      consecutivePollErrors += 1;
      log('poll_error', { consecutiveErrors: consecutivePollErrors, error: error.message });
    }

    const delay = Math.max(0, config.pollIntervalMs - (Date.now() - startedAt));
    if (!stopping) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
  }
  log('daemon_stopped');
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

main().catch(error => {
  log('fatal', { error: error.message });
  process.exitCode = 1;
});
