import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { Button } from '~/components/ui/button';
import { Users } from '~/components/icons';
import { useProjectTabs } from '~/components/project/project-tabs-context';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Spinner } from '~/components/ui/spinner';
import type { ProjectAuthMode, ProjectAuthOidcConfig } from '~/api/client';
import { AuthModeSelector, type AuthSelection } from './auth-mode-selector';
import { OidcForm } from './oidc-form';
import { BypassPathsEditor } from './bypass-paths-editor';
import { ForwardAccessTokenToggle } from './forward-access-token-toggle';
import { useAppUsers } from '~/api/app-users';
import { useSignInProviderOptions } from '~/api/sign-in-providers';
import { useProjectAuth } from './use-project-auth';

export interface ProjectAuthTabProps {
  projectId: string;
  environmentId: string;
  appUrl?: string;
  disabled?: boolean;
  onSaved?: () => void;
  onLeave?: () => void;
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
  const providerOptions = useSignInProviderOptions();
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
  const appUsers = useAppUsers(projectId, () => draftMode() === 'app_users');
  const tabs = useProjectTabs();
  const usersWho = (status: string) => appUsers.data?.users.filter((user) => user.status === status).length ?? 0;
  const accessSummary = () => {
    const active = usersWho('active');
    const invited = usersWho('invited');
    const canSignIn = active === 1 ? '1 user can sign in' : `${active} users can sign in`;
    return invited > 0 ? `${canSignIn} · ${invited} invited` : canSignIn;
  };

  const accessName = (mode: ProjectAuthMode, providerId: string | null) => {
    switch (mode) {
      case 'public':
        return 'Public';
      case 'manual':
        return 'Manual';
      case 'app_users':
        return 'App Users';
      case 'provider':
        return providerOptions.data?.find((option) => option.id === providerId)?.name ?? 'the chosen provider';
    }
  };

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
    const from = accessName(serverMode(), serverProviderId());
    const to = accessName(draftMode(), draftProviderId());
    const change =
      from === to ? `You're about to save ${to} access.` : `You're about to change access from ${from} to ${to}.`;
    switch (draftMode()) {
      case 'public':
        return `${change} Anyone can open the app without signing in.`;
      case 'manual':
        return `${change} Visitors must sign in via the configured OIDC provider before the app loads.`;
      case 'provider':
        return `${change} Visitors must sign in with ${to} before the app loads.`;
      case 'app_users':
        return appUsers.data?.users.length === 0
          ? `${change} There are no App Users yet, so nobody can open the app until you add one.`
          : `${change} Visitors must sign in with one of this project's App Users before the app loads.`;
    }
  });

  const selectAccess = (selection: AuthSelection) => {
    setDraftMode(selection.mode);
    setDraftProviderId(selection.signInProviderId);
  };

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
        when={!query.isLoading && !providerOptions.isPending}
        fallback={
          <div class="py-6">
            <Spinner label="Loading auth settings…" />
          </div>
        }
      >
        <AuthModeSelector
          value={{ mode: draftMode(), signInProviderId: draftProviderId() }}
          providers={providerOptions.data ?? []}
          onChange={selectAccess}
          disabled={props.disabled || mutation.isPending}
        />

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
            <ForwardAccessTokenToggle
              checked={draftProviderForward()}
              onChange={setDraftProviderForward}
              disabled={props.disabled || mutation.isPending}
            />
          </div>
        </Show>

        <Show when={draftMode() === 'app_users'}>
          <div class="pt-2 border-t border-border">
            <div class="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <Users class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div class="min-w-0 flex-1 text-xs leading-snug">
                <p class="font-medium text-foreground">{appUsers.isPending ? 'Loading users…' : accessSummary()}</p>
                <p class="text-muted-foreground">
                  {serverMode() === 'app_users'
                    ? 'Invite people, set their roles and send reset links on the Users tab.'
                    : 'Save to require sign-in. Invite people and set their roles on the Users tab.'}
                </p>
              </div>
              <Show when={tabs}>
                <Button
                  size="sm"
                  variant="outline"
                  class="shrink-0"
                  onClick={() => {
                    tabs?.openTab('users');
                    props.onLeave?.();
                  }}
                >
                  Open Users
                </Button>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={draftMode() !== 'public'}>
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
