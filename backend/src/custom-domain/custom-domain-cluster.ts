import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { customDomains } from '../../db/schema';
import {
  CERT_MANAGER_CERTIFICATES,
  KubeObjectWriter,
  TRAEFIK_INGRESS_ROUTES,
  TRAEFIK_MIDDLEWARES,
  type KubeLabels,
  type KubeObjectKind,
} from '../common/kube-object-writer';
import type { DbExecutor } from '../common/locks';
import type { Transaction } from '../external-services/configuration/transaction';
import { appAuthMiddlewareName } from '../project/app-auth-route';
import { withEnvironmentAuthLock, type LockedEnvironmentAuth } from '../project/environment-auth-lock';
import { signInOnEachHost } from '../project/project-auth.service';
import {
  certificateProgress,
  customDomainCertificate,
  customDomainIngressRoute,
  customDomainLabels,
  customDomainObjectName,
  customDomainSecretName,
  customDomainSignInMiddleware,
  customDomainSignInName,
  hostsOf,
  redirectTargetOf,
  redirectToMainMiddleware,
  redirectToMainName,
  redirectWithoutWwwMiddleware,
  redirectWithoutWwwName,
  unprotectedMarkerMiddleware,
  type CertificateProgress,
  type DomainCluster,
  type DomainHosts,
  type RoutedDomain,
  type RoutedEnvironment,
} from './custom-domain-objects';
import { ROUTED_DOMAIN_STATUSES } from './main-domain';

type DomainOfEnvironment = DomainHosts & { projectEnvironmentId: string };

interface RoutingObject {
  metadata: { name: string; labels?: KubeLabels };
  spec: object;
}

@Injectable()
export class CustomDomainCluster {
  private readonly kube: KubeObjectWriter;
  private readonly cluster: DomainCluster;
  private readonly issuer: string;

  constructor(config: ConfigService) {
    const namespace = config.getOrThrow<string>('k8sNamespace');
    this.kube = new KubeObjectWriter(namespace);
    this.cluster = {
      namespace,
      webappServiceName: config.getOrThrow<string>('webappServiceName'),
      webappServicePort: config.getOrThrow<number>('webappServicePort'),
    };
    this.issuer = config.get<string>('customDomainsClusterIssuer', '');
  }

  async orderCertificate(domain: DomainOfEnvironment): Promise<void> {
    const certificate = customDomainCertificate(domain, domain.projectEnvironmentId, {
      namespace: this.cluster.namespace,
      issuer: this.issuer,
    });
    await this.kube.deleteIfExists(CERT_MANAGER_CERTIFICATES, certificate.metadata.name);
    await this.kube.upsert(CERT_MANAGER_CERTIFICATES, certificate.metadata.name, certificate);
  }

  private async keepCertificate(domain: DomainHosts, environmentId: string): Promise<void> {
    const name = customDomainObjectName(domain.id);
    if (await this.kube.find(CERT_MANAGER_CERTIFICATES, name)) return;
    const certificate = customDomainCertificate(domain, environmentId, {
      namespace: this.cluster.namespace,
      issuer: this.issuer,
    });
    await this.kube.upsert(CERT_MANAGER_CERTIFICATES, name, certificate);
  }

  async certificateProgress(domainId: string): Promise<CertificateProgress> {
    return certificateProgress(await this.kube.find(CERT_MANAGER_CERTIFICATES, customDomainObjectName(domainId)));
  }

  async route(env: RoutedEnvironment, domains: RoutedDomain[]): Promise<void> {
    const mainDomain = domains.find((domain) => domain.isMain)?.hostname ?? null;
    const sentToMain = domains.some((domain) =>
      hostsOf(domain).some((host) => mainDomain !== null && redirectTargetOf(host, domain, mainDomain) === mainDomain)
    );
    if (domains.length > 0) await this.write(TRAEFIK_MIDDLEWARES, unprotectedMarkerMiddleware(this.cluster.namespace));
    await this.redirectToMain(env.id, sentToMain ? mainDomain : null);
    await this.redirectWithoutWww(
      env.id,
      domains.some((domain) => domain.bare)
    );
    const signIn =
      env.authMode === 'provider' && domains.length > 0 ? await this.signInOnTheDomains(env.id) : undefined;
    if (signIn) await this.write(TRAEFIK_MIDDLEWARES, signIn);
    for (const domain of domains) {
      await this.keepCertificate(domain, env.id);
      await this.write(TRAEFIK_INGRESS_ROUTES, customDomainIngressRoute(domain, { ...env, mainDomain }, this.cluster));
    }
    if (!signIn) await this.kube.deleteIfExists(TRAEFIK_MIDDLEWARES, customDomainSignInName(env.id));
  }

