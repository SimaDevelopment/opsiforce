import { createMemo, For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { cn } from '~/lib/cn';
import { Check, LoaderCircle, X } from '~/components/icons';
import { describeJob, jobActions, type JobHost } from './job-kind';
import type { TrackedJob } from './job-dock-context';

export interface JobCardProps {
  entry: TrackedJob;
  host: JobHost;
  onExpand: () => void;
  onDismiss: () => void;
}

export function JobCard(props: JobCardProps) {
  const display = createMemo(() => describeJob(props.entry));
  const actions = createMemo(() => jobActions(props.entry, props.host));
  const isDone = () => display().phase === 'done';
  const isFailed = () => display().phase === 'failed';
  const isTerminal = () => display().phase !== 'running';

  return (
    <div
      class={cn(
        'of-job pointer-events-auto relative w-72 cursor-pointer animate-in fade-in-0 slide-in-from-bottom-2'
      )}
      style={{
        // the phase is carried by a rail at the top edge, so a glance down the
        // dock reads as a list of states rather than a list of cards
        '--job-color': isFailed()
          ? 'var(--job-failed)'
          : isDone()
            ? 'var(--job-done)'
            : 'var(--job-running)',
      }}
      role="button"
      tabIndex={0}
      onClick={() => props.onExpand()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') props.onExpand();
      }}
    >
      <span class="of-job-rail" aria-hidden="true" />

      <Show when={display().accentPulse}>
        <span class="pointer-events-none absolute inset-0 rounded-lg animate-publish-arrive" />
      </Show>

      <div class="flex items-start gap-2.5">
        <Show
          when={!isTerminal()}
          fallback={
            <Show
              when={isDone()}
              fallback={
                <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-destructive text-white">
                  <X class="h-3 w-3" />
                </span>
              }
            >
              <span class="of-fill of-tone-done mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white">
                <Check class="h-3 w-3" />
              </span>
            </Show>
          }
        >
          <LoaderCircle class="mt-0.5 h-5 w-5 shrink-0 animate-spin text-primary" />
        </Show>

        <div class="min-w-0 flex-1">
          <p class={cn('truncate text-xs font-semibold', isFailed() ? 'text-destructive' : 'text-foreground')}>
            {display().cardTitle}
          </p>

          <Show when={!isTerminal()}>
            <p class="mt-0.5 text-xs text-muted-foreground">{display().stepLabel}</p>
          </Show>

          <Show when={isFailed() && display().error}>
            <p class="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">{display().error}</p>
          </Show>

          <Show when={isTerminal() && actions().length > 0}>
            <div class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <For each={actions()}>
                {(action) => (
                  <Show
                    when={action.href}
                    fallback={
                      <button
                        class="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          action.onSelect?.();
                        }}
                      >
                        <Dynamic component={action.icon} class="h-3 w-3 shrink-0" />
                        {action.label}
                      </button>
                    }
                  >
                    {(href) => (
                      <a
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Dynamic component={action.icon} class="h-3 w-3 shrink-0" />
                        {action.label}
                      </a>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>

        <Show when={isTerminal() || display().dismissWhileRunning}>
          <button
            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={display().dismissLabel ?? 'Dismiss'}
            onClick={(e) => {
              e.stopPropagation();
              props.onDismiss();
            }}
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </Show>
      </div>

      <Show when={!isTerminal()}>
        <div class="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            class="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${display().progressPercent}%` }}
          />
        </div>
      </Show>
    </div>
  );
}
