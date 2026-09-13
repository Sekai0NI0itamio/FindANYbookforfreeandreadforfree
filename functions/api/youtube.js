// Cloudflare Pages Function — proxy for the official YouTube Data API.
// The API key lives in the Cloudflare environment variable YOUTUBE_KEY and is
// NEVER sent to the browser. Deployed automatically with the site.
// Routed at /api/youtube?q=...
export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams.get('q') || '';
  const key = env.YOUTUBE_KEY;
  if (!key) return json({ configured: false, items: [] });
  if (!q.trim()) return json({ configured: true, items: [] });
  try {
    const u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video' +
      '&maxResults=10&safeSearch=moderate&q=' + encodeURIComponent(q.slice(0, 100)) +
      '&key=' + encodeURIComponent(key);
    const r = await fetch(u);
    if (!r.ok) return json({ configured: true, items: [] });
    const j = await r.json();
    return json({ configured: true, items: (j.items || []).filter(i => i.id && i.id.videoId) });
  } catch {
    return json({ configured: true, items: [] });
  }
}

function json(o) {
  return new Response(JSON.stringify(o), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
