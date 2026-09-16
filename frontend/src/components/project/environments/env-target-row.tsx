import { Show } from 'solid-js';
import { Check, Rocket } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { EnvAppLinkButtons } from './env-app-link-buttons';
import type { PublishTarget } from '~/api/publish';

export interface EnvTargetRowProps {
  target: PublishTarget;
  hasApp: boolean;
  canPublish: boolean;
  onPublish: () => void;
}

export function EnvTargetRow(props: EnvTargetRowProps) {
  return (
    <div class="col-span-full grid grid-cols-subgrid items-center rounded-md border border-dashed border-border/80 px-2.5 py-2">
      <span class="flex min-w-0 items-center gap-1.5">
        <Check class="invisible h-3.5 w-3.5 shrink-0" />
        <span class="truncate text-xs font-semibold text-foreground" title={props.target.name}>
          {props.target.name}
        </span>
      </span>
      <EnvAppLinkButtons appUrl="" enabled={false} disabledReason="Publish first — no app is running here yet" />
      <span class="truncate text-xs text-muted-foreground">Not published yet</span>
      <Show when={props.canPublish && props.hasApp}>
        <Button
          size="sm"
          variant="outline"
          class="h-7 shrink-0 justify-self-end px-2.5"
          onClick={() => props.onPublish()}
        >
          <Rocket class="h-3.5 w-3.5" />
          Publish
        </Button>
      </Show>
    </div>
  );
}
