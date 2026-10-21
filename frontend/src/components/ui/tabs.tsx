import { Tabs as Kobalte } from '@kobalte/core/tabs';
import { splitProps, type ParentProps, type ComponentProps } from 'solid-js';
import { cn } from '~/lib/cn';

function Tabs(props: ComponentProps<typeof Kobalte>) {
  const [local, rest] = splitProps(props, ['class']);
  return <Kobalte class={cn('w-full', local.class)} {...rest} />;
}

function TabsList(props: ParentProps<ComponentProps<typeof Kobalte.List>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.List
      class={cn(
        'inline-flex h-9 items-center justify-start overflow-x-auto [scrollbar-width:none] rounded-lg bg-muted p-1 text-muted-foreground w-full',
        local.class
      )}
      {...rest}
    >
      {local.children}
    </Kobalte.List>
  );
}

function TabsTrigger(props: ParentProps<ComponentProps<typeof Kobalte.Trigger>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Trigger
      class={cn(
        'inline-flex flex-1 items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium ring-offset-background transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow-sm',
        local.class
      )}
      {...rest}
    >
      {local.children}
    </Kobalte.Trigger>
  );
}

function TabsContent(props: ParentProps<ComponentProps<typeof Kobalte.Content>>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <Kobalte.Content
      class={cn(
        'mt-3 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        local.class
      )}
      {...rest}
    >
      {local.children}
    </Kobalte.Content>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
