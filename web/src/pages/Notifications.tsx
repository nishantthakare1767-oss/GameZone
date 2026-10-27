import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import type { NotificationItem } from '../lib/types';
import { formatDateTime, relativeFrom } from '../lib/format';
import { useTicker } from '../lib/realtime';
import { useToast } from '../components/ui';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '../components/ui';

interface NotificationPage {
  items: NotificationItem[];
  unreadCount: number;
  total: number;
}

const severityStyles: Record<string, string> = {
  CRITICAL: 'border-rose-500/40 bg-rose-500/5',
  WARNING: 'border-amber-500/30 bg-amber-500/5',
  INFO: 'border-white/5 bg-ink-850/60',
};

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useTicker(15_000);

  const notifications = useQuery({
    queryKey: ['notifications', { unreadOnly }],
    queryFn: () =>
      api.get<NotificationPage>(`/api/notifications?limit=100${unreadOnly ? '&unreadOnly=true' : ''}`),
    refetchInterval: 25_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean }>(`/api/notifications/${id}/read`),
    onSuccess: invalidate,
    onError: (error) => toast.error(errorMessage(error)),
  });

  const markAll = useMutation({
    mutationFn: () => api.post<{ ok: boolean; count: number }>('/api/notifications/read-all'),
    onSuccess: (data) => {
      toast.success(`${data.count} notification${data.count === 1 ? '' : 's'} marked read`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = notifications.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Notifications</h1>
          <p className="mt-1 text-sm text-slate-400">
            {notifications.data?.unreadCount ?? 0} unread · alerts persist across server restarts
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            Unread only
          </label>
          <Button
            size="sm"
            onClick={() => markAll.mutate()}
            loading={markAll.isPending}
            disabled={(notifications.data?.unreadCount ?? 0) === 0}
          >
            Mark all read
          </Button>
        </div>
      </header>

      {notifications.isError ? (
        <ErrorState message="Could not load notifications." onRetry={() => void notifications.refetch()} />
      ) : notifications.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon="✓"
            title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
            description="Expiry warnings, agent outages and restriction failures appear here."
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const unread = item.readAt === null;
            return (
              <li
                key={item.id}
                className={`card flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between ${
                  severityStyles[item.severity] ?? ''
                } ${unread ? '' : 'opacity-70'}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`chip ${
                        item.severity === 'CRITICAL'
                          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                          : item.severity === 'WARNING'
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                            : 'border-ink-600 bg-ink-800 text-slate-300'
                      }`}
                    >
                      {item.severity.toLowerCase()}
                    </span>
                    <p className="font-medium text-white">{item.title}</p>
                    {unread && <span className="h-1.5 w-1.5 rounded-full bg-accent-400" aria-label="unread" />}
                  </div>
                  <p className="mt-1 text-sm text-slate-300">{item.message}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {formatDateTime(item.createdAt)} IST · {relativeFrom(item.createdAt, now)}
                    {item.deviceName ? ` · ${item.deviceName}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.sessionId && (
                    <Link to="/history" className="btn btn-ghost btn-xs">
                      History
                    </Link>
                  )}
                  {unread && (
                    <Button
                      size="sm"
                      onClick={() => markRead.mutate(item.id)}
                      loading={markRead.isPending && markRead.variables === item.id}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
