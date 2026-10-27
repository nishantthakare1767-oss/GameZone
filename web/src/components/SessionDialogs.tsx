import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, errorMessage, newIdempotencyKey } from '../lib/api';
import type { DeviceView, SessionView, SettingsShape } from '../lib/types';
import { formatMinutes, formatTime } from '../lib/format';
import { Button, Dialog, Field, Input, Select, useToast } from './ui';

function useInvalidateAll() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['devices'] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    void queryClient.invalidateQueries({ queryKey: ['device'] });
  };
}

function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: SettingsShape }>('/api/settings'),
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

export function StartSessionDialog({
  device,
  open,
  onClose,
}: {
  device: DeviceView | null;
  open: boolean;
  onClose: () => void;
}) {
  const settings = useSettings();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const nicknameId = useId();
  const customId = useId();
  const presets = settings.data?.settings.sessionDurations ?? [30, 60, 90, 120, 180];
  const min = settings.data?.settings.minSessionMinutes ?? 5;
  const max = settings.data?.settings.maxSessionMinutes ?? 720;

  const [minutes, setMinutes] = useState<number>(presets[0] ?? 60);
  const [custom, setCustom] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMinutes(presets[0] ?? 60);
    setCustom('');
    setNickname('');
    setError(null);
  }, [open, device?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const finalMinutes = custom.trim() === '' ? minutes : Number(custom);

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ session: SessionView }>('/api/sessions', {
        deviceId: device?.id,
        durationMinutes: finalMinutes,
        customerNickname: nickname.trim() || null,
      }),
    onSuccess: (data) => {
      toast.success(`Session started on ${data.session.deviceName} — ends ${formatTime(data.session.expiresAt)} IST`);
      invalidate();
      onClose();
    },
    onError: (caught) => {
      setError(errorMessage(caught));
    },
  });

  const submit = () => {
    setError(null);
    if (!Number.isInteger(finalMinutes) || finalMinutes < min || finalMinutes > max) {
      setError(`Duration must be between ${min} and ${max} minutes`);
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Start session${device ? ` · ${device.name}` : ''}`}
      description="The server sets the expiry time. Closing this browser does not stop the timer."
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={mutation.isPending}>
            Start session
          </Button>
        </>
      }
    >
      <div>
        <span className="label">Quick durations</span>
        <div className="flex flex-wrap gap-2">
          {presets.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMinutes(value);
                setCustom('');
              }}
              aria-pressed={custom === '' && minutes === value}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                custom === '' && minutes === value
                  ? 'border-accent-500 bg-accent-500/20 text-white'
                  : 'border-ink-600 text-slate-300 hover:border-ink-500'
              }`}
            >
              {formatMinutes(value)}
            </button>
          ))}
        </div>
      </div>

      <Field label="Custom duration (minutes)" htmlFor={customId} hint={`Between ${min} and ${max} minutes`}>
        <Input
          id={customId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          placeholder="e.g. 75"
          value={custom}
          onChange={(event) => setCustom(event.target.value.replace(/[^\d]/g, ''))}
        />
      </Field>

      <Field label="Customer nickname (optional)" htmlFor={nicknameId}>
        <Input
          id={nicknameId}
          maxLength={40}
          placeholder="Shadow"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
        />
      </Field>

      <p className="rounded-lg border border-white/5 bg-ink-900 px-3 py-2 text-sm text-slate-400">
        Expires at{' '}
        <span className="font-mono text-slate-200">
          {formatTime(new Date(Date.now() + finalMinutes * 60_000))} IST
        </span>
      </p>

      {error && (
        <p className="text-sm text-rose-300" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Extend                                                              */
/* ------------------------------------------------------------------ */

export function ExtendSessionDialog({
  device,
  reactivate,
  open,
  onClose,
}: {
  device: DeviceView | null;
  reactivate: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const settings = useSettings();
  const customId = useId();
  const noteId = useId();
  const max = settings.data?.settings.maxExtensionMinutes ?? 240;

  const [minutes, setMinutes] = useState(30);
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useMemo(
    () => newIdempotencyKey('extend'),
    // A new key per dialog opening, so a genuine retry reuses it.
    [open, device?.session?.id],
  );

  useEffect(() => {
    if (!open) return;
    setMinutes(30);
    setCustom('');
    setNote('');
    setError(null);
  }, [open, device?.session?.id]);

  const finalMinutes = custom.trim() === '' ? minutes : Number(custom);
  const session = device?.session ?? null;

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ session: SessionView; replayed: boolean }>(`/api/sessions/${session?.id}/extend`, {
        minutes: finalMinutes,
        idempotencyKey,
        reactivate,
        note: note.trim() || null,
      }),
    onSuccess: (data) => {
      toast.success(
        data.replayed
          ? 'That extension was already applied — no time was added twice.'
          : `${finalMinutes} minutes added to ${data.session.deviceName}`,
      );
      invalidate();
      onClose();
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.code === 'REACTIVATION_REQUIRED') {
        setError('This session expired. Close this dialog and use Reactivate.');
        return;
      }
      setError(errorMessage(caught));
    },
  });

  const submit = () => {
    setError(null);
    if (!Number.isInteger(finalMinutes) || finalMinutes < 1 || finalMinutes > max) {
      setError(`Extension must be between 1 and ${max} minutes`);
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${reactivate ? 'Reactivate' : 'Extend'} session · ${device?.name ?? ''}`}
      description={
        reactivate
          ? 'Time restarts from now and the device agent is re-authorised. Expired minutes are not credited.'
          : session
            ? `Currently expires ${formatTime(session.expiresAt)} IST`
            : undefined
      }
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={mutation.isPending}>
            {reactivate ? 'Reactivate' : 'Add time'}
          </Button>
        </>
      }
    >
      <div>
        <span className="label">Additional time</span>
        <div className="flex flex-wrap gap-2">
          {[15, 30, 60, 120].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMinutes(value);
                setCustom('');
              }}
              aria-pressed={custom === '' && minutes === value}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                custom === '' && minutes === value
                  ? 'border-accent-500 bg-accent-500/20 text-white'
                  : 'border-ink-600 text-slate-300 hover:border-ink-500'
              }`}
            >
              +{formatMinutes(value)}
            </button>
          ))}
        </div>
      </div>

      <Field label="Custom minutes" htmlFor={customId} hint={`Up to ${max} minutes`}>
        <Input
          id={customId}
          type="number"
          inputMode="numeric"
          value={custom}
          onChange={(event) => setCustom(event.target.value.replace(/[^\d]/g, ''))}
          placeholder="e.g. 45"
        />
      </Field>

      <Field label="Note (optional)" htmlFor={noteId}>
        <Input
          id={noteId}
          maxLength={200}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Customer requested extra time"
        />
      </Field>

      <p className="text-xs text-slate-500">
        Extension reference <span className="kbd">{idempotencyKey.slice(0, 18)}…</span> prevents
        double-adding time if the request is retried.
      </p>

      {error && (
        <p className="text-sm text-rose-300" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* End                                                                 */
/* ------------------------------------------------------------------ */

const END_REASONS = [
  'Customer finished early',
  'Time completed',
  'Device problem',
  'Staff override',
  'Customer asked to stop',
];

export function EndSessionDialog({
  device,
  open,
  onClose,
}: {
  device: DeviceView | null;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const customId = useId();
  const [reason, setReason] = useState(END_REASONS[0]!);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const session = device?.session ?? null;

  useEffect(() => {
    if (!open) return;
    setReason(END_REASONS[0]!);
    setCustom('');
    setError(null);
  }, [open, device?.id]);

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ session: SessionView }>(`/api/sessions/${session?.id}/end`, {
        reason: custom.trim() || reason,
      }),
    onSuccess: (data) => {
      toast.success(`Session on ${data.session.deviceName} ended`);
      invalidate();
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`End session · ${device?.name ?? ''}`}
      description="Ending early releases the station immediately. The reason is stored in session history."
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => mutation.mutate()} loading={mutation.isPending}>
            End session
          </Button>
        </>
      }
    >
      <Field label="Reason">
        <Select value={reason} onChange={(event) => setReason(event.target.value)}>
          {END_REASONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Custom reason (optional)" htmlFor={customId} hint="Overrides the selection above">
        <Input
          id={customId}
          maxLength={200}
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Customer left for a tournament"
        />
      </Field>

      {error && (
        <p className="text-sm text-rose-300" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
