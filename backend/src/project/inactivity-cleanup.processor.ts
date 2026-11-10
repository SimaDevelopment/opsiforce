import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { and, eq, exists, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { projectSettings, projects } from '../../db/schema';
import { INACTIVITY_CLEANUP_STEPS, projectLastActivityAt, type InactivityCleanupStep } from './inactivity-cleanup';
import { ProjectService } from './project.service';

export const INACTIVITY_CLEANUP_QUEUE = 'project-inactivity-cleanup';

interface InactiveProject {
  id: string;
  tenantId: string;
}

@Processor(INACTIVITY_CLEANUP_QUEUE)
export class InactivityCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(InactivityCleanupProcessor.name);

  constructor(private readonly projectService: ProjectService) {
    super();
  }

  async process(): Promise<void> {
    const outcomes: string[] = [];
    for (const step of INACTIVITY_CLEANUP_STEPS) {
      const done = await this.sweep(step);
      if (done > 0) outcomes.push(`${step.done} ${done}`);
    }
    if (outcomes.length > 0) this.logger.log(`Inactivity cleanup ${outcomes.join(' and ')} Project(s)`);
  }

  private async inactiveProjects(condition: SQL): Promise<InactiveProject[]> {
    const rows = await db
      .select({ id: projects.id, tenantId: projects.tenantId })
      .from(projects)
      .innerJoin(projectSettings, eq(projectSettings.projectId, projects.id))
      .where(and(isNull(projects.kind), isNotNull(projects.tenantId), condition));
    return rows.filter((row): row is InactiveProject => row.tenantId !== null);
  }

  private async sweep(step: InactivityCleanupStep): Promise<number> {
    const after = projectSettings[step.field];
    const inactive = and(isNotNull(after), lt(projectLastActivityAt, sql`now() - ${after} * interval '1 millisecond'`));
    const condition = (step.onlyEnabledProjects ? and(eq(projects.disabled, false), inactive) : inactive) as SQL;
    const stillInactive = and(
      isNull(projects.kind),
      exists(
        db
          .select({ projectId: projectSettings.projectId })
          .from(projectSettings)
          .where(and(eq(projectSettings.projectId, projects.id), inactive))
      )
    ) as SQL;
    let done = 0;
    for (const candidate of await this.inactiveProjects(condition)) {
      try {
        if (await step.runIfStill(this.projectService, candidate.id, candidate.tenantId, stillInactive)) done++;
      } catch (err) {
        this.logger.warn(
          `Inactivity cleanup could not ${step.action} Project ${candidate.id}: ${(err as Error).message}`
        );
      }
    }
    return done;
  }
}
