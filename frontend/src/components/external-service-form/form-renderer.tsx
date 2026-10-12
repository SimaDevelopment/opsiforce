import { For, Match, Show, Switch, createMemo, createSignal, createUniqueId, type JSX } from 'solid-js';
import { renderInfoTemplate, visibleFieldKeys, type Field } from '@opsiforce/external-service-sdk/forms';
import { Button } from '~/components/ui/button';
import { Switch as Toggle, SwitchControl, SwitchLabel, SwitchThumb } from '~/components/ui/switch';
import { ChevronDown, ChevronRight, Lock, Plus, Trash2 } from '~/components/icons';
import { cn } from '~/lib/cn';
import { ChoiceField } from './choice-field';
import { CopyButton } from './copy-button';
import { CallButton, CallInfo } from './form-call-fields';
import { GeneratedField } from './generated-field';
import { fixedOptionsOf, type FormContext } from './form-context';
import { ICON_BUTTON_CLASS, INPUT_CLASS, INVALID_INPUT_CLASS } from './form-styles';
import {
  errorKeyOf,
  isPlainValues,
  isSectionVisible,
  newListItemId,
  withDefaults,
  type FieldPath,
  type FormValues,
} from './form-values';
import { HelpText } from './help-text';
import { KeyValueField } from './key-value-field';
import { SecretField } from './secret-field';

type KeyedField = Exclude<Field, { type: 'section' }>;
type SectionFieldDefinition = Extract<Field, { type: 'section' }>;
type ListFieldDefinition = Extract<Field, { type: 'list' }>;
type InfoFieldDefinition = Extract<Field, { type: 'info' }>;
type ButtonFieldDefinition = Extract<Field, { type: 'button' }>;

interface LevelProps {
  fields: readonly Field[];
  scope: FormValues;
  path: FieldPath;
  ctx: FormContext;
}

const DEFAULT_LIST_MAX_ITEMS = 100;

export function ServiceFormFields(props: { fields: readonly Field[]; ctx: FormContext }) {
  return <FieldList fields={props.fields} scope={props.ctx.draft.values} path={[]} ctx={props.ctx} />;
}

export function ReadOnlyNotice(props: { children: JSX.Element }) {
  return (
    <div class="mb-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Lock class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{props.children}</span>
    </div>
  );
}

