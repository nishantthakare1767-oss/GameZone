import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/session';
import { useRealtimeFeed, useTicker, type ConnectionState } from '../lib/realtime';
import { formatTime } from '../lib/format';
import { Button } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: '◧', end: true },
  { to: '/devices', label: 'Devices', icon: '▤' },
  { to: '/sessions', label: 'Active sessions', icon: '◔' },
  { to: '/history', label: 'Session history', icon: '☰' },
  { to: '/notifications', label: 'Notifications', icon: '◈' },
  { to: '/staff', label: 'Staff', icon: '◉' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const connection = useRealtimeFeed();
  const now = useTicker(1000);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const notifications = useQuery({
    queryKey: ['notifications', 'badge'],
    queryFn: () => api.get<{ unreadCount: number }>('/api/notifications?limit=1'),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const unread = notifications.data?.unreadCount ?? 0;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/5 bg-ink-900/60 p-4 lg:flex">
        <Brand />
        <nav className="mt-6 flex flex-1 flex-col gap-1" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}
            >
              <span aria-hidden="true" className="w-4 text-center text-xs opacity-70">
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.to === '/notifications' && unread > 0 && (
                <span className="rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 space-y-3 border-t border-white/5 pt-4">
          <ConnectionPill state={connection} />
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-200">{user?.displayName}</p>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">{user?.role}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={handleSignOut} loading={signingOut}>
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/5 bg-ink-900/85 px-4 py-3 backdrop-blur lg:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-lg border border-ink-600 p-2 text-slate-300"
          >
            ☰
          </button>
          <span className="font-semibold tracking-tight text-white">GameHub</span>
          <span className="ml-auto font-mono text-xs text-slate-400 tabular">{formatTime(now)}</span>
        </header>

        {menuOpen && (
          <div className="border-b border-white/5 bg-ink-900 px-4 py-3 lg:hidden">
            <nav className="grid gap-1" aria-label="Mobile">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}
                >
                  <span aria-hidden="true" className="w-4 text-center text-xs opacity-70">
                    {item.icon}
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {item.to === '/notifications' && unread > 0 && (
                    <span className="rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {unread}
                    </span>
                  )}
                </NavLink>
              ))}
            </nav>
            <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-3">
              <span className="text-sm text-slate-300">{user?.displayName}</span>
              <Button size="sm" variant="ghost" onClick={handleSignOut} loading={signingOut}>
                Sign out
              </Button>
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-accent-500/20 text-accent-300 ring-1 ring-accent-500/40">
        <span className="text-sm font-black">GH</span>
      </div>
      <div>
        <p className="text-sm font-semibold leading-tight text-white">GameHub</p>
        <p className="text-[11px] tracking-wide text-slate-500 uppercase">Control center</p>
      </div>
    </div>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const map: Record<ConnectionState, { label: string; className: string }> = {
    online: { label: 'Live updates on', className: 'text-emerald-300' },
    connecting: { label: 'Connecting…', className: 'text-amber-300' },
    offline: { label: 'Live updates lost', className: 'text-rose-300' },
  };
  const current = map[state];
  return (
    <div className={`flex items-center gap-2 text-[11px] font-medium ${current.className}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === 'online' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : 'bg-rose-400'
        }`}
        aria-hidden="true"
      />
      {current.label}
    </div>
  );
}
