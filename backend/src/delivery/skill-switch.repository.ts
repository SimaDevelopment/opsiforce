import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectEnvironmentSkillsOff } from '../../db/schema';

export interface SwitchedOffSkill {
  skillName: string;
  switchedOffBy: string | null;
  switchedOffAt: Date;
}

export interface SwitchedOffSetChange {
  switchedOff: string[];
  switchedOn: string[];
}

@Injectable()
export class SkillSwitchRepository {
  async switchedOff(projectEnvironmentId: string): Promise<SwitchedOffSkill[]> {
    return db
      .select({
        skillName: projectEnvironmentSkillsOff.skillName,
        switchedOffBy: projectEnvironmentSkillsOff.switchedOffBy,
        switchedOffAt: projectEnvironmentSkillsOff.switchedOffAt,
      })
      .from(projectEnvironmentSkillsOff)
      .where(eq(projectEnvironmentSkillsOff.projectEnvironmentId, projectEnvironmentId));
  }

  async switchedOffNames(projectEnvironmentId: string): Promise<Set<string>> {
    return new Set((await this.switchedOff(projectEnvironmentId)).map((row) => row.skillName));
  }

  async switchOff(projectEnvironmentId: string, skillName: string, switchedOffBy: string | null): Promise<void> {
    await db
      .insert(projectEnvironmentSkillsOff)
      .values({ projectEnvironmentId, skillName, switchedOffBy })
      .onConflictDoNothing();
  }

  async switchOn(projectEnvironmentId: string, skillName: string): Promise<boolean> {
    const deleted = await db
      .delete(projectEnvironmentSkillsOff)
      .where(
        and(
          eq(projectEnvironmentSkillsOff.projectEnvironmentId, projectEnvironmentId),
          eq(projectEnvironmentSkillsOff.skillName, skillName)
        )
      )
      .returning({ skillName: projectEnvironmentSkillsOff.skillName });
    return deleted.length > 0;
  }

  async replace(sourceProjectEnvironmentId: string, targetProjectEnvironmentId: string): Promise<SwitchedOffSetChange> {
    return db.transaction(async (tx) => {
      const source = await tx
        .select({
          skillName: projectEnvironmentSkillsOff.skillName,
          switchedOffBy: projectEnvironmentSkillsOff.switchedOffBy,
          switchedOffAt: projectEnvironmentSkillsOff.switchedOffAt,
        })
        .from(projectEnvironmentSkillsOff)
        .where(eq(projectEnvironmentSkillsOff.projectEnvironmentId, sourceProjectEnvironmentId));
      const previous = await tx
        .delete(projectEnvironmentSkillsOff)
        .where(eq(projectEnvironmentSkillsOff.projectEnvironmentId, targetProjectEnvironmentId))
        .returning({ skillName: projectEnvironmentSkillsOff.skillName });
      if (source.length > 0) {
        await tx
          .insert(projectEnvironmentSkillsOff)
          .values(source.map((row) => ({ ...row, projectEnvironmentId: targetProjectEnvironmentId })));
      }
      const before = new Set(previous.map((row) => row.skillName));
      const after = new Set(source.map((row) => row.skillName));
      return {
        switchedOff: [...after].filter((name) => !before.has(name)).toSorted(),
        switchedOn: [...before].filter((name) => !after.has(name)).toSorted(),
      };
    });
  }
}
