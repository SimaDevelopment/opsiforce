import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { agents, externalServices, projectEnvironments, projects, skills } from '../../db/schema';
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

export interface ClaimableSubjectRow extends SubjectRow {
  type: 'agent' | 'skill';
}

export interface ExternalServiceSubjectRow {
  id: string;
  slug: string;
  title: string | null;
  disabled: boolean;
  builderChatId: string | null;
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
    if (skill) return { type: 'skill', id: skill.id };
    const [service] = await db
      .select({ id: externalServices.id })
      .from(externalServices)
      .where(eq(externalServices.builderChatId, chatId))
      .limit(1);
    return service ? { type: 'external_service', id: service.id } : null;
  }

  async findExternalService(tenantId: string, id: string): Promise<ExternalServiceSubjectRow | null> {
    const [row] = await db
      .select({
        id: externalServices.id,
        slug: externalServices.slug,
        title: projects.title,
        disabled: projects.disabled,
        builderChatId: externalServices.builderChatId,
      })
      .from(externalServices)
      .innerJoin(projects, eq(projects.id, externalServices.builderChatId))
      .where(and(eq(externalServices.id, id), eq(externalServices.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  }

  async claim(subject: ClaimableSubjectRow, chatId: string): Promise<boolean> {
    const table = subject.type === 'agent' ? agents : skills;
    const claimed = await db
      .update(table)
      .set({ builderChatId: chatId })
      .where(and(eq(table.id, subject.id), isNull(table.builderChatId)))
      .returning({ id: table.id });
    return claimed.length > 0;
  }

  /** Oldest first, so two racing creates agree on which one is the chat's Test Project. */
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
      .orderBy(asc(projects.createdAt), asc(projects.id)) as Promise<TestProjectRow[]>;
  }
}
