import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<{ user: User }>('/api/auth/me')).user,
    retry: false,
    staleTime: 30_000,
  });

  const loginMutation = useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      api.post<{ user: User }>('/api/auth/login', input),
    onSuccess: (data) => {
      queryClient.setQueryData(['me'], data.user);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(['me'], null);
    },
  });

  const value = useMemo<AuthState>(
    () => ({
      user: me.data ?? null,
      isLoading: me.isLoading,
      login: async (username, password) => {
        await loginMutation.mutateAsync({ username, password });
      },
      logout: async () => {
        await logoutMutation.mutateAsync();
      },
    }),
    [me.data, me.isLoading, loginMutation, logoutMutation],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-slate-400">Loading GameHub…</div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function useIsAdmin(): boolean {
  return useAuth().user?.role === 'ADMIN';
}
