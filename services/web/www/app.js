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

  const lines = String(src).split('\n');
  let html = '', list = null;  // list = 'ul' | 'ol' | null
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
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

function playBlob(blob) {
  return new Promise(res => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.onended = () => { URL.revokeObjectURL(url); res(); };
    a.onerror = res;
    a.play().catch(res);
  });
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
      openBook(full, collId);
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
  // Target language is chosen per-book in the player; default to last-used (or 'en').
  const tgt = localStorage.getItem('default_target_lang') || 'en';
  const fd  = new FormData();
  fd.append('file', file);

  let url = `/api/books?source_lang=${src}&target_lang=${tgt}`;
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
  card.addEventListener('click', e => { if (!e.target.closest('.book-delete')) openBook(book); });
  return card;
}

function makeBookMini(book) {
  const wrap = document.createElement('div');
  wrap.className = 'book-mini';
  wrap.innerHTML = `
    <div class="book-mini-cover" style="background:${bookGradient(book.title)}">${bookCoverInner(book.title)}</div>
    <div class="book-mini-title">${esc(book.title)}</div>
    <div class="book-mini-lang">${LANG[book.source_lang] || book.source_lang}</div>`;
  wrap.addEventListener('click', () => openBook(book));
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
let _transcriptRefreshTimer = null;

async function refreshPartialTranscript(bookId) {
  if (!S.book || S.book.id !== bookId) { clearInterval(_transcriptRefreshTimer); return; }
  try {
    const data = await api('GET', `/api/books/${bookId}/transcript`);
    S.transcript = data.segments || S.transcript;
    if (data.complete) clearInterval(_transcriptRefreshTimer);
  } catch {}
}

function _startAudio(bookId, prog, autoplay) {
  audioEl.src = `/api/books/${bookId}/audio`;
  audioEl.load();
  audioEl.addEventListener('loadedmetadata', () => {
    if (prog > 0) audioEl.currentTime = prog;
    if (autoplay) audioEl.play().catch(() => {});
  }, { once: true });
}

async function openBook(book, collId = null, autoplay = false) {
  S.book = book;
  S.transcript = [];
  S.activeIdx  = -1;
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
    _startAudio(book.id, prog, autoplay);
  } catch {
    // Fallback to localStorage
    $('pf-tgt-sel').value = book.target_lang || 'en';
    _startAudio(book.id, savedPos(book.id) || 0, autoplay);
  }

  miniPlayer.classList.remove('hidden');
  openFullPlayer();
  _essayNotifShown = false;
  loadLastEssayPos(book.id).catch(() => {});

  // Load transcript silently for updateActive (mini-player subtitle)
  try {
    const data = await api('GET', `/api/books/${book.id}/transcript`);
    S.transcript = data.segments || [];
    // If still transcribing, keep refreshing the partial transcript so the subtitle
    // (and Clarify reach) extend as more sentences are produced.
    clearInterval(_transcriptRefreshTimer);
    if (!data.complete) {
      _transcriptRefreshTimer = setInterval(() => refreshPartialTranscript(book.id), 20000);
    }
  } catch {
    S.transcript = [];
  }

  // Load playlist when opened from a collection
  if (collId) {
    try {
      const books = await api('GET', `/api/collections/${collId}/books`);
      S.playlistBooks = books;
    } catch {
      S.playlistBooks = [];
    }
    if (S.playlistBooks.length > 1) {
      renderPlaylist();
      showRightPanel('playlist');
    }
  } else {
    S.playlistBooks = [];
  }
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
  updateActive(t);
  if (S.book) { savePos(S.book.id, t); saveBookSettings({ progress_sec: t }); }
});

