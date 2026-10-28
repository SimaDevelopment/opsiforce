import { Switch as Kobalte } from '@kobalte/core/switch';
import { splitProps, type ComponentProps, type ParentProps } from 'solid-js';
import { cn } from '~/lib/cn';

export function SwitchControl(props: ParentProps<ComponentProps<typeof Kobalte.Control>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <>
      <Kobalte.Input class="peer sr-only" />
      <Kobalte.Control
        class={cn(
          'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
          'data-[checked]:bg-[var(--job-done)] bg-muted-foreground/30',
          local.class
        )}
        {...rest}
      >
        {local.children}
      </Kobalte.Control>
    </>
  );
}
