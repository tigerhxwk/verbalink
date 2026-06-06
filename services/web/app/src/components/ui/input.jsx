import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

// shadcn-style Input, themed to Solar Dusk.
export const Input = forwardRef(({ className, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-11 w-full rounded-md border border-input bg-background px-3.5 py-2 text-base text-foreground',
      'placeholder:text-muted-foreground outline-none transition-[border-color,box-shadow]',
      'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
