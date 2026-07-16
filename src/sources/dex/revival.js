// Revival + rug detection for dormant watchlist tokens.
import { getState, save } from '../../core/store.js';

const RULES = {
  volSpikeRatio: 3,     // h1 volume >= 3x the hourly average of h24
  priceMovePct: 10,     // h1 price change >= +10%
  liqAddPct: 20,        // liquidity up >= 20% vs baseline
  txnSurgeRatio: 3,     // h1 txns >= 3x hourly average (needs >=10 txns + min volume)
  minH1VolumeUsd: 5_000, // ignore dust — revivals need real money flowing
  rugDropPct: 50,       // liquidity down >= 50% vs baseline -> LIQUIDITY PULL alarm
  minRugLiqUsd: 10_000, // baseline must be meaningful before rug logic applies
};

export function checkRevival(pair) {
  const st = getState();
  const key = `${pair.chainId}:${pair.baseToken.address}`;
  const base = st.baselines[key];
  const liq = pair.liquidity?.usd || 0;
  // Pair-flip guard: if the best pair changed pools, reset baseline silently —
  // comparing liquidity across different pools creates fake rug/revival alerts.
  if (base && base.pair && base.pair !== pair.pairAddress) {
    st.baselines[key] = { liq, pair: pair.pairAddress, symbol: pair.baseToken.symbol, updated: Date.now() };
    save();
    return null;
  }
  const track = { kind: 'dex', chainId: pair.chainId, address: pair.baseToken.address, price: Number(pair.priceUsd) || 0 };

  // --- Rug alarm: liquidity halved vs baseline ---
  if (base?.liq >= RULES.minRugLiqUsd && liq <= base.liq * (1 - RULES.rugDropPct / 100)) {
    st.baselines[key] = { ...base, liq, pair: pair.pairAddress }; save(); // accept new reality, alert once
    return {
      source: 'DEX', type: 'RUG', severity: 'HIGH', key, cooldownMin: 1440,
      title: `${pair.baseToken.symbol}: liquidity pulled (${pair.chainId})`,
      lines: [
        `Liquidity dropped ${(100 * (1 - liq / base.liq)).toFixed(0)}%: $${fmt(base.liq)} → $${fmt(liq)}`,
        `Price ${pair.priceChange?.h1 >= 0 ? '+' : ''}${pair.priceChange?.h1 ?? '?'}% 1h — if you hold this, check it NOW`,
      ],
      url: pair.url, track,
    };
  }

  // --- Revival signals ---
  const signals = [];
  const volH1 = pair.volume?.h1 || 0;
  const volH24 = pair.volume?.h24 || 0;
  const hourlyAvg = volH24 / 24;
  const priceH1 = pair.priceChange?.h1 || 0;
  const txH1 = (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0);
  const txAvg = ((pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)) / 24;

  if (volH1 >= RULES.minH1VolumeUsd && hourlyAvg > 0 && volH1 / hourlyAvg >= RULES.volSpikeRatio)
    signals.push(`Volume spike: $${fmt(volH1)}/h vs $${fmt(hourlyAvg)}/h avg (${(volH1 / hourlyAvg).toFixed(1)}x)`);
  if (priceH1 >= RULES.priceMovePct)
    signals.push(`Price +${priceH1}% in 1h`);
  if (txAvg > 0 && txH1 >= 10 && volH1 >= RULES.minH1VolumeUsd && txH1 / txAvg >= RULES.txnSurgeRatio)
    signals.push(`Txn surge: ${txH1} txns/h vs ${txAvg.toFixed(1)} avg`);
  if (base?.liq > 0 && liq >= base.liq * (1 + RULES.liqAddPct / 100))
    signals.push(`Liquidity +${(((liq - base.liq) / base.liq) * 100).toFixed(0)}% ($${fmt(liq)})`);

  st.baselines[key] = {
    liq: base ? base.liq * 0.9 + liq * 0.1 : liq,
    pair: pair.pairAddress,
    symbol: pair.baseToken.symbol,
    updated: Date.now(),
  };
  save();

  if (!signals.length) return null;
  const severity = signals.length >= 3 ? 'HIGH' : signals.length === 2 ? 'MEDIUM' : 'LOW';
  return {
    source: 'DEX', type: 'REVIVAL', severity, key, cooldownMin: 360,
    title: `${pair.baseToken.symbol} waking up (${pair.chainId})`,
    lines: [...signals, `Price: $${pair.priceUsd} · Liq: $${fmt(liq)} · Vol24h: $${fmt(volH24)}`],
    url: pair.url, track,
  };
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0);
export { RULES };
