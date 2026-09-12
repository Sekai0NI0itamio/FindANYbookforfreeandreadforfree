const qEl = document.getElementById('q');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const mem = new Map();
let ctl = null;
let debounceT = 0;
let runSeq = 0;
let animT = 0;
let liveCount = 0;

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

function buildQueries(raw) {
  const w = words(raw);
  const quoted = luc(raw).slice(0, 120);
  const qs = [];
  if (w.length >= 2) qs.push('mediatype:texts AND title:("' + quoted + '")');
  if (w.length) {
    const tw = w.slice(0, 6).map(x => x).join(' AND ');
    qs.push('mediatype:texts AND title:(' + tw + ')');
  }
  qs.push('mediatype:texts AND (' + w.slice(0, 8).join(' AND ') + ')');
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
  params.append('fl[]', 'access-restricted-item');
  params.append('fl[]', 'collection');
  params.append('fl[]', 'language');
  params.set('rows', '20');
  params.set('page', '1');
  params.set('output', 'json');
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
  if (/[_]{2,}|[a-z]+\d{4,}/.test(t) && t.split(' ').length < 3) return 70;
  return 0;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'by', 'with', 'for', 'on', 'to', 'in', 'at', 'as', 'is', 'it', 'ed']);
function sig(ws) { return ws.filter(w => w.length > 2 && !STOP.has(w)); }
function baseOf(t) {
  return norm(t).split(' - ')[0].split(' : ')[0].split(' (')[0].split(' / ')[0].trim();
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
    out.push({ doc: d, title, coverage, exact, mismatch, pages, print, access, score });
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
  return { kind: 'free', label: 'Free to read', cls: 'ok' };
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stars(avg) {
  const f = Math.max(0, Math.min(5, Math.round(Number(avg) || 0)));
  return '★'.repeat(f) + '☆'.repeat(5 - f);
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
    }
    for (const d of docs) {
      const o = byTitle.get(norm(d.title || '')) || byTitle.get(baseOf(d.title || ''));
      if (!o) continue;
      if (o.number_of_pages_median) d._med = Number(o.number_of_pages_median);
      if (o.ratings_average) { d._avg = Number(o.ratings_average); d._cnt = Number(o.ratings_count || 0); }
      if (o.want_to_read_count) d._want = Number(o.want_to_read_count);
      if (o.author_name) d._by = o.author_name.slice(0, 3).join(', ');
      if (o.already_read_count) d._read = Number(o.already_read_count);
    }
  } catch {}
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
  const ext = { '.pdf': 'PDF', '.epub': 'EPUB', '.mobi': 'Kindle', '.azw': 'Kindle', '.djvu': 'DjVu', '.txt': 'Plain text', '.torrent': 'Torrent' };
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

function render(list) {
  resultsEl.innerHTML = '';
  if (!list.length) {
    resultsEl.innerHTML = '<div class="empty">No matches on Internet Archive for that query.<br><span class="etips">Try fewer words, check spelling, or try one of these:</span></div><div id="tryempty">Try: <button data-try="High Output Management">High Output Management</button><button data-try="Lord of the Flies">Lord of the Flies</button><button data-try="Pride and Prejudice">Pride and Prejudice</button></div>';
    return;
  }
  list.forEach((r, i) => {
    const d = r.doc;
    const id = d.identifier;
    const url = 'https://archive.org/details/' + id;
    const by = creatorText(d);
    const yr = yearText(d);
    const desc = String(d.description || '').slice(0, 280);
    const row = document.createElement('article');
    row.className = 'row';
    row.innerHTML =
      '<span class="idx">' + (i + 1) + '</span>' +
      '<img class="cover" loading="lazy" alt="" src="https://archive.org/services/img/' + encodeURIComponent(id) + '">' +
      '<div class="main">' +
      '<h2>' + hi(r.title) + '</h2>' +
      '<p class="byline">' + esc([by, yr].filter(Boolean).join(' · ')) + '</p>' +
      '<div class="badges">' +
      (r.pages != null ? '<span class="stamp pages">' + (r.print ? '≈' + r.pages + ' print ed.' : r.pages + ' scans') + '</span>' : '<span class="stamp pages">pages n/a</span>') +
      '<span class="stamp ' + r.access.cls + '">' + esc(r.access.label) + '</span>' +
      (r.mismatch ? '<span class="stamp mismatch">possible mismatch</span>' : '') +
      '</div>' +
      (desc ? '<p class="desc">' + hi(desc) + '</p>' : '') +
      (d._avg ? '<p class="meta"><span class="stars">' + stars(d._avg) + '</span> ' + Number(d._avg).toFixed(1) + ' · ' + (d._cnt || 0) + ' ratings' + (d._want ? ' · want ' + d._want : '') + (d._read ? ' · read ' + d._read : '') + '</p>' : '') +
      '<p class="url"><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a></p>' +
      '<p class="dl"><button data-dl="' + esc(id) + '" data-kind="' + esc(r.access.kind) + '" data-title="' + esc(r.title) + '">Download options</button></p>' +
      '</div>';
    const img = row.querySelector('img');
    img.onerror = () => { img.style.visibility = 'hidden'; };
    resultsEl.appendChild(row);
  });
}

async function runSearch(raw, opts) {
  const query = raw.trim();
  if (query.length < 4) {
    statusEl.textContent = query.length < 2 ? 'Type a book title to search Internet Archive.' : 'Keep typing…';
    if (!query) resultsEl.innerHTML = '';
    stopAnimate();
    document.body.classList.remove('searched');
    return;
  }
  const key = norm(query);
  const hit = cacheGet(key);
  document.body.classList.toggle('searched', query.length >= 4);
  lastWords = sig(words(query));
  stopAnimate();
  if (hit) {
    statusEl.textContent = hit.length + (hit.length === 1 ? ' book' : ' books') + ' (cached)';
    render(sortDocs(hit));
    if (opts && opts.fromCache) return;
  } else {
    resultsEl.innerHTML = '';
  }
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const my = ++runSeq;
  liveCount = 0;
  animateStatus('Searching Internet Archive');
  try {
    const queries = buildQueries(query);
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
    await olEnrich(docs, query, ctl.signal);
    if (my !== runSeq) return;
    const ranked = rankResults(docs, query).slice(0, 20);
    cacheSet(key, ranked);
    if (norm(qEl.value) !== key) return;
    stopAnimate();
    statusEl.textContent = ranked.length + (ranked.length === 1 ? ' book' : ' books') + ' found';
    render(sortDocs(ranked));
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    stopAnimate();
    const stale = cacheGet(key);
    if (stale) {
      statusEl.textContent = stale.length + ' books found (cached)';
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
  if (b) openDownloads(b.getAttribute('data-dl'), b.getAttribute('data-title') || '', b.getAttribute('data-kind') || 'unknown');
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
  const p = new URLSearchParams(location.search).get('q');
  if (p && p.trim()) {
    qEl.value = p;
    runSearch(p);
  } else {
    statusEl.textContent = 'Type a book title to search Internet Archive.';
  }
  const m = (location.hash || '').match(/^#download-(.+)$/);
  if (m) openDownloads(decodeURIComponent(m[1]), decodeURIComponent(m[1]), 'unknown');
})();
