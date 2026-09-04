import { WALLET_ADDRESS } from '../env.js';

async function main() {
  if (!WALLET_ADDRESS) throw new Error('WALLET_ADDRESS is required');

  const response = await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'clearinghouseState', user: WALLET_ADDRESS }),
  });
  if (!response.ok) throw new Error(`Hyperliquid account request failed: ${response.status}`);

  const state: any = await response.json();
  const positions = (state.assetPositions ?? [])
  .map((item: any) => item.position ?? item)
  .filter((position: any) => Number(position.szi) !== 0)
  .map((position: any) => ({
    coin: position.coin,
    side: Number(position.szi) > 0 ? 'long' : 'short',
    size: Math.abs(Number(position.szi)),
    leverage: position.leverage?.value,
    marginMode: position.leverage?.type,
    entryPrice: Number(position.entryPx),
    positionValueUsd: Number(position.positionValue),
    marginUsedUsd: Number(position.marginUsed),
    unrealizedPnlUsd: Number(position.unrealizedPnl),
    liquidationPrice: position.liquidationPx == null ? null : Number(position.liquidationPx),
  }));

  console.log(JSON.stringify({
    wallet: WALLET_ADDRESS,
    accountValueUsd: Number(state.marginSummary?.accountValue ?? 0),
    withdrawableUsd: Number(state.withdrawable ?? 0),
    openPositions: positions,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
