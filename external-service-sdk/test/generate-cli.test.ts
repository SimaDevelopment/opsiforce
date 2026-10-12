import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkServiceManifest, openApiRouteRequest, type OpenApiRoute } from '@opsiforce/external-service-sdk';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';

import { runCli } from './support/cli.ts';
import { fixtureFolder, serviceFolderWith, type JsonObject } from './support/fixtures.ts';

const tasksDocument = join(fixtureFolder('openapi'), 'tasks.json');

function tasksDocumentWith(edit: (document: JsonObject) => void): string {
  const document = JSON.parse(readFileSync(tasksDocument, 'utf8'));
  edit(document);
  const folder = serviceFolderWith({ 'openapi.json': JSON.stringify(document) });
  return join(folder, 'openapi.json');
}

function generate(documentPath: string, files: Record<string, string> = {}, flags: string[] = []) {
  const folder = serviceFolderWith(files);
  const run = runCli(['generate', '--from-openapi', documentPath, folder, ...flags]);
  const read = (name: string): JsonObject | undefined =>
    existsSync(join(folder, name)) ? JSON.parse(readFileSync(join(folder, name), 'utf8')) : undefined;
  return { run, folder, manifest: read('service.json'), routes: read('openapi-routes.json') };
}

test('generate writes one Operation per route with a flat input from path, query and body', () => {
  const { run, manifest } = generate(tasksDocument);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(Object.keys(manifest.operations), [
    'create_task',
    'delete_task',
    'get_task',
    'list_tasks',
    'post_v1_tasks_archive',
  ]);
  assert.deepEqual(manifest.operations.list_tasks.input, {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    additionalProperties: false,
  });
  assert.deepEqual(manifest.operations.create_task.input.required, ['title']);
  assert.deepEqual(Object.keys(manifest.operations.create_task.input.properties), ['title', 'assignee', 'labels']);
  assert.deepEqual(manifest.operations.get_task.input, {
    type: 'object',
    properties: { taskId: { type: 'string', format: 'uuid' } },
    required: ['taskId'],
    additionalProperties: false,
  });
});

test('generate takes each kind from the HTTP method', () => {
  const { manifest } = generate(tasksDocument);

  const kinds = Object.fromEntries(
    Object.entries(manifest.operations as Record<string, { kind: string }>).map(([name, op]) => [name, op.kind])
  );
  assert.deepEqual(kinds, {
    create_task: 'write',
    delete_task: 'destructive',
    get_task: 'read',
    list_tasks: 'read',
    post_v1_tasks_archive: 'write',
  });
});

test('generate writes a manifest that passes check, with schemas outside the input profile translated', () => {
  const { run, folder, manifest } = generate(tasksDocument);

  assert.deepEqual(
    checkServiceManifest(manifest, { origin: 'custom' }).problems.filter((p) => p.severity === 'error'),
    []
  );
  assert.equal(runCli(['check', folder]).status, 0, run.stdout);
  assert.equal(manifest.operations.create_task.input.properties.title.pattern, undefined);
  assert.deepEqual(manifest.operations.create_task.input.properties.assignee, {
    type: ['object', 'null'],
    anyOf: [{ $ref: '#/$defs/Person' }, { type: 'null' }],
  });
  assert.deepEqual(manifest.operations.create_task.input.properties.labels.examples, [['urgent']]);
  assert.deepEqual(manifest.$defs.Person.properties.id, { type: 'string' });
});

test('generate names the service from the document when there is no service.json yet', () => {
  const { manifest } = generate(tasksDocument);

  assert.equal(manifest.sdk, 1);
  assert.equal(manifest.displayName, 'Tasks API');
  assert.equal(manifest.description, "Track the team's tasks.");
  assert.equal(manifest.operations.list_tasks.title, 'List tasks');
  assert.equal(manifest.operations.list_tasks.description, 'Every open task, newest first.');
  assert.equal(manifest.operations.get_task.description, 'Get a task');
});

test('generate keeps everything but the Operations and $defs of an existing service.json', () => {
  const existing = {
    sdk: 1,
    displayName: 'Team tasks',
    description: 'Our tasks.',
    serviceForm: [{ key: 'apiKey', type: 'secret', label: 'API key', required: true }],
    operations: { stale_operation: { kind: 'read', description: 'Gone.', input: { type: 'object' } } },
  };

  const { manifest } = generate(tasksDocument, { 'service.json': JSON.stringify(existing) });

  assert.equal(manifest.displayName, 'Team tasks');
  assert.deepEqual(manifest.serviceForm, existing.serviceForm);
  assert.equal(manifest.operations.stale_operation, undefined);
  assert.ok(manifest.operations.list_tasks);
});