const PLAY_SVG  = `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
const PAUSE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
const MINI_PLAY  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
const MINI_PAUSE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

audioEl.addEventListener('play',  () => { $('play-btn').innerHTML = PAUSE_SVG; $('mini-play-btn').innerHTML = MINI_PAUSE; });
audioEl.addEventListener('pause', () => { $('play-btn').innerHTML = PLAY_SVG;  $('mini-play-btn').innerHTML = MINI_PLAY; });

// ── Playback controls ─────────────────────────────────────────────────────────
$('play-btn').addEventListener('click',    () => { clearAutoResume(); audioEl.paused ? audioEl.play() : audioEl.pause(); });
$('mini-play-btn').addEventListener('click', () => { clearAutoResume(); audioEl.paused ? audioEl.play() : audioEl.pause(); });
$('rewind-btn').addEventListener('click',  () => { audioEl.currentTime = Math.max(0, audioEl.currentTime - 15); });
$('forward-btn').addEventListener('click', () => { audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 15); });

$('seek-bar').addEventListener('mousedown', () => { S.seeking = true; });
$('seek-bar').addEventListener('input',     () => { $('time-cur').textContent = fmt(+$('seek-bar').value); });
$('seek-bar').addEventListener('change',    () => { audioEl.currentTime = +$('seek-bar').value; S.seeking = false; });

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
}

// ── Right panel helpers ───────────────────────────────────────────────────────
function showRightPanel(view) {
  $('pf-right-panel').classList.remove('hidden');
  pfFull.classList.add('pf-panel-open');
  if (view === 'clarify') {
    $('pf-playlist-view').classList.add('hidden');
    $('pf-clarify-panel').classList.remove('hidden');
  } else {
    $('pf-clarify-panel').classList.add('hidden');
    $('pf-playlist-view').classList.remove('hidden');
  }
}

function hideRightPanel() {
  $('pf-right-panel').classList.add('hidden');
  pfFull.classList.remove('pf-panel-open');
}

// ── Clarify ───────────────────────────────────────────────────────────────────
function openClPanel() { showRightPanel('clarify'); }

function closeClPanel() {
  if (S.playlistBooks.length > 1) {
    showRightPanel('playlist');
  } else {
    hideRightPanel();
  }
}

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

function playB64Audio(b64) {
  if (!b64) return;
  const blob = b64Blob(b64, 'audio/wav');
  playBlob(blob);
}

$('cl-tts-orig').addEventListener('click', () => playB64Audio(_audioOrigB64));
$('cl-tts-trl').addEventListener('click',  () => playB64Audio(_audioTrlB64));

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

async function runClarify() {
  if (S.clarifying || !S.book) return;
  S.clarifying = true;
  $('clarify-btn').disabled      = true;
  $('mini-clarify-btn').disabled = true;
  _audioOrigB64 = null;
  _audioTrlB64  = null;
  $('cl-tts-orig').disabled = true;
  $('cl-tts-trl').disabled  = true;

  audioEl.pause();
  clearAutoResume();
  openClPanel();
  $('cl-original').textContent   = '…';
  $('cl-translated').textContent = '';
  $('cl-explanation').textContent = '';
  $('cl-explanation').classList.add('hidden');
  $('cl-terms').classList.add('hidden');
  setClStatus('Analyzing…', true);

  try {
    const expl = $('cl-explanation');
    const panel = $('pf-clarify-panel');
    let sentenceStart = audioEl.currentTime;

    await streamPost('/api/clarify/stream',
      { book_id: S.book.id, position_sec: audioEl.currentTime, mode: _clarifyMode },
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
          panel.scrollTop = panel.scrollHeight;
        } else if (ev.type === 'token') {
          expl.textContent += ev.text;
          panel.scrollTop = panel.scrollHeight;  // follow streaming text
        } else if (ev.type === 'done') {
          // Only start the auto-continue countdown after the explanation is fully streamed
          setClStatus('');
          startAutoResume(sentenceStart);
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
  msgs.scrollTop = msgs.scrollHeight;
  // Also scroll the whole clarify panel so the input row stays in view
  const panel = $('pf-clarify-panel');
  panel.scrollTop = panel.scrollHeight;
}

function appendChatMsg(role, text, streaming = false) {
  const el = document.createElement('div');
  el.className = `cl-chat-msg ${role}${streaming ? ' streaming' : ''}`;
  el.textContent = text;
  $('cl-chat-messages').appendChild(el);
  scrollChatDown();
  return el;
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
      { book_id: S.book.id, message: msg, position_sec: audioEl.currentTime },
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
}

function showApp() {
  $('login-page').classList.add('hidden');
  $('app').classList.remove('hidden');
  if (S.currentUser) $('sidebar-username').textContent = S.currentUser.username;
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
  if (!username || !password) { errEl.textContent = 'Enter username and password.'; return; }
  const btn = $('login-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const user = await api('POST', '/api/auth/login', { username, password });
    S.currentUser = user;
    showApp();
    loadAll();
  } catch (err) {
    let msg = 'Invalid username or password.';
    try { const p = JSON.parse(err.message); if (p.detail) msg = p.detail; } catch {}
    if (msg.toLowerCase().includes('locked')) msg = 'Account temporarily locked. Try again later.';
    errEl.textContent = msg;
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
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
let _lastEssayPos = 0;
let _essayNotifShown = false;

async function loadLastEssayPos(bookId) {
  try {
    const r = await api('GET', `/api/books/${bookId}/essays/last-position`);
    _lastEssayPos = r.position_sec || 0;
  } catch {
    _lastEssayPos = 0;
  }
}

function checkEssayTrigger(currentTime) {
  if (!S.book || !_userSettings.essay_enabled || _essayNotifShown) return;
  const interval = (_userSettings.essay_interval_min || 30) * 60;
  if (currentTime - _lastEssayPos >= interval) {
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
  _lastEssayPos = audioEl.currentTime;  // reset trigger from current position
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
      { book_id: S.book.id, position_sec: audioEl.currentTime });
    _currentEssayId = r.essay_id;
    $('essay-prompt-text').textContent = r.prompt;
    $('essay-submit-btn').disabled = false;
    _lastEssayPos = audioEl.currentTime;
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

// Hook essay trigger into timeupdate
const _origTimeUpdate = audioEl.ontimeupdate;
audioEl.addEventListener('timeupdate', () => {
  if (!S.seeking) checkEssayTrigger(audioEl.currentTime);
});

// ── Init ──────────────────────────────────────────────────────────────────────
setGreeting();
checkAuth();
