import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EXTERNAL_SERVICE_BUILDER_AGENT_SLUG } from '../../agent/agent-visibility';
import { AgentService } from '../../agent/agent.service';
import { ProjectService } from '../../project/project.service';
import { EXTERNAL_SERVICE_CHAT_KIND } from '../../project/project.types';
import { ServiceConsumers, type ServiceConsumer } from '../configuration/service-consumers';
import { ServiceSkillReach } from '../knowledge/service-skill-reach';
import { RESERVED_SERVICE_SLUGS, SERVICE_SLUG_PATTERN } from '../registry/built-in-services';
import { CustomServiceRefusal } from './custom-service-refusal';
import { ServiceAppSeeder, type ServiceAppSeed } from './service-app-seeder';
import { CustomServiceRepository, isCustomSlugTaken } from './custom-service.repository';
import { customServiceSummaryOf, type CustomServiceSummary } from './custom-service-summary';

export const SERVICE_NAME_MAX_LENGTH = 80;

export interface CustomServiceCreator {
  tenantId: string;
  userId: string;
}

export interface NewCustomServiceRequest {
  name?: unknown;
  slug?: unknown;
}

function requireName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0 || trimmed.length > SERVICE_NAME_MAX_LENGTH) {
    throw new CustomServiceRefusal(
      400,
      'invalid-name',
      `A service needs a name of 1 to ${SERVICE_NAME_MAX_LENGTH} characters`
    );
  }
  return trimmed;
}

function requireSlugShape(slug: unknown): string {
  if (typeof slug !== 'string' || !SERVICE_SLUG_PATTERN.test(slug)) {
    throw new CustomServiceRefusal(
      400,
      'invalid-slug',
      'A slug is 2 to 31 lowercase letters, digits and hyphens, starting with a letter'
    );
  }
  if (RESERVED_SERVICE_SLUGS.includes(slug)) {
    throw new CustomServiceRefusal(400, 'invalid-slug', `\`${slug}\` is reserved by the platform`);
  }
  return slug;
}

@Injectable()
export class CustomServices {
  constructor(
    private readonly repository: CustomServiceRepository,
    private readonly projects: ProjectService,
    private readonly agents: AgentService,
    private readonly consumers: ServiceConsumers,
    private readonly serviceSkillReach: ServiceSkillReach,
    private readonly seeder: ServiceAppSeeder
  ) {}

  async create(
    creator: CustomServiceCreator,
    request: NewCustomServiceRequest,
    seed: ServiceAppSeed | null = null
  ): Promise<CustomServiceSummary> {
    const name = requireName(request.name);
    const slug = await this.requireFreeSlug(creator.tenantId, request.slug);

    const agentId = await this.agents.findBuilderAgentId(EXTERNAL_SERVICE_BUILDER_AGENT_SLUG);
    if (!agentId) {
      throw new ServiceUnavailableException('The External Service Builder is not installed on this deployment');
    }

    const chat = await this.projects.create({ title: name, agentId }, creator.tenantId, {
      createdBy: creator.userId,
      kind: EXTERNAL_SERVICE_CHAT_KIND,
      configureBeforeDelivery: seed ? (chatId) => this.seeder.seed(chatId, seed) : null,
    });
    const id = crypto.randomUUID();
    try {
      await this.repository.insert({
        id,
        tenantId: creator.tenantId,
        slug,
        builderChatId: chat.id,
        createdBy: creator.userId,
      });
    } catch (error) {
      await this.projects.discardHalfCreatedProject(chat.id);
      if (isCustomSlugTaken(error)) throw slugTaken(slug, 'custom');
      throw error;
    }
    return customServiceSummaryOf(await this.requireService(creator.tenantId, id));
  }

  async renameSlug(tenantId: string, id: string, requestedSlug: unknown): Promise<CustomServiceSummary> {
    const service = await this.requireService(tenantId, id);
    if (service.defaultEnvironmentId !== null) throw slugLocked(service.slug);
    if (requestedSlug === service.slug) return customServiceSummaryOf(service);

    const slug = await this.requireFreeSlug(tenantId, requestedSlug);
    try {
      if (!(await this.repository.renameSlugWhileUnpublished(tenantId, id, slug))) throw slugLocked(service.slug);
    } catch (error) {
      if (isCustomSlugTaken(error)) throw slugTaken(slug, 'custom');
      throw error;
    }
    return customServiceSummaryOf(await this.requireService(tenantId, id));
  }

  async disable(tenantId: string, id: string): Promise<CustomServiceSummary> {
    const service = await this.requireService(tenantId, id);
    if (!service.disabled) await this.projects.disable(service.builderChatId, tenantId);
    return customServiceSummaryOf(await this.requireService(tenantId, id));
  }

  async enable(tenantId: string, id: string): Promise<CustomServiceSummary> {
    const service = await this.requireService(tenantId, id);
    if (service.disabled) await this.projects.enable(service.builderChatId, tenantId);
    return customServiceSummaryOf(await this.requireService(tenantId, id));
  }

  async consumersOf(tenantId: string, id: string): Promise<ServiceConsumer[]> {
    await this.requireService(tenantId, id);
    return this.consumers.of(id);
  }

  async delete(tenantId: string, id: string, confirmSlug: unknown): Promise<void> {
    const service = await this.requireService(tenantId, id);
    if (confirmSlug !== service.slug) {
      throw new CustomServiceRefusal(400, 'slug-mismatch', `Type \`${service.slug}\` to delete this service`);
    }
    await this.consumers.sayGoodbye(id);
    await this.serviceSkillReach.reachEnvironmentsAfter(service, () =>
      this.projects.remove(service.builderChatId, tenantId)
    );
  }

  private async requireFreeSlug(tenantId: string, requested: unknown): Promise<string> {
    const slug = requireSlugShape(requested);
    const holder = await this.repository.slugInUse(tenantId, slug);
    if (holder) throw slugTaken(slug, holder);
    return slug;
  }

  private async requireService(tenantId: string, id: string) {
    const service = await this.repository.findInTenant(tenantId, id);
    if (!service) throw new NotFoundException(`External Service ${id} not found`);
    return service;
  }
}

function slugTaken(slug: string, holder: 'built_in' | 'custom'): CustomServiceRefusal {
  return new CustomServiceRefusal(
    409,
    'slug-taken',
    holder === 'built_in'
      ? `\`${slug}\` is the name of a Built-in External Service`
      : `Your Organization already has an External Service called \`${slug}\``
  );
}

function slugLocked(slug: string): CustomServiceRefusal {
  return new CustomServiceRefusal(
    409,
    'slug-locked',
    `\`${slug}\` has been published, so its slug can no longer change`
  );
}
