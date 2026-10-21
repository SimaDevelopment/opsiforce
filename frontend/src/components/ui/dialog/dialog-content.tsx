import { Dialog as Kobalte } from '@kobalte/core/dialog';
import { splitProps, Show, type ComponentProps, type ParentProps } from 'solid-js';
import { X } from '~/components/icons';
import { cn } from '~/lib/cn';

type DialogContentProps = ParentProps<
  ComponentProps<typeof Kobalte.Content> & { hideClose?: boolean; align?: 'center' | 'top' }
>;

export function DialogContent(props: DialogContentProps) {
  const [local, rest] = splitProps(props, ['class', 'children', 'hideClose', 'align']);
  return (
    <Kobalte.Portal>
      <Kobalte.Overlay
        class={cn(
          'fixed inset-0 z-50 bg-black/50',
          'data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0'
        )}
      />
      <div
        class={cn(
          'fixed inset-0 z-50 flex justify-center',
          local.align === 'top' ? 'items-start pt-[8vh]' : 'items-center'
        )}
      >
        <Kobalte.Content
          class={cn(
            'relative z-50 w-full max-w-md overflow-y-auto rounded-lg border border-border bg-popover p-6 shadow-lg',
            local.align === 'top' ? 'max-h-[84dvh]' : 'max-h-[calc(100dvh-2rem)]',
            'animate-in fade-in-0 zoom-in-95',
            'data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95',
            local.class
          )}
          {...rest}
        >
          {local.children}
          <Show when={!local.hideClose}>
            <Kobalte.CloseButton
              class={cn(
                'absolute right-3 top-3 inline-flex items-center justify-center rounded-md w-7 h-7',
                'text-muted-foreground hover:bg-accent hover:text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
              )}
              aria-label="Close"
            >
              <X class="w-4 h-4" />
            </Kobalte.CloseButton>
          </Show>
        </Kobalte.Content>
      </div>
    </Kobalte.Portal>
  );
}
