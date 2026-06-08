import { useState, useEffect } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { Eye } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import ThemeLamp from '../components/ThemeLamp';
import Logo from '../components/Logo';

export default function Login() {
  const setUser = useStore((s) => s.setUser);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(null);     // { kind: 'ok'|'fail', n }
  const ticket = useAnimationControls();

  useEffect(() => {   // spring entrance on mount
    ticket.start({ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 320, damping: 24 } });
  }, [ticket]);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!username || !password) { setErr('Enter username and password.'); return; }
    setBusy(true);
    try {
      const user = await api('POST', '/api/auth/login', { username, password });
      setStamp({ kind: 'ok', n: Date.now() });
      setTimeout(() => setUser(user), 720);
    } catch (e2) {
      let msg = 'Invalid username or password.';
      try { const j = JSON.parse(e2.message); if (j.detail) msg = j.detail; } catch { /* default */ }
      if (msg.toLowerCase().includes('locked')) msg = 'Account temporarily locked. Try again later.';
      setStamp({ kind: 'fail', n: Date.now() });
      ticket.start({ x: [0, -8, 7, -5, 4, 0], transition: { duration: 0.4 } });   // shake
      setErr(msg); setBusy(false);
    }
  }
  const okColor = '#4caf82';   // "Admitted" = green; "Denied" = destructive red

  return (
    <div className="min-h-full flex items-center justify-center p-5 bg-[var(--background)]">
      <ThemeLamp className="fixed top-4 right-5" />

      <div className="w-full max-w-5xl flex flex-col lg:flex-row items-center justify-center gap-10 lg:gap-20">

        {/* Mission statement — desktop only, alongside the ticket (left) */}
        <motion.div
          initial={{ opacity: 0, x: -18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 26, delay: 0.1 }}
          className="hidden lg:flex flex-col flex-1 max-w-md">
          <div className="flex items-center gap-2.5 mb-7">
            <Logo className="w-8 h-8 shrink-0" />
            <span className="font-display text-2xl text-foreground">Verbalink</span>
          </div>
          <h2 className="font-display text-[2rem] leading-[1.18] text-foreground mb-5">
            A story shouldn&rsquo;t ask for perfect eyesight, a shared language, or a free evening before it gives itself to you.
          </h2>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Verbalink exists to close that gap — pairing voice with text so every reader can meet a book on their own terms.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-7">
            Listen and follow along. Pause on a sentence to see it translated or explained. Ask what a passage means and talk it through.
          </p>
          <p className="font-display text-xl text-primary leading-snug">
            Reading made accessible, and language made learnable — one sentence at a time.
          </p>
        </motion.div>

        {/* Right column: mobile tagline above the ticket */}
        <div className="flex flex-col items-center">
          <p className="lg:hidden font-display text-2xl text-center text-foreground mb-7 px-4 max-w-[340px]">
            Where listening becomes understanding.
          </p>

          <motion.div
            animate={ticket}
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            className="relative w-[360px] max-w-full rounded-md overflow-hidden bg-card text-card-foreground
                       shadow-[0_30px_80px_rgba(0,0,0,0.55)] border border-border">
            <div className="ticket-rail left-[-7px]" aria-hidden="true" />
            <div className="ticket-rail right-[-7px]" aria-hidden="true" />

        {/* stub */}
        <div className="flex items-center justify-between px-7 py-3 border-b border-dashed border-border"
             style={{ background: 'var(--primary-dim)' }}>
          <span className="font-ui text-xs font-semibold tracking-[0.22em] uppercase text-primary">Reader's Ticket</span>
          <span className="font-ui text-[13px] text-muted-foreground">№ 0042</span>
        </div>

        {/* body */}
        <div className="px-10 pt-8 pb-9">
          <div className="flex items-center justify-center gap-2.5 mb-1.5">
            <Logo className="w-9 h-9 shrink-0" />
            <span className="font-display text-4xl text-foreground">Verbalink</span>
          </div>
          <p className="text-center text-sm text-muted-foreground tracking-wide mb-8">Your language learning library</p>

          <form autoComplete="on" onSubmit={submit} noValidate className="space-y-4">
            <div>
              <label htmlFor="login-username" className="block font-ui text-sm text-muted-foreground uppercase tracking-wide mb-2">Card holder</label>
              <Input id="login-username" name="username" placeholder="username" autoComplete="username"
                     autoCapitalize="none" autoCorrect="off" spellCheck={false}
                     value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div>
              <label htmlFor="login-password" className="block font-ui text-sm text-muted-foreground uppercase tracking-wide mb-2">Pass phrase</label>
              <div className="relative">
                <Input id="login-password" name="password" type={show ? 'text' : 'password'} placeholder="••••••••"
                       autoComplete="current-password" className="pr-11"
                       value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}
                        className={'absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-md transition ' + (show ? 'text-primary' : 'text-muted-foreground hover:text-primary')}>
                  <Eye size={18} />
                </button>
              </div>
            </div>
            <div className="min-h-[18px] text-center text-[15px] text-destructive" role="alert" aria-live="polite">{err}</div>
            <Button type="submit" disabled={busy} className="w-full">{busy ? 'Checking…' : 'Check in'}</Button>
          </form>
        </div>

        {stamp && (
          <motion.div key={stamp.n} aria-hidden="true" className="login-stamp"
            style={{ color: stamp.kind === 'ok' ? okColor : 'var(--destructive)' }}
            initial={{ opacity: 0, scale: 2.6, rotate: -16 }}
            animate={{ opacity: 0.95, scale: 1, rotate: -16 }}
            transition={{ type: 'spring', stiffness: 700, damping: 18, mass: 0.7 }}>
            {stamp.kind === 'ok' ? 'Admitted' : 'Denied'}
          </motion.div>
        )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
