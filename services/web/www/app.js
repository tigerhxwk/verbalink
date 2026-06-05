'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  page: 'dashboard',
  books: [],
  collections: [],
  openCollId: null,      // collection detail currently shown
  book: null,
  transcript: [],
  activeIdx: -1,
  maxReadSec: 0,         // furthest point actually listened to — anchors the spoiler blur
  listenedTotal: 0,      // cumulative seconds actually heard (scrubbing doesn't count)
  essayRanges: [],       // [{start,end}] actually-heard intervals since the last essay
  seeking: false,
  playerOpen: false,
  clarifying: false,
  pollTimer: null,
  pendingFile: null,     // waiting for lang modal
  pendingCollId: null,   // collection context for the pending upload
  searchQuery: '',
  libFilter: 'all',
  currentUser: null,
  playlistCollId: null,
  playlistBooks: [],
  shuffle: false,
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const audioEl     = $('audio-el');
const miniPlayer  = $('mini-player');
const playerFull  = $('player-full');
const pfFull = $('player-full');

// ── Constants ─────────────────────────────────────────────────────────────────
const LANG = {
  en: 'English', ru: 'Russian', de: 'German',   fr: 'French',
  es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  pl: 'Polish',  uk: 'Ukrainian', sv: 'Swedish', tr: 'Turkish',
  ar: 'Arabic',  zh: 'Chinese',  ja: 'Japanese', ko: 'Korean',
};
const LANG_ALL = Object.entries(LANG);

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function bookGradient(title) {
  let h = 5381;
  for (let i = 0; i < title.length; i++) h = ((h << 5) + h) ^ title.charCodeAt(i);
  const hue = Math.abs(h) % 360;
  return `linear-gradient(145deg,hsl(${hue},50%,22%) 0%,hsl(${(hue+38)%360},40%,13%) 55%,hsl(${(hue+190)%360},28%,8%) 100%)`;
}

function parseBookMeta(title) {
  const m = (title || '').match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { author: m[1].trim(), name: m[2].trim() } : { author: '', name: title || '' };
}

function bookCoverInner(title) {
  const { author, name } = parseBookMeta(title);
  const initial = ((name || title || '?')[0] || '?').toUpperCase();
  return `<span class="book-initial">${initial}</span>` +
    `<div class="book-cover-meta">` +
    `<span class="book-cover-title">${esc(name || title)}</span>` +
    (author ? `<span class="book-cover-author">${esc(author)}</span>` : '') +
    `</div>`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Minimal, XSS-safe Markdown → HTML (escape first, then apply inline + block rules).
// Supports: **bold**, *italic*/_italic_, `code`, bullet lists (- / *), numbered lists, paragraphs.
function renderMarkdown(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  const isTableSep = (line) => line.includes('|') && /^[\s:|-]+$/.test(line) && line.includes('-');

  const lines = String(src).split('\n');
  let html = '', list = null;  // list = 'ul' | 'ol' | null
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m;
    // GFM table: a "| … |" header row immediately followed by a "| --- | --- |" separator
    if (line.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
      closeList();
      const header = splitRow(line);
      let body = '';
      i += 2;  // consume header + separator
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitRow(lines[i].trim());
        body += '<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      i--;  // the for-loop will advance past the last consumed row
      html += '<table class="md-table"><thead><tr>'
            + header.map(h => `<th>${inline(h)}</th>`).join('')
            + '</tr></thead><tbody>' + body + '</tbody></table>';
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      html += `<div class="md-h md-h${m[1].length}">${inline(m[2])}</div>`;
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (line === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function b64Blob(b64, mime) {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}


function waitUntil(pred) {
  return new Promise(res => { const t = () => pred() ? res() : requestAnimationFrame(t); t(); });
}

function savedPos(id)   { return parseFloat(localStorage.getItem('pos:' + id) || '0') || 0; }
function savePos(id, t) { localStorage.setItem('pos:' + id, t); }

function recentIds() { return JSON.parse(localStorage.getItem('recent') || '[]'); }
function pushRecent(id) {
  localStorage.setItem('recent', JSON.stringify([id, ...recentIds().filter(x => x !== id)].slice(0, 12)));
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, path, body, onProgress) {
  if (body instanceof FormData) {
    return new Promise((res, rej) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      if (onProgress) xhr.upload.onprogress = onProgress;
      xhr.onload = () => {
        if (xhr.status === 401) { onUnauthorized(); rej(new Error('Unauthorized')); return; }
        try { res(JSON.parse(xhr.responseText)); } catch { rej(new Error(xhr.responseText)); }
      };
      xhr.onerror = () => rej(new Error('Upload failed'));
      xhr.send(body);
    });
  }
  const opts = { method };
  if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (r.status === 401) { onUnauthorized(); throw new Error('Unauthorized'); }
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return null;
  return r.json();
}

// ── Navigation ────────────────────────────────────────────────────────────────
function setPage(page, extra) {
  S.page = page;
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.page === page || (page === 'collection' && n.dataset.page === 'collections'))
  );
  const el = $('page-' + page);
  if (!el) return;
  el.classList.remove('hidden');
  if (page === 'dashboard')   renderDashboard();
  if (page === 'library')     renderLibrary();
  if (page === 'collections') renderCollectionsList();
  if (page === 'collection')  renderCollectionDetail(extra);
}

document.querySelectorAll('.nav-item').forEach(btn =>
  btn.addEventListener('click', () => setPage(btn.dataset.page))
);

// ── Greeting ──────────────────────────────────────────────────────────────────
function setGreeting() {
  const h = new Date().getHours();
  $('greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ── Load everything ───────────────────────────────────────────────────────────
async function loadAll() {
  [S.books, S.collections] = await Promise.all([
    api('GET', '/api/books'),
    api('GET', '/api/collections'),
  ]);
  render();
  schedulePoll();
  pollTranscriptionProgress();
}

function render() {
  if (S.page === 'dashboard')        renderDashboard();
  else if (S.page === 'library')     renderLibrary();
  else if (S.page === 'collections') renderCollectionsList();
  else if (S.page === 'collection')  renderCollectionDetail(S.openCollId);
}

function schedulePoll() {
  clearTimeout(S.pollTimer);
  const needsPoll = S.books.some(b =>
    b.transcription_status === 'pending' || b.transcription_status === 'processing' ||
    b.translation_status === 'processing'
  );
  if (needsPoll) S.pollTimer = setTimeout(loadAll, 4000);
}

function fmtEta(sec) {
  if (!sec || sec < 5) return 'almost done';
  if (sec < 60) return `~${sec}s left`;
  const m = Math.round(sec / 60);
  return `~${m} min left`;
}

async function pollTranscriptionProgress() {
  const processing = S.books.filter(b => b.transcription_status === 'processing');
  for (const book of processing) {
    try {
      const p = await api('GET', `/api/books/${book.id}/transcription-progress`);
      const bar = $(`tpbar-${book.id}`);
      const eta = $(`tpeta-${book.id}`);
      if (bar && p.active) {
        bar.style.width = (p.pct || 0) + '%';
        if (eta) eta.textContent = p.eta_sec != null ? fmtEta(p.eta_sec) : '';
      }
    } catch {}
  }
  if (processing.length) setTimeout(pollTranscriptionProgress, 2000);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const recent  = recentIds();
  const heroBook = recent.map(id => S.books.find(b => b.id === id)).find(b => b && savedPos(b.id) > 30);

  // Hero
  const heroSec = $('hero-section');
  if (heroBook) {
    heroSec.classList.remove('hidden');
    const pos = savedPos(heroBook.id);
    const pct = heroBook.duration_sec ? Math.round(pos / heroBook.duration_sec * 100) : 0;
    $('continue-hero').innerHTML = `
      <div class="continue-hero-bg" style="background:${bookGradient(heroBook.title)}"></div>
      <div class="continue-hero-scrim"></div>
      <div class="continue-hero-content">
        <div class="continue-hero-eyebrow">Continue Reading</div>
        <div class="continue-hero-title">${esc(heroBook.title)}</div>
        <div class="continue-hero-bar">
          <div class="continue-hero-progress"><div style="width:${pct}%"></div></div>
          <span class="continue-hero-pct">${pct}%</span>
          <div class="continue-hero-play" id="continue-hero-play">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          </div>
        </div>
      </div>`;
    $('continue-hero').onclick = () => openBook(heroBook, null, true);  // hero click → open + autoplay
  } else {
    heroSec.classList.add('hidden');
  }

  // Recently played row
  const recentSec = $('recent-section');
  const recentBooks = recent.map(id => S.books.find(b => b.id === id)).filter(Boolean);
  if (recentBooks.length > 1) {
    recentSec.classList.remove('hidden');
    const row = $('recent-row');
    row.innerHTML = '';
    recentBooks.slice(0, 10).forEach(b => row.appendChild(makeBookMini(b)));
  } else {
    recentSec.classList.add('hidden');
  }

  // Collections (compact)
  renderCollectionsDash();

  // All books
  const grid  = $('dash-books');
  const empty = $('dash-empty');
  grid.innerHTML = '';
  if (!S.books.length) {
    grid.classList.add('hidden'); empty.classList.remove('hidden');
  } else {
    grid.classList.remove('hidden'); empty.classList.add('hidden');
    S.books.forEach(b => grid.appendChild(makeBookCard(b)));
  }
}

function renderCollectionsDash() {
  const grid  = $('collections-grid');
  const empty = $('coll-empty');
  grid.innerHTML = '';
  if (!S.collections.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  S.collections.forEach(c => grid.appendChild(makeCollCard(c)));
}

// ── Library ───────────────────────────────────────────────────────────────────
function renderLibrary() {
  let books = S.books;
  if (S.libFilter !== 'all') books = books.filter(b => b.transcription_status === S.libFilter);
  if (S.searchQuery) {
    const q = S.searchQuery.toLowerCase();
    books = books.filter(b => b.title.toLowerCase().includes(q));
  }
  const grid  = $('lib-books');
  const empty = $('lib-empty');
  grid.innerHTML = '';
  if (!books.length) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    books.forEach(b => grid.appendChild(makeBookCard(b)));
  }
}

$('search-input').addEventListener('input', e => { S.searchQuery = e.target.value.trim(); renderLibrary(); });
$('filter-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  S.libFilter = chip.dataset.filter;
  renderLibrary();
});

// ── Collections ───────────────────────────────────────────────────────────────
function renderCollectionsList() {
  const grid  = $('coll-full-grid');
  const empty = $('coll-full-empty');
  grid.innerHTML = '';
  if (!S.collections.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  S.collections.forEach(c => grid.appendChild(makeCollCard(c, true)));
}

function makeCollCard(coll, large = false) {
  const card = document.createElement('div');
  card.className = 'coll-card';
  if (large) card.style.minHeight = '80px';
  card.innerHTML = `
    <div class="coll-card-name">${esc(coll.name)}</div>
    <div class="coll-card-count">${coll.book_count} book${coll.book_count !== 1 ? 's' : ''}</div>
    <button class="coll-delete" data-id="${coll.id}" title="Delete">✕</button>`;
  card.addEventListener('click', e => {
    if (e.target.closest('.coll-delete')) return;
    openCollection(coll.id);
  });
  card.querySelector('.coll-delete').addEventListener('click', e => {
    e.stopPropagation();
    deleteCollection(coll.id);
  });
  return card;
}

function openCollection(collId) {
  S.openCollId = collId;
  setPage('collection', collId);
}

async function renderCollectionDetail(collId) {
  if (!collId) return;
  const coll = S.collections.find(c => c.id === collId);
  if (!coll) { setPage('collections'); return; }

  $('coll-detail-title').textContent = coll.name;

  const list  = $('coll-detail-list');
  const empty = $('coll-detail-empty');
  list.innerHTML = '<div class="t-loading">Loading…</div>';
  empty.classList.add('hidden');

  const books = await api('GET', `/api/collections/${collId}/books`);
  list.innerHTML = '';

  if (!books.length) {
    empty.classList.remove('hidden');
    return;
  }

  books.forEach(b => {
    const row = document.createElement('div');
    row.className = 'coll-book-row ready';

    const dotCls = { done:'dot-done', pending:'dot-pending', processing:'dot-processing', error:'dot-error' }[b.transcription_status] || 'dot-pending';
    const statusTxt = b.transcription_status === 'processing' ? 'transcribing…' : b.transcription_status;

    row.innerHTML = `
      <div class="coll-book-cover" style="background:${bookGradient(b.title)}">${bookCoverInner(b.title)}</div>
      <div class="coll-book-info">
        <div class="coll-book-title">${esc(b.title)}</div>
        <div class="coll-book-meta">
          <span class="status-dot ${dotCls}"></span>${statusTxt}
          &nbsp;·&nbsp;${LANG[b.source_lang] || b.source_lang}
          → ${LANG[b.target_lang] || b.target_lang}
          ${b.duration_sec ? `&nbsp;·&nbsp;${fmt(b.duration_sec)}` : ''}
        </div>
        ${b.transcription_status === 'error' && b.error ? `<div style="font-size:10px;color:var(--danger);margin-top:3px">${esc(b.error.slice(0,120))}</div>` : ''}
      </div>
      <div class="coll-book-actions">
        ${b.transcription_status === 'error' ? `<button class="coll-retranscribe" data-id="${b.id}">retry</button>` : ''}
        <button class="coll-remove" data-id="${b.id}" title="Remove from collection">✕</button>
      </div>`;

    row.addEventListener('click', e => {
      if (e.target.closest('.coll-book-actions')) return;
      const full = S.books.find(bk => bk.id === b.id) || b;
      openBookTap(full, collId);
    });

    row.querySelector('.coll-remove')?.addEventListener('click', async e => {
      e.stopPropagation();
      await api('DELETE', `/api/collections/${collId}/books/${b.id}`);
      renderCollectionDetail(collId);
      await loadAll();
    });

    row.querySelector('.coll-retranscribe')?.addEventListener('click', async e => {
      e.stopPropagation();
      await api('POST', `/api/books/${b.id}/retranscribe`);
      await loadAll();
      renderCollectionDetail(collId);
    });

    list.appendChild(row);
  });
}

$('coll-back-btn').addEventListener('click', () => setPage('collections'));

async function deleteCollection(id) {
  if (!confirm('Delete this collection? Books will not be deleted.')) return;
  await api('DELETE', `/api/collections/${id}`);
  await loadAll();
  if (S.page === 'collection' && S.openCollId === id) setPage('collections');
}

// Collection create modal
function openCollModal() {
  $('coll-name-input').value = '';
  $('coll-modal').classList.remove('hidden');
  setTimeout(() => $('coll-name-input').focus(), 50);
}
$('new-coll-btn').addEventListener('click', openCollModal);
$('new-coll-btn-2').addEventListener('click', openCollModal);
$('coll-cancel-btn').addEventListener('click', () => $('coll-modal').classList.add('hidden'));
$('coll-create-btn').addEventListener('click', async () => {
  const name = $('coll-name-input').value.trim();
  if (!name) return;
  await api('POST', '/api/collections', { name });
  $('coll-modal').classList.add('hidden');
  await loadAll();
});
$('coll-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('coll-create-btn').click(); });

// ── Upload ────────────────────────────────────────────────────────────────────
function triggerUpload(file, collId = null) {
  if (!file) return;
  S.pendingFile = file;
  S.pendingCollId = collId;
  $('modal-filename').textContent = file.name;
  $('upload-share').checked = false;   // sharing is opt-in, default off, every upload

  // Populate collection dropdown
  const collSel = $('upload-coll-sel');
  collSel.innerHTML = '<option value="">— none —</option>';
  S.collections.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.id === collId) opt.selected = true;
    collSel.appendChild(opt);
  });

  $('lang-modal').classList.remove('hidden');

  // Detect source language from filename in the background
  const srcSel = $('src-lang-sel');
  srcSel.disabled = true;
  api('POST', '/api/detect_language', { filename: file.name })
    .then(d => { if (d.lang) srcSel.value = d.lang; })
    .catch(() => {})
    .finally(() => { srcSel.disabled = false; });
}

['file-input-main', 'file-input-lib', 'file-input-empty'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', () => { triggerUpload(el.files[0]); el.value = ''; });
});

