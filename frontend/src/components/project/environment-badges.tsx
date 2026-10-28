import { For, Show, createMemo } from 'solid-js';
import { useEnvironments, type Environment } from '~/api/environments';
import { EnvironmentBadge } from '~/components/environment-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';

const MAX_VISIBLE_BADGES = 3;

export function EnvironmentBadges(props: { environmentIds: string[]; dimmed?: boolean; size?: 'default' | 'sm' }) {
  const environments = useEnvironments();

  const resolved = createMemo(() => {
    const registry = environments.data;
    if (!registry) return [];
    const byId = new Map(registry.map((env) => [env.id, env]));
    return props.environmentIds
      .map((id) => byId.get(id))
      .filter((env): env is Environment => env !== undefined)
      .toSorted(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
  });

  const visible = createMemo(() => resolved().slice(0, MAX_VISIBLE_BADGES));
  const overflow = createMemo(() => resolved().length - visible().length);
  const overflowNames = createMemo(() =>
    resolved()
      .slice(MAX_VISIBLE_BADGES)
      .map((env) => env.name)
      .join(', ')
  );

  return (
    <Show when={resolved().length > 0}>
      <div class={cn('flex items-center gap-1 min-w-0', props.dimmed && 'opacity-50')}>
        <For each={visible()}>
          {(env) => (
            <Tooltip>
              <TooltipTrigger as="span" class="inline-flex shrink-0" aria-label={env.name}>
                <EnvironmentBadge environment={env} size={props.size} />
              </TooltipTrigger>
              <TooltipContent>{env.name}</TooltipContent>
            </Tooltip>
          )}
        </For>
        <Show when={overflow() > 0}>
          <Tooltip>
            <TooltipTrigger as="span" class="text-[9px] leading-none text-sidebar-muted-foreground">
              +{overflow()}
            </TooltipTrigger>
            <TooltipContent>{overflowNames()}</TooltipContent>
          </Tooltip>
        </Show>
      </div>
    </Show>
  );
}
