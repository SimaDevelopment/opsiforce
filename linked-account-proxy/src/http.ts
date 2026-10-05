import type { ServerResponse } from 'node:http';

export type JsonRecord = Record<string, unknown>;

export interface ErrorBody {
  message: string;
  type: string;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function sendError(res: ServerResponse, status: number, error: ErrorBody): void {
  sendJson(res, status, { error });
}
