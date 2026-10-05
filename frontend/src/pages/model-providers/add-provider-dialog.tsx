import { Show, createEffect, createSignal, createUniqueId, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { toast } from 'solid-sonner';
import {
  useCreateModelProvider,
  useModelProviderCreationRules,
  usePlatformModelProviderCreationRules,
  useTestModelProvider,
  type BaseFormatId,
  type ModelProviderKind,
} from '~/api/model-providers';
import { AlertTriangle, Plus } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { cn } from '~/lib/cn';
import {
  BaseUrlField,
  Field,
  INPUT_CLASS,
  KeyField,
  KindChoice,
  LinkedAccountNote,
  TestOutcome,
  errorMessage,
  isDraftComplete,
  newProviderOf,
  providerNameError,
  type TestResult,
} from './connection-fields';
import { TIPS } from './copy';
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
  const [global, setGlobal] = createSignal(false);
  const [draft, setDraft] = createStore({
    kind: 'official-api-key' as ModelProviderKind,
    name: '',
    key: '',
    baseUrl: '',
  });
  const [result, setResult] = createSignal<TestResult | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
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
  const complete = () => isDraftComplete(draft, kinds(), nameMaxLength());
  const provider = () => newProviderOf(props.format, draft);
  const testProvider = () => (global() ? testGlobal : testCustom);
  const createProvider = () => (global() ? createGlobal : createCustom);

  createEffect(() => {
    if (props.open) {
      setGlobal(untrack(() => !props.canAddCustom));
      setDraft({ kind: 'official-api-key', name: '', key: '', baseUrl: '' });
      setResult(null);
      setSaveError(null);
    }
  });

  createEffect(() => {
    const available = kinds();
    if (available.length > 0 && !available.includes(untrack(() => draft.kind))) setDraft({ kind: available[0] });
  });

  function change(patch: Partial<typeof draft>) {
    setDraft(patch);
    setResult(null);
    setSaveError(null);
  }

  function chooseGlobal(checked: boolean) {
    setGlobal(checked);
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
        props.onOpenChange(false);
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
        <DialogTitle>Add {label()} model provider</DialogTitle>
        <DialogDescription>
          <Show when={!global()} fallback={TIPS.globalDescription}>
            <Show
              when={linking()}
              fallback={
                <>
                  Only this organization can use it. It starts on with weight 1, so it takes a share of {label()}{' '}
                  requests straight away.
                </>
              }
            >
              Only this organization can use it. It starts on with weight 1 and takes a share of {label()} requests once
              it is signed in.
            </Show>
          </Show>
        </DialogDescription>
        <Show when={props.canAddGlobal}>
          <GlobalChoice checked={global()} locked={!props.canAddCustom} onChange={chooseGlobal} />
        </Show>
        <Show
          when={!limitReached()}
          fallback={
            <p class="mt-4 text-xs text-destructive">
              This organization has reached {customRules.data?.customProviderLimit} Custom model providers. Delete one
              to add another.
            </p>
          }
        >
          <div class="mt-4 space-y-3">
            <KindChoice kinds={kinds()} selected={draft.kind} onSelect={(kind) => change({ kind })} />
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
                      Lowercase letters, digits and hyphens, up to {nameMaxLength()} characters. It can’t be changed
                      later.
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
              <BaseUrlField format={props.format} value={draft.baseUrl} onInput={(baseUrl) => change({ baseUrl })} />
            </Show>
            <Show
              when={!linking()}
              fallback={
                <LinkedAccountNote
                  servedBy={
                    global() ? 'every organization that switches it on' : 'the whole organization: every Agent in it'
                  }
                />
              }
            >
              <KeyField
                format={props.format}
                value={draft.key}
                onInput={(key) => change({ key })}
                hint="Stored in the model gateway only; it is never shown again."
              />
              <p class="text-xs text-muted-foreground">
                It can serve every {label()} model. A model it doesn’t serve is retried on this format’s other providers
                that are on.
              </p>
            </Show>
            <Show when={global()}>
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
                <TestOutcome result={result()} idle="Save is available after a test passes." passed="The key works" />
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
            Add model provider
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GlobalChoice(props: { checked: boolean; locked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label
      class={cn(
        'mt-4 flex items-start gap-2 rounded-md border p-2.5 text-xs transition-colors',
        props.checked ? 'border-primary bg-primary/5' : 'border-border',
        props.locked ? 'cursor-default' : 'cursor-pointer hover:bg-accent/40'
      )}
    >
      <input
        type="checkbox"
        class="mt-px h-3.5 w-3.5 shrink-0 accent-primary"
        checked={props.checked}
        disabled={props.locked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span class="space-y-0.5">
        <span class="block font-medium leading-4 text-foreground">Global — available to every organization</span>
        <span class="block text-[11px] leading-snug text-muted-foreground">{TIPS.globalChoice}</span>
      </span>
    </label>
  );
}
