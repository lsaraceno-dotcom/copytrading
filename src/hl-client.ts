import { Hyperliquid } from 'hyperliquid';

const INVO_BUILDER = { address: '0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81', fee: 35 };

// SDK expects "SOL-PERP" format; REST API uses "SOL"
function toSdkCoin(coin: string): string {
  return coin.includes('-') ? coin : `${coin}-PERP`;
}

let sdk: Hyperliquid | null = null;

export async function connect(agentKey: string, walletAddress: string): Promise<Hyperliquid> {
  sdk = new Hyperliquid({
    privateKey: agentKey,
    walletAddress,
    enableWs: false,
  });
  await sdk.connect();
  return sdk;
}

export function getSdk(): Hyperliquid {
  if (!sdk) throw new Error('HL SDK not connected. Call connect() first.');
  return sdk;
}

export async function getMeta() {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  return (await resp.json()) as { universe: { name: string; szDecimals: number; maxLeverage: number }[] };
}

export async function getAllMids(): Promise<Record<string, string>> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  return await resp.json();
}

export async function getPositions(wallet: string) {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet }),
  });
  const data = await resp.json();
  return data.assetPositions
    .filter((p: any) => parseFloat(p.position.szi) !== 0)
    .map((p: any) => p.position);
}

export async function setLeverage(coin: string, leverage: number) {
  const s = getSdk();
  return s.exchange.updateLeverage(toSdkCoin(coin), 'isolated', leverage);
}

export async function placeMarketOrder(
  coin: string,
  isBuy: boolean,
  size: string,
  slippagePct = 0.02,
  reduceOnly = false,
) {
  const mids = await getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);

  const rawPx = isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct);
  const limitPx = parseFloat(rawPx.toPrecision(5)).toString();

  const s = getSdk();
  return s.exchange.placeOrder({
    coin: toSdkCoin(coin),
    is_buy: isBuy,
    sz: parseFloat(size),
    limit_px: parseFloat(limitPx),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: reduceOnly,
    grouping: 'na',
    builder: INVO_BUILDER,
  });
}

export async function closePosition(coin: string, wallet: string) {
  const positions = await getPositions(wallet);
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) throw new Error(`No open position for ${coin}`);

  const size = Math.abs(parseFloat(pos.szi));
  const isLong = parseFloat(pos.szi) > 0;

  // Close = opposite direction
  return placeMarketOrder(coin, !isLong, size.toString(), 0.02, true);
}

/** Close only a known allocation of a net Hyperliquid position. */
export async function closePositionSize(
  coin: string,
  wallet: string,
  requestedSize: string,
  expectedSide: 'long' | 'short',
) {
  const positions = await getPositions(wallet);
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) throw new Error(`No open position for ${coin}`);

  const currentSize = Math.abs(parseFloat(pos.szi));
  const allocationSize = Math.abs(parseFloat(requestedSize));
  if (!Number.isFinite(allocationSize) || allocationSize <= 0) {
    throw new Error(`Invalid close size: ${requestedSize}`);
  }

  // Never submit more than the current net position. This SDK configuration
  // cannot sign reduce-only orders, so capping is an important last guard.
  const size = Math.min(currentSize, allocationSize);
  const isLong = parseFloat(pos.szi) > 0;
  if (isLong !== (expectedSide === 'long')) {
    throw new Error(`Local ${coin} position direction no longer matches copied allocation`);
  }
  return placeMarketOrder(coin, !isLong, size.toString(), 0.02, true);
}

export async function placeProtectiveOrder(
  coin: string,
  side: 'long' | 'short',
  size: string,
  triggerPrice: number,
  type: 'tp' | 'sl',
  cloid: string,
) {
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) throw new Error(`Invalid trigger price: ${triggerPrice}`);
  const triggerPx = parseFloat(triggerPrice.toPrecision(5));
  return getSdk().exchange.placeOrder({
    coin: toSdkCoin(coin),
    is_buy: side === 'short',
    sz: parseFloat(size),
    limit_px: triggerPx,
    order_type: { trigger: { triggerPx, isMarket: true, tpsl: type } },
    reduce_only: true,
    cloid,
    grouping: 'na',
    builder: INVO_BUILDER,
  });
}

export async function cancelOrderByCloid(coin: string, cloid: string) {
  return getSdk().exchange.cancelOrderByCloid(toSdkCoin(coin), cloid);
}

export async function getOrderStatus(wallet: string, cloid: string) {
  return getSdk().info.getOrderStatus(wallet, cloid, true);
}

export { INVO_BUILDER };