  async routeWithin(executor: DbExecutor, environmentId: string, auth: LockedEnvironmentAuth | undefined) {
    if (!auth) return;
    await this.route(
      { id: environmentId, authMode: auth.authMode },
      await this.routedDomainsOf(environmentId, executor)
    );
  }

  async routeEnvironment(environmentId: string): Promise<void> {
    await withEnvironmentAuthLock(environmentId, (tx, auth) => this.routeWithin(tx, environmentId, auth));
  }

  async followAppAuth(env: RoutedEnvironment): Promise<void> {
    const domains = await this.routedDomainsOf(env.id);
    if (domains.length > 0) await this.route(env, domains);
  }

  routedDomainsOf(environmentId: string, executor: DbExecutor = db): Promise<RoutedDomain[]> {
    return executor
      .select({
        id: customDomains.id,
        hostname: customDomains.hostname,
        bare: customDomains.bare,
        isMain: customDomains.isMain,
        redirectsToMain: customDomains.redirectsToMain,
      })
      .from(customDomains)
      .where(
        and(
          eq(customDomains.projectEnvironmentId, environmentId),
          inArray(customDomains.status, ROUTED_DOMAIN_STATUSES)
        )
      )
      .orderBy(asc(customDomains.createdAt), asc(customDomains.id));
  }

  async routedEnvironmentIds(): Promise<string[]> {
    const routed = await db
      .selectDistinct({ id: customDomains.projectEnvironmentId })
      .from(customDomains)
      .where(inArray(customDomains.status, ROUTED_DOMAIN_STATUSES));
    return routed.map(({ id }) => id);
  }

  private async redirectToMain(environmentId: string, mainHostname: string | null): Promise<void> {
    if (mainHostname === null) {
      await this.kube.deleteIfExists(TRAEFIK_MIDDLEWARES, redirectToMainName(environmentId));
      return;
    }
    await this.write(
      TRAEFIK_MIDDLEWARES,
      redirectToMainMiddleware(environmentId, mainHostname, this.cluster.namespace)
    );
  }

  private async redirectWithoutWww(environmentId: string, needed: boolean): Promise<void> {
    if (!needed) {
      await this.kube.deleteIfExists(TRAEFIK_MIDDLEWARES, redirectWithoutWwwName(environmentId));
      return;
    }
    await this.write(TRAEFIK_MIDDLEWARES, redirectWithoutWwwMiddleware(environmentId, this.cluster.namespace));
  }

  private async write(kind: KubeObjectKind, object: RoutingObject): Promise<void> {
    const current = (await this.kube.find(kind, object.metadata.name)) as RoutingObject | undefined;
    const unchanged =
      current &&
      isDeepStrictEqual(current.spec, object.spec) &&
      isDeepStrictEqual(current.metadata.labels, object.metadata.labels);
    if (!unchanged) await this.kube.upsert(kind, object.metadata.name, object);
  }

  private async signInOnTheDomains(environmentId: string) {
    const spec = signInOnEachHost(await this.kube.find(TRAEFIK_MIDDLEWARES, appAuthMiddlewareName(environmentId)));
    return spec && customDomainSignInMiddleware(environmentId, this.cluster.namespace, spec);
  }

  async remove(domainId: string): Promise<void> {
    await this.kube.deleteByLabels(TRAEFIK_INGRESS_ROUTES, customDomainLabels(domainId));
    await this.kube.deleteByLabels(CERT_MANAGER_CERTIFICATES, customDomainLabels(domainId));
    await this.kube.deleteSecretIfExists(customDomainSecretName(domainId));
  }

  async removeEnvironment(environmentId: string, thenWithin?: (tx: Transaction) => Promise<void>): Promise<void> {
    await withEnvironmentAuthLock(environmentId, async (tx) => {
      const domains = await tx
        .delete(customDomains)
        .where(eq(customDomains.projectEnvironmentId, environmentId))
        .returning({ id: customDomains.id });
      for (const { id } of domains) await this.remove(id);
      await this.redirectToMain(environmentId, null);
      await this.redirectWithoutWww(environmentId, false);
      await this.kube.deleteIfExists(TRAEFIK_MIDDLEWARES, customDomainSignInName(environmentId));
      await thenWithin?.(tx);
    });
  }
}
