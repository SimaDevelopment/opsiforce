import { DropdownMenu as Kobalte } from '@kobalte/core/dropdown-menu';
import { splitProps, type ParentProps, type ComponentProps } from 'solid-js';
import { cn } from '~/lib/cn';

function DropdownMenu(props: ComponentProps<typeof Kobalte>) {
  return <Kobalte gutter={4} {...props} />;
}

function DropdownMenuTrigger(props: ParentProps<ComponentProps<typeof Kobalte.Trigger>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Trigger class={cn('outline-none', local.class)} {...rest}>
      {local.children}
    </Kobalte.Trigger>
  );
}

function DropdownMenuContent(props: ParentProps<ComponentProps<typeof Kobalte.Content>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Portal>
      <Kobalte.Content
        class={cn(
          'z-50 min-w-32 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none',
          'animate-in fade-in-0 zoom-in-95',
          'data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95',
          local.class
        )}
        {...rest}
      >
        {local.children}
      </Kobalte.Content>
    </Kobalte.Portal>
  );
}

function DropdownMenuItem(props: ParentProps<ComponentProps<typeof Kobalte.Item>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Item
      class={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors',
        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        local.class
      )}
      {...rest}
    >
      {local.children}
    </Kobalte.Item>
  );
}

function DropdownMenuSeparator(props: ComponentProps<typeof Kobalte.Separator>) {
  const [local, rest] = splitProps(props, ['class']);
  return <Kobalte.Separator class={cn('-mx-1 my-1 h-px bg-border', local.class)} {...rest} />;
}

function DropdownMenuSub(props: ComponentProps<typeof Kobalte.Sub>) {
  return <Kobalte.Sub gutter={4} {...props} />;
}

function DropdownMenuSubTrigger(props: ParentProps<ComponentProps<typeof Kobalte.SubTrigger>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.SubTrigger
      class={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors',
        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        local.class
      )}
      {...rest}
    >
      {local.children}
    </Kobalte.SubTrigger>
  );
}

function DropdownMenuSubContent(props: ParentProps<ComponentProps<typeof Kobalte.SubContent>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Portal>
      <Kobalte.SubContent
        class={cn(
          'z-50 min-w-40 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none',
          'animate-in fade-in-0 zoom-in-95',
          'data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95',
          local.class
        )}
        {...rest}
      >
        {local.children}
      </Kobalte.SubContent>
    </Kobalte.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
