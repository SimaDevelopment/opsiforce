import { Show, createEffect, createSignal, type JSX } from 'solid-js';
import { createStore } from 'solid-js/store';
import { toast } from '~/lib/toast';
import {
  useCreateSignInProvider,
  useUpdateSignInProvider,
  type SaveSignInProviderDto,
  type SignInProvider,
} from '~/api/sign-in-providers';
import { CopyValue } from '~/components/copy-value';
import { FieldWithTooltip, TextInput } from '~/components/project-auth/field-with-tooltip';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';

const DEFAULT_SCOPE = 'openid profile email';

interface Draft {
  name: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  requiredClaimName: string;
  requiredClaimValues: string;
  groupsClaim: string;
}

function draftOf(provider: SignInProvider | null): Draft {
  return {
    name: provider?.name ?? '',
    discoveryUrl: provider?.discoveryUrl ?? '',
    clientId: provider?.clientId ?? '',
    clientSecret: '',
    scope: provider?.scope ?? DEFAULT_SCOPE,
    requiredClaimName: provider?.requiredClaimName ?? '',
    requiredClaimValues: provider?.requiredClaimValues.join(', ') ?? '',
    groupsClaim: provider?.groupsClaim ?? '',
  };
}

function claimValuesOf(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function payloadOf(draft: Draft): SaveSignInProviderDto {
  const claimName = draft.requiredClaimName.trim();
  return {
    name: draft.name.trim(),
    discoveryUrl: draft.discoveryUrl.trim(),
    clientId: draft.clientId.trim(),
    ...(draft.clientSecret.trim() ? { clientSecret: draft.clientSecret.trim() } : {}),
    scope: draft.scope.trim(),
    requiredClaimName: claimName || null,
    requiredClaimValues: claimName ? claimValuesOf(draft.requiredClaimValues) : [],
    groupsClaim: draft.groupsClaim.trim() || null,
  };
}

function Hint(props: { children: JSX.Element }) {
  return <p class="text-xs text-muted-foreground">{props.children}</p>;
}

function Code(props: { children: JSX.Element }) {
  return <span class="font-mono">{props.children}</span>;
}

function FormSection(props: { title: string; description?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="space-y-3">
      <div class="space-y-0.5">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</h3>
        <Show when={props.description}>
          <p class="text-xs text-muted-foreground">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

export function RedirectUri(props: { value: string }) {
  return (
    <FieldWithTooltip
      label="Redirect URI"
      tooltip="Copy this URL into the app you registered at your identity provider. Add it to the app's allowed redirect URIs and to its allowed post-logout redirect URIs, or signing in and signing out fail."
    >
      <CopyValue value={props.value} label="Copy redirect URI" />
    </FieldWithTooltip>
  );
}

export function SignInProviderDialog(props: {
  provider: SignInProvider | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateSignInProvider();
  const update = useUpdateSignInProvider();
  const [draft, setDraft] = createStore<Draft>(draftOf(null));
  const [error, setError] = createSignal<string | null>(null);
  const editing = () => props.provider !== null;
  const pending = () => create.isPending || update.isPending;

  createEffect(() => {
    if (props.open) {
      setDraft(draftOf(props.provider));
      setError(null);
    }
  });

  const missing = (): string | null => {
    if (!draft.name.trim()) return 'Name is required';
    if (!draft.discoveryUrl.trim()) return 'Issuer or discovery URL is required';
    if (!draft.clientId.trim()) return 'Client ID is required';
    if (!editing() && !draft.clientSecret.trim()) return 'Client secret is required';
    return null;
  };

  const change = (patch: Partial<Draft>) => {
    setDraft(patch);
    setError(null);
  };

  const onSaved = (provider: SignInProvider) => {
    toast.success(
      editing()
        ? `${provider.name} saved`
        : `${provider.name} added. Copy its redirect URI into your identity provider.`
    );
    props.onOpenChange(false);
  };
  const onFailed = (err: unknown) => setError(err instanceof Error ? err.message : 'The provider could not be saved');

  const save = () => {
    const problem = missing();
    if (problem) {
      setError(problem);
      return;
    }
    const dto = payloadOf(draft);
    const provider = props.provider;
    if (provider) update.mutate({ id: provider.id, dto }, { onSuccess: onSaved, onError: onFailed });
    else create.mutate(dto, { onSuccess: onSaved, onError: onFailed });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg" align="top">
        <DialogTitle>{editing() ? `Edit ${props.provider?.name ?? ''}` : 'Add sign-in provider'}</DialogTitle>
        <DialogDescription>
          Connect the app you registered for your organization at an OIDC identity provider. Project owners then pick it
          by name in App Auth and never see its secret.
        </DialogDescription>
        <form class="mt-4 space-y-5" autocomplete="off" onSubmit={(e) => e.preventDefault()}>
          <Show
            when={props.provider}
            fallback={
              <p class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Fill in the details of the app you registered at your identity provider. Once you add the provider, its
                card shows a redirect URI that you copy back into that app.
              </p>
            }
          >
            {(provider) => <RedirectUri value={provider().redirectUri} />}
          </Show>

          <FormSection title="Identity provider app">
            <FieldWithTooltip label="Name" required tooltip="Unique in your organization, up to 64 characters.">
              <TextInput value={draft.name} onInput={(name) => change({ name })} placeholder="Example Org staff" />
              <Hint>Project owners see this name when they choose a sign-in provider in App Auth.</Hint>
            </FieldWithTooltip>
            <FieldWithTooltip
              label="Issuer or discovery URL"
              required
              tooltip="/.well-known/openid-configuration is appended when missing. For Microsoft Entra ID use your directory's own issuer, not /common."
            >
              <TextInput
                type="url"
                value={draft.discoveryUrl}
                onInput={(discoveryUrl) => change({ discoveryUrl })}
                placeholder="https://id.example-org.com"
              />
              <Hint>Your identity provider's issuer URL, where it publishes its OpenID configuration.</Hint>
            </FieldWithTooltip>
            <FieldWithTooltip label="Client ID" required tooltip="Also called the application ID.">
              <TextInput value={draft.clientId} onInput={(clientId) => change({ clientId })} />
              <Hint>The ID of the app you registered at your identity provider.</Hint>
            </FieldWithTooltip>
            <FieldWithTooltip
              label="Client secret"
              required={!editing()}
              tooltip="Stored encrypted and never shown again. The identity provider must accept the secret in the token request body (client_secret_post)."
            >
              <TextInput
                type="password"
                value={draft.clientSecret}
                onInput={(clientSecret) => change({ clientSecret })}
                placeholder={editing() ? 'Leave blank to keep current' : undefined}
              />
              <Hint>
                {editing()
                  ? 'Leave blank to keep the current secret, or paste a new one to replace it.'
                  : 'The secret your identity provider generated for that app.'}
              </Hint>
            </FieldWithTooltip>
            <FieldWithTooltip
              label="Scope (optional)"
              tooltip="The OAuth scopes requested when someone signs in. Some identity providers add a claim, such as groups, only when its scope is requested."
            >
              <TextInput value={draft.scope} onInput={(scope) => change({ scope })} placeholder={DEFAULT_SCOPE} />
              <Hint>
                Space-separated and must include <Code>openid</Code>. Left empty, it is <Code>{DEFAULT_SCOPE}</Code>.
              </Hint>
            </FieldWithTooltip>
          </FormSection>

          <FormSection
            title="Who can sign in (optional)"
            description="Only people whose ID token has the required claim, holding one of the allowed values, get into the apps that use this provider."
          >
            <FieldWithTooltip
              label="Required claim (optional)"
              tooltip="A dotted path such as realm_access.roles reaches a nested claim. A name containing : or /, such as https://example.com/roles, is one namespaced claim. Most identity providers put groups or roles in the ID token only once you turn that on for the app; until then everyone is refused."
            >
              <TextInput
                value={draft.requiredClaimName}
                onInput={(requiredClaimName) => change({ requiredClaimName })}
                placeholder="groups"
              />
              <Hint>The ID-token claim to check, such as groups or roles.</Hint>
            </FieldWithTooltip>
            <FieldWithTooltip
              label="Allowed values (optional)"
              tooltip="Available once a required claim is set. Someone whose claim holds none of these values gets 403 Forbidden."
            >
              <TextInput
                value={draft.requiredClaimValues}
                onInput={(requiredClaimValues) => change({ requiredClaimValues })}
                placeholder="staff, contractors"
                disabled={!draft.requiredClaimName.trim()}
              />
              <Hint>
                Separate values with commas; any one of them is enough. Left empty, the claim only has to exist.
              </Hint>
            </FieldWithTooltip>
            <Show when={!draft.requiredClaimName.trim()}>
              <p class="of-note of-tone-needs-you text-xs">
                Without a required claim, anyone who can sign in to this identity provider can open the apps that use
                it. Set one if the provider also signs in accounts from outside your organization.
              </p>
            </Show>
          </FormSection>

          <FormSection
            title="What apps receive (optional)"
            description={
              <>
                Every app gets the signed-in person in the <Code>X-Oidc-Subject</Code>, <Code>X-Oidc-Email</Code> and{' '}
                <Code>X-Oidc-Username</Code> headers. Add a groups claim to send their groups too.
              </>
            }
          >
            <FieldWithTooltip
              label="Groups claim (optional)"
              tooltip="Written like the required claim: groups, roles, a dotted path such as realm_access.roles, or a namespaced claim. A single value becomes a one-item array. The claim must be in the ID token."
            >
              <TextInput
                value={draft.groupsClaim}
                onInput={(groupsClaim) => change({ groupsClaim })}
                placeholder="groups"
              />
              <Hint>
                Its values reach every app as a JSON array in the <Code>X-Oidc-Groups</Code> header, for permissions
                inside the app. Left empty, or when someone has no such claim, the header is <Code>[]</Code>.
              </Hint>
            </FieldWithTooltip>
          </FormSection>

          <Show when={error()}>
            <p class="break-words text-xs text-destructive" role="alert">
              {error()}
            </p>
          </Show>
        </form>
        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={pending()} onClick={save}>
            {editing() ? 'Save' : 'Add provider'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
