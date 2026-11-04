import { Select as Kobalte } from '@kobalte/core/select';
import { splitProps, type ParentProps, type ComponentProps } from 'solid-js';
import { cn } from '~/lib/cn';

function Select<Option, OptGroup = never>(props: ComponentProps<typeof Kobalte<Option, OptGroup>>) {
  return <Kobalte gutter={4} {...props} />;
}

function SelectTrigger(props: ParentProps<ComponentProps<typeof Kobalte.Trigger>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Trigger
      class={cn(
        'flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2.5 py-1.5 text-xs ring-offset-background transition-colors',
        'placeholder:text-muted-foreground',
        'focus:outline-none focus:ring-1 focus:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        local.class
      )}
      {...rest}
    >
      {local.children}
      <Kobalte.Icon class="ml-2 shrink-0">
        <svg
          class="w-3.5 h-3.5 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
        </svg>
      </Kobalte.Icon>
    </Kobalte.Trigger>
  );
}

function SelectValue<T>(props: ComponentProps<typeof Kobalte.Value<T>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Value class={cn('text-xs text-foreground', local.class)} {...rest}>
      {local.children}
    </Kobalte.Value>
  );
}

function SelectContent(props: ParentProps<ComponentProps<typeof Kobalte.Content>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Portal>
      <Kobalte.Content
        class={cn(
          'z-50 min-w-32 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md',
          'animate-in fade-in-0 zoom-in-95',
          'data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95',
          local.class
        )}
        {...rest}
      >
        <Kobalte.Listbox class="p-1" />
        {local.children}
      </Kobalte.Content>
    </Kobalte.Portal>
  );
}

function SelectItem(props: ParentProps<ComponentProps<typeof Kobalte.Item>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Item
      class={cn(
        'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors',
        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        local.class
      )}
      {...rest}
    >
      <Kobalte.ItemLabel>{local.children}</Kobalte.ItemLabel>
      <Kobalte.ItemIndicator class="ml-auto">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </Kobalte.ItemIndicator>
    </Kobalte.Item>
  );
}

function SelectSection(props: ParentProps<ComponentProps<typeof Kobalte.Section>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Section
      class={cn(
        'px-2 pt-1.5 pb-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground',
        local.class
      )}
      {...rest}
    >
      {local.children}
    </Kobalte.Section>
  );
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectSection };
