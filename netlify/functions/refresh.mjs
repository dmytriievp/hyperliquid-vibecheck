// ─────────────────────────────────────────────────────────────────────────────
// Scheduled refresh — keeps a cache of daily candle volume in Netlify Blobs.
//
// Runs every 15 minutes. Each run refreshes as many stale markets as fit in the
// time budget and saves progress, so after each UTC midnight the cache is full
// again within a few runs. Live prices / volume / OI are fetched by the browser
// directly (cheap); only the expensive 30-day history comes from here.
// Served to the front end by data.mjs at /api/data.
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from '@netlify/blobs';
import { refreshCandles } from '../lib/candles.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const t0 = Date.now();
  try {
    const store = getStore('vibecheck');
    const prev = await store.get('snapshot', { type: 'json' }).catch(() => null);
    const { snapshot, stats } = await refreshCandles(prev, { budgetMs: 16000 });
    await store.setJSON('snapshot', snapshot);
    console.log(`[VibeCheck] candles: fetched ${stats.fetched}, fresh ${stats.fresh}/${stats.tracked}, ${Date.now() - t0}ms`);
    return new Response('OK');
  } catch (err) {
    console.error('[VibeCheck] Refresh failed:', err.message);
    return new Response('Error: ' + err.message, { status: 500 });
  }
};
