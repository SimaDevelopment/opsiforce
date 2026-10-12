export const openApiMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type OpenApiMethod = (typeof openApiMethods)[number];

export type OpenApiRouteBody = 'none' | 'fields' | 'whole';

export const wholeBodyField = 'body';

export interface OpenApiRoute {
  method: OpenApiMethod;
  path: string;
  pathParams: string[];
  queryParams: string[];
  body: OpenApiRouteBody;
}

export type OpenApiRoutes = Record<string, OpenApiRoute>;

export interface OpenApiRouteRequest {
  method: OpenApiMethod;
  path: string;
  body: unknown;
}

function queryValue(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function openApiRouteRequest(route: OpenApiRoute, input: Record<string, unknown>): OpenApiRouteRequest {
  const path = route.path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(String(input[name] ?? ''))
  );
  const query = new URLSearchParams();
  for (const name of route.queryParams) {
    const value = input[name];
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(name, queryValue(item));
  }
  const search = query.toString();
  const taken = new Set([...route.pathParams, ...route.queryParams]);
  const body =
    route.body === 'none'
      ? undefined
      : route.body === 'whole'
        ? input[wholeBodyField]
        : Object.fromEntries(Object.entries(input).filter(([name]) => !taken.has(name)));
  return { method: route.method, path: search === '' ? path : `${path}?${search}`, body };
}
