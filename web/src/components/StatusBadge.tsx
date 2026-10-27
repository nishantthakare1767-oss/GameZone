import type { ConnectivityStatus, OperationalStatus } from '../lib/types';

const statusStyles: Record<OperationalStatus, { className: string; dot: string; label: string }> = {
  AVAILABLE: {
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    dot: 'bg-emerald-400',
    label: 'Available',
  },
  ACTIVE: {
    className: 'border-indigo-400/30 bg-indigo-500/10 text-indigo-200',
    dot: 'bg-indigo-400',
    label: 'In session',
  },
  EXPIRING_SOON: {
    className: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
    dot: 'bg-amber-400',
    label: 'Expiring soon',
  },
  EXPIRED: {
    className: 'border-orange-400/40 bg-orange-500/10 text-orange-200',
    dot: 'bg-orange-400',
    label: 'Time expired',
  },
  RESTRICTED: {
    className: 'border-rose-400/40 bg-rose-500/10 text-rose-200',
    dot: 'bg-rose-400',
    label: 'Restricted',
  },
  MAINTENANCE: {
    className: 'border-sky-400/30 bg-sky-500/10 text-sky-200',
    dot: 'bg-sky-400',
    label: 'Maintenance',
  },
  ERROR: {
    className: 'border-red-500/40 bg-red-500/10 text-red-200',
    dot: 'bg-red-500',
    label: 'Agent error',
  },
  DISABLED: {
    className: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
    dot: 'bg-slate-500',
    label: 'Disabled',
  },
};

export function StatusBadge({ status }: { status: OperationalStatus }) {
  const style = statusStyles[status];
  return (
    <span className={`chip ${style.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
      {style.label}
    </span>
  );
}

const connectivityStyles: Record<ConnectivityStatus, { className: string; label: string }> = {
  ONLINE: { className: 'text-emerald-300', label: 'Online' },
  OFFLINE: { className: 'text-rose-300', label: 'Offline' },
  NEVER_CONNECTED: { className: 'text-slate-400', label: 'Not connected yet' },
  MANUAL: { className: 'text-slate-400', label: 'Staff managed' },
};

export function ConnectivityBadge({ state }: { state: ConnectivityStatus }) {
  const style = connectivityStyles[state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.className}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === 'ONLINE' ? 'bg-emerald-400' : state === 'OFFLINE' ? 'bg-rose-400' : 'bg-slate-500'
        }`}
        aria-hidden="true"
      />
      {style.label}
    </span>
  );
}
