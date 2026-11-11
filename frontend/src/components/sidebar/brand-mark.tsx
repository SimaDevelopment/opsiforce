import { Link } from '@tanstack/solid-router';
import { branding } from '~/lib/branding';
import { cn } from '~/lib/cn';

/**
 * The mark carries no frame. A border and a tinted box make a glyph read as a
 * control, and this one is not clickable-looking furniture — it is the product
 * saying its own name. The sidebar's other glyphs (tenant avatar, nav icons)
 * all centre on one vertical spine, and `.of-sb-head` puts this one on it too,
 * which is why the gap here is 5 rather than 8: the mark is wider than they
 * are, so the wordmark still lands on the same label column as every row below.
 */
export function BrandMark(props: { class?: string; nameClass?: string }) {
  return (
    <Link
      to="/"
      title="Home"
      class={cn(
        'group/brand flex min-w-0 items-center gap-[5px] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.class
      )}
    >
      <img
        alt={branding.name}
        src={branding.icon}
        class="h-[26px] w-[26px] shrink-0 transition-opacity group-hover/brand:opacity-80"
      />
      <span aria-hidden="true" class={cn('truncate text-sm font-semibold', props.nameClass)}>
        {branding.name}
      </span>
    </Link>
  );
}
