import { Show, createSignal, createUniqueId, type JSX } from 'solid-js';
import { Eye, EyeOff, RefreshCw } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/cn';

const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GENERATED_PASSWORD_LENGTH = 16;
const UNBIASED_BYTE_LIMIT = 256 - (256 % PASSWORD_ALPHABET.length);

export const INPUT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive';

export function generatePassword(): string {
  let password = '';
  while (password.length < GENERATED_PASSWORD_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(GENERATED_PASSWORD_LENGTH))) {
      if (byte < UNBIASED_BYTE_LIMIT && password.length < GENERATED_PASSWORD_LENGTH) {
        password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      }
    }
  }
  return password;
}

export function passwordError(password: string): string | null {
  if (!password) return 'Enter a password, or generate one';
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

export interface FieldControl {
  id: string;
  invalid: () => true | undefined;
  describedBy: () => string | undefined;
}

export function Field(props: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (control: FieldControl) => JSX.Element;
}) {
  const id = createUniqueId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const control: FieldControl = {
    id,
    invalid: () => (props.error ? true : undefined),
    describedBy: () => [props.error && errorId, props.hint && hintId].filter(Boolean).join(' ') || undefined,
  };
  return (
    <div class="space-y-2">
      <label for={id} class="block text-xs font-medium text-foreground">
        {props.label}
      </label>
      {props.children(control)}
      <Show when={props.error}>
        <p id={errorId} class="text-xs text-destructive">
          {props.error}
        </p>
      </Show>
      <Show when={props.hint}>
        <p id={hintId} class="text-xs text-muted-foreground leading-snug">
          {props.hint}
        </p>
      </Show>
    </div>
  );
}

export function PasswordField(props: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
  ref?: (el: HTMLInputElement) => void;
}) {
  const [revealed, setRevealed] = createSignal(true);
  return (
    <Field label={props.label} error={props.error} hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
      {(control) => (
        <div class="flex gap-2">
          <div class="relative min-w-0 flex-1">
            <input
              ref={props.ref}
              id={control.id}
              type={revealed() ? 'text' : 'password'}
              name="new-password"
              autocomplete="new-password"
              autocapitalize="none"
              spellcheck={false}
              value={props.value}
              onInput={(e) => props.onInput(e.currentTarget.value)}
              disabled={props.disabled}
              aria-invalid={control.invalid()}
              aria-describedby={control.describedBy()}
              class={cn(INPUT_CLASS, 'pr-9 font-mono')}
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={revealed() ? 'Hide password' : 'Show password'}
              onClick={() => setRevealed(!revealed())}
            >
              <Show when={revealed()} fallback={<Eye class="h-3.5 w-3.5" aria-hidden="true" />}>
                <EyeOff class="h-3.5 w-3.5" aria-hidden="true" />
              </Show>
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="h-9 shrink-0"
            disabled={props.disabled}
            onClick={() => {
              props.onInput(generatePassword());
              setRevealed(true);
            }}
          >
            <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
            Generate
          </Button>
        </div>
      )}
    </Field>
  );
}
