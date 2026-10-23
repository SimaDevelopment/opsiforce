import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { agentSettings, agents } from '../../db/schema';
import { isPreset, podSettingsForSelection, POD_CLASS_DEFAULT, type PodClass } from '../pod/pod-classes';
import { type AgentRegistry, type AgentRegistryEntry, readMergedAgentRegistry } from './agent-config';
import { writeAgentPodSettings } from './agent-pod-settings';

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
      const [agent] = await db
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
        })
        .returning({ id: agents.id });
      const warmPoolSize = registryPoolSize(entry);
      await db
        .insert(agentSettings)
        .values({ agentId: agent.id, warmPoolSize })
        .onConflictDoUpdate({ target: agentSettings.agentId, set: { warmPoolSize, updatedAt: new Date() } });
      await writeAgentPodSettings(
        db,
        agent.id,
        podSettingsForSelection({ podClass: this.registryPodClass(slug, entry) })
      );
    }
    this.logger.log(`Reconciled ${entries.length} agent(s) from registry`);
  }

  private registryPodClass(slug: string, entry: AgentRegistryEntry): PodClass {
    if (entry.podClass === undefined) return POD_CLASS_DEFAULT;
    if (isPreset(entry.podClass as PodClass)) return entry.podClass as PodClass;
    this.logger.warn(`Agent ${slug} has an unknown podClass "${entry.podClass}"; using ${POD_CLASS_DEFAULT}`);
    return POD_CLASS_DEFAULT;
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
  };
}

function registryPoolSize(entry: AgentRegistryEntry): number {
  return typeof entry.poolSize === 'number' && entry.poolSize > 0 ? entry.poolSize : 0;
}
