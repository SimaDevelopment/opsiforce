import { Show } from 'solid-js';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from '~/components/icons';
import { cn } from '~/lib/cn';

const spinnerIconVariants = cva('animate-spin text-muted-foreground', {
  variants: {
    size: {
      xs: 'w-3 h-3',
      sm: 'w-3.5 h-3.5',
      md: 'w-4 h-4',
      lg: 'w-6 h-6',
    },
  },
  defaultVariants: { size: 'md' },
});

type SpinnerSize = VariantProps<typeof spinnerIconVariants>['size'];

export interface SpinnerProps {
  label?: string;
  size?: SpinnerSize;
  class?: string;
  overlay?: boolean;
}

export function Spinner(props: SpinnerProps) {
  const content = (
    <div class="flex items-center justify-center gap-2 text-muted-foreground">
      <LoaderCircle class={spinnerIconVariants({ size: props.size })} />
      <Show when={props.label}>
        <span class="text-sm">{props.label}</span>
      </Show>
    </div>
  );

  return (
    <Show
      when={props.overlay}
      fallback={<div class={cn('flex items-center justify-center h-full', props.class)}>{content}</div>}
    >
      <div class={cn('absolute inset-0 flex items-center justify-center bg-background z-10', props.class)}>
        {content}
      </div>
    </Show>
  );
}
