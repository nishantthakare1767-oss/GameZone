import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import type { IntegrationView, SettingsShape } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { useIsAdmin } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  useToast,
} from '../components/ui';

interface SettingsResponse {
  settings: SettingsShape;
  defaults: SettingsShape;
  serverTime: string;
}

interface AuditResponse {
  items: {
    id: string;
    actorLabel: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    outcome: string;
    ip: string | null;
    createdAt: string;
  }[];
  total: number;
}

interface HealthResponse {
  ok: boolean;
  serverTime: string;
  database: string;
  expiryWorker: { lastRunAt: string | null; lastStatus: string; lastProcessed: number };
}

export function SettingsPage() {
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<SettingsShape | null>(null);
  const [auditAction, setAuditAction] = useState('');

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsResponse>('/api/settings'),
  });

  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.get<{ items: IntegrationView[] }>('/api/integrations'),
  });

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthResponse>('/api/health'),
    refetchInterval: 30_000,
  });

  const audit = useQuery({
    queryKey: ['audit', auditAction],
    queryFn: () =>
      api.get<AuditResponse>(
        `/api/audit?limit=40${auditAction.trim() ? `&action=${encodeURIComponent(auditAction.trim())}` : ''}`,
      ),
    enabled: isAdmin,
  });

  useEffect(() => {
    if (settings.data && draft === null) setDraft(settings.data.settings);
  }, [settings.data, draft]);

  const save = useMutation({
    mutationFn: (patch: Partial<SettingsShape>) => api.patch<{ settings: SettingsShape }>('/api/settings', patch),
    onSuccess: (data) => {
      setDraft(data.settings);
      toast.success('Settings saved');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const updateIntegration = useMutation({
    mutationFn: (input: { id: string; enabled?: boolean; adapter?: string; baseUrl?: string }) =>
      api.patch<{ items: IntegrationView[] }>(`/api/integrations/${input.id}`, {
        enabled: input.enabled,
        adapter: input.adapter,
        baseUrl: input.baseUrl,
      }),
    onSuccess: () => {
      toast.success('Integration updated');
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (settings.isError) {
    return <ErrorState message="Could not load settings." onRetry={() => void settings.refetch()} />;
  }
  if (settings.isLoading || !draft) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-40" />
        ))}
      </div>
    );
  }

  const set = <K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) =>
    setDraft({ ...draft, [key]: value });

  const numberField = (key: keyof SettingsShape, label: string, hint: string, min = 1, max = 86400) => (
    <Field key={key} label={label} hint={hint} htmlFor={`setting-${key}`}>
      <Input
        id={`setting-${key}`}
        type="number"
        min={min}
        max={max}
        disabled={!isAdmin}
        value={String(draft[key])}
        onChange={(event) => {
          const value = Number(event.target.value.replace(/[^\d]/g, ''));
          set(key, value as SettingsShape[typeof key]);
        }}
      />
    </Field>
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          {isAdmin ? 'Changes take effect immediately for new sessions.' : 'Read-only — administrators can change these.'}
        </p>
      </header>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-white">Session policy</h2>
        <p className="mt-1 text-xs text-slate-400">
          Durations are enforced by the server; clients cannot bypass them.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Café name" htmlFor="setting-cafeName">
            <Input
              id="setting-cafeName"
              value={draft.cafeName}
              disabled={!isAdmin}
              onChange={(event) => set('cafeName', event.target.value)}
            />
          </Field>
          <Field label="Minimum session (minutes)" htmlFor="setting-min">
            <Input
              id="setting-min"
              type="number"
              min={1}
              max={720}
              disabled={!isAdmin}
              value={draft.minSessionMinutes}
              onChange={(event) => set('minSessionMinutes', Number(event.target.value.replace(/[^\d]/g, '')))}
            />
          </Field>
          {numberField('maxSessionMinutes', 'Maximum session (minutes)', 'Caps a single booking', 5, 1440)}
          {numberField('maxExtensionMinutes', 'Maximum extension (minutes)', 'Per extension request', 1, 720)}
          {numberField('expiringSoonMinutes', 'First warning (minutes before expiry)', 'Dashboard + notification', 1, 60)}
          {numberField('expiringWarningMinutes', 'Final warning (minutes before expiry)', 'Critical alert', 1, 30)}
          {numberField('deviceOfflineAfterSeconds', 'Device offline after (seconds)', 'No heartbeat threshold', 15, 3600)}
          {numberField('agentGraceSeconds', 'Agent offline grace (seconds)', 'How long a PC keeps its last authorization', 0, 86400)}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <ToggleRow
            label="Allow extending expired sessions"
            description="Requires an explicit ‘reactivate’ confirmation from staff."
            checked={draft.allowExtensionAfterExpiry}
            disabled={!isAdmin}
            onChange={(checked) => set('allowExtensionAfterExpiry', checked)}
          />
          <ToggleRow
            label="Block sessions when a PC agent is offline"
            description="Stricter policy: no session starts without a live agent."
            checked={draft.blockOfflineDeviceSessions}
            disabled={!isAdmin}
            onChange={(checked) => set('blockOfflineDeviceSessions', checked)}
          />
          <ToggleRow
            label="Sound alerts"
            description="Chime for warnings and critical alerts in this browser."
            checked={draft.soundNotifications}
            disabled={!isAdmin}
            onChange={(checked) => set('soundNotifications', checked)}
          />
          <ToggleRow
            label="Consoles require staff enforcement"
            description="Always on for retail consoles without a verified remote lock."
            checked={draft.requireStaffAssistedConsoles}
            disabled
            onChange={() => undefined}
          />
        </div>

        {isAdmin && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() =>
                save.mutate({
                  cafeName: draft.cafeName,
                  minSessionMinutes: draft.minSessionMinutes,
                  maxSessionMinutes: draft.maxSessionMinutes,
                  maxExtensionMinutes: draft.maxExtensionMinutes,
                  expiringSoonMinutes: draft.expiringSoonMinutes,
                  expiringWarningMinutes: draft.expiringWarningMinutes,
                  deviceOfflineAfterSeconds: draft.deviceOfflineAfterSeconds,
                  agentGraceSeconds: draft.agentGraceSeconds,
                  allowExtensionAfterExpiry: draft.allowExtensionAfterExpiry,
                  blockOfflineDeviceSessions: draft.blockOfflineDeviceSessions,
                  soundNotifications: draft.soundNotifications,
                })
              }
              loading={save.isPending}
            >
              Save settings
            </Button>
            <Button onClick={() => setDraft(settings.data!.settings)} disabled={save.isPending}>
              Reset changes
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-white">PlayStation integration</h2>
        {integrations.isLoading ? (
          <Skeleton className="mt-3 h-24" />
        ) : (
          integrations.data?.items.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              isAdmin={isAdmin}
              busy={updateIntegration.isPending}
              onSave={(input) => updateIntegration.mutate({ id: integration.id, ...input })}
            />
          ))
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-white">System health</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Database</dt>
            <dd className="text-slate-200">{health.data?.database ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Expiry worker</dt>
            <dd className="text-slate-200">
              {health.data?.expiryWorker.lastStatus ?? '—'}
              {health.data?.expiryWorker.lastRunAt
                ? ` · ${formatDateTime(health.data.expiryWorker.lastRunAt)}`
                : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Last processed</dt>
            <dd className="text-slate-200">{health.data?.expiryWorker.lastProcessed ?? 0} items</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Server time (UTC)</dt>
            <dd className="text-slate-200">{health.data ? formatDateTime(health.data.serverTime) : '—'} IST</dd>
          </div>
        </dl>
        <p className="mt-4 rounded-lg border border-white/5 bg-ink-900 p-3 text-xs leading-relaxed text-slate-400">
          Backups: run <span className="kbd">npm run backup</span> on the café server (writes a
          compressed JSON snapshot to <span className="kbd">backups/</span>). Restore with{' '}
          <span className="kbd">npm run restore -- &lt;file&gt;</span>. Schedule the backup task nightly;
          see <span className="kbd">docs/backup-restore.md</span>.
        </p>
      </Card>

      {isAdmin && (
        <Card className="p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Audit log</h2>
              <p className="mt-1 text-xs text-slate-400">
                {audit.data?.total ?? 0} events · actor, action, target and outcome
              </p>
            </div>
            <Field label="Filter by action" htmlFor="audit-filter">
              <Input
                id="audit-filter"
                placeholder="SESSION_EXTEND"
                value={auditAction}
                onChange={(event) => setAuditAction(event.target.value)}
              />
            </Field>
          </div>

          {audit.isError ? (
            <ErrorState message="Could not load the audit log." onRetry={() => void audit.refetch()} />
          ) : audit.isLoading ? (
            <Skeleton className="mt-3 h-32" />
          ) : (audit.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No audit events match" description="Clear the filter to see everything." />
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Actor</th>
                    <th className="th">Action</th>
                    <th className="th">Target</th>
                    <th className="th">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data!.items.map((entry) => (
                    <tr key={entry.id} className="border-t border-white/5">
                      <td className="td whitespace-nowrap">{formatDateTime(entry.createdAt)}</td>
                      <td className="td">{entry.actorLabel}</td>
                      <td className="td font-mono text-xs">{entry.action}</td>
                      <td className="td text-slate-400">
                        {entry.targetType ?? '—'}
                        {entry.targetId ? ` · ${entry.targetId.slice(0, 8)}` : ''}
                      </td>
                      <td className="td">
                        <span
                          className={
                            entry.outcome === 'SUCCESS'
                              ? 'text-emerald-300'
                              : entry.outcome === 'DENIED'
                                ? 'text-amber-300'
                                : 'text-rose-300'
                          }
                        >
                          {entry.outcome.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-white/5 bg-ink-900 p-3">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
    </label>
  );
}

function IntegrationCard({
  integration,
  isAdmin,
  busy,
  onSave,
}: {
  integration: IntegrationView;
  isAdmin: boolean;
  busy: boolean;
  onSave: (input: { enabled?: boolean; adapter?: string; baseUrl?: string }) => void;
}) {
  const adapterId = useId();
  const baseUrlId = useId();
  const [adapter, setAdapter] = useState((integration.config.adapter as string) ?? 'manual-staff-enforcement');
  const [baseUrl, setBaseUrl] = useState((integration.config.baseUrl as string) ?? '');

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-white/5 bg-ink-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-white">{integration.name}</p>
          <p className="text-xs text-slate-400">{integration.notes}</p>
        </div>
        <span
          className={`chip ${
            integration.status === 'MANUAL_ENFORCEMENT'
              ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
              : 'border-rose-400/40 bg-rose-500/10 text-rose-200'
          }`}
        >
          {integration.status.replaceAll('_', ' ').toLowerCase()}
        </span>
      </div>

      <ul className="grid gap-1 text-xs text-slate-400 sm:grid-cols-2">
        <li>Automatic lock: {integration.capabilities.automaticLock ? 'yes' : 'no — staff enforced'}</li>
        <li>Verified on hardware: {integration.capabilities.verified ? 'yes' : 'not verified'}</li>
        <li>Connectivity reporting: {integration.capabilities.connectivity ? 'yes' : 'no'}</li>
        <li>App control: {integration.capabilities.appControl ? 'yes' : 'no'}</li>
      </ul>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Adapter" htmlFor={adapterId}>
          <Select
            id={adapterId}
            value={adapter}
            disabled={!isAdmin}
            onChange={(event) => setAdapter(event.target.value)}
          >
            <option value="manual-staff-enforcement">Manual staff enforcement (verified)</option>
            <option value="http-bridge">Venue bridge over HTTP (unverified)</option>
          </Select>
        </Field>
        {adapter === 'http-bridge' && (
          <Field label="Bridge base URL" htmlFor={baseUrlId}>
            <Input
              id={baseUrlId}
              placeholder="http://10.0.0.20:8080"
              value={baseUrl}
              disabled={!isAdmin}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
        )}
      </div>

      {isAdmin && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => onSave({ adapter, baseUrl: baseUrl || undefined })}
          >
            Save adapter
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onSave({ enabled: !integration.enabled })}
          >
            {integration.enabled ? 'Disable integration' : 'Enable integration'}
          </Button>
        </div>
      )}
    </div>
  );
}
