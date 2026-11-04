import { For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useLocation, useNavigate } from '@tanstack/solid-router';
import { ArrowLeft } from '~/components/icons';
import { useSidebar } from '~/components/ui/sidebar';
import type { RailTab } from '~/constants/section-rail';

export const COLLAPSED_ROW =
  'group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-0';
export const COLLAPSED_HIDDEN = 'group-data-[collapsible=icon]/sidebar:hidden';

/**
 * Settings and Admin take over the sidebar instead of opening a second rail
 * beside it. Two 240px columns of navigation for one page of content is the
 * arrangement the redesign set out to remove: the sidebar is the one place
 * the product lists where you can go, so it swaps its contents and offers the
 * way back.
 */
export function SidebarSectionNav(props: { title: string; tabs: RailTab[]; groupOrder: readonly string[] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { open } = useSidebar();
  const isActive = (to: string) => {
    const path = location().pathname;
    return path === to || path.startsWith(`${to}/`);
  };

  return (
    <nav class="flex flex-col gap-1 px-2 pt-1 pb-2" aria-label={props.title}>
      <button
        type="button"
        class={`of-row fr-panel ${COLLAPSED_ROW}`}
        title={open() ? undefined : 'Back to projects'}
        aria-label="Back to projects"
        onClick={() => navigate({ to: '/' })}
      >
        <ArrowLeft class="w-4 h-4 shrink-0" />
        <span class={`lbl ${COLLAPSED_HIDDEN}`}>Back to projects</span>
      </button>

      <For each={props.groupOrder}>
        {(group) => {
          const groupTabs = () => props.tabs.filter((tab) => tab.group === group);
          return (
            <Show when={groupTabs().length > 0}>
              <div class={`of-sb-sec-head mt-2 ${COLLAPSED_HIDDEN}`}>
                <span class="ttl">{group}</span>
              </div>
              <For each={groupTabs()}>
                {(tab) => (
                  <button
                    type="button"
                    class={`of-row fr-panel ${COLLAPSED_ROW}`}
                    aria-current={isActive(tab.to) ? 'page' : undefined}
                    onClick={() => navigate({ to: tab.to })}
                    title={`${tab.label} — ${tab.description}`}
                    aria-label={tab.label}
                  >
                    <Dynamic component={tab.icon} class="w-4 h-4 shrink-0" />
                    <span class={`lbl ${COLLAPSED_HIDDEN}`}>{tab.label}</span>
                  </button>
                )}
              </For>
            </Show>
          );
        }}
      </For>
    </nav>
  );
}
