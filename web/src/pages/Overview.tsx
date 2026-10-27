import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { DashboardSummary, DeviceView } from '../lib/types';
import { formatDateTime, formatTime, relativeFrom } from '../lib/format';
import { useTicker } from '../lib/realtime';
import { DEFAULT_FILTERS, filterDevices, type DeviceFilterState } from '../lib/deviceFilters';
import { DeviceCard } from '../components/DeviceCard';
import { useSessionActions } from '../components/SessionActionHost';
import { Button, Card, EmptyState, ErrorState, Input, Select, Skeleton, StatCard } from '../components/ui';

export function OverviewPage() {
  const [filters, setFilters] = useState<DeviceFilterState>(DEFAULT_FILTERS);
  const actions = useSessionActions();
  const now = useTicker(1000);

  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardSummary>('/api/dashboard/summary'),
    refetchInterval: 20_000,
  });

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<{ items: DeviceView[] }>('/api/devices'),
    refetchInterval: 20_000,
  });

  const visible = useMemo(
    () => filterDevices(devices.data?.items ?? [], filters),
    [devices.data, filters],
  );

  if (summary.isError) {
    return (
      <ErrorState
        message={`Could not load the dashboard: ${(summary.error as Error).message}`}
        onRetry={() => void summary.refetch()}
      />
    );
  }

  const totals = summary.data?.totals;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Operations overview</h1>
          <p className="mt-1 text-sm text-slate-400">
            Server time {formatTime(now)} IST · all timers run on the local server
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              void summary.refetch();
              void devices.refetch();
            }}
            loading={summary.isFetching || devices.isFetching}
          >
            Refresh now
          </Button>
        </div>
      </header>

      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {summary.isLoading || !totals ? (
          Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-24" />)
        ) : (
          <>
            <StatCard label="Available" value={totals.available} tone="positive" hint={`${totals.devices} devices total`} />
            <StatCard label="In session" value={totals.active} hint={`${totals.pcs} PCs · ${totals.consoles} consoles`} />
            <StatCard label="Expiring ≤5 min" value={totals.expiringSoon} tone="warning" hint="Warn the customer" />
            <StatCard
              label="Expired / locked"
              value={totals.expired + totals.restricted}
              tone="critical"
              hint={`${totals.restricted} restricted`}
            />
            <StatCard label="Offline agents" value={totals.offline} tone="muted" hint="No recent heartbeat" />
            <StatCard
              label="Maintenance / errors"
              value={totals.maintenance + totals.errors}
              tone={totals.errors > 0 ? 'critical' : 'muted'}
              hint={`${totals.errors} agent error(s)`}
            />
          </>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0">
          <div className="card mb-4 flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
            <Input
              aria-label="Search devices"
              placeholder="Search device, customer or location"
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              className="sm:max-w-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Select
                aria-label="Filter by status"
                value={filters.status}
                onChange={(event) =>
                  setFilters({ ...filters, status: event.target.value as DeviceFilterState['status'] })
                }
                className="w-auto"
              >
                <option value="ALL">All statuses</option>
                <option value="AVAILABLE">Available</option>
                <option value="ACTIVE">In session</option>
                <option value="EXPIRING_SOON">Expiring soon</option>
                <option value="EXPIRED">Time expired</option>
                <option value="RESTRICTED">Restricted</option>
                <option value="MAINTENANCE">Maintenance</option>
                <option value="ERROR">Agent error</option>
                <option value="DISABLED">Disabled</option>
              </Select>
              <Select
                aria-label="Filter by type"
                value={filters.type}
                onChange={(event) =>
                  setFilters({ ...filters, type: event.target.value as DeviceFilterState['type'] })
                }
                className="w-auto"
              >
                <option value="ALL">All types</option>
                <option value="PC">PCs</option>
                <option value="PLAYSTATION">Consoles</option>
              </Select>
              <Select
                aria-label="Sort devices"
                value={filters.sort}
                onChange={(event) =>
                  setFilters({ ...filters, sort: event.target.value as DeviceFilterState['sort'] })
                }
                className="w-auto"
              >
                <option value="NAME">Sort: name</option>
                <option value="STATUS">Sort: attention first</option>
                <option value="EXPIRY">Sort: next to expire</option>
                <option value="HEARTBEAT">Sort: last heartbeat</option>
              </Select>
            </div>
          </div>

          {devices.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-64" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState
                title={devices.data?.items.length ? 'No devices match these filters' : 'No devices registered yet'}
                description={
                  devices.data?.items.length
                    ? 'Clear the search or pick a different status.'
                    : 'Add your first PC or console from the Devices page.'
                }
                action={
                  devices.data?.items.length ? (
                    <Button onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</Button>
                  ) : null
                }
              />
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {visible.map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  now={now}
                  actions={{
                    onStart: actions.start,
                    onExtend: actions.extend,
                    onEnd: actions.end,
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="min-w-0 space-y-3">
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Recent activity</h2>
              <span className="text-[11px] text-slate-500">
                {summary.data ? formatDateTime(summary.data.serverTime) : ''}
              </span>
            </div>
            {summary.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-10" />
                ))}
              </div>
            ) : summary.data?.recentActivity.length ? (
              <ol className="space-y-3">
                {summary.data.recentActivity.map((item) => (
                  <li key={item.id} className="flex gap-3">
                    <span
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                        item.severity === 'CRITICAL'
                          ? 'bg-rose-400'
                          : item.severity === 'WARNING'
                            ? 'bg-amber-400'
                            : 'bg-accent-400'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200">
                        <span className="font-medium">{item.deviceName ?? 'Device'}</span>{' '}
                        <span className="text-slate-400">· {item.message}</span>
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {item.actorLabel} · {relativeFrom(item.at, now)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-slate-500">No session activity yet.</p>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-white">Needs attention</h2>
            {summary.data ? (
              <ul className="space-y-2 text-sm">
                <AttentionRow
                  label="Expiring within 5 minutes"
                  value={summary.data.totals.expiringSoon}
                  tone="warning"
                />
                <AttentionRow
                  label="Expired, awaiting lock"
                  value={summary.data.totals.expired}
                  tone="critical"
                />
                <AttentionRow label="Restricted stations" value={summary.data.totals.restricted} tone="critical" />
                <AttentionRow label="Offline agents" value={summary.data.totals.offline} tone="muted" />
                <AttentionRow label="Agent errors" value={summary.data.totals.errors} tone="critical" />
              </ul>
            ) : null}
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold text-white">PlayStation consoles</h2>
            <p className="text-xs leading-relaxed text-slate-400">
              Retail consoles have no verified remote lock. Their sessions are timed by the server and
              flagged for staff action at expiry — the dashboard never claims otherwise.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function AttentionRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'warning' | 'critical' | 'muted';
}) {
  const toneClass = value === 0 ? 'text-slate-500' : tone === 'critical' ? 'text-rose-300' : tone === 'warning' ? 'text-amber-300' : 'text-slate-300';
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono font-semibold tabular ${toneClass}`}>{value}</span>
    </li>
  );
}
