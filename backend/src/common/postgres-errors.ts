export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_UNIQUE_VIOLATION = '23505';

interface PostgresErrorFields {
  code?: string;
  constraint_name?: string;
}

export function postgresError(error: unknown): PostgresErrorFields {
  const direct = error as (PostgresErrorFields & { cause?: unknown }) | null | undefined;
  if (direct?.code) return direct;
  return (direct?.cause as PostgresErrorFields | undefined) ?? {};
}

export function isPostgresError(error: unknown, code: string, constraint?: string): boolean {
  const pg = postgresError(error);
  return pg.code === code && (constraint === undefined || pg.constraint_name === constraint);
}
