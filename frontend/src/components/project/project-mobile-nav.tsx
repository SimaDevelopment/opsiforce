import { For, type Component } from 'solid-js';
import { AppWindow, Code as CodeIcon, Database, Files, MessageSquare, Users } from '~/components/icons';
import { PROJECT_TAB_LABELS, type ProjectTab } from '~/components/project/project-header';

/**
 * A phone has no room on the band for the project's tabs, so they live in a
 * bottom bar instead: one destination per tab plus the App preview, which on
 * a desktop is a docked column and on a phone is a full-screen overlay. The
 * bar stays put while the overlay is open, so leaving the preview is one tap,
 * like arriving at it.
 */
export type ProjectMobileDestination = ProjectTab | 'preview';

export interface ProjectMobileNavProps {
  active: ProjectMobileDestination;
  /** The tabs this user may open, in band order. */
  tabs: ProjectTab[];
  showPreview: boolean;
  onSelect: (destination: ProjectMobileDestination) => void;
}

const ICONS: Record<ProjectMobileDestination, Component<{ class?: string }>> = {
  chat: MessageSquare,
  files: Files,
  code: CodeIcon,
  db: Database,
  users: Users,
  preview: AppWindow,
};

const LABELS: Record<ProjectMobileDestination, string> = { ...PROJECT_TAB_LABELS, preview: 'Preview' };

export function ProjectMobileNav(props: ProjectMobileNavProps) {
  const items = (): ProjectMobileDestination[] => (props.showPreview ? [...props.tabs, 'preview'] : props.tabs);
  return (
    <nav class="of-mobile-nav" aria-label="Project sections">
      <For each={items()}>
        {(destination) => {
          const Icon = ICONS[destination];
          return (
            <button
              type="button"
              class="of-mobile-nav-item"
              aria-current={props.active === destination ? 'page' : undefined}
              onClick={() => props.onSelect(destination)}
            >
              <span class="of-mobile-nav-icon">
                <Icon class="h-[22px] w-[22px]" />
              </span>
              <span class="of-mobile-nav-label">{LABELS[destination]}</span>
            </button>
          );
        }}
      </For>
    </nav>
  );
}
