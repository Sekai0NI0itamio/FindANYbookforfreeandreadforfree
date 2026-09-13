const qEl = document.getElementById('q');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const mem = new Map();
let ctl = null;
let debounceT = 0;
let runSeq = 0;
let animT = 0;
let liveCount = 0;
let pirateMode = false;

// Pirate mode is opt-in + requires disclaimer agreement.
// Default is OFF. Persists in localStorage so the user only agrees once.
try { pirateMode = localStorage.getItem('ffp:pirate') === 'on'; } catch {}

// Issue tracking (Sentry, free tier, email-only signup). Activate: paste your
// public DSN below. Until then this block does nothing and loads nothing.
// Privacy: query text is stripped before sending; only error + page path go out.
const SENTRY_DSN = '';
(function initErrors() {
  if (!SENTRY_DSN) return;
  const s = document.createElement('script');
  s.src = 'https://browser.sentry-cdn.com/8.38.0/bundle.min.js';
  s.crossOrigin = 'anonymous';
  s.onload = () => {
    try {
      Sentry.init({
        dsn: SENTRY_DSN,
        tracesSampleRate: 0,
        beforeSend(ev) {
          try {
            ev.request = ev.request || {};
            ev.request.url = location.pathname;
            if (ev.breadcrumbs) ev.breadcrumbs = ev.breadcrumbs.map(b => {
              if (b.data && b.data.url) b.data.url = String(b.data.url).split('?')[0];
              return b;
            });
          } catch {}
          return ev;
        },
      });
    } catch {}
  };
  document.head.appendChild(s);
})();

function animateStatus(base) {
  clearInterval(animT);
  let n = 0;
  animT = setInterval(() => {
    n = (n + 1) % 4;
    statusEl.textContent = base + '.'.repeat(n) + (liveCount ? ' · ' + liveCount + ' found' : '');
  }, 350);
}

function stopAnimate() { clearInterval(animT); }

function norm(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function words(s) {
  return norm(s).replace(/["():[\]]/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length > 1);
}

function luc(s) {
  return String(s || '').replace(/"/g, '');
}

function cacheGet(k) {
  if (mem.has(k)) return mem.get(k);
  try {
    const raw = localStorage.getItem('bl2:' + k);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Date.now() - o.t > 10 * 60 * 1000) return null;
    mem.set(k, o.d);
    return o.d;
  } catch {
    return null;
  }
}

function cacheSet(k, d) {
  mem.set(k, d);
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('bl2:')) keys.push(key);
    }
    while (keys.length > 40) {
      const old = keys.shift();
      localStorage.removeItem(old);
    }
    localStorage.setItem('bl2:' + k, JSON.stringify({ t: Date.now(), d: d.slice(0, 20) }));
  } catch {}
}

const CATS = {
  books: { media: 'texts', coll: '', ph: 'Title — e.g. High Output Management' },
  video: { media: 'movies', coll: '(collection:feature_films OR collection:moviesandfilms OR collection:classic_cartoons)', ph: 'Film title — e.g. Night of the Living Dead' },
  anime: { media: 'movies', coll: 'collection:animationandcartoons', ph: 'Animated title…' },
  music: { media: 'audio', coll: '', ph: 'Artist or track — e.g. Beethoven' },
};
let cat = 'books';

function buildQueries(raw, c) {
  const cfg = CATS[c] || CATS.books;
  const base = 'mediatype:' + cfg.media + (cfg.coll ? ' AND (' + cfg.coll + ')' : '');
  const w = words(raw);
  const quoted = luc(raw).slice(0, 120);
  const qs = [];
  if (w.length >= 2) qs.push(base + ' AND title:("' + quoted + '")');
  if (w.length) {
    const tw = w.slice(0, 6).map(x => x).join(' AND ');
    qs.push(base + ' AND title:(' + tw + ')');
  }
  qs.push(base + ' AND (' + w.slice(0, 8).join(' AND ') + ')');
  return qs.slice(0, 3);
}

