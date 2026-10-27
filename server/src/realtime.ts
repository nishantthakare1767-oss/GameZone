import type { Server as SocketServer } from 'socket.io';

export interface RealtimeBus {
  emit(event: string, payload?: unknown): void;
}

export const noopRealtime: RealtimeBus = { emit: () => {} };

export function createSocketRealtime(io: SocketServer): RealtimeBus {
  return {
    emit(event, payload) {
      io.emit(event, payload);
    },
  };
}

/** A bus that records events, used by tests. */
export function createRecordingRealtime(): RealtimeBus & { events: { event: string; payload?: unknown }[] } {
  const events: { event: string; payload?: unknown }[] = [];
  return {
    events,
    emit(event, payload) {
      events.push({ event, payload });
    },
  };
}

export const REALTIME_EVENTS = {
  devicesChanged: 'devices:changed',
  sessionChanged: 'sessions:changed',
  notificationNew: 'notification:new',
  workerRun: 'worker:run',
  deviceHeartbeat: 'device:heartbeat',
} as const;
