import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db';
import {
  environments,
  externalServiceCalls,
  externalServices,
  projectEnvironments,
  tenants,
  type JsonValue,
} from '../../../db/schema';
import {
  afterCursor,
  beforeCursor,
  cursorValue,
  decodeCursor,
  encodeCursor,
  type PageCursor,
} from '../../public-api/pagination';
import { CALL_OUTCOMES, FAILED_STATUS_FROM, outcomeOf, type CallOutcome } from '../gate/call-outcome';

export const CALL_PAGE_SIZE = 25;

const MAX_SEARCH_LENGTH = 200;

export interface CallScope {
  serviceId?: string;
  tenantId?: string;
  projectEnvironmentId?: string;
}

export interface CallPageQuery {
  older?: PageCursor;
  newer?: PageCursor;
  search?: string;
  outcome?: CallOutcome;
}

export interface CallView {
  callId: string;
  createdAt: string;
  kind: string;
  via: string | null;
  operation: string | null;
  operationKind: string | null;
  outcome: CallOutcome;
  status: number;
  code: string | null;
  detail: string | null;
  bounds: JsonValue | null;
  inputBytes: number | null;
  outputBytes: number | null;
  durationMs: number;
  manifestHash: string | null;
  serviceId: string | null;
  slug: string;
  tenantId: string | null;
  tenantName: string | null;
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  environmentName: string | null;
  servedBy: string | null;
  userId: string | null;
}

export interface CallPage {
  calls: CallView[];
  retentionDays: number;
  newer: string | null;
  older: string | null;
}

export interface ServiceOwnership {
  id: string;
  tenantId: string | null;
}

function single(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`"${name}" must be given once`);
  return value;
}

function cursorParameter(value: unknown, name: string): PageCursor | undefined {
  const raw = single(value, name);
  if (raw === undefined || raw === '') return undefined;
  const cursor = decodeCursor(raw);
  if (!cursor) throw new BadRequestException(`"${name}" is not a cursor this list returned`);
  return cursor;
}

