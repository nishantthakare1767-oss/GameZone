import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { DeviceView } from '../lib/types';
import { EndSessionDialog, ExtendSessionDialog, StartSessionDialog } from './SessionDialogs';

interface SessionActions {
  start: (device: DeviceView) => void;
  extend: (device: DeviceView, reactivate: boolean) => void;
  end: (device: DeviceView) => void;
}

const SessionActionsContext = createContext<SessionActions | null>(null);

export function SessionActionProvider({ children }: { children: ReactNode }) {
  const [startTarget, setStartTarget] = useState<DeviceView | null>(null);
  const [extendTarget, setExtendTarget] = useState<DeviceView | null>(null);
  const [endTarget, setEndTarget] = useState<DeviceView | null>(null);
  const [reactivate, setReactivate] = useState(false);

  const actions = useMemo<SessionActions>(
    () => ({
      start: (device) => setStartTarget(device),
      extend: (device, shouldReactivate) => {
        setReactivate(shouldReactivate);
        setExtendTarget(device);
      },
      end: (device) => setEndTarget(device),
    }),
    [],
  );

  return (
    <SessionActionsContext.Provider value={actions}>
      {children}
      <StartSessionDialog
        device={startTarget}
        open={startTarget !== null}
        onClose={() => setStartTarget(null)}
      />
      <ExtendSessionDialog
        device={extendTarget}
        reactivate={reactivate}
        open={extendTarget !== null}
        onClose={() => setExtendTarget(null)}
      />
      <EndSessionDialog
        device={endTarget}
        open={endTarget !== null}
        onClose={() => setEndTarget(null)}
      />
    </SessionActionsContext.Provider>
  );
}

export function useSessionActions(): SessionActions {
  const context = useContext(SessionActionsContext);
  if (!context) throw new Error('useSessionActions must be used inside SessionActionProvider');
  return context;
}
