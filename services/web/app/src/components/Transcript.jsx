import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { cn, scrollBehavior } from '../lib/utils';

// Wide transcript panel shown beside the player. Active line follows playback; lines past the
// furthest-listened point are blurred (spoiler protection) and clear on hover.
export default function Transcript({ segments, activeIdx, readIdx, blur, onClose, onClarify, onPlay, className }) {
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'center', behavior: scrollBehavior() }); }, [activeIdx]);

  return (
    <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className={cn('rounded-2xl bg-card border border-border shadow-2xl flex flex-col', className)}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <span className="font-body font-bold text-lg text-foreground">Transcript</span>
        <button onClick={onClose} aria-label="Close transcript"
          className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
        {segments.length === 0 && <div className="text-muted-foreground text-sm px-1">No transcript yet.</div>}
        {segments.map((s, i) => {
          const unread = blur && i > readIdx;
          return (
            <div key={s.id ?? i} ref={i === activeIdx ? activeRef : null}
              className={'group flex items-start gap-1 rounded-md transition-colors ' +
                (i === activeIdx ? 'bg-accent/60 shadow-[inset_3px_0_0_var(--primary)]' : 'hover:bg-accent/30')}>
              <button onClick={() => onClarify(s)} title="Clarify this line"
                className={'flex-1 text-left px-4 py-2.5 font-body text-lg leading-relaxed ' +
                  (i === activeIdx ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>
                <span className={unread ? 'blur-[3px] hover:blur-none select-none' : ''}>{s.text}</span>
              </button>
              <button onClick={() => onPlay(s.start)} title="Play from here"
                className="shrink-0 mt-2 mr-1 w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-primary hover:bg-accent/50 transition">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
              </button>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