test('generate writes the route table a generic handler calls', () => {
  const { routes } = generate(tasksDocument);

  assert.deepEqual(routes.get_task, {
    method: 'GET',
    path: '/v1/tasks/{taskId}',
    pathParams: ['taskId'],
    queryParams: [],
    body: 'none',
  });
  assert.deepEqual(routes.list_tasks.queryParams, ['limit']);
  assert.equal(routes.create_task.body, 'fields');
});

test('generate writes service.types.ts for the manifest it wrote', () => {
  const { folder } = generate(tasksDocument);

  const types = readFileSync(join(folder, 'service.types.ts'), 'utf8');
  const json = JSON.parse(readFileSync(join(folder, 'service.json'), 'utf8'));
  assert.match(types, new RegExp(`export const manifestHash = '${computeManifestHash(json)}';`));
});

test('generate leaves files that did not change alone', () => {
  const first = generate(tasksDocument);
  const again = runCli(['generate', '--from-openapi', tasksDocument, first.folder]);

  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /service\.json is up to date/);
});

test('an x-opsiforce-operation route list replaces operationIds, takes x-opsiforce-kind and leaves the rest out', () => {
  const document = tasksDocumentWith((doc) => {
    doc.paths['/v1/tasks'].get['x-opsiforce-operation'] = 'find_tasks';
    doc.paths['/v1/tasks/{taskId}/archive'].post['x-opsiforce-operation'] = 'archive_task';
    doc.paths['/v1/tasks/{taskId}/archive'].post['x-opsiforce-kind'] = 'destructive';
  });

  const { run, manifest } = generate(document);

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(Object.keys(manifest.operations), ['archive_task', 'find_tasks']);
  assert.equal(manifest.operations.archive_task.kind, 'destructive');
});

test('generate fails on two routes with the same Operation name and writes nothing', () => {
  const document = tasksDocumentWith((doc) => {
    doc.paths['/v1/tasks/{taskId}'].get.operationId = 'listTasks';
  });

  const { run, folder } = generate(document);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /list_tasks.*GET \/v1\/tasks\b.*GET \/v1\/tasks\/\{taskId\}/);
  assert.equal(existsSync(join(folder, 'service.json')), false);
  assert.equal(existsSync(join(folder, 'openapi-routes.json')), false);
});

test('generate fails when a path, query or body field shares a name with another', () => {
  const document = tasksDocumentWith((doc) => {
    doc.components.schemas.NewTask.properties.limit = { type: 'integer' };
    doc.paths['/v1/tasks'].post.parameters = [{ name: 'limit', in: 'query', schema: { type: 'integer' } }];
  });

  const { run, folder } = generate(document);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /create_task.*"limit" comes from both the query and the body/);
  assert.equal(existsSync(join(folder, 'service.json')), false);
});

test('generate refuses a request body that is not JSON', () => {
  const document = tasksDocumentWith((doc) => {
    doc.paths['/v1/tasks'].post.requestBody = {
      content: { 'multipart/form-data': { schema: { type: 'object' } } },
    };
  });

  const { run } = generate(document);

  assert.equal(run.status, 1);
  assert.match(run.stdout, /create_task.*application\/json/);
});

test('generate without --from-openapi is a usage error', () => {
  const run = runCli(['generate', serviceFolderWith({})]);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /--from-openapi/);
});

test('a route table entry turns a flat input back into the request', () => {
  const route: OpenApiRoute = {
    method: 'POST',
    path: '/v1/tasks/{taskId}/comments',
    pathParams: ['taskId'],
    queryParams: ['notify'],
    body: 'fields',
  };

  assert.deepEqual(openApiRouteRequest(route, { taskId: 'a/b', notify: true, text: 'Hi', mentions: ['x'] }), {
    method: 'POST',
    path: '/v1/tasks/a%2Fb/comments?notify=true',
    body: { text: 'Hi', mentions: ['x'] },
  });
  assert.deepEqual(openApiRouteRequest({ ...route, method: 'GET', body: 'none' }, { taskId: 't1' }), {
    method: 'GET',
    path: '/v1/tasks/t1/comments',
    body: undefined,
  });
});
