import { describe, expect, it } from 'vitest';
import { appAuthRouteRules, type AppAuthRouteTarget } from '../../src/project/app-auth-route';
import { traefikRuleMatches } from '../support/traefik-routing';

const APPS = 'apps.example.com';
const ENV: AppAuthRouteTarget = {
  id: '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f',
  shortId: '3f2a9c1e7b4d',
};
const OTHER: AppAuthRouteTarget = {
  id: '9d8c7b6a-1111-4e8a-9c2f-1a2b3c4d5e6f',
  shortId: '9d8c7b6a1111',
};

function protects(host: string, env = ENV): boolean {
  return appAuthRouteRules(env, APPS).some((rule) => traefikRuleMatches(rule, host));
}

function environmentRoutedTo(host: string, envs: AppAuthRouteTarget[]): string | undefined {
  const matching = envs.flatMap((env) =>
    appAuthRouteRules(env, APPS)
      .filter((rule) => traefikRuleMatches(rule, host))
      .map((rule) => ({ id: env.id, priority: rule.priority }))
  );
  return matching.toSorted((a, b) => b.priority - a.priority)[0]?.id;
}

describe('App Auth route rules', () => {
  it('leave a label that only starts with the environment id alone', () => {
    expect(protects('3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6fx.apps.example.com')).toBe(false);
  });

  it("leave another App's addresses alone", () => {
    expect(protects('ledger-dev-9d8c7b6a1111.apps.example.com')).toBe(false);
    expect(protects('9d8c7b6a-1111-4e8a-9c2f-1a2b3c4d5e6f-dev.apps.example.com')).toBe(false);
  });

  it('send a legacy address to its own App when its Environment Slug is another App Short ID', () => {
    const legacyHost = `${ENV.id}-${OTHER.shortId}.apps.example.com`;

    expect(protects(legacyHost, OTHER)).toBe(true);
    expect(environmentRoutedTo(legacyHost, [OTHER, ENV])).toBe(ENV.id);
    expect(environmentRoutedTo(legacyHost, [ENV, OTHER])).toBe(ENV.id);
  });

  it('tell apart two Apps whose Short IDs share the first 12 characters', () => {
    const longer = { id: '3f2a9c1e-7b4d-5e8a-9c2f-1a2b3c4d5e6f', shortId: '3f2a9c1e7b4d5e' };
    expect(protects('ledger-dev-3f2a9c1e7b4d5e.apps.example.com')).toBe(false);
    expect(protects('ledger-dev-3f2a9c1e7b4d.apps.example.com', longer)).toBe(false);
    expect(protects('ledger-dev-3f2a9c1e7b4d5e.apps.example.com', longer)).toBe(true);
  });

  it('leave a label that merely contains the Short ID alone', () => {
    expect(protects('ledger-3f2a9c1e7b4d-dev.apps.example.com')).toBe(false);
    expect(protects('ledger3f2a9c1e7b4d.apps.example.com')).toBe(false);
    expect(protects('3f2a9c1e7b4d.apps.example.com')).toBe(false);
  });

  it('leave hosts under another domain alone', () => {
    expect(protects('ledger-dev-3f2a9c1e7b4d.apps.example.com.evil.test')).toBe(false);
    expect(protects('ledger-dev-3f2a9c1e7b4d.appsxexample.com')).toBe(false);
    expect(protects('ledger-dev-3f2a9c1e7b4d.other.example.com')).toBe(false);
    expect(protects('a.ledger-dev-3f2a9c1e7b4d.apps.example.com')).toBe(false);
  });
});
