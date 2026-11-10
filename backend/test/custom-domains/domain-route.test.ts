import { describe, expect, it } from 'vitest';
import {
  customDomainIngressRoute,
  redirectToMainMiddleware,
  redirectWithoutWwwMiddleware,
  type RoutedDomain,
} from '../../src/custom-domain/custom-domain-objects';
import type { ProjectAuthMode } from '../../src/project/project.types';
import { traefikRedirect, traefikRuleMatches } from '../support/traefik-routing';

const ENV_ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const DOMAIN_ID = '9b1d2c3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const CLUSTER = { namespace: 'opsiforce', webappServiceName: 'proxy-app', webappServicePort: 3002 };
const GATE = { name: `opsiforce-project-${ENV_ID}-oidc`, namespace: 'opsiforce' };
const SIGN_IN_ON_THE_DOMAIN = { name: `opsiforce-project-${ENV_ID}-oidc-domains`, namespace: 'opsiforce' };
const STRIP = { name: 'opsiforce-strip-identity-headers', namespace: 'opsiforce' };
const MARKER = { name: 'opsiforce-custom-domain-unprotected', namespace: 'opsiforce' };
const REDIRECT = { name: `opsiforce-project-${ENV_ID}-to-main`, namespace: 'opsiforce' };
const WITHOUT_WWW = { name: `opsiforce-project-${ENV_ID}-without-www`, namespace: 'opsiforce' };

const SUBDOMAIN: RoutedDomain = {
  id: DOMAIN_ID,
  hostname: 'shop.example-org.com',
  bare: false,
  isMain: false,
  redirectsToMain: false,
};
const BARE: RoutedDomain = { ...SUBDOMAIN, hostname: 'example-org.com', bare: true };
const REDIRECTED_SUBDOMAIN: RoutedDomain = { ...SUBDOMAIN, redirectsToMain: true };
const REDIRECTED_BARE: RoutedDomain = { ...BARE, redirectsToMain: true };
const ANOTHER_MAIN_DOMAIN = 'store.example-org.net';
const NO_MAIN_DOMAIN = null;

type Domain = RoutedDomain;
type Route = { match: string; middlewares: unknown[]; services: unknown[] };

function routesOf(domain: Domain, authMode: ProjectAuthMode, mainDomain: string | null = domain.hostname): Route[] {
  return customDomainIngressRoute(domain, { id: ENV_ID, authMode, mainDomain }, CLUSTER).spec.routes as Route[];
}

function matches(route: Route, host: string): boolean {
  return traefikRuleMatches({ match: route.match, priority: 0 }, host);
}

function middlewaresByHost(domain: Domain, authMode: ProjectAuthMode, mainDomain: string | null = domain.hostname) {
  const routes = routesOf(domain, authMode, mainDomain);
  const hosts = domain.bare ? [domain.hostname, `www.${domain.hostname}`] : [domain.hostname];
  return Object.fromEntries(hosts.map((host) => [host, routes.find((route) => matches(route, host))?.middlewares]));
}