// Collection-context upload inputs
document.addEventListener('change', e => {
  if (e.target.id === 'file-input-coll' || e.target.id === 'file-input-coll2') {
    triggerUpload(e.target.files[0], S.openCollId);
    e.target.value = '';
  }
});

$('lang-cancel-btn').addEventListener('click', () => {
  $('lang-modal').classList.add('hidden');
  S.pendingFile = null;
  S.pendingCollId = null;
});

$('lang-confirm-btn').addEventListener('click', async () => {
  $('lang-modal').classList.add('hidden');
  const file    = S.pendingFile;
  const collId  = $('upload-coll-sel').value || S.pendingCollId || null;
  S.pendingFile = null;
  S.pendingCollId = null;
  if (!file) return;

  const src = $('src-lang-sel').value;
  const share = $('upload-share').checked;
  // Target language is chosen per-book in the player; default to last-used (or 'en').
  const tgt = localStorage.getItem('default_target_lang') || 'en';
  const fd  = new FormData();
  fd.append('file', file);

  let url = `/api/books?source_lang=${src}&target_lang=${tgt}&share=${share}`;
  if (collId) url += `&collection_id=${collId}`;

  const toast = $('upload-toast'), fill = $('toast-fill'), label = $('toast-label');
  toast.classList.remove('hidden');
  fill.style.width = '0%';
  label.textContent = `Uploading ${file.name}…`;

  try {
    await api('POST', url, fd, e => {
      if (e.lengthComputable) fill.style.width = (e.loaded / e.total * 100).toFixed(0) + '%';
    });
    fill.style.width = '100%';
    label.textContent = collId ? 'Added to collection, transcribing…' : 'Queued for transcription';
    await loadAll();
    if (S.page === 'collection') renderCollectionDetail(S.openCollId);
  } catch (err) {
    label.textContent = 'Upload failed: ' + err.message;
  } finally {
    setTimeout(() => toast.classList.add('hidden'), 3500);
  }
});

// ── Book card builders ────────────────────────────────────────────────────────
function makeBookCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';
  const pos = savedPos(book.id);
  const pct = book.duration_sec && pos ? Math.round(pos / book.duration_sec * 100) : 0;
  const dotCls = { done:'dot-done', pending:'dot-pending', processing:'dot-processing', error:'dot-error' }[book.transcription_status] || 'dot-pending';
  const isProcessing = book.transcription_status === 'processing';
  const statusTxt = isProcessing ? 'transcribing…' : book.transcription_status;
  card.innerHTML = `
    <button class="book-delete" data-id="${book.id}" title="Delete book" aria-label="Delete book">✕</button>
    <div class="book-card-cover"><div class="book-card-cover-inner" style="background:${bookGradient(book.title)}">${bookCoverInner(book.title)}</div></div>
    <div class="book-card-body">
      <div class="book-card-title">${esc(book.title)}</div>
      <div class="book-card-meta">
        <span class="book-card-lang">${LANG[book.source_lang] || book.source_lang}</span>
        <span class="book-card-status"><span class="status-dot ${dotCls}"></span>${statusTxt}</span>
      </div>
      ${isProcessing ? `<div class="book-card-transcribe-progress"><div class="book-card-transcribe-bar" id="tpbar-${book.id}" style="width:0%"></div></div><div class="book-card-eta" id="tpeta-${book.id}"></div>` : ''}
      ${pct > 0 ? `<div class="book-card-progress"><div style="width:${pct}%"></div></div>` : ''}
    </div>`;
  card.querySelector('.book-delete').addEventListener('click', e => { e.stopPropagation(); deleteBook(book.id); });
  card.addEventListener('click', e => { if (!e.target.closest('.book-delete')) openBookTap(book); });
  return card;
}

// Tapping a book opens it. On mobile, jump straight into the reader (reading-first); the
// player still loads underneath (paused) and is reachable via the reader's Back button.
async function openBookTap(book, collId = null) {
  await openBook(book, collId);
  if (window.matchMedia('(max-width: 760px)').matches) openReader();
}

function makeBookMini(book) {
  const wrap = document.createElement('div');
  wrap.className = 'book-mini';
  wrap.innerHTML = `
    <div class="book-mini-cover" style="background:${bookGradient(book.title)}">${bookCoverInner(book.title)}</div>
    <div class="book-mini-title">${esc(book.title)}</div>
    <div class="book-mini-lang">${LANG[book.source_lang] || book.source_lang}</div>`;
  wrap.addEventListener('click', () => openBookTap(book));
  return wrap;
}

async function deleteBook(id) {
  if (!confirm('Delete this book and its transcript?')) return;
  await api('DELETE', `/api/books/${id}`);
  await loadAll();
}


// ── Book settings persistence ─────────────────────────────────────────────────
let _settingsSaveTimer = null;

function saveBookSettings(patch) {
  if (!S.book) return;
  clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(async () => {
    try { await api('PUT', `/api/books/${S.book.id}/settings`, patch); } catch {}
  }, 800);
}

// ── Open book / player ────────────────────────────────────────────────────────
// Sliding transcript window — the browser only holds ~120 sentences around the
// current position, refetched as you play or seek (keeps memory tiny on long books).
let _winFetching = false;
const WIN = { lo: Infinity, hi: -Infinity, hasPrev: false, hasNext: false, bookId: null };

function _resetWindow() {
  S.transcript = [];
  S.activeIdx = -1;
  WIN.lo = Infinity; WIN.hi = -Infinity; WIN.hasPrev = false; WIN.hasNext = false; WIN.bookId = null;
}

async function ensureWindow(t, force = false) {
  if (!S.book || _winFetching) return;
  const haveWindow = S.transcript.length > 0 && WIN.bookId === S.book.id;
  // Refetch when we have nothing, jumped before the window, or are nearing its
  // forward edge with more sentences available (also keeps up with live transcription).
  const need = force || !haveWindow
    || (t < WIN.lo + 5 && WIN.hasPrev)
    || (t > WIN.hi - 15 && WIN.hasNext);
  if (!need) return;
  _winFetching = true;
  try {
    const data = await api('GET', `/api/books/${S.book.id}/sentences?around=${Math.max(0, t)}`);
    S.transcript = data.segments || [];
    WIN.lo = data.window_start_sec; WIN.hi = data.window_end_sec;
    WIN.hasPrev = data.has_prev; WIN.hasNext = data.has_next; WIN.bookId = S.book.id;
    S.activeIdx = -1;
    renderTranscriptScroller();
    updateActive(t);   // highlight the position we centred on (playback OR scrub target)
  } catch {
    // transcript not ready yet — leave window empty, will retry on next tick
  } finally {
    _winFetching = false;
  }
}

function _startAudio(bookId, prog, autoplay) {
  audioEl.src = `/api/books/${bookId}/audio`;
  audioEl.load();
  audioEl.addEventListener('loadedmetadata', () => {
    if (prog > 0) audioEl.currentTime = prog;
    if (autoplay) audioEl.play().catch(() => {});
  }, { once: true });
}

// ── Chapter markers on the seek bar ───────────────────────────────────────────
async function loadChapters(bookId) {
  S.chapters = [];
  $('seek-markers').innerHTML = '';
  try {
    const data = await api('GET', `/api/books/${bookId}/chapters`);
    S.chapters = data.chapters || [];
    renderChapterMarkers();
  } catch {}
}

