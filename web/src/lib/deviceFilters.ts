import type { DeviceView, OperationalStatus } from './types';

export type StatusFilter = 'ALL' | OperationalStatus;
export type TypeFilter = 'ALL' | 'PC' | 'PLAYSTATION';
export type SortKey = 'NAME' | 'STATUS' | 'EXPIRY' | 'HEARTBEAT';

const STATUS_PRIORITY: Record<OperationalStatus, number> = {
  EXPIRING_SOON: 0,
  EXPIRED: 1,
  ERROR: 2,
  ACTIVE: 3,
  RESTRICTED: 4,
  AVAILABLE: 5,
  MAINTENANCE: 6,
  DISABLED: 7,
};

export interface DeviceFilterState {
  search: string;
  status: StatusFilter;
  type: TypeFilter;
  sort: SortKey;
}

export const DEFAULT_FILTERS: DeviceFilterState = {
  search: '',
  status: 'ALL',
  type: 'ALL',
  sort: 'NAME',
};

export function filterDevices(devices: DeviceView[], filters: DeviceFilterState): DeviceView[] {
  const term = filters.search.trim().toLowerCase();

  const filtered = devices.filter((device) => {
    if (filters.status !== 'ALL' && device.status !== filters.status) return false;
    if (filters.type !== 'ALL' && device.type !== filters.type) return false;
    if (!term) return true;
    return (
      device.name.toLowerCase().includes(term) ||
      (device.session?.customerNickname ?? '').toLowerCase().includes(term) ||
      (device.location ?? '').toLowerCase().includes(term)
    );
  });

  return filtered.sort((a, b) => {
    switch (filters.sort) {
      case 'STATUS': {
        const delta = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
        return delta !== 0 ? delta : a.name.localeCompare(b.name);
      }
      case 'EXPIRY': {
        const aTime = a.session ? new Date(a.session.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.session ? new Date(b.session.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
      }
      case 'HEARTBEAT': {
        const aTime = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
        const bTime = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
        return bTime - aTime;
      }
      default:
        return a.name.localeCompare(b.name, undefined, { numeric: true });
    }
  });
}