describe('the route of a Custom domain', () => {
  describe.each([
    ['public', [MARKER]],
    ['manual', [STRIP, GATE]],
    ['provider', [STRIP, SIGN_IN_ON_THE_DOMAIN]],
    ['app_users', [STRIP, GATE]],
  ] as const)('for %s App Auth', (authMode, signIn) => {
    it('lets the Main domain reach the App through its sign-in or the marker', () => {
      expect(middlewaresByHost(SUBDOMAIN, authMode)).toEqual({ 'shop.example-org.com': signIn });
    });

    it('sends the www of a bare Main domain on to the bare domain, its apex reaching the App', () => {
      expect(middlewaresByHost(BARE, authMode)).toEqual({
        'example-org.com': signIn,
        'www.example-org.com': [WITHOUT_WWW],
      });
    });

    it('lets another domain reach the App on its own host by default', () => {
      expect(middlewaresByHost(SUBDOMAIN, authMode, ANOTHER_MAIN_DOMAIN)).toEqual({
        'shop.example-org.com': signIn,
      });
      expect(middlewaresByHost(BARE, authMode, ANOTHER_MAIN_DOMAIN)).toEqual({
        'example-org.com': signIn,
        'www.example-org.com': [WITHOUT_WWW],
      });
    });

    it('sends another domain set to redirect on to the Main domain, its www through the bare domain', () => {
      expect(middlewaresByHost(REDIRECTED_SUBDOMAIN, authMode, ANOTHER_MAIN_DOMAIN)).toEqual({
        'shop.example-org.com': [REDIRECT],
      });
      expect(middlewaresByHost(REDIRECTED_BARE, authMode, ANOTHER_MAIN_DOMAIN)).toEqual({
        'example-org.com': [REDIRECT],
        'www.example-org.com': [WITHOUT_WWW],
      });
    });

    it('ignores the redirect on the Main domain itself and while the App has no Main domain', () => {
      expect(middlewaresByHost(REDIRECTED_SUBDOMAIN, authMode)).toEqual({ 'shop.example-org.com': signIn });
      expect(middlewaresByHost(REDIRECTED_SUBDOMAIN, authMode, NO_MAIN_DOMAIN)).toEqual({
        'shop.example-org.com': signIn,
      });
      expect(middlewaresByHost(BARE, authMode, NO_MAIN_DOMAIN)).toEqual({
        'example-org.com': signIn,
        'www.example-org.com': [WITHOUT_WWW],
      });
    });
  });

  it("sends every host to the App proxy's Service", () => {
    for (const route of [...routesOf(BARE, 'manual'), ...routesOf(BARE, 'public', ANOTHER_MAIN_DOMAIN)]) {
      expect(route.services).toEqual([{ name: 'proxy-app', namespace: 'opsiforce', port: 3002 }]);
    }
  });

  it("sets no priority on any rule, so cert-manager's longer HTTP-01 solver rule for the same host wins at issuance and every renewal", () => {
    const everyRoute = [SUBDOMAIN, BARE].flatMap((domain) =>
      (['public', 'manual', 'provider', 'app_users'] as const).flatMap((authMode) =>
        [domain.hostname, ANOTHER_MAIN_DOMAIN, NO_MAIN_DOMAIN].flatMap((mainDomain) =>
          routesOf(domain, authMode, mainDomain)
        )
      )
    );

    expect(everyRoute.filter((route) => 'priority' in route)).toEqual([]);
  });

  it('matches a subdomain and nothing else', () => {
    const routes = routesOf(SUBDOMAIN, 'public');
    const answering = (host: string) => routes.some((route) => matches(route, host));

    expect(answering('shop.example-org.com')).toBe(true);
    expect(answering('SHOP.Example-Org.com:443')).toBe(true);
    for (const host of [
      'example-org.com',
      'www.shop.example-org.com',
      'a.shop.example-org.com',
      'shopxexample-org.com',
      'shop.example-org.com.evil.test',
      'shop.example-org.co',
      `${ENV_ID}.apps.opsiforce.localtest.me`,
    ]) {
      expect(answering(host), host).toBe(false);
    }
  });

  it('matches a bare domain and its www, one route each, and nothing else', () => {
    const routes = routesOf(BARE, 'manual');

    expect(
      routes.map((route) => ['example-org.com', 'www.example-org.com'].filter((host) => matches(route, host)))
    ).toEqual([['example-org.com'], ['www.example-org.com']]);
    for (const host of ['shop.example-org.com', 'wwwexample-org.com', 'www.www.example-org.com', 'example-org.co']) {
      expect(
        routes.some((route) => matches(route, host)),
        host
      ).toBe(false);
    }
  });

  it("names its certificate's Secret and is labelled with its domain and environment", () => {
    const route = customDomainIngressRoute(
      SUBDOMAIN,
      { id: ENV_ID, authMode: 'public', mainDomain: NO_MAIN_DOMAIN },
      CLUSTER
    );

    expect(route).toMatchObject({
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: {
        name: `opsiforce-domain-${DOMAIN_ID}`,
        namespace: 'opsiforce',
        labels: { 'opsiforce.io/custom-domain': DOMAIN_ID, 'opsiforce.io/environment': ENV_ID },
      },
      spec: { entryPoints: ['websecure'], tls: { secretName: `opsiforce-domain-${DOMAIN_ID}-tls` } },
    });
  });
});

describe("the environment's redirect to its Main domain", () => {
  const middleware = redirectToMainMiddleware(ENV_ID, 'shop.example-org.com', 'opsiforce');

  it('is the Middleware the routes of other domains name, labelled with its environment', () => {
    expect(middleware).toMatchObject({
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: { ...REDIRECT, labels: { 'opsiforce.io/environment': ENV_ID } },
    });
  });

  it('is temporary, so no browser keeps a destination that Make main or the redirect switch can turn around', () => {
    expect(middleware.spec.redirectRegex.permanent).toBe(false);
  });

  it.each([
    ['https://www.example-org.com/orders/7?tab=items&page=2', 'https://shop.example-org.com/orders/7?tab=items&page=2'],
    ['https://legacy.example-org.com:443/', 'https://shop.example-org.com/'],
    ['http://legacy.example-org.com/a/b/', 'https://shop.example-org.com/a/b/'],
  ])('sends %s to %s, keeping the path and query', (from, to) => {
    expect(traefikRedirect(middleware.spec.redirectRegex, from)).toBe(to);
  });
});

describe("the environment's redirect from www to its bare domain", () => {
  const middleware = redirectWithoutWwwMiddleware(ENV_ID, 'opsiforce');

  it('is the Middleware the www of every bare domain names, labelled with its environment', () => {
    expect(middleware).toMatchObject({
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: { ...WITHOUT_WWW, labels: { 'opsiforce.io/environment': ENV_ID } },
      spec: { redirectRegex: { permanent: true } },
    });
  });

  it.each([
    ['https://www.example-org.com/orders/7?tab=items&page=2', 'https://example-org.com/orders/7?tab=items&page=2'],
    ['https://www.example-org.com:443/', 'https://example-org.com/'],
    ['http://www.example-org.co.uk/a/b/', 'https://example-org.co.uk/a/b/'],
  ])('sends %s to %s, keeping the path and query', (from, to) => {
    expect(traefikRedirect(middleware.spec.redirectRegex, from)).toBe(to);
  });
});
