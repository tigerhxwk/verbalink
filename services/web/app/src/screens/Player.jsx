import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { bookGradient, bookInitial } from '../lib/cover';
import { LANG, langName } from '../lib/lang';
import { cn } from '../lib/utils';
import { api } from '../api';
import { usePlayer } from '../player';
import Transcript from '../components/Transcript';
import ClarifySheet from '../components/ClarifySheet';
import ThemeLamp from '../components/ThemeLamp';

const fmt = (s) => { s = Math.max(0, s | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`; };
const idxAt = (segments, t) => { let i = -1; for (let k = 0; k < segments.length; k++) { if (segments[k].start <= t) i = k; else break; } return i; };

function TBtn({ children, label, onClick, title }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className="relative w-12 h-12 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
      {children}
      {label && <span className="absolute bottom-0.5 text-[11px] font-bold">{label}</span>}
    </button>
  );
}
function IconBtn({ children, title, onClick }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className="w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-primary hover:bg-accent/40 transition-colors">
      {children}
    </button>
  );
}
function Equalizer() {
  return (
    <div className="absolute bottom-2 right-2 flex items-end gap-[3px] h-4">
      {[0, 1, 2, 3].map((i) => (
        // scaleY (GPU transform) instead of animating height → no per-frame layout/paint
        <motion.span key={i} className="w-1 h-4 rounded-sm bg-white/90 origin-bottom"
          animate={{ scaleY: [0.28, 1, 0.4, 0.85, 0.28] }}
          transition={{ duration: 0.85 + i * 0.18, repeat: Infinity, ease: 'easeInOut' }} style={{ scaleY: 0.28 }} />
      ))}
    </div>
  );
}

// Cover + equalizer as a leaf: subscribes to playing/deckMoving itself, so pausing the loops
// while the deck slides re-renders ONLY this — never the deck (which would re-measure → 2-step).
function Cover({ book }) {
  const playing = usePlayer((s) => s.playing);
  const moving = usePlayer((s) => s.deckMoving);
  const live = playing && !moving;
  return (
    <motion.div animate={{ scale: live ? [1, 1.015, 1] : 1 }}
      transition={{ duration: 3.6, repeat: live ? Infinity : 0, ease: 'easeInOut' }}
      className="relative w-40 h-40 rounded-2xl flex items-center justify-center mb-5 shadow-xl border border-border"
      style={{ background: bookGradient(book.title) }}>
      <span className="font-display text-6xl text-white/90 select-none">{bookInitial(book.title)}</span>
      {live && <Equalizer />}
    </motion.div>
  );
}

// Isolated `cur` subscriber so the rest of the deck doesn't re-render ~4×/sec.
function SeekRow({ dur, seekTo }) {
  const cur = usePlayer((s) => s.cur);
  return (
    <>
      <input type="range" min={0} max={dur || 0} step={0.1} value={Math.min(cur, dur || 0)} onChange={(e) => seekTo(+e.target.value)}
             className="w-full accent-[var(--primary)] cursor-pointer" />
      <div className="flex justify-between w-full text-sm text-muted-foreground mb-5 tabular-nums"><span>{fmt(cur)}</span><span>{fmt(dur)}</span></div>
    </>
  );
}

// Karaoke transcript — subscribes to cur/maxRead itself so toggling it doesn't re-render the deck.
function LiveTranscript({ segments, blur, onClose, onClarify, onPlay }) {
  const cur = usePlayer((s) => s.cur);
  const maxRead = usePlayer((s) => s.maxRead);
  const activeIdx = idxAt(segments, cur);
  const readIdx = idxAt(segments, maxRead);
  return (
    <Transcript segments={segments} activeIdx={activeIdx} readIdx={readIdx} blur={blur}
      className="w-full max-w-3xl h-[85vh]" onClose={onClose} onClarify={onClarify} onPlay={onPlay} />
  );
}

export default function Player() {
  // Selective subscriptions — NOT `cur`, so the deck (with its layout animation) is stable.
  const book = usePlayer((s) => s.book);
  const playing = usePlayer((s) => s.playing);
  const dur = usePlayer((s) => s.dur);
  const speed = usePlayer((s) => s.speed);
  const vol = usePlayer((s) => s.vol);
  const toggle = usePlayer((s) => s.toggle);
  const seekTo = usePlayer((s) => s.seekTo);
  const playFrom = usePlayer((s) => s.playFrom);
  const skip = usePlayer((s) => s.skip);
  const setRate = usePlayer((s) => s.setRate);
  const setVolume = usePlayer((s) => s.setVolume);
  const collapse = usePlayer((s) => s.collapse);
  const openChat = usePlayer((s) => s.openChat);
  const openReader = usePlayer((s) => s.openReader);
  const openEssay = usePlayer((s) => s.openEssay);

  const [tgt, setTgt] = useState(book?.target_lang || 'en');
  const [segments, setSegments] = useState([]);
  const [showTranscript, setShowTranscript] = useState(false);
  const [blur, setBlur] = useState(true);
  const [clarifySeg, setClarifySeg] = useState(null);
  const winRef = useRef({ start: 0, end: 0, hasPrev: false, hasNext: false });
  const loadingRef = useRef(false);

  // Transcript windowing: load around the *actual* position and re-load as playback
  // crosses the loaded window — otherwise the transcript is stuck at the book's start
  // and disagrees with what chat/clarify report.
  useEffect(() => {
    if (!book) return;
    api('GET', '/api/settings').then((s) => setBlur(!!s.blur_unread)).catch(() => {});

    const loadWindow = (around) => {
      loadingRef.current = true;
      api('GET', `/api/books/${book.id}/sentences?around=${around}`)
        .then((d) => {
          setSegments(d.segments || []);
          winRef.current = { start: d.window_start_sec || 0, end: d.window_end_sec || 0, hasPrev: !!d.has_prev, hasNext: !!d.has_next };
        })
        .catch(() => {})
        .finally(() => { loadingRef.current = false; });
    };

    loadWindow(usePlayer.getState().cur || book.progress_sec || 0);

    const unsub = usePlayer.subscribe((s) => {
      if (loadingRef.current) return;
      const w = winRef.current;
      if ((w.hasNext && s.cur > w.end - 8) || (w.hasPrev && s.cur < w.start + 2)) loadWindow(s.cur);
    });
    return unsub;
  }, [book]);

  if (!book) return null;

  const changeTgt = (v) => { setTgt(v); api('PUT', `/api/books/${book.id}/settings`, { target_lang: v }).catch(() => {}); };
  const clarifyLine = (seg) => { if (seg) setClarifySeg(seg); };
  const clarifyCurrent = () => { const i = idxAt(segments, usePlayer.getState().cur); clarifyLine(segments[Math.max(0, i)] || segments[0]); };
  const prevLine = () => { const i = idxAt(segments, usePlayer.getState().cur); if (i > 0) playFrom(segments[i - 1].start); };
  const nextLine = () => { const i = idxAt(segments, usePlayer.getState().cur); if (i >= 0 && i < segments.length - 1) playFrom(segments[i + 1].start); };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={(e) => { if (e.target === e.currentTarget) collapse(); }}
      className="fixed inset-0 z-50 flex items-center justify-center p-6 overflow-y-auto"
      style={{ backgroundColor: 'color-mix(in srgb, var(--background) 60%, transparent)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>

      <motion.div layout transition={{ type: 'spring', stiffness: 300, damping: 34 }}
        onLayoutAnimationStart={() => usePlayer.getState().setDeckMoving(true)}
        onLayoutAnimationComplete={() => usePlayer.getState().setDeckMoving(false)}
        className={cn('rounded-2xl bg-card border border-border shadow-2xl px-6 pt-4 pb-6',
          showTranscript ? 'absolute left-6 top-6 w-full max-w-xs z-10 hidden lg:block' : 'w-full max-w-md')}>

        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1">
            <button onClick={collapse} title="Minimize" aria-label="Minimize"
              className="w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
            </button>
            <ThemeLamp />
          </div>
          <div className="flex items-center gap-1">
            <IconBtn title="Ask about this book" onClick={openChat}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>
            </IconBtn>
            <IconBtn title="Practice essay" onClick={openEssay}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
            </IconBtn>
            <IconBtn title="Reading mode" onClick={openReader}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            </IconBtn>
            <IconBtn title="Transcript" onClick={() => setShowTranscript((v) => !v)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </IconBtn>
          </div>
        </div>

        <div className="flex flex-col items-center">
          <Cover book={book} />
          <h2 className="font-body font-bold text-xl text-center text-foreground leading-tight">{book.title}</h2>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2 mb-5">
            <span>{langName(book.source_lang)}</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            <select value={tgt} onChange={(e) => changeTgt(e.target.value)} title="Translate to"
              className="bg-popover text-foreground border border-border rounded-md px-2 py-1 text-sm outline-none focus:border-ring cursor-pointer">
              {Object.entries(LANG).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </div>
        </div>

        <SeekRow dur={dur} seekTo={seekTo} />

        <div className="flex flex-col items-center">
          <button onClick={clarifyCurrent}
            className="mb-4 inline-flex items-center gap-2 px-5 py-2 rounded-full border border-border text-base text-muted-foreground hover:text-primary hover:border-primary transition-colors">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            Clarify
          </button>
          <div className="flex items-center justify-center gap-3 mb-6">
            <TBtn label="line" title="Previous line" onClick={prevLine}>
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
            </TBtn>
            <TBtn label="15" title="Back 15s" onClick={() => skip(-15)}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </TBtn>
            <button onClick={toggle} aria-label="Play/Pause"
              className="w-16 h-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg hover:brightness-110 active:scale-95 transition">
              {playing
                ? <svg width="27" height="27" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                : <svg width="27" height="27" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>}
            </button>
            <TBtn label="15" title="Forward 15s" onClick={() => skip(15)}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </TBtn>
            <TBtn label="line" title="Next line" onClick={nextLine}>
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
            </TBtn>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3 text-[15px]">
            <span className="w-14 text-muted-foreground">Speed</span>
            <input type="range" min={0.5} max={2.5} step={0.05} value={speed} onChange={(e) => setRate(+e.target.value)} className="flex-1 accent-[var(--primary)] cursor-pointer" />
            <span className="w-12 text-right text-muted-foreground tabular-nums">{speed.toFixed(2).replace(/\.?0+$/, '')}×</span>
          </div>
          <div className="flex items-center gap-3 text-[15px]">
            <span className="w-14 text-muted-foreground">Volume</span>
            <input type="range" min={0} max={1} step={0.02} value={vol} onChange={(e) => setVolume(+e.target.value)} className="flex-1 accent-[var(--primary)] cursor-pointer" />
            <span className="w-12 text-right text-muted-foreground tabular-nums">{Math.round(vol * 100)}%</span>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {showTranscript && (
          <LiveTranscript segments={segments} blur={blur}
            onClose={() => setShowTranscript(false)} onClarify={clarifyLine} onPlay={(t) => playFrom(t)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {clarifySeg && (
          <ClarifySheet bookId={book.id} seg={clarifySeg}
            onClose={() => setClarifySeg(null)} onPlayLine={(t) => playFrom(t)} />
        )}
      </AnimatePresence>

    </motion.div>
  );
}
