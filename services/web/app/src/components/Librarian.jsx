import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, streamPost } from '../api';
import { renderMarkdown } from '../lib/markdown';
import { cn, scrollBehavior } from '../lib/utils';

const SUGGESTIONS = [
  'Recommend something new to read',
  'What have I been reading lately?',
  'Where did I read about guilt?',
];

function Bubble({ role, text }) {
  const base = 'max-w-[88%] rounded-xl px-3.5 py-2.5 text-[15px] leading-relaxed';
  if (role === 'user') return <div className={base + ' self-end bg-popover text-foreground'}>{text}</div>;
  return <div className={base + ' self-start border border-border text-muted-foreground md'} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

export default function Librarian() {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { api('GET', '/api/librarian').then((d) => setMsgs(d.messages || [])).catch(() => {}); }, []);
  useEffect(() => { if (open) scrollRef.current?.scrollTo({ top: 1e9, behavior: scrollBehavior() }); }, [msgs, open]);

  async function send(text) {
    text = (text ?? input).trim();
    if (!text || busy) return;
    setOpen(true); setInput('');
    setMsgs((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setBusy(true);
    let raw = '';
    try {
      await streamPost('/api/librarian/stream', { message: text }, (ev) => {
        if (ev.type === 'token') { raw += ev.text; setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: raw }; return c; }); }
      });
    } catch (e) {
      setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: 'Error: ' + e.message }; return c; });
    } finally { setBusy(false); }
  }

  async function clear() {
    try { await api('DELETE', '/api/librarian'); } catch { /* ignore */ }
    setMsgs([]); setOpen(false);
  }

  const hasChat = msgs.length > 0;

  return (
    <section className="rounded-2xl border border-border bg-gradient-to-br from-card to-card/40 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-9 h-9 rounded-full bg-[var(--primary-dim)] text-primary flex items-center justify-center shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-body font-bold text-foreground">Your Librarian</div>
          <div className="text-xs text-muted-foreground">Recommendations & finding things across your library</div>
        </div>
        {hasChat && (
          <button onClick={() => setOpen((v) => !v)} className="text-sm text-muted-foreground hover:text-foreground transition px-2 py-1">
            {open ? 'Hide' : 'Show'}
          </button>
        )}
        {hasChat && (
          <button onClick={clear} title="Clear conversation" aria-label="Clear conversation"
            className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive transition">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {hasChat && open && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: 'easeOut' }} className="overflow-hidden">
            <div ref={scrollRef} className="px-5 pb-3 max-h-[42vh] overflow-y-auto flex flex-col gap-2.5">
              {msgs.map((m, i) => <Bubble key={i} role={m.role} text={m.content} />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!hasChat && (
        <div className="px-5 pb-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => send(s)}
              className="px-3 py-1.5 rounded-full border border-border text-xs text-muted-foreground hover:text-primary hover:border-primary transition">
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
          placeholder="Ask your librarian…" autoComplete="off"
          className="flex-1 bg-popover text-foreground border border-border rounded-lg px-3 py-2 text-[15px] outline-none focus:border-ring" />
        <button onClick={() => send()} disabled={busy} aria-label="Send"
          className={cn('w-10 h-10 shrink-0 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:brightness-110 disabled:opacity-50 transition')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/></svg>
        </button>
      </div>
    </section>
  );
}
