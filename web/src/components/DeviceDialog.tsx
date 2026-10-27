import { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import type { DeviceView } from '../lib/types';
import { formatDateTime, relativeFrom } from '../lib/format';
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from './ui';

interface DeviceDialogProps {
  open: boolean;
  device: DeviceView | null;
  onClose: () => void;
}

interface FormState {
  name: string;
  type: 'PC' | 'PLAYSTATION';
  controlMode: 'AGENT' | 'MANUAL';
  accessMethod: 'SHELL_REPLACE' | 'SESSION_LOCK' | 'MANUAL';
  location: string;
  notes: string;
  offlineGraceSeconds: string;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: '',
  type: 'PC',
  controlMode: 'AGENT',
  accessMethod: 'SHELL_REPLACE',
  location: '',
  notes: '',
  offlineGraceSeconds: '',
  enabled: true,
};

export function DeviceDialog({ open, device, onClose }: DeviceDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const nameId = useId();
  const locationId = useId();
  const graceId = useId();
  const notesId = useId();

  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<{ code: string; expiresAt: string | null; deviceId: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEnrollment(null);
    setConfirmArchive(false);
    setForm(
      device
        ? {
            name: device.name,
            type: device.type,
            controlMode: device.controlMode,
            accessMethod: device.accessMethod,
            location: device.location ?? '',
            notes: device.notes ?? '',
            offlineGraceSeconds: device.offlineGraceSeconds ? String(device.offlineGraceSeconds) : '',
            enabled: device.enabled,
          }
        : EMPTY,
    );
  }, [open, device]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['devices'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const save = useMutation({
    mutationFn: async (): Promise<{
      device: DeviceView;
      enrollmentCode: string | null;
      enrollmentExpiresAt: string | null;
    }> => {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        controlMode: form.controlMode,
        accessMethod: form.accessMethod,
        location: form.location.trim() || null,
        notes: form.notes.trim() || null,
        offlineGraceSeconds: form.offlineGraceSeconds === '' ? null : Number(form.offlineGraceSeconds),
        enabled: form.enabled,
      };
      if (device) {
        const updated = await api.patch<{ device: DeviceView }>(`/api/devices/${device.id}`, payload);
        return { device: updated.device, enrollmentCode: null, enrollmentExpiresAt: null };
      }
      return api.post<{ device: DeviceView; enrollmentCode: string | null; enrollmentExpiresAt: string | null }>(
        '/api/devices',
        payload,
      );
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(device ? 'Device updated' : 'Device added');
      if (data.enrollmentCode) {
        setEnrollment({
          code: data.enrollmentCode,
          expiresAt: data.enrollmentExpiresAt,
          deviceId: data.device.id,
        });
        return;
      }
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const archive = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/api/devices/${device?.id}/archive`),
    onSuccess: () => {
      invalidate();
      toast.success('Device archived. History is preserved.');
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const restore = useMutation({
    mutationFn: () => api.post<{ device: DeviceView }>(`/api/devices/${device?.id}/restore`),
    onSuccess: () => {
      invalidate();
      toast.success('Device restored');
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const issueEnrollment = useMutation({
    mutationFn: () =>
      api.post<{ enrollmentCode: string; enrollmentExpiresAt: string }>(
        `/api/devices/${device?.id}/enrollment`,
      ),
    onSuccess: (data) => {
      setEnrollment({
        code: data.enrollmentCode,
        expiresAt: data.enrollmentExpiresAt,
        deviceId: device?.id ?? '',
      });
      invalidate();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const toggleMaintenance = useMutation({
    mutationFn: () =>
      api.post<{ device: DeviceView }>(`/api/devices/${device?.id}/maintenance`, {
        maintenance: !device?.maintenance,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(device?.maintenance ? 'Device returned to service' : 'Device set to maintenance');
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const copyCode = async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.code);
      toast.success('Enrollment code copied');
    } catch {
      toast.error('Clipboard unavailable — read the code manually');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={device ? `Manage ${device.name}` : 'Add a device'}
      description={
        device
          ? `${device.type === 'PC' ? 'Windows PC' : 'PlayStation console'} · ${device.controlMode === 'AGENT' ? 'agent managed' : 'staff enforced'}`
          : 'Devices can be added at any time — the number of stations is not fixed.'
      }
      footer={
        enrollment ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
              {device ? 'Save changes' : 'Add device'}
            </Button>
          </>
        )
      }
    >
      {enrollment ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            Enter this one-time code in the agent installer on the PC. It can be used once and
            replaces any previous credential.
          </p>
          <div className="flex flex-col gap-2 rounded-xl border border-accent-500/30 bg-accent-500/10 p-4">
            <span className="font-mono text-xl tracking-[0.15em] text-white">{enrollment.code}</span>
            {enrollment.expiresAt && (
              <span className="text-xs text-slate-400">
                Expires {formatDateTime(enrollment.expiresAt)} IST
              </span>
            )}
          </div>
          <Button size="sm" onClick={copyCode}>
            Copy code
          </Button>
          <div className="rounded-lg border border-white/5 bg-ink-900 p-3">
            <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase">Device ID</p>
            <p className="mt-1 font-mono text-xs break-all text-slate-300">{enrollment.deviceId}</p>
            <p className="mt-2 text-[11px] text-slate-500">
              Use this with the installer: <span className="kbd">-DeviceId</span>
            </p>
          </div>
          <p className="text-xs text-slate-500">
            The code is shown only now. Issue a new one from this dialog if it is lost.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Device name" htmlFor={nameId} hint="Shown on the dashboard, e.g. PC-01">
              <Input
                id={nameId}
                value={form.name}
                maxLength={40}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="PC-01"
              />
            </Field>

            <Field label="Type">
              <Select
                value={form.type}
                onChange={(event) => {
                  const type = event.target.value as FormState['type'];
                  setForm({
                    ...form,
                    type,
                    controlMode: type === 'PLAYSTATION' ? 'MANUAL' : form.controlMode,
                    accessMethod: type === 'PLAYSTATION' ? 'MANUAL' : form.accessMethod,
                  });
                }}
              >
                <option value="PC">Windows PC</option>
                <option value="PLAYSTATION">PlayStation console</option>
              </Select>
            </Field>

            <Field
              label="Control mode"
              hint={
                form.controlMode === 'AGENT'
                  ? 'A Windows agent applies the lock locally'
                  : 'Staff end play manually — no remote lock'
              }
            >
              <Select
                value={form.controlMode}
                onChange={(event) =>
                  setForm({ ...form, controlMode: event.target.value as FormState['controlMode'] })
                }
              >
                <option value="AGENT">Agent managed (PC)</option>
                <option value="MANUAL">Staff assisted (console)</option>
              </Select>
            </Field>

            <Field label="Access method">
              <Select
                value={form.accessMethod}
                onChange={(event) =>
                  setForm({ ...form, accessMethod: event.target.value as FormState['accessMethod'] })
                }
                disabled={form.controlMode === 'MANUAL'}
              >
                <option value="SHELL_REPLACE">Kiosk shell (recommended)</option>
                <option value="SESSION_LOCK">Session lock screen</option>
                <option value="MANUAL">Manual</option>
              </Select>
            </Field>

            <Field label="Location" htmlFor={locationId}>
              <Input
                id={locationId}
                value={form.location}
                maxLength={60}
                onChange={(event) => setForm({ ...form, location: event.target.value })}
                placeholder="Row A · left"
              />
            </Field>

            <Field
              label="Offline grace (seconds)"
              htmlFor={graceId}
              hint="Blank uses the café default"
            >
              <Input
                id={graceId}
                type="number"
                min={0}
                max={86400}
                value={form.offlineGraceSeconds}
                onChange={(event) =>
                  setForm({ ...form, offlineGraceSeconds: event.target.value.replace(/[^\d]/g, '') })
                }
                placeholder="900"
              />
            </Field>
          </div>

          <Field label="Notes" htmlFor={notesId}>
            <Textarea
              id={notesId}
              rows={2}
              maxLength={500}
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
              placeholder="RTX 4070 · 240 Hz"
            />
          </Field>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            Enabled for new sessions
          </label>

          {device && (
            <div className="space-y-3 rounded-xl border border-white/5 bg-ink-900 p-3">
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-slate-500">Connectivity</dt>
                  <dd className="text-slate-300">{device.connectivity.replaceAll('_', ' ').toLowerCase()}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Last heartbeat</dt>
                  <dd className="text-slate-300">{relativeFrom(device.lastHeartbeatAt)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Agent version</dt>
                  <dd className="text-slate-300">{device.agentVersion ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Credential</dt>
                  <dd className="text-slate-300">{device.hasActiveCredential ? 'Enrolled' : 'None'}</dd>
                </div>
              </dl>

              <div className="flex flex-wrap gap-2">
                {device.controlMode === 'AGENT' && (
                  <Button size="sm" onClick={() => issueEnrollment.mutate()} loading={issueEnrollment.isPending}>
                    Issue enrollment code
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => toggleMaintenance.mutate()}
                  loading={toggleMaintenance.isPending}
                >
                  {device.maintenance ? 'Return to service' : 'Set maintenance'}
                </Button>
                {device.archivedAt ? (
                  <Button size="sm" onClick={() => restore.mutate()} loading={restore.isPending}>
                    Restore device
                  </Button>
                ) : confirmArchive ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-rose-300">Archive this device?</span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => archive.mutate()}
                      loading={archive.isPending}
                    >
                      Confirm
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(false)}>
                      No
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setConfirmArchive(true)}>
                    Archive
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                Archiving hides the device and revokes its agent credential; session history stays
                intact. Devices with an active session cannot be archived.
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
