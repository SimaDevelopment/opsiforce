import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { agents, projectEnvironments, projects, skills } from '../../db/schema';
import { CHAT_KINDS, TEST_PROJECT_KIND, type ChatKind, type ProjectStatus } from '../project/project.types';
import type { BuilderSubjectType } from './builder.types';

export interface ChatRow {
  id: string;
  kind: ChatKind;
  disabled: boolean;
  lastPromptAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
}

export interface TestProjectRow {
  id: string;
  chatId: string;
  status: ProjectStatus;
  disabled: boolean;
}

export interface SubjectRow {
  type: BuilderSubjectType;
  id: string;
}

const chatFields = {
  id: projects.id,
  kind: projects.kind,
  disabled: projects.disabled,
  lastPromptAt: projects.lastPromptAt,
  createdAt: projects.createdAt,
  createdBy: projects.createdBy,
};

@Injectable()
export class BuilderChatRepository {
  async findChat(tenantId: string, chatId: string): Promise<ChatRow | null> {
    const [row] = (await db
      .select(chatFields)
      .from(projects)
      .where(
        and(eq(projects.id, chatId), eq(projects.tenantId, tenantId), inArray(projects.kind, [...CHAT_KINDS]))
      )) as ChatRow[];
    return row ?? null;
  }

  async subjectOf(chatId: string): Promise<SubjectRow | null> {
    const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.builderChatId, chatId)).limit(1);
    if (agent) return { type: 'agent', id: agent.id };
    const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.builderChatId, chatId)).limit(1);
    return skill ? { type: 'skill', id: skill.id } : null;
  }

  async claim(subject: SubjectRow, chatId: string): Promise<boolean> {
    const table = subject.type === 'agent' ? agents : skills;
    const claimed = await db
      .update(table)
      .set({ builderChatId: chatId })
      .where(and(eq(table.id, subject.id), isNull(table.builderChatId)))
      .returning({ id: table.id });
    return claimed.length > 0;
  }

  /** A list, not a row: ADR-0063 holds one live per chat, and leftovers must still be reachable. */
  async testProjectsOf(chatId: string): Promise<TestProjectRow[]> {
    return db
      .select({
        id: projects.id,
        chatId: projects.createdByProjectId,
        status: projectEnvironments.status,
        disabled: projects.disabled,
      })
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .where(and(eq(projects.kind, TEST_PROJECT_KIND), eq(projects.createdByProjectId, chatId)))
      .orderBy(desc(projects.createdAt)) as Promise<TestProjectRow[]>;
  }
}
