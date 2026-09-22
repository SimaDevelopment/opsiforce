import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents, projectEnvironments, projects, skills, users } from '../../db/schema';
import {
  CHAT_KINDS,
  TEST_PROJECT_KIND,
  type ChatKind,
  type ChatVisibility,
  type ProjectStatus,
} from '../project/project.types';
import type { ProducedArtifact } from './builder.types';

export interface ChatRow {
  id: string;
  title: string | null;
  kind: ChatKind;
  visibility: ChatVisibility;
  disabled: boolean;
  lastPromptAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
  creatorDisplayName: string | null;
}

export interface TestProjectRow {
  id: string;
  chatId: string;
  status: ProjectStatus;
  disabled: boolean;
}

const chatFields = {
  id: projects.id,
  title: projects.title,
  kind: projects.kind,
  visibility: projects.chatVisibility,
  disabled: projects.disabled,
  lastPromptAt: projects.lastPromptAt,
  createdAt: projects.createdAt,
  createdBy: projects.createdBy,
  creatorDisplayName: users.displayName,
};

@Injectable()
export class BuilderChatRepository {
  listChats(tenantId: string): Promise<ChatRow[]> {
    return db
      .select(chatFields)
      .from(projects)
      .leftJoin(users, eq(users.id, projects.createdBy))
      .where(and(eq(projects.tenantId, tenantId), inArray(projects.kind, [...CHAT_KINDS])))
      .orderBy(desc(projects.createdAt), desc(projects.id)) as Promise<ChatRow[]>;
  }

  async findChat(tenantId: string, chatId: string): Promise<ChatRow | null> {
    const [row] = (await db
      .select(chatFields)
      .from(projects)
      .leftJoin(users, eq(users.id, projects.createdBy))
      .where(
        and(eq(projects.id, chatId), eq(projects.tenantId, tenantId), inArray(projects.kind, [...CHAT_KINDS]))
      )) as ChatRow[];
    return row ?? null;
  }

  /** A list, not a row: ADR-0063 holds one live per chat, and leftovers must still be reachable. */
  async testProjectsOf(chatIds: string[]): Promise<TestProjectRow[]> {
    if (chatIds.length === 0) return [];
    return db
      .select({
        id: projects.id,
        chatId: projects.createdByProjectId,
        status: projectEnvironments.status,
        disabled: projects.disabled,
      })
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .where(and(eq(projects.kind, TEST_PROJECT_KIND), inArray(projects.createdByProjectId, chatIds)))
      .orderBy(desc(projects.createdAt)) as Promise<TestProjectRow[]>;
  }

  async setVisibility(chatId: string, visibility: ChatVisibility): Promise<void> {
    await db.update(projects).set({ chatVisibility: visibility, updatedAt: new Date() }).where(eq(projects.id, chatId));
  }

  async producedBy(chatIds: string[]): Promise<Map<string, ProducedArtifact[]>> {
    const byChat = new Map<string, ProducedArtifact[]>(chatIds.map((id) => [id, []]));
    if (chatIds.length === 0) return byChat;

    const skillRows = await db
      .select({ chatId: skills.createdInChatProjectId, id: skills.id, name: skills.name })
      .from(skills)
      .where(inArray(skills.createdInChatProjectId, chatIds));
    const agentRows = await db
      .select({ chatId: agents.createdInChatProjectId, id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.createdInChatProjectId, chatIds));

    for (const row of skillRows) {
      if (row.chatId) byChat.get(row.chatId)?.push({ type: 'skill', id: row.id, name: row.name });
    }
    for (const row of agentRows) {
      if (row.chatId) byChat.get(row.chatId)?.push({ type: 'agent', id: row.id, name: row.name });
    }
    return byChat;
  }
}
