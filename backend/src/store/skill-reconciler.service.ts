import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { skills, skillVersionFiles, skillVersions } from '../../db/schema';
import { AgentReconcilerService } from '../agent/agent-reconciler.service';
import { isTextFile } from './gate/skill-tree';
import { agentConfigRoot, readComposedSkills, skillSourceDirectories, type ComposedSkill } from './skill-tree';
import { readdirSync } from 'node:fs';

const MINT_LOCK_NAMESPACE = 'skill-version-mint:';

@Injectable()
export class SkillReconcilerService implements OnModuleInit {
  private readonly logger = new Logger(SkillReconcilerService.name);
  private reconciled: Promise<void> | null = null;

  constructor(private readonly agentReconciler: AgentReconcilerService) {}

  async onModuleInit(): Promise<void> {
    await this.ready();
  }

  ready(): Promise<void> {
    this.reconciled ??= this.agentReconciler.ready().then(() => this.reconcile(readComposedSkills()));
    return this.reconciled;
  }

  async reconcile(composed: ComposedSkill[]): Promise<void> {
    for (const skill of composed) {
      const skillId = await this.upsertSkill(skill);
      await this.ensureVersion(skillId, skill);
      await this.pointAtNewestVersion(skillId, skill.description);
    }
    this.logger.log(`Reconciled ${composed.length} built-in skill(s) from the image`);
  }

  private async upsertSkill(skill: ComposedSkill): Promise<string> {
    await db
      .insert(skills)
      .values({ id: crypto.randomUUID(), name: skill.name, origin: 'built_in', description: skill.description })
      .onConflictDoNothing({ target: skills.name, where: isNull(skills.tenantId) });

    const [row] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.name, skill.name), isNull(skills.tenantId)))
      .limit(1);
    return row.id;
  }

  private async ensureVersion(skillId: string, skill: ComposedSkill): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${MINT_LOCK_NAMESPACE}${skillId}`}))`);

      const [existing] = await tx
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.contentHash, skill.contentHash)))
        .limit(1);
      if (existing) return;

      const [{ highest }] = await tx
        .select({ highest: sql<number>`coalesce(max(${skillVersions.version}), 0)` })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, skillId));

      const versionId = crypto.randomUUID();
      await tx.insert(skillVersions).values({
        id: versionId,
        skillId,
        version: Number(highest) + 1,
        description: skill.description,
        contentHash: skill.contentHash,
        flags: skill.flags,
        createdVia: 'reconciler',
      });

      if (skill.tree.length > 0) {
        await tx.insert(skillVersionFiles).values(
          skill.tree.map((file) => ({
            id: crypto.randomUUID(),
            versionId,
            path: file.path,
            content: file.content,
            size: file.content.byteLength,
            isBinary: !isTextFile(file.content),
            isExecutable: file.executable,
          }))
        );
      }
    });
  }

  private async pointAtNewestVersion(skillId: string, description: string | null): Promise<void> {
    const [newest] = await db
      .select({ id: skillVersions.id })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.version))
      .limit(1);
    if (!newest) return;

    await db
      .update(skills)
      .set({ latestVersionId: newest.id, description, updatedAt: new Date() })
      .where(and(eq(skills.id, skillId), sql`${skills.latestVersionId} is distinct from ${newest.id}`));
  }
}

export function imageSkillNames(root: string = agentConfigRoot()): Set<string> {
  const names = new Set<string>();
  for (const directory of skillSourceDirectories(root)) {
    for (const entry of entriesOf(directory)) {
      names.add(entry);
    }
  }
  return names;
}

export function reservedSkillNames(root: string = agentConfigRoot()): Set<string> {
  return imageSkillNames(root);
}

function entriesOf(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