function renderChapterMarkers() {
  const cont = $('seek-markers');
  const dur = audioEl.duration;
  cont.innerHTML = '';
  if (!dur || !isFinite(dur) || !(S.chapters || []).length) return;
  S.chapters.forEach(ch => {
    if (ch.time > dur) return;
    const m = document.createElement('div');
    m.className = 'pf-seek-marker';
    m.style.left = (ch.time / dur * 100) + '%';
    m.title = ch.label;
    m.addEventListener('click', () => { clearAutoResume(); audioEl.currentTime = ch.time; });
    cont.appendChild(m);
  });
}

audioEl.addEventListener('loadedmetadata', renderChapterMarkers);
audioEl.addEventListener('durationchange', renderChapterMarkers);

async function openBook(book, collId = null, autoplay = false) {
  S.book = book;
  _resetWindow();
  S.playlistCollId = collId;

  // Close clarify, reset panel state
  clearAutoResume();
  $('pf-clarify-panel').classList.add('hidden');
  pfFull.classList.remove('pf-panel-open');
  $('pf-right-panel').classList.add('hidden');

  pushRecent(book.id);

  const bg = bookGradient(book.title);
  [$('pf-cover'), $('mini-cover')].forEach(d => {
    if (d) { d.style.background = bg; d.innerHTML = bookCoverInner(book.title); }
  });
  $('pf-title').textContent      = book.title;
  $('pf-src-lang').textContent   = LANG[book.source_lang] || book.source_lang;
  $('pf-book-label').textContent = book.title;
  $('mini-title').textContent    = book.title;
  $('mini-sub').textContent      = LANG[book.source_lang] || book.source_lang;

  // Load per-book settings from DB
  try {
    const s = await api('GET', `/api/books/${book.id}/settings`);
    // Playback speed
    const speed = s.playback_speed || 1.0;
    audioEl.playbackRate = speed;
    $('speed-bar').value = speed;
    $('speed-val').textContent = speed.toFixed(2).replace(/\.?0+$/, '') + '×';
    // Volume
    const vol = s.volume ?? 1.0;
    audioEl.volume = vol;
    $('volume-bar').value = vol;
    updateVolUI(vol);
    // Clarify mode
    if (s.clarify_mode) setClarifyMode(s.clarify_mode);
    // Target lang
    $('pf-tgt-sel').value = s.target_lang || book.target_lang || 'en';
    // Progress
    const prog = s.progress_sec || savedPos(book.id) || 0;
    S.maxReadSec = prog;          // everything up to the resume point is already "read"
    _startAudio(book.id, prog, autoplay);
  } catch {
    // Fallback to localStorage
    $('pf-tgt-sel').value = book.target_lang || 'en';
    const prog = savedPos(book.id) || 0;
    S.maxReadSec = prog;
    _startAudio(book.id, prog, autoplay);
  }

  miniPlayer.classList.remove('hidden');
  openFullPlayer();
  _essayNotifShown = false;
  // Reset per-book listening trackers (session-scoped)
  S.listenedTotal = 0; S.essayRanges = []; _lastEssayListened = 0; _lastTickT = null;

  // Load the initial transcript window around the saved position
  ensureWindow(savedPos(book.id) || 0, true);
  loadChapters(book.id);
  loadChatHistory(book.id);
  showChatFab();           // floating chat becomes available for this book (starts collapsed)
  collapseChat();

  // Load playlist when opened from a collection
  if (collId) {
    try {
      const books = await api('GET', `/api/collections/${collId}/books`);
      S.playlistBooks = books;
    } catch {
      S.playlistBooks = [];
    }
    if (S.playlistBooks.length > 1) renderPlaylist();
  } else {
    S.playlistBooks = [];
  }
  // Reading view is the default — but respect the user's collapsed preference
  if (_transcriptCollapsed) { hideRightPanel(); $('pf-transcript-btn').classList.remove('active'); }
  else { showRightPanel('transcript'); $('pf-transcript-btn').classList.add('active'); }
}

// ── Language selector in player ───────────────────────────────────────────────
$('pf-tgt-sel').addEventListener('change', async () => {
  if (!S.book) return;
  const newLang = $('pf-tgt-sel').value;
  try {
    const updated = await api('PATCH', `/api/books/${S.book.id}`, { target_lang: newLang });
    S.book = updated;
    localStorage.setItem('default_target_lang', newLang);  // remember for next upload
    // Sync in books list
    const idx = S.books.findIndex(b => b.id === updated.id);
    if (idx !== -1) S.books[idx] = updated;
  } catch (err) {
    console.error('Failed to update language:', err);
    $('pf-tgt-sel').value = S.book.target_lang; // revert
  }
});

// ── Full player show/hide ─────────────────────────────────────────────────────
function openFullPlayer() {
  playerFull.classList.remove('hidden');
  requestAnimationFrame(() => playerFull.classList.add('visible'));
  S.playerOpen = true;
}

function closeFullPlayer() {
  playerFull.classList.remove('visible');
  S.playerOpen = false;
  playerFull.addEventListener('transitionend', () => {
    if (!S.playerOpen) playerFull.classList.add('hidden');
  }, { once: true });
}

$('pf-collapse-btn').addEventListener('click', closeFullPlayer);
$('mini-expand-btn').addEventListener('click', () => S.playerOpen ? closeFullPlayer() : openFullPlayer());
$('mini-expand').addEventListener('click',     () => { if (!S.playerOpen) openFullPlayer(); });

// ── Audio events ──────────────────────────────────────────────────────────────
audioEl.addEventListener('loadedmetadata', () => {
  $('seek-bar').max = audioEl.duration;
  $('time-total').textContent = fmt(audioEl.duration);
});

audioEl.addEventListener('timeupdate', () => {
  if (S.seeking) return;
  const t   = audioEl.currentTime;
  const dur = audioEl.duration || 1;
  $('seek-bar').value           = t;
  $('time-cur').textContent     = fmt(t);
  $('mini-seek-fill').style.width = (t / dur * 100).toFixed(2) + '%';
  if (!audioEl.paused) { S.maxReadSec = Math.max(S.maxReadSec || 0, t); noteListenTick(t); }  // only while actually playing
  updateActive(t);
  ensureWindow(t);  // slide the transcript window as playback advances
  if (S.book) { savePos(S.book.id, t); saveBookSettings({ progress_sec: t }); }
});

// Refetch the window after a seek (user may have jumped far from the loaded range),
// then resync the karaoke highlight + blur to the new position.
audioEl.addEventListener('seeked', async () => {
  if (!S.book) return;
  _lastTickT = null;          // break listening contiguity — a jump isn't "listened to"
  const t = audioEl.currentTime;
  const outside = !(t >= WIN.lo && t <= WIN.hi);   // force a refetch if we left the window
  await ensureWindow(t, outside);
  updateActive(t);
});

