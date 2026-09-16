import { Show } from 'solid-js';
import { Clock, AlertTriangle } from '~/components/icons';
import type { CronState } from '../lib/types';

interface Props {
  state: CronState;
  disableExplainerText?: boolean;
}

export function ScheduleExplainer(props: Props) {
  return (
    <Show
      when={props.state.error === ''}
      fallback={
        <div class="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
          <span>{props.state.error}</span>
        </div>
      }
    >
      <Show when={!props.disableExplainerText && props.state.next}>
        <div class="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Clock class="w-3.5 h-3.5 shrink-0" />
          <span>Next run: {props.state.next}</span>
        </div>
      </Show>
    </Show>
  );
}
