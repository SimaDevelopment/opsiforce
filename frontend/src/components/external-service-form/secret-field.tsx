import { Show, createSignal } from 'solid-js';
import type { Field } from '@opsiforce/external-service-sdk/forms';
import { Button } from '~/components/ui/button';
import { Lock } from '~/components/icons';
import { cn } from '~/lib/cn';
import { INPUT_CLASS, INVALID_INPUT_CLASS } from './form-styles';
import { KEPT_SECRET, isKeptSecret } from './form-values';

type SecretFieldDefinition = Extract<Field, { type: 'secret' }>;

const STORED_BOX_CLASS =
  'inline-flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 font-mono text-[11px] text-muted-foreground';

export function SecretField(props: {
  id: string;
  field: SecretFieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const wasStored = isKeptSecret(props.value);
  const [replacing, setReplacing] = createSignal(false);
  const stored = () => isKeptSecret(props.value);
  const typed = () => (typeof props.value === 'string' ? props.value : '');

  const write = (text: string) => props.onChange(text === '' && wasStored ? KEPT_SECRET : text);
  const cancelReplace = () => {
    props.onChange(KEPT_SECRET);
    setReplacing(false);
  };

  return (
    <Show
      when={!stored() || replacing()}
      fallback={
        <div class="flex items-center gap-2">
          <span class={STORED_BOX_CLASS}>
            <Lock class="h-3 w-3 shrink-0" aria-hidden="true" />
            stored · encrypted
          </span>
          <Show when={!props.disabled}>
            <Button variant="outline" size="sm" class="h-7 text-xs" onClick={() => setReplacing(true)}>
              Replace
            </Button>
          </Show>
        </div>
      }
    >
      <div class="flex items-start gap-2">
        <Show
          when={props.field.multiline}
          fallback={
            <input
              id={props.id}
              type="password"
              autocomplete="new-password"
              class={cn(INPUT_CLASS, 'font-mono', props.invalid && INVALID_INPUT_CLASS)}
              placeholder={
                wasStored ? 'Leave blank to keep the stored value' : (props.field.placeholder ?? 'Paste the value')
              }
              value={typed()}
              disabled={props.disabled}
              aria-invalid={props.invalid}
              onInput={(event) => write(event.currentTarget.value)}
            />
          }
        >
          <textarea
            id={props.id}
            class={cn(
              INPUT_CLASS,
              'h-24 py-2 font-mono [-webkit-text-security:disc]',
              props.invalid && INVALID_INPUT_CLASS
            )}
            placeholder={
              wasStored ? 'Leave blank to keep the stored value' : (props.field.placeholder ?? 'Paste the value')
            }
            value={typed()}
            disabled={props.disabled}
            aria-invalid={props.invalid}
            spellcheck={false}
            onInput={(event) => write(event.currentTarget.value)}
          />
        </Show>
        <Show when={wasStored && replacing()}>
          <Button variant="ghost" size="sm" class="h-8 text-xs" onClick={cancelReplace}>
            Keep stored
          </Button>
        </Show>
      </div>
    </Show>
  );
}