const PLAY_SVG  = `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
const PAUSE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
const MINI_PLAY  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
const MINI_PAUSE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

audioEl.addEventListener('play',  () => { stopTts(); $('play-btn').innerHTML = PAUSE_SVG; $('mini-play-btn').innerHTML = MINI_PAUSE; });
audioEl.addEventListener('pause', () => { $('play-btn').innerHTML = PLAY_SVG;  $('mini-play-btn').innerHTML = MINI_PLAY; _lastTickT = null; });

// ── Playback controls ─────────────────────────────────────────────────────────
$('play-btn').addEventListener('click',    () => { clearAutoResume(); audioEl.paused ? audioEl.play() : audioEl.pause(); });
$('mini-play-btn').addEventListener('click', () => { clearAutoResume(); audioEl.paused ? audioEl.play() : audioEl.pause(); });
$('rewind-btn').addEventListener('click',  () => { audioEl.currentTime = Math.max(0, audioEl.currentTime - 15); });
$('forward-btn').addEventListener('click', () => { audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 15); });

$('pf-reset-btn').addEventListener('click', async () => {
  if (!S.book) return;
  if (!confirm('Reset listening progress for this book? Playback returns to the start and the spoiler blur covers everything again.')) return;
  try { await api('POST', `/api/books/${S.book.id}/reset-progress`); } catch {}
  localStorage.removeItem('pos:' + S.book.id);
  localStorage.removeItem('reader_pos_' + S.book.id);
  // Reset in-session trackers so the blur + essay timing restart from zero
  S.maxReadSec = 0; S.listenedTotal = 0; S.essayRanges = []; _lastEssayListened = 0; _lastTickT = null;
  audioEl.pause();
  audioEl.currentTime = 0;     // fires 'seeked' → window refetch + highlight resync
  updateActive(0);             // immediate blur refresh from the start
});

$('seek-bar').addEventListener('mousedown', () => { S.seeking = true; });
$('seek-bar').addEventListener('touchstart', () => { S.seeking = true; }, { passive: true });
let _seekFetchT = 0;
$('seek-bar').addEventListener('input', () => {
  const v = +$('seek-bar').value;
  $('time-cur').textContent = fmt(v);
  updateActive(v);            // karaoke highlight + blur follow the pin while scrubbing
  // If scrubbing into unloaded territory, fetch that region (throttled) so text follows
  if (!(v >= WIN.lo && v <= WIN.hi) && Date.now() - _seekFetchT > 250) {
    _seekFetchT = Date.now();
    ensureWindow(v, true);
  }
});
$('seek-bar').addEventListener('change', () => {
  const v = +$('seek-bar').value;
  audioEl.currentTime = v;    // fires 'seeked', which refetches + resyncs the highlight
  S.seeking = false;
});

$('speed-bar').addEventListener('input', () => {
  const v = parseFloat($('speed-bar').value);
  audioEl.playbackRate = v;
  $('speed-val').textContent = v.toFixed(2).replace(/\.?0+$/, '') + '×';
  saveBookSettings({ playback_speed: v });
});

const VOL_SVG_ON  = `<svg id="vol-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const VOL_SVG_LOW = `<svg id="vol-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
const VOL_SVG_OFF = `<svg id="vol-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;

function updateVolUI(v) {
  $('volume-val').textContent = Math.round(v * 100) + '%';
  $('vol-mute-btn').innerHTML = v === 0 ? VOL_SVG_OFF : v < 0.4 ? VOL_SVG_LOW : VOL_SVG_ON;
}

$('volume-bar').addEventListener('input', () => {
  const v = parseFloat($('volume-bar').value);
  audioEl.volume = v;
  updateVolUI(v);
  saveBookSettings({ volume: v });
});

let _prevVol = 1;
$('vol-mute-btn').addEventListener('click', () => {
  if (audioEl.volume > 0) {
    _prevVol = audioEl.volume;
    audioEl.volume = 0;
    $('volume-bar').value = 0;
  } else {
    audioEl.volume = _prevVol;
    $('volume-bar').value = _prevVol;
  }
  updateVolUI(audioEl.volume);
});

// ── Transcript / sentence navigation ─────────────────────────────────────────
function jumpSentence(dir) {
  const segs = S.transcript;
  if (!segs.length) return;
  const t = audioEl.currentTime;
  if (dir < 0) {
    const idx = S.activeIdx < 0 ? 0 : S.activeIdx;
    const cur = segs[idx];
    // If we're more than 2s into the current sentence, replay from its start
    if (cur && t - cur.start > 2) {
      audioEl.currentTime = cur.start;
    } else if (idx > 0) {
      audioEl.currentTime = segs[idx - 1].start;
    } else {
      audioEl.currentTime = segs[0].start;
    }
  } else {
    const idx = S.activeIdx;
    if (idx >= 0 && idx < segs.length - 1) {
      audioEl.currentTime = segs[idx + 1].start;
    }
  }
}

$('prev-sent-btn').addEventListener('click', () => jumpSentence(-1));
$('next-sent-btn').addEventListener('click', () => jumpSentence(1));

function updateActive(t) {
  const segs = S.transcript;
  if (!segs.length) return;
  let lo = 0, hi = segs.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx === S.activeIdx) return;
  S.activeIdx = idx;
  // Update mini player subtitle with current segment text
  if (idx >= 0 && segs[idx]) {
    $('mini-sub').textContent = segs[idx].text;
  }
  highlightTranscript(idx);
}

// ── Transcript scroller ─────────────────────────────────────────────────────
let _transcriptCollapsed = localStorage.getItem('transcript_collapsed') === '1';
let _blurUnread = localStorage.getItem('blur_unread') === '1';

function renderTranscriptScroller() {
  const scroll = $('transcript-scroll');
  if (!scroll) return;
  const segs = S.transcript || [];
  scroll.innerHTML = '';
  segs.forEach((seg, i) => {
    const row = document.createElement('div');
    row.className = 'tr-line' + (i === S.activeIdx ? ' active' : '');
    row.dataset.i = i;

    const txt = document.createElement('button');
    txt.className = 'tr-line-text';
    txt.textContent = seg.text.trim();
    txt.title = 'Explain this sentence';
    txt.addEventListener('click', () => { if (!S.clarifying) analyzeSentenceFor(seg); });

    const rew = document.createElement('button');
    rew.className = 'tr-line-rewind';
    rew.title = 'Rewind to the start of this sentence';
    rew.innerHTML = _REWIND_SVG;
    rew.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAutoResume(); stopTts();
      audioEl.currentTime = seg.start;
      audioEl.play().catch(() => {});
    });

    row.appendChild(txt);
    row.appendChild(rew);
    scroll.appendChild(row);
  });
  applyBlurUnread();
  highlightTranscript(S.activeIdx);
}

// Index of the last sentence actually listened to (high-water mark) — anchors the spoiler
// blur so it remembers your furthest-read point instead of following the scrub pin backward.
function _readBoundaryIdx() {
  const segs = S.transcript || [];
  const mr = S.maxReadSec || 0;
  let r = -1;
  for (let i = 0; i < segs.length; i++) { if (segs[i].start <= mr) r = i; else break; }
  return r;
}

function highlightTranscript(idx) {
  const scroll = $('transcript-scroll');
  // Skip when the transcript isn't actually visible (works for both the desktop
  // collapsed state and the mobile sheet, where _transcriptCollapsed doesn't apply).
  if (!scroll
      || $('pf-right-panel').classList.contains('hidden')
      || $('pf-transcript-view').classList.contains('hidden')) return;
  const readIdx = _readBoundaryIdx();
  scroll.querySelectorAll('.tr-line').forEach(el => {
    const i = +el.dataset.i;
    el.classList.toggle('active', i === idx);     // highlight follows playback / scrub pin
    el.classList.toggle('unread', i > readIdx);   // blur everything past furthest-read; -1 ⇒ blur all
  });
  const row = scroll.querySelector(`.tr-line[data-i="${idx}"]`);
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Collapsed = right panel hidden → controls center (grid drops to single column).
// Only governs the transcript view; clarify/playlist open explicitly regardless.
function applyTranscriptCollapsed() {
  if (!S.book) return;
  // On mobile the player opens as controls only; the transcript is a manual overlay
  // (opened from the header button), never auto-shown.
  if (window.matchMedia('(max-width: 760px)').matches) return;
  // Don't disturb an open clarify or playlist panel
  const rightHidden = $('pf-right-panel').classList.contains('hidden');
  const clarifyOpen = !rightHidden && !$('pf-clarify-panel').classList.contains('hidden');
  const playlistOpen = !rightHidden && !$('pf-playlist-view').classList.contains('hidden');
  if (clarifyOpen || playlistOpen) return;
  if (_transcriptCollapsed) hideRightPanel();
  else { showRightPanel('transcript'); highlightTranscript(S.activeIdx); }
  $('pf-transcript-btn').classList.toggle('active', !_transcriptCollapsed);
}

function applyBlurUnread() {
  $('transcript-scroll').classList.toggle('blur-unread', _blurUnread);
  $('transcript-blur-btn').classList.toggle('active', _blurUnread);
}

function setTranscriptCollapsed(collapsed) {
  _transcriptCollapsed = collapsed;
  localStorage.setItem('transcript_collapsed', collapsed ? '1' : '0');
  applyTranscriptCollapsed();
  saveUserSetting({ transcript_collapsed: collapsed });
}

// In-panel chevron hides the panel (centers controls)
$('transcript-toggle-btn').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 760px)').matches) { hideRightPanel(); return; }  // mobile sheet
  setTranscriptCollapsed(true);
});
// Header button toggles the transcript panel on/off
$('pf-transcript-btn').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 760px)').matches) {
    // Mobile: toggle the transcript sheet directly (don't persist a desktop layout pref)
    const open = !$('pf-right-panel').classList.contains('hidden')
              && !$('pf-transcript-view').classList.contains('hidden');
    if (open) hideRightPanel();
    else { showRightPanel('transcript'); renderTranscriptScroller(); highlightTranscript(S.activeIdx); }
    return;
  }
  setTranscriptCollapsed(!_transcriptCollapsed);
});

$('transcript-blur-btn').addEventListener('click', () => {
  _blurUnread = !_blurUnread;
  localStorage.setItem('blur_unread', _blurUnread ? '1' : '0');
  applyBlurUnread();
  saveUserSetting({ blur_unread: _blurUnread });
});

// Debounced PUT of a single user setting to the DB (per-account persistence)
let _settingsPutTimer = null;
let _settingsPutPending = {};
function saveUserSetting(patch) {
  _settingsPutPending = { ..._settingsPutPending, ...patch };
  _userSettings = { ..._userSettings, ...patch };
  clearTimeout(_settingsPutTimer);
  _settingsPutTimer = setTimeout(async () => {
    const body = _settingsPutPending; _settingsPutPending = {};
    try { await api('PUT', '/api/settings', body); } catch {}
  }, 400);
}

// Clarify a specific sentence object (used by the scroller rows)
function analyzeSentenceFor(seg) {
  if (!_clarifyIsOpen()) _resumeAfterClarify = !audioEl.paused;   // only on fresh entry
  audioEl.pause();
  openClPanel();
  $('cl-original').textContent = '';
  $('cl-translated').textContent = '';
  $('cl-explanation').textContent = '';
  $('cl-explanation').classList.add('hidden');
  $('cl-terms').classList.add('hidden');
  buildSentencePicker();
  analyzeSentence((seg.start + seg.end) / 2);
}

// ── Right panel helpers ───────────────────────────────────────────────────────
function showRightPanel(view) {
  $('pf-right-panel').classList.remove('hidden');
  pfFull.classList.add('pf-panel-open');
  $('pf-transcript-view').classList.toggle('hidden', view !== 'transcript');
  $('pf-playlist-view').classList.toggle('hidden', view !== 'playlist');
  $('pf-clarify-panel').classList.toggle('hidden', view !== 'clarify');
}

function hideRightPanel() {
  $('pf-right-panel').classList.add('hidden');
  pfFull.classList.remove('pf-panel-open');
}

// ── Clarify ───────────────────────────────────────────────────────────────────
function openClPanel() { showRightPanel('clarify'); }

function closeClPanel() {
  stopTts();
  // On mobile the panel is a floating sheet — closing just dismisses it.
  if (window.matchMedia('(max-width: 760px)').matches) { clearAutoResume(); hideRightPanel(); return; }
  // Desktop: return to the reading view, respecting the collapsed preference
  if (_transcriptCollapsed) hideRightPanel();
  else { showRightPanel('transcript'); highlightTranscript(S.activeIdx); }
}

// Mobile: tapping the dimmed backdrop (outside the sheet) dismisses the panel.
$('pf-right-panel').addEventListener('click', (e) => {
  if (e.target !== e.currentTarget) return;
  if (!window.matchMedia('(max-width: 760px)').matches) return;
  clearAutoResume(); stopTts(); hideRightPanel();
});

function renderClTerms(terms) {
  const el = $('cl-terms');
  if (!terms || !terms.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = terms.map(t => `
    <div class="cl-term-item">
      <div class="cl-term-name">${esc(t.term)}</div>
      <div class="cl-term-meaning">${esc(t.meaning || '')}</div>
      ${t.urban ? `<div class="cl-term-urban"><span class="cl-urban-label">Urban Dictionary</span>${esc(t.urban)}</div>` : ''}
    </div>`).join('');
}

// ── Clarify mode ──────────────────────────────────────────────────────────────
let _clarifyMode = localStorage.getItem('clarify_mode') || 'advanced';

function setClarifyMode(mode, persist = false) {
  _clarifyMode = mode;
  localStorage.setItem('clarify_mode', mode);
  document.querySelectorAll('.cl-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  if (persist) saveBookSettings({ clarify_mode: mode });
}
setClarifyMode(_clarifyMode);

document.querySelectorAll('.cl-mode-btn').forEach(b =>
  b.addEventListener('click', () => setClarifyMode(b.dataset.mode, true))
);

// ── TTS playback ──────────────────────────────────────────────────────────────
let _audioOrigB64 = null;
let _audioTrlB64  = null;

// Single shared TTS player — starting one clip stops any other (original vs translation
// are mutually exclusive). Re-clicking the playing source toggles it off.
let _ttsAudio = null;
let _ttsSource = null;  // 'orig' | 'trl'

function stopTts() {
  if (_ttsAudio) {
    _ttsAudio.pause();
    if (_ttsAudio.src) URL.revokeObjectURL(_ttsAudio.src);
    _ttsAudio = null;
  }
  _ttsSource = null;
}

function playB64Audio(b64, source) {
  // Toggle off if the same source is already playing
  if (_ttsSource === source && _ttsAudio && !_ttsAudio.paused) { stopTts(); return; }
  stopTts();
  if (!b64) return;
  // TTS and book audio are mutually exclusive — pause the book (and cancel any
  // auto-resume countdown) so they never overlap.
  clearAutoResume();
  audioEl.pause();
  const url = URL.createObjectURL(b64Blob(b64, 'audio/wav'));
  _ttsAudio = new Audio(url);
  _ttsSource = source;
  _ttsAudio.onended = () => stopTts();
  _ttsAudio.onerror = () => stopTts();
  _ttsAudio.play().catch(() => stopTts());
}

$('cl-tts-orig').addEventListener('click', () => playB64Audio(_audioOrigB64, 'orig'));
$('cl-tts-trl').addEventListener('click',  () => playB64Audio(_audioTrlB64, 'trl'));

// ── Auto-resume countdown ──────────────────────────────────────────────────────
let _autoResumeTimer = null;
let _autoResumePos   = 0;

function startAutoResume(position, secs = 10) {
  clearAutoResume();
  _autoResumePos = position;
  $('cl-cancel-btn').classList.remove('hidden');
  let remaining = secs;
  const tick = () => {
    if (remaining <= 0) {
      _autoResumeTimer = null;
      $('cl-cancel-btn').classList.add('hidden');
      audioEl.currentTime = _autoResumePos;
      audioEl.play();
      setClStatus('');
      return;
    }
    setClStatus(`Continuing in ${remaining}…`);
    remaining--;
    _autoResumeTimer = setTimeout(tick, 1000);
  };
  tick();
}

function clearAutoResume() {
  if (_autoResumeTimer) { clearTimeout(_autoResumeTimer); _autoResumeTimer = null; }
  $('cl-cancel-btn').classList.add('hidden');
  setClStatus('');
}

// ── Streaming helper ──────────────────────────────────────────────────────────
async function streamPost(path, body, onEvent) {
  const resp = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) { onUnauthorized(); throw new Error('Unauthorized'); }
  if (!resp.ok) throw new Error(await resp.text());
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  }
}

// Recent sentences up to the current playback position (current + a few previous).
function recentSentences(maxCount = 5) {
  const t = audioEl.currentTime;
  const segs = S.transcript || [];
  if (!segs.length) return { list: [], currentIdx: -1 };
  let idx = segs.findIndex(s => s.start <= t && t <= s.end);
  if (idx === -1) {
    for (let i = segs.length - 1; i >= 0; i--) { if (segs[i].end <= t) { idx = i; break; } }
  }
  if (idx === -1) idx = 0;
  const start = Math.max(0, idx - (maxCount - 1));
  return { list: segs.slice(start, idx + 1), currentIdx: idx };
}

const _REWIND_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 19 2 12 11 5 11 19"/><polyline points="22 19 13 12 22 5 22 19"/></svg>';

function buildSentencePicker() {
  const picker = $('cl-picker');
  const wrap = $('cl-picker-wrap');
  const { list } = recentSentences(5);
  if (list.length <= 1) { wrap.classList.add('hidden'); picker.innerHTML = ''; return list; }
  wrap.classList.remove('hidden');
  picker.innerHTML = '';
  list.forEach((seg, i) => {
    const row = document.createElement('div');
    row.className = 'cl-picker-item' + (i === list.length - 1 ? ' current' : '');

    const txt = document.createElement('button');
    txt.className = 'cl-picker-text';
    txt.textContent = seg.text.trim();
    txt.title = 'Explain this sentence';
    txt.addEventListener('click', () => {
      if (S.clarifying) return;
      picker.querySelectorAll('.cl-picker-item').forEach(el => el.classList.remove('selected'));
      row.classList.add('selected');
      analyzeSentence((seg.start + seg.end) / 2);
    });

    const rew = document.createElement('button');
    rew.className = 'cl-picker-rewind';
    rew.title = 'Rewind to the start of this sentence';
    rew.innerHTML = _REWIND_SVG;
    rew.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAutoResume();
      stopTts();
      audioEl.currentTime = seg.start;
      audioEl.play().catch(() => {});
    });

    row.appendChild(txt);
    row.appendChild(rew);
    picker.appendChild(row);
  });
  return list;
}

let _resumeAfterClarify = false;   // only auto-continue if audio was playing when clarify began
let _clarifyPos = null;            // position of the clarified sentence (for chat passage context)

// True when the clarify panel is already on screen (so we're switching sentences, not entering fresh).
function _clarifyIsOpen() {
  return !$('pf-right-panel').classList.contains('hidden')
      && !$('pf-clarify-panel').classList.contains('hidden');
}

function runClarify() {
  if (!S.book) return;
  // Capture "was playing" only on fresh entry — a prior clarify already paused the audio,
  // so re-reading audioEl.paused here would wrongly latch false.
  if (!_clarifyIsOpen()) _resumeAfterClarify = !audioEl.paused;
  audioEl.pause();
  clearAutoResume();
  openClPanel();
  // Reset display
  $('cl-original').textContent   = '';
  $('cl-translated').textContent = '';
  $('cl-explanation').textContent = '';
  $('cl-explanation').classList.add('hidden');
  $('cl-terms').classList.add('hidden');
  // Build the picker and analyze the current sentence by default (instant + switchable)
  const list = buildSentencePicker();
  if (list.length) {
    const cur = list[list.length - 1];
    const items = $('cl-picker').querySelectorAll('.cl-picker-item');
    if (items.length) items[items.length - 1].classList.add('selected');
    analyzeSentence((cur.start + cur.end) / 2);
  } else {
    analyzeSentence(audioEl.currentTime);  // transcript not loaded — fall back to position
  }
}

async function analyzeSentence(positionSec) {
  if (S.clarifying) return;
  stopTts();  // stop any TTS from a previously-clarified sentence
  S.clarifying = true;
  $('clarify-btn').disabled      = true;
  $('mini-clarify-btn').disabled = true;
  _audioOrigB64 = null;
  _audioTrlB64  = null;
  $('cl-tts-orig').disabled = true;
  $('cl-tts-trl').disabled  = true;
  clearAutoResume();

  $('cl-translated').textContent = '';
  $('cl-explanation').textContent = '';
  $('cl-explanation').classList.add('hidden');
  $('cl-terms').classList.add('hidden');
  $('cl-original').textContent = '…';
  setClStatus('Analyzing…', true);
  _clarifyPos = positionSec;

  try {
    const expl = $('cl-explanation');
    const panel = $('pf-clarify-panel');
    let sentenceStart = positionSec;

    await streamPost('/api/clarify/stream',
      { book_id: S.book.id, position_sec: positionSec, mode: _clarifyMode },
      (ev) => {
        if (ev.type === 'meta') {
          $('cl-src-pill').textContent   = LANG[ev.source_lang] || ev.source_lang;
          $('cl-tgt-pill').textContent   = LANG[ev.target_lang] || ev.target_lang;
          $('cl-original').textContent   = ev.original_text;
          $('cl-translated').textContent = ev.translated_text;
          renderClTerms(ev.terms || []);
          setClStatus('Explaining…', true);
          expl.classList.remove('hidden');
          _audioOrigB64 = ev.audio_original || null;
          _audioTrlB64  = ev.audio_translated || null;
          $('cl-tts-orig').disabled = !_audioOrigB64;
          $('cl-tts-trl').disabled  = !_audioTrlB64;
          sentenceStart = ev.sentence_start;
        } else if (ev.type === 'token') {
          expl.textContent += ev.text;
          panel.scrollTop = panel.scrollHeight;  // follow streaming text
        } else if (ev.type === 'done') {
          setClStatus('');
          _clarifyPos = sentenceStart;
          // Only count down to resume if audio was actually playing when we clarified
          if (_resumeAfterClarify) startAutoResume(sentenceStart);
        }
      }
    );

  } catch (err) {
    if (err.message !== 'Unauthorized') {
      let msg = err.message;
      try { const p = JSON.parse(msg); if (p.detail) msg = p.detail; } catch {}
      setClStatus(msg);
    }
  } finally {
    S.clarifying = false;
    $('clarify-btn').disabled      = false;
    $('mini-clarify-btn').disabled = false;
  }
}

function setClStatus(msg, dot = false) {
  $('cl-status').innerHTML = dot ? `<span class="cl-status-dot"></span>${msg}` : msg;
}

$('clarify-btn').addEventListener('click', runClarify);
$('mini-clarify-btn').addEventListener('click', runClarify);
$('pf-chat-btn').addEventListener('click', expandChat);

$('cl-resume-btn').addEventListener('click', () => {
  clearAutoResume();
  audioEl.currentTime = _autoResumePos || audioEl.currentTime;
  audioEl.play();
});
$('cl-cancel-btn').addEventListener('click', () => { clearAutoResume(); });
$('cl-close-btn').addEventListener('click', () => { clearAutoResume(); closeClPanel(); });

// ── Dialogue ──────────────────────────────────────────────────────────────────
let _chatStreaming = false;

function scrollChatDown() {
  const msgs = $('cl-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function appendChatMsg(role, text, streaming = false) {
  const el = document.createElement('div');
  el.className = `cl-chat-msg ${role}${streaming ? ' streaming' : ''}`;
  if (role === 'assistant') el.innerHTML = renderMarkdown(text);
  else el.textContent = text;
  $('cl-chat-messages').appendChild(el);
  scrollChatDown();
  return el;
}

// Load this book's stored conversation (full history) into the chat panel.
async function loadChatHistory(bookId) {
  const cont = $('cl-chat-messages');
  cont.innerHTML = '';
  try {
    const data = await api('GET', `/api/chat/${bookId}`);
    (data.messages || []).forEach(m => appendChatMsg(m.role, m.content));
  } catch {}
}

async function sendChat() {
  if (_chatStreaming || !S.book) return;
  const input = $('cl-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  _chatStreaming = true;
  $('cl-chat-send').disabled = true;

  appendChatMsg('user', msg);
  const respEl = appendChatMsg('assistant', '', true);
  let raw = '';

  try {
    await streamPost('/api/chat/stream',
      { book_id: S.book.id, message: msg, position_sec: currentChatPos() },
      (ev) => {
        if (ev.type === 'token') {
          raw += ev.text;
          respEl.innerHTML = renderMarkdown(raw);  // re-render accumulated markdown
          scrollChatDown();
        } else if (ev.type === 'done') {
          respEl.classList.remove('streaming');
        }
      }
    );
  } catch (err) {
    respEl.textContent = 'Error: ' + err.message;
    respEl.classList.remove('streaming');
  } finally {
    _chatStreaming = false;
    $('cl-chat-send').disabled = false;
  }
}

$('cl-chat-send').addEventListener('click', sendChat);
$('cl-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
$('cl-chat-input').addEventListener('focus', () => setTimeout(scrollChatDown, 300));  // after mobile keyboard opens

// ── Floating book chat (collapsible; decoupled from clarify) ──
// Anchor the chat's passage context to whatever the user is looking at right now.
function currentChatPos() {
  // The floating chat is general — anchor to where the user IS right now:
  // the page they're reading, otherwise the current playback position.
  if (READER.open) {
    const el = readerFirstVisible();
    if (el) return parseFloat(el.dataset.start) || 0;
  }
  return audioEl.currentTime || 0;
}
function showChatFab() { if (S.book) $('chat-float').classList.remove('hidden'); }
function hideChatFab() { $('chat-float').classList.add('hidden', 'collapsed'); }
function expandChat() {
  if (!S.book) return;
  $('chat-float').classList.remove('hidden', 'collapsed');
  setTimeout(() => { scrollChatDown(); $('cl-chat-input').focus(); }, 80);
}
function collapseChat() { $('chat-float').classList.add('collapsed'); }
$('chat-fab').addEventListener('click', expandChat);
$('chat-float-min').addEventListener('click', collapseChat);

// ── Playlist ──────────────────────────────────────────────────────────────────
function renderPlaylist() {
  const container = $('playlist-items');
  container.innerHTML = '';
  S.playlistBooks.forEach(b => {
    const isActive = S.book && b.id === S.book.id;
    const item = document.createElement('div');
    item.className = 'pl-item' + (isActive ? ' pl-active' : '');
    item.innerHTML = `
      <div class="pl-cover" style="background:${bookGradient(b.title)}">${bookCoverInner(b.title)}</div>
      <div class="pl-info">
        <div class="pl-title">${esc(b.title)}</div>
        <div class="pl-meta">${LANG[b.source_lang] || b.source_lang}${b.duration_sec ? ' · ' + fmt(b.duration_sec) : ''}</div>
      </div>`;
    item.addEventListener('click', () => openBook(b, S.playlistCollId));
    container.appendChild(item);
  });
  const active = container.querySelector('.pl-active');
  if (active) setTimeout(() => active.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
}

function playNext() {
  if (!S.playlistBooks.length || !S.book) return;
  let next;
  if (S.shuffle) {
    const others = S.playlistBooks.filter(b => b.id !== S.book.id);
    if (!others.length) return;
    next = others[Math.floor(Math.random() * others.length)];
  } else {
    const idx = S.playlistBooks.findIndex(b => b.id === S.book.id);
    if (idx === -1 || idx >= S.playlistBooks.length - 1) return;
    next = S.playlistBooks[idx + 1];
  }
  openBook(next, S.playlistCollId);
}

function playPrev() {
  if (!S.playlistBooks.length || !S.book) return;
  const idx = S.playlistBooks.findIndex(b => b.id === S.book.id);
  if (idx <= 0) return;
  openBook(S.playlistBooks[idx - 1], S.playlistCollId);
}

$('mini-prev-btn').addEventListener('click', playPrev);
$('mini-next-btn').addEventListener('click', playNext);

$('pl-shuffle-btn').addEventListener('click', () => {
  S.shuffle = !S.shuffle;
  $('pl-shuffle-btn').classList.toggle('active', S.shuffle);
});

audioEl.addEventListener('ended', () => { if (S.playlistBooks.length > 1) playNext(); });

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === ' ')          { e.preventDefault(); if (S.book) { clearAutoResume(); audioEl.paused ? audioEl.play() : audioEl.pause(); } }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); if (S.book) audioEl.currentTime = Math.max(0, audioEl.currentTime - 15); }
  if (e.key === 'ArrowRight') { e.preventDefault(); if (S.book) audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 15); }
  if (e.key === 'Escape') {
    if (!$('pf-clarify-panel').classList.contains('hidden')) { closeClPanel(); return; }
    if (!$('pf-right-panel').classList.contains('hidden')) { hideRightPanel(); return; }
    if (S.playerOpen) closeFullPlayer();
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
function onUnauthorized() {
  S.currentUser = null;
  showLogin();
}

function showLogin() {
  $('app').classList.add('hidden');
  $('login-page').classList.remove('hidden');
  $('login-error').textContent = '';
  clearLoginStamp();
  // Reset the submit button — it may have been left disabled/"Checking…" by a
  // prior successful login (e.g. user hit browser Back or logged out).
  const btn = $('login-submit-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Check in'; }
  _librarianLoaded = false;   // next user reloads their own librarian history
  hideChatFab();
}

// ── Librarian (main-page RAG chat over the user's whole library) ──
let _librarianLoaded = false;
let _librarianStreaming = false;
function appendLibrarianMsg(role, text, streaming = false) {
  const el = document.createElement('div');
  el.className = `cl-chat-msg ${role}${streaming ? ' streaming' : ''}`;
  if (role === 'assistant') el.innerHTML = renderMarkdown(text); else el.textContent = text;
  const c = $('librarian-messages'); c.appendChild(el); c.scrollTop = c.scrollHeight;
  return el;
}
async function loadLibrarian() {
  if (_librarianLoaded) return;
  _librarianLoaded = true;
  const c = $('librarian-messages');
  if (!c) return;
  c.innerHTML = '';
  try {
    const d = await api('GET', '/api/librarian');
    (d.messages || []).forEach(m => appendLibrarianMsg(m.role, m.content));
    if (!(d.messages || []).length) {
      appendLibrarianMsg('assistant', "Hi! I'm your librarian. Ask me to recommend something from your shelf, find where you read about a topic, or talk about your books.");
    }
  } catch {}
}
async function sendLibrarian() {
  if (_librarianStreaming) return;
  const input = $('librarian-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  _librarianStreaming = true;
  $('librarian-send').disabled = true;
  appendLibrarianMsg('user', msg);
  const respEl = appendLibrarianMsg('assistant', '', true);
  let raw = '';
  try {
    await streamPost('/api/librarian/stream', { message: msg }, (ev) => {
      if (ev.type === 'token') { raw += ev.text; respEl.innerHTML = renderMarkdown(raw); const c = $('librarian-messages'); c.scrollTop = c.scrollHeight; }
      else if (ev.type === 'done') { respEl.classList.remove('streaming'); }
    });
  } catch (err) {
    respEl.textContent = 'Error: ' + err.message; respEl.classList.remove('streaming');
  } finally {
    _librarianStreaming = false; $('librarian-send').disabled = false;
  }
}
$('librarian-send').addEventListener('click', sendLibrarian);
$('librarian-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendLibrarian(); } });
$('librarian-toggle').addEventListener('click', () => {
  const card = $('librarian-toggle').closest('.librarian-card');
  const collapsed = card.classList.toggle('collapsed');
  $('librarian-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
});

function showApp() {
  $('login-page').classList.add('hidden');
  $('app').classList.remove('hidden');
  if (S.currentUser) $('sidebar-username').textContent = S.currentUser.username;
  loadLibrarian();
}

async function checkAuth() {
  try {
    const user = await api('GET', '/api/auth/me');
    S.currentUser = user;
    showApp();
    loadAll();
    loadUserSettings();
  } catch {
    showLogin();
  }
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const errEl    = $('login-error');
  errEl.textContent = '';
  clearLoginStamp();
  if (!username || !password) { errEl.textContent = 'Enter username and password.'; return; }
  const btn = $('login-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const user = await api('POST', '/api/auth/login', { username, password });
    S.currentUser = user;
    showLoginStamp('ok');
    // Let the "Admitted" stamp land before swapping to the app.
    setTimeout(() => { showApp(); loadAll(); loadUserSettings(); }, 680);
  } catch (err) {
    let msg = 'Invalid username or password.';
    try { const p = JSON.parse(err.message); if (p.detail) msg = p.detail; } catch {}
    if (msg.toLowerCase().includes('locked')) msg = 'Account temporarily locked. Try again later.';
    showLoginStamp('fail');
    errEl.textContent = msg;
    btn.disabled = false;
    btn.textContent = 'Check in';
  }
});

// Password show/hide toggle
$('pw-toggle') && $('pw-toggle').addEventListener('click', () => {
  const inp = $('login-password'), btn = $('pw-toggle');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  btn.title = show ? 'Hide password' : 'Show password';
  inp.focus();
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch {}
  S.currentUser = null;
  S.books = [];
  S.collections = [];
  S.book = null;
  showLogin();
});

// ── User settings ─────────────────────────────────────────────────────────────
let _userSettings = { essay_enabled: true, essay_interval_min: 30 };

async function loadUserSettings() {
  try {
    _userSettings = await api('GET', '/api/settings');
    $('settings-essay-enabled').checked = !!_userSettings.essay_enabled;
    $('settings-essay-interval').value  = String(_userSettings.essay_interval_min || 30);
    $('settings-interval-row').style.opacity = _userSettings.essay_enabled ? '1' : '0.4';
    // UI prefs follow the user account (DB is source of truth; localStorage is just a cache)
    _blurUnread = !!_userSettings.blur_unread;
    _transcriptCollapsed = !!_userSettings.transcript_collapsed;
    localStorage.setItem('blur_unread', _blurUnread ? '1' : '0');
    localStorage.setItem('transcript_collapsed', _transcriptCollapsed ? '1' : '0');
    applyBlurUnread();
    applyTranscriptCollapsed();
    if (_userSettings.theme) {                 // DB is source of truth for theme
      localStorage.setItem('theme', _userSettings.theme);
      applyTheme(_userSettings.theme);
    }
  } catch {}
}

$('settings-essay-enabled').addEventListener('change', () => {
  $('settings-interval-row').style.opacity = $('settings-essay-enabled').checked ? '1' : '0.4';
});

$('settings-cancel-btn').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
$('settings-save-btn').addEventListener('click', async () => {
  const body = {
    essay_enabled:      $('settings-essay-enabled').checked,
    essay_interval_min: parseInt($('settings-essay-interval').value),
  };
  await api('PUT', '/api/settings', body);
  _userSettings = { ..._userSettings, ...body };
  $('settings-modal').classList.add('hidden');
});

// Hook settings icon (add to sidebar or nav — look for existing gear/settings button)
document.querySelectorAll('[data-action="settings"]').forEach(b =>
  b.addEventListener('click', () => $('settings-modal').classList.remove('hidden'))
);

// ── Essay trigger ─────────────────────────────────────────────────────────────
let _essayNotifShown = false;
let _lastEssayListened = 0;   // S.listenedTotal at the last essay (trigger baseline)
let _lastTickT = null;        // previous timeupdate position, to measure contiguous listening

// Merge [start,end] into a sorted, coalesced interval list (gaps ≤1s are joined).
function _mergeRange(arr, start, end) {
  arr.push({ start, end });
  arr.sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of arr) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  arr.length = 0; arr.push(...out);
}

// Called on each playing timeupdate: count only *contiguous* progress as listened,
// so a scrub (which breaks contiguity via _lastTickT reset) never inflates the total.
function noteListenTick(t) {
  if (_lastTickT != null && t > _lastTickT && t - _lastTickT < 2) {
    S.listenedTotal += (t - _lastTickT);
    _mergeRange(S.essayRanges, _lastTickT, t);
  }
  _lastTickT = t;
}

function checkEssayTrigger() {
  if (!S.book || !_userSettings.essay_enabled || _essayNotifShown) return;
  const interval = (_userSettings.essay_interval_min || 30) * 60;
  // Trigger after the user has ACTUALLY listened to `interval` seconds of new content
  // (sum of real playback), regardless of where in the book those minutes came from.
  if ((S.listenedTotal - _lastEssayListened) >= interval) {
    _essayNotifShown = true;
    showEssayNotification();
  }
}

function showEssayNotification() {
  const mins = _userSettings.essay_interval_min || 30;
  $('essay-notif-text').textContent = `You've covered ${mins} min — write an essay?`;
  $('essay-notification').classList.remove('hidden');
}

