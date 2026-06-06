import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, streamPost } from '../api';
import { usePlayer } from '../player';
import { renderMarkdown } from '../lib/markdown';

function Bubble({ role, text }) {
  const base = 'max-w-[85%] rounded-xl px-3.5 py-2.5 text-[15px] leading-relaxed';
  if (role === 'user') return <div className={base + ' self-end bg-popover text-foreground'}>{text}</div>;
  return <div className={base + ' self-start border border-border text-muted-foreground md'} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

export default function ChatWidget() {
  // Selective subscriptions — avoid re-rendering on the ~4Hz `cur` tick (we read cur lazily on send).
  const book = usePlayer((s) => s.book);
  const chatOpen = usePlayer((s) => s.chatOpen);
  const openChat = usePlayer((s) => s.openChat);
  const closeChat = usePlayer((s) => s.closeChat);
  // The full player and the reader each have their own chat button, so the floating
  // bubble would duplicate it there — only show the FAB from the dashboard / mini-bar.
  const expanded = usePlayer((s) => s.expanded);
  const readerOpen = usePlayer((s) => s.readerOpen);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const loadedFor = useRef(null);
  const scrollRef = useRef(null);

  // load this book's history once it's opened
  useEffect(() => {
    if (!book || !chatOpen || loadedFor.current === book.id) return;
    loadedFor.current = book.id;
    api('GET', `/api/chat/${book.id}`).then((d) => setMsgs(d.messages || [])).catch(() => setMsgs([]));
  }, [book, chatOpen]);

  // Pin to bottom instantly — smooth-scrolling on every streamed token fights itself and looks ragged.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 1e9 }); }, [msgs]);

  if (!book) return null;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setBusy(true);
    let raw = '';
    try {
      await streamPost('/api/chat/stream', { book_id: book.id, message: text, position_sec: usePlayer.getState().cur }, (ev) => {
        if (ev.type === 'token') { raw += ev.text; setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: raw }; return c; }); }
      });
    } catch (e) {
      setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: 'Error: ' + e.message }; return c; });
    } finally { setBusy(false); }
  }

  return (
    <>
      <AnimatePresence>
        {chatOpen && (
          <motion.div initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="fixed bottom-32 md:bottom-4 right-2 sm:right-4 z-[60] w-[360px] max-w-[calc(100vw-1rem)] h-[460px] max-h-[calc(100dvh-10rem)] rounded-2xl bg-card border border-border shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="font-body font-bold text-foreground">Chat</span>
              <button onClick={closeChat} aria-label="Minimize chat" className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2.5">
              {msgs.length === 0 && <div className="text-sm text-muted-foreground m-auto text-center px-4">Ask anything about this book.</div>}
              {msgs.map((m, i) => <Bubble key={i} role={m.role} text={m.content} />)}
            </div>
            <div className="flex items-center gap-2 px-3 py-3 border-t border-border">
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
                placeholder="Ask about this book…" autoComplete="off"
                className="flex-1 bg-popover text-foreground border border-border rounded-lg px-3 py-2 text-[15px] outline-none focus:border-ring" />
              <button onClick={send} disabled={busy} aria-label="Send"
                className="w-10 h-10 shrink-0 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:brightness-110 disabled:opacity-50 transition">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/></svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!chatOpen && !expanded && !readerOpen && (
        <button onClick={openChat} aria-label="Chat about this book" title="Chat"
          className="fixed bottom-32 md:bottom-20 right-5 z-[55] w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-xl flex items-center justify-center hover:brightness-110 hover:-translate-y-0.5 transition">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>
        </button>
      )}
    </>
  );
}
