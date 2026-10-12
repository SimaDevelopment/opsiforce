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
  disabled: boolean;
  hidesBuiltIn: boolean;
}

export interface CustomServiceSummaryContext {
  published?: RegisteredService;
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
    disabled: row.disabled,
    hidesBuiltIn: context.hidesBuiltIn ?? false,
  };
}
