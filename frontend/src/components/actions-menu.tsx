import { Show, type Component, type JSX, type ParentProps } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { EllipsisVertical } from '~/components/icons';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { cn } from '~/lib/cn';

const TRIGGER_CLASS =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function ActionsMenu(
  props: ParentProps<{
    label: string;
    variant?: 'ghost' | 'outline';
    triggerClass?: string;
    onTriggerClick?: (event: MouseEvent) => void;
  }>
) {
  const icon = <EllipsisVertical class="h-4 w-4" aria-hidden="true" />;
  return (
    <DropdownMenu>
      <Show
        when={props.variant === 'outline'}
        fallback={
          <DropdownMenuTrigger
            class={props.triggerClass ?? TRIGGER_CLASS}
            onClick={(event: MouseEvent) => props.onTriggerClick?.(event)}
            aria-label={props.label}
          >
            {icon}
          </DropdownMenuTrigger>
        }
      >
        <DropdownMenuTrigger
          as={Button}
          variant="outline"
          size="icon"
          class={props.triggerClass ?? 'h-8 w-8'}
          onClick={(event: MouseEvent) => props.onTriggerClick?.(event)}
          aria-label={props.label}
        >
          {icon}
        </DropdownMenuTrigger>
      </Show>
      <DropdownMenuContent onClick={(event: MouseEvent) => event.stopPropagation()}>
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ActionsMenuItem(props: {
  icon: Component<{ class?: string }>;
  onSelect: () => void;
  destructive?: boolean;
  children: JSX.Element;
}) {
  return (
    <DropdownMenuItem
      class={props.destructive ? 'text-destructive data-[highlighted]:text-destructive' : undefined}
      onSelect={() => props.onSelect()}
    >
      <Dynamic
        component={props.icon}
        class={cn('h-3.5 w-3.5 shrink-0', !props.destructive && 'text-muted-foreground')}
        aria-hidden="true"
      />
      {props.children}
    </DropdownMenuItem>
  );
}
