import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { api, streamPost } from '../api';
import { langName } from '../lib/lang';

const fmt = (s) => { s = Math.max(0, s | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`; };

export default function EssaySheet({ bookId, positionSec, ranges, onClose }) {
  const [prompt, setPrompt] = useState('');
  const [essayId, setEssayId] = useState(null);
  const [tgt, setTgt] = useState('');
  const [text, setText] = useState('');
  const [review, setReview] = useState('');
  const [phase, setPhase] = useState('loading'); // loading | write | reviewing | done | error
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    api('POST', '/api/essay/prompt', { book_id: bookId, position_sec: positionSec, ranges })
      .then((d) => { setPrompt(d.prompt || ''); setEssayId(d.essay_id); setTgt(langName(d.target_lang)); setPhase('write'); })
      .catch((e) => { setPrompt('Could not generate a prompt: ' + e.message); setPhase('error'); });
    api('GET', `/api/books/${bookId}/essays`).then((rows) => setHistory(rows || [])).catch(() => {});
  }, [bookId]);

  async function submit() {
    if (!text.trim() || !essayId || phase === 'reviewing') return;
    setPhase('reviewing'); setReview('');
    let raw = '';
    try {
      await streamPost('/api/essay/submit/stream', { essay_id: essayId, book_id: bookId, essay_text: text }, (ev) => {
        if (ev.type === 'token') { raw += ev.text; setReview(raw); }
      });
      setPhase('done');
    } catch (e) { setReview('Error: ' + e.message); setPhase('done'); }
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}
      className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50">
      <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }} onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-2xl bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">

        <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          <h2 className="font-body font-bold text-lg text-foreground flex-1">Practice essay</h2>
          {history.length > 0 && (
            <button onClick={() => setShowHistory((v) => !v)} className="text-sm text-muted-foreground hover:text-foreground transition px-2 py-1">
              {showHistory ? 'Back' : `Past (${history.length})`}
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {showHistory ? (
            <div className="space-y-4">
              {history.map((h) => (
                <div key={h.id} className="rounded-lg border border-border p-4">
                  <div className="text-xs text-muted-foreground mb-1">at {fmt(h.position_sec)}</div>
                  <div className="text-sm text-foreground font-medium whitespace-pre-wrap">{h.prompt}</div>
                  {h.essay_text && <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap"><span className="text-foreground font-medium">You:</span> {h.essay_text}</p>}
                  {h.review && <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap border-l-2 border-primary/40 pl-3">{h.review}</p>}
                </div>
              ))}
            </div>
          ) : (
            <>
              {phase === 'loading' && <div className="flex items-center gap-2 text-sm text-muted-foreground"><span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />Writing your prompt…</div>}
              {phase !== 'loading' && (
                <div className="rounded-lg bg-[var(--primary-dim)] border border-primary/20 p-4 text-[15px] leading-relaxed text-foreground whitespace-pre-wrap">{prompt}</div>
              )}
              {(phase === 'write' || phase === 'reviewing' || phase === 'done') && (
                <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={phase !== 'write'}
                  placeholder={`Write your response${tgt ? ' in ' + tgt : ''}…`} rows={6}
                  className="w-full mt-4 bg-popover text-foreground border border-border rounded-lg px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-ring resize-y disabled:opacity-70" />
              )}
              {(review || phase === 'reviewing') && (
                <div className="mt-4">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">Tutor review</div>
                  <p className="text-[15px] leading-relaxed text-muted-foreground whitespace-pre-wrap">{review}
                    {phase === 'reviewing' && <span className="inline-block w-1.5 h-1.5 ml-1 rounded-full bg-primary animate-pulse align-middle" />}</p>
                </div>
              )}
            </>
          )}
        </div>

        {!showHistory && (
          <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
            {phase === 'done'
              ? <button onClick={onClose} className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition">Done</button>
              : <>
                  <button onClick={onClose} className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition">Skip</button>
                  <button onClick={submit} disabled={phase !== 'write' || !text.trim()}
                    className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 disabled:opacity-50 transition">
                    {phase === 'reviewing' ? 'Reviewing…' : 'Submit'}
                  </button>
                </>}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
