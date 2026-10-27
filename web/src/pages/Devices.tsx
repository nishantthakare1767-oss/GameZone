import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { DeviceView } from '../lib/types';
import { DEFAULT_FILTERS, filterDevices, type DeviceFilterState } from '../lib/deviceFilters';
import { useTicker } from '../lib/realtime';
import { useIsAdmin } from '../lib/session';
import { DeviceCard } from '../components/DeviceCard';
import { DeviceDialog } from '../components/DeviceDialog';
import { useSessionActions } from '../components/SessionActionHost';
import { Button, Card, EmptyState, ErrorState, Input, Select, Skeleton } from '../components/ui';

export function DevicesPage() {
  const isAdmin = useIsAdmin();
  const actions = useSessionActions();
  const now = useTicker(1000);
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<DeviceFilterState>(DEFAULT_FILTERS);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DeviceView | null>(null);

  const devices = useQuery({
    queryKey: ['devices', { includeArchived }],
    queryFn: () =>
      api.get<{ items: DeviceView[] }>(`/api/devices${includeArchived ? '?includeArchived=true' : ''}`),
    refetchInterval: 20_000,
  });

  const visible = useMemo(
    () => filterDevices(devices.data?.items ?? [], filters),
    [devices.data, filters],
  );

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openManage = (device: DeviceView) => {
    setEditing(device);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Devices</h1>
          <p className="mt-1 text-sm text-slate-400">
            {devices.data?.items.length ?? 0} stations · add as many as the café grows to
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Show archived
          </label>
          {isAdmin && (
            <Button variant="primary" onClick={openCreate}>
              Add device
            </Button>
          )}
        </div>
      </header>

      <Card className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
        <Input
          aria-label="Search devices"
          placeholder="Search name, customer or location"
          value={filters.search}
          onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          className="sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="Filter by status"
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value as DeviceFilterState['status'] })
            }
            className="w-auto"
          >
            <option value="ALL">All statuses</option>
            <option value="AVAILABLE">Available</option>
            <option value="ACTIVE">In session</option>
            <option value="EXPIRING_SOON">Expiring soon</option>
            <option value="EXPIRED">Time expired</option>
            <option value="RESTRICTED">Restricted</option>
            <option value="MAINTENANCE">Maintenance</option>
            <option value="ERROR">Agent error</option>
            <option value="DISABLED">Disabled</option>
          </Select>
          <Select
            aria-label="Filter by type"
            value={filters.type}
            onChange={(event) =>
              setFilters({ ...filters, type: event.target.value as DeviceFilterState['type'] })
            }
            className="w-auto"
          >
            <option value="ALL">All types</option>
            <option value="PC">PCs</option>
            <option value="PLAYSTATION">Consoles</option>
          </Select>
          <Select
            aria-label="Sort devices"
            value={filters.sort}
            onChange={(event) =>
              setFilters({ ...filters, sort: event.target.value as DeviceFilterState['sort'] })
            }
            className="w-auto"
          >
            <option value="NAME">Sort: name</option>
            <option value="STATUS">Sort: attention first</option>
            <option value="EXPIRY">Sort: next to expire</option>
            <option value="HEARTBEAT">Sort: last heartbeat</option>
          </Select>
        </div>
      </Card>

      {devices.isError ? (
        <ErrorState
          message="Could not load devices."
          onRetry={() => void queryClient.invalidateQueries({ queryKey: ['devices'] })}
        />
      ) : devices.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-64" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title="No devices to show"
            description={
              isAdmin
                ? 'Add a PC or console to start managing sessions.'
                : 'Ask an administrator to register devices.'
            }
            action={isAdmin ? <Button variant="primary" onClick={openCreate}>Add device</Button> : null}
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {visible.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              now={now}
              actions={{
                onStart: actions.start,
                onExtend: actions.extend,
                onEnd: actions.end,
                onManage: isAdmin ? openManage : undefined,
              }}
            />
          ))}
        </div>
      )}

      <DeviceDialog open={dialogOpen} device={editing} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
