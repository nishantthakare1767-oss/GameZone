import { Link } from 'react-router-dom';
import type { DeviceView } from '../lib/types';
import { formatCountdown, formatMinutes, formatTime, relativeFrom } from '../lib/format';
import { ConnectivityBadge, StatusBadge } from './StatusBadge';
import { Button } from './ui';

export interface DeviceCardActions {
  onStart: (device: DeviceView) => void;
  onExtend: (device: DeviceView, reactivate: boolean) => void;
  onEnd: (device: DeviceView) => void;
  onManage?: (device: DeviceView) => void;
}

export function DeviceCard({
  device,
  now,
  actions,
}: {
  device: DeviceView;
  now: number;
  actions: DeviceCardActions;
}) {
  const session = device.session;
  const remainingSeconds = session
    ? Math.round((new Date(session.expiresAt).getTime() - now) / 1000)
    : 0;
  const overdue = session ? remainingSeconds <= 0 : false;
  const critical = session ? remainingSeconds > 0 && remainingSeconds <= 300 : false;
  const canStart =
    device.enabled &&
    !device.maintenance &&
    !device.archivedAt &&
    (device.status === 'AVAILABLE' ||
      device.status === 'RESTRICTED' ||
      device.status === 'EXPIRED' ||
      device.status === 'ERROR');
  const canManageSession = Boolean(session) && (device.status === 'ACTIVE' || device.status === 'EXPIRING_SOON');
  const onManage = actions.onManage;

  return (
    <article className="card card-hover flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-white">{device.name}</h3>
            <span className="chip border-ink-600 bg-ink-800 text-[10px] text-slate-400">
              {device.type === 'PC' ? 'PC' : 'Console'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {device.location ?? 'No location set'}
            {device.requiresStaffEnforcement && ' · staff-assisted enforcement'}
          </p>
        </div>
        <StatusBadge status={device.status} />
      </header>

      {session ? (
        <div className="rounded-xl border border-white/5 bg-ink-900/70 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm text-slate-300">
              {session.customerNickname ? (
                <>
                  <span className="text-slate-500">Playing as</span>{' '}
                  <span className="font-medium text-white">{session.customerNickname}</span>
                </>
              ) : (
                <span className="text-slate-500">No customer nickname</span>
              )}
            </p>
            <p
              className={`shrink-0 font-mono text-lg font-semibold tabular ${
                overdue ? 'text-orange-300' : critical ? 'text-amber-300' : 'text-white'
              }`}
              aria-live={critical || overdue ? 'polite' : 'off'}
            >
              {formatCountdown(remainingSeconds)}
            </p>
          </div>

          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${
                overdue ? 'bg-orange-400' : critical ? 'bg-amber-400' : 'bg-accent-500'
              }`}
              style={{
                width: `${Math.min(
                  100,
                  Math.max(0, (1 - remainingSeconds / (session.plannedDurationMinutes * 60 + session.extendedMinutes * 60)) * 100),
                )}%`,
              }}
              aria-hidden="true"
            />
          </div>

          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <div className="min-w-0">
              <dt className="text-slate-500">Started</dt>
              <dd className="truncate text-slate-300">{formatTime(session.startedAt)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-500">Expires</dt>
              <dd className="truncate text-slate-300">{formatTime(session.expiresAt)} IST</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-500">Booked</dt>
              <dd className="truncate text-slate-300">
                {formatMinutes(session.plannedDurationMinutes)}
                {session.extendedMinutes > 0 && ` +${formatMinutes(session.extendedMinutes)}`}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-500">Opened by</dt>
              <dd className="truncate text-slate-300">{session.startedBy.displayName}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="flex min-h-[92px] flex-col justify-center rounded-xl border border-dashed border-white/5 bg-ink-900/40 p-3">
          <p className="text-sm text-slate-400">
            {device.maintenance
              ? 'Under maintenance — sessions blocked'
              : device.archivedAt
                ? 'Archived device'
                : device.restrictionPending
                  ? 'Waiting for the agent to confirm the lock'
                  : 'No active session'}
          </p>
          {device.agentError && (
            <p className="mt-1 line-clamp-2 text-xs text-rose-300">Agent: {device.agentError}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <ConnectivityBadge state={device.connectivity} />
        <span className="text-slate-500">
          {device.controlMode === 'AGENT'
            ? `Heartbeat ${relativeFrom(device.lastHeartbeatAt, now)}`
            : 'No agent'}
          {device.agentVersion ? ` · v${device.agentVersion}` : ''}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {canStart && !session && (
          <Button variant="primary" size="sm" onClick={() => actions.onStart(device)}>
            Start session
          </Button>
        )}
        {device.status === 'EXPIRED' && session && (
          <Button variant="primary" size="sm" onClick={() => actions.onExtend(device, true)}>
            Reactivate
          </Button>
        )}
        {canManageSession && (
          <>
            <Button size="sm" onClick={() => actions.onExtend(device, false)}>
              Extend
            </Button>
            <Button variant="danger" size="sm" onClick={() => actions.onEnd(device)}>
              End
            </Button>
          </>
        )}
        {onManage && (
          <Button variant="ghost" size="sm" onClick={() => onManage(device)}>
            Manage
          </Button>
        )}
        <Link
          to={`/history?deviceId=${device.id}`}
          className="btn btn-ghost btn-xs ml-auto text-slate-400"
        >
          History
        </Link>
      </div>
    </article>
  );
}
