import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';

export interface SignInProvider {
  id: string;
  name: string;
  discoveryUrl: string;
  clientId: string;
  scope: string;
  requiredClaimName: string | null;
  requiredClaimValues: string[];
  groupsClaim: string | null;
  redirectUri: string;
  environmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SignInProviderOption {
  id: string;
  name: string;
}

export interface SaveSignInProviderDto {
  name?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  requiredClaimName?: string | null;
  requiredClaimValues?: string[];
  groupsClaim?: string | null;
}

export const signInProviderKeys = {
  all: ['sign-in-providers'] as const,
  list: () => [...signInProviderKeys.all, 'list'] as const,
  options: () => [...signInProviderKeys.all, 'options'] as const,
};

export function useSignInProviders() {
  return createAppQuery(() => ({
    queryKey: signInProviderKeys.list(),
    queryFn: () => api.get<SignInProvider[]>('/sign-in-providers'),
  }));
}

export function useSignInProviderOptions() {
  return createAppQuery(() => ({
    queryKey: signInProviderKeys.options(),
    queryFn: () => api.get<SignInProviderOption[]>('/sign-in-providers/options'),
  }));
}

export function useCreateSignInProvider() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (dto: SaveSignInProviderDto) => api.post<SignInProvider>('/sign-in-providers', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: signInProviderKeys.all }),
  }));
}

export function useUpdateSignInProvider() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: ({ id, dto }: { id: string; dto: SaveSignInProviderDto }) =>
      api.patch<SignInProvider>(`/sign-in-providers/${id}`, dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: signInProviderKeys.all }),
  }));
}

export function useDeleteSignInProvider() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/sign-in-providers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: signInProviderKeys.all }),
  }));
}
