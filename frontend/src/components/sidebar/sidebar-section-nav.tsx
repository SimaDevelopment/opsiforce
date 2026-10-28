import { For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useLocation, useNavigate } from '@tanstack/solid-router';
import { ArrowLeft } from '~/components/icons';
import type { RailTab } from '~/constants/section-rail';

/**
 * Settings and Admin take over the sidebar instead of opening a second rail
 * beside it. Two 240px columns of navigation for one page of content is the
 * arrangement the redesign set out to remove: the sidebar is the one place
 * the product lists where you can go, so it swaps its contents and offers the
 * way back.
 */
export function SidebarSectionNav(props: {
  title: string;
  tabs: RailTab[];
  groupOrder: readonly string[];
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = (to: string) => {
    const path = location().pathname;
    return path === to || path.startsWith(`${to}/`);
  };

  return (
    <nav class="flex flex-col gap-1 px-2 pb-2" aria-label={props.title}>
      <button type="button" class="of-row fr-panel" onClick={() => navigate({ to: '/' })}>
        <ArrowLeft class="w-4 h-4 shrink-0" />
        <span class="lbl">Back to projects</span>
      </button>

      <For each={props.groupOrder}>
        {(group) => {
          const groupTabs = () => props.tabs.filter((tab) => tab.group === group);
          return (
            <Show when={groupTabs().length > 0}>
              <div class="of-sb-sec-head mt-2">
                <span class="ttl">{group}</span>
              </div>
              <For each={groupTabs()}>
                {(tab) => (
                  <button
                    type="button"
                    class="of-row fr-panel"
                    aria-current={isActive(tab.to) ? 'page' : undefined}
                    onClick={() => navigate({ to: tab.to })}
                    title={tab.description}
                  >
                    <Dynamic component={tab.icon} class="w-4 h-4 shrink-0" />
                    <span class="lbl">{tab.label}</span>
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