export function parseCallPageQuery(query: Record<string, unknown> | undefined): CallPageQuery {
  const older = cursorParameter(query?.older, 'older');
  const newer = cursorParameter(query?.newer, 'newer');
  if (older && newer) throw new BadRequestException('Ask for "older" or "newer", not both');

  const search = single(query?.q, 'q')?.trim();
  if (search && search.length > MAX_SEARCH_LENGTH) {
    throw new BadRequestException(`"q" is longer than ${MAX_SEARCH_LENGTH} characters`);
  }

  const outcome = single(query?.outcome, 'outcome');
  if (outcome !== undefined && outcome !== '' && !CALL_OUTCOMES.includes(outcome as CallOutcome)) {
    throw new BadRequestException(`"outcome" must be one of ${CALL_OUTCOMES.join(', ')}`);
  }

  return {
    older,
    newer,
    search: search || undefined,
    outcome: outcome ? (outcome as CallOutcome) : undefined,
  };
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function scopeConditions(scope: CallScope): SQL[] {
  return [
    scope.serviceId === undefined ? undefined : eq(externalServiceCalls.externalServiceId, scope.serviceId),
    scope.tenantId === undefined ? undefined : eq(externalServiceCalls.tenantId, scope.tenantId),
    scope.projectEnvironmentId === undefined
      ? undefined
      : eq(externalServiceCalls.projectEnvironmentId, scope.projectEnvironmentId),
  ].filter((condition): condition is SQL => condition !== undefined);
}

function searchCondition(search: string | undefined): SQL | undefined {
  if (!search) return undefined;
  const pattern = likePattern(search);
  return or(
    sql`${externalServiceCalls.operation} ilike ${pattern}`,
    sql`exists (
      select 1 from jsonb_array_elements(coalesce(${externalServiceCalls.bounds}, '[]'::jsonb)) as touched(bound)
      where touched.bound->>'value' ilike ${pattern} or touched.bound->>'label' ilike ${pattern}
    )`
  );
}

function outcomeCondition(outcome: CallOutcome | undefined): SQL | undefined {
  if (outcome === 'refused') return eq(externalServiceCalls.decision, 'refused');
  if (outcome === 'failed') {
    return and(eq(externalServiceCalls.decision, 'allowed'), gte(externalServiceCalls.status, FAILED_STATUS_FROM));
  }
  if (outcome === 'allowed') {
    return and(eq(externalServiceCalls.decision, 'allowed'), lt(externalServiceCalls.status, FAILED_STATUS_FROM));
  }
  return undefined;
}

const servingEnvironments = alias(environments, 'serving_environments');

const KEY_COLUMNS = [externalServiceCalls.createdAt, externalServiceCalls.id] as const;

const callColumns = {
  id: externalServiceCalls.id,
  createdAt: externalServiceCalls.createdAt,
  cursorAt: cursorValue(externalServiceCalls.createdAt),
  kind: externalServiceCalls.kind,
  via: externalServiceCalls.via,
  operation: externalServiceCalls.operation,
  operationKind: externalServiceCalls.operationKind,
  decision: externalServiceCalls.decision,
  status: externalServiceCalls.status,
  code: externalServiceCalls.code,
  detail: externalServiceCalls.detail,
  bounds: externalServiceCalls.bounds,
  inputBytes: externalServiceCalls.inputBytes,
  outputBytes: externalServiceCalls.outputBytes,
  durationMs: externalServiceCalls.durationMs,
  manifestHash: externalServiceCalls.manifestHash,
  serviceId: externalServiceCalls.externalServiceId,
  slug: externalServiceCalls.slug,
  tenantId: externalServiceCalls.tenantId,
  tenantName: tenants.displayName,
  projectId: externalServiceCalls.projectId,
  projectTitle: externalServiceCalls.projectTitle,
  projectEnvironmentId: externalServiceCalls.projectEnvironmentId,
  environmentName: environments.name,
  servedBy: servingEnvironments.name,
  userId: externalServiceCalls.userId,
};

type CallRow = Awaited<ReturnType<CallLogReader['rows']>>[number];

function viewOf({ cursorAt: _cursorAt, id, createdAt, ...row }: CallRow): CallView {
  return { callId: id, createdAt: createdAt.toISOString(), outcome: outcomeOf(row), ...row };
}

function keyOf(row: CallRow): PageCursor {
  return { cursorAt: row.cursorAt, id: row.id };
}

@Injectable()
export class CallLogReader {
  private readonly retentionDays: number;

  constructor(configService: ConfigService) {
    this.retentionDays = configService.getOrThrow<number>('externalServiceCallLogRetentionDays');
  }

  async serviceOwnership(serviceId: string): Promise<ServiceOwnership> {
    const [service] = await db
      .select({ id: externalServices.id, tenantId: externalServices.tenantId })
      .from(externalServices)
      .where(eq(externalServices.id, serviceId));
    if (!service) throw new NotFoundException(`No External Service ${serviceId}`);
    return service;
  }

  async page(scope: CallScope, query: CallPageQuery): Promise<CallPage> {
    const filters = [...scopeConditions(scope), searchCondition(query.search), outcomeCondition(query.outcome)];
    const goingNewer = query.newer !== undefined;
    const from = query.newer ?? query.older;

    const fetched = goingNewer
      ? await this.rows(filters, from && afterCursor(...KEY_COLUMNS, from), 'oldest-first')
      : await this.rows(filters, from && beforeCursor(...KEY_COLUMNS, from), 'newest-first');
    const rows = goingNewer ? fetched.slice(0, CALL_PAGE_SIZE).toReversed() : fetched.slice(0, CALL_PAGE_SIZE);
    const morePast = fetched.length > CALL_PAGE_SIZE;

    const newest = rows[0] ? keyOf(rows[0]) : from;
    const oldest = rows.at(-1) ? keyOf(rows.at(-1) as CallRow) : from;
    const hasNewer = goingNewer
      ? morePast
      : from !== undefined && newest !== undefined && (await this.exists(filters, afterCursor(...KEY_COLUMNS, newest)));
    const hasOlder = goingNewer
      ? oldest !== undefined && (await this.exists(filters, beforeCursor(...KEY_COLUMNS, oldest)))
      : morePast;

    return {
      calls: rows.map(viewOf),
      retentionDays: this.retentionDays,
      newer: hasNewer && newest ? encodeCursor(newest) : null,
      older: hasOlder && oldest ? encodeCursor(oldest) : null,
    };
  }

  private rows(filters: (SQL | undefined)[], cursor: SQL | undefined, order: 'newest-first' | 'oldest-first') {
    const direction = order === 'newest-first' ? desc : asc;
    return db
      .select(callColumns)
      .from(externalServiceCalls)
      .leftJoin(tenants, eq(tenants.id, externalServiceCalls.tenantId))
      .leftJoin(projectEnvironments, eq(projectEnvironments.id, externalServiceCalls.projectEnvironmentId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId))
      .leftJoin(servingEnvironments, eq(servingEnvironments.id, externalServiceCalls.serviceEnvironmentId))
      .where(and(...filters, cursor))
      .orderBy(direction(externalServiceCalls.createdAt), direction(externalServiceCalls.id))
      .limit(CALL_PAGE_SIZE + 1);
  }

  private async exists(filters: (SQL | undefined)[], cursor: SQL | undefined): Promise<boolean> {
    const [row] = await db
      .select({ id: externalServiceCalls.id })
      .from(externalServiceCalls)
      .where(and(...filters, cursor))
      .limit(1);
    return row !== undefined;
  }
}
