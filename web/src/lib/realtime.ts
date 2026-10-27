import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { SettingsShape } from './types';
import { useToast } from '../components/ui';
import type { NotificationItem } from './types';

/** Ticks once per second for countdown displays. The server value stays authoritative. */
export function useTicker(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type ConnectionState = 'connecting' | 'online' | 'offline';

/**
 * Subscribes to the server's realtime feed and refreshes the affected queries.
 * The dashboard never trusts local state for session timing — every event
 * triggers a refetch so the server remains the single source of truth.
 */
export function useRealtimeFeed(): ConnectionState {
  const queryClient = useQueryClient();
  const toast = useToast();
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: SettingsShape }>('/api/settings'),
    staleTime: 60_000,
    retry: false,
  });
  const soundEnabled = useRef(true);
  soundEnabled.current = settingsQuery.data?.settings.soundNotifications ?? true;

  useEffect(() => {
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setState('online'));
    socket.on('disconnect', () => setState('offline'));
    socket.on('connect_error', () => setState('offline'));

    const refresh = (keys: string[][]) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    };

    socket.on('sessions:changed', () => refresh([['sessions'], ['sessions', 'active'], ['dashboard'], ['devices']]));
    socket.on('devices:changed', () => refresh([['devices'], ['dashboard']]));
    socket.on('device:heartbeat', () => refresh([['devices'], ['dashboard']]));
    socket.on('worker:run', () => refresh([['dashboard'], ['notifications']]));

    socket.on('notification:new', (notification: NotificationItem) => {
      refresh([['notifications'], ['dashboard'], ['sessions'], ['devices']]);
      if (notification.severity === 'CRITICAL') {
        toast.error(notification.title);
        playChime(true);
      } else if (notification.severity === 'WARNING') {
        toast.info(notification.title);
        if (soundEnabled.current) playChime(false);
      }
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [queryClient, toast]);

  return state;
}

/** Short WebAudio blip; no audio asset required and no autoplay prompt. */
function playChime(urgent: boolean) {
  try {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const context = new AudioCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = urgent ? 880 : 660;
    gain.gain.value = 0.05;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (urgent ? 0.28 : 0.16));
    window.setTimeout(() => void context.close(), 600);
  } catch {
    /* Audio is a convenience only. */
  }
}
