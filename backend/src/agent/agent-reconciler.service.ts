import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { agents } from '../../db/schema';
import { type AgentRegistry, type AgentRegistryEntry, readMergedAgentRegistry } from './agent-config';

@Injectable()
export class AgentReconcilerService implements OnModuleInit {
  private readonly logger = new Logger(AgentReconcilerService.name);
  private reconciled: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    await this.ready();
  }

  ready(): Promise<void> {
    this.reconciled ??= this.reconcile(readMergedAgentRegistry());
    return this.reconciled;
  }

  async reconcile(registry: AgentRegistry): Promise<void> {
    const entries = Object.entries(registry.agents);
    for (const [slug, entry] of entries) {
      const stamped = stampedFields(entry);
      await db
        .insert(agents)
        .values({ id: crypto.randomUUID(), name: slug, ...stamped })
        .onConflictDoUpdate({
          target: agents.name,
          targetWhere: isNull(agents.tenantId),
          set: {
            ...stamped,
            displayName: sql`coalesce(${stamped.displayName}, ${agents.displayName})`,
            description: sql`coalesce(${stamped.description}, ${agents.description})`,
            updatedAt: new Date(),
          },
        });
    }
    this.logger.log(`Reconciled ${entries.length} agent(s) from registry`);
  }
}

function stampedFields(entry: AgentRegistryEntry) {
  return {
    displayName: entry.name ?? null,
    description: entry.description ?? null,
    origin: 'built_in',
    version: entry.version ?? null,
    model: entry.model ?? null,
    variant: entry.variant ?? null,
    poolSize: typeof entry.poolSize === 'number' && entry.poolSize > 0 ? entry.poolSize : 0,
  };
}
