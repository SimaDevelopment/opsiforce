import { Tabs as Kobalte } from '@kobalte/core/tabs';
import { splitProps, type ParentProps, type ComponentProps } from 'solid-js';
import { cn } from '~/lib/cn';

function Tabs(props: ComponentProps<typeof Kobalte>) {
  const [local, rest] = splitProps(props, ['class']);
  return <Kobalte class={cn('w-full', local.class)} {...rest} />;
}

/**
 * `segmented` is the default — a control inside a panel. `folder` is for tabs
 * that sit on the band and own the surface below them, where the selected tab
 * has to merge into the content rather than float above it.
 */
function TabsList(props: ParentProps<ComponentProps<typeof Kobalte.List> & { variant?: 'segmented' | 'folder' }>) {
  const [local, rest] = splitProps(props, ['class', 'children', 'variant']);
  return (
    <Kobalte.List
      class={cn(
        local.variant === 'folder'
          ? 'of-tabs overflow-x-auto [scrollbar-width:none]'
          : 'of-seg inline-flex items-center justify-start overflow-x-auto [scrollbar-width:none] w-full',
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
        'flex-1 fr disabled:pointer-events-none disabled:opacity-50',
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