$('essay-notif-dismiss').addEventListener('click', () => {
  $('essay-notification').classList.add('hidden');
  _lastEssayListened = S.listenedTotal;   // wait another full interval of listening
  S.essayRanges = [];
  _essayNotifShown = false;
});

$('essay-notif-accept').addEventListener('click', async () => {
  $('essay-notification').classList.add('hidden');
  await openEssayPanel();
});

// ── Essay panel ───────────────────────────────────────────────────────────────
let _currentEssayId   = null;
let _essaySubmitting  = false;
let _essayMinimized   = false;

async function openEssayPanel() {
  if (!S.book) return;
  $('essay-panel').classList.remove('hidden');
  $('essay-tab').classList.add('hidden');
  $('essay-phase-prompt').classList.remove('hidden');
  $('essay-phase-review').classList.add('hidden');
  $('essay-textarea').value = '';
  $('essay-char-count').textContent = '0 chars';
  $('essay-prompt-text').textContent = 'Generating prompt…';
  $('essay-submit-btn').disabled = true;
  _essayMinimized = false;

  try {
    const r = await api('POST', '/api/essay/prompt',
      { book_id: S.book.id, position_sec: audioEl.currentTime,
        ranges: S.essayRanges.map(x => ({ start: x.start, end: x.end })) });  // exact heard passages
    _currentEssayId = r.essay_id;
    $('essay-prompt-text').textContent = r.prompt;
    $('essay-submit-btn').disabled = false;
    _lastEssayListened = S.listenedTotal;   // next essay after another interval of listening
    S.essayRanges = [];
    _essayNotifShown = false;
  } catch (err) {
    $('essay-prompt-text').textContent = 'Could not generate prompt: ' + err.message;
  }
}

$('essay-minimize-btn').addEventListener('click', () => {
  $('essay-panel').classList.add('hidden');
  $('essay-tab').classList.remove('hidden');
  _essayMinimized = true;
});

$('essay-tab').addEventListener('click', () => {
  $('essay-panel').classList.remove('hidden');
  $('essay-tab').classList.add('hidden');
  _essayMinimized = false;
});

$('essay-close-btn').addEventListener('click', () => {
  $('essay-panel').classList.add('hidden');
  $('essay-tab').classList.add('hidden');
  _essayNotifShown = false;
});

$('essay-textarea').addEventListener('input', () => {
  const len = $('essay-textarea').value.length;
  $('essay-char-count').textContent = `${len} chars`;
});

$('essay-submit-btn').addEventListener('click', async () => {
  if (_essaySubmitting || !_currentEssayId) return;
  const text = $('essay-textarea').value.trim();
  if (!text) return;
  _essaySubmitting = true;
  $('essay-submit-btn').disabled = true;

  // Switch to review phase
  $('essay-phase-prompt').classList.add('hidden');
  $('essay-phase-review').classList.remove('hidden');
  $('essay-review-essay').textContent = text;
  $('essay-review-text').textContent = '';

  try {
    await streamPost('/api/essay/submit/stream',
      { essay_id: _currentEssayId, book_id: S.book.id, essay_text: text },
      (ev) => {
        if (ev.type === 'token') $('essay-review-text').textContent += ev.text;
      }
    );
  } catch (err) {
    $('essay-review-text').textContent = 'Error: ' + err.message;
  } finally {
    _essaySubmitting = false;
  }
});

