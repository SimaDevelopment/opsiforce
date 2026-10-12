import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export const stateFileInWorkspace = 'data/service-state.db';
export const defaultStateFile = `/workspace/${stateFileInWorkspace}`;
export const maxStateKeyLength = 256;
const BUSY_TIMEOUT_MS = 5000;
const STATE_TABLE = 'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT';
function checkKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > maxStateKeyLength) {
        throw new RangeError(`ctx.state keys are 1 to ${maxStateKeyLength} characters`);
    }
}
function encodeValue(value) {
    const json = JSON.stringify(value);
    if (value === undefined || json === undefined)
        throw new TypeError('ctx.state.set needs a JSON value');
    return json;
}
function sqliteState(withDatabase) {
    return {
        async get(key) {
            checkKey(key);
            const row = withDatabase((database) => database.prepare('SELECT value FROM state WHERE key = ?').get(key));
            return row === undefined ? undefined : JSON.parse(row.value);
        },
        async set(key, value) {
            checkKey(key);
            const json = encodeValue(value);
            withDatabase((database) => database
                .prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
                .run(key, json));
        },
        async delete(key) {
            checkKey(key);
            withDatabase((database) => database.prepare('DELETE FROM state WHERE key = ?').run(key));
        },
        async list(prefix = '') {
            const rows = withDatabase((database) => database.prepare('SELECT key, value FROM state WHERE instr(key, ?) = 1 ORDER BY key').all(prefix));
            return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
        },
    };
}
export function createFileServiceState(file = defaultStateFile) {
    return sqliteState((run) => {
        mkdirSync(dirname(file), { recursive: true });
        const database = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
        try {
            database.exec(STATE_TABLE);
            return run(database);
        }
        finally {
            database.close();
        }
    });
}
export function createMemoryServiceState() {
    const database = new DatabaseSync(':memory:');
    database.exec(STATE_TABLE);
    return sqliteState((run) => run(database));
}
export function unavailableServiceState(message) {
    const fail = async () => {
        throw new Error(message);
    };
    return { get: fail, set: fail, delete: fail, list: fail };
}
