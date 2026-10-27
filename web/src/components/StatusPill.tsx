import type { SessionStatus } from '../lib/types';

const styles: Record<SessionStatus, { className: string; label: string }> = {
  ACTIVE: { className: 'border-indigo-400/30 bg-indigo-500/10 text-indigo-200', label: 'Active' },
  EXPIRED: { className: 'border-orange-400/40 bg-orange-500/10 text-orange-200', label: 'Expired' },
  ENDED: { className: 'border-slate-500/30 bg-slate-500/10 text-slate-300', label: 'Ended' },
};

export function StatusPill({ status }: { status: SessionStatus }) {
  const style = styles[status];
  return <span className={`chip ${style.className}`}>{style.label}</span>;
}
