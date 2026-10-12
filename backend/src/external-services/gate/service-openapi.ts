import { problem, type Bound, type Operation, type ServiceManifest } from '@opsiforce/external-service-sdk';
import {
  boundInputsOf,
  operationLimitsOf,
  problemMediaType,
  type BoundInput,
} from '@opsiforce/external-service-sdk/platform';
import type { RegisteredService } from '../registry/service-registry';
import { GATE_ROUTE_PREFIX, VIA_HEADER } from './gate-routes';

type DocumentObject = Record<string, unknown>;

export interface ServiceOpenApiDocument extends DocumentObject {
  openapi: '3.1.0';
  paths: Record<string, { post: DocumentObject }>;
}

interface DeclaredProblem {
  status: number;
  code: string;
  detail: string;
  extensions?: DocumentObject;
}

const PROBLEM_SCHEMA_NAME = 'opsiforce.Problem';

const PROBLEM_SCHEMA_REF = `#/components/schemas/${PROBLEM_SCHEMA_NAME}`;

const DEFS_REF_PREFIX = '#/$defs/';

const SECURITY_SCHEME = 'serviceKey';

const problemSchema = {
  type: 'object',
  description:
    'An RFC 9457 problem. `code` is stable; `callId` names the Call in the Call log (`GET …/calls`) when the Gate logged one.',
  required: ['type', 'title', 'status', 'code'],
  properties: {
    type: { type: 'string', description: '`urn:opsiforce:error:<code>`' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: { type: 'string' },
    detail: { type: 'string' },
    callId: { type: 'string' },
    operation: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    limit: { type: 'integer' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { pointer: { type: 'string' }, detail: { type: 'string' }, rule: { type: 'string' } },
      },
    },
    bound: { type: 'string' },
    pointer: { type: 'string' },
    value: {},
    allowed: {
      type: 'array',
      maxItems: 50,
      items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } } },
    },
    truncated: { type: 'boolean' },
  },
};

const retryAfterHeader = {
  'retry-after': { description: 'Seconds to wait before retrying', schema: { type: 'integer' } },
};

const statusDescriptions: Record<number, string> = {
  400: 'The input does not match the Operation, or the service refused it',
  401: 'No valid environment service key',
  403: 'Not allowed in this Project environment',
  404: 'Unknown service, unknown Operation, or something the service could not find',
  409: "This environment's Project configuration is incomplete, or the service answered a conflict",
  413: 'The input is larger than the Operation accepts',
  422: 'The service could not process the input',
  429: 'The service is rate limited upstream',
  500: 'The platform failed while handling the call',
  502: 'The service failed or answered something the Gate refuses to pass on',
  503: 'The service cannot take calls right now',
};

const serviceOwnStatuses = new Set([400, 404, 409, 422, 429, 502]);

function gateProblems(service: RegisteredService, name: string, operation: Operation, bounded: boolean) {
  const { inputBytes } = operationLimitsOf(operation);
  const problems: DeclaredProblem[] = [
    {
      status: 400,
      code: 'invalid-input',
      detail: 'The input does not match the Operation.',
      extensions: { operation: name, errors: [{ pointer: '/field', detail: 'must be string', rule: 'type' }] },
    },
    { status: 401, code: 'unauthorized', detail: 'Send the environment service key: Authorization: Bearer gw-…' },
    {
      status: 403,
      code: 'operation-off',
      detail: `"${name}" is switched off for this Project environment.`,
      extensions: { operation: name },
    },
    ...(bounded
      ? [
          {
            status: 403,
            code: 'out-of-bounds',
            detail: 'The input names a value this Project configuration does not allow.',
            extensions: {
              operation: name,
              bound: '<bound>',
              pointer: '/field',
              value: '<value>',
              allowed: [{ value: '<allowed value>', label: '<its label>' }],
            },
          },
        ]
      : []),
    { status: 404, code: 'unknown-service', detail: `There is no External Service "${service.slug}".` },
    {
      status: 409,
      code: 'configuration-incomplete',
      detail: "This Project environment's configuration is missing a required field.",
      extensions: { missing: ['<field>'] },
    },
    {
      status: 413,
      code: 'input-too-large',
      detail: `The input is larger than ${inputBytes} bytes.`,
      extensions: { operation: name, limit: inputBytes },
    },
    { status: 500, code: 'gate-failed', detail: 'The platform failed while handling this call.' },
    { status: 500, code: 'secret-unreadable', detail: 'A stored secret of this service cannot be read.' },
    { status: 502, code: 'service-failed', detail: 'The service failed while handling this call.' },
    { status: 502, code: 'timeout', detail: 'The service did not answer in time.' },
    { status: 502, code: 'secret-in-response', detail: 'The answer contained a secret, so the Gate withheld it.' },
    { status: 503, code: 'service-not-configured', detail: `"${service.slug}" is not set up on this platform yet.` },
  ];
  if (service.origin === 'custom') {
    problems.push(
      { status: 503, code: 'service-reloading', detail: 'The service is reloading; retry shortly.' },
      { status: 503, code: 'service-starting', detail: 'The service is starting; retry shortly.' }
    );
  }
  return problems;
}

