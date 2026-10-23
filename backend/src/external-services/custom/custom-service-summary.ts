import type { RegisteredService } from '../registry/service-registry';
import type { CustomServiceRow } from './custom-service.repository';

export interface CustomServiceSummary {
  id: string;
  slug: string;
  origin: 'custom';
  displayName: string;
  description: string;
  icon: string | null;
  builderChatId: string;
  published: boolean;
  publishedEnvironmentIds: string[];
  defaultEnvironmentId: string | null;
  disabled: boolean;
  hidesBuiltIn: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface CustomServiceSummaryContext {
  published?: RegisteredService;
  publishedEnvironmentIds?: string[];
  hidesBuiltIn?: boolean;
}

export function customServiceSummaryOf(
  row: CustomServiceRow,
  context: CustomServiceSummaryContext = {}
): CustomServiceSummary {
  return {
    id: row.id,
    slug: row.slug,
    origin: 'custom',
    displayName: context.published?.manifest.displayName ?? row.name,
    description: context.published?.manifest.description ?? '',
    icon: context.published?.icon ?? null,
    builderChatId: row.builderChatId,
    published: row.defaultEnvironmentId !== null,
    publishedEnvironmentIds:
      context.publishedEnvironmentIds ?? (row.defaultEnvironmentId ? [row.defaultEnvironmentId] : []),
    defaultEnvironmentId: row.defaultEnvironmentId,
    disabled: row.disabled,
    hidesBuiltIn: context.hidesBuiltIn ?? false,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
