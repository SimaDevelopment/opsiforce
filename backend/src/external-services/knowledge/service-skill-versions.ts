import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { skills, skillVersions } from '../../../db/schema';
import { serviceSkillName } from '../../delivery/service-skill-source';
import { hashSkillTree } from '../../store/gate';
import { SkillRepository } from '../../store/skill.repository';
import { manifestDescription } from '../../store/skill-tree';
import type { RegisteredService } from '../registry/service-registry';
import { markedSkillOf, movePinsToLatest } from './service-skill.repository';
import { serviceSkillTree } from './service-skills';

@Injectable()
export class ServiceSkillVersions {
  private readonly logger = new Logger(ServiceSkillVersions.name);
  private readonly laying = new Map<string, Promise<boolean>>();

  constructor(private readonly skillRepository: SkillRepository) {}

  lay(service: RegisteredService): Promise<boolean> {
    const previous = this.laying.get(service.id) ?? Promise.resolve(false);
    const next = previous.catch(() => false).then(() => this.layNow(service));
    this.laying.set(service.id, next);
    return next;
  }

  private async layNow(service: RegisteredService): Promise<boolean> {
    const skillId = await this.skillOf(service);
    if (!skillId) return false;
    const tree = serviceSkillTree(service);
    const contentHash = hashSkillTree(tree);
    const [latest] = await db
      .select({ latestVersionId: skills.latestVersionId, contentHash: skillVersions.contentHash })
      .from(skills)
      .leftJoin(skillVersions, eq(skillVersions.id, skills.latestVersionId))
      .where(eq(skills.id, skillId));
    if (latest?.contentHash === contentHash) return false;
    const { versionId, version } = await this.skillRepository.mintNextVersion({
      skillId,
      userId: null,
      description: manifestDescription(tree),
      tree,
      contentHash,
      flags: { has_executables: false },
      lints: [],
      createdVia: 'service',
      sourceRef: null,
    });
    await movePinsToLatest(skillId, versionId);
    this.logger.log(`Laid version ${version} of ${serviceSkillName(service.slug)}`);
    return true;
  }

  private async skillOf(service: RegisteredService): Promise<string | null> {
    const existing = await markedSkillOf(service.id);
    if (existing) return existing.id;
    await db
      .insert(skills)
      .values({
        id: crypto.randomUUID(),
        tenantId: service.tenantId,
        origin: service.tenantId === null ? 'built_in' : 'custom',
        name: serviceSkillName(service.slug),
        description: service.manifest.description,
        visibility: 'public',
        externalServiceId: service.id,
      })
      .onConflictDoNothing();
    const created = await markedSkillOf(service.id);
    if (!created)
      this.logger.warn(`${serviceSkillName(service.slug)} is taken by another Skill; ${service.slug} gets none`);
    return created?.id ?? null;
  }
}
