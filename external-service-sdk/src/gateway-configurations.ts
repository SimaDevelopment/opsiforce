import { callerIdentityHeader, type CallerIdentity } from './caller-identity.ts';
import type { ProjectConfigurationEntry } from './define-service.ts';
import type { FormValues } from './form-levels.ts';
import type { ConfigurationSource, RequestConfiguration } from './service-pipeline.ts';

export const configurationCacheLifeMs = 5_000;

export const configurationPath = '/configuration';

export const projectConfigurationsPath = '/configuration/projects';

export interface GatewayConfigurationsOptions {
  url: string;
  gatewayKey: string;
  now?: () => number;
  fetch?: typeof fetch;
}

interface Cached<T> {
  fetchedAt: number;
  value: Promise<T>;
}

const serviceEntry = '';

export function gatewayConfigurations(options: GatewayConfigurationsOptions): ConfigurationSource {
  const now = options.now ?? Date.now;
  const send = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');
  const configurations = new Map<string, Cached<RequestConfiguration>>();
  let projectConfigurations: Cached<ProjectConfigurationEntry[]> | null = null;

  const fresh = <T>(cached: Cached<T> | null | undefined): cached is Cached<T> =>
    cached !== undefined && cached !== null && now() - cached.fetchedAt < configurationCacheLifeMs;

  const ask = async <T>(path: string, callerIdentity?: string): Promise<T> => {
    const headers: Record<string, string> = { authorization: `Bearer ${options.gatewayKey}` };
    if (callerIdentity !== undefined) headers[callerIdentityHeader] = callerIdentity;
    const answer = await send(`${base}${path}`, { headers });
    if (!answer.ok) {
      const text = await answer.text().catch(() => '');
      throw new Error(
        `the configuration fetch answered ${answer.status}${text === '' ? '' : `: ${text.slice(0, 300)}`}`
      );
    }
    return (await answer.json()) as T;
  };

  const remembered = <T>(
    read: () => Cached<T> | null | undefined,
    keep: (entry: Cached<T> | null) => void,
    fetchNow: () => Promise<T>
  ) => {
    const cached = read();
    if (fresh(cached)) return cached.value;
    const entry: Cached<T> = { fetchedAt: now(), value: fetchNow() };
    keep(entry);
    entry.value.catch(() => {
      if (read() === entry) keep(null);
    });
    return entry.value;
  };

  const configurationFor = (key: string, callerIdentity?: string) =>
    remembered(
      () => configurations.get(key),
      (entry) => (entry === null ? configurations.delete(key) : configurations.set(key, entry)),
      () => ask<RequestConfiguration>(configurationPath, callerIdentity)
    );

  return {
    forCaller(caller: CallerIdentity, callerIdentity: string) {
      if (caller.projectEnvironmentId === undefined) return configurationFor(serviceEntry);
      return configurationFor(caller.projectEnvironmentId, callerIdentity);
    },
    async service(): Promise<FormValues> {
      return (await configurationFor(serviceEntry)).serviceConfiguration;
    },
    forget(caller: CallerIdentity) {
      if (caller.projectEnvironmentId === undefined) configurations.clear();
      else {
        configurations.delete(caller.projectEnvironmentId);
        configurations.delete(serviceEntry);
      }
      projectConfigurations = null;
    },
    projectConfigurations() {
      return remembered(
        () => projectConfigurations,
        (entry) => {
          projectConfigurations = entry;
        },
        async () =>
          (await ask<{ projectConfigurations: ProjectConfigurationEntry[] }>(projectConfigurationsPath))
            .projectConfigurations
      );
    },
  };
}
