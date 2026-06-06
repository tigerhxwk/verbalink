import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { upload } from '../api';
import { LANG } from '../lib/lang';
import { cn } from '../lib/utils';

const ACCEPT = '.mp3,.m4a,.m4b,.aac,.ogg,.wav,.flac,.epub,.fb2,.txt,audio/*';

function LangSelect({ value, onChange, label }) {
  return (
    <label className="flex-1 min-w-0">
      <span className="block text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full bg-popover text-foreground border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-ring cursor-pointer">
        {Object.entries(LANG).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      </select>
    </label>
  );
}

export default function AddBook({ onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [src, setSrc] = useState('ru');
  const [tgt, setTgt] = useState('en');
  const [share, setShare] = useState(true);
  const [progress, setProgress] = useState(null); // null idle, 0..1 uploading
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [showShareHelp, setShowShareHelp] = useState(false);
  const inputRef = useRef(null);

  const busy = progress !== null;

  async function start() {
    if (!file || busy) return;
    setError(''); setProgress(0);
    try {
      await upload('/api/books', file, { source_lang: src, target_lang: tgt, share }, setProgress);
      onUploaded?.();
      onClose();
    } catch (e) { setError(e.message); setProgress(null); }
  }

  function pick(f) { if (f) { setFile(f); setError(''); } }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !busy && onClose()}
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50">
      <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }} onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-body font-bold text-lg text-foreground">Add a book</h2>
          <button onClick={() => !busy && onClose()} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
          </button>
        </div>

        <div className="px-5 py-5 overflow-y-auto space-y-5">
          {/* drop zone */}
          <div onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
            className={cn('rounded-xl border-2 border-dashed px-5 py-8 text-center cursor-pointer transition-colors',
              drag ? 'border-primary bg-[var(--primary-dim)]' : 'border-border hover:border-primary/60')}>
            <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
              onChange={(e) => pick(e.target.files?.[0])} />
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 text-primary"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            {file
              ? <div className="text-foreground font-medium break-all">{file.name}</div>
              : <div className="text-muted-foreground text-sm">Tap to choose, or drag a file here<br /><span className="text-xs">audio, EPUB, FB2 or TXT</span></div>}
          </div>

          {/* languages */}
          <div className="flex items-end gap-3">
            <LangSelect label="Book language" value={src} onChange={setSrc} />
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-muted-foreground mb-3"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            <LangSelect label="Translate to" value={tgt} onChange={setTgt} />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary)]" />
                <span className="text-sm text-muted-foreground">Share this book with the community library</span>
              </label>
              <button type="button" aria-label="What gets shared?" aria-expanded={showShareHelp}
                onClick={() => setShowShareHelp((v) => !v)}
                className="w-4 h-4 shrink-0 flex items-center justify-center rounded-full border border-border text-[10px] font-bold text-muted-foreground hover:text-primary hover:border-primary transition">?</button>
            </div>
            <AnimatePresence initial={false}>
              {showShareHelp && (
                <motion.p initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }} className="text-xs leading-relaxed text-muted-foreground">
                  <span className="block mt-2 rounded-lg bg-popover border border-border p-3">
                    Only the book's <strong className="text-foreground">catalog info</strong> is shared — title, author, genres,
                    synopsis, level and language — so other readers can discover it and get recommendations.
                    Your <strong className="text-foreground">audio, transcript and reading progress stay private.</strong>
                  </span>
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}

          {busy && (
            <div>
              <div className="h-2 rounded-full bg-border overflow-hidden">
                <div className="h-full w-full bg-primary origin-left transition-transform duration-150" style={{ transform: `scaleX(${progress})` }} />
              </div>
              <div className="text-xs text-muted-foreground mt-1.5">{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Processing — transcription will start shortly.'}</div>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
          <button onClick={() => !busy && onClose()} disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 transition">Cancel</button>
          <button onClick={start} disabled={!file || busy}
            className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 disabled:opacity-50 transition">Upload</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
