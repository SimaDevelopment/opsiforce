import { Tooltip as Kobalte } from '@kobalte/core/tooltip';
import { splitProps, type ParentProps, type ComponentProps } from 'solid-js';
import { cn } from '~/lib/cn';

function Tooltip(props: ComponentProps<typeof Kobalte>) {
  return <Kobalte gutter={4} openDelay={150} closeDelay={0} {...props} />;
}

function TooltipTrigger(props: ParentProps<ComponentProps<typeof Kobalte.Trigger>>) {
  return <Kobalte.Trigger {...props} />;
}

function TooltipContent(props: ParentProps<ComponentProps<typeof Kobalte.Content>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Portal>
      <Kobalte.Content
        class={cn(
          'z-50 max-w-xs overflow-hidden rounded-md bg-[var(--ink-strong)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--bg-content)] shadow-lg',
          'animate-in fade-in-0 zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95',
          local.class
        )}
        {...rest}
      >
        {local.children}
      </Kobalte.Content>
    </Kobalte.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent };
