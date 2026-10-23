import { For, Show } from 'solid-js';
import type { KeepAliveSource, PodKeepAlive, PodTimeout } from '~/api/pods';
import { elapsedSince } from '~/lib/use-now';
import { formatAgo, formatDuration } from '~/lib/format-duration';
import { cn } from '~/lib/cn';

interface KeepAliveCellProps {
  keepAlive: PodKeepAlive;
  timeout: PodTimeout;
  now: () => number;
  dataUpdatedAt: () => number;
}

const KINDS: readonly KeepAliveSource[] = ['agent', 'app'];

const KIND_STYLES: Record<KeepAliveSource, { label: string; dot: string; bar: string; text: string }> = {
  agent: { label: 'Agent', dot: 'bg-indigo-500', bar: 'bg-indigo-500', text: 'text-indigo-600' },
  app: { label: 'App', dot: 'bg-emerald-500', bar: 'bg-emerald-500', text: 'text-emerald-600' },
};

export function KeepAliveCell(props: KeepAliveCellProps) {
  const live = (remainingMs: number | null) =>
    remainingMs === null ? null : Math.max(0, remainingMs - elapsedSince(props.now(), props.dataUpdatedAt()));

  const liveAgent = () => live(props.keepAlive.agent.remainingMs);
  const liveApp = () => live(props.keepAlive.app.remainingMs);

  const suspendsIn = () => {
    const values = [liveAgent(), liveApp()].filter((value): value is number => value !== null && value > 0);
    return values.length > 0 ? Math.max(...values) : null;
  };

  return (
    <div class="w-full min-w-56 space-y-1.5">
      <div class="text-xs">
        <Show when={suspendsIn()} fallback={<span class="font-medium text-amber-600">Idle — suspending</span>}>
          {(value) => (
            <span class="text-muted-foreground">
              Suspends in <span class="font-semibold tabular-nums text-foreground">{formatDuration(value())}</span>
            </span>
          )}
        </Show>
      </div>

      <For each={KINDS}>
        {(kind) => {
          const style = KIND_STYLES[kind];
          const activity = () => props.keepAlive[kind];
          const timeoutMs = () => (kind === 'agent' ? props.timeout.agentIdleMs : props.timeout.appIdleMs);
          const remaining = () => live(activity().remainingMs);
          const alive = () => {
            const value = remaining();
            return value !== null && value > 0;
          };
          const fraction = () => {
            const total = timeoutMs();
            return total > 0 ? Math.min(1, Math.max(0, (remaining() ?? 0) / total)) : 0;
          };
          const lastTouchMs = () => activity().lastTouchMs;

          return (
            <div class="flex items-center gap-2">
              <span class={cn('size-1.5 shrink-0 rounded-full', alive() ? style.dot : 'bg-muted-foreground/30')} />
              <span class="w-9 shrink-0 text-[11px] text-muted-foreground">{style.label}</span>
              <span class="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/80">
                <Show when={lastTouchMs() !== null} fallback="—">
                  {formatAgo(elapsedSince(props.now(), lastTouchMs() ?? 0))}
                </Show>
              </span>
              <div class="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <Show when={alive()}>
                  <div class={cn('h-full rounded-full', style.bar)} style={{ width: `${fraction() * 100}%` }} />
                </Show>
              </div>
              <span
                class={cn(
                  'w-12 shrink-0 text-right text-[11px] tabular-nums',
                  alive() ? style.text : 'text-muted-foreground/50'
                )}
              >
                {alive() ? formatDuration(remaining() ?? 0) : 'idle'}
              </span>
            </div>
          );
        }}
      </For>
    </div>
  );
}
