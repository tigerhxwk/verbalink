import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { useStore } from '../store';
import { cn } from '../lib/utils';

function Card({ title, desc, children }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <h2 className="font-body font-bold text-lg text-foreground">{title}</h2>
      {desc && <p className="text-sm text-muted-foreground mt-0.5">{desc}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[15px] text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ on, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={cn('relative w-12 h-7 rounded-full transition-colors shrink-0', on ? 'bg-primary' : 'bg-border')}>
      <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className={cn('absolute top-1 w-5 h-5 rounded-full bg-white shadow', on ? 'left-6' : 'left-1')} />
    </button>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="inline-flex rounded-full bg-popover border border-border p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={cn('px-3 py-1.5 rounded-full text-sm font-medium capitalize transition-colors min-w-[56px]',
            value === o.value ? 'bg-[var(--primary-dim)] text-primary' : 'text-muted-foreground hover:text-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Settings({ setPage }) {
  const { user, theme, setTheme, setUser } = useStore();
  const [s, setS] = useState(null);

  useEffect(() => { api('GET', '/api/settings').then(setS).catch(() => setS({})); }, []);

  const save = (patch) => { setS((cur) => ({ ...cur, ...patch })); api('PUT', '/api/settings', patch).catch(() => {}); };
  const pickTheme = (t) => { setTheme(t); api('PUT', '/api/settings', { theme: t }).catch(() => {}); };
  async function logout() { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } setUser(null); }

  return (
    <main className="flex-1 overflow-y-auto">
      <header className="px-5 sm:px-8 pt-6 sm:pt-8 pb-5 border-b border-border">
        <h1 className="font-body font-bold text-2xl sm:text-3xl text-foreground">Settings</h1>
      </header>

      <div className="p-5 sm:p-8 pb-24 md:pb-8 max-w-2xl space-y-5">
        <Card title="Appearance">
          <Row label="Theme" hint="System follows your device.">
            <Segmented value={theme} onChange={pickTheme}
              options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </Row>
        </Card>

        <Card title="Reading" desc="How transcripts and the reader behave.">
          <Row label="Spoiler protection" hint="Blur lines you haven't reached yet.">
            <Switch on={!!s?.blur_unread} onChange={(v) => save({ blur_unread: v })} />
          </Row>
        </Card>

        <Card title="Practice essays" desc="Periodic recap essays as you listen.">
          <Row label="Enable essays">
            <Switch on={!!s?.essay_enabled} onChange={(v) => save({ essay_enabled: v })} />
          </Row>
          {s?.essay_enabled && (
            <Row label="Every" hint="Minimum 5 minutes.">
              <div className="inline-flex items-center gap-2">
                <button onClick={() => save({ essay_interval_min: Math.max(5, (s?.essay_interval_min || 30) - 5) })}
                  className="w-8 h-8 rounded-lg border border-border text-muted-foreground hover:text-primary hover:border-primary transition">−</button>
                <span className="w-16 text-center text-sm text-foreground tabular-nums">{s?.essay_interval_min || 30} min</span>
                <button onClick={() => save({ essay_interval_min: Math.min(120, (s?.essay_interval_min || 30) + 5) })}
                  className="w-8 h-8 rounded-lg border border-border text-muted-foreground hover:text-primary hover:border-primary transition">+</button>
              </div>
            </Row>
          )}
        </Card>

        <Card title="Membership" desc="Voice quality, monthly credits and processing priority.">
          <button onClick={() => setPage?.('membership')}
            className="w-full flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 hover:border-primary/60 transition">
            <span className="text-[15px] text-foreground">View plans & your current tier</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </Card>

        <Card title="Account">
          <Row label="Signed in as" hint={user?.is_admin ? 'Administrator' : 'Reader'}>
            <span className="text-[15px] font-medium text-foreground">{user?.username}</span>
          </Row>
          <button onClick={logout}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-destructive hover:border-destructive/50 transition">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Sign out
          </button>
        </Card>
      </div>
    </main>
  );
}
