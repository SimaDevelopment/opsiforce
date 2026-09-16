import { Show } from 'solid-js';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { useProjects } from '~/api/projects';
import { Code as CodeIcon, Database, Files, MessageSquare } from '~/components/icons';
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { ProjectActionsMenu } from '~/components/project-actions-menu';
import { EnvironmentsPopover } from '~/components/project/environments/environments-popover';
import type { ProjectStatus } from '~/api/client';
import type { ProjectEnvironment } from '~/api/environments';

export type ProjectTab = 'chat' | 'files' | 'code' | 'db';

export interface ProjectHeaderProps {
  projectId: string;
  status: ProjectStatus;
  workspaceId: string | null;
  appExists: boolean;
  showAgentTabs: boolean;
  activeTab: ProjectTab;
  onActiveTabChange: (tab: ProjectTab) => void;
  environments: ProjectEnvironment[];
  activeEnvironmentId: string;
  onActiveEnvironmentChange: (environmentId: string) => void;
  onDeleted: () => void;
}

export function ProjectHeader(props: ProjectHeaderProps) {
  const { hasPermission } = usePermissions();
  const canViewCode = () => hasPermission(Permission.viewCodeTab);
  const canViewDb = () => hasPermission(Permission.viewDbTab);
  const projects = useProjects();
  const project = () => projects.data?.find((p) => p.id === props.projectId);

  const handleEnvironmentDeleted = (environmentId: string) => {
    if (props.activeEnvironmentId === environmentId) {
      props.onActiveEnvironmentChange(props.projectId);
    }
  };

  return (
    <div class="flex items-center justify-between gap-2 px-3 py-2 bg-background border-b border-border shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <Tabs value={props.activeTab} onChange={(v) => props.onActiveTabChange(v as ProjectTab)} class="w-auto">
          <TabsList class="w-auto">
            <TabsTrigger value="chat" class="flex-none gap-1.5">
              <MessageSquare class="w-3.5 h-3.5" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="files" class="flex-none gap-1.5">
              <Files class="w-3.5 h-3.5" />
              Files
            </TabsTrigger>
            <Show when={props.showAgentTabs && canViewCode()}>
              <TabsTrigger value="code" class="flex-none gap-1.5">
                <CodeIcon class="w-3.5 h-3.5" />
                Code
              </TabsTrigger>
            </Show>
            <Show when={props.showAgentTabs && canViewDb()}>
              <TabsTrigger value="db" class="flex-none gap-1.5">
                <Database class="w-3.5 h-3.5" />
                DB
              </TabsTrigger>
            </Show>
          </TabsList>
        </Tabs>
        <EnvironmentsPopover
          projectId={props.projectId}
          environments={props.environments}
          activeEnvironmentId={props.activeEnvironmentId}
          onActiveEnvironmentChange={props.onActiveEnvironmentChange}
          onEnvironmentDeleted={handleEnvironmentDeleted}
        />
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <ProjectActionsMenu
          projectId={props.projectId}
          status={props.status}
          workspaceId={props.workspaceId}
          project={project()}
          activeEnvironmentId={props.activeEnvironmentId}
          onDeleted={props.onDeleted}
        />
      </div>
    </div>
  );
}
