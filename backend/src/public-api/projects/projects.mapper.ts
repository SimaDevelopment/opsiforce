import { ProjectStatus, type AgentStatus } from '../../project/project.types';
import { runtimeBaseUrl, runtimeOpenapiUrl } from '../../common/runtime-urls';
import type { EnvironmentRow, ProjectRow } from './projects.repository';
import type { EnvironmentDto, ProjectDto } from './projects.schema';

const DEFAULT_ENVIRONMENT_NAME = 'Development';
const UNNAMED_ENVIRONMENT_NAME = 'Environment';

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toEnvironmentDto(row: EnvironmentRow, projectDisabled: boolean): EnvironmentDto {
  return {
    id: row.id,
    name: row.isDefault ? DEFAULT_ENVIRONMENT_NAME : (row.environmentName ?? UNNAMED_ENVIRONMENT_NAME),
    slug: row.environmentSlug,
    isDefault: row.isDefault,
    status: projectDisabled ? ProjectStatus.Disabled : row.status,
    hasApp: row.hasApp,
    appName: row.appName,
    lastActiveAt: isoOrNull(row.lastActiveAt),
    opencode: {
      baseUrl: runtimeBaseUrl(row.id),
      openapiUrl: runtimeOpenapiUrl(row.id),
      sessionId: row.sessionId,
    },
  };
}

export const ProjectMapper = {
  toDto: (project: ProjectRow, environments: EnvironmentRow[], agentStatus: AgentStatus): ProjectDto => ({
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
    agentStatus,
    lastPromptAt: isoOrNull(project.lastPromptAt),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    environments: environments.map((environment) => toEnvironmentDto(environment, project.disabled)),
  }),
};
