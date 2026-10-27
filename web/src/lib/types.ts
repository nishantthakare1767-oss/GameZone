export type DeviceType = 'PC' | 'PLAYSTATION';
export type ControlMode = 'AGENT' | 'MANUAL';
export type AccessMethod = 'SHELL_REPLACE' | 'SESSION_LOCK' | 'MANUAL';
export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'ENDED';
export type OperationalStatus =
  | 'AVAILABLE'
  | 'ACTIVE'
  | 'EXPIRING_SOON'
  | 'EXPIRED'
  | 'RESTRICTED'
  | 'MAINTENANCE'
  | 'ERROR'
  | 'DISABLED';
export type ConnectivityStatus = 'ONLINE' | 'OFFLINE' | 'NEVER_CONNECTED' | 'MANUAL';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'ADMIN' | 'STAFF';
}

export interface StaffMember extends User {
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

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
  remainingSeconds: number;
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

export interface NotificationItem {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  deviceId: string | null;
  deviceName: string | null;
  sessionId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface SettingsShape {
  cafeName: string;
  timezone: string;
  sessionDurations: number[];
  minSessionMinutes: number;
  maxSessionMinutes: number;
  maxExtensionMinutes: number;
  expiringSoonMinutes: number;
  expiringWarningMinutes: number;
  deviceOfflineAfterSeconds: number;
  agentGraceSeconds: number;
  allowExtensionAfterExpiry: boolean;
  requireStaffAssistedConsoles: boolean;
  soundNotifications: boolean;
  blockOfflineDeviceSessions: boolean;
}

export interface IntegrationView {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  status: string;
  notes: string | null;
  capabilities: {
    automaticLock: boolean;
    verified: boolean;
    connectivity: boolean;
    appControl: boolean;
  };
  config: Record<string, unknown>;
  lastCheckedAt: string | null;
}

export interface DeviceHistory {
  sessions: SessionView[];
  events: { id: string; type: string; message: string | null; at: string }[];
  accessEvents: { id: string; action: string; outcome: string; message: string | null; at: string }[];
}

export interface SessionDetail {
  session: SessionView;
  extensions: {
    id: string;
    minutes: number;
    previousExpiresAt: string;
    newExpiresAt: string;
    addedBy: string;
    note: string | null;
    createdAt: string;
  }[];
  events: { id: string; type: string; actorLabel: string; detail: unknown; at: string }[];
}
