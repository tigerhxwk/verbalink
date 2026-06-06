import { motion } from 'framer-motion';
import { bookGradient, bookInitial } from '../lib/cover';
import { langName } from '../lib/lang';

export default function BookCard({ book, onOpen }) {
  const pct = book.duration_sec ? Math.round((book.progress_sec || 0) / book.duration_sec * 100) : 0;
  const processing = book.transcription_status === 'processing';
  return (
    <motion.button
      type="button"
      whileHover={{ y: -3 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      onClick={() => onOpen?.(book)}
      className="text-left rounded-lg overflow-hidden bg-card border border-border hover:border-primary/60 transition-colors"
    >
      <div className="relative aspect-[3/4] flex items-center justify-center" style={{ background: bookGradient(book.title) }}>
        <span className="font-display text-5xl text-white/90 select-none">{bookInitial(book.title)}</span>
        {processing && (
          <span className="absolute bottom-2 left-2 right-2 text-center text-[11px] text-white/90 bg-black/45 rounded py-1">transcribing…</span>
        )}
        {!processing && pct > 0 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/30"><div className="h-full bg-primary" style={{ width: pct + '%' }} /></div>
        )}
      </div>
      <div className="p-3">
        <div className="font-body font-bold text-sm leading-snug line-clamp-2 text-foreground">{book.title}</div>
        <div className="text-xs text-muted-foreground mt-1 truncate">{book.author || langName(book.source_lang)}</div>
      </div>
    </motion.button>
  );
}
