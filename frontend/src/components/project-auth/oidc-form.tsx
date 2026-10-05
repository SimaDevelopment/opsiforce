import { For, Show, createSignal } from 'solid-js';
import type { ProjectAuthOidcConfig } from '~/api/client';
import { Check, Copy } from '~/components/icons';
import { FieldWithTooltip, TextInput } from './field-with-tooltip';

type FieldKey = keyof ProjectAuthOidcConfig;
type InputType = 'text' | 'password' | 'url';

interface FieldDef {
  key: Exclude<FieldKey, 'assertClaims' | 'forwardAccessToken'>;
  label: string;
  tooltip: string;
  required?: boolean;
  type?: InputType;
  placeholder?: string;
  column: 'left' | 'right';
}

const FIELDS: FieldDef[] = [
  {
    key: 'clientId',
    label: 'Client Id',
    tooltip: 'The OAuth client ID provided by your identity provider',
    required: true,
    placeholder: 'Enter client id',
    column: 'left',
  },
  {
    key: 'clientSecret',
    label: 'Client Secret',
    tooltip: 'The OAuth client secret provided by your identity provider (keep this confidential)',
    type: 'password',
    placeholder: 'Enter client secret',
    column: 'right',
  },
  {
    key: 'discoveryUrl',
    label: 'Discovery Url',
    tooltip: 'OIDC discovery endpoint URL (if supported by your provider)',
    type: 'url',
    placeholder: 'Enter discovery url',
    column: 'left',
  },
  {
    key: 'scope',
    label: 'Scope',
    tooltip: 'OAuth scopes (openid, email, profile are commonly used)',
    placeholder: 'openid email profile',
    column: 'right',
  },
];

export interface OidcFormProps {
  value: ProjectAuthOidcConfig;
  onChange: (next: ProjectAuthOidcConfig) => void;
  disabled?: boolean;
  secretAlreadySet?: boolean;
  callbackUrls?: string[];
}

export function OidcForm(props: OidcFormProps) {
  const left = FIELDS.filter((f) => f.column === 'left');
  const right = FIELDS.filter((f) => f.column === 'right');
  const [copiedUrl, setCopiedUrl] = createSignal<string | null>(null);

  const copyCallback = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 1500);
  };

  const fieldValue = (key: FieldDef['key']) => (props.value[key] as string | undefined) ?? '';
  const setField = (key: FieldDef['key'], v: string) => props.onChange({ ...props.value, [key]: v });

  const placeholderFor = (f: FieldDef): string | undefined => {
    if (f.key === 'clientSecret' && props.secretAlreadySet) {
      return 'Leave blank to keep current';
    }
    return f.placeholder;
  };

  const renderField = (f: FieldDef) => (
    <FieldWithTooltip label={f.label} tooltip={f.tooltip} required={f.required}>
      <TextInput
        value={fieldValue(f.key)}
        onInput={(v) => setField(f.key, v)}
        placeholder={placeholderFor(f)}
        type={f.type ?? 'text'}
        disabled={props.disabled}
      />
    </FieldWithTooltip>
  );

  return (
    <div class="space-y-3">
      <form class="grid grid-cols-2 gap-x-3 gap-y-3" autocomplete="off" onSubmit={(e) => e.preventDefault()}>
        <div class="space-y-3">
          <For each={left}>{renderField}</For>
        </div>
        <div class="space-y-3">
          <For each={right}>{renderField}</For>
        </div>
      </form>

      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={props.value.forwardAccessToken ?? false}
          disabled={props.disabled}
          onChange={(e) => props.onChange({ ...props.value, forwardAccessToken: e.currentTarget.checked })}
        />
        <span>
          Forward the signed-in user's access token to this app's backend
          <span class="block text-xs text-muted-foreground">
            Allows the app to call APIs with the permissions requested above. Enable only for trusted app code.
            Authentication bypass paths must be empty.
          </span>
        </span>
      </label>

      <Show when={props.callbackUrls?.length}>
        <FieldWithTooltip
          label="Callback URLs"
          tooltip="Add every redirect URI below to your identity provider's allowed redirect URIs — the app answers on each of these hostnames, and sign-in fails on any host whose callback is not registered."
        >
          <div class="space-y-2">
            <For each={props.callbackUrls}>
              {(url) => (
                <div class="flex items-center gap-2">
                  <input
                    readOnly
                    value={url}
                    spellcheck={false}
                    class="flex h-9 w-full rounded-md border border-input bg-muted/40 px-3 py-1 text-sm text-muted-foreground focus-visible:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => copyCallback(url)}
                    class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Copy callback URL"
                  >
                    <Show when={copiedUrl() === url} fallback={<Copy class="h-3.5 w-3.5" />}>
                      <Check class="h-3.5 w-3.5 text-green-500" />
                    </Show>
                  </button>
                </div>
              )}
            </For>
          </div>
        </FieldWithTooltip>
      </Show>
    </div>
  );
}
