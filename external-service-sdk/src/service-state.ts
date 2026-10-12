import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ServiceState, StateEntry } from './handlers.ts';

export const stateFileInWorkspace = 'data/service-state.db';

export const defaultStateFile = `/workspace/${stateFileInWorkspace}`;

export const maxStateKeyLength = 256;

const BUSY_TIMEOUT_MS = 5000;

const STATE_TABLE = 'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT';

type WithDatabase = <Result>(run: (database: DatabaseSync) => Result) => Result;

function checkKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > maxStateKeyLength) {
    throw new RangeError(`ctx.state keys are 1 to ${maxStateKeyLength} characters`);
  }
}

function encodeValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (value === undefined || json === undefined) throw new TypeError('ctx.state.set needs a JSON value');
  return json;
}

function sqliteState(withDatabase: WithDatabase): ServiceState {
  return {
    async get<Value>(key: string) {
      checkKey(key);
      const row = withDatabase((database) => database.prepare('SELECT value FROM state WHERE key = ?').get(key)) as
        | { value: string }
        | undefined;
      return row === undefined ? undefined : (JSON.parse(row.value) as Value);
    },
    async set(key, value) {
      checkKey(key);
      const json = encodeValue(value);
      withDatabase((database) =>
        database
          .prepare(
            'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
          )
          .run(key, json)
      );
    },
    async delete(key) {
      checkKey(key);
      withDatabase((database) => database.prepare('DELETE FROM state WHERE key = ?').run(key));
    },
    async list(prefix = '') {
      const rows = withDatabase((database) =>
        database.prepare('SELECT key, value FROM state WHERE instr(key, ?) = 1 ORDER BY key').all(prefix)
      ) as { key: string; value: string }[];
      return rows.map((row): StateEntry => ({ key: row.key, value: JSON.parse(row.value) }));
    },
  };
}

export function createFileServiceState(file: string = defaultStateFile): ServiceState {
  return sqliteState((run) => {
    mkdirSync(dirname(file), { recursive: true });
    const database = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    try {
      database.exec(STATE_TABLE);
      return run(database);
    } finally {
      database.close();
    }
  });
}

export function createMemoryServiceState(): ServiceState {
  const database = new DatabaseSync(':memory:');
  database.exec(STATE_TABLE);
  return sqliteState((run) => run(database));
}

export function unavailableServiceState(message: string): ServiceState {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return { get: fail, set: fail, delete: fail, list: fail };
}