function problemResponses(problems: DeclaredProblem[]): Record<string, DocumentObject> {
  const byStatus = new Map<number, DeclaredProblem[]>();
  for (const declared of problems) byStatus.set(declared.status, [...(byStatus.get(declared.status) ?? []), declared]);
  for (const status of serviceOwnStatuses) if (!byStatus.has(status)) byStatus.set(status, []);
  return Object.fromEntries(
    [...byStatus.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([status, declared]) => {
        const codes = declared.map(({ code }) => `\`${code}\``);
        const serviceOwn = serviceOwnStatuses.has(status) ? ['a `code` of the service itself'] : [];
        const description = `${statusDescriptions[status]}: ${[...codes, ...serviceOwn].join(', ')}.`;
        return [
          String(status),
          {
            description,
            ...(status === 429 || status === 503 ? { headers: retryAfterHeader } : {}),
            content: {
              [problemMediaType]: {
                schema: { $ref: PROBLEM_SCHEMA_REF },
                ...(declared.length > 0
                  ? {
                      examples: Object.fromEntries(
                        declared.map((entry) => [
                          entry.code,
                          { value: problem({ ...entry.extensions, status, code: entry.code, detail: entry.detail }) },
                        ])
                      ),
                    }
                  : {}),
              },
            },
          },
        ];
      })
  );
}

function boundSource(bound: Bound): string {
  const [listKey, itemKey] = bound.path.split('[].');
  if (!itemKey) return `the Project configuration's \`${bound.path}\``;
  const where = Object.entries(bound.where ?? {}).map(
    ([field, pointer]) =>
      `\`${itemKey}\` of the Project configuration's \`${listKey}\` item whose \`${field}\` equals the input's \`${pointer}\``
  );
  return where[0] ?? `the \`${itemKey}\` values across the Project configuration's \`${listKey}\` items`;
}

function boundExplanation(name: string, bound: Bound | undefined): string {
  if (!bound) return `Bound to \`${name}\`.`;
  const unless = Object.entries(bound.unless ?? {}).map(
    ([field, value]) => ` (any value while \`${field}\` is \`${String(value)}\`)`
  );
  return `Bound to \`${name}\`: one of ${boundSource(bound)}${unless.join('')}. Describe (\`GET\` the server URL) lists the allowed values with labels; anything else answers \`403 out-of-bounds\`.`;
}

function documentedSchema(schema: unknown, manifest: ServiceManifest): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => documentedSchema(entry, manifest));
  if (typeof schema !== 'object' || schema === null) return schema;
  const documented: DocumentObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(DEFS_REF_PREFIX)) {
      documented.$ref = `#/components/schemas/${value.slice(DEFS_REF_PREFIX.length)}`;
    } else if (key === 'boundTo' && typeof value === 'string') {
      documented['x-opsiforce-bound'] = value;
      const explanation = boundExplanation(value, manifest.bounds?.[value]);
      const own = (schema as DocumentObject).description;
      documented.description = typeof own === 'string' ? `${own}\n\n${explanation}` : explanation;
    } else if (key === 'description' && typeof (schema as DocumentObject).boundTo === 'string') {
      continue;
    } else {
      documented[key] = documentedSchema(value, manifest);
    }
  }
  return documented;
}