function FieldList(props: LevelProps) {
  const visible = createMemo(() => visibleFieldKeys(props.fields, props.scope));
  return (
    <div class="flex flex-col gap-3.5">
      <For each={props.fields}>
        {(field) => (
          <Show
            when={field.type === 'section' ? field : undefined}
            fallback={
              <Show when={visible().has((field as KeyedField).key)}>
                <FieldView field={field as KeyedField} scope={props.scope} path={props.path} ctx={props.ctx} />
              </Show>
            }
          >
            {(section) => (
              <Show when={isSectionVisible(section(), visible())}>
                <SectionField section={section()} scope={props.scope} path={props.path} ctx={props.ctx} />
              </Show>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}

function FieldShell(props: {
  id: string;
  field: KeyedField;
  error?: string;
  children: JSX.Element;
  hideLabel?: boolean;
}) {
  return (
    <div class="flex flex-col gap-1">
      <Show when={!props.hideLabel}>
        <label for={props.id} class={cn('text-xs text-muted-foreground', props.error && 'text-destructive')}>
          {props.field.label ?? props.field.key}
          <Show when={'required' in props.field && props.field.required}>
            <span class="text-muted-foreground/60" aria-hidden="true">
              {' '}
              *
            </span>
          </Show>
        </label>
      </Show>
      {props.children}
      <Show when={props.error}>
        <span id={`${props.id}-error`} class="text-[11px] text-destructive">
          {props.error}
        </span>
      </Show>
      <Show when={props.field.help}>{(help) => <HelpText text={help()} />}</Show>
    </div>
  );
}

function FieldView(props: { field: KeyedField; scope: FormValues; path: FieldPath; ctx: FormContext }) {
  const id = createUniqueId();
  const path = () => [...props.path, props.field.key];
  const value = () => props.scope[props.field.key];
  const set = (next: unknown) => props.ctx.draft.setAt(path(), next);
  const error = () => props.ctx.draft.errorAt(path());
  const disabled = () => props.ctx.readOnly();
  const itemId = () => (props.path.length > 0 && typeof props.scope.id === 'string' ? props.scope.id : undefined);
  const field = props.field;

  return (
    <Switch>
      <Match when={field.type === 'list' && field}>
        {(list) => (
          <ListField list={list() as ListFieldDefinition} scope={props.scope} path={props.path} ctx={props.ctx} />
        )}
      </Match>
      <Match when={field.type === 'info' && field}>
        {(info) => (
          <InfoField
            id={id}
            field={info() as InfoFieldDefinition}
            scope={props.scope}
            itemId={itemId()}
            ctx={props.ctx}
          />
        )}
      </Match>
      <Match when={field.type === 'button' && field}>
        {(button) => <CallButton field={button() as ButtonFieldDefinition} itemId={itemId()} ctx={props.ctx} />}
      </Match>
      <Match when={field.type === 'toggle'}>
        <FieldShell id={id} field={field} error={error()} hideLabel>
          <Toggle checked={value() === true} onChange={(checked) => set(checked)} disabled={disabled()} class="gap-2">
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
            <SwitchLabel class="text-xs font-normal">{field.label ?? field.key}</SwitchLabel>
          </Toggle>
        </FieldShell>
      </Match>
      <Match when={(field.type === 'secret' || field.type === 'text') && field.generate && field}>
        {(generated) => (
          <FieldShell id={id} field={field} error={error()}>
            <GeneratedField
              field={generated() as Extract<Field, { type: 'text' | 'secret' }>}
              value={value()}
              path={errorKeyOf(props.ctx.draft.values, path())}
              itemId={itemId()}
              ctx={props.ctx}
            />
          </FieldShell>
        )}
      </Match>
      <Match when={field.type === 'secret' && field}>
        {(secret) => (
          <FieldShell id={id} field={field} error={error()}>
            <SecretField
              id={id}
              field={secret() as Extract<Field, { type: 'secret' }>}
              value={value()}
              onChange={set}
              disabled={disabled()}
              invalid={!!error()}
            />
          </FieldShell>
        )}
      </Match>
      <Match when={field.type === 'text' || field.type === 'textarea'}>
        <FieldShell id={id} field={field} error={error()}>
          <Show
            when={field.type === 'textarea'}
            fallback={
              <input
                id={id}
                class={cn(INPUT_CLASS, error() && INVALID_INPUT_CLASS)}
                value={typeof value() === 'string' ? (value() as string) : ''}
                placeholder={'placeholder' in field ? field.placeholder : undefined}
                disabled={disabled()}
                aria-invalid={!!error()}
                aria-describedby={error() ? `${id}-error` : undefined}
                onInput={(event) => set(event.currentTarget.value)}
              />
            }
          >
            <textarea
              id={id}
              class={cn(INPUT_CLASS, 'h-20 py-2', error() && INVALID_INPUT_CLASS)}
              value={typeof value() === 'string' ? (value() as string) : ''}
              placeholder={'placeholder' in field ? field.placeholder : undefined}
              disabled={disabled()}
              aria-invalid={!!error()}
              aria-describedby={error() ? `${id}-error` : undefined}
              onInput={(event) => set(event.currentTarget.value)}
            />
          </Show>
        </FieldShell>
      </Match>
      <Match when={field.type === 'number' && field}>
        {(number) => {
          const definition = number() as Extract<Field, { type: 'number' }>;
          return (
            <FieldShell id={id} field={field} error={error()}>
              <input
                id={id}
                type="number"
                inputmode="decimal"
                class={cn(INPUT_CLASS, 'w-32 tabular-nums', error() && INVALID_INPUT_CLASS)}
                value={typeof value() === 'number' ? (value() as number) : ''}
                min={definition.min}
                max={definition.max}
                step={definition.step ?? (definition.integer ? 1 : 'any')}
                placeholder={definition.placeholder}
                disabled={disabled()}
                aria-invalid={!!error()}
                aria-describedby={error() ? `${id}-error` : undefined}
                onInput={(event) => {
                  const text = event.currentTarget.value;
                  set(text === '' || Number.isNaN(Number(text)) ? undefined : Number(text));
                }}
              />
            </FieldShell>
          );
        }}
      </Match>
      <Match when={field.type === 'radio' && field}>
        {(radio) => (
          <FieldShell id={id} field={field} error={error()}>
            <RadioGroup
              id={id}
              field={radio() as Extract<Field, { type: 'radio' }>}
              value={value()}
              onChange={set}
              ctx={props.ctx}
            />
          </FieldShell>
        )}
      </Match>
      <Match when={(field.type === 'select' || field.type === 'multiselect') && field}>
        {(choice) => (
          <FieldShell id={id} field={field} error={error()}>
            <ChoiceField
              id={id}
              field={choice() as Extract<Field, { type: 'select' | 'multiselect' }>}
              value={value()}
              scope={props.scope}
              itemId={itemId()}
              onChange={set}
              ctx={props.ctx}
              invalid={!!error()}
            />
          </FieldShell>
        )}
      </Match>
      <Match when={field.type === 'keyValue'}>
        <FieldShell id={id} field={field} error={error()}>
          <KeyValueField
            id={id}
            label={field.label ?? field.key}
            value={value()}
            onChange={set}
            disabled={disabled()}
            invalid={!!error()}
          />
        </FieldShell>
      </Match>
    </Switch>
  );
}

function RadioGroup(props: {
  id: string;
  field: Extract<Field, { type: 'radio' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  ctx: FormContext;
}) {
  const name = `radio-${props.id}`;
  const options = () => fixedOptionsOf(props.field, props.ctx) ?? [];
  return (
    <fieldset id={props.id} class="flex flex-wrap gap-1.5 border-0 p-0">
      <legend class="sr-only">{props.field.label ?? props.field.key}</legend>
      <For each={options()}>
        {(option) => {
          const checked = () => props.value === option.value;
          return (
            <label
              class={cn(
                'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
                checked()
                  ? 'border-foreground/40 bg-accent text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              <input
                type="radio"
                class="sr-only"
                name={name}
                value={option.value}
                checked={checked()}
                disabled={props.ctx.readOnly()}
                onChange={() => props.onChange(option.value)}
              />
              <span
                aria-hidden="true"
                class={cn(
                  'h-3 w-3 rounded-full border',
                  checked() ? 'border-[4px] border-foreground' : 'border-muted-foreground/50'
                )}
              />
              {option.label}
            </label>
          );
        }}
      </For>
    </fieldset>
  );
}

function SectionField(props: {
  section: SectionFieldDefinition;
  scope: FormValues;
  path: FieldPath;
  ctx: FormContext;
}) {
  const [open, setOpen] = createSignal(!props.section.collapsed);
  const contentId = createUniqueId();
  return (
    <div class="rounded-md border border-border">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen(!open())}
        aria-expanded={open()}
        aria-controls={contentId}
      >
        <Show
          when={open()}
          fallback={<ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        >
          <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Show>
        <span class="text-xs font-medium">{props.section.title}</span>
        <Show when={props.section.description}>
          <span class="min-w-0 truncate text-[11px] text-muted-foreground">{props.section.description}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div id={contentId} class="border-t border-border p-2.5">
          <FieldList fields={props.section.fields} scope={props.scope} path={props.path} ctx={props.ctx} />
        </div>
      </Show>
    </div>
  );
}

function itemTitle(list: ListFieldDefinition, item: FormValues): string | undefined {
  for (const field of list.item) {
    if (field.type !== 'text' || field.generate) continue;
    const value = item[field.key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function ListField(props: { list: ListFieldDefinition; scope: FormValues; path: FieldPath; ctx: FormContext }) {
  const id = createUniqueId();
  const listPath = () => [...props.path, props.list.key];
  const items = (): FormValues[] => {
    const value = props.scope[props.list.key];
    return Array.isArray(value) ? value.filter(isPlainValues) : [];
  };
  const maxItems = () => props.list.maxItems ?? DEFAULT_LIST_MAX_ITEMS;
  const write = (next: FormValues[]) => props.ctx.draft.setAt(listPath(), next.length === 0 ? undefined : next);
  const itemNoun = () => (props.list.label ?? 'item').toLowerCase().replace(/s$/, '');

  return (
    <FieldShell id={id} field={props.list} error={props.ctx.draft.errorAt(listPath())}>
      <div id={id} class="flex flex-col gap-2">
        <For each={items()}>
          {(item, index) => (
            <div class="rounded-md border border-border p-2.5">
              <div class="-mt-1 mb-1.5 flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-xs font-medium">
                  {itemTitle(props.list, item) ?? `${capitalized(itemNoun())} ${index() + 1}`}
                </span>
                <Show when={!props.ctx.readOnly()}>
                  <button
                    type="button"
                    class={cn(ICON_BUTTON_CLASS, 'hover:text-destructive')}
                    aria-label={`Remove ${itemTitle(props.list, item) ?? `${itemNoun()} ${index() + 1}`}`}
                    onClick={() => write(items().filter((_, position) => position !== index()))}
                  >
                    <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </Show>
              </div>
              <FieldList fields={props.list.item} scope={item} path={[...listPath(), index()]} ctx={props.ctx} />
            </div>
          )}
        </For>
        <Show when={props.ctx.readOnly() && items().length === 0}>
          <span class="text-[11px] text-muted-foreground">None</span>
        </Show>
        <Show when={!props.ctx.readOnly()}>
          <Button
            variant="outline"
            size="sm"
            class="h-7 w-full border-dashed text-xs"
            disabled={items().length >= maxItems()}
            onClick={() => write([...items(), { ...withDefaults(props.list.item, {}), id: newListItemId() }])}
          >
            <Plus class="h-3.5 w-3.5" aria-hidden="true" />
            Add {itemNoun()}
          </Button>
        </Show>
      </div>
    </FieldShell>
  );
}

function renderTemplate(template: string, scope: FormValues, ctx: FormContext): string {
  const shared = ctx.templateValues();
  return renderInfoTemplate(template, (variable) => {
    const value = variable in shared ? shared[variable] : scope[variable];
    return value === undefined || value === null ? '' : String(value);
  });
}

function InfoField(props: {
  id: string;
  field: InfoFieldDefinition;
  scope: FormValues;
  itemId?: string;
  ctx: FormContext;
}) {
  const text = () => {
    if (props.field.template !== undefined) return renderTemplate(props.field.template, props.scope, props.ctx);
    return props.field.text ?? '';
  };
  return (
    <Show
      when={props.field.call === undefined}
      fallback={
        <CallInfo
          id={props.id}
          field={props.field}
          call={props.field.call ?? ''}
          itemId={props.itemId}
          ctx={props.ctx}
        />
      }
    >
      <FieldShell id={props.id} field={props.field} hideLabel={!props.field.label}>
        <Show
          when={props.field.template !== undefined}
          fallback={<HelpText text={text()} class="text-xs text-foreground" />}
        >
          <div id={props.id} class="flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1.5">
            <span class="min-w-0 flex-1 truncate font-mono text-[11px]">
              {text() || <span class="text-muted-foreground">Not set yet</span>}
            </span>
            <CopyButton text={text()} label={`Copy ${props.field.label ?? 'value'}`} />
          </div>
        </Show>
      </FieldShell>
    </Show>
  );
}
