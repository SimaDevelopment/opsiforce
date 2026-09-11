export type { JsonObject, JsonValue } from '../../src/common/json';

import type { JsonValue } from '../../src/common/json';

export function parseJson(raw: string): JsonValue {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}
