import type { CallerIdentity } from './caller-identity.ts';
import { allowAll, type Configurations, type DefinedService, type Upstream } from './define-service.ts';
import { valueFieldsOf, withSecrets } from './form-levels.ts';
import type { RequestConfiguration } from './service-pipeline.ts';
import { sdkPackageVersion } from './package-version.ts';
import { upstreamAddress } from './upstream-forwarding.ts';

export const wellKnownPath = '/.well-known/opsiforce';

export interface DescribedUpstream {
  name: string;
  api: string;
  url?: string;
  mount?: string;
}

export interface DescribedRoute {
  route: string;
  action: 'proxy' | 'handle' | 'refuse';
  upstream?: string;
  summary: string;
  allowedBy: string[];
  allowAll?: true;
}

export interface ServiceDescription {
  sdk: string;
  manifestHash: string;
  settingsLink?: string;
  configuration?: Record<string, { label: string; value: unknown }>;
  upstreams: DescribedUpstream[];
  routes: DescribedRoute[];
}

function describedUrl(upstream: Upstream<never>, configurations: Configurations<never>): string | undefined {
  try {
    const { origin, basePath } = upstreamAddress(upstream, configurations);
    return `${origin}${basePath}`;
  } catch {
    return undefined;
  }
}

export function describeService(
  defined: DefinedService,
  caller: CallerIdentity,
  configuration: RequestConfiguration | undefined
): ServiceDescription {
  const { manifest, definition } = defined;
  const configurations = {
    serviceConfiguration: withSecrets(manifest.serviceForm, configuration?.serviceConfiguration ?? {}),
    projectConfiguration:
      configuration === undefined || configuration.projectConfiguration === null
        ? null
        : withSecrets(manifest.projectForm, configuration.projectConfiguration),
  } as Configurations<never>;

  const upstreams = new Map<string, DescribedUpstream>();
  for (const entry of definition.routes) {
    const target = entry.to as Upstream<never> | undefined;
    if (!target || upstreams.has(target.name)) continue;
    const url =
      typeof target.url === 'function' && configuration === undefined
        ? undefined
        : describedUrl(target, configurations);
    upstreams.set(target.name, {
      name: target.name,
      api: target.api,
      ...(url === undefined ? {} : { url }),
      ...(target.mount === undefined ? {} : { mount: target.mount }),
    });
  }

  const routes = definition.routes.map(
    (entry): DescribedRoute => ({
      route: entry.pattern.source,
      action: entry.action,
      ...(entry.to ? { upstream: entry.to.name } : {}),
      summary: entry.summary,
      allowedBy: [...entry.allowedBy],
      ...(entry.action !== 'refuse' && entry.check === allowAll ? { allowAll: true as const } : {}),
    })
  );

  const namesProjectEnvironment = caller.projectEnvironmentId !== undefined;
  const projectConfiguration = configurations.projectConfiguration as Record<string, unknown> | null;
  const described =
    namesProjectEnvironment && projectConfiguration !== null
      ? Object.fromEntries(
          valueFieldsOf(manifest.projectForm ?? [])
            .filter((field) => projectConfiguration[field.key] !== undefined)
            .map((field) => [
              field.key,
              {
                label: field.label ?? field.key,
                value: JSON.parse(JSON.stringify(projectConfiguration[field.key])) as unknown,
              },
            ])
        )
      : undefined;

  return {
    sdk: sdkPackageVersion,
    manifestHash: defined.manifestHash,
    ...(namesProjectEnvironment && configuration?.settingsLink !== undefined
      ? { settingsLink: configuration.settingsLink }
      : {}),
    ...(described === undefined ? {} : { configuration: described }),
    upstreams: [...upstreams.values()],
    routes,
  };
}
