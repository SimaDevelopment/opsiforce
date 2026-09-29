import { Show } from 'solid-js';
import { ApiError } from '~/api/client';

export const ENTRY_SLUG_MAX_LENGTH = { agent: 60, skill: 64 } as const;

export function isNameUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'name_unavailable';
}

export function EntryNameField(props: {
  id: string;
  label: string;
  value: string;
  slug: string;
  unavailable: boolean;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  const slugLineId = () => `${props.id}-slug`;

  return (
    <>
      <label for={props.id} class="mb-1 block text-xs font-medium text-muted-foreground">
        {props.label}
      </label>
      <input
        id={props.id}
        name="name"
        type="text"
        autocomplete="off"
        maxLength={80}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder={props.placeholder}
        aria-describedby={slugLineId()}
        aria-invalid={props.unavailable}
        autofocus
      />
      <p id={slugLineId()} class="mt-1.5 min-h-4 text-xs text-muted-foreground" aria-live="polite">
        <Show
          when={props.slug}
          fallback={
            <Show when={props.value.trim()}>
              <span class="text-destructive">Use at least one letter or digit.</span>
            </Show>
          }
        >
          {(slug) => (
            <Show
              when={props.unavailable}
              fallback={
                <>
                  Slug <span class="font-mono text-foreground">{slug()}</span> — fixed once created.
                </>
              }
            >
              <span class="text-destructive">
                Slug <span class="font-mono">{slug()}</span> is taken or reserved. Pick another name.
              </span>
            </Show>
          )}
        </Show>
      </p>
    </>
  );
}
