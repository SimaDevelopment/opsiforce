import { BadRequestException, Injectable } from '@nestjs/common';
import { callLogRetentionDays, type CallLogOutcome } from '@opsiforce/external-service-sdk/server';
import { and, asc, desc, eq, gt, gte, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from 'sqlite';
import { db } from '../../../db';
import { externalServiceCalls } from '../../../db/schema';
import { isAdaptedBuiltIn, type AdaptedBuiltIn } from '../built-ins/built-ins-adapter';
import { ServiceRegistry } from '../registry/service-registry';
import { knownEnvironments, projectTitles } from './record-owners';
import { ServiceRecordsHomes, type ServiceCopy } from './service-records-file';

export const CALL_LOG_PAGE_SIZE = 25;

export type CallLogCallerKind = 'call' | 'platform';

export const CALL_LOG_OUTCOME_FILTERS = ['allowed', 'not supported', 'not allowed', 'failed'] as const;

export type CallLogOutcomeFilter = (typeof CALL_LOG_OUTCOME_FILTERS)[number];

const ALLOWED_OUTCOMES: CallLogOutcome[] = ['proxied', 'handled'];

export const CALL_LOG_TIME_RANGES = { '1h': 1, '24h': 24, '7d': 7 * 24, '30d': 30 * 24 } as const;

export type CallLogTimeRange = keyof typeof CALL_LOG_TIME_RANGES;

const HOUR_MS = 60 * 60 * 1000;

interface CallLogCursor {
  time: string;
  id: number | string;
}

export interface CallLogQuery {
  older?: CallLogCursor;
  newer?: CallLogCursor;
  outcome?: CallLogOutcomeFilter;
  projectId?: string;
  since?: CallLogTimeRange;
}

export interface CallLogEntry {
  requestId: string;
  time: string;
  callerKind: CallLogCallerKind;
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  environment: string | null;
  environmentName: string | null;
  method: string;
  path: string;
  route: string | null;
  outcome: CallLogOutcome;
  reason: string | null;
  status: number;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  notes: Record<string, unknown>;
}

export interface CallLogProject {
  projectId: string;
  title: string | null;
}

export interface CallLogPage {
  calls: CallLogEntry[];
  projects: CallLogProject[];
  retentionDays: number;
  newer: string | null;
  older: string | null;
}

export type CallLogScope =
  | { tenantId: string; serviceId: string; copy: ServiceCopy }
  | { tenantId: string; serviceId: string; projectEnvironmentId: string };

interface StoredCall {
  id: number | string;
  request_id: string;
  time: string;
  caller_kind: CallLogCallerKind;
  project_id: string | null;
  project_environment_id: string | null;
  environment: string | null;
  method: string;
  path: string;
  route: string | null;
  outcome: CallLogOutcome;
  reason: string | null;
  status: number;
  bytes_in: number;
  bytes_out: number;
  duration_ms: number;
  notes: string;
}

interface StoredPage {
  rows: StoredCall[];
  hasNewer: boolean;
  hasOlder: boolean;
  projectIds: string[];
}

const CURSOR_SEPARATOR = '|';
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TABLE_ROW_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function encodeCursor({ time, id }: CallLogCursor): string {
  return Buffer.from(`${time}${CURSOR_SEPARATOR}${id}`).toString('base64url');
}

function decodeCursor(value: string): CallLogCursor | null {
  const [time, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split(CURSOR_SEPARATOR);
  if (rest.length > 0 || !time || !CURSOR_TIME_PATTERN.test(time) || !id) return null;
  if (/^\d{1,15}$/.test(id)) return { time, id: Number(id) };
  return TABLE_ROW_ID_PATTERN.test(id) ? { time, id } : null;
}

function single(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`"${name}" must be given once`);
  return value;
}

function oneOf<Choice extends string>(value: unknown, name: string, choices: readonly Choice[]): Choice | undefined {
  const given = single(value, name);
  if (given === undefined) return undefined;
  if (!choices.includes(given as Choice))
    throw new BadRequestException(`"${name}" must be one of ${choices.join(', ')}`);
  return given as Choice;
}

function cursorParameter(value: unknown, name: string): CallLogCursor | undefined {
  const raw = single(value, name);
  if (raw === undefined) return undefined;
  const cursor = decodeCursor(raw);
  if (!cursor) throw new BadRequestException(`"${name}" is not a cursor this list returned`);
  return cursor;
}

export function parseCallLogQuery(query: Record<string, unknown> | undefined): CallLogQuery {
  const older = cursorParameter(query?.older, 'older');
  const newer = cursorParameter(query?.newer, 'newer');
  if (older && newer) throw new BadRequestException('Ask for "older" or "newer", not both');
  const projectId = single(query?.project, 'project');
  const outcome = oneOf(query?.outcome, 'outcome', CALL_LOG_OUTCOME_FILTERS);
  const since = oneOf(query?.since, 'since', Object.keys(CALL_LOG_TIME_RANGES) as CallLogTimeRange[]);
  return {
    ...(older ? { older } : {}),
    ...(newer ? { newer } : {}),
    ...(outcome ? { outcome } : {}),
    ...(projectId ? { projectId } : {}),
    ...(since ? { since } : {}),
  };
}

function outcomesOf(filter: CallLogOutcomeFilter): [CallLogOutcome, CallLogOutcome] {
  return filter === 'allowed' ? ['proxied', 'handled'] : [filter, filter];
}

interface Filter {
  sql: string;
  values: (string | number)[];
}

function filtersOf(query: CallLogQuery, projectEnvironmentId: string | undefined, now: number): Filter[] {
  const retained = new Date(now - callLogRetentionDays * 24 * HOUR_MS).toISOString();
  const since = query.since ? new Date(now - CALL_LOG_TIME_RANGES[query.since] * HOUR_MS).toISOString() : retained;
  return [
    { sql: 'time >= ?', values: [since > retained ? since : retained] },
    ...(projectEnvironmentId ? [{ sql: 'project_environment_id = ?', values: [projectEnvironmentId] }] : []),
    ...(query.projectId ? [{ sql: 'project_id = ?', values: [query.projectId] }] : []),
    ...(query.outcome ? [{ sql: 'outcome IN (?, ?)', values: [...outcomesOf(query.outcome)] }] : []),
    { sql: "(caller_kind <> 'platform' OR outcome NOT IN (?, ?))", values: ALLOWED_OUTCOMES },
  ];
}

const OLDER_THAN = '(time < ? OR (time = ? AND id < ?))';
const NEWER_THAN = '(time > ? OR (time = ? AND id > ?))';

function cursorFilter(clause: string, cursor: CallLogCursor): Filter {
  return { sql: clause, values: [cursor.time, cursor.time, cursor.id] };
}

function where(filters: Filter[]): { clause: string; values: (string | number)[] } {
  return {
    clause: filters.length === 0 ? '' : `WHERE ${filters.map((filter) => filter.sql).join(' AND ')}`,
    values: filters.flatMap((filter) => filter.values),
  };
}

async function selectRows(
  database: Database,
  filters: Filter[],
  order: 'DESC' | 'ASC',
  limit: number
): Promise<StoredCall[]> {
  const { clause, values } = where(filters);
  return database.all<StoredCall[]>(
    `SELECT * FROM calls ${clause} ORDER BY time ${order}, id ${order} LIMIT ?`,
    ...values,
    limit
  );
}

async function anyRow(database: Database, filters: Filter[]): Promise<boolean> {
  const { clause, values } = where(filters);
  return (await database.get(`SELECT 1 AS found FROM calls ${clause} LIMIT 1`, ...values)) !== undefined;
}

async function storedPage(
  database: Database,
  query: CallLogQuery,
  projectEnvironmentId: string | undefined,
  now: number
): Promise<StoredPage> {
  const filters = filtersOf(query, projectEnvironmentId, now);
  const goingNewer = query.newer !== undefined;
  const from = query.newer ?? query.older;
  const fromCursor = from ? [cursorFilter(goingNewer ? NEWER_THAN : OLDER_THAN, from)] : [];
  const fetched = await selectRows(
    database,
    [...filters, ...fromCursor],
    goingNewer ? 'ASC' : 'DESC',
    CALL_LOG_PAGE_SIZE + 1
  );
  const more = fetched.length > CALL_LOG_PAGE_SIZE;
  const rows = goingNewer ? fetched.slice(0, CALL_LOG_PAGE_SIZE).toReversed() : fetched.slice(0, CALL_LOG_PAGE_SIZE);
  const newest = rows[0];
  const oldest = rows.at(-1);
  const hasNewer = goingNewer
    ? more
    : from !== undefined &&
      newest !== undefined &&
      (await anyRow(database, [...filters, cursorFilter(NEWER_THAN, newest)]));
  const hasOlder = goingNewer
    ? oldest !== undefined && (await anyRow(database, [...filters, cursorFilter(OLDER_THAN, oldest)]))
    : more;
  const projectFilters = filtersOf({}, projectEnvironmentId, now);
  const { clause, values } = where([...projectFilters, { sql: 'project_id IS NOT NULL', values: [] }]);
  const projectRows = await database.all<{ project_id: string }[]>(
    `SELECT DISTINCT project_id FROM calls ${clause}`,
    ...values
  );
  return { rows, hasNewer, hasOlder, projectIds: projectRows.map((row) => row.project_id) };
}

const EMPTY_PAGE: StoredPage = { rows: [], hasNewer: false, hasOlder: false, projectIds: [] };

function tableFilters(
  service: AdaptedBuiltIn,
  tenantId: string,
  query: CallLogQuery,
  projectEnvironmentId: string | undefined,
  now: number
): SQL[] {
  const retained = now - callLogRetentionDays * 24 * HOUR_MS;
  const since = query.since ? now - CALL_LOG_TIME_RANGES[query.since] * HOUR_MS : retained;
  return [
    eq(externalServiceCalls.externalServiceId, service.id),
    eq(externalServiceCalls.tenantId, tenantId),
    gte(externalServiceCalls.createdAt, new Date(Math.max(since, retained))),
    ...(projectEnvironmentId ? [eq(externalServiceCalls.projectEnvironmentId, projectEnvironmentId)] : []),
    ...(query.projectId ? [eq(externalServiceCalls.projectId, query.projectId)] : []),
    ...(query.outcome ? [sql`${externalServiceCalls.outcome} in ${outcomesOf(query.outcome)}`] : []),
    sql`(${externalServiceCalls.callerKind} <> 'platform' or ${externalServiceCalls.outcome} not in ${ALLOWED_OUTCOMES})`,
  ];
}

function tableCursor(direction: 'older' | 'newer', cursor: CallLogCursor): SQL {
  const time = new Date(cursor.time);
  const id = String(cursor.id);
  const before = direction === 'older' ? lt : gt;
  return or(
    before(externalServiceCalls.createdAt, time),
    and(eq(externalServiceCalls.createdAt, time), before(externalServiceCalls.id, id))
  ) as SQL;
}

async function tableRows(filters: SQL[], order: 'DESC' | 'ASC', limit: number): Promise<StoredCall[]> {
  const direction = order === 'DESC' ? desc : asc;
  const rows = await db
    .select()
    .from(externalServiceCalls)
    .where(and(...filters))
    .orderBy(direction(externalServiceCalls.createdAt), direction(externalServiceCalls.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    request_id: row.requestId,
    time: row.createdAt.toISOString(),
    caller_kind: row.callerKind,
    project_id: row.projectId,
    project_environment_id: row.projectEnvironmentId,
    environment: row.environment,
    method: row.method,
    path: row.path,
    route: row.route,
    outcome: row.outcome,
    reason: row.reason,
    status: row.status,
    bytes_in: row.inputBytes ?? 0,
    bytes_out: row.outputBytes ?? 0,
    duration_ms: row.durationMs,
    notes: JSON.stringify(row.notes ?? {}),
  }));
}