// ── Voice input ───────────────────────────────────────────────────────────────
let _mediaRecorder = null;
let _voiceChunks   = [];

$('essay-voice-btn').addEventListener('click', async () => {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _voiceChunks = [];
    _mediaRecorder = new MediaRecorder(stream);
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _voiceChunks.push(e.data); };
    _mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $('essay-voice-btn').classList.remove('recording');
      $('essay-voice-label').textContent = 'Processing…';
      $('essay-voice-btn').disabled = true;
      try {
        const blob = new Blob(_voiceChunks, { type: 'audio/webm' });
        const form = new FormData();
        form.append('file', blob, 'voice.webm');
        const r = await fetch('/api/voice-input', { method: 'POST', credentials: 'include', body: form });
        if (!r.ok) throw new Error(await r.text());
        const { text } = await r.json();
        if (text) $('essay-textarea').value += (($('essay-textarea').value ? ' ' : '') + text);
        $('essay-textarea').dispatchEvent(new Event('input'));
      } catch (e) {
        console.error('Voice input error:', e);
      } finally {
        $('essay-voice-label').textContent = 'Speak';
        $('essay-voice-btn').disabled = false;
      }
    };
    _mediaRecorder.start();
    $('essay-voice-btn').classList.add('recording');
    $('essay-voice-label').textContent = 'Stop';
  } catch (e) {
    alert('Microphone access denied or unavailable.');
  }
});

// Hook essay trigger into timeupdate (gates on listened time, not scrub position)
audioEl.addEventListener('timeupdate', () => {
  if (!S.seeking) checkEssayTrigger();
});

// ── Theme ───────────────────────────────────────────────────────────────────────
const THEME_ICONS = {
  // sun
  light:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  // moon
  dark:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  // auto (half-filled disc)
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
};
const _prefersDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let _themePref = localStorage.getItem('theme') || 'system';

function resolvedTheme(pref) {
  if (pref === 'system') return (_prefersDark && _prefersDark.matches) ? 'dark' : 'light';
  return pref;
}
function applyTheme(pref) {
  _themePref = pref;
  document.documentElement.setAttribute('data-theme', resolvedTheme(pref));
  // Login-page toggle (icon button, pre-auth)
  const loginBtn = $('theme-toggle-login');
  if (loginBtn) {
    loginBtn.innerHTML = THEME_ICONS[pref] || THEME_ICONS.system;
    loginBtn.title = pref === 'system' ? 'Theme: auto (follows system)' : 'Theme: ' + pref;
  }
  // Settings-modal segmented control
  document.querySelectorAll('#theme-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === pref));
}
function setTheme(pref) {
  applyTheme(pref);
  localStorage.setItem('theme', pref);
  saveUserSetting({ theme: pref });   // persists to DB when logged in (guarded)
}
function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  setTheme(order[(order.indexOf(_themePref) + 1) % order.length]);
}
if (_prefersDark && _prefersDark.addEventListener) {
  _prefersDark.addEventListener('change', () => { if (_themePref === 'system') applyTheme('system'); });
}
// Login page: icon cycles Auto→Light→Dark. Settings modal: explicit segment buttons.
$('theme-toggle-login') && $('theme-toggle-login').addEventListener('click', cycleTheme);
document.querySelectorAll('#theme-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => setTheme(b.dataset.theme)));

// ── Login stamp ───────────────────────────────────────────────────────────────
function showLoginStamp(kind) {            // 'ok' | 'fail'
  const st = $('login-stamp');
  if (!st) return;
  st.textContent = kind === 'ok' ? 'Admitted' : 'Denied';
  st.classList.remove('stamp-show', 'stamp-ok', 'stamp-fail');
  void st.offsetWidth;                     // reflow → restart animation
  st.classList.add('stamp-show', kind === 'ok' ? 'stamp-ok' : 'stamp-fail');
  if (kind === 'fail') {
    const ticket = $('login-ticket');
    if (ticket) { ticket.classList.remove('shake'); void ticket.offsetWidth; ticket.classList.add('shake'); }
  }
}
function clearLoginStamp() {
  const st = $('login-stamp');
  if (st) st.classList.remove('stamp-show', 'stamp-ok', 'stamp-fail');
}

// ════════════════ MOBILE READING MODE ════════════════
const READER = {
  open: false, fontScale: 1.0, lineSpacing: 1.6, brightness: 1.0,
  clSeg: null, clarifying: false,
  segs: [], moreBefore: false, moreAfter: false, loading: false,
  pitch: 0, bookId: null,          // own buffer + page width, independent of playback
};

function clampNum(v, lo, hi, dflt) {
  v = parseFloat(v);
  if (!isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}
function applyReaderPrefs() {
  const rm = $('reader-mode');
  rm.style.setProperty('--reader-font-scale', READER.fontScale);
  rm.style.setProperty('--reader-line', READER.lineSpacing);
  $('reader-dim').style.opacity = String(1 - READER.brightness);
  $('rc-font-val').textContent = Math.round(READER.fontScale * 100) + '%';
  $('rc-line-val').textContent = READER.lineSpacing.toFixed(1);
  $('rc-bright').value = String(Math.round(READER.brightness * 100));
}
function loadReaderPrefs() {
  READER.fontScale   = clampNum(_userSettings.reader_font_scale,   0.6, 2.4, 1.0);
  READER.lineSpacing = clampNum(_userSettings.reader_line_spacing, 1.2, 2.4, 1.6);
  READER.brightness  = clampNum(_userSettings.reader_brightness,   0.3, 1.0, 1.0);
  applyReaderPrefs();
}

// ── Independent reading buffer (not tied to the player's transcript window) ──
function _mergeSegs(a, b) {
  const map = new Map();
  [...a, ...b].forEach(s => map.set(Math.round(s.start * 100), s));
  return [...map.values()].sort((x, y) => x.start - y.start);
}
function readerFetchWindow(t) {
  return api('GET', `/api/books/${S.book.id}/sentences?around=${Math.max(0, t)}`);
}
async function readerLoadInitial(t) {
  READER.loading = true;
  try {
    const d = await readerFetchWindow(t);
    READER.segs = d.segments || [];
    READER.moreBefore = !!d.has_prev;
    READER.moreAfter  = !!d.has_next;
    READER.bookId = S.book.id;
  } catch { READER.segs = []; }
  finally { READER.loading = false; }
}
async function readerLoadMore(dir) {
  if (READER.loading || !READER.segs.length) return 0;
  if (dir === 'fwd'  && !READER.moreAfter)  return 0;
  if (dir === 'back' && !READER.moreBefore) return 0;
  READER.loading = true;
  let added = 0;
  try {
    const anchorT = dir === 'fwd'
      ? READER.segs[READER.segs.length - 1].end + 0.05
      : Math.max(0, READER.segs[0].start - 0.05);
    const d = await readerFetchWindow(anchorT);
    const before = READER.segs.length;
    READER.segs = _mergeSegs(READER.segs, d.segments || []);
    added = READER.segs.length - before;
    if (dir === 'fwd') READER.moreAfter  = !!d.has_next;
    else               READER.moreBefore = !!d.has_prev;
  } catch {} finally { READER.loading = false; }
  return added;
}

// ── Pagination: content flows into full-height columns; one column == one page ──
function layoutReaderColumns() {
  const scroll = $('reader-scroll'), page = $('reader-page');
  const cs = getComputedStyle(scroll);
  const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
  const content = Math.max(120, scroll.clientWidth - padL - padR);
  page.style.columnWidth = content + 'px';
  page.style.columnGap = (padL + padR) + 'px';
  READER.pitch = content + padL + padR;          // one page width
}
function renderReaderPage() {
  const page = $('reader-page');
  page.innerHTML = '';
  if (!READER.segs.length) {
    page.innerHTML = '<div class="reader-empty">Nothing transcribed here yet.</div>';
    return;
  }
  let para = document.createElement('p'); para.className = 'reader-para';
  READER.segs.forEach((seg, i) => {
    const span = document.createElement('span');
    span.className = 'reader-sent';
    span.dataset.start = seg.start;
    span.textContent = seg.text.trim() + ' ';
    span.addEventListener('click', () => openReaderClarify(seg));
    para.appendChild(span);
    if ((i + 1) % 4 === 0) { page.appendChild(para); para = document.createElement('p'); para.className = 'reader-para'; }
  });
  if (para.childNodes.length) page.appendChild(para);
  layoutReaderColumns();
  highlightReaderActive();
}
function readerSnap(smooth = true) {
  const s = $('reader-scroll');
  if (!READER.pitch) return;
  const idx = Math.round(s.scrollLeft / READER.pitch);
  s.scrollTo({ left: idx * READER.pitch, behavior: smooth ? 'smooth' : 'auto' });
}
function readerFirstVisible() {
  const s = $('reader-scroll'), srect = s.getBoundingClientRect();
  for (const el of $('reader-page').querySelectorAll('.reader-sent')) {
    const r = el.getBoundingClientRect();
    if (r.left >= srect.left - 2 && r.left < srect.right) return el;
  }
  return null;
}
function updateReaderArrows() {
  const s = $('reader-scroll');
  const atStart = s.scrollLeft <= 2;
  const atEnd = s.scrollLeft + s.clientWidth >= s.scrollWidth - 2;
  const prev = $('reader-prev-page'), next = $('reader-next-page');
  if (prev) prev.disabled = atStart && !READER.moreBefore;
  if (next) next.disabled = atEnd && !READER.moreAfter;
}
function reaffixReader(anchorStart) {            // keep reading spot after a relayout
  layoutReaderColumns();
  if (anchorStart != null) {
    const el = $('reader-page').querySelector(`.reader-sent[data-start="${anchorStart}"]`);
    if (el) { readerScrollToEl(el, false); updateReaderArrows(); return; }
  }
  readerSnap(false); updateReaderArrows();
}
async function readerNextPage() {
  const s = $('reader-scroll');
  if (READER.moreAfter && s.scrollLeft + s.clientWidth >= s.scrollWidth - READER.pitch * 0.5) {
    if (await readerLoadMore('fwd')) renderReaderPage();
  }
  s.scrollTo({ left: (Math.round(s.scrollLeft / READER.pitch) + 1) * READER.pitch, behavior: 'smooth' });
  setTimeout(updateReaderArrows, 350);
}
async function readerPrevPage() {
  const s = $('reader-scroll');
  if (READER.moreBefore && s.scrollLeft <= READER.pitch * 0.5) {
    const first = $('reader-page').querySelector('.reader-sent');
    const anchorStart = first ? first.dataset.start : null;
    if (await readerLoadMore('back')) {
      renderReaderPage();
      const el = anchorStart != null ? $('reader-page').querySelector(`.reader-sent[data-start="${anchorStart}"]`) : null;
      if (el) { readerScrollToEl(el, false); updateReaderArrows(); return; }
    }
  }
  s.scrollTo({ left: Math.max(0, Math.round(s.scrollLeft / READER.pitch) - 1) * READER.pitch, behavior: 'smooth' });
  setTimeout(updateReaderArrows, 350);
}
let _readerScrollT = null;
function onReaderScroll() {                       // swipe: auto-load at boundaries, then snap
  clearTimeout(_readerScrollT);
  _readerScrollT = setTimeout(async () => {
    const s = $('reader-scroll');
    if (READER.moreAfter && s.scrollLeft + s.clientWidth >= s.scrollWidth - READER.pitch * 0.8) {
      if (await readerLoadMore('fwd')) renderReaderPage();
    } else if (READER.moreBefore && s.scrollLeft <= READER.pitch * 0.8) {
      const first = $('reader-page').querySelector('.reader-sent');
      const anchorStart = first ? first.dataset.start : null;
      if (await readerLoadMore('back')) {
        renderReaderPage();
        const el = anchorStart != null ? $('reader-page').querySelector(`.reader-sent[data-start="${anchorStart}"]`) : null;
        if (el) { readerScrollToEl(el, false); updateReaderArrows(); saveReaderPos(); return; }
      }
    }
    readerSnap();
    updateReaderArrows();
    saveReaderPos();
  }, 140);
}

// ── Highlight where audio is (does NOT move the reading position) ──
function highlightReaderActive() {
  if (!READER.open) return;
  const t = audioEl.currentTime || 0;
  let activeStart = null;
  for (const s of READER.segs) { if (s.start <= t) activeStart = s.start; else break; }
  $('reader-page').querySelectorAll('.reader-sent').forEach(el =>
    el.classList.toggle('active', activeStart !== null && +el.dataset.start === activeStart));
}

// Scroll so `el` sits at the start of a page (geometry-based — reliable for the
// horizontal multi-column layout, unlike scrollIntoView).
function readerScrollToEl(el, smooth = true) {
  if (!el || !READER.pitch) return;
  const s = $('reader-scroll');
  const delta = el.getBoundingClientRect().left - s.getBoundingClientRect().left;
  const target = Math.round((s.scrollLeft + delta) / READER.pitch) * READER.pitch;
  s.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
}
function readerElForTime(t) {
  let target = null;
  for (const s of READER.segs) { if (s.start <= t) target = s; else break; }
  const page = $('reader-page');
  return (target ? page.querySelector(`.reader-sent[data-start="${target.start}"]`) : null)
         || page.querySelector('.reader-sent');
}
function readerSeekToTime(t, smooth = true) { readerScrollToEl(readerElForTime(t), smooth); }

// ── Reading-position persistence (own spot, independent of playback) ──
function readerSavedPos(bookId) {
  const v = parseFloat(localStorage.getItem('reader_pos_' + bookId));
  return isFinite(v) ? v : null;
}
function saveReaderPos() {
  if (!READER.open || !S.book) return;
  const el = readerFirstVisible();
  if (el) localStorage.setItem('reader_pos_' + S.book.id, el.dataset.start);
}

// ── Reading ↔ playback sync (independent; connected on demand) ──
function readerLocate(smooth = true) {            // jump the reading view to current playback
  readerSeekToTime(audioEl.currentTime || 0, smooth);
  highlightReaderActive();
}
function readerPlayHere() {                        // play audio from the first sentence on this page
  const el = readerFirstVisible();
  if (!el) return;
  const start = parseFloat(el.dataset.start);
  if (!isFinite(start)) return;
  stopTts(); clearAutoResume();
  audioEl.currentTime = start;
  audioEl.play().catch(() => {});
  updateReaderPlayIcon();
}

async function openReader() {
  if (!S.book) return;
  READER.open = true;
  $('reader-title').textContent = S.book.title || 'Reading';
  loadReaderPrefs();
  $('reader-mode').classList.remove('hidden');          // show first so clientWidth is correct
  $('chat-float').classList.add('in-reader');           // reader uses its own chat button (hide FAB)
  collapseChat();
  // Resume at our own saved reading spot; first time, start where playback is.
  const saved = readerSavedPos(S.book.id);
  // audio metadata may not be loaded yet (reader opened straight from a tap) — fall back to the book's progress
  const startT = saved != null ? saved : (audioEl.currentTime || S.maxReadSec || 0);
  if (READER.bookId !== S.book.id || !READER.segs.length) {
    await readerLoadInitial(startT);
  }
  renderReaderPage();
  // Jump after layout settles (two frames so the multi-column width is applied).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    readerSeekToTime(startT, false);
    highlightReaderActive();
    updateReaderArrows();
  }));
  updateReaderPlayIcon();
  updateReaderProgress();
}
function closeReader() {
  READER.open = false;
  $('reader-mode').classList.add('hidden');
  $('reader-cl-bg').classList.add('hidden');
  $('reader-ctrl-bg').classList.add('hidden');
  $('chat-float').classList.remove('in-reader');
}

