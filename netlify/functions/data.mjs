// ─────────────────────────────────────────────────────────────────────────────
// Data API — serves the cached snapshot from Netlify Blobs
// Exposed at /api/data via config.path
// Returns JSON with: { updatedAt, live, histByDay }
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/data' };

export default async () => {
  try {
    const store    = getStore('vibecheck');
    const snapshot = await store.get('snapshot', { type: 'json' });

    if (!snapshot) {
      return new Response(
        JSON.stringify({ error: 'Data not ready yet — first scheduled refresh is pending.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify(snapshot), {
      headers: {
        'Content-Type': 'application/json',
        // Cache at CDN edge for 5 min; stale-while-revalidate so there's no gap
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (err) {
    console.error('[VibeCheck] data.mjs error:', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