async function builtInPage(
  service: AdaptedBuiltIn,
  tenantId: string,
  query: CallLogQuery,
  projectEnvironmentId: string | undefined,
  now: number
): Promise<StoredPage> {
  const filters = tableFilters(service, tenantId, query, projectEnvironmentId, now);
  const goingNewer = query.newer !== undefined;
  const from = query.newer ?? query.older;
  const fromCursor = from ? [tableCursor(goingNewer ? 'newer' : 'older', from)] : [];
  const fetched = await tableRows([...filters, ...fromCursor], goingNewer ? 'ASC' : 'DESC', CALL_LOG_PAGE_SIZE + 1);
  const more = fetched.length > CALL_LOG_PAGE_SIZE;
  const rows = goingNewer ? fetched.slice(0, CALL_LOG_PAGE_SIZE).toReversed() : fetched.slice(0, CALL_LOG_PAGE_SIZE);
  const newest = rows[0];
  const oldest = rows.at(-1);
  const anyBeyond = async (direction: 'older' | 'newer', row: StoredCall) =>
    (await tableRows([...filters, tableCursor(direction, { time: row.time, id: row.id })], 'DESC', 1)).length > 0;
  const hasNewer = goingNewer ? more : from !== undefined && newest !== undefined && (await anyBeyond('newer', newest));
  const hasOlder = goingNewer ? oldest !== undefined && (await anyBeyond('older', oldest)) : more;
  const projectRows = await db
    .selectDistinct({ projectId: externalServiceCalls.projectId })
    .from(externalServiceCalls)
    .where(
      and(...tableFilters(service, tenantId, {}, projectEnvironmentId, now), isNotNull(externalServiceCalls.projectId))
    );
  return {
    rows,
    hasNewer,
    hasOlder,
    projectIds: projectRows.flatMap((row) => (row.projectId ? [row.projectId] : [])),
  };
}

