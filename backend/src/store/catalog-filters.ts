import { and, eq, ilike, isNotNull, not, or, type Column, type SQL } from 'drizzle-orm';

export type CatalogListFilter = 'all' | 'mine' | 'built_in' | 'custom' | 'private' | 'disabled';

export const CATALOG_LIST_FILTERS: CatalogListFilter[] = ['all', 'mine', 'built_in', 'custom', 'private', 'disabled'];

export interface CatalogColumns {
  tenantId: Column;
  name: Column;
  displayName: Column;
  description: Column;
  origin: Column;
  visibility: Column;
  createdBy: Column;
}

export interface CatalogScope {
  userId: string;
  disabled: SQL<boolean>;
}

export function catalogFilterWhere(columns: CatalogColumns, filter: CatalogListFilter, scope: CatalogScope): SQL | undefined {
  const enabled = not(scope.disabled);
  switch (filter) {
    case 'mine':
      return and(eq(columns.createdBy, scope.userId), enabled);
    case 'built_in':
      return and(eq(columns.origin, 'built_in'), enabled);
    case 'custom':
      return and(eq(columns.origin, 'custom'), enabled);
    case 'private':
      return and(eq(columns.visibility, 'private'), isNotNull(columns.tenantId), enabled);
    case 'disabled':
      return scope.disabled;
    default:
      return enabled;
  }
}

export function catalogSearchWhere(columns: CatalogColumns, query: string | undefined): SQL | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  const pattern = `%${trimmed.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  return or(ilike(columns.name, pattern), ilike(columns.displayName, pattern), ilike(columns.description, pattern));
}
