import { Match, Show, Switch } from 'solid-js';
import type { Operation } from '@opsiforce/external-service-sdk/forms';
import type { ChangedAspect, ManifestChange } from '~/api/external-service-publishing';
import { Badge } from '~/components/ui/badge';
import { AlertTriangle } from '~/components/icons';
import { cn } from '~/lib/cn';

type OperationKind = Operation['kind'];

const KIND_PILL_CLASS: Record<OperationKind, string> = {
  read: 'bg-muted text-muted-foreground',
  write: 'bg-amber-50 text-amber-700',
  destructive: 'bg-red-50 text-red-700',
};

export function KindPill(props: { kind: OperationKind }) {
  return (
    <span
      class={cn(
        'inline-flex shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide',
        KIND_PILL_CLASS[props.kind]
      )}
    >
      {props.kind}
    </span>
  );
}

export function ChangeMark(props: { change: ManifestChange; aspects: ChangedAspect[] }) {
  return (
    <Switch>
      <Match when={props.change === 'added'}>
        <Badge variant="success" class="shrink-0 font-normal">
          + Added
        </Badge>
      </Match>
      <Match when={props.change === 'changed'}>
        <Badge variant="warning" class="shrink-0 font-normal">
          Changed: {props.aspects.join(', ')}
        </Badge>
      </Match>
      <Match when={props.change === 'removed'}>
        <Badge variant="destructive" class="shrink-0 font-normal">
          − Removed
        </Badge>
      </Match>
    </Switch>
  );
}

export function usedByLabel(configurations: number): string {
  return configurations === 1 ? 'used by 1 Project configuration' : `used by ${configurations} Project configurations`;
}

export function DraftBadge() {
  return (
    <Badge variant="outline" class="font-medium text-muted-foreground">
      Draft
    </Badge>
  );
}

export function NeedsSetupBadge() {
  return (
    <Badge variant="warning" class="gap-1 font-medium">
      <AlertTriangle class="h-3 w-3" aria-hidden="true" />
      Needs setup
    </Badge>
  );
}

export function ServiceIcon(props: { icon: string | null; name: string; class?: string }) {
  const source = () => (props.icon ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.icon)}` : null);
  return (
    <Show
      when={source()}
      fallback={
        <span
          aria-hidden="true"
          class={cn(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-semibold uppercase text-muted-foreground',
            props.class
          )}
        >
          {props.name.trim().charAt(0) || '?'}
        </span>
      }
    >
      {(src) => <img src={src()} alt="" class={cn('h-5 w-5 shrink-0 object-contain', props.class)} />}
    </Show>
  );
}
