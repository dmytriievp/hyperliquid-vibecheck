// ─────────────────────────────────────────────────────────────────────────────
// Candle cache builder — shared logic for the scheduled refresh.
//
// The front end owns categorisation (classify() in index.html). The server only
// keeps a per-market cache of daily notional volume so visitors don't each have
// to pull ~150 candle series from Hyperliquid.
//
// Netlify scheduled functions have a short execution limit, so every run works
// against a time budget and picks up where the previous run stopped. A market
// counts as fresh once it was fetched after the most recent UTC midnight.
// ─────────────────────────────────────────────────────────────────────────────

export const HL_API = 'https://api.hyperliquid.xyz/info';
export const COVERAGE = 0.997;   // markets carrying ≥99.7% of 24h volume
export const MIN_COINS = 60;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const utcDay = ts => new Date(ts).toISOString().slice(0, 10);

export async function hl(body, { fetchImpl = fetch, tries = 5 } = {}) {
  const payload = JSON.stringify(body);
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetchImpl(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * 2 ** a); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (a === tries - 1) throw e;
      await sleep(500 * 2 ** a);
    }
  }
  throw new Error('Hyperliquid API rate-limited');
}

// Live markets across native + every HIP-3 dex, sorted by 24h volume (desc).
export async function liveMarkets(opts) {
  const dexList = await hl({ type: 'perpDexs' }, opts);
  const dexes = [''].concat((dexList || []).filter(Boolean).map(d => d.name));
  const rs = await Promise.allSettled(dexes.map(d => hl(d ? { type: 'metaAndAssetCtxs', dex: d } : { type: 'metaAndAssetCtxs' }, opts)));
  if (rs[0].status !== 'fulfilled') throw new Error('native markets fetch failed: ' + rs[0].reason?.message);
  const out = [];
  rs.forEach(r => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
    const uni = r.value[0]?.universe || [], ctx = r.value[1] || [];
    uni.forEach((a, i) => {
      if (a.isDelisted) return;
      const vol = parseFloat(ctx[i]?.dayNtlVlm || 0);
      if (vol > 0) out.push({ name: a.name, vol });
    });
  });
  return out.sort((a, b) => b.vol - a.vol);
}

export function pickCoins(markets) {
  const total = markets.reduce((a, m) => a + m.vol, 0) || 1;
  const coins = []; let cum = 0;
  for (const m of markets) {
    coins.push(m.name); cum += m.vol;
    if (cum / total >= COVERAGE && coins.length >= MIN_COINS) break;
  }
  return { coins, coverage: cum / total };
}

// Refresh stale entries in `prev.candles` until the time budget runs out.
export async function refreshCandles(prev, { budgetMs = 20000, concurrency = 3, now = Date.now(), ...opts } = {}) {
  const deadline = Date.now() + budgetMs;
  const midnight = Date.parse(utcDay(now) + 'T00:00:00Z');
  const markets = await liveMarkets(opts);
  const { coins, coverage } = pickCoins(markets);
  const old = prev?.v === 2 ? prev.candles || {} : {};
  // keep only coins we still track (drops delisted / long-tail markets)
  const candles = Object.fromEntries(coins.filter(c => old[c]).map(c => [c, old[c]]));
  const todo = coins.filter(c => !(candles[c] && candles[c].ts >= midnight));
  const start = now - 32 * 864e5;
  let i = 0, fetched = 0;
  const worker = async () => {
    while (i < todo.length && Date.now() < deadline) {
      const coin = todo[i++];
      try {
        const d = await hl({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: start, endTime: now } }, { ...opts, tries: 3 });
        if (Array.isArray(d)) {
          candles[coin] = { ts: Date.now(), c: d.map(k => [utcDay(k.t), Math.round(parseFloat(k.v || 0) * parseFloat(k.c || 0))]) };
          fetched++;
        }
      } catch { /* retried next run */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const fresh = coins.filter(c => candles[c] && candles[c].ts >= midnight).length;
  return {
    snapshot: { v: 2, updatedAt: Date.now(), coverage, coins: coins.length, fresh, candles },
    stats: { tracked: coins.length, fetched, fresh, remaining: coins.length - fresh },
  };
}
