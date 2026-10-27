import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { DeviceView, SessionDetail, SessionView } from '../lib/types';
import { formatDateTime, formatMinutes, formatTime } from '../lib/format';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, Input, Select, Skeleton } from '../components/ui';
import { StatusPill } from '../components/StatusPill';

const PAGE_SIZE = 25;

interface Page {
  items: SessionView[];
  total: number;
  limit: number;
  offset: number;
}

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const deviceId = params.get('deviceId') ?? '';

  useEffect(() => {
    setOffset(0);
  }, [deviceId, status, from, to, search]);

  const devices = useQuery({
    queryKey: ['devices', 'history-filter'],
    queryFn: () => api.get<{ items: DeviceView[] }>('/api/devices'),
    staleTime: 60_000,
  });

  const query = new URLSearchParams();
  if (deviceId) query.set('deviceId', deviceId);
  if (status !== 'ALL') query.set('status', status);
  if (from) query.set('from', new Date(from).toISOString());
  if (to) query.set('to', new Date(new Date(to).getTime() + 86_400_000 - 1).toISOString());
  if (search.trim()) query.set('search', search.trim());
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String(offset));

  const sessions = useQuery({
    queryKey: ['sessions', 'history', query.toString()],
    queryFn: () => api.get<Page>(`/api/sessions?${query.toString()}`),
  });

  const detail = useQuery({
    queryKey: ['sessions', 'detail', detailId],
    queryFn: () => api.get<SessionDetail>(`/api/sessions/${detailId}`),
    enabled: detailId !== null,
  });

  const total = sessions.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const clearFilters = () => {
    setSearch('');
    setStatus('ALL');
    setFrom('');
    setTo('');
    setParams({});
  };

  const filtersActive = Boolean(deviceId || status !== 'ALL' || from || to || search);

  const deviceOptions = useMemo(() => devices.data?.items ?? [], [devices.data]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Session history</h1>
          <p className="mt-1 text-sm text-slate-400">
            {total} session{total === 1 ? '' : 's'} recorded · times shown in IST
          </p>
        </div>
        {filtersActive && (
          <Button size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </header>

      <Card className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Device">
          <Select
            value={deviceId}
            onChange={(event) => {
              const value = event.target.value;
              if (value) setParams({ deviceId: value });
              else setParams({});
            }}
          >
            <option value="">All devices</option>
            {deviceOptions.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="State">
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="ALL">Any state</option>
            <option value="ACTIVE">Active</option>
            <option value="EXPIRED">Expired</option>
            <option value="ENDED">Ended</option>
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <Field label="Search">
          <Input
            placeholder="Device or nickname"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      </Card>

      {sessions.isError ? (
        <ErrorState message="Could not load session history." onRetry={() => void sessions.refetch()} />
      ) : sessions.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-12" />
          ))}
        </div>
      ) : (sessions.data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="No sessions match"
            description="Try widening the date range or clearing filters."
            action={filtersActive ? <Button onClick={clearFilters}>Clear filters</Button> : null}
          />
        </Card>
      ) : (
        <>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead className="bg-ink-900/60">
                <tr>
                  <th className="th">Device</th>
                  <th className="th">Customer</th>
                  <th className="th">Staff</th>
                  <th className="th">Started</th>
                  <th className="th">Booked</th>
                  <th className="th">State</th>
                  <th className="th">Reason</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data!.items.map((session) => (
                  <tr
                    key={session.id}
                    className="cursor-pointer border-t border-white/5 hover:bg-white/5"
                    onClick={() => setDetailId(session.id)}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setDetailId(session.id);
                      }
                    }}
                  >
                    <td className="td font-medium text-white">{session.deviceName}</td>
                    <td className="td">{session.customerNickname ?? '—'}</td>
                    <td className="td">{session.startedBy.displayName}</td>
                    <td className="td">{formatDateTime(session.startedAt)}</td>
                    <td className="td">
                      {formatMinutes(session.plannedDurationMinutes)}
                      {session.extendedMinutes > 0 && (
                        <span className="text-slate-500"> +{formatMinutes(session.extendedMinutes)}</span>
                      )}
                    </td>
                    <td className="td">
                      <StatusPill status={session.status} />
                    </td>
                    <td className="td max-w-[220px] truncate text-slate-400">
                      {session.endReason ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-400">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <Dialog
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        width="max-w-2xl"
        title={detail.data ? `${detail.data.session.deviceName} · session detail` : 'Session detail'}
        description={
          detail.data
            ? `${formatDateTime(detail.data.session.startedAt)} → ${formatDateTime(detail.data.session.expiresAt)} IST`
            : undefined
        }
        footer={
          <Button onClick={() => setDetailId(null)}>
            Close
          </Button>
        }
      >
        {detail.isLoading ? (
          <Skeleton className="h-40" />
        ) : detail.isError ? (
          <ErrorState message="Could not load this session." onRetry={() => void detail.refetch()} />
        ) : detail.data ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Customer</dt>
                <dd className="text-slate-200">{detail.data.session.customerNickname ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">State</dt>
                <dd>
                  <StatusPill status={detail.data.session.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Opened by</dt>
                <dd className="text-slate-200">{detail.data.session.startedBy.displayName}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Ended by</dt>
                <dd className="text-slate-200">{detail.data.session.endedBy?.displayName ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Planned</dt>
                <dd className="text-slate-200">{formatMinutes(detail.data.session.plannedDurationMinutes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Added</dt>
                <dd className="text-slate-200">{formatMinutes(detail.data.session.extendedMinutes)}</dd>
              </div>
            </dl>

            <section>
              <h3 className="mb-2 text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                Extensions
              </h3>
              {detail.data.extensions.length === 0 ? (
                <p className="text-sm text-slate-500">No extensions.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {detail.data.extensions.map((extension) => (
                    <li key={extension.id} className="flex justify-between gap-3 text-slate-300">
                      <span>
                        +{formatMinutes(extension.minutes)} by {extension.addedBy}
                        {extension.note ? ` · ${extension.note}` : ''}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-slate-500">
                        {formatTime(extension.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                Timeline
              </h3>
              <ol className="space-y-2 text-sm">
                {detail.data.events.map((event) => (
                  <li key={event.id} className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" aria-hidden="true" />
                    <div>
                      <p className="text-slate-200">
                        {event.type.replaceAll('_', ' ').toLowerCase()} · {event.actorLabel}
                      </p>
                      <p className="text-[11px] text-slate-500">{formatDateTime(event.at)} IST</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
