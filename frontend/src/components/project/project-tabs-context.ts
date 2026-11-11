import { createContext, useContext } from 'solid-js';
import type { ProjectTab } from './project-header';

export const ProjectTabsContext = createContext<{ openTab: (tab: ProjectTab) => void }>();

export const useProjectTabs = () => useContext(ProjectTabsContext);
