import { Link } from '@tanstack/solid-router';
import { branding } from '~/lib/branding';
import { cn } from '~/lib/cn';

export function BrandMark(props: { class?: string; nameClass?: string }) {
  return (
    <Link
      to="/"
      title="Home"
      class={cn(
        'group/brand flex min-w-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.class
      )}
    >
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/5 transition-colors group-hover/brand:bg-foreground/10">
        <img alt={branding.name} src={branding.icon} class="h-4 w-4" />
      </span>
      <span aria-hidden="true" class={cn('truncate text-sm font-semibold', props.nameClass)}>
        {branding.name}
      </span>
    </Link>
  );
}
