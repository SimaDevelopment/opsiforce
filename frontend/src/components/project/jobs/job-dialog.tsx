import { createMemo, For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { Button } from '~/components/ui/button';
import { AlertTriangle } from '~/components/icons';
import { StepProgress } from '~/components/project/step-progress';
import { describeJob, jobActions, type JobActionDescriptor, type JobHost } from './job-kind';
import type { TrackedJob } from './job-dock-context';

export interface JobDialogProps {
  entry: TrackedJob;
  host: JobHost;
  onMinimize: () => void;
  onDismiss: () => void;
}

export function JobDialog(props: JobDialogProps) {
  const display = createMemo(() => describeJob(props.entry));
  const actions = createMemo(() => jobActions(props.entry, props.host));
  const isDone = () => display().phase === 'done';
  const isFailed = () => display().phase === 'failed';
  const isRunning = () => display().phase === 'running';
  const dismissLabel = () => display().dismissLabel ?? (isDone() ? 'Done' : 'Close');

  const runAction = (action: JobActionDescriptor) => {
    if (action.href) window.open(action.href, '_blank', 'noopener,noreferrer');
    else action.onSelect?.();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onMinimize();
      }}
    >
      <DialogContent class="max-w-lg">
        <DialogTitle class="flex items-center gap-2">
          <Dynamic component={display().headerIcon} class="h-4 w-4 text-primary" />
          {display().dialogTitle}
        </DialogTitle>
        <DialogDescription>{display().dialogNote}</DialogDescription>

        <div class="mt-4">
          <StepProgress
            steps={display().steps}
            currentIndex={display().currentIndex}
            isFailed={isFailed()}
            isDone={isDone()}
          />
        </div>

        <Show when={display().notice}>
          {(notice) => (
            <div class="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle class="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>{notice()}</span>
            </div>
          )}
        </Show>

        <Show when={isFailed() && display().error}>
          <div class="mt-2 text-xs text-destructive">{display().error}</div>
        </Show>

        <div class="mt-5 flex justify-end gap-2">
          <Show when={isRunning()}>
            <Button size="sm" variant="outline" onClick={() => props.onMinimize()}>
              Minimize
            </Button>
          </Show>
          <Show when={!isRunning() || display().dismissWhileRunning}>
            <Button size="sm" variant="outline" onClick={() => props.onDismiss()}>
              {dismissLabel()}
            </Button>
          </Show>
          <Show when={!isRunning()}>
            <For each={actions()}>
              {(action) => (
                <Button
                  size="sm"
                  variant={action.variant === 'outline' ? 'outline' : 'default'}
                  onClick={() => runAction(action)}
                >
                  <Dynamic component={action.icon} class="h-3.5 w-3.5" />
                  {action.label}
                </Button>
              )}
            </For>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
}
