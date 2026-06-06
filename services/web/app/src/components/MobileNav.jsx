import { cn } from '../lib/utils';
import ThemeLamp from './ThemeLamp';
import Logo from './Logo';

const HomeIcon = (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
const LibIcon = (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>;
const ColIcon = (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
const GearIcon = (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;

const TABS = [
  { id: 'dashboard', label: 'Home', Icon: HomeIcon },
  { id: 'library', label: 'Library', Icon: LibIcon },
  { id: 'collections', label: 'Collections', Icon: ColIcon },
  { id: 'settings', label: 'Settings', Icon: GearIcon },
];

export default function MobileNav({ page, setPage, onAdd, className }) {
  return (
    <>
      {/* top bar */}
      <header className={cn('flex items-center gap-2 px-4 h-14 border-b border-border bg-card sticky top-0 z-30', className)}>
        <Logo className="w-6 h-6 shrink-0" />
        <span className="font-display text-xl text-foreground flex-1">Verbalink</span>
        <ThemeLamp />
        <button onClick={onAdd} aria-label="Add book"
          className="w-9 h-9 flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:brightness-110 transition">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </header>

      {/* bottom tab bar */}
      <nav className={cn('fixed bottom-0 inset-x-0 z-30 flex border-t border-border bg-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)]', className)}>
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setPage(id)}
            className={cn('flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] transition-colors',
              page === id ? 'text-primary' : 'text-muted-foreground')}>
            <Icon width="22" height="22" />
            <span className="text-[11px] font-medium">{label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
