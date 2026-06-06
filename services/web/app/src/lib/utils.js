import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn's class-name helper: merge conditional + Tailwind classes without conflicts.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// Honor "reduce motion" for programmatic scrolls (scrollTo/scrollIntoView ignore the CSS rule).
export const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export const scrollBehavior = () => (reduceMotion() ? 'auto' : 'smooth');
