import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { serviceConfigurationSourceOf, type Field } from '@opsiforce/external-service-sdk/forms';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { AlertTriangle, Check, ExternalLink, LoaderCircle, Plus, Search, X } from '~/components/icons';
import { cn } from '~/lib/cn';
import { fixedOptionsOf, type FieldOption, type FormContext } from './form-context';
import { formCallFailure } from './form-labels';
import { INVALID_INPUT_CLASS } from './form-styles';
import type { FormValues } from './form-values';

type ChoiceFieldDefinition = Extract<Field, { type: 'select' | 'multiselect' }>;

type CallSource = { call: string; searchable?: boolean; dependsOn?: string[] };

const SEARCH_DELAY_MS = 250;
const MAX_OPTIONS_PER_CALL = 50;

function callSourceOf(field: ChoiceFieldDefinition): CallSource | null {
  const options = field.options;
  return !Array.isArray(options) && 'call' in options ? options : null;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

export function ChoiceField(props: {
  id: string;
  field: ChoiceFieldDefinition;
  value: unknown;
  scope: FormValues;
  itemId?: string;
  onChange: (value: unknown) => void;
  ctx: FormContext;
  invalid: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [loaded, setLoaded] = createSignal<FieldOption[] | null>(null);
  const [loadedFor, setLoadedFor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const multiple = () => props.field.type === 'multiselect';
  const callSource = () => callSourceOf(props.field);
  const fromServiceConfiguration = () => serviceConfigurationSourceOf(props.field) !== null;

  const fixedOptions = (): FieldOption[] | null => fixedOptionsOf(props.field, props.ctx);
  const options = (): FieldOption[] | null => fixedOptions() ?? loaded();

  const selected = (): string[] => {
    if (multiple()) return Array.isArray(props.value) ? props.value.map(String) : [];
    return typeof props.value === 'string' && props.value !== '' ? [props.value] : [];
  };

  const waitingFor = (): string[] =>
    (callSource()?.dependsOn ?? []).filter((parent) => isEmptyValue(props.scope[parent]));

  const parentValues = () => JSON.stringify((callSource()?.dependsOn ?? []).map((parent) => props.scope[parent]));

  let requestNumber = 0;
  const load = async (text: string) => {
    const source = callSource();
    const callService = props.ctx.callService;
    if (!source || !callService || waitingFor().length > 0) return;
    const number = ++requestNumber;
    setLoading(true);
    setFailure(null);
    try {
      const answer = (await callService('options', source.call, {
        query: text,
        ...(props.itemId === undefined ? {} : { item: props.itemId }),
      })) as FieldOption[];
      if (number !== requestNumber) return;
      setLoaded(answer);
      setLoadedFor(text);
      props.ctx.seenOptions?.(props.field.key, answer);
    } catch (error) {
      if (number === requestNumber) setFailure(formCallFailure(error));
    } finally {
      if (number === requestNumber) setLoading(false);
    }
  };

  onMount(() => {
    if (callSource() && selected().length > 0) void load('');
  });

  createEffect(
    on(
      parentValues,
      () => {
        requestNumber += 1;
        setLoaded(null);
        setLoadedFor(null);
        setFailure(null);
        setLoading(false);
        if (!props.ctx.readOnly() && selected().length > 0) props.onChange(undefined);
      },
      { defer: true }
    )
  );

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      query,
      (text) => {
        if (!callSource()?.searchable || !open()) return;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void load(text), SEARCH_DELAY_MS);
      },
      { defer: true }
    )
  );
  onCleanup(() => clearTimeout(searchTimer));

  const labelOf = (value: string) =>
    options()?.find((option) => option.value === value)?.label ??
    props.ctx.storedLabel(props.field.key, value) ??
    value;

  const isGone = (value: string) => {
    const known = options();
    if (known === null) return false;
    if (known.some((option) => option.value === value)) return false;
    if (fixedOptions() !== null) return true;
    return loadedFor() === '' && known.length < MAX_OPTIONS_PER_CALL;
  };

  const goneNote = () => (fromServiceConfiguration() ? 'missing from the Service configuration' : 'no longer found');

  const choose = (value: string) => {
    if (!multiple()) {
      props.onChange(value);
      setOpen(false);
      return;
    }
    const current = selected();
    props.onChange(current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]);
  };

  const remove = (value: string) => {
    if (!multiple()) {
      props.onChange(undefined);
      return;
    }
    const rest = selected().filter((entry) => entry !== value);
    props.onChange(rest.length === 0 ? undefined : rest);
  };

  const canChoose = () =>
    !props.ctx.readOnly() &&
    waitingFor().length === 0 &&
    (fixedOptions() !== null || props.ctx.callService !== undefined);

  const openPicker = (next: boolean) => {
    setOpen(next);
    if (next && callSource() && (loaded() === null || loadedFor() !== query())) void load(query());
  };

  const parentLabels = () => waitingFor().join(', ');

  return (
    <div class="flex flex-col gap-1.5">
      <div
        id={props.id}
        role="group"
        class={cn(
          'flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1',
          props.invalid && INVALID_INPUT_CLASS
        )}
      >
        <For each={selected()}>
          {(value) => (
            <span
              class={cn(
                'inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-1.5 text-[11px]',
                isGone(value)
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-border bg-muted text-foreground'
              )}
              title={value}
            >
              <Show when={isGone(value)}>
                <AlertTriangle class="h-3 w-3 shrink-0" aria-hidden="true" />
              </Show>
              <span class="truncate">{labelOf(value)}</span>
              <Show when={isGone(value)}>
                <span class="shrink-0 text-[10px]">· {goneNote()}</span>
              </Show>
              <Show when={!props.ctx.readOnly() && (multiple() || !props.field.required)}>
                <button
                  type="button"
                  class="shrink-0 opacity-60 hover:opacity-100"
                  aria-label={`Remove ${labelOf(value)}`}
                  onClick={() => remove(value)}
                >
                  <X class="h-3 w-3" aria-hidden="true" />
                </button>
              </Show>
            </span>
          )}
        </For>
        <Show when={canChoose()}>
          <Popover open={open()} onOpenChange={openPicker} placement="bottom-start">
            <PopoverTrigger class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
              <Show when={multiple()} fallback={selected().length > 0 ? 'Change' : 'Choose…'}>
                <Plus class="h-3 w-3" aria-hidden="true" /> Add
              </Show>
            </PopoverTrigger>
            <PopoverContent class="w-72 p-1.5">
              <Show when={callSource()?.searchable}>
                <div class="mb-1 flex items-center gap-1.5 rounded-md border border-input px-2">
                  <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input
                    class="h-7 w-full bg-transparent text-xs outline-none"
                    placeholder="Search…"
                    aria-label={`Search ${props.field.label ?? props.field.key}`}
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                  />
                </div>
              </Show>
              <Show
                when={!loading()}
                fallback={
                  <div class="flex items-center gap-1.5 px-2 py-2 text-[11px] text-muted-foreground" role="status">
                    <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" /> Asking the service…
                  </div>
                }
              >
                <Show
                  when={failure()}
                  fallback={
                    <div class="max-h-56 overflow-y-auto" role="listbox" aria-multiselectable={multiple()}>
                      <For
                        each={options() ?? []}
                        fallback={
                          <div class="px-2 py-2 text-[11px] text-muted-foreground">
                            {callSource() ? 'Nothing found.' : 'Nothing to choose yet.'}
                          </div>
                        }
                      >
                        {(option) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected().includes(option.value)}
                            class="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                            onClick={() => choose(option.value)}
                          >
                            <span class="min-w-0 flex-1">
                              <span class="block truncate">{option.label}</span>
                              <Show when={option.description}>
                                <span class="block truncate text-[10px] text-muted-foreground">
                                  {option.description}
                                </span>
                              </Show>
                            </span>
                            <Show when={selected().includes(option.value)}>
                              <Check class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  }
                >
                  {(message) => (
                    <div class="flex flex-col items-start gap-1 px-2 py-2 text-[11px] text-destructive" role="alert">
                      {message()}
                      <button
                        type="button"
                        class="text-[11px] text-foreground underline underline-offset-2"
                        onClick={() => void load(query())}
                      >
                        Try again
                      </button>
                    </div>
                  )}
                </Show>
              </Show>
            </PopoverContent>
          </Popover>
        </Show>
        <Show when={selected().length === 0 && !canChoose()}>
          <span class="px-1 text-[11px] text-muted-foreground">
            {waitingFor().length > 0 && !props.ctx.readOnly() ? `Choose ${parentLabels()} first` : 'None'}
          </span>
        </Show>
      </div>
      <Show when={callSource()}>
        {(source) => (
          <span class="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
            <ExternalLink class="h-2.5 w-2.5" aria-hidden="true" /> choices come from the service ({source().call}
            {source().dependsOn?.length ? `, after ${source().dependsOn?.join(', ')}` : ''})
          </span>
        )}
      </Show>
      <Show when={!open() && failure() && selected().length > 0}>
        <span class="text-[10px] text-muted-foreground">Couldn't check these picks with the service.</span>
      </Show>
    </div>
  );
}
