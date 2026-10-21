import { For, Show, createSignal, createUniqueId, untrack, type JSX } from 'solid-js';
import { ApiError } from '~/api/client';
import {
  BASE_FORMAT_IDS,
  type BaseFormatId,
  type ModelProviderKind,
  type NewCustomModelProvider,
  type NewLinkedAccount,
  type NewProviderAvailability,
} from '~/api/model-providers';
import { AlertTriangle, Check } from '~/components/icons';
import { cn } from '~/lib/cn';
import { BASE_URL_HINT, BASE_URL_PLACEHOLDER, KIND_HINT, KIND_LABEL } from './copy';
import { LabelledSwitch } from './provider-widgets';
import { BASE_FORMAT_LABEL } from './traffic-split';

export const INPUT_CLASS =
  'h-8 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export type TestResult = { passed: true } | { passed: false; message: string };

const NAME_SLUG = /^[a-z0-9-]+$/;

export interface ProviderDraft {
  kind: ModelProviderKind;
  name: string;
  key: string;
  baseUrl: string;
  endpoint: string;
  models: string[] | null;
  deployments: Record<string, string>;
}

export const EMPTY_DRAFT: ProviderDraft = {
  kind: 'official-api-key',
  name: '',
  key: '',
  baseUrl: '',
  endpoint: '',
  models: null,
  deployments: {},
};

export const AZURE_KEY_PLACEHOLDER = 'Key of the Azure resource…';

const AZURE_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com', '.cognitiveservices.azure.com'];

export function isAzureEndpoint(value: string): boolean {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value.trim());
  return AZURE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix)) && url.pathname.replace(/\/+$/, '') === '';
}

export function deploymentsToSend(models: string[], deployments: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    models.flatMap((model) => {
      const deployment = deployments[model]?.trim();
      return deployment && deployment !== model ? [[model, deployment]] : [];
    })
  );
}

function linkedAccountDraft(baseFormat: BaseFormatId, name: string): NewLinkedAccount {
  return { baseFormat, kind: 'linked-account', vendor: 'chatgpt', name };
}

export function providerNameError(name: string, maxLength: number): string | null {
  if (name === '') return null;
  if (!NAME_SLUG.test(name)) return 'Use only lowercase letters, digits and hyphens';
  if (name.length > maxLength) return `At most ${maxLength} characters`;
  return null;
}

export function isDraftComplete(draft: ProviderDraft, kinds: ModelProviderKind[], maxLength: number): boolean {
  return (
    draft.name !== '' &&
    !providerNameError(draft.name, maxLength) &&
    (draft.kind === 'linked-account' || draft.key.trim() !== '') &&
    kinds.includes(draft.kind) &&
    (draft.kind !== 'compatible-endpoint' || isHttpsUrl(draft.baseUrl)) &&
    (draft.kind !== 'azure-foundry' || isAzureEndpoint(draft.endpoint)) &&
    (draft.models === null || draft.models.length > 0)
  );
}

export function newProviderOf(
  baseFormat: BaseFormatId,
  draft: ProviderDraft,
  availability?: NewProviderAvailability
): NewCustomModelProvider {
  const shared = { name: draft.name, ...(availability ? { availability } : {}) };
  if (draft.kind === 'linked-account') return { ...linkedAccountDraft(baseFormat, draft.name), ...shared };
  if (draft.kind === 'azure-foundry') {
    return {
      baseFormat,
      kind: draft.kind,
      key: draft.key,
      endpoint: draft.endpoint.trim(),
      ...(draft.models
        ? { models: draft.models, deployments: deploymentsToSend(draft.models, draft.deployments) }
        : {}),
      ...shared,
    };
  }
  return {
    baseFormat,
    kind: draft.kind,
    key: draft.key,
    ...(draft.kind === 'compatible-endpoint' ? { baseUrl: draft.baseUrl.trim() } : {}),
    ...(draft.models ? { models: draft.models } : {}),
    ...shared,
  };
}

export function LinkedAccountNote(props: { servedBy: string }) {
  return (
    <div class="space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-xs">
      <p class="font-medium text-foreground">The ChatGPT account you sign in will serve {props.servedBy}.</p>
      <p class="text-muted-foreground">
        Add and sign in shows a code right here: open the link, enter the code at OpenAI, and it takes requests as soon
        as you approve.
      </p>
    </div>
  );
}

export function FormError(props: { message: string | null }) {
  return (
    <Show when={props.message}>
      <p class="break-words text-xs text-destructive" role="alert">
        {props.message}
      </p>
    </Show>
  );
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function isHttpsUrl(value: string): boolean {
  return URL.canParse(value.trim()) && new URL(value.trim()).protocol === 'https:';
}

export function Field(props: { label: string; for?: string; children: JSX.Element }) {
  return (
    <div class="space-y-1">
      <Show when={props.for} fallback={<span class="text-xs text-muted-foreground">{props.label}</span>}>
        {(inputId) => (
          <label for={inputId()} class="block text-xs text-muted-foreground">
            {props.label}
          </label>
        )}
      </Show>
      {props.children}
    </div>
  );
}

export function FixedValue(props: { label: string; value: string; mono?: boolean }) {
  return (
    <Field label={props.label}>
      <p
        class={cn('break-all text-xs text-foreground', props.mono && 'font-mono')}
        translate={props.mono ? 'no' : undefined}
      >
        {props.value}
      </p>
    </Field>
  );
}

const CHOICE_COLUMNS: Record<number, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
};

