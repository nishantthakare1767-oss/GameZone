import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { errorMessage } from '../lib/api';
import { useTicker } from '../lib/realtime';
import { formatTime } from '../lib/format';
import { Button, Field, Input } from '../components/ui';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useTicker(30_000);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const destination = (location.state as { from?: string } | null)?.from ?? '/';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      navigate(destination, { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-white/5 p-12 lg:flex">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent-500/20 text-accent-300 ring-1 ring-accent-500/40">
            <span className="text-sm font-black">GH</span>
          </div>
          <div>
            <p className="font-semibold text-white">GameHub</p>
            <p className="text-[11px] tracking-[0.2em] text-slate-500 uppercase">Control center</p>
          </div>
        </div>

        <div className="max-w-md">
          <h1 className="text-4xl leading-tight font-semibold text-white">
            Every station, every timer, one console.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            Session timing is enforced by the café server, not by a browser tab. PCs lock themselves
            when time runs out; consoles are flagged for staff. The dashboard keeps working when the
            internet doesn't.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-slate-400">
            <li className="flex items-center gap-2">
              <span className="text-emerald-400">▸</span> Server-authoritative expiry with restart recovery
            </li>
            <li className="flex items-center gap-2">
              <span className="text-emerald-400">▸</span> Live device and session updates
            </li>
            <li className="flex items-center gap-2">
              <span className="text-emerald-400">▸</span> Full audit trail for every staff action
            </li>
          </ul>
        </div>

        <p className="font-mono text-xs text-slate-600">
          Local server time {formatTime(now)} IST · works offline on the café LAN
        </p>
      </div>

      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <p className="text-lg font-semibold text-white">GameHub Control Center</p>
            <p className="text-sm text-slate-400">Staff sign-in</p>
          </div>

          <h2 className="text-2xl font-semibold text-white">Sign in</h2>
          <p className="mt-1 text-sm text-slate-400">Use your staff account.</p>

          <form className="mt-6 space-y-4" onSubmit={submit}>
            <Field label="Username" htmlFor="username">
              <Input
                id="username"
                name="username"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>

            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            {error && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Sign in
            </Button>
          </form>

          <p className="mt-6 text-xs leading-relaxed text-slate-500">
            Access is restricted to café staff. Failed attempts are rate limited and written to the
            audit log.
          </p>
        </div>
      </div>
    </div>
  );
}
