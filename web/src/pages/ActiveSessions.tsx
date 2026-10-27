import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { DeviceView, SessionView } from '../lib/types';
import { formatCountdown, formatMinutes, formatTime } from '../lib/format';
import { useTicker } from '../lib/realtime';
import { useSessionActions } from '../components/SessionActionHost';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  StatCard,
} from '../components/ui';

export function ActiveSessionsPage() {
  const actions = useSessionActions();
  const now = useTicker(1000);
  const [search, setSearch] = useState('');

  const sessions = useQuery({
    queryKey: ['sessions', 'active'],
    queryFn: () => api.get<{ items: SessionView[] }>('/api/sessions/active'),
    refetchInterval: 15_000,
  });

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<{ items: DeviceView[] }>('/api/devices'),
    refetchInterval: 30_000,
  });

  const deviceById = useMemo(
    () => new Map((devices.data?.items ?? []).map((device) => [device.id, device])),
    [devices.data],
  );

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const items = sessions.data?.items ?? [];
    return items
      .filter((session) =>
        term
          ? session.deviceName.toLowerCase().includes(term) ||
            (session.customerNickname ?? '').toLowerCase().includes(term) ||
            session.startedBy.displayName.toLowerCase().includes(term)
          : true,
      )
      .sort(
        (a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime(),
      );
  }, [sessions.data, search]);

  const expiringSoon = rows.filter((session) => {
    const remaining = new Date(session.expiresAt).getTime() - now;
    return remaining > 0 && remaining <= 5 * 60_000;
  }).length;

  const overdue = rows.filter((session) => new Date(session.expiresAt).getTime() <= now).length;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-white">Active sessions</h1>
        <p className="mt-1 text-sm text-slate-400">
          Remaining time is recalculated from the server's expiry timestamp every second.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Live sessions" value={rows.length} />
        <StatCard label="Expiring ≤5 min" value={expiringSoon} tone={expiringSoon ? 'warning' : 'muted'} />
        <StatCard label="Past expiry" value={overdue} tone={overdue ? 'critical' : 'muted'} />
      </div>

      <Card className="p-3">
        <Input
          aria-label="Search active sessions"
          placeholder="Search device, customer or staff"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="sm:max-w-sm"
        />
      </Card>

      {sessions.isError ? (
        <ErrorState message="Could not load active sessions." onRetry={() => void sessions.refetch()} />
      ) : sessions.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No active sessions"
            description="Start a session from the overview or devices page to see it here."
            action={
              <Link to="/devices" className="btn btn-secondary btn-xs">
                Go to devices
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden overflow-hidden lg:block">
            <table className="w-full border-collapse">
              <thead className="bg-ink-900/60">
                <tr>
                  <th className="th">Device</th>
                  <th className="th">Customer</th>
                  <th className="th">Started</th>
                  <th className="th">Expires</th>
                  <th className="th">Remaining</th>
                  <th className="th">Booked</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((session) => {
                  const remaining = Math.round(new Date(session.expiresAt).getTime() - now) / 1000;
                  const urgent = remaining <= 300;
                  const device = deviceById.get(session.deviceId);
                  return (
                    <tr key={session.id} className="border-t border-white/5">
                      <td className="td">
                        <div className="font-medium text-white">{session.deviceName}</div>
                        <div className="text-xs text-slate-500">
                          {session.deviceType === 'PC' ? 'PC' : 'Console'}
                          {session.requiresStaffEnforcement && ' · staff enforced'}
                        </div>
                      </td>
                      <td className="td">{session.customerNickname ?? '—'}</td>
                      <td className="td">{formatTime(session.startedAt)}</td>
                      <td className="td">{formatTime(session.expiresAt)}</td>
                      <td className="td">
                        <span
                          className={`font-mono font-semibold tabular ${
                            remaining <= 0 ? 'text-orange-300' : urgent ? 'text-amber-300' : 'text-slate-200'
                          }`}
                        >
                          {formatCountdown(remaining)}
                        </span>
                      </td>
                      <td className="td">
                        {formatMinutes(session.plannedDurationMinutes)}
                        {session.extendedMinutes > 0 && (
                          <span className="text-slate-500"> +{formatMinutes(session.extendedMinutes)}</span>
                        )}
                      </td>
                      <td className="td text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            onClick={() => device && actions.extend(device, session.status === 'EXPIRED')}
                            disabled={!device}
                          >
                            {remaining <= 0 ? 'Reactivate' : 'Extend'}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => device && actions.end(device)}
                            disabled={!device || remaining <= 0}
                          >
                            End
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <div className="space-y-3 lg:hidden">
            {rows.map((session) => {
              const remaining = Math.round(new Date(session.expiresAt).getTime() - now) / 1000;
              const device = deviceById.get(session.deviceId);
              return (
                <Card key={session.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-white">{session.deviceName}</p>
                      <p className="text-xs text-slate-400">
                        {session.customerNickname ?? 'No nickname'} · started {formatTime(session.startedAt)}
                      </p>
                    </div>
                    <span
                      className={`font-mono text-lg font-semibold tabular ${
                        remaining <= 0 ? 'text-orange-300' : remaining <= 300 ? 'text-amber-300' : 'text-white'
                      }`}
                    >
                      {formatCountdown(remaining)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Expires {formatTime(session.expiresAt)} IST · opened by {session.startedBy.displayName}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => device && actions.extend(device, remaining <= 0)}
                      disabled={!device}
                    >
                      {remaining <= 0 ? 'Reactivate' : 'Extend'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => device && actions.end(device)}
                      disabled={!device || remaining <= 0}
                    >
                      End
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
