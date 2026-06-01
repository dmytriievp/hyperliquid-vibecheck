// ─────────────────────────────────────────────────────────────────────────────
// Scheduled refresh — runs every hour via Netlify Scheduled Functions
// Fetches live data + 30-day candles, aggregates, stores in Netlify Blobs
// Scheduled functions run as background functions (15 min timeout) — plenty
// of time to fetch 415 assets in batches.
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from '@netlify/blobs';
import { AC, HIP3_DEXES, ALL_CAT_KEYS, grp, parseDex, aggregate } from '../lib/ac.mjs';

export const config = { schedule: '@hourly' };

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlPost(type, dex) {
  const body = JSON.stringify(dex ? { type, dex } : { type });
  const r = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`HL API ${r.status} for ${type} ${dex || ''}`);
  return r.json();
}

async function fetchCandles() {
  const assets = Object.keys(AC);
  const now    = Date.now();
  const start  = now - 31 * 24 * 60 * 60 * 1000;
  const BATCH  = 15; // larger batch since no user is waiting
  const allCandles = {};

  for (let i = 0; i < assets.length; i += BATCH) {
    const batch = assets.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async coin => {
        const body = JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval: '1d', startTime: start, endTime: now },
        });
        const r = await fetch(HL_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const data = await r.json();
        if (!Array.isArray(data)) return { coin, candles: [] };
        return {
          coin,
          candles: data.map(c => ({
            day: new Date(c.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            vol: parseFloat(c.v || 0) * parseFloat(c.c || 0),
          })),
        };
      })
    );
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) allCandles[r.value.coin] = r.value.candles;
    });
    // Small delay between batches to be kind to the API
    if (i + BATCH < assets.length) await new Promise(res => setTimeout(res, 80));
  }

  // Collect unique days, sort chronologically, keep last 30
  const daySet = new Set();
  Object.values(allCandles).forEach(cs => cs.forEach(c => daySet.add(c.day)));
  const yr = new Date().getFullYear();
  const days = Array.from(daySet)
    .sort((a, b) => new Date(`${a},${yr}`) - new Date(`${b},${yr}`))
    .slice(-30);

  // Aggregate volume per day per category
  return days.map(day => {
    let totalVol = 0;
    const catVol = {};
    Object.entries(allCandles).forEach(([coin, cs]) => {
      const c = cs.find(x => x.day === day);
      if (!c) return;
      totalVol += c.vol;
      if (!AC[coin]) {
        if (coin.includes(':')) {
          const d = coin.split(':')[0];
          if (d !== 'hyna') {
            catVol['TradFi'] = (catVol['TradFi'] || 0) + c.vol;
            catVol['Stocks'] = (catVol['Stocks'] || 0) + c.vol;
          }
        }
        return;
      }
      ALL_CAT_KEYS.forEach(key => {
        if (!grp(coin, key)) return;
        catVol[key] = (catVol[key] || 0) + c.vol;
      });
    });
    return { day, totalVol, catVol };
  });
}

export default async () => {
  console.log('[VibeCheck] Refresh started', new Date().toISOString());
  try {
    // ── 1. Fetch live market data (native + all 7 HIP-3 dexes in parallel) ──
    const results = await Promise.allSettled([
      hlPost('metaAndAssetCtxs', null),
      ...HIP3_DEXES.map(d => hlPost('metaAndAssetCtxs', d)),
    ]);

    if (results[0].status !== 'fulfilled') {
      throw new Error('Native market fetch failed: ' + results[0].reason?.message);
    }

    const assets = parseDex(results[0].value);
    HIP3_DEXES.forEach((_, i) => {
      const r = results[i + 1];
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        assets.push(...parseDex(r.value));
      } else {
        console.warn(`[VibeCheck] ${HIP3_DEXES[i]} dex fetch failed:`, r.reason?.message);
      }
    });

    const live = aggregate(assets);
    console.log(`[VibeCheck] Live: ${assets.length} assets | vol $${(live.totalVol / 1e9).toFixed(2)}B | OI $${(live.totalOI / 1e9).toFixed(2)}B`);

    // ── 2. Fetch 30-day candle history ──
    const histByDay = await fetchCandles();
    console.log(`[VibeCheck] History: ${histByDay.length} days of candles`);

    // ── 3. Store snapshot in Netlify Blobs ──
    const store = getStore('vibecheck');
    await store.setJSON('snapshot', {
      updatedAt: Date.now(),
      live,
      histByDay,
    });

    console.log('[VibeCheck] Refresh complete ✓');
    return new Response('OK');
  } catch (err) {
    console.error('[VibeCheck] Refresh failed:', err.message);
    return new Response('Error: ' + err.message, { status: 500 });
  }
};
