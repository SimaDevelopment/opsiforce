import type { ServerResponse } from 'node:http';

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ErrorBody {
  message: string;
  type: string;
  code?: string;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function sendError(res: ServerResponse, status: number, error: ErrorBody): void {
  sendJson(res, status, { error });
}