export function RadioChoice<T extends string>(props: {
  label: string;
  options: T[];
  selected: T;
  onSelect: (option: T) => void;
  title: (option: T) => string;
  hint?: (option: T) => string;
}) {
  const groupName = createUniqueId();
  return (
    <fieldset class="space-y-1">
      <legend class="mb-1 text-xs text-muted-foreground">{props.label}</legend>
      <div class={cn('grid gap-2', CHOICE_COLUMNS[props.options.length])}>
        <For each={props.options}>
          {(option) => (
            <label
              class={cn(
                'flex h-full cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                props.selected === option
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:border-muted-foreground/40 hover:bg-accent/40'
              )}
            >
              <input
                type="radio"
                name={groupName}
                class="mt-px h-3.5 w-3.5 shrink-0 accent-primary"
                checked={props.selected === option}
                onChange={() => props.onSelect(option)}
              />
              <span class="min-w-0">
                <span class="block font-medium leading-4 text-foreground">{props.title(option)}</span>
                <Show when={props.hint}>
                  {(hint) => (
                    <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{hint()(option)}</span>
                  )}
                </Show>
              </span>
            </label>
          )}
        </For>
      </div>
    </fieldset>
  );
}

export function KindChoice(props: {
  kinds: ModelProviderKind[];
  selected: ModelProviderKind;
  onSelect: (kind: ModelProviderKind) => void;
}) {
  return (
    <RadioChoice
      label="Connect with"
      options={props.kinds}
      selected={props.selected}
      onSelect={props.onSelect}
      title={(kind) => KIND_LABEL[kind]}
      hint={(kind) => KIND_HINT[kind]}
    />
  );
}

export function BaseUrlField(props: { format: BaseFormatId; value: string; onInput: (value: string) => void }) {
  const invalid = () => props.value.trim() !== '' && !isHttpsUrl(props.value);
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  return (
    <Field label="Base URL" for={inputId}>
      <input
        id={inputId}
        aria-describedby={hintId}
        aria-invalid={invalid()}
        type="url"
        name="baseUrl"
        autocomplete="off"
        spellcheck={false}
        class={cn(INPUT_CLASS, 'font-mono placeholder:font-sans')}
        placeholder={BASE_URL_PLACEHOLDER[props.format]}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <div aria-live="polite">
        <Show
          when={invalid()}
          fallback={
            <p id={hintId} class="text-xs text-muted-foreground">
              {BASE_URL_HINT[props.format]}
            </p>
          }
        >
          <p id={hintId} class="text-xs text-destructive">
            Enter an https:// URL
          </p>
        </Show>
      </div>
    </Field>
  );
}

export function KeyField(props: {
  format: BaseFormatId;
  value: string;
  onInput: (value: string) => void;
  hint: string;
  placeholder?: string;
}) {
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  return (
    <Field label="API key" for={inputId}>
      <input
        id={inputId}
        aria-describedby={hintId}
        type="password"
        name="apiKey"
        autocomplete="off"
        class={INPUT_CLASS}
        placeholder={props.placeholder ?? `${BASE_FORMAT_LABEL[props.format]} API key…`}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <p id={hintId} class="text-xs text-muted-foreground">
        {props.hint}
      </p>
    </Field>
  );
}

export function TestOutcome(props: { result: TestResult | null; idle: string; passed: string }) {
  return (
    <output class="min-w-0">
      <Show when={props.result} fallback={<span class="text-xs text-muted-foreground">{props.idle}</span>}>
        {(outcome) => {
          const current = outcome();
          return current.passed ? (
            <span class="inline-flex items-center gap-1 text-xs text-emerald-700">
              <Check class="h-3 w-3" /> {props.passed}
            </span>
          ) : (
            <span class="inline-flex items-start gap-1 break-words text-xs text-destructive">
              <AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" /> {current.message}
            </span>
          );
        }}
      </Show>
    </output>
  );
}

type ModelScope = 'every' | 'chosen';

const MODEL_SCOPES: ModelScope[] = ['every', 'chosen'];

