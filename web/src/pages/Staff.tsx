import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import type { StaffMember } from '../lib/types';
import { formatDateTime, relativeFrom } from '../lib/format';
import { useAuth, useIsAdmin } from '../lib/session';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  useToast,
} from '../components/ui';

export function StaffPage() {
  const isAdmin = useIsAdmin();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<StaffMember | null>(null);

  const staff = useQuery({
    queryKey: ['staff'],
    queryFn: () => api.get<{ items: StaffMember[] }>('/api/staff'),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['staff'] });

  const toggleActive = useMutation({
    mutationFn: (member: StaffMember) =>
      api.patch<{ ok: boolean }>(`/api/staff/${member.id}`, { isActive: !member.isActive }),
    onSuccess: (_data, member) => {
      toast.success(`${member.displayName} ${member.isActive ? 'deactivated' : 'reactivated'}`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const changeRole = useMutation({
    mutationFn: (member: StaffMember) =>
      api.patch<{ ok: boolean }>(`/api/staff/${member.id}`, {
        role: member.role === 'ADMIN' ? 'STAFF' : 'ADMIN',
      }),
    onSuccess: () => {
      toast.success('Role updated');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Staff</h1>
          <p className="mt-1 text-sm text-slate-400">
            {isAdmin
              ? 'Administrators manage accounts, devices and policies. Staff run sessions.'
              : 'Read-only roster — administrators manage accounts.'}
          </p>
        </div>
        {isAdmin && (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Add staff account
          </Button>
        )}
      </header>

      {staff.isError ? (
        <ErrorState message="Could not load staff." onRetry={() => void staff.refetch()} />
      ) : staff.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : staff.data?.items.length === 0 ? (
        <Card>
          <EmptyState title="No staff accounts" description="Add the first staff account to begin." />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead className="bg-ink-900/60">
              <tr>
                <th className="th">Name</th>
                <th className="th">Username</th>
                <th className="th">Role</th>
                <th className="th">Status</th>
                <th className="th">Last sign-in</th>
                {isAdmin && <th className="th text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {staff.data!.items.map((member) => (
                <tr key={member.id} className="border-t border-white/5">
                  <td className="td font-medium text-white">
                    {member.displayName}
                    {member.id === user?.id && <span className="ml-2 text-xs text-slate-500">(you)</span>}
                  </td>
                  <td className="td font-mono text-xs text-slate-400">{member.username}</td>
                  <td className="td">
                    <span
                      className={`chip ${
                        member.role === 'ADMIN'
                          ? 'border-accent-400/40 bg-accent-500/10 text-accent-200'
                          : 'border-ink-600 bg-ink-800 text-slate-300'
                      }`}
                    >
                      {member.role}
                    </span>
                  </td>
                  <td className="td">
                    <span className={member.isActive ? 'text-emerald-300' : 'text-slate-500'}>
                      {member.isActive ? 'Active' : 'Deactivated'}
                    </span>
                  </td>
                  <td className="td text-slate-400">
                    {member.lastLoginAt ? relativeFrom(member.lastLoginAt) : 'never'}
                  </td>
                  {isAdmin && (
                    <td className="td">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => changeRole.mutate(member)}>
                          Make {member.role === 'ADMIN' ? 'staff' : 'admin'}
                        </Button>
                        <Button size="sm" onClick={() => setResetTarget(member)}>
                          Reset password
                        </Button>
                        <Button
                          size="sm"
                          variant={member.isActive ? 'danger' : 'secondary'}
                          onClick={() => toggleActive.mutate(member)}
                          disabled={member.id === user?.id}
                        >
                          {member.isActive ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateStaffDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ResetPasswordDialog member={resetTarget} onClose={() => setResetTarget(null)} />
    </div>
  );
}

function CreateStaffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const usernameId = useId();
  const nameId = useId();
  const passwordId = useId();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'STAFF' | 'ADMIN'>('STAFF');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/staff', {
        username: username.trim(),
        displayName: displayName.trim(),
        role,
        password,
      }),
    onSuccess: () => {
      toast.success('Staff account created');
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      setUsername('');
      setDisplayName('');
      setPassword('');
      setRole('STAFF');
      setError(null);
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add staff account"
      description="New accounts must change this password at first sign-in."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending}>
            Create account
          </Button>
        </>
      }
    >
      <Field label="Display name" htmlFor={nameId}>
        <Input id={nameId} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </Field>
      <Field label="Username" htmlFor={usernameId} hint="Letters, numbers, dot, dash or underscore">
        <Input id={usernameId} value={username} onChange={(event) => setUsername(event.target.value)} />
      </Field>
      <Field label="Role">
        <Select value={role} onChange={(event) => setRole(event.target.value as 'STAFF' | 'ADMIN')}>
          <option value="STAFF">Staff — run sessions</option>
          <option value="ADMIN">Administrator — full control</option>
        </Select>
      </Field>
      <Field
        label="Temporary password"
        htmlFor={passwordId}
        hint="At least 10 characters with upper, lower and a number"
      >
        <Input
          id={passwordId}
          type="text"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
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

function ResetPasswordDialog({ member, onClose }: { member: StaffMember | null; onClose: () => void }) {
  const toast = useToast();
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>(`/api/staff/${member?.id}/reset-password`, { newPassword: password }),
    onSuccess: () => {
      toast.success(`Password reset for ${member?.displayName}. All their sessions were signed out.`);
      setPassword('');
      setError(null);
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      open={member !== null}
      onClose={onClose}
      title={`Reset password · ${member?.displayName ?? ''}`}
      description={`Last sign-in ${member?.lastLoginAt ? formatDateTime(member.lastLoginAt) : 'never'}`}
      footer={
        <>
          <Button onClick={onClose} disabled={reset.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => reset.mutate()} loading={reset.isPending}>
            Reset password
          </Button>
        </>
      }
    >
      <Field label="New password" htmlFor={passwordId}>
        <Input
          id={passwordId}
          type="text"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
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
