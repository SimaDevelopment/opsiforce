import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Spinner } from '~/components/ui/spinner';
import type { ProjectAuthMode, ProjectAuthOidcConfig } from '~/api/client';
import { AuthModeSelector } from './auth-mode-selector';
import { OidcForm } from './oidc-form';
import { BypassPathsEditor } from './bypass-paths-editor';
import { SignInProviderPicker } from './sign-in-provider-picker';
import { useSignInProviderOptions } from '~/api/sign-in-providers';
import { useProjectAuth } from './use-project-auth';

export interface ProjectAuthTabProps {
  projectId: string;
  environmentId: string;
  disabled?: boolean;
  onSaved?: () => void;
}

const EMPTY_CONFIG: ProjectAuthOidcConfig = {
  scope: 'openid profile email',
};

function configsEqual(a: ProjectAuthOidcConfig, b: ProjectAuthOidcConfig): boolean {
  const keys: (keyof ProjectAuthOidcConfig)[] = [
    'clientId',
    'clientSecret',
    'discoveryUrl',
    'scope',
    'forwardAccessToken',
  ];
  return keys.every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function validationError(
  mode: ProjectAuthMode,
  config: ProjectAuthOidcConfig,
  serverHasExistingConfig: boolean,
  signInProviderId: string | null
): string | null {
  if (mode === 'provider') return signInProviderId ? null : 'Choose a sign-in provider';
  if (mode !== 'manual') return null;
  if (!config.clientId?.trim()) return 'Client Id is required';
  if (!serverHasExistingConfig && !config.clientSecret?.trim()) {
    return 'Client Secret is required';
  }
  if (!config.discoveryUrl?.trim()) {
    return 'Discovery URL is required';
  }
  return null;
}

export function ProjectAuthTab(props: ProjectAuthTabProps) {
  const projectId = () => props.projectId;
  const environmentId = () => props.environmentId;
  const { query, mutation } = useProjectAuth(projectId, environmentId);

  const [draftMode, setDraftMode] = createSignal<ProjectAuthMode>('public');
  const [draftConfig, setDraftConfig] = createSignal<ProjectAuthOidcConfig>(EMPTY_CONFIG);
  const [draftBypassPaths, setDraftBypassPaths] = createSignal<string[]>([]);
  const [draftProviderId, setDraftProviderId] = createSignal<string | null>(null);
  const [draftProviderForward, setDraftProviderForward] = createSignal(false);
  const providerOptions = useSignInProviderOptions({ enabled: () => draftMode() === 'provider' });
  const [saveAttempted, setSaveAttempted] = createSignal(false);
  const [confirmOpen, setConfirmOpen] = createSignal(false);

  createEffect(() => {
    const data = query.data;
    if (!data) return;
    setDraftMode(data.mode);
    setDraftConfig(data.config ?? EMPTY_CONFIG);
    setDraftBypassPaths(data.bypassAuthPaths ?? []);
    setDraftProviderId(data.signInProviderId ?? null);
    setDraftProviderForward(data.mode === 'provider' && (data.config?.forwardAccessToken ?? false));
    setSaveAttempted(false);
  });

  const serverMode = () => query.data?.mode ?? 'public';
  const serverConfig = () => query.data?.config ?? EMPTY_CONFIG;
  const serverBypassPaths = () => query.data?.bypassAuthPaths ?? [];
  const serverProviderId = () => query.data?.signInProviderId ?? null;
  const serverProviderForward = () =>
    query.data?.mode === 'provider' && (query.data.config?.forwardAccessToken ?? false);
  const providerName = () =>
    providerOptions.data?.find((option) => option.id === draftProviderId())?.name ?? 'the chosen provider';

  const dirty = createMemo(() => {
    if (draftMode() !== serverMode()) return true;
    if (draftMode() === 'manual' && !configsEqual(draftConfig(), serverConfig())) return true;
    if (draftMode() === 'provider' && draftProviderId() !== serverProviderId()) return true;
    if (draftMode() === 'provider' && draftProviderForward() !== serverProviderForward()) return true;
    if (draftMode() !== 'public' && !arraysEqual(draftBypassPaths(), serverBypassPaths())) return true;
    return false;
  });

  const serverHasExistingConfig = () => query.data?.mode === 'manual';
  const error = createMemo(() =>
    validationError(draftMode(), draftConfig(), serverHasExistingConfig(), draftProviderId())
  );

  const requestSave = () => {
    setSaveAttempted(true);
    const err = error();
    if (err) {
      toast.error(err);
      return;
    }
    setConfirmOpen(true);
  };

  const confirmSave = () => {
    const mode = draftMode();
    mutation.mutate(
      {
        mode,
        signInProviderId: mode === 'provider' ? (draftProviderId() ?? undefined) : undefined,
        config:
          mode === 'manual'
            ? draftConfig()
            : mode === 'provider'
              ? { forwardAccessToken: draftProviderForward() }
              : undefined,
        bypassAuthPaths: mode === 'public' ? undefined : draftBypassPaths(),
      },
      {
        onSuccess: () => {
          toast.success('Auth settings saved');
          props.onSaved?.();
        },
        onError: (e) => toast.error(`Failed to save: ${(e as Error).message}`),
      }
    );
  };

  const confirmDescription = createMemo(() => {
    const from = serverMode();
    const to = draftMode();
    const transition = from === to ? `auth mode "${to}"` : `auth mode from "${from}" to "${to}"`;
    switch (to) {
      case 'public':
        return `You're about to update ${transition}. The app will be accessible to anyone without signing in.`;
      case 'manual':
        return `You're about to update ${transition}. Visitors will be required to sign in via the configured OIDC provider before the app loads.`;
      case 'provider':
        return `You're about to update ${transition}. Visitors will be required to sign in with ${providerName()} before the app loads.`;
    }
  });

  const reset = () => {
    setDraftMode(serverMode());
    setDraftConfig(serverConfig());
    setDraftBypassPaths(serverBypassPaths());
    setDraftProviderId(serverProviderId());
    setDraftProviderForward(serverProviderForward());
  };

  return (
    <div class="space-y-4">
      <Show
        when={!query.isLoading}
        fallback={
          <div class="py-6">
            <Spinner label="Loading auth settings…" />
          </div>
        }
      >
        <AuthModeSelector value={draftMode()} onChange={setDraftMode} disabled={props.disabled || mutation.isPending} />

        <Show when={draftMode() === 'manual'}>
          <div class="pt-2 border-t border-border">
            <OidcForm
              value={draftConfig()}
              onChange={setDraftConfig}
              disabled={props.disabled || mutation.isPending}
              secretAlreadySet={serverHasExistingConfig()}
              callbackUrls={query.data?.callbackUrls}
            />
          </div>
        </Show>

        <Show when={draftMode() === 'provider'}>
          <div class="pt-2 border-t border-border">
            <SignInProviderPicker
              value={draftProviderId()}
              onChange={setDraftProviderId}
              forwardAccessToken={draftProviderForward()}
              onForwardAccessTokenChange={setDraftProviderForward}
              disabled={props.disabled || mutation.isPending}
            />
          </div>
        </Show>

        <Show when={draftMode() === 'manual' || draftMode() === 'provider'}>
          <div class="pt-2 border-t border-border">
            <BypassPathsEditor
              value={draftBypassPaths()}
              onChange={setDraftBypassPaths}
              disabled={props.disabled || mutation.isPending}
            />
          </div>
        </Show>

        <Show when={saveAttempted() && error()}>{(e) => <p class="text-xs text-destructive">{e()}</p>}</Show>

        <div class="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Show when={dirty()}>
            <Button size="sm" variant="ghost" onClick={reset} disabled={mutation.isPending}>
              Reset
            </Button>
          </Show>
          <Button size="sm" onClick={requestSave} disabled={props.disabled || !dirty()} loading={mutation.isPending}>
            Save
          </Button>
        </div>
      </Show>

      <ConfirmDialog
        open={confirmOpen()}
        onOpenChange={setConfirmOpen}
        title="Save auth settings?"
        description={confirmDescription() ?? ''}
        confirmLabel="Save"
        onConfirm={confirmSave}
      />
    </div>
  );
}