function notesOf(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

@Injectable()
export class ServiceCallLog {
  constructor(
    private readonly homes: ServiceRecordsHomes,
    private readonly registry: ServiceRegistry
  ) {}

  async page(scope: CallLogScope, query: CallLogQuery): Promise<CallLogPage> {
    const registered = await this.registry.byIdForTenant(scope.tenantId, scope.serviceId);
    if (registered && isAdaptedBuiltIn(registered)) {
      const projectEnvironmentId = 'projectEnvironmentId' in scope ? scope.projectEnvironmentId : undefined;
      return this.viewOf(await builtInPage(registered, scope.tenantId, query, projectEnvironmentId, Date.now()));
    }
    const copy =
      'copy' in scope
        ? scope.copy
        : await this.copyServing(scope.tenantId, scope.serviceId, scope.projectEnvironmentId);
    const home = await this.homes.of(scope.tenantId, scope.serviceId, copy);
    const projectEnvironmentId = 'projectEnvironmentId' in scope ? scope.projectEnvironmentId : undefined;
    const now = Date.now();
    const stored = home
      ? await this.homes.read(home, (database) => storedPage(database, query, projectEnvironmentId, now), EMPTY_PAGE)
      : EMPTY_PAGE;
    return this.viewOf(stored);
  }

  private async copyServing(tenantId: string, serviceId: string, projectEnvironmentId: string): Promise<ServiceCopy> {
    const tested = await this.registry.testedBy(projectEnvironmentId, tenantId);
    return tested?.id === serviceId ? 'development' : 'default';
  }

  private async viewOf(stored: StoredPage): Promise<CallLogPage> {
    const projectIds = [
      ...new Set([...stored.projectIds, ...stored.rows.flatMap((row) => (row.project_id ? [row.project_id] : []))]),
    ];
    const projectEnvironmentIds = [
      ...new Set(stored.rows.flatMap((row) => (row.project_environment_id ? [row.project_environment_id] : []))),
    ];
    const [titles, environmentsById] = await Promise.all([
      projectTitles(projectIds),
      knownEnvironments(projectEnvironmentIds),
    ]);
    const newest = stored.rows[0];
    const oldest = stored.rows.at(-1);
    return {
      calls: stored.rows.map((row) => ({
        requestId: row.request_id,
        time: row.time,
        callerKind: row.caller_kind,
        projectId: row.project_id,
        projectTitle: row.project_id ? (titles.get(row.project_id) ?? null) : null,
        projectEnvironmentId: row.project_environment_id,
        environment: row.environment,
        environmentName: row.project_environment_id
          ? (environmentsById.get(row.project_environment_id)?.environmentName ?? null)
          : null,
        method: row.method,
        path: row.path,
        route: row.route,
        outcome: row.outcome,
        reason: row.reason,
        status: row.status,
        bytesIn: row.bytes_in,
        bytesOut: row.bytes_out,
        durationMs: row.duration_ms,
        notes: notesOf(row.notes),
      })),
      projects: stored.projectIds
        .map((projectId) => ({ projectId, title: titles.get(projectId) ?? null }))
        .toSorted((a, b) => (a.title ?? '').localeCompare(b.title ?? '')),
      retentionDays: callLogRetentionDays,
      newer: stored.hasNewer && newest ? encodeCursor({ time: newest.time, id: newest.id }) : null,
      older: stored.hasOlder && oldest ? encodeCursor({ time: oldest.time, id: oldest.id }) : null,
    };
  }
}