// ── Reading controls (persist to account) ──
function setReaderFont(delta) {
  const a = READER.open ? readerFirstVisible() : null, aStart = a ? a.dataset.start : null;
  READER.fontScale = clampNum(READER.fontScale + delta, 0.6, 2.4, 1.0);
  applyReaderPrefs(); saveUserSetting({ reader_font_scale: READER.fontScale });
  if (READER.open) reaffixReader(aStart);
}
function setReaderLine(delta) {
  const a = READER.open ? readerFirstVisible() : null, aStart = a ? a.dataset.start : null;
  READER.lineSpacing = clampNum(READER.lineSpacing + delta, 1.2, 2.4, 1.6);
  applyReaderPrefs(); saveUserSetting({ reader_line_spacing: READER.lineSpacing });
  if (READER.open) reaffixReader(aStart);
}
function setReaderBright(pct) { READER.brightness = clampNum(pct / 100, 0.3, 1.0, 1.0); applyReaderPrefs(); saveUserSetting({ reader_brightness: READER.brightness }); }

// ── Tap-a-line clarify sheet (reuses /api/clarify/stream; playback ONLY via Play button) ──
function setRclStatus(msg, dot = false) {
  $('rcl-status').innerHTML = (dot ? '<span class="cl-status-dot"></span>' : '') + (msg || '');
}
function renderRclTerms(terms) {
  const box = $('rcl-terms');
  if (!terms || !terms.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.innerHTML = terms.map(t =>
    `<span class="rcl-term"><b>${esc(t.term)}</b> — ${esc(t.meaning || '')}</span>`).join('');
  box.classList.remove('hidden');
}

async function openReaderClarify(seg) {
  if (READER.clarifying) return;
  READER.clSeg = seg;
  $('reader-cl-bg').classList.remove('hidden', 'sheet-collapsed');   // always open expanded
  $('reader-cl-sheet').classList.remove('collapsed');
  $('reader-cl-sheet').scrollTop = 0;
  $('rcl-original').textContent   = seg.text.trim();
  $('rcl-translated').textContent = '';
  $('rcl-explanation').textContent = '';
  renderRclTerms([]);
  $('rcl-src').textContent = '';
  $('rcl-tgt').textContent = '';
  setRclStatus('Analyzing…', true);
  READER.clarifying = true;
  const pos = (seg.start + seg.end) / 2;
  try {
    await streamPost('/api/clarify/stream',
      { book_id: S.book.id, position_sec: pos, mode: _clarifyMode },
      (ev) => {
        if (ev.type === 'meta') {
          $('rcl-src').textContent = LANG[ev.source_lang] || ev.source_lang;
          $('rcl-tgt').textContent = LANG[ev.target_lang] || ev.target_lang;
          $('rcl-original').textContent   = ev.original_text;
          $('rcl-translated').textContent = ev.translated_text;
          renderRclTerms(ev.terms || []);
          setRclStatus('Explaining…', true);
        } else if (ev.type === 'token') {
          $('rcl-explanation').textContent += ev.text;
          const sheet = $('reader-cl-sheet'); sheet.scrollTop = sheet.scrollHeight;
        } else if (ev.type === 'done') {
          setRclStatus('');                  // no autoplay — manual Play only
        }
      });
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      let msg = err.message; try { const p = JSON.parse(msg); if (p.detail) msg = p.detail; } catch {}
      setRclStatus(msg);
    }
  } finally {
    READER.clarifying = false;
  }
}
function playReaderLine() {
  if (!READER.clSeg) return;
  stopTts();
  clearAutoResume();
  audioEl.currentTime = READER.clSeg.start;
  audioEl.play().catch(() => {});
  updateReaderPlayIcon();
}


// ── Reader playback bar ──
function updateReaderPlayIcon() {
  const p = $('reader-play-icon');
  if (!p) return;
  p.innerHTML = audioEl.paused ? '<path d="M8 5v14l11-7z"/>' : '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
}
function updateReaderProgress() {
  if (!READER.open) return;
  const d = audioEl.duration || 0, c = audioEl.currentTime || 0;
  $('reader-prog-fill').style.width = d ? (c / d * 100) + '%' : '0%';
  $('reader-time').textContent = fmt(c);
}

// ── Reader event wiring ──
$('pf-read-btn').addEventListener('click', openReader);
$('pf-reader-btn').addEventListener('click', openReader);   // mobile transport-row reader button
$('reader-back').addEventListener('click', closeReader);
$('reader-aa').addEventListener('click', () => $('reader-ctrl-bg').classList.remove('hidden'));
$('reader-chat-btn').addEventListener('click', expandChat);
$('reader-play').addEventListener('click', () => { audioEl.paused ? audioEl.play().catch(() => {}) : audioEl.pause(); });
$('reader-prev-page').addEventListener('click', readerPrevPage);
$('reader-next-page').addEventListener('click', readerNextPage);
$('reader-playhere').addEventListener('click', readerPlayHere);
$('reader-locate').addEventListener('click', () => readerLocate(true));
$('reader-scroll').addEventListener('scroll', onReaderScroll, { passive: true });
$('reader-prog').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audioEl.duration) audioEl.currentTime = ((e.clientX - r.left) / r.width) * audioEl.duration;
});
$('rc-font-dec').addEventListener('click', () => setReaderFont(-0.1));
$('rc-font-inc').addEventListener('click', () => setReaderFont(+0.1));
$('rc-line-dec').addEventListener('click', () => setReaderLine(-0.1));
$('rc-line-inc').addEventListener('click', () => setReaderLine(+0.1));
$('rc-bright').addEventListener('input', (e) => setReaderBright(+e.target.value));
$('rcl-play').addEventListener('click', playReaderLine);
$('rcl-collapse').addEventListener('click', () => {
  const collapsed = $('reader-cl-sheet').classList.toggle('collapsed');
  $('reader-cl-bg').classList.toggle('sheet-collapsed', collapsed);   // un-dim + click-through when collapsed
});
$('rcl-close').addEventListener('click', () => {
  $('reader-cl-bg').classList.add('hidden');
  $('reader-cl-bg').classList.remove('sheet-collapsed');
  $('reader-cl-sheet').classList.remove('collapsed');
});
// Reader mode (Beginner/Advanced) buttons re-run the current clarify in the new mode
document.querySelectorAll('#reader-cl-sheet .cl-mode-btn').forEach(b =>
  b.addEventListener('click', () => { if (READER.clSeg && !READER.clarifying) openReaderClarify(READER.clSeg); }));
// Tap the dimmed backdrop (not the sheet) to dismiss
$('reader-ctrl-bg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });
$('reader-cl-bg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); });
// The grip bar at the top of each sheet dismisses it (tap to close)
document.querySelectorAll('#reader-mode .sheet-grip').forEach(g =>
  g.addEventListener('click', () => { const bg = g.closest('.reader-sheet-bg'); if (bg) bg.classList.add('hidden'); }));

audioEl.addEventListener('timeupdate', () => { if (READER.open) { updateReaderProgress(); highlightReaderActive(); } });
audioEl.addEventListener('play',  updateReaderPlayIcon);
audioEl.addEventListener('pause', updateReaderPlayIcon);
// Re-paginate on viewport change, keeping the reading spot
window.addEventListener('resize', () => {
  if (!READER.open) return;
  const a = readerFirstVisible(), aStart = a ? a.dataset.start : null;
  reaffixReader(aStart);
});

// Browser Back can restore this page from the bfcache mid-login (button frozen
// on "Checking…"). Re-verify auth and reset the login button on restore.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    const btn = $('login-submit-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Check in'; }
    checkAuth();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
applyTheme(_themePref);
setGreeting();
checkAuth();
