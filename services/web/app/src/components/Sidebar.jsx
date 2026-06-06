import { useStore } from '../store';
import { api } from '../api';
import { cn } from '../lib/utils';
import ThemeLamp from './ThemeLamp';
import Logo from './Logo';

const NAV = [
  { id: 'dashboard', label: 'Home' },
  { id: 'library', label: 'Library' },
  { id: 'collections', label: 'Collections' },
];

export default function Sidebar({ page, setPage, onAdd, className }) {
  const { user, setUser } = useStore();
  async function logout() { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } setUser(null); }

  return (
    <nav className={cn('w-56 shrink-0 flex flex-col border-r border-border bg-card', className)}>
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-border">
        <Logo className="w-7 h-7 shrink-0" />
        <span className="font-display text-2xl text-foreground">Verbalink</span>
      </div>

      <div className="flex-1 p-2.5 space-y-1">
        <button onClick={onAdd}
          className="w-full mb-2 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add book
        </button>
        {NAV.map((n) => (
          <button key={n.id} onClick={() => setPage(n.id)}
            className={cn('w-full text-left px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
              page === n.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/40')}>
            {n.label}
          </button>
        ))}
      </div>

      <div className="p-3 border-t border-border flex items-center gap-1">
        <span className="flex-1 text-sm text-muted-foreground truncate px-1">{user?.username}</span>
        <ThemeLamp />
        <button onClick={() => setPage('settings')} title="Settings" aria-label="Settings"
          className={cn('w-9 h-9 flex items-center justify-center rounded-md transition-colors',
            page === 'settings' ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button onClick={logout} title="Sign out" aria-label="Sign out"
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive transition-colors">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    </nav>
  );
}
