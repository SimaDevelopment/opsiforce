import { Logger } from '@nestjs/common';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { skills, skillVersionFiles, skillVersions } from '../../db/schema';
import { SERVICE_SKILL_PREFIX } from '../delivery/service-skill-source';
import { hashSkillTree, type SkillTree } from './gate';
import { SKILL_MANIFEST_PATH } from './gate/skill-tree';

const RENAMED_PREFIX = 'store-';
const MAX_NAME_LENGTH = 64;
const logger = new Logger('ServiceSkillNames');

export function isReservedForServiceSkills(name: string): boolean {
  return name.startsWith(SERVICE_SKILL_PREFIX);
}

async function nameTaken(tenantId: string | null, name: string, skillId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.name, name),
        ne(skills.id, skillId),
        tenantId === null ? isNull(skills.tenantId) : or(eq(skills.tenantId, tenantId), isNull(skills.tenantId))
      )
    )
    .limit(1);
  return row !== undefined;
}

async function freeName(tenantId: string | null, name: string, skillId: string): Promise<string> {
  const base = `${RENAMED_PREFIX}${name}`.slice(0, MAX_NAME_LENGTH).replace(/-+$/, '');
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!(await nameTaken(tenantId, candidate, skillId))) return candidate;
  }
}

function renamedManifest(content: Buffer, name: string): Buffer {
  return Buffer.from(content.toString('utf8').replace(/^name:.*$/m, `name: ${name}`), 'utf8');
}

export async function renameSkillsReservedForServices(): Promise<void> {
  const reserved = await db
    .select({ id: skills.id, tenantId: skills.tenantId, name: skills.name })
    .from(skills)
    .where(and(sql`starts_with(${skills.name}, ${SERVICE_SKILL_PREFIX})`, isNull(skills.externalServiceId)));
  for (const skill of reserved) {
    const name = await freeName(skill.tenantId, skill.name, skill.id);
    await db.transaction(async (tx) => {
      await tx.update(skills).set({ name, updatedAt: new Date() }).where(eq(skills.id, skill.id));
      const versions = await tx
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, skill.id));
      for (const version of versions) {
        const files = await tx.select().from(skillVersionFiles).where(eq(skillVersionFiles.versionId, version.id));
        const tree: SkillTree = files.map((file) => ({
          path: file.path,
          content:
            file.path === SKILL_MANIFEST_PATH
              ? renamedManifest(Buffer.from(file.content), name)
              : Buffer.from(file.content),
          executable: file.isExecutable,
        }));
        const manifest = tree.find((file) => file.path === SKILL_MANIFEST_PATH);
        if (manifest) {
          await tx
            .update(skillVersionFiles)
            .set({ content: manifest.content, size: manifest.content.byteLength })
            .where(and(eq(skillVersionFiles.versionId, version.id), eq(skillVersionFiles.path, SKILL_MANIFEST_PATH)));
        }
        await tx
          .update(skillVersions)
          .set({ contentHash: hashSkillTree(tree) })
          .where(eq(skillVersions.id, version.id));
      }
    });
    logger.log(
      `Renamed Store Skill ${skill.name} to ${name}: names starting with ${SERVICE_SKILL_PREFIX} belong to Service skills`
    );
  }
}
