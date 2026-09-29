import { Show, createSignal } from 'solid-js';
import { Pencil } from '~/components/icons';
import { cn } from '~/lib/cn';
import { FOCUS_RING } from './store-list';

export function InlineEdit(props: {
  value: string | null;
  label: string;
  placeholder: string;
  onSave: (value: string) => Promise<void>;
  required?: boolean;
  maxLength?: number;
  multiline?: boolean;
  flushLeft?: boolean;
  class?: string;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  const start = () => {
    setDraft(props.value ?? '');
    setEditing(true);
  };

  const commit = async () => {
    if (!editing() || saving()) return;
    const next = draft().trim();
    if (next === (props.value ?? '') || (props.required && !next)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const saved = await props.onSave(next).then(
      () => true,
      () => false
    );
    setSaving(false);
    if (saved) setEditing(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void commit();
    }
  };

  const fieldProps = () => ({
    name: props.label.toLowerCase().replaceAll(' ', '-'),
    autocomplete: 'off',
    'aria-label': props.label,
    maxLength: props.maxLength,
    value: draft(),
    disabled: saving(),
    onInput: (event: InputEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
      setDraft(event.currentTarget.value),
    onBlur: () => void commit(),
    onKeyDown,
  });

  const fieldClass = () =>
    cn(
      'w-full rounded-md border border-input bg-background px-2 py-1 shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring',
      props.flushLeft && '-translate-x-2',
      props.class
    );

  return (
    <Show
      when={editing()}
      fallback={
        <button
          type="button"
          onClick={start}
          aria-label={`Edit ${props.label}`}
          class={cn(
            'group inline-flex max-w-full items-start gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/60',
            props.flushLeft && '-translate-x-2',
            FOCUS_RING,
            props.class
          )}
        >
          <span class={cn('min-w-0 text-pretty', !props.value && 'italic text-muted-foreground')}>
            {props.value || props.placeholder}
          </span>
          <Pencil
            class="mt-[0.3em] h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground group-focus-visible:text-foreground"
            aria-hidden="true"
          />
        </button>
      }
    >
      <Show
        when={props.multiline}
        fallback={
          <input
            type="text"
            ref={selectOnOpen}
            {...fieldProps()}
            class={cn(fieldClass(), 'w-auto min-w-[12ch] max-w-full field-sizing-content pr-3')}
          />
        }
      >
        <textarea
          ref={selectOnOpen}
          {...fieldProps()}
          rows={2}
          placeholder={props.placeholder}
          class={cn(fieldClass(), 'resize-none')}
        />
      </Show>
    </Show>
  );
}

function selectOnOpen(element: HTMLInputElement | HTMLTextAreaElement) {
  queueMicrotask(() => element.select());
}
