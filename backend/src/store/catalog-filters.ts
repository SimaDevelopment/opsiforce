import { and, eq, ilike, isNotNull, or, type Column, type SQL } from 'drizzle-orm';

export type CatalogListFilter = 'all' | 'built_in' | 'custom' | 'private' | 'archived';

export const CATALOG_LIST_FILTERS: CatalogListFilter[] = ['all', 'built_in', 'custom', 'private', 'archived'];

export interface CatalogColumns {
  tenantId: Column;
  name: Column;
  displayName: Column;
  description: Column;
  origin: Column;
  visibility: Column;
  archived: Column;
}

export function catalogFilterWhere(columns: CatalogColumns, filter: CatalogListFilter): SQL | undefined {
  switch (filter) {
    case 'built_in':
      return and(eq(columns.origin, 'built_in'), eq(columns.archived, false));
    case 'custom':
      return and(eq(columns.origin, 'custom'), eq(columns.archived, false));
    case 'private':
      return and(eq(columns.visibility, 'private'), isNotNull(columns.tenantId), eq(columns.archived, false));
    case 'archived':
      return eq(columns.archived, true);
    default:
      return eq(columns.archived, false);
  }
}

export function catalogSearchWhere(columns: CatalogColumns, query: string | undefined): SQL | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  const pattern = `%${trimmed.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  return or(ilike(columns.name, pattern), ilike(columns.displayName, pattern), ilike(columns.description, pattern));
}
