import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { builtInCounters, type BuiltInCounterName } from './define-service.ts';
import type { CallRow, CountEntry, ServiceRecords } from './service-pipeline.ts';

export const recordsFileInWorkspace = 'data/service-records.db';

export const defaultRecordsFile = `/workspace/${recordsFileInWorkspace}`;

export const callLogRetentionDays = 30;

export const recordsSchemaVersion = 2;

const BUSY_TIMEOUT_MS = 5000;

const FLUSH_AFTER_MS = 1000;

const PRUNE_EVERY_MS = 60 * 60 * 1000;

const FLUSH_AT_PENDING = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const recordsSchema = `
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  time TEXT NOT NULL,
  caller_kind TEXT NOT NULL,
  project_id TEXT,
  project_environment_id TEXT,
  environment TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  route TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  status INTEGER NOT NULL,
  bytes_in INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  notes TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS calls_by_time ON calls (time, id);
CREATE INDEX IF NOT EXISTS calls_by_project ON calls (project_id, time, id);
CREATE INDEX IF NOT EXISTS calls_by_project_environment ON calls (project_environment_id, time, id);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,
  project_id TEXT,
  project_environment_id TEXT,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  value INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS usage_by_count ON usage (
  month, ifnull(project_id, ''), ifnull(project_environment_id, ''), name
);
`;

export interface FileServiceRecordsOptions {
  file?: string;
  now?: () => number;
  flushAfterMs?: number;
}

export interface FileServiceRecords extends ServiceRecords {
  flush(): void;
  close(): void;
}

interface OpenRecords {
  database: DatabaseSync;
  insertCall: StatementSync;
  pruneCalls: StatementSync;
  addUsage: StatementSync;
}

interface PendingCount {
  month: string;
  projectId: string | null;
  projectEnvironmentId: string | null;
  name: string;
  label: string;
  description: string | null;
  n: number;
}

function openRecords(file: string): OpenRecords {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    database.exec('PRAGMA locking_mode = NORMAL');
    database.exec('PRAGMA journal_mode = TRUNCATE');
    database.exec('PRAGMA synchronous = FULL');
    database.exec(recordsSchema);
    database.exec(`PRAGMA user_version = ${recordsSchemaVersion}`);
    return {
      database,
      insertCall: database.prepare(
        `INSERT OR IGNORE INTO calls (request_id, time, caller_kind, project_id, project_environment_id, environment,
           method, path, route, outcome, reason, status, bytes_in, bytes_out, duration_ms, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      pruneCalls: database.prepare('DELETE FROM calls WHERE time < ?'),
      addUsage: database.prepare(
        `INSERT INTO usage (month, project_id, project_environment_id, name, label, description, value)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (month, ifnull(project_id, ''), ifnull(project_environment_id, ''), name)
         DO UPDATE SET value = value + excluded.value, label = excluded.label, description = excluded.description`
      ),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function monthOf(time: string | number): string {
  return new Date(time).toISOString().slice(0, 7);
}

function builtInCountsOf(row: CallRow): BuiltInCounterName[] {
  if (row.callerKind !== 'call') return [];
  if (row.outcome === 'not allowed') return ['requests', 'not_allowed'];
  if (row.outcome === 'failed') return ['requests', 'failed'];
  return ['requests'];
}

function notesText(notes: Record<string, unknown>): string {
  try {
    return JSON.stringify(notes) ?? '{}';
  } catch {
    return '{}';
  }
}

export function createFileServiceRecords(options: FileServiceRecordsOptions = {}): FileServiceRecords {
  const file = options.file ?? defaultRecordsFile;
  const now = options.now ?? Date.now;
  const flushAfterMs = options.flushAfterMs ?? FLUSH_AFTER_MS;
  let pending: CallRow[] = [];
  let pendingCounts = new Map<string, PendingCount>();
  let open: OpenRecords | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let prunedAt = Number.NEGATIVE_INFINITY;
  let lastProblem = '';

  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastProblem) return;
    lastProblem = message;
    process.stderr.write(`The Call log and Usage could not be written to ${file}: ${message}\n`);
  };

  const closeDatabase = () => {
    open?.database.close();
    open = null;
  };

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending.length === 0 && pendingCounts.size === 0) return;
    const rows = pending;
    const counts = [...pendingCounts.values()];
    pending = [];
    pendingCounts = new Map();
    try {
      open ??= openRecords(file);
      const { database, insertCall, pruneCalls, addUsage } = open;
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          insertCall.run(
            row.requestId,
            row.time,
            row.callerKind,
            row.projectId,
            row.projectEnvironmentId,
            row.environment,
            row.method,
            row.path,
            row.route,
            row.outcome,
            row.reason,
            row.status,
            row.bytesIn,
            row.bytesOut,
            Math.max(0, Math.round(row.durationMs)),
            notesText(row.notes)
          );
        }
        for (const count of counts) {
          addUsage.run(
            count.month,
            count.projectId,
            count.projectEnvironmentId,
            count.name,
            count.label,
            count.description,
            count.n
          );
        }
        if (now() - prunedAt >= PRUNE_EVERY_MS) {
          pruneCalls.run(new Date(now() - callLogRetentionDays * DAY_MS).toISOString());
          prunedAt = now();
        }
        database.exec('COMMIT');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
      lastProblem = '';
    } catch (error) {
      report(error);
      try {
        closeDatabase();
      } catch {
        open = null;
      }
    }
  };

  const flushSoon = () => {
    if (timer !== null) return;
    timer = setTimeout(flush, flushAfterMs);
    timer.unref();
  };

  const flushWhenFull = () => {
    if (pending.length >= FLUSH_AT_PENDING || pendingCounts.size >= FLUSH_AT_PENDING) flush();
    else flushSoon();
  };

  const addCount = (month: string, entry: Omit<CountEntry, 'environment'>) => {
    const key = JSON.stringify([month, entry.projectId, entry.projectEnvironmentId, entry.name]);
    const queued = pendingCounts.get(key);
    if (queued) {
      queued.n += entry.n;
      queued.label = entry.label;
      queued.description = entry.description;
    } else {
      pendingCounts.set(key, {
        month,
        projectId: entry.projectId,
        projectEnvironmentId: entry.projectEnvironmentId,
        name: entry.name,
        label: entry.label,
        description: entry.description,
        n: entry.n,
      });
    }
    flushWhenFull();
  };

  return {
    call(row) {
      for (const name of builtInCountsOf(row)) {
        addCount(monthOf(row.time), {
          name,
          label: builtInCounters[name].label,
          description: builtInCounters[name].description ?? null,
          n: 1,
          projectId: row.projectId,
          projectEnvironmentId: row.projectEnvironmentId,
        });
      }
      pending.push(row);
      flushWhenFull();
    },
    count(entry) {
      addCount(monthOf(now()), entry);
    },
    flush,
    close() {
      flush();
      closeDatabase();
    },
  };
}
