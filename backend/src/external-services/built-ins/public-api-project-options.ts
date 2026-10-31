import type { CallerIdentity, OptionItem } from '@opsiforce/external-service-sdk';
import { maxOptionsPerCall } from '@opsiforce/external-service-sdk/server';
import { and, asc, desc, eq, ilike, isNull, not, or, type Column } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db';
import { agents, projects, workspaceMembers, workspaces } from '../../../db/schema';
import { agentDisabledIn, liveAgentsWhere } from '../../agent/agent-visibility';
import { containsPattern } from '../../common/like-pattern';
import { formCallRequester } from '../gate/form-call-requester';
import { otherProjectCandidatesWhere } from '../../project/calling-project-reach';
import { visibleProjectsFilter } from '../../project/project-visibility';

export const OTHER_PROJECT_CHOICES = 'otherProjectChoices';

export const CREATED_PROJECT_AGENT_CHOICES = 'createdProjectAgentChoices';

export const CREATED_PROJECT_WORKSPACE_CHOICES = 'createdProjectWorkspaceChoices';

const projectWorkspace = alias(workspaces, 'project_workspace');

const PUBLIC_WORKSPACE_LABEL = 'Public';

function containing(query: string, ...columns: Column[]) {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  const pattern = containsPattern(trimmed);
  return or(...columns.map((column) => ilike(column, pattern)));
}

interface ChoicesViewer {
  userId: string;
  callingProjectId?: string;
}

async function choicesViewerOf(caller: CallerIdentity): Promise<ChoicesViewer | null> {
  if (caller.projectId === undefined) {
    const userId = formCallRequester();
    return userId ? { userId } : null;
  }
  const [calling] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(and(eq(projects.id, caller.projectId), eq(projects.tenantId, caller.tenantId)));
  return calling?.createdBy ? { userId: calling.createdBy, callingProjectId: caller.projectId } : null;
}

export async function otherProjectChoicesFor(caller: CallerIdentity, query: string): Promise<OptionItem[]> {
  const viewer = await choicesViewerOf(caller);
  if (!viewer) return [];

  const visible = visibleProjectsFilter(caller.tenantId, viewer.userId);
  const candidates = viewer.callingProjectId
    ? otherProjectCandidatesWhere(viewer.callingProjectId)
    : isNull(projects.kind);
  const rows = await db
    .select({ id: projects.id, title: projects.title, workspaceName: projectWorkspace.name })
    .from(projects)
    .leftJoin(workspaceMembers, visible.workspaceMemberJoin)
    .leftJoin(projectWorkspace, eq(projectWorkspace.id, projects.workspaceId))
    .where(and(visible.where, candidates, containing(query, projects.title)))
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .limit(maxOptionsPerCall);

  return rows.map((row) => ({
    value: row.id,
    label: `${row.title?.trim() || 'Untitled project'} · ${row.workspaceName ?? PUBLIC_WORKSPACE_LABEL}`,
  }));
}

export async function createdProjectAgentChoicesFor(caller: CallerIdentity, query: string): Promise<OptionItem[]> {
  const viewer = await choicesViewerOf(caller);
  if (!viewer) return [];

  const rows = await db
    .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
    .from(agents)
    .where(
      and(
        liveAgentsWhere(caller.tenantId, viewer.userId),
        not(agentDisabledIn(caller.tenantId)),
        containing(query, agents.displayName, agents.name)
      )
    )
    .orderBy(asc(agents.name))
    .limit(maxOptionsPerCall);

  return rows.map((row) => ({ value: row.id, label: row.displayName ?? row.name }));
}

export async function createdProjectWorkspaceChoicesFor(caller: CallerIdentity, query: string): Promise<OptionItem[]> {
  const viewer = await choicesViewerOf(caller);
  if (!viewer) return [];

  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, viewer.userId))
    )
    .where(
      and(eq(workspaces.tenantId, caller.tenantId), eq(workspaces.type, 'shared'), containing(query, workspaces.name))
    )
    .orderBy(asc(workspaces.name))
    .limit(maxOptionsPerCall);

  return rows.map((row) => ({ value: row.id, label: row.name }));
}
