import { motion } from 'framer-motion';
import { usePlayer } from '../player';
import { bookGradient, bookInitial } from '../lib/cover';
import { langName } from '../lib/lang';

export default function MiniPlayer() {
  const { book, playing, cur, dur, expand, toggle, close } = usePlayer();
  if (!book) return null;
  const pct = dur ? (cur / dur) * 100 : 0;

  return (
    <motion.div initial={{ y: 90 }} animate={{ y: 0 }} exit={{ y: 90 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="fixed bottom-14 md:bottom-0 left-0 right-0 md:left-56 z-40 bg-card/90 backdrop-blur border-t border-border">
      <div className="h-0.5 bg-border"><div className="h-full bg-primary" style={{ width: pct + '%' }} /></div>
      <div className="flex items-center gap-3 px-4 py-2.5 cursor-pointer" onClick={expand} title="Expand player">
        <div className="w-10 h-10 rounded-md flex items-center justify-center shrink-0" style={{ background: bookGradient(book.title) }}>
          <span className="font-display text-lg text-white/90">{bookInitial(book.title)}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-body font-bold text-sm text-foreground truncate">{book.title}</div>
          <div className="text-xs text-muted-foreground truncate">{langName(book.source_lang)} → {langName(book.target_lang)}</div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); toggle(); }} aria-label="Play/Pause"
          className="w-10 h-10 flex items-center justify-center rounded-full bg-primary text-primary-foreground shrink-0 hover:brightness-110 transition">
          {playing
            ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>}
        </button>
        <button onClick={(e) => { e.stopPropagation(); close(); }} aria-label="Close" title="Stop"
          className="w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground hover:text-destructive shrink-0 transition">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
        </button>
      </div>
    </motion.div>
  );
}
