import { For, Show, createEffect, createMemo, createSignal, createUniqueId, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { toast } from 'solid-sonner';
import {
  useCreateModelProvider,
  useModelProviderCreationRules,
  usePlatformModelProviderAccess,
  usePlatformModelProviderCreationRules,
  useTestModelProvider,
  type BaseFormatId,
  type ModelProviderKind,
  type ModelProviderScope,
  type NewProviderAvailability,
} from '~/api/model-providers';
import { SearchInput } from '~/components/store/store-list';
import { AlertTriangle, Plus } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { cn } from '~/lib/cn';
import {
  AZURE_KEY_PLACEHOLDER,
  BaseUrlField,
  EMPTY_DRAFT,
  EndpointField,
  Field,
  INPUT_CLASS,
  KeyField,
  KindChoice,
  LinkedAccountNote,
  ModelChoiceField,
  RadioChoice,
  TestOutcome,
  errorMessage,
  isDraftComplete,
  newProviderOf,
  providerNameError,
  type ProviderDraft,
  type TestResult,
} from './connection-fields';
import { TIPS } from './copy';
import { LinkedAccountSignInStep } from './linked-account-sign-in';
import { BASE_FORMAT_LABEL } from './traffic-split';

interface AddProviderPermissions {
  canAddCustom: boolean;
  canAddGlobal: boolean;
}

export function AddProviderButton(props: { format: BaseFormatId } & AddProviderPermissions) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <Button size="sm" variant="outline" class="ml-auto h-7" onClick={() => setOpen(true)}>
        <Plus class="h-3.5 w-3.5" /> Add model provider
      </Button>
      <AddProviderDialog
        format={props.format}
        canAddCustom={props.canAddCustom}
        canAddGlobal={props.canAddGlobal}
        open={open()}
        onOpenChange={setOpen}
      />
    </>
  );
}

