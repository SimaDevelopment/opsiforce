import { For } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Link, useLocation } from '@tanstack/solid-router';
import { Bot, Files } from '~/components/icons';
import { cn } from '~/lib/cn';

const SECTIONS = [
  { to: '/store/agents', label: 'Agents', icon: Bot },
  { to: '/store/skills', label: 'Skills', icon: Files },
] as const;

export function StoreNav() {
  const location = useLocation();
  const isActive = (to: string) => location().pathname === to || location().pathname.startsWith(`${to}/`);

  return (
    <nav aria-label="Store" class="shrink-0 border-b border-border bg-background">
      <div class="mx-auto flex w-full max-w-5xl items-center px-4 py-2 sm:px-6">
        <div class="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
          <For each={SECTIONS}>
            {(section) => (
              <Link
                to={section.to}
                search={{ filter: 'all', q: '' }}
                aria-current={isActive(section.to) ? 'page' : undefined}
                class={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  isActive(section.to) ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'
                )}
              >
                <Dynamic component={section.icon} class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {section.label}
              </Link>
            )}
          </For>
        </div>
      </div>
    </nav>
  );
}