async function fetchSearch(q, signal) {
  const params = new URLSearchParams();
  params.set('q', q);
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('fl[]', 'creator');
  params.append('fl[]', 'date');
  params.append('fl[]', 'year');
  params.append('fl[]', 'description');
  params.append('fl[]', 'imagecount');
  params.append('fl[]', 'runtime');
  params.append('fl[]', 'duration');
  params.append('fl[]', 'access-restricted-item');
  params.append('fl[]', 'collection');
  params.append('fl[]', 'language');
  params.set('rows', '20');
  params.set('page', '1');
  params.set('output', 'json');
  params.append('sort[]', 'downloads desc');
  const r = await fetch('https://archive.org/advancedsearch.php?' + params.toString(), { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return (j.response && j.response.docs) || [];
}

function isJunk(doc) {
  const t = norm(doc.title || '');
  if (!t) return 50;
  if (t.length < 3) return 80;
  if (/\.(pdf|epub|mobi|txt)$/.test(t)) return 120;
  if (/^(pdf|ocr|full text|scan|combined|collection|misc)/.test(t)) return 60;
  if (/ringtones?|mobile tones?|sms tone|\.mp3 download/i.test(t)) return 160;
  if (/[_]{2,}|[a-z]+\d{4,}/.test(t) && t.split(' ').length < 3) return 70;
  return 0;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'by', 'with', 'for', 'on', 'to', 'in', 'at', 'as', 'is', 'it', 'ed']);
function sig(ws) { return ws.filter(w => w.length > 2 && !STOP.has(w)); }
function baseOf(t) {
  return norm(t).split(' - ')[0].split(' : ')[0].split(' (')[0].split(' / ')[0].trim();
}
function noArt(s) {
  return String(s || '').replace(/^(the|a|an)\s+/i, '');
}

function rankResults(docs, raw) {
  const qw = words(raw);
  const qset = new Set(qw);
  const seen = new Set();
  const out = [];
  for (const d of docs) {
    const id = d.identifier;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = String(d.title || id);
    const tw = words(title);
    const tset = new Set(tw);
    let cover = 0;
    for (const x of qset) if (tset.has(x)) cover++;
    const coverage = qw.length ? cover / qw.length : 0;
    const exact = norm(title) === norm(raw) ? 1 : 0;
    const sqw = new Set(sig(qw)), stw = new Set(sig(tw));
    let hits = 0;
    for (const x of sqw) if (stw.has(x)) hits++;
    const recall = sqw.size ? hits / sqw.size : 0;
    const precision = stw.size ? hits / stw.size : 0;
    const baseExact = baseOf(title) === norm(raw) ? 1 : 0;
    const creator = norm(d.creator || (Array.isArray(d.creator) ? d.creator.join(' ') : ''));
    let authorHit = 0;
    for (const x of tset) { if (creator.includes(x) && x.length > 2) { authorHit = 0; break; } }
    for (const x of qw) { if (creator.includes(x) && x.length > 2) { authorHit = 1; break; } }
    const junk = isJunk(d);
    const mismatch = coverage < 0.34 && !exact ? 1 : 0;
    const scans = parseInt(d.imagecount, 10);
    const med = Number(d._med || 0) || 0;
    const pages = Number.isFinite(scans) ? scans : (med ? med : null);
    const print = pages != null && !Number.isFinite(scans);
    const flag = d['access-restricted-item'];
    const access = accessOf(d);
    const score = exact * 1000 + baseExact * 800 + recall * 200 + precision * 300 + authorHit * 150 + (pages != null ? Math.min(pages, 2000) / 100 : 0) + (d.description ? 5 : 0) - junk - mismatch * 500;
    out.push({ doc: d, title, coverage, exact, mismatch, pages, print, access, score, src: 'Internet Archive', note: 'Stream or download', ia: true, url: 'https://archive.org/details/' + id });
  }
  const tier = { free: 0, borrow: 1, unknown: 2, pay: 3 };
  out.sort((a, b) => {
    if (a.mismatch !== b.mismatch) return a.mismatch - b.mismatch;
    const al = tier[a.access.kind] ?? 2, bl = tier[b.access.kind] ?? 2;
    if (al !== bl) return al - bl;
    if (b.score !== a.score) return b.score - a.score;
    return (b.pages || 0) - (a.pages || 0);
  });
  return out;
}

// Piracy search links — shown ONLY when user explicitly enables pirate mode
// and accepts the disclaimer. These are deep-search links, not embedded streams.
// Domains verified 2026-09-13; pirate sites change constantly.
const PIRATE_SEARCH = {
  anime: [
    ['AniWatch', 'https://aniwatch.so/search?keyword='],
    ['HiAnime', 'https://hianime.so/search?keyword='],
    ['9anime', 'https://9anime.to/search?keyword='],
    ['AnimePahe', 'https://animepahe.ru/search/'],
    ['Gogoanime', 'https://gogoanimehd.to/search.html?keyword='],
    ['AnikotoTV', 'https://anikototv.to/search/'],
  ],
  video: [
    ['LookMovie', 'https://lookmovie2.to/movies/search/?query='],
    ['Fmovies', 'https://fmovies.ps/search?keyword='],
    ['123movies', 'https://123moviesfree.net/search/?query='],
    ['Soap2day', 'https://soap2day.to/search?query='],
    ['YesMovies', 'https://yesmovies.ag/search/?q='],
  ],
  books: [
    ['Z-Library', 'https://z-library.se/s/'],
    ['Libgen', 'https://libgen.li/search.php?req='],
    ['Anna\'s Archive', 'https://annas-archive.se/search?q='],
  ],
  music: [
    ['SoundCloud', 'https://soundcloud.com/search?q='],
  ],
};

function pirateLinks(title) {
  if (!pirateMode) return '';
  const sites = PIRATE_SEARCH[cat];
  if (!sites || !sites.length) return '';
  const q = encodeURIComponent(String(title || '').slice(0, 70));
  return '<div class="pirate-row"><p class="dnote pirate-links"><span class="pirate-tag">⛓ Watch now</span> ' +
    sites.map(([n, b]) =>
      '<a href="' + esc(b + q) + '" target="_blank" rel="noopener" class="pirate-btn">' + esc(n) + '</a>')
    .join('') + '</p></div>';
}

function pirateServicesHtml() {
  if (!pirateMode) return '';
  const sites = PIRATE_SEARCH[cat];
  if (!sites || !sites.length) return '';
  return '<div class="sline pirate-sline"><b>⛓ Pirate sources:</b> ' +
    sites.map(([n, u]) =>
      '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(n) + '</a>').join('') + '</div>';
}

// Top-of-results pirate search box: shows one-click search buttons for the
// current query across all pirate sites in the active category.
function pirateSearchBox(query) {
  if (!pirateMode || !query) return '';
  const sites = PIRATE_SEARCH[cat];
  if (!sites || !sites.length) return '';
  const q = encodeURIComponent(String(query || '').slice(0, 70));
  return '<div class="pirate-box">' +
    '<p class="pirate-box-title">⛓ Search pirate sites for "' + esc(String(query).slice(0, 50)) + '"</p>' +
    '<div class="pirate-box-btns">' +
    sites.map(([n, b]) =>
      '<a href="' + esc(b + q) + '" target="_blank" rel="noopener" class="pirate-btn-lg">' + esc(n) + '</a>')
    .join('') + '</div></div>';
}
const SERVICES = {
  books: {
    open: [
      ['Project Gutenberg', 'https://www.gutenberg.org'],
      ['Open Library', 'https://openlibrary.org'],
      ['Standard Ebooks', 'https://standardebooks.org'],
      ['LibriVox audiobooks', 'https://librivox.org'],
    ],
    card: [
      ['Libby / OverDrive', 'https://libbyapp.com'],
      ['Hoopla', 'https://www.hoopladigital.com'],
    ],
  },
  video: {
    open: [
      ['Tubi', 'https://tubitv.com'],
      ['Pluto TV', 'https://pluto.tv'],
      ['The Roku Channel', 'https://therokuchannel.roku.com'],
      ['Sling Freestream', 'https://www.sling.com/freestream'],
      ['Xumo Play', 'https://play.xumo.com'],
      ['Plex', 'https://watch.plex.tv'],
      ['Vudu Free', 'https://www.vudu.com'],
      ['Crackle', 'https://www.crackle.com'],
      ['Bilibili', 'https://www.bilibili.tv/en/anime'],
    ],
    card: [
      ['Kanopy', 'https://www.kanopy.com'],
      ['Hoopla', 'https://www.hoopladigital.com'],
      ['Libby', 'https://libbyapp.com'],
    ],
  },
  anime: {
    open: [
      ['Muse Asia (official licensor)', 'https://www.youtube.com/@MuseAsia'],
      ['Ani-One Asia (official licensor)', 'https://www.youtube.com/@AniOneAsia'],
      ['Ani-One India', 'https://www.youtube.com/@AniOneIndia'],
      ['AnimeLog', 'https://www.youtube.com/@AnimeLog'],
      ['Bilibili (official anime)', 'https://www.bilibili.tv/en/anime'],
      ['Tubi Anime', 'https://tubitv.com/category/anime'],
      ['Pluto TV Anime', 'https://pluto.tv/live-tv/pluto-tv-anime'],
      ['RetroCrush', 'https://www.retrocrush.tv'],
      ['iQIYI', 'https://www.iq.com'],
    ],
    card: [
      ['Hoopla', 'https://www.hoopladigital.com'],
      ['Kanopy', 'https://www.kanopy.com'],
    ],
  },
  music: {
    open: [
      ['Internet Archive', 'https://archive.org/details/audio'],
      ['Live Music Archive', 'https://archive.org/details/etree'],
      ['Openverse', 'https://openverse.org'],
      ['Audius', 'https://audius.co'],
      ['ccMixter', 'https://ccmixter.org'],
      ['Jamendo', 'https://www.jamendo.com'],
      ['Musopen (public domain)', 'https://musopen.org'],
    ],
    card: [
      ['Freegal Music', 'https://freemusic.freegalmusic.com'],
      ['Hoopla Music', 'https://www.hoopladigital.com'],
    ],
  },
};

function renderServices() {
  const row = document.getElementById('services');
  if (!row) return;
  const s = SERVICES[cat] || SERVICES.books;
  const line = (label, list) => (list && list.length)
    ? '<div class="sline"><b>' + label + '</b> ' + list.map(([n, u]) =>
        '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(n) + '</a>').join('') + '</div>'
    : '';
  const toggle = '<div class="sline pirate-toggle">' +
    '<button id="pirate-toggle" class="' + (pirateMode ? 'on' : '') + '">' +
    (pirateMode ? '⛓ Pirate: ON' : '⛓ Enable pirate sources') + '</button></div>';
  row.innerHTML = line('Free, no account:', s.open) + line('Free with a library card:', s.card)
    + pirateServicesHtml() + toggle;
}

function freeLabel() {
  return cat === 'music' ? 'Free to listen' : (cat === 'video' || cat === 'anime' ? 'Free to watch' : 'Free to read');
}

function accessOf(doc) {
  const flag = doc['access-restricted-item'];
  if (flag === 'true') {
    const raw = Array.isArray(doc.collection) ? doc.collection.join(' ') : String(doc.collection || '');
    const coll = raw.toLowerCase();
    if (/printdisabled|inlibrary|-ol\b|canadianlibraries|toronto/i.test(coll)) {
      return { kind: 'borrow', label: 'Borrow free on Archive', cls: 'borrow' };
    }
    if (coll) return { kind: 'pay', label: 'Preview only — buy or borrow elsewhere', cls: 'pay' };
    return { kind: 'unknown', label: 'Restricted — check Archive for access', cls: 'unknown' };
  }
  return { kind: 'free', label: freeLabel(), cls: 'ok' };
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fixMojibake(s) {
  s = String(s || '');
  if (!/Ã.|â€|Â./.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

function stars(avg) {
  const f = Math.max(0, Math.min(5, Math.round(Number(avg) || 0)));
  return '★'.repeat(f) + '☆'.repeat(5 - f);
}

function subsetWork(title, creator, works) {
  const tw = new Set(sig(words(baseOf(title))));
  if (tw.size < 2) return null;
  const cnorm = norm(creatorText({ creator }) || '');
  for (const o of works) {
    const ow = new Set(sig(words(baseOf(o.title || ''))));
    if (ow.size < 2) continue;
    const [small, big] = tw.size <= ow.size ? [tw, ow] : [ow, tw];
    let ok = true;
    for (const w of small) if (!big.has(w)) { ok = false; break; }
    if (!ok) continue;
    const extra = [...big].filter(w => !small.has(w));
    const authors = norm(((o.author_name || []).join(' ')) + ' ' + cnorm);
    if (extra.every(w => authors.includes(w))) return o;
  }
  return null;
}

async function olEnrich(docs, raw, signal) {
  try {
    const u = 'https://openlibrary.org/search.json?q=' + encodeURIComponent(raw) +
      '&limit=10&fields=key,title,author_name,number_of_pages_median,ratings_average,ratings_count,want_to_read_count,already_read_count';
    const r = await fetch(u, { signal });
    if (!r.ok) return;
    const j = await r.json();
    const byTitle = new Map();
    for (const o of (j.docs || [])) {
      const k = norm(o.title);
      if (k && !byTitle.has(k)) byTitle.set(k, o);
      const ks = noArt(k);
      if (ks && !byTitle.has(ks)) byTitle.set(ks, o);
    }
    for (const d of docs) {
      const t = norm(d.title || '');
      const o = byTitle.get(t) || byTitle.get(noArt(t)) || byTitle.get(baseOf(d.title || '')) || byTitle.get(noArt(baseOf(d.title || ''))) || subsetWork(d.title || '', d.creator || '', j.docs || []);
      if (!o) continue;
      if (o.number_of_pages_median) d._med = Number(o.number_of_pages_median);
      if (o.ratings_average) { d._avg = Number(o.ratings_average); d._cnt = Number(o.ratings_count || 0); }
      if (o.want_to_read_count) d._want = Number(o.want_to_read_count);
      if (o.author_name) d._by = o.author_name.slice(0, 3).join(', ');
      if (o.already_read_count) d._read = Number(o.already_read_count);
    }
  } catch {}
}

function one(v) { return Array.isArray(v) ? v[0] : v; }

function fmtDur(sec) {
  sec = Math.round(Number(sec) || 0);
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  return m + ':' + String(sec % 60).padStart(2, '0');
}

// Legal free-music sources. Both send permissive CORS and need no API key.
async function openverseAudio(q, signal) {
  const r = await fetch('https://api.openverse.org/v1/audio/?q=' + encodeURIComponent(q) + '&page_size=20', { signal });
  if (!r.ok) throw new Error('openverse ' + r.status);
  const j = await r.json();
  return (j.results || []).map(o => ({
    identifier: 'ov-' + String(o.id || '').slice(0, 10),
    title: o.title || 'Untitled',
    creator: o.creator || '',
    description: o.license ? 'License ' + String(o.license).toUpperCase() : '',
    _src: 'Openverse',
    _note: 'Creative Commons · download',
    _url: o.foreign_landing_url || o.url,
    _thumb: o.thumbnail || '',
    _dur: fmtDur((Number(o.duration) || 0) / 1000),
  }));
}

async function audiusTracks(q, signal) {
  const qs = 'query=' + encodeURIComponent(q) + '&limit=20&app_name=findforfree';
  const hosts = [
    'https://api.audius.co/v1',
    'https://discoveryprovider.audius.co/v1',
    'https://discoveryprovider3.audius.co/v1',
  ];
  let lastErr = null;
  for (const h of hosts) {
    try {
      const r = await fetch(h + '/tracks/search?' + qs, { signal });
      if (!r.ok) { lastErr = new Error('audius ' + r.status); continue; }
      const j = await r.json();
      return (j.data || []).map(t => ({
        identifier: 'au-' + String(t.id || '').slice(0, 12),
        title: t.title || 'Untitled',
        creator: (t.user && t.user.name) || '',
        description: t.genre || '',
        _src: 'Audius',
        _note: 'Free streaming',
        _url: t.permalink ? 'https://audius.co' + t.permalink : 'https://audius.co',
        _thumb: (t.artwork && (t.artwork['150x150'] || t.artwork['480x480'])) || '',
        _dur: fmtDur(t.duration),
        _au: t.id,
      }));
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('audius failed');
}

// iTunes Search API: keyless, CORS-enabled (*), legal 30-sec previews + store links.
async function itunesMusic(q, signal) {
  const r = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(q) +
    '&media=music&entity=song&limit=20&country=US', { signal });
  if (!r.ok) throw new Error('itunes ' + r.status);
  const j = await r.json();
  return ((j.results || []).map(t => ({
    identifier: 'it-' + String(t.trackId || Math.abs(hashStr(t.trackName + t.artistName))),
    title: t.trackName || 'Untitled',
    creator: t.artistName || '',
    description: (t.collectionName ? 'Album: ' + t.collectionName : '') +
      (t.primaryGenreName ? ' · ' + t.primaryGenreName : ''),
    _src: 'Apple Music',
    _note: '30-sec preview · free',
    _url: t.trackViewUrl || 'https://music.apple.com/us/search?term=' + encodeURIComponent(q),
    _thumb: t.artworkUrl100 || '',
    _dur: fmtDur((Number(t.trackTimeMillis) || 0) / 1000),
    _preview: t.previewUrl || '',
  })));
}

function hashStr(s) {
  let h = 0;
  s = String(s || '');
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

// MusicBrainz: keyless, CORS-enabled, the open music encyclopedia (metadata + links).
async function musicBrainzRecs(q, signal) {
  const r = await fetch('https://musicbrainz.org/ws/2/recording/?query=' +
    encodeURIComponent('recording:"' + luc(q).slice(0, 60) + '"') + '&fmt=json&limit=10',
    { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('musicbrainz ' + r.status);
  const j = await r.json();
  return ((j.recordings || []).map(t => {
    const artist = ((t['artist-credit'] || []).map(a => a.name).filter(Boolean).join(', ')) || '';
    return {
      identifier: 'mb-' + String(t.id || '').slice(0, 8),
      title: t.title || 'Untitled',
      creator: artist,
      description: (t.disambiguation ? t.disambiguation + ' · ' : '') +
        (((t.releases || [])[0] || {}).title ? 'Release: ' + (t.releases[0].title) : ''),
      _src: 'MusicBrainz',
      _note: 'Open metadata · find free recordings',
      _url: 'https://musicbrainz.org/recording/' + (t.id || ''),
      _thumb: '',
      _dur: fmtDur((Number(t.length) || 0) / 1000),
    };
  }));
}

// ---- Anime: keyless metadata with real fuzzy search (fixes "crayon shin" = zero) ----
async function jikanAnime(q, signal) {
  const r = await fetch('https://api.jikan.moe/v4/anime?q=' + encodeURIComponent(q) +
    '&limit=10&sfw=true&order_by=members&sort=desc', { signal });
  if (!r.ok) throw new Error('jikan ' + r.status);
  const j = await r.json();
  return ((j.data || []).map(a => ({
    identifier: 'jk-' + String(a.mal_id || Math.abs(hashStr(a.title))),
    title: a.title_english || a.title || 'Untitled',
    creator: ((a.studios || []).map(s => s.name).join(', ')) || '',
    description: String(a.synopsis || '').slice(0, 280),
    _src: 'MyAnimeList',
    _note: (a.score ? '★ ' + a.score + ' · ' : '') + (a.type || 'Anime') + ' · check free providers below',
    _url: a.url || 'https://myanimelist.net/anime.php?q=' + encodeURIComponent(q),
    _thumb: (a.images && a.images.jpg && (a.images.jpg.large_image_url || a.images.jpg.image_url)) || '',
    _year: String((a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year) || a.year || ''),
  })));
}

async function kitsuAnime(q, signal) {
  const r = await fetch('https://kitsu.io/api/edge/anime?filter[text]=' + encodeURIComponent(q) +
    '&page[limit]=10', { signal, headers: { Accept: 'application/vnd.api+json' } });
  if (!r.ok) throw new Error('kitsu ' + r.status);
  const j = await r.json();
  return ((j.data || []).map(a => {
    const at = a.attributes || {};
    return {
      identifier: 'kt-' + String(a.id || '').slice(0, 10),
      title: (at.titles && (at.titles.en || at.titles.en_us || at.canonicalTitle)) || 'Untitled',
      creator: '',
      description: String(at.synopsis || '').slice(0, 280),
      _src: 'Kitsu',
      _note: (at.averageRating ? '★ ' + (Number(at.averageRating) / 20).toFixed(1) + ' · ' : '') +
        (at.showType || 'Anime') + ' · check free providers below',
      _url: 'https://kitsu.io/anime/' + (a.id || ''),
      _thumb: (at.posterImage && (at.posterImage.small || at.posterImage.medium)) || '',
      _year: String((at.startDate || '').slice(0, 4)),
    };
  }));
}

async function anilistAnime(q, signal) {
  const query = 'query($q:String){Page(perPage:8){media(search:$q,type:ANIME){id title{romaji english} description coverImage{medium large} siteUrl averageScore startDate{year} format}}}';
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { q } }),
  });
  if (!r.ok) throw new Error('anilist ' + r.status);
  const j = await r.json();
  const list = (j.data && j.data.Page && j.data.Page.media) || [];
  return list.map(m => ({
    identifier: 'al-' + String(m.id || '').slice(0, 10),
    title: ((m.title || {}).english || (m.title || {}).romaji) || 'Untitled',
    creator: '',
    description: String((m.description || '').replace(/<[^>]+>/g, ' ')).slice(0, 280),
    _src: 'AniList',
    _note: (m.averageScore ? '★ ' + (Number(m.averageScore) / 20).toFixed(1) + ' · ' : '') +
      (m.format || 'Anime') + ' · check free providers below',
    _url: m.siteUrl || ('https://anilist.co/search/anime?search=' + encodeURIComponent(q)),
    _thumb: (m.coverImage && (m.coverImage.large || m.coverImage.medium)) || '',
    _year: String((m.startDate && m.startDate.year) || ''),
  }));
}

// ---- Video: TVMaze (keyless, CORS) so licensed titles never return zero ----
async function tvmazeShows(q, signal) {
  const r = await fetch('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q), { signal });
  if (!r.ok) throw new Error('tvmaze ' + r.status);
  const j = await r.json();
  return ((Array.isArray(j) ? j : []).slice(0, 10).map(o => {
    const s = o.show || {};
    return {
      identifier: 'tv-' + String(s.id || Math.abs(hashStr(s.name))),
      title: s.name || 'Untitled',
      creator: ((s.network && s.network.name) || (s.webChannel && s.webChannel.name) || ''),
      description: String(s.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280),
      _src: 'TVMaze',
      _note: (s.status ? s.status + ' · ' : '') + 'check free providers below',
      _url: s.officialSite || s.url || ('https://www.tvmaze.com/search?q=' + encodeURIComponent(q)),
      _thumb: (s.image && (s.image.medium || s.image.original)) || '',
      _year: String((s.premiered || '').slice(0, 4)),
    };
  }));
}

// ---- Books: Open Library + Gutenberg (Gutendex) + Google Books, all keyless ----
async function olBooks(q, signal) {
  const u = 'https://openlibrary.org/search.json?q=' + encodeURIComponent(q) +
    '&limit=15&fields=key,title,author_name,first_publish_year,cover_i,ratings_average,ratings_count,number_of_pages_median';
  const r = await fetch(u, { signal });
  if (!r.ok) throw new Error('ol ' + r.status);
  const j = await r.json();
  return ((j.docs || []).map(o => ({
    identifier: 'ol-' + String(o.key || o.title).replace(/[^a-z0-9]+/gi, '').slice(0, 12),
    title: o.title || 'Untitled',
    creator: (o.author_name || []).slice(0, 3).join(', '),
    description: '',
    _src: 'Open Library',
    _note: 'Borrow free with account',
    _url: 'https://openlibrary.org' + (o.key || ''),
    _thumb: o.cover_i ? 'https://covers.openlibrary.org/b/id/' + o.cover_i + '-M.jpg' : '',
    _year: String(o.first_publish_year || ''),
    _avg: o.ratings_average, _cnt: o.ratings_count,
    _med: o.number_of_pages_median,
  })));
}

async function gutendexBooks(q, signal) {
  const r = await fetch('https://gutendex.com/books/?search=' + encodeURIComponent(q), { signal });
  if (!r.ok) throw new Error('gutendex ' + r.status);
  const j = await r.json();
  return ((j.results || []).slice(0, 10).map(b => {
    const gid = b.id;
    const img = (b.formats && (b.formats['image/jpeg'] || b.formats['image/png'])) || '';
    return {
      identifier: 'gx-' + String(gid),
      title: b.title || 'Untitled',
      creator: ((b.authors || []).map(a => a.name).join(', ')),
      description: ((b.subjects || []).slice(0, 4).join(' · ')).slice(0, 200),
      _src: 'Project Gutenberg',
      _note: 'Free ebook · public domain',
      _url: 'https://www.gutenberg.org/ebooks/' + gid,
      _thumb: img,
      _dur: '',
    };
  }));
}

async function googleBooks(q, signal) {
  const r = await fetch('https://www.googleapis.com/books/v1/volumes?q=' +
    encodeURIComponent(q) + '&maxResults=15', { signal });
  if (!r.ok) throw new Error('gbooks ' + r.status);
  const j = await r.json();
  return (((j.items || [])).map(it => {
    const v = it.volumeInfo || {};
    const isbn = ((v.industryIdentifiers || []).map(x => x.identifier).join('')).slice(0, 13);
    return {
      identifier: 'gb-' + String(it.id || isbn).slice(0, 12),
      title: v.title || 'Untitled',
      creator: (v.authors || []).slice(0, 3).join(', '),
      description: String(v.description || '').replace(/<[^>]+>/g, ' ').slice(0, 280),
      _src: 'Google Books',
      _note: 'Preview / free where available',
      _url: v.infoLink || ('https://books.google.com/books?q=' + encodeURIComponent(q)),
      _thumb: (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '',
      _year: String((v.publishedDate || '').slice(0, 4)),
    };
  }));
}

// Live Music Archive: 300k+ concert recordings artists allow fans to tape & share.
async function liveMusic(q, signal) {
  const url = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent('collection:etree AND (' + luc(q).slice(0, 80) + ')') +
    '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&fl[]=description&sort[]=downloads%20desc&rows=15&output=json';
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error('etree ' + r.status);
  const j = await r.json();
  return ((j.response && j.response.docs) || []).map(d => ({
    ...d,
    _src: 'Live Music Archive',
    _note: 'Free · artist-approved recording',
    _ia: true,
  }));
}

// Every source below is public, keyless and browser-callable. No API keys.
// Failures are isolated via allSettled so one dead source never zeroes results.
function otherSources(c, q, signal) {
  const jobs = [];
  if (c === 'music') jobs.push(
    itunesMusic(q, signal), audiusTracks(q, signal), liveMusic(q, signal),
    musicBrainzRecs(q, signal), openverseAudio(q, signal),
  );
  else if (c === 'anime') jobs.push(
    kitsuAnime(q, signal), anilistAnime(q, signal), jikanAnime(q, signal),
  );
  else if (c === 'video') jobs.push(tvmazeShows(q, signal));
  else if (c === 'books') jobs.push(olBooks(q, signal), gutendexBooks(q, signal), googleBooks(q, signal));
  if (!jobs.length) return Promise.resolve([]);
  return Promise.allSettled(jobs).then(rs => rs.flatMap(r => (r.status === 'fulfilled' ? r.value : [])));
}

// Interleave by source so one catalogue can't dominate the top of the list —
// the user sees a real mix of services (Audius, Openverse, LMA, Archive…).
function interleaveBy(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out;
}

// Info-only databases must never wear a "Free to watch/read" stamp — that is
// what sent you to a Kitsu page with no play button. Only playable sources
// (Archive, Audius, Apple previews, Gutenberg…) get the free stamp.
const META_STAMP = {
  'MyAnimeList': 'Info only · use providers below',
  'Kitsu': 'Info only · use providers below',
  'AniList': 'Info only · use providers below',
  'TVMaze': 'Info only · use providers below',
  'MusicBrainz': 'Metadata · find free recordings',
  'Google Books': 'Preview · check free sources',
};
function extrasToRanked(items, query) {
  const sq = new Set(sig(words(query)));
  return items.map(d => {
    const tw = new Set(sig(words(d.title)));
    let hits = 0;
    for (const w of sq) if (tw.has(w)) hits++;
    const cov = sq.size ? hits / sq.size : 0;
    const meta = META_STAMP[d._src];
    const borrow = d._src === 'Open Library';
    return {
      doc: d,
      title: d.title,
      score: cov * 400,
      mismatch: false,
      pages: null,
      print: false,
      access: meta
        ? { kind: 'unknown', label: meta, cls: 'unknown' }
        : borrow
          ? { kind: 'borrow', label: 'Borrow free with account', cls: 'borrow' }
          : { kind: 'free', label: freeLabel(), cls: 'ok' },
      src: d._src,
      note: d._note,
      ia: !!d._ia,
      url: d._url,
      thumb: d._thumb,
      dur: d._dur,
      year: d._year,
      au: d._au,
    };
  });
}

function creatorText(d) {
  if (Array.isArray(d.creator)) return d.creator.slice(0, 3).join(', ');
  return d.creator || d._by || '';
}

const dlCache = new Map();

function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function pickDownloads(files) {
  const ext = { '.pdf': 'PDF', '.epub': 'EPUB', '.mobi': 'Kindle', '.azw': 'Kindle', '.djvu': 'DjVu', '.txt': 'Plain text', '.torrent': 'Torrent', '.mp4': 'Video', '.ogv': 'Video', '.webm': 'Video', '.mp3': 'Audio', '.ogg': 'Audio', '.flac': 'Audio', '.m4a': 'Audio' };
  const main = [], more = [];
  for (const f of (files || [])) {
    const name = String(f.name || '');
    if (!name) continue;
    const low = name.toLowerCase();
    if (/__ia_thumb|thumb\.jpg|\.gif$|\.png$|\.log$|_meta\.sqlite$|_files\.xml$|_marc\.xml$/.test(low)) continue;
    const dot = low.lastIndexOf('.');
    const e = dot >= 0 ? low.slice(dot) : '';
    const size = fmtSize(f.size);
    if (ext[e] && !/\.gz$|\.xml$|\.json$|\.sqlite$|\.zip$/.test(low)) {
      let label = ext[e];
      if (/_text\.pdf$/.test(low)) label = 'PDF (searchable text)';
      if (/_djvu\.txt$/.test(low)) label = 'Full text (OCR)';
      main.push({ name, label, size });
    } else if (!/\.gz$|\.xml$|\.json$|\.sqlite$/.test(low)) {
      more.push({ name, label: (/\.zip$/.test(low) ? 'Page images (ZIP)' : name.split('.').pop().toUpperCase() + ' file'), size });
    }
  }
  const byLen = (a, b) => a.name.length - b.name.length;
  main.sort(byLen);
  more.sort(byLen);
  return { main, more };
}

function dlShell(title) {
  let ov = document.getElementById('dlov');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'dlov';
    ov.hidden = true;
    ov.innerHTML = '<div class="dlg" role="dialog" aria-modal="true"><button class="x" aria-label="Close">×</button><h3></h3><div class="dbody"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.x')) closeDownloads(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDownloads(); });
  }
  ov.querySelector('h3').textContent = title;
  return ov;
}

function closeDownloads() {
  const ov = document.getElementById('dlov');
  if (ov) ov.hidden = true;
  document.body.style.overflow = '';
}

async function openDownloads(id, title, kind) {
  const ov = dlShell(title || id);
  const body = ov.querySelector('.dbody');
  ov.hidden = false;
  document.body.style.overflow = 'hidden';
  const link = (href, t) => '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(t) + '</a>';
  const details = 'https://archive.org/details/' + id;
  if (kind === 'borrow') {
    body.innerHTML = '<p class="dnote">Borrow-only on Archive — its files unlock after you borrow it with a free account.</p><p>' + link(details, 'Open on Archive to borrow') + '</p>';
    return;
  }
  if (kind === 'pay') {
    body.innerHTML = '<p class="dnote">Preview only — buy a copy or borrow it elsewhere.</p><p>' + link(details, 'Open on Archive') + '</p>';
    return;
  }
  body.innerHTML = '<p class="dnote">Loading files…</p>';
  try {
    let files = dlCache.get(id);
    let md = null;
    if (!files || kind === 'unknown') {
      const r = await fetch('https://archive.org/metadata/' + encodeURIComponent(id));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      files = j.files || [];
      md = j.metadata || {};
      dlCache.set(id, files);
    }
    if (kind === 'unknown') {
      const live = accessOf({ 'access-restricted-item': md ? md['access-restricted-item'] : undefined, collection: md ? md.collection : undefined });
      const k = live ? live.kind : kind;
      if (k === 'borrow') {
        body.innerHTML = '<p class="dnote">Borrow-only on Archive — its files unlock after you borrow it with a free account.</p><p>' + link(details, 'Open on Archive to borrow') + '</p>';
        return;
      }
      if (k === 'pay' || k === 'unknown') {
        body.innerHTML = '<p class="dnote">No open downloads — check access on the Archive page.</p><p>' + link(details, 'Open on Archive') + '</p>';
        return;
      }
    }
    const { main, more } = pickDownloads(files);
    if (!main.length && !more.length) {
      body.innerHTML = '<p class="dnote">No direct downloads listed.</p><p>' + link(details, 'See all files on Archive') + '</p>';
      return;
    }
    const row = (o) =>
      '<p class="drow"><span>' + esc(o.label) + ' · ' + esc(o.size) + '<br><small>' + esc(o.name) + '</small></span>' +
      link('https://archive.org/download/' + encodeURIComponent(id) + '/' + encodeURIComponent(o.name), 'Download') + '</p>';
    body.innerHTML = main.map(row).join('') +
      (more.length ? '<p class="dsec">More files</p>' + more.map(row).join('') : '') +
      '<p class="dnote">' + link(details, 'All files on Archive') + '</p>';
  } catch (e) {
    body.innerHTML = '<p class="dnote">Could not load files right now.</p><p>' + link(details, 'Open on Archive') + '</p>';
  }
}

function yearText(d) {
  const y = d.year || (d.date || '').slice(0, 4);
  return /^\d{4}$/.test(String(y)) ? String(y) : '';
}

let lastWords = [];
let lastQuery = '';

function hi(t) {
  let s = esc(t);
  for (const w of lastWords) {
    if (!w) continue;
    const re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    s = s.replace(re, '<mark>$1</mark>');
  }
  return s;
}

function sortDocs(list) {
  const arr = [...list];
  const tier = { free: 0, borrow: 1, unknown: 2, pay: 3 };
  arr.sort((a, b) => {
    if (a.mismatch !== b.mismatch) return a.mismatch - b.mismatch;
    const al = tier[a.access.kind] ?? 2, bl = tier[b.access.kind] ?? 2;
    if (al !== bl) return al - bl;
    if (b.score !== a.score) return b.score - a.score;
    return (b.pages || 0) - (a.pages || 0);
  });
  return arr;
}

// Per-title deep links into each free provider's own search. Keyless, so every
// result can hand the user a direct path to check each free service in turn.
const FREE_SEARCH = [
  ['YouTube', 'https://www.youtube.com/results?search_query='],
  ['Tubi', 'https://tubitv.com/search/'],
  ['Pluto TV', 'https://pluto.tv/en/search?q='],
  ['Roku', 'https://therokuchannel.roku.com/search/'],
  ['iQIYI', 'https://www.iq.com/search?query='],
  ['Bilibili', 'https://www.bilibili.tv/en/search?keyword='],
  ['JustWatch', 'https://www.justwatch.com/us/search?q='],
];

function provLinks(title) {
  const q = encodeURIComponent(String(title || '').slice(0, 70));
  return '<p class="dnote">▶ Watch free on: ' + FREE_SEARCH.map(([n, b]) =>
    '<a href="' + esc(b + q) + '" target="_blank" rel="noopener">' + esc(n) + '</a>').join(' · ') + '</p>';
}

// In-page audio playback. Audius streams full tracks; Archive items resolve to
// their first playable file on click. Both are keyless and legal to stream.
let audioEl = null;
const auFileCache = new Map();

function audio() {
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = 'aud';
    audioEl.controls = true;
    audioEl.preload = 'none';
    audioEl.hidden = true;
    document.body.appendChild(audioEl);
  }
  return audioEl;
}

async function playAudio(ref, title) {
  const idx = String(ref).indexOf(':');
  const kind = idx >= 0 ? String(ref).slice(0, idx) : String(ref);
  const val = idx >= 0 ? String(ref).slice(idx + 1) : '';
  const el = audio();
  if (kind === 'pv') {
    try {
      const url = decodeURIComponent(val);
      if (!/^https:\/\//.test(url)) return;
      el.src = url;
      el.hidden = false;
      try { await el.play(); } catch {}
    } catch {}
    return;
  }
  if (kind === 'au') {
    el.src = 'https://api.audius.co/v1/tracks/' + encodeURIComponent(val) + '/stream?app_name=findforfree';
    el.hidden = false;
    try { await el.play(); } catch {}
    return;
  }
  if (kind === 'ia') {
    statusEl.textContent = 'Loading audio…';
    let file = auFileCache.get(val);
    if (file === undefined) {
      try {
        const r = await fetch('https://archive.org/metadata/' + encodeURIComponent(val));
        const j = await r.json();
        const f = (j.files || []).find(x => /\.(mp3|ogg|m4a|flac)$/i.test(x.name || ''));
        file = f ? f.name : '';
      } catch { file = ''; }
      auFileCache.set(val, file);
    }
    statusEl.textContent = '';
    if (!file) { statusEl.textContent = 'No playable audio file on this item — try Download options.'; return; }
    el.src = 'https://archive.org/download/' + encodeURIComponent(val) + '/' + encodeURIComponent(file);
    el.hidden = false;
    try { await el.play(); } catch {}
  }
}

// Unified action buttons for ALL categories — play, read, watch, download.
// Each result's identifier prefix tells us the source and available actions.
function actionBtns(r) {
  const id = String((r.doc && r.doc.identifier) || '');
  const t = esc(String(r.title || '').slice(0, 80));
  const url = r.url || '';
  let html = '';

  // --- Music: play / preview / download ---
  if (cat === 'music') {
    if (r.doc && r.doc._preview) {
      html += '<p class="dl"><button data-play="pv:' + esc(encodeURIComponent(r.doc._preview)) + '" data-title="' + t + '">▶ Preview (30s)</button></p>';
    }
    if (r.au) {
      html += '<p class="dl"><button data-play="au:' + esc(String(r.au)) + '" data-title="' + t + '">▶ Play full track</button></p>';
    }
    if (r.ia) {
      html += '<p class="dl"><button data-play="ia:' + esc(id) + '" data-title="' + t + '">▶ Play</button></p>';
      html += '<p class="dl"><button data-dl="' + esc(id) + '" data-kind="' + esc(r.access.kind) + '" data-title="' + t + '">Download audio</button></p>';
    }
    if (id.startsWith('it-') && url) {
      html += '<p class="dl"><a href="' + esc(url) + '" target="_blank" rel="noopener" class="action-link">Open in Apple Music</a></p>';
    }
    if (id.startsWith('au-') && url) {
      html += '<p class="dl"><a href="' + esc(url) + '" target="_blank" rel="noopener" class="action-link">Open in Audius</a></p>';
    }
    if (id.startsWith('mb-') && url) {
      html += '<p class="dl"><a href="' + esc(url) + '" target="_blank" rel="noopener" class="action-link">View on MusicBrainz</a></p>';
    }
  }

  // --- Books: read / borrow / download ---
  if (cat === 'books') {
    if (id.startsWith('gx-')) {
      const gid = id.replace('gx-', '');
      html += '<p class="dl"><a href="https://www.gutenberg.org/ebooks/' + esc(gid) + '" target="_blank" rel="noopener" class="action-link action-read">Read free (Gutenberg)</a></p>';
      html += '<p class="dl"><a href="https://www.gutenberg.org/ebooks/' + esc(gid) + '.epub.noimages" target="_blank" rel="noopener" class="action-link">Download EPUB</a></p>';
      html += '<p class="dl"><a href="https://www.gutenberg.org/ebooks/' + esc(gid) + '.txt.utf-8" target="_blank" rel="noopener" class="action-link">Download plain text</a></p>';
    }
    if (id.startsWith('ol-') && url) {
      html += '<p class="dl"><a href="' + esc(url) + '" target="_blank" rel="noopener" class="action-link action-read">Borrow free (Open Library)</a></p>';
    }
    if (id.startsWith('gb-') && url) {
      html += '<p class="dl"><a href="' + esc(url) + '" target="_blank" rel="noopener" class="action-link">Preview (Google Books)</a></p>';
    }
    if (r.ia) {
      html += '<p class="dl"><button data-dl="' + esc(id) + '" data-kind="' + esc(r.access.kind) + '" data-title="' + t + '">Download options</button></p>';
    }
  }

  // --- Video / Anime: watch / trailer ---
  if (cat === 'video' || cat === 'anime') {
    if (r.ia) {
      html += '<p class="dl"><button data-play="ia:' + esc(id) + '" data-title="' + t + '">▶ Watch</button></p>';
      html += '<p class="dl"><button data-dl="' + esc(id) + '" data-kind="' + esc(r.access.kind) + '" data-title="' + t + '">Download video</button></p>';
    }
    if (url) {
      html += '<p class="dl"><a href="' + esc(url) + '" target="_blank" rel="noopener" class="action-link">View details</a></p>';
    }
  }

  return html;
}

function render(list) {
  resultsEl.innerHTML = '';
  if (!list.length) {
    resultsEl.innerHTML = '<div class="empty">No matches for that query.<br><span class="etips">Try fewer words, check spelling, or try one of these:</span></div><div id="tryempty">Try: <button data-try="High Output Management">High Output Management</button><button data-try="Lord of the Flies">Lord of the Flies</button><button data-try="Pride and Prejudice">Pride and Prejudice</button></div>'
      + ((cat === 'video' || cat === 'anime') ? '<div class="provpanel">' + provLinks(lastQuery) + '</div>' : '')
      + pirateSearchBox(lastQuery);
    return;
  }
  // Pirate search box goes ABOVE all legal results when pirate mode is on
  if (pirateMode) {
    const box = document.createElement('div');
    box.innerHTML = pirateSearchBox(lastQuery);
    resultsEl.appendChild(box);
  }
  list.forEach((r, i) => {
    const d = r.doc;
    const id = d.identifier;
    const url = r.url || ('https://archive.org/details/' + id);
    const thumb = r.thumb || ('https://archive.org/services/img/' + encodeURIComponent(id));
    const by = fixMojibake(creatorText(d));
    const yr = r.year || yearText(d);
    const descRaw = fixMojibake(String(d.description || '')).replace(/\s+/g, ' ').trim();
    const desc = descRaw.length > 6 ? descRaw.slice(0, 280) : '';
    const dur = r.dur || one(d.runtime) || one(d.duration);
    const row = document.createElement('article');
    row.className = 'row';
    row.dataset.id = id;
    row.innerHTML =
      '<span class="idx">' + (i + 1) + '</span>' +
      '<img class="cover" loading="lazy" alt="" src="' + esc(thumb) + '">' +
      '<div class="main">' +
      '<h2>' + hi(fixMojibake(r.title)) + '</h2>' +
      '<p class="byline">' + esc([by, yr].filter(Boolean).join(' · ')) + '</p>' +
      '<div class="badges">' +
      (r.pages != null ? '<span class="stamp pages">' + (r.print ? '≈' + r.pages + ' print ed.' : r.pages + ' scans') + '</span>' : (dur ? '<span class="stamp pages">' + esc(String(dur).slice(0, 16)) + '</span>' : '')) +
      '<span class="stamp ' + r.access.cls + '">' + esc(r.access.label) + '</span>' +
      '<span class="stamp src">' + esc(r.src || 'Internet Archive') + '</span>' +
      (r.mismatch ? '<span class="stamp mismatch">possible mismatch</span>' : '') +
      '</div>' +
      (desc ? '<p class="desc">' + hi(desc) + '</p>' : '') +
      (d._avg ? '<p class="meta"><span class="stars">' + stars(d._avg) + '</span> ' + Number(d._avg).toFixed(1) + ' · ' + (d._cnt || 0) + ' ratings' + (d._want ? ' · want ' + d._want : '') + (d._read ? ' · read ' + d._read : '') + '</p>' : '') +
      '<p class="url"><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a></p>' +
      ((cat === 'video' || cat === 'anime' || cat === 'books' || cat === 'music') ? pirateLinks(r.title) : '') +
      ((cat === 'video' || cat === 'anime') ? provLinks(r.title) : '') +
      actionBtns(r) +
      (r.note ? '<p class="dnote">' + esc(r.note) + '</p>' : '') +
      '</div>';
    const img = row.querySelector('img');
    img.onerror = () => { img.style.visibility = 'hidden'; };
    resultsEl.appendChild(row);
  });
}

function pageBadgeText(r) {
  if (r.pages == null) return null;
  return r.print ? '≈' + r.pages + ' print ed.' : r.pages + ' scans';
}

async function enrichCounts(ranked, key, my) {
  const missing = ranked.filter(r => r.pages == null);
  if (!missing.length) return;
  await Promise.allSettled(missing.map(async (r) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const resp = await fetch('https://archive.org/metadata/' + encodeURIComponent(r.doc.identifier), { signal: ctl.signal });
      clearTimeout(t);
      if (!resp.ok) return;
      const j = await resp.json();
      const ic = j && j.metadata && j.metadata.imagecount;
      if (!ic || my !== runSeq) return;
      r.doc.imagecount = ic;
      r.pages = Number(ic);
      r.print = false;
      const el = resultsEl.querySelector('[data-id="' + CSS.escape(r.doc.identifier) + '"] .stamp.pages');
      if (el) el.textContent = pageBadgeText(r);
      else {
        const badges = resultsEl.querySelector('[data-id="' + CSS.escape(r.doc.identifier) + '"] .badges');
        if (badges) {
          const s = document.createElement('span');
          s.className = 'stamp pages';
          s.textContent = pageBadgeText(r);
          badges.prepend(s);
        }
      }
    } catch {}
  }));
  if (my !== runSeq) return;
  cacheSet(key, ranked);
}

async function runSearch(raw, opts) {
  const query = raw.trim();
  if (query.length < 4) {
    statusEl.textContent = query.length < 2 ? 'Type a title to search free media.' : 'Keep typing…';
    if (!query) resultsEl.innerHTML = '';
    stopAnimate();
    document.body.classList.remove('searched');
    return;
  }
  const key = cat + ':' + norm(query);
  lastQuery = query;
  const hit = cacheGet(key);
  document.body.classList.toggle('searched', query.length >= 4);
  lastWords = sig(words(query));
  stopAnimate();
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const my = ++runSeq;
  if (hit) {
    statusEl.textContent = '';
    render(sortDocs(hit));
    if (cat === 'books') enrichCounts(hit, key, my).catch(() => {});
    if (opts && opts.fromCache) return;
  } else {
    resultsEl.innerHTML = '';
  }
  liveCount = 0;
  animateStatus(cat === 'books' ? 'Searching Internet Archive' : 'Searching ' + cat);
  try {
    // Fire the keyless meta sources NOW so they run in parallel with the
    // Archive queries below instead of waiting behind them.
    const extrasP = otherSources(cat, query, ctl.signal);
    const queries = buildQueries(query, cat);
    let docs = [];
    for (const qq of queries) {
      const got = await fetchSearch(qq, ctl.signal);
      if (my !== runSeq) return;
      let added = 0;
      for (const d of got) if (!docs.find(x => x.identifier === d.identifier)) { docs.push(d); added++; }
      if (added) {
        liveCount = docs.length;
        render(sortDocs(rankResults(docs, query).slice(0, 20)));
      }
      if (docs.length >= 12) break;
    }
    if (cat === 'books') await olEnrich(docs, query, ctl.signal);
    if (my !== runSeq) return;
    let combined = rankResults(docs, query).slice(0, 20);
    try {
      const ex = await extrasP;
      if (my !== runSeq) return;
      if (ex.length) {
        const top = (src, n) => extrasToRanked(ex.filter(x => x._src === src), query)
          .sort((a, b) => b.score - a.score).slice(0, n);
        let mixed = null;
        if (cat === 'music') {
          mixed = interleaveBy([
            top('Apple Music', 8),
            top('Audius', 8),
            top('Openverse', 6),
            top('Live Music Archive', 6),
            top('MusicBrainz', 6),
            sortDocs(combined).slice(0, 8),
          ]);
        } else if (cat === 'anime') {
          mixed = interleaveBy([
            top('Kitsu', 8),
            top('AniList', 6),
            top('MyAnimeList', 6),
            sortDocs(combined).slice(0, 8),
          ]);
        } else if (cat === 'video') {
          mixed = interleaveBy([
            top('TVMaze', 8),
            sortDocs(combined).slice(0, 10),
          ]);
        } else if (cat === 'books') {
          mixed = interleaveBy([
            top('Open Library', 8),
            top('Project Gutenberg', 6),
            top('Google Books', 6),
            sortDocs(combined).slice(0, 8),
          ]);
        }
        if (mixed && mixed.length) {
          mixed.sort((a, b) => (a.mismatch ? 1 : 0) - (b.mismatch ? 1 : 0));
          combined = mixed;
        }
      }
    } catch {}
    const ranked = (cat === 'music' || cat === 'anime' || cat === 'video' || cat === 'books'
      ? combined : sortDocs(combined)).slice(0, 20);
    cacheSet(key, ranked);
    if (norm(qEl.value) !== norm(query)) return;
    stopAnimate();
    statusEl.textContent = '';
    render(ranked);
    if (cat === 'books') enrichCounts(ranked, key, my).catch(() => {});
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    stopAnimate();
    const stale = cacheGet(key);
    if (stale) {
      statusEl.textContent = '';
      render(stale);
    } else {
      statusEl.textContent = 'Archive.org unreachable right now — try again.';
    }
  }
}

function syncUrl(v) {
  const url = new URL(location.href);
  if (norm(v).length >= 4) url.searchParams.set('q', v.trim());
  else url.searchParams.delete('q');
  url.searchParams.set('cat', cat);
  history.replaceState(null, '', url.toString());
}

function schedule() {
  clearTimeout(debounceT);
  debounceT = setTimeout(() => {
    syncUrl(qEl.value);
    runSearch(qEl.value);
  }, 300);
}

qEl.addEventListener('input', schedule);
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(debounceT);
    runSearch(qEl.value);
  }
});

resultsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-dl]');
  if (b) { openDownloads(b.getAttribute('data-dl'), b.getAttribute('data-title') || '', b.getAttribute('data-kind') || 'unknown'); return; }
  const p = e.target.closest('[data-play]');
  if (p) playAudio(p.getAttribute('data-play'), p.getAttribute('data-title') || '');
});

document.getElementById('cat').addEventListener('change', (e) => {
  cat = CATS[e.target.value] ? e.target.value : 'books';
  qEl.placeholder = CATS[cat].ph;
  renderServices();
  clearTimeout(debounceT);
  syncUrl(qEl.value);
  if (qEl.value.trim().length >= 4) runSearch(qEl.value);
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-try]');
  if (!t) return;
  qEl.value = t.getAttribute('data-try');
  clearTimeout(debounceT);
  syncUrl(qEl.value);
  runSearch(qEl.value);
  qEl.focus();
});

// --- Pirate mode toggle + disclaimer modal ---
function disclaimerShell() {
  let ov = document.getElementById('pirate-ov');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'pirate-ov';
  ov.hidden = true;
  ov.innerHTML =
    '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="pirate-dtitle">' +
    '<button class="x" aria-label="Close">×</button>' +
    '<h3 id="pirate-dtitle">Pirate Sources Disclaimer</h3>' +
    '<div class="dbody">' +
    '<p><strong>These are unlicensed third-party sites.</strong> Find For Free does not host, embed, or control any content on them.</p>' +
    '<p>By enabling pirate sources you acknowledge and agree that:</p>' +
    '<ul>' +
    '<li>You are solely responsible for your use of these links.</li>' +
    '<li>Find For Free is <strong>not affiliated</strong> with any pirate site listed.</li>' +
    '<li>You understand these sites may violate copyright laws in your jurisdiction.</li>' +
    '<li>You assume all legal and personal risk.</li>' +
    '</ul>' +
    '<p class="dnote">Legal (free with ads / library) sources remain visible by default and are always recommended first.</p>' +
    '<p><label class="agree-label"><input type="checkbox" id="pirate-agree"> I have read and agree to these terms</label></p>' +
    '<p><button id="pirate-confirm" disabled>Enable pirate sources</button></p>' +
    '</div></div>';
  document.body.appendChild(ov);
  const cb = ov.querySelector('#pirate-agree');
  const btn = ov.querySelector('#pirate-confirm');
  const close = () => { ov.hidden = true; document.body.style.overflow = ''; };
  cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
  btn.addEventListener('click', () => {
    pirateMode = true;
    try { localStorage.setItem('ffp:pirate', 'on'); } catch {}
    close();
    renderServices();
    if (norm(qEl.value).length >= 4) runSearch(qEl.value);
  });
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.x')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.hidden) close(); });
  return ov;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#pirate-toggle');
  if (!btn) return;
  if (pirateMode) {
    // Toggle OFF — instant, no disclaimer needed
    pirateMode = false;
    try { localStorage.removeItem('ffp:pirate'); } catch {}
    renderServices();
    if (norm(qEl.value).length >= 4) runSearch(qEl.value);
  } else {
    // Toggle ON — show disclaimer first
    const ov = disclaimerShell();
    ov.hidden = false;
    document.body.style.overflow = 'hidden';
    const cb = ov.querySelector('#pirate-agree');
    const confirm = ov.querySelector('#pirate-confirm');
    cb.checked = false;
    confirm.disabled = true;
  }
});

(function init() {
  const sp = new URLSearchParams(location.search);
  const p = sp.get('q');
  const c = sp.get('cat');
  if (c && CATS[c]) {
    cat = c;
    document.getElementById('cat').value = c;
    qEl.placeholder = CATS[c].ph;
  }
  renderServices();
  if (p && p.trim()) {
    qEl.value = p;
    runSearch(p);
  } else {
    statusEl.textContent = 'Type a title to search free media.';
  }
  const m = (location.hash || '').match(/^#download-(.+)$/);
  if (m) openDownloads(decodeURIComponent(m[1]), decodeURIComponent(m[1]), 'unknown');
})();
