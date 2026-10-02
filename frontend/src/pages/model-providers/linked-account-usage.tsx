import { For, Show, createSignal, onCleanup } from 'solid-js';
import { useLinkedAccountUsage, type LinkedAccountUsageWindow, type ModelProviderScope } from '~/api/model-providers';
import { cn } from '~/lib/cn';

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const NEAR_LIMIT_PERCENT = 75;
const AT_LIMIT_PERCENT = 90;

const RESET_DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function windowLabel(minutes: number): string {
  if (minutes === WEEK_MINUTES) return 'Weekly';
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}-day`;
  if (minutes % HOUR_MINUTES === 0) return `${minutes / HOUR_MINUTES}-hour`;
  return `${minutes}-minute`;
}

function resetLabel(resetsAt: string, now: number): string {
  const minutesLeft = Math.max(0, Math.ceil((Date.parse(resetsAt) - now) / MINUTE_MS));
  if (minutesLeft >= DAY_MINUTES) return `resets ${RESET_DAY_FORMAT.format(new Date(resetsAt))}`;
  const hours = Math.floor(minutesLeft / HOUR_MINUTES);
  const minutes = minutesLeft % HOUR_MINUTES;
  return `resets in ${hours > 0 ? `${hours}h ` : ''}${minutes}m`;
}

function planLabel(plan: string): string {
  return `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
}

function barClass(usedPercent: number): string {
  if (usedPercent >= AT_LIMIT_PERCENT) return 'bg-destructive';
  if (usedPercent >= NEAR_LIMIT_PERCENT) return 'bg-amber-500';
  return 'bg-primary';
}

function UsageMeter(props: { window: LinkedAccountUsageWindow; now: number }) {
  const label = () => windowLabel(props.window.windowMinutes);
  const percent = () => Math.round(props.window.usedPercent);
  return (
    <>
      <span class="text-muted-foreground">{label()}</span>
      <meter class="sr-only" aria-label={`${label()} limit used`} min={0} max={100} value={percent()} />
      <div aria-hidden="true" class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          class={cn('h-full rounded-full transition-[width] motion-reduce:transition-none', barClass(percent()))}
          style={{ width: `${percent()}%` }}
        />
      </div>
      <span class="text-right tabular-nums text-foreground">{percent()}%</span>
      <span class="whitespace-nowrap text-muted-foreground">
        <Show when={props.window.resetsAt}>{(resetsAt) => resetLabel(resetsAt(), props.now)}</Show>
      </span>
    </>
  );
}

export function LinkedAccountUsage(props: { scope: ModelProviderScope; name: string }) {
  const usage = useLinkedAccountUsage(props.scope, () => props.name);
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
  onCleanup(() => clearInterval(timer));

  return (
    <Show
      when={usage.data}
      fallback={
        <Show when={usage.isError}>
          <p class="text-muted-foreground">The subscription’s usage could not be read from OpenAI.</p>
        </Show>
      }
    >
      {(data) => (
        <Show when={data().windows.length > 0}>
          <section aria-label={`${props.name} subscription usage`} class="max-w-sm space-y-1">
            <Show when={data().plan}>{(plan) => <p class="text-muted-foreground">{planLabel(plan())} limits</p>}</Show>
            <div class="grid grid-cols-[auto_minmax(4rem,1fr)_2.5rem_auto] items-center gap-x-2 gap-y-1">
              <For each={data().windows}>{(window) => <UsageMeter window={window} now={now()} />}</For>
            </div>
          </section>
        </Show>
      )}
    </Show>
  );
}
