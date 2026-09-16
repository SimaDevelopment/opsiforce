import { Show, createSignal } from 'solid-js';
import { AlertTriangle, X } from '~/components/icons';

export interface EnvProdBannerProps {
  environmentName: string;
  onSwitchToDevelopment: () => void;
}

export function EnvProdBanner(props: EnvProdBannerProps) {
  const [dismissed, setDismissed] = createSignal(false);

  return (
    <Show when={!dismissed()}>
      <div class="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
        <div class="flex items-start gap-2.5">
          <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <div class="min-w-0 flex-1 text-xs leading-relaxed text-amber-900">
            You are viewing the published <span class="font-semibold">{props.environmentName}</span> app. Edits made
            here in chat or code are <span class="font-semibold">not saved</span> and will be overwritten on the next
            publish.{' '}
            <button
              type="button"
              onClick={props.onSwitchToDevelopment}
              class="font-semibold underline underline-offset-2 hover:text-amber-950"
            >
              Switch to Development
            </button>{' '}
            to make changes.
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-amber-700 transition-colors hover:bg-amber-500/20 hover:text-amber-900"
            aria-label="Dismiss"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </Show>
  );
}
