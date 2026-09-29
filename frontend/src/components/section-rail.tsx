import { For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useLocation, useNavigate } from '@tanstack/solid-router';
import { cn } from '~/lib/cn';
import { PanelLeftClose, PanelLeftOpen } from '~/components/icons';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '~/components/ui/sidebar';
import { createPersistedSignal } from '~/lib/persisted-signal';
import type { RailTab } from '~/constants/section-rail';

const COLLAPSED_KEY = 'opsiforce:section-rail:collapsed';

export function SectionRail(props: { tabs: RailTab[]; groupOrder: readonly string[] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = createPersistedSignal<boolean>(COLLAPSED_KEY, false);
  const isActive = (to: string) => {
    const path = location().pathname;
    return path === to || path.startsWith(`${to}/`);
  };
  const go = (to: string) => navigate({ to });

  return (
    <>
      <nav
        class={cn(
          'hidden shrink-0 flex-col gap-1 overflow-y-auto border-r border-sidebar-border bg-sidebar md:flex',
          collapsed() ? 'p-2 md:w-14' : 'p-3 md:w-56 lg:w-60'
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed())}
          aria-label={collapsed() ? 'Expand the section rail' : 'Collapse the section rail'}
          title={collapsed() ? 'Expand the section rail' : 'Collapse the section rail'}
          class={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            collapsed() ? 'self-center' : 'self-end'
          )}
        >
          <Show when={collapsed()} fallback={<PanelLeftClose class="h-4 w-4" />}>
            <PanelLeftOpen class="h-4 w-4" />
          </Show>
        </button>

        <For each={props.groupOrder}>
          {(group) => {
            const groupTabs = () => props.tabs.filter((tab) => tab.group === group);
            return (
              <Show when={groupTabs().length > 0}>
                <Show when={!collapsed()}>
                  <div class="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted-foreground first:pt-1">
                    {group}
                  </div>
                </Show>
                <SidebarMenu>
                  <For each={groupTabs()}>
                    {(tab) => (
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={isActive(tab.to)}
                          onClick={() => go(tab.to)}
                          class={collapsed() ? 'justify-center' : undefined}
                          title={tab.label}
                        >
                          <Dynamic component={tab.icon} class="h-4 w-4 shrink-0" />
                          <Show when={!collapsed()}>
                            <span class="truncate">{tab.label}</span>
                          </Show>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )}
                  </For>
                </SidebarMenu>
              </Show>
            );
          }}
        </For>
      </nav>

      <nav class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-sidebar-border bg-sidebar p-2 md:hidden">
        <For each={props.tabs}>
          {(tab) => (
            <button
              onClick={() => go(tab.to)}
              class={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                isActive(tab.to)
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/60'
              )}
            >
              <Dynamic component={tab.icon} class="h-3.5 w-3.5 shrink-0" />
              {tab.label}
            </button>
          )}
        </For>
      </nav>
    </>
  );
}
