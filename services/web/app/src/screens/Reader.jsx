import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api';
import { usePlayer } from '../player';
import { langName } from '../lib/lang';
import { cn, scrollBehavior } from '../lib/utils';
import ClarifySheet from '../components/ClarifySheet';
import ThemeLamp from '../components/ThemeLamp';

function IconBtn({ children, title, onClick, active }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className={cn('w-9 h-9 flex items-center justify-center rounded-full transition-colors',
        active ? 'text-primary bg-accent/40' : 'text-muted-foreground hover:text-primary hover:bg-accent/40')}>
      {children}
    </button>
  );
}

export default function Reader() {
  // Selective subscriptions: the reader is heavy and must NOT re-render on the ~4Hz `cur` tick.
  const book = usePlayer((s) => s.book);
  const closeReader = usePlayer((s) => s.closeReader);
  const openChat = usePlayer((s) => s.openChat);
  const playFrom = usePlayer((s) => s.playFrom);

  const [segments, setSegments] = useState([]);
  const [clarifySeg, setClarifySeg] = useState(null);
  const [showCtrl, setShowCtrl] = useState(false);
  const [font, setFont] = useState(1);
  const [line, setLine] = useState(1.7);
  const [bright, setBright] = useState(1);
  const [col, setCol] = useState({ width: 0, pad: 0 });   // one column == one page

  const scrollRef = useRef(null);
  const segsRef = useRef([]);                              // latest segments for the stable loaders
  const moreRef = useRef({ before: false, after: false });
  const loadingRef = useRef(false);
  const pitchRef = useRef(0);                              // page width in px
  const snapRef = useRef(null);                            // debounce for snap-to-page

  useEffect(() => { segsRef.current = segments; }, [segments]);

  const fetchWindow = useCallback((t) => api('GET', `/api/books/${book.id}/sentences?around=${Math.max(0, t)}`), [book]);

  // Pull in the adjacent window and merge it; stop a direction only when the window
  // stops advancing (so a missing/incorrect has_next can never silently wall us off).
  const loadMore = useCallback(async (dir) => {
    const segs = segsRef.current;
    const m = moreRef.current;
    if (loadingRef.current || !segs.length) return 0;
    if (dir > 0 && !m.after) return 0;
    if (dir < 0 && !m.before) return 0;
    loadingRef.current = true;
    const el = scrollRef.current;
    const prevW = el ? el.scrollWidth : 0, prevL = el ? el.scrollLeft : 0;
    let added = 0;
    try {
      const anchor = dir > 0 ? segs[segs.length - 1].end + 0.05 : Math.max(0, segs[0].start - 0.05);
      const d = await fetchWindow(anchor);
      const map = new Map(segs.map((s) => [Math.round(s.start * 100), s]));
      for (const s of (d.segments || [])) map.set(Math.round(s.start * 100), s);
      const merged = [...map.values()].sort((a, b) => a.start - b.start);
      added = merged.length - segs.length;
      if (added > 0) {
        setSegments(merged);
        if (dir > 0) moreRef.current = { before: m.before, after: d.has_next ?? true };
        else {
          moreRef.current = { before: d.has_prev ?? true, after: m.after };
          if (el) requestAnimationFrame(() => { el.scrollLeft = prevL + (el.scrollWidth - prevW); });
        }
      } else {
        moreRef.current = dir > 0 ? { ...m, after: false } : { ...m, before: false }; // exhausted
      }
    } catch { /* leave as-is, retry on next scroll */ }
    finally { loadingRef.current = false; }
    return added;
  }, [fetchWindow]);

  // Initial window around the saved position + reading prefs.
  useEffect(() => {
    if (!book) return;
    loadingRef.current = true;
    const around = usePlayer.getState().book?.progress_sec || 0;
    api('GET', `/api/books/${book.id}/sentences?around=${Math.max(0, around)}`).then((d) => {
      setSegments(d.segments || []);
      moreRef.current = { before: d.has_prev ?? false, after: d.has_next ?? true };
    }).catch(() => {}).finally(() => { loadingRef.current = false; });
    api('GET', '/api/settings').then((s) => {
      if (s.reader_font_scale) setFont(s.reader_font_scale);
      if (s.reader_line_spacing) setLine(s.reader_line_spacing);
      if (s.reader_brightness != null) setBright(s.reader_brightness);
    }).catch(() => {});
  }, [book]);

  // One column == the full page width (so each swipe/arrow is exactly one page).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const pad = Math.max(20, Math.round(w * 0.07));
      setCol({ width: Math.max(120, w - pad * 2), pad });
      pitchRef.current = w; // content + 2·pad == clientWidth
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!book) return null;

  const savePref = (patch) => api('PUT', '/api/settings', patch).catch(() => {});

  // Snap to the nearest whole page once a free swipe/scroll settles (CSS scroll-snap can't
  // target multicol columns, so we do it in JS).
  const snapToPage = () => {
    const el = scrollRef.current;
    const pitch = pitchRef.current;
    if (!el || !pitch || loadingRef.current) return;
    const target = Math.round(el.scrollLeft / pitch) * pitch;
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollTo({ left: target, behavior: scrollBehavior() });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pitch = pitchRef.current || el.clientWidth;
    if (el.scrollLeft + el.clientWidth >= el.scrollWidth - pitch * 0.8) loadMore(1);
    else if (el.scrollLeft <= pitch * 0.8) loadMore(-1);
    if (snapRef.current) clearTimeout(snapRef.current);
    snapRef.current = setTimeout(snapToPage, 110);
  };

  const page = async (dir) => {
    const el = scrollRef.current;
    if (!el) return;
    const pitch = pitchRef.current || el.clientWidth;
    if (dir > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - pitch * 0.5) await loadMore(1);
    if (dir < 0 && el.scrollLeft <= pitch * 0.5) await loadMore(-1);
    el.scrollBy({ left: dir * pitch, behavior: scrollBehavior() });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 18 }}
      transition={{ type: 'spring', stiffness: 280, damping: 30 }}
      className="fixed inset-0 z-50 bg-background flex flex-col">

      {/* header */}
      <div className="flex items-center gap-1 px-4 py-3 border-b border-border z-10">
        <button onClick={closeReader} title="Close reader" aria-label="Close reader"
          className="w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
        </button>
        <ThemeLamp />
        <div className="flex-1 min-w-0 text-center px-2">
          <div className="font-body font-bold text-foreground truncate">{book.title}</div>
          <div className="text-xs text-muted-foreground">{langName(book.source_lang)} → {langName(book.target_lang)}</div>
        </div>
        <IconBtn title="Ask about this book" onClick={openChat}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>
        </IconBtn>
        <div className="relative">
          <IconBtn title="Reading settings" active={showCtrl} onClick={() => setShowCtrl((v) => !v)}>
            <span className="font-display text-lg leading-none">Aa</span>
          </IconBtn>
          <AnimatePresence>
            {showCtrl && (
              <motion.div initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 360, damping: 28 }}
                className="absolute right-0 mt-2 w-64 rounded-xl bg-card border border-border shadow-2xl p-4 z-20 space-y-4">
                <Stepper label="Text size" value={`${Math.round(font * 100)}%`}
                  onDown={() => { const v = Math.max(0.8, +(font - 0.1).toFixed(2)); setFont(v); savePref({ reader_font_scale: v }); }}
                  onUp={() => { const v = Math.min(1.8, +(font + 0.1).toFixed(2)); setFont(v); savePref({ reader_font_scale: v }); }} />
                <Stepper label="Line spacing" value={line.toFixed(1)}
                  onDown={() => { const v = Math.max(1.3, +(line - 0.1).toFixed(1)); setLine(v); savePref({ reader_line_spacing: v }); }}
                  onUp={() => { const v = Math.min(2.4, +(line + 0.1).toFixed(1)); setLine(v); savePref({ reader_line_spacing: v }); }} />
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">Brightness</div>
                  <input type="range" min={0.3} max={1} step={0.05} value={bright}
                    onChange={(e) => { const v = +e.target.value; setBright(v); savePref({ reader_brightness: v }); }}
                    className="w-full accent-[var(--primary)] cursor-pointer" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* paginated text — one column per page */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={onScroll} className="h-full mx-auto w-full max-w-[44rem] overflow-x-auto overflow-y-hidden py-10"
          style={{ paddingLeft: col.pad, paddingRight: col.pad }}>
          <div className="h-full font-body text-foreground"
            style={{ columnWidth: col.width ? `${col.width}px` : '30rem', columnGap: `${col.pad * 2}px`, columnFill: 'auto', fontSize: `${(1.15 * font).toFixed(2)}rem`, lineHeight: line }}>
            {segments.length === 0
              ? <p className="text-muted-foreground">No text available yet.</p>
              : segments.map((s, i) => (
                  <span key={i} onClick={() => setClarifySeg(s)} title="Tap to clarify"
                    className="cursor-pointer rounded transition-colors hover:bg-accent/50 hover:shadow-[inset_2px_0_0_var(--primary)] px-0.5">
                    {s.text}{' '}
                  </span>
                ))}
          </div>
        </div>

        {/* page arrows (desktop) */}
        <button onClick={() => page(-1)} aria-label="Previous page"
          className="hidden md:flex absolute left-2 top-1/2 -translate-y-1/2 w-11 h-11 items-center justify-center rounded-full bg-card/80 border border-border text-muted-foreground hover:text-primary backdrop-blur transition">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button onClick={() => page(1)} aria-label="Next page"
          className="hidden md:flex absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 items-center justify-center rounded-full bg-card/80 border border-border text-muted-foreground hover:text-primary backdrop-blur transition">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>

        {/* brightness dimmer */}
        {bright < 1 && <div className="absolute inset-0 bg-black pointer-events-none" style={{ opacity: 1 - bright }} />}
      </div>

      <AnimatePresence>
        {clarifySeg && (
          <ClarifySheet bookId={book.id} seg={clarifySeg}
            onClose={() => setClarifySeg(null)} onPlayLine={(t) => playFrom(t)} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Stepper({ label, value, onDown, onUp }) {
  const btn = 'w-8 h-8 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-primary hover:border-primary transition';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">{label}</div>
      <div className="flex items-center gap-3">
        <button onClick={onDown} className={btn} aria-label={`${label} smaller`}>−</button>
        <span className="flex-1 text-center text-sm text-foreground tabular-nums">{value}</span>
        <button onClick={onUp} className={btn} aria-label={`${label} larger`}>+</button>
      </div>
    </div>
  );
}
