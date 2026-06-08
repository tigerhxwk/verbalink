import { useState } from 'react';
import { cn } from '../lib/utils';

// Star rating. Pass `onRate` to make it interactive (click a star to set, click it again to clear).
export default function Stars({ value = 0, onRate, size = 18, className }) {
  const [hover, setHover] = useState(0);
  const interactive = typeof onRate === 'function';
  return (
    <div className={cn('inline-flex items-center gap-0.5', className)} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = (hover || value) >= n;
        return (
          <button key={n} type="button" disabled={!interactive}
            onMouseEnter={() => interactive && setHover(n)}
            onClick={() => onRate?.(n === value ? 0 : n)}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            className={cn('transition-colors', interactive ? 'cursor-pointer hover:text-primary' : 'cursor-default',
              filled ? 'text-primary' : 'text-muted-foreground/35')}>
            <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </button>
        );
      })}
    </div>
  );
}