function AddProviderDialog(
  props: { format: BaseFormatId; open: boolean; onOpenChange: (open: boolean) => void } & AddProviderPermissions
) {
  const customRules = useModelProviderCreationRules(() => props.canAddCustom);
  const globalRules = usePlatformModelProviderCreationRules(() => props.canAddGlobal);
  const testCustom = useTestModelProvider('tenant');
  const testGlobal = useTestModelProvider('platform');
  const createCustom = useCreateModelProvider('tenant');
  const createGlobal = useCreateModelProvider('platform');
  const [audience, setAudience] = createSignal<Audience>('organization');
  const [chosenTenantIds, setChosenTenantIds] = createSignal<string[]>([]);
  const [draft, setDraft] = createStore<ProviderDraft>({ ...EMPTY_DRAFT });
  const global = () => audience() !== 'organization';
  const audiences = (): Audience[] => [
    ...(props.canAddCustom ? (['organization'] as const) : []),
    ...(props.canAddGlobal ? (['every', 'chosen'] as const) : []),
  ];
  const availability = (): NewProviderAvailability | undefined => {
    if (audience() === 'every') return { mode: 'every' };
    if (audience() === 'chosen') return { mode: 'chosen', tenantIds: chosenTenantIds() };
    return undefined;
  };
  const catalog = () => (global() ? globalRules.data : customRules.data)?.catalogModels;
  const azure = () => draft.kind === 'azure-foundry';
  const [result, setResult] = createSignal<TestResult | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [signingIn, setSigningIn] = createSignal<{ scope: ModelProviderScope; name: string } | null>(null);
  const label = () => BASE_FORMAT_LABEL[props.format];
  const nameId = createUniqueId();
  const nameHintId = createUniqueId();

  const kindsOf = (isGlobal: boolean) =>
    (isGlobal ? globalRules.data : customRules.data)?.kindsByFormat[props.format] ?? [];
  const kinds = () => kindsOf(global());
  const prefix = () => (global() ? (globalRules.data?.namePrefix ?? 'opsiforce-') : '');
  const nameMaxLength = () => (global() ? globalRules.data?.nameMaxLength : customRules.data?.nameMaxLength) ?? 0;
  const limitReached = () =>
    !global() && !!customRules.data && customRules.data.customProviderCount >= customRules.data.customProviderLimit;
  const nameError = () => providerNameError(draft.name, nameMaxLength());
  const needsBaseUrl = () => draft.kind === 'compatible-endpoint';
  const linking = () => draft.kind === 'linked-account';
  const complete = () =>
    isDraftComplete(draft, kinds(), nameMaxLength()) && (audience() !== 'chosen' || chosenTenantIds().length > 0);
  const provider = () => newProviderOf(props.format, draft, availability());
  const testProvider = () => (global() ? testGlobal : testCustom);
  const createProvider = () => (global() ? createGlobal : createCustom);

  createEffect(() => {
    if (props.open) {
      setAudience(untrack(() => (props.canAddCustom ? 'organization' : 'every')));
      setChosenTenantIds([]);
      setDraft({ ...EMPTY_DRAFT });
      setResult(null);
      setSaveError(null);
      setSigningIn(null);
    }
  });

  createEffect(() => {
    const available = kinds();
    if (available.length > 0 && !available.includes(untrack(() => draft.kind))) setDraft({ kind: available[0] });
  });

  function change(patch: Partial<ProviderDraft>) {
    setDraft(patch);
    setResult(null);
    setSaveError(null);
  }

  function chooseKind(kind: ModelProviderKind) {
    change({ kind, models: null, deployments: {} });
  }

  function chooseAudience(next: Audience) {
    setAudience(next);
    setResult(null);
    setSaveError(null);
  }

  function runTest() {
    setResult(null);
    const tested = provider();
    if (tested.kind === 'linked-account') return;
    testProvider().mutate(tested, {
      onSuccess: () => setResult({ passed: true }),
      onError: (err) => setResult({ passed: false, message: errorMessage(err, 'The test could not be run') }),
    });
  }

  function save() {
    const added = `${prefix()}${draft.name}`;
    createProvider().mutate(provider(), {
      onSuccess: () => {
        toast.success(`${added} added`);
        if (linking()) setSigningIn({ scope: global() ? 'platform' : 'tenant', name: added });
        else props.onOpenChange(false);
      },
      onError: (err) => {
        setResult(null);
        setSaveError(errorMessage(err, 'The model provider could not be added'));
      },
    });
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-xl" align="top">
        <Show
          when={signingIn()}
          fallback={
            <>
              <DialogTitle>Add {label()} model provider</DialogTitle>
              <DialogDescription>
                <Show
                  when={!global()}
                  fallback={audience() === 'chosen' ? TIPS.chosenDescription : TIPS.globalDescription}
                >
                  <Show
                    when={linking()}
                    fallback={
                      <>
                        Only this organization can use it. It starts on for Agents and Apps at weight 1, so it takes a
                        share of {label()} requests straight away.
                      </>
                    }
                  >
                    Only this organization can use it. It starts on for Agents at weight 1 and takes a share of their{' '}
                    {label()} requests once it is signed in. Switch it on for Apps on its card if apps should use it
                    too.
                  </Show>
                </Show>
              </DialogDescription>
              <Show when={audiences().length > 1}>
                <div class="mt-4 space-y-2">
                  <RadioChoice
                    label="Who can use it"
                    options={audiences()}
                    selected={audience()}
                    onSelect={chooseAudience}
                    title={(option) => AUDIENCE_TITLE[option]}
                    hint={(option) => AUDIENCE_HINT[option]}
                  />
                  <Show when={audience() === 'chosen'}>
                    <OrganizationPicker selected={chosenTenantIds()} onChange={setChosenTenantIds} />
                  </Show>
                </div>
              </Show>
              <Show
                when={!limitReached()}
                fallback={
                  <p class="mt-4 text-xs text-destructive">
                    This organization has reached {customRules.data?.customProviderLimit} Custom model providers. Delete
                    one to add another.
                  </p>
                }
              >
                <div class="mt-4 space-y-3">
                  <KindChoice kinds={kinds()} selected={draft.kind} onSelect={chooseKind} />
                  <Field label="Name" for={nameId}>
                    <div class="flex items-center">
                      <Show when={prefix()}>
                        <span
                          translate="no"
                          class="flex h-8 items-center rounded-l-md border border-r-0 border-input bg-muted px-2 font-mono text-xs text-muted-foreground"
                        >
                          {prefix()}
                        </span>
                      </Show>
                      <input
                        id={nameId}
                        aria-describedby={nameHintId}
                        aria-invalid={nameError() !== null}
                        type="text"
                        name="name"
                        autocomplete="off"
                        spellcheck={false}
                        class={cn(INPUT_CLASS, 'font-mono placeholder:font-sans', prefix() && 'rounded-l-none')}
                        placeholder={global() ? 'e.g. capacity…' : 'e.g. team-openai…'}
                        value={draft.name}
                        onInput={(event) => change({ name: event.currentTarget.value })}
                      />
                    </div>
                    <div aria-live="polite">
                      <Show
                        when={nameError()}
                        fallback={
                          <p id={nameHintId} class="text-xs text-muted-foreground">
                            Lowercase letters, digits and hyphens, up to {nameMaxLength()} characters. It can’t be
                            changed later.
                          </p>
                        }
                      >
                        <p id={nameHintId} class="text-xs text-destructive">
                          {nameError()}
                        </p>
                      </Show>
                    </div>
                  </Field>
                  <Show when={needsBaseUrl()}>
                    <BaseUrlField
                      format={props.format}
                      value={draft.baseUrl}
                      onInput={(baseUrl) => change({ baseUrl })}
                    />
                  </Show>
                  <Show when={azure()}>
                    <EndpointField value={draft.endpoint} onInput={(endpoint) => change({ endpoint })} />
                  </Show>
                  <Show
                    when={!linking()}
                    fallback={
                      <LinkedAccountNote
                        servedBy={
                          global()
                            ? 'every organization that switches it on'
                            : 'the whole organization: every Agent in it'
                        }
                      />
                    }
                  >
                    <KeyField
                      format={props.format}
                      value={draft.key}
                      onInput={(key) => change({ key })}
                      hint="Stored in the model gateway only; it is never shown again."
                      placeholder={azure() ? AZURE_KEY_PLACEHOLDER : undefined}
                    />
                    <Show when={catalog()}>
                      {(models) => (
                        <ModelChoiceField
                          catalog={azure() ? models() : { [props.format]: models()[props.format] }}
                          selected={draft.models}
                          deployments={azure() ? draft.deployments : undefined}
                          onChange={(chosen, deployments) => change({ models: chosen, deployments })}
                        />
                      )}
                    </Show>
                  </Show>
                  <Show when={global() && !azure()}>
                    <div class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{TIPS.notMetered}</span>
                    </div>
                  </Show>
                  <Show when={!linking()}>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!complete()}
                        loading={testProvider().isPending}
                        onClick={runTest}
                      >
                        Test connection
                      </Button>
                      <TestOutcome
                        result={result()}
                        idle="Save is available after a test passes."
                        passed="The key works"
                      />
                    </div>
                  </Show>
                  <Show when={saveError()}>
                    <p class="break-words text-xs text-destructive" role="alert">
                      {saveError()}
                    </p>
                  </Show>
                </div>
              </Show>
              <div class="mt-4 flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={limitReached() || !complete() || (!linking() && result()?.passed !== true)}
                  loading={createProvider().isPending}
                  onClick={save}
                >
                  {linking() ? 'Add and sign in' : 'Add model provider'}
                </Button>
              </div>
            </>
          }
        >
          {(step) => (
            <LinkedAccountSignInStep
              scope={step().scope}
              name={step().name}
              onClose={() => props.onOpenChange(false)}
            />
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}

type Audience = 'organization' | 'every' | 'chosen';

const AUDIENCE_TITLE: Record<Audience, string> = {
  organization: 'Only this organization',
  every: 'Every organization',
  chosen: 'Chosen organizations',
};

const AUDIENCE_HINT: Record<Audience, string> = {
  organization: 'A Custom model provider of this organization',
  every: 'Built-in, including organizations added later',
  chosen: 'Built-in, only for the ones you tick',
};

function OrganizationPicker(props: { selected: string[]; onChange: (tenantIds: string[]) => void }) {
  const access = usePlatformModelProviderAccess();
  const [query, setQuery] = createSignal('');
  const shown = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return (access.data?.tenants ?? []).filter((tenant) => tenant.displayName.toLowerCase().includes(needle));
  });
  const toggle = (tenantId: string, on: boolean) =>
    props.onChange(on ? [...props.selected, tenantId] : props.selected.filter((entry) => entry !== tenantId));
  return (
    <div class="space-y-1.5">
      <SearchInput label="Search organizations" value={query()} onInput={setQuery} />
      <ul class="max-h-44 divide-y divide-border overflow-y-auto rounded-md border border-border">
        <For
          each={shown()}
          fallback={<li class="px-3 py-3 text-center text-xs text-muted-foreground">No organizations</li>}
        >
          {(tenant) => (
            <li>
              <label class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/40">
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 accent-primary"
                  checked={props.selected.includes(tenant.tenantId)}
                  onChange={(event) => toggle(tenant.tenantId, event.currentTarget.checked)}
                />
                <span class="min-w-0 flex-1 truncate">{tenant.displayName}</span>
              </label>
            </li>
          )}
        </For>
      </ul>
      <p class="text-xs text-muted-foreground">
        {props.selected.length} chosen. Organizations added later don’t get it until you tick them.
      </p>
    </div>
  );
}
