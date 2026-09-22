import { For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useLocation, useNavigate } from '@tanstack/solid-router';
import { cn } from '~/lib/cn';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '~/components/ui/sidebar';
import type { RailTab } from '~/constants/section-rail';

export function SectionRail(props: {
  tabs: RailTab[];
  groupOrder: readonly string[];
  belowTabsOnDesktop?: JSX.Element;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = (to: string) => {
    const path = location().pathname;
    return path === to || path.startsWith(`${to}/`);
  };
  const go = (to: string) => navigate({ to });

  return (
    <>
      <nav class="hidden shrink-0 flex-col gap-1 overflow-y-auto border-r border-sidebar-border bg-sidebar p-3 md:flex md:w-56 lg:w-60">
        <For each={props.groupOrder}>
          {(group) => {
            const groupTabs = () => props.tabs.filter((tab) => tab.group === group);
            return (
              <Show when={groupTabs().length > 0}>
                <div class="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted-foreground first:pt-1">
                  {group}
                </div>
                <SidebarMenu>
                  <For each={groupTabs()}>
                    {(tab) => (
                      <SidebarMenuItem>
                        <SidebarMenuButton isActive={isActive(tab.to)} onClick={() => go(tab.to)}>
                          <Dynamic component={tab.icon} class="h-4 w-4 shrink-0" />
                          <span class="truncate">{tab.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )}
                  </For>
                </SidebarMenu>
              </Show>
            );
          }}
        </For>
        <Show when={props.belowTabsOnDesktop}>{props.belowTabsOnDesktop}</Show>
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
