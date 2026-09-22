import { Bot, Files, MessageSquare } from '~/components/icons';
import { Permission } from '~/constants/permissions';
import { firstPermittedRailTab, railTabForPath, type RailTab } from '~/constants/section-rail';

export const STORE_GROUP_ORDER = ['Skill & Agent Store'] as const;

export const STORE_TABS: RailTab[] = [
  {
    to: '/store/agents',
    label: 'Agents',
    description:
      'Built-in agents ship with the platform. Custom agents hold one definition per environment — edit Development, then publish it onward.',
    group: 'Skill & Agent Store',
    icon: Bot,
    isPermitted: () => true,
  },
  {
    to: '/store/skills',
    label: 'Skills',
    description:
      'Published skill versions your agents can pin. Saving a skill publishes a new version — there are no drafts, and pins never move on their own.',
    group: 'Skill & Agent Store',
    icon: Files,
    isPermitted: () => true,
  },
  {
    to: '/store/builder',
    label: 'Skill & Agent Builder',
    description: 'Author skills and agents in chat, and test them in a real project.',
    group: 'Skill & Agent Store',
    icon: MessageSquare,
    isPermitted: (has) => has(Permission.manageSkills) || has(Permission.manageAgents),
  },
];

export function firstPermittedStoreTab(hasPermission: (permission: string) => boolean): RailTab | undefined {
  return firstPermittedRailTab(STORE_TABS, hasPermission);
}

export function storeTabForPath(pathname: string): RailTab | undefined {
  return railTabForPath(STORE_TABS, pathname);
}
