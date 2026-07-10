// Revival signal rules for dormant tokens.
// Signals: volume spike (h1 pace vs h24 avg), price move, liquidity add, txn surge.
import { getState, save } from '../../core/store.js';

const RULES = {
  volSpikeRatio: 3,     // h1 volume >= 3x the hourly average of h24
  priceMovePct: 10,     // h1 price change >= +10%
  liqAddPct: 20,        // liquidity up >= 20% vs baseline
  txnSurgeRatio: 3,     // h1 txns >= 3x hourly average of h24
  minH1VolumeUsd: 500,  // ignore dust
};

export function checkRevival(pair) {
  const signals = [];
  const volH1 = pair.volume?.h1 || 0;
  const volH24 = pair.volume?.h24 || 0;
  const hourlyAvg = volH24 / 24;
  const priceH1 = pair.priceChange?.h1 || 0;
  const liq = pair.liquidity?.usd || 0;
  const txH1 = (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0);
  const txAvg = ((pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)) / 24;

  if (volH1 >= RULES.minH1VolumeUsd && hourlyAvg > 0 && volH1 / hourlyAvg >= RULES.volSpikeRatio)
    signals.push(`Volume spike: $${fmt(volH1)}/h vs $${fmt(hourlyAvg)}/h avg (${(volH1 / hourlyAvg).toFixed(1)}x)`);
  if (priceH1 >= RULES.priceMovePct)
    signals.push(`Price +${priceH1}% in 1h`);
  if (txAvg > 0 && txH1 >= 10 && volH1 >= RULES.minH1VolumeUsd && txH1 / txAvg >= RULES.txnSurgeRatio)
    signals.push(`Txn surge: ${txH1} txns/h vs ${txAvg.toFixed(1)} avg`);

  // Liquidity vs stored baseline
  const st = getState();
  const key = `${pair.chainId}:${pair.baseToken.address}`;
  const base = st.baselines[key];
  if (base?.liq > 0 && liq >= base.liq * (1 + RULES.liqAddPct / 100))
    signals.push(`Liquidity +${(((liq - base.liq) / base.liq) * 100).toFixed(0)}% ($${fmt(liq)})`);

  // Update baseline (slow-moving EMA so a pump doesn't instantly become the new normal)
  st.baselines[key] = {
    liq: base ? base.liq * 0.9 + liq * 0.1 : liq,
    symbol: pair.baseToken.symbol,
    updated: Date.now(),
  };
  save();

  if (!signals.length) return null;
  const severity = signals.length >= 3 ? 'HIGH' : signals.length === 2 ? 'MEDIUM' : 'LOW';
  return {
    source: 'DEX', type: 'REVIVAL', severity, key,
    title: `${pair.baseToken.symbol} waking up (${pair.chainId})`,
    lines: [...signals, `Price: $${pair.priceUsd} · Liq: $${fmt(liq)} · Vol24h: $${fmt(volH24)}`],
    url: pair.url,
  };
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0);
