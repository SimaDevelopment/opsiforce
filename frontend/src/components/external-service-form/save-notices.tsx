import { For, Show, createSignal } from 'solid-js';
import { Button } from '~/components/ui/button';
import type { HookFailure } from '~/api/external-service-views';
import type { RemovedItemsNotice } from '~/api/project-external-services';
import { AlertTriangle, Info } from '~/components/icons';

export const AWAITING_PUBLISH = 'awaiting-publish';

interface HookFailureActions {
  failure: HookFailure;
  onRetry: () => Promise<void>;
  onDiscard: () => Promise<void>;
}

export function HookFailureNotice(props: HookFailureActions) {
  return (
    <Show when={props.failure.code !== AWAITING_PUBLISH} fallback={<AwaitingPublishNotice />}>
      <FailedHookNotice failure={props.failure} onRetry={props.onRetry} onDiscard={props.onDiscard} />
    </Show>
  );
}

function AwaitingPublishNotice() {
  return (
    <div
      class="mb-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
      role="status"
    >
      <Info class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>Saved with a Publish. The new version applies it once that Publish finishes.</span>
    </div>
  );
}

function FailedHookNotice(props: HookFailureActions) {
  const [running, setRunning] = createSignal<'retry' | 'discard' | null>(null);
  const [actionFailed, setActionFailed] = createSignal<string | null>(null);

  const run = async (action: 'retry' | 'discard') => {
    setRunning(action);
    setActionFailed(null);
    try {
      await (action === 'retry' ? props.onRetry() : props.onDiscard());
    } catch (error) {
      setActionFailed(error instanceof Error && error.message ? error.message : `The ${action} could not run.`);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div
      class="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
      role="alert"
    >
      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>Saved, but the service could not apply it: {props.failure.detail ?? 'its after-save hook failed.'}</span>
        <span class="font-mono text-[10px] text-muted-foreground">
          {props.failure.code} · call {props.failure.callId}
        </span>
        <Show when={actionFailed()}>{(message) => <span class="text-destructive">{message()}</span>}</Show>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-7 text-xs"
        title="Stop asking the service to apply this save, without calling it"
        disabled={running() !== null}
        loading={running() === 'discard'}
        onClick={() => void run('discard')}
      >
        Discard
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7 text-xs"
        disabled={running() !== null}
        loading={running() === 'retry'}
        onClick={() => void run('retry')}
      >
        Retry
      </Button>
    </div>
  );
}

export function RemovedItemsNoticeBanner(props: { notice: RemovedItemsNotice }) {
  return (
    <div
      class="mb-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
      role="status"
    >
      <Info class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="flex flex-col gap-0.5">
        <span>The Service configuration no longer has these items, so they were removed here:</span>
        <ul class="list-disc pl-4">
          <For each={props.notice.removed}>
            {(item) => (
              <li>
                <span class="font-medium">{item.label}</span>
                <span class="text-muted-foreground"> from {item.fields.join(', ')}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}