export function ModelChoiceField(props: {
  catalog: Partial<Record<BaseFormatId, string[]>>;
  selected: string[] | null;
  deployments?: Record<string, string>;
  onChange: (selected: string[] | null, deployments: Record<string, string>) => void;
}) {
  const formats = () => BASE_FORMAT_IDS.filter((format) => (props.catalog[format]?.length ?? 0) > 0);
  const everyModel = () => formats().flatMap((format) => props.catalog[format] ?? []);
  const namesDeployments = () => props.deployments !== undefined;
  const deployments = () => props.deployments ?? {};
  const scope = (): ModelScope => (props.selected === null ? 'every' : 'chosen');
  const chosen = () => props.selected ?? [];
  const [renaming, setRenaming] = createSignal(
    Object.keys(deploymentsToSend(untrack(chosen), untrack(deployments))).length > 0
  );

  const choose = (next: ModelScope) =>
    props.onChange(next === 'every' ? null : (props.selected ?? everyModel()), deployments());
  const toggle = (model: string, on: boolean) =>
    props.onChange(on ? [...chosen(), model] : chosen().filter((entry) => entry !== model), deployments());
  const rename = (model: string, deployment: string) =>
    props.onChange(props.selected, { ...deployments(), [model]: deployment });
  const switchRenaming = (on: boolean) => {
    setRenaming(on);
    if (!on) props.onChange(props.selected, {});
  };

  return (
    <div class="space-y-2">
      <RadioChoice
        label="Models"
        options={MODEL_SCOPES}
        selected={scope()}
        onSelect={choose}
        title={(option) => (option === 'every' ? 'Every model' : 'Only the models I choose')}
        hint={(option) =>
          option === 'every'
            ? namesDeployments()
              ? 'Each deployed under its own name, including models added later'
              : 'Including models added later'
            : 'Models added later don’t reach it until you choose them'
        }
      />
      <Show when={scope() === 'chosen'}>
        <Show when={namesDeployments()}>
          <LabelledSwitch
            checked={renaming()}
            onChange={switchRenaming}
            label="Some deployments have different names"
            hint={
              renaming()
                ? 'Enter the Azure deployment name beside each model whose deployment is named differently.'
                : 'Each model is deployed under its own name.'
            }
          />
        </Show>
        <div class="rounded-md border border-border">
          <div class="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs">
            <span class="mr-auto text-muted-foreground">
              {chosen().length} of {everyModel().length} chosen
            </span>
            <button
              type="button"
              class="text-primary hover:underline disabled:opacity-50"
              disabled={chosen().length === everyModel().length}
              onClick={() => props.onChange(everyModel(), deployments())}
            >
              Select all
            </button>
            <button
              type="button"
              class="text-primary hover:underline disabled:opacity-50"
              disabled={chosen().length === 0}
              onClick={() => props.onChange([], deployments())}
            >
              Clear
            </button>
          </div>
          <div class="max-h-64 space-y-2 overflow-y-auto p-3">
            <For each={formats()}>
              {(format) => (
                <div class="space-y-1">
                  <Show when={formats().length > 1}>
                    <p class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {BASE_FORMAT_LABEL[format]}
                    </p>
                  </Show>
                  <For each={props.catalog[format] ?? []}>
                    {(model) => {
                      const isChosen = () => chosen().includes(model);
                      return (
                        <div class="flex min-h-7 flex-wrap items-center gap-2 text-xs">
                          <label class="inline-flex min-w-44 cursor-pointer items-center gap-2">
                            <input
                              type="checkbox"
                              class="h-3.5 w-3.5 accent-primary"
                              checked={isChosen()}
                              onChange={(event) => toggle(model, event.currentTarget.checked)}
                            />
                            <span class="font-mono" translate="no">
                              {model}
                            </span>
                          </label>
                          <Show when={namesDeployments() && renaming() && isChosen()}>
                            <input
                              type="text"
                              aria-label={`Deployment name of ${model}`}
                              autocomplete="off"
                              spellcheck={false}
                              class={cn(INPUT_CLASS, 'h-7 max-w-56 flex-1 font-mono')}
                              placeholder="Deployment name"
                              value={deployments()[model] ?? ''}
                              onInput={(event) => rename(model, event.currentTarget.value)}
                            />
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
        <Show when={chosen().length === 0}>
          <p class="text-xs text-destructive">Choose at least one model, or choose Every model.</p>
        </Show>
      </Show>
    </div>
  );
}

export function EndpointField(props: { value: string; onInput: (value: string) => void }) {
  const invalid = () => props.value.trim() !== '' && !isAzureEndpoint(props.value);
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  return (
    <Field label="Endpoint" for={inputId}>
      <input
        id={inputId}
        aria-describedby={hintId}
        aria-invalid={invalid()}
        type="url"
        name="endpoint"
        autocomplete="off"
        spellcheck={false}
        class={cn(INPUT_CLASS, 'font-mono placeholder:font-sans')}
        placeholder="https://<resource>.services.ai.azure.com"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <p id={hintId} class={cn('text-xs', invalid() ? 'text-destructive' : 'text-muted-foreground')}>
        {invalid()
          ? 'Enter the resource address only, on openai.azure.com, services.ai.azure.com or cognitiveservices.azure.com'
          : 'The resource address from the Azure AI Foundry portal, without a path.'}
      </p>
    </Field>
  );
}
