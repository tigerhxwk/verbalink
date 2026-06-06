import { useStore } from '../store';
import { cn } from '../lib/utils';

const TIERS = [
  { id: 'reader', name: 'Reader', plan: 'Free', engine: 'Piper', credits: '1,000', priority: 'Standard',
    blurb: 'Everything you need to listen, read and learn.',
    perks: ['Listen, read & transcripts', 'Clarify & chat', 'Practice essays', 'Voice short books (~200 min/mo)'] },
  { id: 'scholar', name: 'Scholar', plan: 'Next', engine: 'Kokoro', credits: '10,000', priority: 'Faster',
    blurb: 'More credits and a richer voice for serious study.',
    perks: ['Everything in Reader', 'Natural Kokoro voicing', 'Higher queue priority', '≈ 24 h of voicing / mo'] },
  { id: 'curator', name: 'Curator', plan: 'Premium', engine: 'F5/E2 + cloning', credits: 'Unlimited', priority: 'High',
    blurb: 'Unlimited voicing and voice cloning.',
    perks: ['Everything in Scholar', 'F5/E2 high-fidelity voicing', 'Voice cloning', 'Unlimited credits'] },
  { id: 'developer', name: 'Developer', plan: 'Staff', engine: 'F5/E2', credits: 'Unlimited', priority: 'Top',
    blurb: 'Top priority plus control-plane access.',
    perks: ['Everything in Curator', 'Top queue priority', 'Logs & user management', 'Database management'] },
];

export default function Membership({ setPage }) {
  const { user } = useStore();
  const current = user?.tier || (user?.is_admin ? 'developer' : 'reader');

  return (
    <main className="flex-1 overflow-y-auto">
      <header className="px-5 sm:px-8 pt-6 sm:pt-8 pb-5 border-b border-border">
        {setPage && (
          <button onClick={() => setPage('settings')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2 transition">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Settings
          </button>
        )}
        <h1 className="font-body font-bold text-2xl sm:text-3xl text-foreground">Membership</h1>
        <p className="text-sm text-muted-foreground mt-1">Your plan determines voice quality, monthly credits and processing priority.</p>
      </header>

      <div className="p-5 sm:p-8 pb-24 md:pb-8">
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {TIERS.map((t) => {
            const isCurrent = t.id === current;
            return (
              <div key={t.id}
                className={cn('relative rounded-2xl border bg-card p-5 flex flex-col',
                  isCurrent ? 'border-primary ring-1 ring-primary' : 'border-border')}>
                {isCurrent && <span className="absolute -top-2.5 left-5 px-2.5 py-0.5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold uppercase tracking-wide">Current</span>}
                <div className="text-xs text-muted-foreground uppercase tracking-wide">{t.plan}</div>
                <div className="font-display text-2xl text-foreground mt-0.5">{t.name}</div>
                <p className="text-sm text-muted-foreground mt-1 min-h-[40px]">{t.blurb}</p>

                <div className="grid grid-cols-2 gap-2 my-4 text-center">
                  <div className="rounded-lg bg-popover py-2">
                    <div className="text-[11px] text-muted-foreground">Credits / mo</div>
                    <div className="text-sm font-bold text-foreground tabular-nums">{t.credits}</div>
                  </div>
                  <div className="rounded-lg bg-popover py-2">
                    <div className="text-[11px] text-muted-foreground">Voice</div>
                    <div className="text-sm font-bold text-foreground">{t.engine}</div>
                  </div>
                </div>

                <ul className="space-y-1.5 flex-1">
                  {t.perks.map((p) => (
                    <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary mt-0.5 shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
                      {p}
                    </li>
                  ))}
                </ul>

                <div className={cn('mt-4 text-center text-sm py-2 rounded-lg',
                  isCurrent ? 'bg-[var(--primary-dim)] text-primary font-medium' : 'text-muted-foreground')}>
                  {isCurrent ? 'Your current plan' : 'Assigned by your account role'}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-5 max-w-2xl">
          Plans are assigned by your account role (managed by your organization's directory), not purchased here.
          Voicing cost is estimated up front from the book length so you always know if you have enough credits before you start.
        </p>
      </div>
    </main>
  );
}
