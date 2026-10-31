import type { PublicUrlService } from '../../project-environment/public-url.service';
import { environmentDisplayName } from '../../project/project.service';
import { ProjectStatus, type AgentStatus } from '../../project/project.types';
import { runtimeBaseUrl, runtimeOpenapiUrl } from '../../common/runtime-urls';
import type { EnvironmentRow, ProjectRow } from './projects.repository';
import type { EnvironmentDto, ProjectDto } from './projects.schema';

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toEnvironmentDto(
  row: EnvironmentRow,
  projectDisabled: boolean,
  publicUrls: PublicUrlService,
  runtimeOrigin: string
): EnvironmentDto {
  return {
    id: row.id,
    name: environmentDisplayName(row),
    slug: row.environmentSlug,
    isDefault: row.isDefault,
    status: projectDisabled ? ProjectStatus.Disabled : row.status,
    hasApp: row.hasApp,
    appName: row.appName,
    publicUrl: publicUrls.publicUrlOnceLive(row),
    lastActiveAt: isoOrNull(row.lastActiveAt),
    opencode: {
      baseUrl: `${runtimeOrigin}${runtimeBaseUrl(row.id)}`,
      openapiUrl: `${runtimeOrigin}${runtimeOpenapiUrl(row.id)}`,
      sessionId: row.sessionId,
    },
  };
}

export const ProjectMapper = {
  toDto: (
    project: ProjectRow,
    environments: EnvironmentRow[],
    activity: { agentStatus: AgentStatus; waitingForInput: boolean },
    publicUrls: PublicUrlService,
    runtimeOrigin: string
  ): ProjectDto => ({
    id: project.id,
    title: project.title,
    description: project.description,
    agent: { id: project.agentId, name: project.agentName },
    workspace:
      project.workspaceId === null || project.workspaceName === null || project.workspaceType === null
        ? null
        : { id: project.workspaceId, name: project.workspaceName, type: project.workspaceType },
    folder:
      project.folderId === null || project.folderName === null
        ? null
        : { id: project.folderId, name: project.folderName },
    disabled: project.disabled,
    createdBy: project.createdBy,
    createdByProjectId: project.createdByProjectId,
    kind: project.kind,
    importedAgent: project.importedAgent,
    timezone: project.timezone,
    agentStatus: activity.agentStatus,
    waitingForInput: activity.waitingForInput,
    lastPromptAt: isoOrNull(project.lastPromptAt),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    environments: environments.map((environment) =>
      toEnvironmentDto(environment, project.disabled, publicUrls, runtimeOrigin)
    ),
  }),
};
