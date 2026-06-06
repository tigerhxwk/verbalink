import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { streamPost } from '../api';
import { langName } from '../lib/lang';
import { cn } from '../lib/utils';
import { usePlayer } from '../player';

const RESUME_AFTER = 10; // seconds before playback auto-continues

// Speaker button that plays a base64 WAV (TTS), mutually exclusive via a shared ref.
function Speaker({ b64, ttsRef }) {
  const play = () => {
    if (!b64) return;
    if (ttsRef.current) { ttsRef.current.pause(); ttsRef.current = null; }
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const a = new Audio(URL.createObjectURL(new Blob([arr], { type: 'audio/wav' })));
    ttsRef.current = a; a.play().catch(() => {});
  };
  return (
    <button onClick={play} disabled={!b64} title="Listen"
      className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-primary hover:bg-accent/50 disabled:opacity-40 transition">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
    </button>
  );
}

// Streams /api/clarify/stream for a sentence: translation (meta) then explanation tokens.
// Re-runs when the mode (beginner/advanced) changes.
export default function ClarifySheet({ bookId, seg, onClose, onPlayLine }) {
  const [mode, setMode] = useState('advanced');
  const [orig, setOrig] = useState(seg?.text || '…');
  const [trans, setTrans] = useState('');
  const [expl, setExpl] = useState('');
  const [src, setSrc] = useState('');
  const [tgt, setTgt] = useState('');
  const [status, setStatus] = useState('Analyzing…');
  const [audioOrig, setAudioOrig] = useState(null);
  const [audioTrl, setAudioTrl] = useState(null);
  const [done, setDone] = useState(false);
  const ttsRef = useRef(null);

  // Pause playback while clarifying; remember whether we were listening so we can auto-resume.
  const [wasPlaying] = useState(() => usePlayer.getState().playing);
  const [cancelled, setCancelled] = useState(false);
  const [count, setCount] = useState(null); // null = no countdown running

  useEffect(() => { if (wasPlaying) usePlayer.getState().pause(); }, [wasPlaying]);

  // Resolve the sheet: optionally resume playback, then close.
  const finish = (resumePlay) => {
    if (resumePlay && wasPlaying) usePlayer.getState().resume();
    onClose();
  };
  const cancelResume = () => { setCancelled(true); setCount(null); };

  // Once the explanation finishes streaming, give the reader RESUME_AFTER seconds before continuing.
  useEffect(() => {
    if (done && wasPlaying && !cancelled && count === null) setCount(RESUME_AFTER);
  }, [done, wasPlaying, cancelled]);

  useEffect(() => {
    if (count === null) return;
    if (count <= 0) { finish(true); return; }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count]);

  useEffect(() => {
    let alive = true;
    setTrans(''); setExpl(''); setStatus('Analyzing…'); setOrig(seg?.text || '…'); setAudioOrig(null); setAudioTrl(null); setDone(false);
    const pos = seg ? (seg.start + seg.end) / 2 : 0;
    streamPost('/api/clarify/stream', { book_id: bookId, position_sec: pos, mode }, (ev) => {
      if (!alive) return;
      if (ev.type === 'meta') {
        setSrc(langName(ev.source_lang)); setTgt(langName(ev.target_lang));
        setOrig(ev.original_text); setTrans(ev.translated_text); setStatus('Explaining…');
        setAudioOrig(ev.audio_original || null); setAudioTrl(ev.audio_translated || null);
      } else if (ev.type === 'token') { setExpl((e) => e + ev.text); }
      else if (ev.type === 'done') { setStatus(''); setDone(true); }
    }).catch((err) => { if (alive) { setStatus('Error: ' + err.message); setDone(true); } });
    return () => { alive = false; if (ttsRef.current) { ttsRef.current.pause(); ttsRef.current = null; } };
  }, [bookId, seg, mode]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => finish(!cancelled)}
      className="absolute inset-0 z-20 flex items-center justify-center p-4 bg-black/40">
      <motion.div initial={{ y: 24, scale: 0.97, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[85%] rounded-2xl bg-card border border-border shadow-2xl flex flex-col">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          {src && <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--primary-dim)] text-primary">{src}</span>}
          {src && <span className="text-muted-foreground">→</span>}
          {tgt && <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--primary-dim)] text-primary">{tgt}</span>}
          <div className="ml-auto flex items-center gap-1 rounded-full bg-popover border border-border p-0.5">
            {['advanced', 'beginner'].map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={cn('px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors',
                  mode === m ? 'bg-[var(--primary-dim)] text-primary' : 'text-muted-foreground hover:text-foreground')}>
                {m}
              </button>
            ))}
          </div>
          <button onClick={() => finish(!cancelled)} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex items-start gap-2">
            <p className="font-body text-lg leading-relaxed text-foreground flex-1">{orig}</p>
            <Speaker b64={audioOrig} ttsRef={ttsRef} />
            {!wasPlaying && (
              <button onClick={() => { if (seg) onPlayLine(seg.start); onClose(); }} title="Play this line from the book"
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-sm hover:brightness-110 transition">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>Play line
              </button>
            )}
          </div>
          {trans && (
            <div className="flex items-start gap-2 mt-3">
              <p className="font-body text-lg leading-relaxed text-primary flex-1">{trans}</p>
              <Speaker b64={audioTrl} ttsRef={ttsRef} />
            </div>
          )}
          {expl && <p className="font-ui text-[15px] leading-relaxed text-muted-foreground whitespace-pre-wrap mt-4">{expl}</p>}
          {status && <div className="flex items-center gap-2 text-sm text-muted-foreground mt-3">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />{status}</div>}
        </div>

        {wasPlaying && (
          <div className="border-t border-border">
            {count !== null && (
              <motion.div className="h-0.5 w-full bg-primary origin-left" initial={{ scaleX: 1 }} animate={{ scaleX: 0 }} transition={{ duration: RESUME_AFTER, ease: 'linear' }} />
            )}
            <div className="flex items-center gap-3 px-5 py-3">
              <span className="text-sm text-muted-foreground">
                {count !== null ? `Resuming in ${count}s…` : 'Playback paused'}
              </span>
              {count !== null && (
                <button onClick={cancelResume} className="ml-auto px-4 py-1.5 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/40 transition">
                  Cancel
                </button>
              )}
              <button onClick={() => finish(true)}
                className={cn('inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-primary text-primary-foreground text-sm hover:brightness-110 transition', count === null && 'ml-auto')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>Resume
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
