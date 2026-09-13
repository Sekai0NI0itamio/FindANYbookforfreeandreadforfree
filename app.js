const qEl = document.getElementById('q');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const mem = new Map();
let ctl = null;
let debounceT = 0;
let runSeq = 0;
let animT = 0;
let liveCount = 0;

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

// Curated directory of genuinely FREE services. Two groups:
//   open — no account, no subscription, ad-funded (all real, licensed companies)
//   card — free with a public library card (funded by your library, not a subscription)
// No unlicensed/piracy sources. Links go to the official sites.
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
  row.innerHTML = line('Free, no account:', s.open) + line('Free with a library card:', s.card);
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
  const r = await fetch('https://api.audius.co/v1/tracks/search?query=' + encodeURIComponent(q) + '&limit=20&app_name=findforfree', { signal });
  if (!r.ok) throw new Error('audius ' + r.status);
  const j = await r.json();
  return (j.data || []).map(t => ({
    identifier: 'au-' + String(t.id || '').slice(0, 10),
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
function otherSources(c, q, signal) {
  if (c !== 'music') return Promise.resolve([]);
  return Promise.allSettled([openverseAudio(q, signal), audiusTracks(q, signal), liveMusic(q, signal)])
    .then(rs => rs.flatMap(r => (r.status === 'fulfilled' ? r.value : [])));
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

function extrasToRanked(items, query) {
  const sq = new Set(sig(words(query)));
  return items.map(d => {
    const tw = new Set(sig(words(d.title)));
    let hits = 0;
    for (const w of sq) if (tw.has(w)) hits++;
    const cov = sq.size ? hits / sq.size : 0;
    return {
      doc: d,
      title: d.title,
      score: cov * 400,
      mismatch: false,
      pages: null,
      print: false,
      access: { kind: 'free', label: freeLabel(), cls: 'ok' },
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
  ['Tubi', 'https://tubitv.com/search/'],
  ['Pluto TV', 'https://pluto.tv/en/search?q='],
  ['Roku', 'https://therokuchannel.roku.com/search/'],
  ['iQIYI', 'https://www.iq.com/search?query='],
  ['Bilibili', 'https://www.bilibili.tv/en/search?keyword='],
  ['JustWatch', 'https://www.justwatch.com/us/search?q='],
];

function provLinks(title) {
  const q = encodeURIComponent(String(title || '').slice(0, 70));
  return '<p class="dnote">Find it free on: ' + FREE_SEARCH.map(([n, b]) =>
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
  const [kind, val] = String(ref).split(':');
  const el = audio();
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

function playBtn(r) {
  if (cat !== 'music') return '';
  const t = esc(String(r.title || '').slice(0, 80));
  if (r.au) return '<p class="dl"><button data-play="au:' + esc(String(r.au)) + '" data-title="' + t + '">▶ Play</button></p>';
  if (r.ia) return '<p class="dl"><button data-play="ia:' + esc(r.doc.identifier) + '" data-title="' + t + '">▶ Play</button></p>';
  return '';
}

function render(list) {
  resultsEl.innerHTML = '';
  if (!list.length) {
    resultsEl.innerHTML = '<div class="empty">No matches for that query.<br><span class="etips">Try fewer words, check spelling, or try one of these:</span></div><div id="tryempty">Try: <button data-try="High Output Management">High Output Management</button><button data-try="Lord of the Flies">Lord of the Flies</button><button data-try="Pride and Prejudice">Pride and Prejudice</button></div>'
      + ((cat === 'video' || cat === 'anime') ? '<div class="provpanel">' + provLinks(lastQuery) + '</div>' : '');
    return;
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
      ((cat === 'video' || cat === 'anime') ? provLinks(r.title) : '') +
      (r.ia
        ? '<p class="dl"><button data-dl="' + esc(id) + '" data-kind="' + esc(r.access.kind) + '" data-title="' + esc(fixMojibake(r.title)) + '">Download options</button></p>'
        : '') +
      playBtn(r) +
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
    if (cat === 'music') {
      try {
        const ex = await otherSources('music', query, ctl.signal);
        if (my !== runSeq) return;
        const top = (src, n) => extrasToRanked(ex.filter(x => x._src === src), query)
          .sort((a, b) => b.score - a.score).slice(0, n);
        const mixed = interleaveBy([
          top('Audius', 8),
          top('Openverse', 6),
          top('Live Music Archive', 6),
          sortDocs(combined).slice(0, 8),
        ]);
        mixed.sort((a, b) => (a.mismatch ? 1 : 0) - (b.mismatch ? 1 : 0));
        combined = mixed;
      } catch {}
    }
    const ranked = (cat === 'music' ? combined : sortDocs(combined)).slice(0, 20);
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
