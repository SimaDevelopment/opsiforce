import { Popover as Kobalte } from '@kobalte/core/popover';
import { splitProps, type ComponentProps, type ParentProps } from 'solid-js';
import { cn } from '~/lib/cn';

export function PopoverContent(props: ParentProps<ComponentProps<typeof Kobalte.Content>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Portal>
      <Kobalte.Content
        class={cn(
          'z-50 w-72 max-w-[calc(100vw-1rem)] origin-[var(--kb-popover-content-transform-origin)] rounded-lg border border-border bg-popover text-popover-foreground shadow-xl outline-none',
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
