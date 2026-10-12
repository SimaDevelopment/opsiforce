import { inputFormats, inputSchemaLimits, type InputSchema, type JsonType } from './input-schema.ts';
import { operationKinds, type OperationKind } from './manifest.ts';
import {
  openApiMethods,
  wholeBodyField,
  type OpenApiMethod,
  type OpenApiRoute,
  type OpenApiRoutes,
} from './openapi-routes.ts';

export const operationNameExtension = 'x-opsiforce-operation';
export const operationKindExtension = 'x-opsiforce-kind';

type JsonObject = Record<string, unknown>;

export interface GeneratedFromOpenApi {
  ok: true;
  manifest: JsonObject;
  routes: OpenApiRoutes;
}

export interface OpenApiGenerationFailure {
  ok: false;
  problems: string[];
}

export interface GenerateFromOpenApiOptions {
  existingManifest?: JsonObject;
}

const jsonTypes: readonly JsonType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const componentSchemaPrefix = '#/components/schemas/';
const limits = { title: 80, operationDescription: 500, serviceDescription: 300, schemaDescription: 2000 };

const kindOfMethod: Record<OpenApiMethod, OperationKind> = {
  GET: 'read',
  POST: 'write',
  PUT: 'write',
  PATCH: 'write',
  DELETE: 'destructive',
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function firstParagraph(text: string): string {
  return (
    text
      .trim()
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? ''
  );
}

function firstSentence(text: string): string {
  const paragraph = firstParagraph(text);
  return /^.*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
}

function withinLimit(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let kept = '';
  for (const sentence of sentences) {
    if ((kept + sentence).trimEnd().length > max) break;
    kept += sentence;
  }
  return kept.trim() === '' ? cut(text, max) : kept.trim();
}

export function snakeCaseName(text: string): string {
  const snake = text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const named = /^[a-z]/.test(snake) ? snake : `op_${snake}`;
  return named.slice(0, 64).replace(/_+$/, '');
}

function defNameOf(componentName: string): string {
  const name = componentName.replace(/[^A-Za-z0-9_]/g, '_');
  return (/^[A-Za-z]/.test(name) ? name : `S${name}`).slice(0, 64);
}

class SchemaTranslator {
  readonly defs = new Map<string, InputSchema>();
  private readonly defNames = new Map<string, string>();
  private readonly translating = new Set<string>();
  private readonly document: JsonObject;

  constructor(document: JsonObject) {
    this.document = document;
  }

  resolve(ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let node: unknown = this.document;
    for (const segment of ref.slice(2).split('/')) {
      if (!isObject(node)) return undefined;
      node = node[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return node;
  }

  dereferenced(value: unknown, seen = new Set<string>()): JsonObject {
    if (!isObject(value)) return {};
    if (typeof value.$ref !== 'string') return value;
    if (seen.has(value.$ref)) return {};
    seen.add(value.$ref);
    return this.dereferenced(this.resolve(value.$ref), seen);
  }

  objectView(value: unknown): JsonObject {
    const schema = this.dereferenced(value);
    if (!Array.isArray(schema.allOf)) return schema;
    const { allOf, ...rest } = schema;
    const merged: JsonObject = { ...rest };
    const properties: JsonObject = isObject(rest.properties) ? { ...rest.properties } : {};
    const required = new Set<string>(Array.isArray(rest.required) ? (rest.required as string[]) : []);
    for (const part of allOf) {
      const member = this.objectView(part);
      if (isObject(member.properties)) Object.assign(properties, member.properties);
      for (const name of Array.isArray(member.required) ? (member.required as string[]) : []) required.add(name);
      if (merged.type === undefined && member.type !== undefined) merged.type = member.type;
      if (merged.description === undefined && member.description !== undefined) merged.description = member.description;
      if (merged.additionalProperties === undefined && member.additionalProperties !== undefined) {
        merged.additionalProperties = member.additionalProperties;
      }
    }
    if (Object.keys(properties).length > 0) merged.properties = properties;
    if (required.size > 0) merged.required = [...required];
    return merged;
  }

  translate(value: unknown): InputSchema {
    if (!isObject(value)) return { type: [...jsonTypes] };
    if (typeof value.$ref === 'string') return this.translateRef(value.$ref, value.description);
    const schema = Array.isArray(value.allOf) ? this.objectView(value) : value;
    const out: InputSchema = {};

    const types = this.declaredTypes(schema);
    if (types) out.type = types.length === 1 ? types[0] : types;
    if (typeof schema.title === 'string') out.title = cut(schema.title, 200);
    if (typeof schema.description === 'string') out.description = cut(schema.description, limits.schemaDescription);
    if (schema.default !== undefined) out.default = schema.default;
    if (Array.isArray(schema.examples)) out.examples = schema.examples.slice(0, 10);
    else if (schema.example !== undefined) out.examples = [schema.example];
    if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= inputSchemaLimits.maxEnumValues) {
      out.enum = schema.enum;
    }
    if (schema.const !== undefined) out.const = schema.const;
    if (isObject(schema.properties)) {
      out.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([name, property]) => [name, this.translate(property)])
      );
    }
    if (Array.isArray(schema.required) && schema.required.length > 0) out.required = schema.required as string[];
    if (typeof schema.additionalProperties === 'boolean') out.additionalProperties = schema.additionalProperties;
    else if (isObject(schema.additionalProperties)) {
      out.additionalProperties =
        Object.keys(schema.additionalProperties).length === 0 ? true : this.translate(schema.additionalProperties);
    }
    for (const key of ['minProperties', 'maxProperties', 'minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
      if (Number.isInteger(schema[key]) && (schema[key] as number) >= 0) out[key] = schema[key] as number;
    }
    if (isObject(schema.items)) out.items = this.translate(schema.items);
    if (typeof schema.uniqueItems === 'boolean') out.uniqueItems = schema.uniqueItems;
    if (typeof schema.format === 'string' && (inputFormats as readonly string[]).includes(schema.format)) {
      out.format = schema.format as InputSchema['format'];
    }
    this.translateBounds(schema, out);
    for (const key of ['anyOf', 'oneOf'] as const) {
      const alternatives = schema[key];
      if (Array.isArray(alternatives) && alternatives.length > 0) {
        out[key] = alternatives.slice(0, inputSchemaLimits.maxAlternatives).map((part) => this.translate(part));
      }
    }
    if (out.type === undefined) {
      const inferred = this.inferredTypes(out);
      out.type = inferred.length === 1 ? inferred[0] : inferred;
    }
    return orderedSchema(out);
  }

  typesOf(schema: InputSchema): JsonType[] {
    if (schema.$ref !== undefined) {
      const def = this.defs.get(schema.$ref.slice('#/$defs/'.length));
      return def ? this.typesOf(def) : [...jsonTypes];
    }
    if (schema.type !== undefined) return Array.isArray(schema.type) ? schema.type : [schema.type];
    return this.inferredTypes(schema);
  }

  private translateRef(ref: string, description: unknown): InputSchema {
    if (!ref.startsWith(componentSchemaPrefix)) return this.translate(this.dereferenced({ $ref: ref }));
    const component = ref.slice(componentSchemaPrefix.length);
    const name = this.defName(component);
    if (!this.defs.has(name) && !this.translating.has(name)) {
      this.translating.add(name);
      this.defs.set(name, this.translate(this.resolve(ref)));
      this.translating.delete(name);
    }
    const out: InputSchema = { $ref: `#/$defs/${name}` };
    if (typeof description === 'string') out.description = cut(description, limits.schemaDescription);
    return out;
  }

  private defName(component: string): string {
    const known = this.defNames.get(component);
    if (known) return known;
    const base = defNameOf(component);
    const taken = new Set(this.defNames.values());
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base.slice(0, 60)}${suffix}`;
    this.defNames.set(component, name);
    return name;
  }

  private declaredTypes(schema: JsonObject): JsonType[] | undefined {
    const declared = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
    const types = declared.filter((type): type is JsonType => jsonTypes.includes(type as JsonType));
    if (types.length === 0) return undefined;
    if (schema.nullable === true && !types.includes('null')) types.push('null');
    return types;
  }

  private inferredTypes(schema: InputSchema): JsonType[] {
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (alternatives) return unique(alternatives.flatMap((part) => this.typesOf(part)));
    if (schema.properties || schema.additionalProperties !== undefined) return ['object'];
    if (schema.items) return ['array'];
    const values = schema.enum ?? (schema.const === undefined ? undefined : [schema.const]);
    if (values) return unique(values.map(jsonTypeOf));
    return [...jsonTypes];
  }

  private translateBounds(schema: JsonObject, out: InputSchema): void {
    for (const key of ['minimum', 'maximum', 'multipleOf'] as const) {
      if (typeof schema[key] === 'number') out[key] = schema[key] as number;
    }
    if (typeof out.multipleOf === 'number' && out.multipleOf <= 0) delete out.multipleOf;
    for (const [key, bound] of [
      ['exclusiveMinimum', 'minimum'],
      ['exclusiveMaximum', 'maximum'],
    ] as const) {
      const value = schema[key];
      if (typeof value === 'number') out[key] = value;
      else if (value === true && typeof out[bound] === 'number') {
        out[key] = out[bound];
        delete out[bound];
      }
    }
  }
}

const schemaKeyOrder = [
  '$ref',
  'type',
  'title',
  'description',
  'format',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'oneOf',
];

function orderedSchema(schema: InputSchema): InputSchema {
  const keys = Object.keys(schema).toSorted((a, b) => {
    const rank = (key: string) => {
      const index = schemaKeyOrder.indexOf(key);
      return index === -1 ? schemaKeyOrder.length : index;
    };
    return rank(a) - rank(b);
  });
  return Object.fromEntries(keys.map((key) => [key, schema[key as keyof InputSchema]])) as InputSchema;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  const type = typeof value;
  if (type === 'number' || type === 'string' || type === 'boolean') return type;
  return 'object';
}

interface RouteOperation {
  method: OpenApiMethod;
  path: string;
  operation: JsonObject;
  parameters: JsonObject[];
}

function routeOperations(document: JsonObject, translator: SchemaTranslator): RouteOperation[] {
  const routes: RouteOperation[] = [];
  for (const [path, item] of Object.entries(isObject(document.paths) ? document.paths : {})) {
    if (!isObject(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of openApiMethods) {
      const operation = item[method.toLowerCase()];
      if (!isObject(operation)) continue;
      const own = Array.isArray(operation.parameters) ? operation.parameters : [];
      const byKey = new Map<string, JsonObject>();
      for (const raw of [...shared, ...own]) {
        const parameter = translator.dereferenced(raw);
        if (typeof parameter.name === 'string') byKey.set(`${String(parameter.in)}:${parameter.name}`, parameter);
      }
      routes.push({ method, path, operation, parameters: [...byKey.values()] });
    }
  }
  return routes;
}

function described(route: RouteOperation): string {
  return `${route.method} ${route.path}`;
}

function operationNameOf(route: RouteOperation, byExtension: boolean): string | null {
  if (byExtension) {
    const name = route.operation[operationNameExtension];
    return typeof name === 'string' ? name : null;
  }
  if (typeof route.operation.operationId === 'string') return snakeCaseName(route.operation.operationId);
  const literal = route.path
    .split('/')
    .filter((segment) => segment !== '' && !segment.startsWith('{'))
    .join('_');
  return snakeCaseName(`${route.method.toLowerCase()}_${literal}`);
}

function jsonBodySchema(
  operation: JsonObject,
  translator: SchemaTranslator
): { schema?: unknown; required: boolean } | 'not-json' | null {
  const body = translator.dereferenced(operation.requestBody);
  if (!isObject(body.content) || Object.keys(body.content).length === 0) return null;
  const mediaType = Object.keys(body.content).find(
    (type) => type === 'application/json' || /^application\/[^;]+\+json$/.test(type)
  );
  if (mediaType === undefined) return 'not-json';
  const content = body.content[mediaType];
  return { schema: isObject(content) ? content.schema : undefined, required: body.required === true };
}

interface FlatInput {
  input: InputSchema;
  route: OpenApiRoute;
}

function flatInput(
  name: string,
  route: RouteOperation,
  translator: SchemaTranslator,
  problems: string[]
): FlatInput | null {
  const properties: Record<string, InputSchema> = {};
  const required: string[] = [];
  const sources = new Map<string, string>();
  let clash = false;
  const add = (field: string, source: string, schema: InputSchema, isRequired: boolean) => {
    const previous = sources.get(field);
    if (previous !== undefined) {
      problems.push(`${name} (${described(route)}): "${field}" comes from both the ${previous} and the ${source}`);
      clash = true;
      return;
    }
    sources.set(field, source);
    properties[field] = schema;
    if (isRequired) required.push(field);
  };
  const parameterSchema = (parameter: JsonObject): InputSchema => {
    const schema = translator.translate(parameter.schema ?? { type: 'string' });
    if (typeof parameter.description === 'string' && schema.description === undefined && schema.$ref === undefined) {
      return orderedSchema({ ...schema, description: cut(parameter.description, limits.schemaDescription) });
    }
    return schema;
  };

  const pathParams: string[] = [];
  const queryParams: string[] = [];
  for (const parameter of route.parameters) {
    const field = parameter.name as string;
    if (parameter.in === 'path') {
      pathParams.push(field);
      add(field, 'path', parameterSchema(parameter), true);
    } else if (parameter.in === 'query') {
      queryParams.push(field);
      add(field, 'query', parameterSchema(parameter), parameter.required === true);
    }
  }

  let body: OpenApiRoute['body'] = 'none';
  let additionalProperties = false;
  const requestBody = jsonBodySchema(route.operation, translator);
  if (requestBody === 'not-json') {
    problems.push(`${name} (${described(route)}): only application/json request bodies can be called through the Gate`);
    return null;
  }
  if (requestBody) {
    const view = translator.objectView(requestBody.schema);
    const isObjectBody =
      isObject(view.properties) || view.type === 'object' || (Array.isArray(view.type) && view.type.includes('object'));
    if (isObjectBody) {
      body = 'fields';
      const bodyRequired = new Set(
        requestBody.required && Array.isArray(view.required) ? (view.required as string[]) : []
      );
      for (const [field, property] of Object.entries(isObject(view.properties) ? view.properties : {})) {
        add(field, 'body', translator.translate(property), bodyRequired.has(field));
      }
      additionalProperties = view.additionalProperties !== false;
    } else {
      body = 'whole';
      add(wholeBodyField, 'body', translator.translate(requestBody.schema), requestBody.required);
    }
  }
  if (clash) return null;

  const input: InputSchema = { type: 'object', properties };
  if (required.length > 0) input.required = required;
  input.additionalProperties = additionalProperties;
  return { input, route: { method: route.method, path: route.path, pathParams, queryParams, body } };
}

function kindOf(name: string, route: RouteOperation, problems: string[]): OperationKind {
  const declared = route.operation[operationKindExtension];
  if (declared === undefined) return kindOfMethod[route.method];
  if (typeof declared === 'string' && (operationKinds as readonly string[]).includes(declared)) {
    return declared as OperationKind;
  }
  problems.push(`${name} (${described(route)}): ${operationKindExtension} must be one of ${operationKinds.join(', ')}`);
  return kindOfMethod[route.method];
}

function operationText(route: RouteOperation): { title?: string; description: string } {
  const summary = typeof route.operation.summary === 'string' ? route.operation.summary.trim() : '';
  const longText = typeof route.operation.description === 'string' ? firstParagraph(route.operation.description) : '';
  const description = longText || summary || described(route);
  return {
    ...(summary === '' ? {} : { title: cut(summary, limits.title) }),
    description: withinLimit(description, limits.operationDescription),
  };
}

function serviceHeader(document: JsonObject, existing: JsonObject | undefined): JsonObject {
  if (existing) {
    const { operations: _operations, $defs: _defs, ...kept } = existing;
    return kept;
  }
  const info = isObject(document.info) ? document.info : {};
  const displayName = cut(
    typeof info.title === 'string' && info.title.trim() !== '' ? info.title.trim() : 'OpenAPI service',
    limits.title
  );
  const description = typeof info.description === 'string' ? firstSentence(info.description) : '';
  return {
    sdk: 1,
    displayName,
    description: withinLimit(description === '' ? displayName : description, limits.serviceDescription),
  };
}

export function generateFromOpenApi(
  document: unknown,
  options: GenerateFromOpenApiOptions = {}
): GeneratedFromOpenApi | OpenApiGenerationFailure {
  if (!isObject(document) || typeof document.openapi !== 'string' || !isObject(document.paths)) {
    return { ok: false, problems: ['the document is not an OpenAPI 3 document (no openapi version or paths)'] };
  }
  const translator = new SchemaTranslator(document);
  const routes = routeOperations(document, translator);
  const byExtension = routes.some((route) => route.operation[operationNameExtension] !== undefined);
  const problems: string[] = [];
  const operations: Record<string, JsonObject> = {};
  const routeTable: OpenApiRoutes = {};
  const owners = new Map<string, RouteOperation>();

  for (const route of routes) {
    const name = operationNameOf(route, byExtension);
    if (name === null) continue;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      problems.push(`${described(route)}: "${name}" is not a snake_case Operation name`);
      continue;
    }
    const owner = owners.get(name);
    if (owner) {
      problems.push(`"${name}" is the name of both ${described(owner)} and ${described(route)}`);
      continue;
    }
    owners.set(name, route);
    const kind = kindOf(name, route, problems);
    const flat = flatInput(name, route, translator, problems);
    if (!flat) continue;
    operations[name] = { kind, ...operationText(route), input: flat.input };
    routeTable[name] = flat.route;
  }

  if (problems.length > 0) return { ok: false, problems };
  if (Object.keys(operations).length === 0) {
    return { ok: false, problems: ['the document has no operations to generate'] };
  }

  const names = Object.keys(operations).toSorted();
  const defs = [...translator.defs.keys()].toSorted();
  const manifest: JsonObject = {
    ...serviceHeader(document, options.existingManifest),
    operations: Object.fromEntries(names.map((name) => [name, operations[name]])),
    ...(defs.length === 0 ? {} : { $defs: Object.fromEntries(defs.map((name) => [name, translator.defs.get(name)])) }),
  };
  return {
    ok: true,
    manifest,
    routes: Object.fromEntries(names.map((name) => [name, routeTable[name] as OpenApiRoute])),
  };
}
