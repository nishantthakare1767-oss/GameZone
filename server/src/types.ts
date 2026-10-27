export type DeviceType = 'PC' | 'PLAYSTATION';
export type ControlMode = 'AGENT' | 'MANUAL';
export type AccessMethod = 'SHELL_REPLACE' | 'SESSION_LOCK' | 'MANUAL';
export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'ENDED';

/** Derived, never stored: what the device is currently doing. */
export type OperationalStatus =
  | 'AVAILABLE'
  | 'ACTIVE'
  | 'EXPIRING_SOON'
  | 'EXPIRED'
  | 'RESTRICTED'
  | 'MAINTENANCE'
  | 'ERROR'
  | 'DISABLED';

/** Derived, never stored: whether we can reach the device agent. */
export type ConnectivityStatus = 'ONLINE' | 'OFFLINE' | 'NEVER_CONNECTED' | 'MANUAL';

export interface SessionView {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  customerNickname: string | null;
  startedAt: string;
  plannedDurationMinutes: number;
  expiresAt: string;
  extendedMinutes: number;
  status: SessionStatus;
  endedAt: string | null;
  endReason: string | null;
  startedBy: { id: string; displayName: string };
  endedBy: { id: string; displayName: string } | null;
  /** Seconds left according to the server clock; negative once overdue. */
  remainingSeconds: number;
  /** 0..1 of the original + extended time already consumed. */
  progress: number;
  restrictionConfirmedAt: string | null;
  requiresStaffEnforcement: boolean;
}

export interface DeviceView {
  id: string;
  name: string;
  type: DeviceType;
  controlMode: ControlMode;
  accessMethod: AccessMethod;
  enabled: boolean;
  maintenance: boolean;
  archivedAt: string | null;
  location: string | null;
  notes: string | null;
  agentVersion: string | null;
  agentOs: string | null;
  agentError: string | null;
  lastHeartbeatAt: string | null;
  lastSeenIp: string | null;
  connectivity: ConnectivityStatus;
  status: OperationalStatus;
  statusLabel: string;
  session: SessionView | null;
  restrictionPending: boolean;
  requiresStaffEnforcement: boolean;
  hasActiveCredential: boolean;
  offlineGraceSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSummary {
  serverTime: string;
  totals: {
    devices: number;
    pcs: number;
    consoles: number;
    available: number;
    active: number;
    expiringSoon: number;
    expired: number;
    restricted: number;
    offline: number;
    maintenance: number;
    errors: number;
    disabled: number;
  };
  activeSessions: SessionView[];
  recentActivity: ActivityItem[];
}

export interface ActivityItem {
  id: string;
  at: string;
  type: string;
  actorLabel: string;
  deviceId: string | null;
  deviceName: string | null;
  sessionId: string | null;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export interface AgentAuthorization {
  deviceId: string;
  state: 'AUTHORIZED' | 'NO_SESSION' | 'EXPIRED' | 'DISABLED' | 'MAINTENANCE';
  serverTime: string;
  session: {
    id: string;
    expiresAt: string;
    customerNickname: string | null;
    startedAt: string;
  } | null;
  /** Seconds the agent may keep its last state while the server is unreachable. */
  graceSeconds: number;
  accessMethod: AccessMethod;
  /** Human readable reason, shown on the kiosk screen. */
  reason: string;
}
