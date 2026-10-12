import Ajv2020 from 'ajv/dist/2020';
import { expect } from 'vitest';

export interface ServiceDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, DocumentOperation>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  security?: Record<string, string[]>[];
}

export interface DocumentOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  'x-opsiforce-kind'?: string;
  parameters?: { name: string; in: string }[];
  requestBody?: { required?: boolean; content: Record<string, { schema: unknown }> };
  responses: Record<string, DocumentResponse>;
}

export interface DocumentResponse {
  description: string;
  headers?: Record<string, unknown>;
  content?: Record<
    string,
    { schema?: unknown; example?: unknown; examples?: Record<string, { value: { code: string } }> }
  >;
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const OPENAPI_SCHEMA_KEYWORDS = ['example', 'discriminator', 'xml', 'externalDocs'];

function referencesIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(referencesIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    key === '$ref' && typeof entry === 'string' ? [entry] : referencesIn(entry)
  );
}

function resolvePointer(document: unknown, ref: string): unknown {
  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>(
      (node, segment) =>
        typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined,
      document
    );
}

function operationsOf(document: ServiceDocument): [string, string, DocumentOperation][] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]): [string, string, DocumentOperation] => [path, method, operation])
  );
}

export function expectOpenApi31(document: ServiceDocument): void {
  expect(document.openapi).toMatch(/^3\.1\.\d+$/);
  expect(typeof document.info.title).toBe('string');
  expect(typeof document.info.version).toBe('string');

  const operationIds = new Set<string>();
  for (const [path, method, operation] of operationsOf(document)) {
    expect(path.startsWith('/'), `${path} starts with /`).toBe(true);
    expect(Object.keys(operation.responses).length, `${method} ${path} has responses`).toBeGreaterThan(0);
    for (const [status, response] of Object.entries(operation.responses)) {
      expect(status, `${method} ${path}`).toMatch(/^([1-5]\d\d|[1-5]XX|default)$/);
      expect(typeof response.description, `${method} ${path} ${status} has a description`).toBe('string');
    }
    if (operation.operationId !== undefined) {
      expect(operationIds.has(operation.operationId), `${operation.operationId} is unique`).toBe(false);
      operationIds.add(operation.operationId);
    }
  }

  for (const ref of referencesIn(document)) {
    expect(ref.startsWith('#/'), `${ref} is local`).toBe(true);
    expect(resolvePointer(document, ref), `${ref} resolves`).toBeDefined();
  }
  for (const name of Object.keys(document.components?.schemas ?? {})) {
    expect(name).toMatch(/^[a-zA-Z0-9.\-_]+$/);
  }
}

export function requestValidator(document: ServiceDocument, path: string) {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  for (const keyword of [...OPENAPI_SCHEMA_KEYWORDS, 'components', 'x-opsiforce-bound']) ajv.addKeyword(keyword);
  const schema = document.paths[path]?.post?.requestBody?.content['application/json']?.schema as object;
  return ajv.compile({ ...schema, components: document.components });
}
