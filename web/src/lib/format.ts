/** All server timestamps are UTC; the cafe operates in Asia/Kolkata. */
export const CAFE_TIMEZONE = 'Asia/Kolkata';

const timeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: CAFE_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: CAFE_TIMEZONE,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: CAFE_TIMEZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export function formatTime(value: string | number | Date | null | undefined): string {
  if (!value) return '—';
  return timeFormatter.format(new Date(value));
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return '—';
  return dateTimeFormatter.format(new Date(value));
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (!value) return '—';
  return dateFormatter.format(new Date(value));
}

/** Clock-style countdown from an authoritative remaining-seconds value. */
export function formatCountdown(totalSeconds: number): string {
  const negative = totalSeconds < 0;
  const abs = Math.abs(Math.floor(totalSeconds));
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;
  const core =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;
  return negative ? `-${core}` : core;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function relativeFrom(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'never';
  const diffSeconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (diffSeconds < 10) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function inSeconds(seconds: number): string {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}
