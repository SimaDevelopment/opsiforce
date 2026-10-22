import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DeliveryResult } from '@opsiforce/external-service-sdk';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceProjectConfigs, projectEnvironments, projects } from '../../../db/schema';
import { Doorbell } from '../doorbell/doorbell';
import { legacyMessagesFor } from '../legacy/legacy-messages';
import type { RegisteredService } from '../registry/service-registry';
import { EventDeliveryCap } from './event-delivery-cap';
import type { EventEnvelope } from './event-envelope';
import { laneReceivers } from './event-receivers';
import { ExternalServiceStore } from './external-service-store';

export class EventDeliveryFailed extends Error {
  constructor(
    readonly status: 500 | 503,
    message: string
  ) {
    super(message);
  }
}

@Injectable()
export class EventDeliveries {
  private readonly logger = new Logger(EventDeliveries.name);
  private readonly storageMountPath: string;

  constructor(
    private readonly store: ExternalServiceStore,
    private readonly doorbell: Doorbell,
    private readonly cap: EventDeliveryCap,
    config: ConfigService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async deliver(copy: RegisteredService, { event, to }: EventEnvelope): Promise<DeliveryResult[]> {
    const directories = await this.connectedReceivers(copy, to);
    const results: DeliveryResult[] = [];
    const held: { projectEnvironmentId: string }[] = [];
    const unstored: string[] = [];
    for (const projectEnvironmentId of to) {
      const directory = directories.get(projectEnvironmentId);
      if (directory === undefined) {
        results.push({ projectEnvironmentId, result: 'not-connected' });
        continue;
      }
      if (!this.cap.admit(copy.id, projectEnvironmentId)) {
        results.push({ projectEnvironmentId, result: 'over-cap' });
        continue;
      }
      try {
        const eventIds = await this.store.storeEvents(
          path.join(this.storageMountPath, directory),
          copy.slug,
          [event],
          await legacyMessagesFor(copy, projectEnvironmentId)
        );
        results.push({ projectEnvironmentId, result: eventIds.length > 0 ? 'stored' : 'duplicate' });
        held.push({ projectEnvironmentId });
      } catch (error) {
        unstored.push(projectEnvironmentId);
        this.logger.error(
          `Could not store the ${event.type} Event ${event.key} of "${copy.slug}" for environment ${projectEnvironmentId}`,
          (error as Error).stack
        );
      }
    }

    try {
      await this.doorbell.ringFor(copy, held);
    } catch (error) {
      this.logger.error(`Could not queue the doorbell for "${copy.slug}"`, (error as Error).stack);
      throw new EventDeliveryFailed(503, 'The Event was stored but the App could not be notified; send it again.');
    }
    if (unstored.length > 0) {
      throw new EventDeliveryFailed(
        500,
        `The Event could not be stored for ${unstored.join(', ')}; send it again (its key keeps it from doubling).`
      );
    }
    return results;
  }

  private async connectedReceivers(copy: RegisteredService, to: readonly string[]): Promise<Map<string, string>> {
    if (to.length === 0) return new Map();
    const rows = await db
      .select({
        projectEnvironmentId: externalServiceProjectConfigs.projectEnvironmentId,
        directory: projectEnvironments.directory,
      })
      .from(externalServiceProjectConfigs)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceProjectConfigs.projectEnvironmentId))
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(
        and(
          eq(externalServiceProjectConfigs.externalServiceId, copy.id),
          inArray(externalServiceProjectConfigs.projectEnvironmentId, [...to]),
          ...laneReceivers(copy)
        )
      );
    return new Map(rows.map((row) => [row.projectEnvironmentId, row.directory]));
  }
}
