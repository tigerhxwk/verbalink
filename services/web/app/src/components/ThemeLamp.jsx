import { motion } from 'framer-motion';
import { useStore } from '../store';
import { cn } from '../lib/utils';

// A little reading lamp: glowing shade = light theme, dark shade = dark theme.
// Click toggles the light on/off (light ⇄ dark). System default applies until first click.
export default function ThemeLamp({ className = '' }) {
  useStore((s) => s.theme);   // re-render on theme change
  const resolved = (typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-theme')) || 'dark';
  const on = resolved === 'light';
  const setTheme = useStore((s) => s.setTheme);

  return (
    <button
      type="button"
      onClick={() => setTheme(on ? 'dark' : 'light')}
      aria-label={on ? 'Turn the lights off (dark theme)' : 'Turn the lights on (light theme)'}
      title={on ? 'Lights on — light theme' : 'Lights off — dark theme'}
      className={cn('relative w-10 h-10 flex items-center justify-center text-muted-foreground hover:text-primary transition', className)}
    >
      {/* warm glow under the shade */}
      <motion.span
        aria-hidden
        className="absolute pointer-events-none"
        animate={{ opacity: on ? 0.9 : 0, scale: on ? 1 : 0.6 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        style={{
          width: 36, height: 36, top: 9, borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 30%, var(--primary) 0%, transparent 65%)',
          filter: 'blur(3px)',
        }}
      />
      <svg className="relative" width="23" height="23" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {/* shade (fills amber when on), stem, base */}
        <path d="M7.5 3.5h9l2.2 6.5H5.3z" fill={on ? 'var(--primary)' : 'transparent'}
              stroke={on ? 'var(--primary)' : 'currentColor'} />
        <path d="M12 10v8.5" />
        <path d="M8.5 20.5h7" />
      </svg>
    </button>
  );
}
