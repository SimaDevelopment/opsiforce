import path from 'node:path';
import { type Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';

export type SqliteJournalMode = 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF';
export type SqliteSynchronous = 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';

export interface SqlitePragmaProfile {
  journalMode?: SqliteJournalMode;
  busyTimeoutMs?: number;
  synchronous?: SqliteSynchronous;
}

export function environmentDatabasePath(envDirectory: string, fileName: string): string {
  return path.join(envDirectory, 'data', fileName);
}

export function openEnvironmentDatabase(
  envDirectory: string,
  fileName: string,
  pragmas: SqlitePragmaProfile
): Promise<Database> {
  return openDatabaseFile(environmentDatabasePath(envDirectory, fileName), pragmas);
}

export async function openDatabaseFile(filename: string, pragmas: SqlitePragmaProfile): Promise<Database> {
  const connection = await open({ filename, driver: sqlite3.Database });
  try {
    for (const statement of pragmaStatements(pragmas)) {
      await connection.exec(statement);
    }
  } catch (err) {
    await connection.close().catch(() => {});
    throw err;
  }
  return connection;
}

function pragmaStatements(pragmas: SqlitePragmaProfile): string[] {
  const statements: string[] = [];
  if (pragmas.journalMode !== undefined) statements.push(`PRAGMA journal_mode = ${pragmas.journalMode}`);
  if (pragmas.busyTimeoutMs !== undefined) statements.push(`PRAGMA busy_timeout = ${pragmas.busyTimeoutMs}`);
  if (pragmas.synchronous !== undefined) statements.push(`PRAGMA synchronous = ${pragmas.synchronous}`);
  return statements;
}
