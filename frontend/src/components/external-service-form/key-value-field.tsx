import { Index, Show } from 'solid-js';
import { Button } from '~/components/ui/button';
import { Plus, X } from '~/components/icons';
import { cn } from '~/lib/cn';
import { ICON_BUTTON_CLASS, INPUT_CLASS, INVALID_INPUT_CLASS } from './form-styles';
import { isPlainValues } from './form-values';

type Pair = [string, string];

function pairsOf(value: unknown): Pair[] {
  if (!isPlainValues(value)) return [];
  return Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]);
}

export function KeyValueField(props: {
  id: string;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const pairs = () => pairsOf(props.value);
  const write = (next: Pair[]) => props.onChange(next.length === 0 ? undefined : Object.fromEntries(next));
  const replaceAt = (index: number, pair: Pair) =>
    write(pairs().map((current, position) => (position === index ? pair : current)));

  return (
    <div id={props.id} class="flex flex-col gap-1.5" role="group" aria-label={props.label}>
      <Index each={pairs()}>
        {(pair, index) => (
          <div class="flex items-center gap-1.5">
            <input
              class={cn(INPUT_CLASS, 'font-mono', props.invalid && INVALID_INPUT_CLASS)}
              aria-label={`${props.label} key ${index + 1}`}
              placeholder="Key"
              value={pair()[0]}
              disabled={props.disabled}
              onChange={(event) => replaceAt(index, [event.currentTarget.value, pair()[1]])}
            />
            <input
              class={cn(INPUT_CLASS, 'font-mono', props.invalid && INVALID_INPUT_CLASS)}
              aria-label={`${props.label} value ${index + 1}`}
              placeholder="Value"
              value={pair()[1]}
              disabled={props.disabled}
              onChange={(event) => replaceAt(index, [pair()[0], event.currentTarget.value])}
            />
            <Show when={!props.disabled}>
              <button
                type="button"
                class={ICON_BUTTON_CLASS}
                aria-label={`Remove ${pair()[0] || 'pair'}`}
                onClick={() => write(pairs().filter((_, position) => position !== index))}
              >
                <X class="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </Show>
          </div>
        )}
      </Index>
      <Show when={!props.disabled}>
        <Button
          variant="outline"
          size="sm"
          class="h-7 w-full border-dashed text-xs"
          disabled={pairs().some(([key]) => key === '')}
          onClick={() => write([...pairs(), ['', '']])}
        >
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> Add pair
        </Button>
      </Show>
      <Show when={props.disabled && pairs().length === 0}>
        <span class="text-[11px] text-muted-foreground">None</span>
      </Show>
    </div>
  );
}
