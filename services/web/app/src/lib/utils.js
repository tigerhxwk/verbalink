import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn's class-name helper: merge conditional + Tailwind classes without conflicts.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
