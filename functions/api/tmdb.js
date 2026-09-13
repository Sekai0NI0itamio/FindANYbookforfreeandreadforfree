// Cloudflare Pages Function — proxy for TMDB (search + legal watch providers,
// the data behind JustWatch). The API key lives in the Cloudflare environment
// variable TMDB_KEY and is NEVER sent to the browser.
// Routed at /api/tmdb?action=search&kind=video|anime&q=...
//        or /api/tmdb?action=providers&type=movie|tv&id=123
export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams;
  const key = env.TMDB_KEY;
  const region = env.TMDB_REGION || 'US';
  if (!key) return json({ configured: false });

  const action = p.get('action') || 'search';
  try {
    if (action === 'search') {
      const kind = p.get('kind') || 'video';
      const q = (p.get('q') || '').slice(0, 100);
      if (!q.trim()) return json({ configured: true, results: [] });
      const types = kind === 'anime' ? ['tv', 'movie'] : ['movie'];
      let out = [];
      for (const type of types) {
        const r = await fetch('https://api.themoviedb.org/3/search/' + type +
          '?api_key=' + encodeURIComponent(key) +
          '&query=' + encodeURIComponent(q) + '&include_adult=false');
        if (!r.ok) continue;
        const j = await r.json();
        let rows = j.results || [];
        if (kind === 'anime') {
          const anim = rows.filter(m => (m.genre_ids || []).includes(16));
          if (anim.length) rows = anim;
        }
        out = out.concat(rows.slice(0, 8).map(m => ({ ...m, _type: type })));
      }
      return json({ configured: true, results: out });
    }

    if (action === 'providers') {
      const type = p.get('type') === 'tv' ? 'tv' : 'movie';
      const id = String(p.get('id') || '').replace(/[^0-9]/g, '');
      if (!id) return json({ configured: true, providers: null });
      const r = await fetch('https://api.themoviedb.org/3/' + type + '/' + id +
        '/watch/providers?api_key=' + encodeURIComponent(key));
      if (!r.ok) return json({ configured: true, providers: null });
      const j = await r.json();
      return json({ configured: true, providers: (j.results || {})[region] || null });
    }
  } catch {
    return json({ configured: true });
  }
  return json({ configured: true });
}

function json(o) {
  return new Response(JSON.stringify(o), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
