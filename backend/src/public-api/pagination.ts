import { and, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

const CURSOR_SEPARATOR = '|';
const CURSOR_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.US';
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

export interface PageCursor {
  cursorAt: string;
  id: string;
}

export function cursorValue(column: PgColumn) {
  return sql<string>`to_char(${column}, ${CURSOR_TIMESTAMP_FORMAT})`.as('cursor_at');
}

function encodeCursor({ cursorAt, id }: PageCursor): string {
  return Buffer.from(`${cursorAt}${CURSOR_SEPARATOR}${id}`).toString('base64url');
}

function isMintedCursorTimestamp(value: string): boolean {
  if (!CURSOR_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 19) === `${value.slice(0, 10)}T${value.slice(11, 19)}`;
}

function decodeCursor(value: string): PageCursor | null {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  if (separator <= 0 || separator === decoded.length - 1) return null;
  const cursorAt = decoded.slice(0, separator);
  if (!isMintedCursorTimestamp(cursorAt)) return null;
  return { cursorAt, id: decoded.slice(separator + 1) };
}

const CursorSchema = z
  .string()
  .describe('Opaque cursor from the nextCursor of a previous page')
  .transform((value, ctx) => {
    const cursor = decodeCursor(value);
    if (!cursor) {
      ctx.addIssue({ code: 'custom', message: 'Not a cursor returned by this API' });
      return z.NEVER;
    }
    return cursor;
  });

export const CursorPageQueryShape = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(`Page size, at most ${MAX_PAGE_LIMIT}`),
  cursor: CursorSchema.optional(),
};

export const CursorPageQuerySchema = z.strictObject(CursorPageQueryShape);

export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;

export function pageSchema<TItem extends z.ZodType>(
  item: TItem,
  id: string
): z.ZodObject<{ items: z.ZodArray<TItem>; nextCursor: z.ZodNullable<z.ZodString> }, z.core.$strict> {
  return z
    .strictObject({
      items: z.array(item),
      nextCursor: z.string().nullable().describe('Pass as ?cursor to fetch the next page; null on the last page'),
    })
    .meta({ id });
}

export function beforeCursor(column: PgColumn, idColumn: PgColumn, cursor: PageCursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const at = sql`to_timestamp(${cursor.cursorAt}, ${CURSOR_TIMESTAMP_FORMAT})::timestamp`;
  return or(lt(column, at), and(eq(column, at), lt(idColumn, cursor.id)));
}

export interface TakenPage<TRow> {
  rows: TRow[];
  nextCursor: string | null;
}

export function takePage<TRow extends PageCursor>(rows: TRow[], limit: number): TakenPage<TRow> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
