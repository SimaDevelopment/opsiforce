import { Show, createSignal, onCleanup } from 'solid-js';
import { Check, Copy } from '~/components/icons';
import { ICON_BUTTON_CLASS } from './form-styles';

const COPIED_FEEDBACK_MS = 1200;

export function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  return (
    <button
      type="button"
      class={ICON_BUTTON_CLASS}
      aria-label={props.label ?? 'Copy'}
      disabled={props.text === ''}
      onClick={() => {
        void navigator.clipboard?.writeText(props.text);
        setCopied(true);
        clearTimeout(timer);
        timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      }}
    >
      <Show when={copied()} fallback={<Copy class="h-3.5 w-3.5" aria-hidden="true" />}>
        <Check class="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
      </Show>
    </button>
  );
}