function operationDescription(operation: Operation, boundInputs: BoundInput[], manifest: ServiceManifest): string {
  const { inputBytes, timeoutSeconds } = operationLimitsOf(operation);
  const unique = [...new Map(boundInputs.map((input) => [`${input.pointer} ${input.bound}`, input])).values()];
  const bounds = unique.map(
    ({ pointer, bound }) =>
      `- \`${pointer.slice(1) || '(the input)'}\`: ${boundExplanation(bound, manifest.bounds?.[bound])}`
  );
  return [
    operation.description,
    `**Kind:** ${operation.kind}. It runs only while switched on for this Project environment (describe → \`operations\`); otherwise \`403 operation-off\`.`,
    ...(bounds.length > 0 ? [['**Bound inputs.**', ...bounds].join('\n')] : []),
    `**Limits:** input up to ${inputBytes} bytes, answered within ${timeoutSeconds} s.`,
  ].join('\n\n');
}

function documentedOperation(service: RegisteredService, name: string, operation: Operation): DocumentObject {
  const { manifest } = service;
  const boundInputs = boundInputsOf(operation.input, manifest.$defs);
  return {
    operationId: name,
    summary: operation.title ?? name,
    description: operationDescription(operation, boundInputs, manifest),
    'x-opsiforce-kind': operation.kind,
    parameters: [
      {
        name: VIA_HEADER,
        in: 'header',
        required: false,
        description: 'Send `app` from App code; a call without it is logged as the agent’s.',
        schema: { type: 'string', enum: ['agent', 'app'] },
      },
    ],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: documentedSchema(operation.input, manifest) } },
    },
    responses: {
      '200': {
        description: "The service's answer: JSON, or one file with its own content type.",
        content: {
          'application/json': {
            schema: {},
            ...(operation.outputExample === undefined ? {} : { example: operation.outputExample }),
          },
        },
      },
      ...problemResponses(gateProblems(service, name, operation, boundInputs.length > 0)),
    },
  };
}

function documentDescription(service: RegisteredService): string {
  return [
    service.manifest.description,
    `**Calling.** Every Operation is \`POST <server>/<operation>\` with its input as the JSON body and this environment's service key: \`Authorization: Bearer $SERVICE_GATEWAY_API_KEY\`. App code also sends \`${VIA_HEADER}: app\`.`,
    "**Before calling.** `GET <server>` (describe) tells which Operations are on in this Project environment, its Project configuration with labels and whether it is complete. `GET <server>/calls?limit=50` lists this environment's recent Calls.",
    '**Errors** are RFC 9457 `application/problem+json` with a stable `code` and, for a logged Call, its `callId`.',
  ].join('\n\n');
}

export function serviceOpenApiDocument(service: RegisteredService): ServiceOpenApiDocument {
  const { manifest } = service;
  const operations = Object.entries(manifest.operations ?? {});
  return {
    openapi: '3.1.0',
    info: {
      title: manifest.displayName,
      description: documentDescription(service),
      version: service.manifestHash.slice(0, 12),
      'x-opsiforce-manifest-hash': service.manifestHash,
    },
    servers: [{ url: `${GATE_ROUTE_PREFIX}${service.slug}` }],
    security: [{ [SECURITY_SCHEME]: [] }],
    paths: Object.fromEntries(
      operations.map(([name, operation]) => [`/${name}`, { post: documentedOperation(service, name, operation) }])
    ),
    components: {
      securitySchemes: {
        [SECURITY_SCHEME]: {
          type: 'http',
          scheme: 'bearer',
          description: "This environment's service key (`$SERVICE_GATEWAY_API_KEY`, `gw-…`).",
        },
      },
      schemas: {
        ...Object.fromEntries(
          Object.entries(manifest.$defs ?? {}).map(([name, schema]) => [name, documentedSchema(schema, manifest)])
        ),
        [PROBLEM_SCHEMA_NAME]: problemSchema,
      },
    },
  };
}
