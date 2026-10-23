import { For } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Link, useLocation } from '@tanstack/solid-router';
import { usePermissions } from '~/api/permissions';
import { Bot, Cable, Files } from '~/components/icons';
import { cn } from '~/lib/cn';
import { canSeeExternalServices } from '~/components/external-service/service-access';

const SECTIONS = [
  { to: '/store/agents', label: 'Agents', icon: Bot },
  { to: '/store/skills', label: 'Skills', icon: Files },
  { to: '/store/external-services', label: 'External Services', icon: Cable },
] as const;

export function storeSectionForPath(pathname: string) {
  return SECTIONS.find((section) => pathname === section.to || pathname.startsWith(`${section.to}/`));
}

export function StoreNav() {
  const location = useLocation();
  const { hasPermission } = usePermissions();
  const sections = () =>
    SECTIONS.filter((section) => section.to !== '/store/external-services' || canSeeExternalServices(hasPermission));
  const isActive = (to: string) => storeSectionForPath(location().pathname)?.to === to;

  return (
    <nav aria-label="Store" class="shrink-0 bg-background shadow-[inset_0_-1px_0_var(--color-border)]">
      <div class="mx-auto w-full max-w-6xl overflow-x-auto px-4 [scrollbar-width:none] sm:px-6">
        <div class="flex items-center gap-5">
          <For each={sections()}>
            {(section) => (
              <Link
                to={section.to}
                search={{ filter: 'all', q: '' }}
                aria-current={isActive(section.to) ? 'page' : undefined}
                class={cn(
                  'inline-flex h-11 shrink-0 items-center gap-2 text-sm font-medium transition-[color,box-shadow]',
                  'focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  isActive(section.to)
                    ? 'text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]'
                    : 'text-muted-foreground hover:text-foreground hover:shadow-[inset_0_-2px_0_var(--color-border)]'
                )}
              >
                <Dynamic component={section.icon} class="h-4 w-4 shrink-0" aria-hidden="true" />
                {section.label}
              </Link>
            )}
          </For>
        </div>
      </div>
    </nav>
  );
}
