import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServiceManifest } from '@opsiforce/external-service-sdk';
import { valueFieldsOf, type ValueField } from '@opsiforce/external-service-sdk/platform';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { EnvironmentService } from '../../environment/environment.service';
import { PublishService } from '../../publish/publish.service';
import type { PublishJobResponse } from '../../publish/publish.types';
import {
  callersOwner,
  isListItem,
  isPlainValues,
  StoredSecret,
  type ConfigurationValues,
} from '../configuration/configuration-values';
import { defaultsMissingFrom, type WrittenDefault } from '../configuration/published-defaults';
import { InvalidConfigurationError, type ConfigurationIssue } from '../configuration/invalid-configuration.error';
import { ServiceConfigurationSaveHooks } from '../configuration/service-configuration-save-hooks';
import { ServiceConfigurationStore, type ServiceConfigurationSave } from '../configuration/service-configuration.store';
import { CustomServiceRefusal } from '../custom/custom-service-refusal';
import { CustomServiceRepository, type CustomServiceRow } from '../custom/custom-service.repository';
import { servableOrNone } from '../registry/custom-service-catalog';
import { BUILT_ON_SDK_1, isBuiltOnSdk1, PACKAGE_FILE, vendoredSdkVersion } from '../registry/published-service-files';
import { readConfinedServiceFolder, readFileInFolder } from '../registry/service-folder-files';
import { ServiceDefaultEnvironments } from './service-default-environments';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { checkReportOf, type CheckReport } from './check-report';
import { ConfigurationImpacts, type ConfigurationImpact } from './configuration-impacts';
import { manifestDiff, type ManifestDiff } from './manifest-diff';
import { manifestIn, serviceAppFolder, serviceInstancesOf, type ServiceInstance } from './service-instances';
import { PublishProbes } from './publish-probes';
import { formChanges, type FormChanges } from './form-diff';
import { PublishChangesReader, testWarningsOf, type FolderDiff, type TestWarning } from './publish-changes';
import { ServiceTestReports, type TestReportView } from './test-reports';

export interface ServiceEnvironmentView {
  environmentId: string;
  name: string;
  slug: string;
  projectEnvironmentId: string | null;
  published: boolean;
  serviceDefault: boolean;
  deployedCommitSha: string | null;
}

export interface ServiceConfigurationReview {
  fields: ValueField[];
  missing: string[];
  fromDevelopment: string[];
  newDefaults: WrittenDefault[];
}

export interface NamedEnvironment {
  environmentId: string;
  name: string;
}

export interface PublishReview {
  target: NamedEnvironment & { firstPublish: boolean; becomesDefault: boolean };
  current: NamedEnvironment | null;
  check: CheckReport;
  changes: ManifestDiff | null;
  impact: ConfigurationImpact | null;
  testReport: TestReportView;
  serviceConfiguration: ServiceConfigurationReview | null;
  builtOnSdk1: boolean;
  testWarnings: TestWarning[];
  publishNote: string | null;
  formChanges: FormChanges | null;
  codeDiff: FolderDiff;
  skillDiff: FolderDiff;
}

export interface DefaultEnvironmentReview extends Omit<
  PublishReview,
  | 'target'
  | 'testReport'
  | 'changes'
  | 'builtOnSdk1'
  | 'testWarnings'
  | 'publishNote'
  | 'formChanges'
  | 'codeDiff'
  | 'skillDiff'
> {
  target: NamedEnvironment;
}

interface ReviewedVersion {
  next: RegisteredService;
  development: RegisteredService | null;
}

interface ReviewInputs {
  files: CheckedFiles;
  version: () => Promise<ReviewedVersion | null>;
  withImpact: boolean;
}

export interface ServiceSubmission {
  environmentId?: unknown;
  values?: unknown;
  copyFromDevelopment?: unknown;
}

interface CheckedFiles {
  builtOnSdk1: boolean;
  check: CheckReport;
  manifest: ServiceManifest | null;
  manifestHash: string | null;
}

function withoutStoredSecrets(values: ConfigurationValues): ConfigurationValues {
  const kept: ConfigurationValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value instanceof StoredSecret) continue;
    kept[key] = Array.isArray(value)
      ? value.map((item) => (isListItem(item) ? { ...withoutStoredSecrets(item), id: item.id } : item))
      : value;
  }
  return kept;
}

function asCallers(service: RegisteredService): RegisteredService {
  return service.home ? { ...service, home: { ...service.home, lane: 'default' } } : service;
}

function firstError(check: CheckReport): string {
  const error = check.problems.find((problem) => problem.severity === 'error');
  return error ? `${error.path}: ${error.message}` : 'service.json does not pass check';
}

@Injectable()
export class ServicePublishing {
  private readonly storageMountPath: string;

  constructor(
    config: ConfigService,
    private readonly repository: CustomServiceRepository,
    private readonly registry: ServiceRegistry,
    private readonly environments: EnvironmentService,
    private readonly store: ServiceConfigurationStore,
    private readonly saveHooks: ServiceConfigurationSaveHooks,
    private readonly impacts: ConfigurationImpacts,
    private readonly testReports: ServiceTestReports,
    private readonly defaults: ServiceDefaultEnvironments,
    private readonly publisher: PublishService,
    private readonly probes: PublishProbes,
    private readonly changes: PublishChangesReader
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async environmentsOf(tenantId: string, id: string): Promise<ServiceEnvironmentView[]> {
    const service = await this.requireService(tenantId, id);
    const [registry, instances] = await Promise.all([
      this.environments.listForTenant(tenantId),
      serviceInstancesOf(service.builderChatId),
    ]);
    return registry
      .filter((environment) => !environment.isDefault)
      .map((environment) => {
        const instance = instances.find((candidate) => candidate.environmentId === environment.id);
        return {
          environmentId: environment.id,
          name: environment.name,
          slug: environment.slug,
          projectEnvironmentId: instance?.id ?? null,
          published: instance?.deployedCommitSha != null,
          serviceDefault: service.defaultEnvironmentId === environment.id,
          deployedCommitSha: instance?.deployedCommitSha ?? null,
        };
      });
  }

  async publishReview(tenantId: string, id: string, environmentId: unknown): Promise<PublishReview> {
    const service = await this.requireService(tenantId, id);
    const target = await this.requireTarget(tenantId, environmentId);
    const development = await this.developmentInstance(service.builderChatId);
    const files = await this.checkedFiles(development.directory);
    const instance = (await serviceInstancesOf(service.builderChatId)).find(
      (candidate) => candidate.environmentId === target.environmentId && !candidate.isDefault
    );
    const becomesDefault =
      service.defaultEnvironmentId === null || service.defaultEnvironmentId === target.environmentId;
    const published = instance?.deployedCommitSha ? await manifestIn(this.storageMountPath, instance.directory) : null;
    const testReport = await this.testReports.of({ manifestHash: files.manifestHash }, development.directory);
    return {
      target: { ...target, firstPublish: !instance?.deployedCommitSha, becomesDefault },
      changes: files.manifest ? manifestDiff(published, files.manifest) : null,
      builtOnSdk1: files.builtOnSdk1,
      formChanges: files.manifest ? formChanges(published, files.manifest) : null,
      testWarnings: testWarningsOf(testReport),
      ...(await this.changes.of(development.directory, await this.defaultCommitOf(service))),
      ...(await this.reviewOf(tenantId, service, {
        files,
        version: async () => {
          const next = await this.developmentOf(service);
          return next && { next: asCallers(next), development: next };
        },
        withImpact: becomesDefault,
      })),
      testReport,
    };
  }

  async publish(tenantId: string, id: string, submission: ServiceSubmission | undefined): Promise<PublishJobResponse> {
    const service = await this.requireService(tenantId, id);
    const target = await this.requireTarget(tenantId, submission?.environmentId);
    const development = await this.developmentInstance(service.builderChatId);
    const files = await this.checkedFiles(development.directory);
    if (files.builtOnSdk1) throw new CustomServiceRefusal(409, 'built-on-sdk-1', BUILT_ON_SDK_1);
    const next = files.check.ok ? await this.developmentOf(service) : null;
    if (!next) {
      throw new CustomServiceRefusal(409, 'check-failed', firstError(files.check), { problems: files.check.problems });
    }
    await this.probes.assertGuarded(next);
    await this.saveNewlyRequired(asCallers(next), next, submission);
    return this.publisher.publish(service.builderChatId, tenantId, {
      environmentId: target.environmentId,
      variables: {},
      scheduleIds: [],
    });
  }

  async publishJob(tenantId: string, id: string, environmentId: unknown): Promise<PublishJobResponse | null> {
    const service = await this.requireService(tenantId, id);
    const target = await this.requireTarget(tenantId, environmentId);
    return this.publisher.getLatestJob(service.builderChatId, target.environmentId);
  }

  async defaultEnvironmentReview(
    tenantId: string,
    id: string,
    environmentId: unknown
  ): Promise<DefaultEnvironmentReview> {
    const service = await this.requirePublishedService(tenantId, id);
    const target = await this.requirePublishedTarget(tenantId, service, environmentId);
    return {
      target: { environmentId: target.environmentId, name: target.name },
      ...(await this.reviewOf(tenantId, service, {
        files: await this.checkedFiles(target.directory),
        version: async () => {
          const next = await this.publishedAt(service, target.environmentId);
          return next && { next, development: await this.developmentOf(service) };
        },
        withImpact: true,
      })),
    };
  }

  private async reviewOf(
    tenantId: string,
    service: CustomServiceRow,
    inputs: ReviewInputs
  ): Promise<Omit<DefaultEnvironmentReview, 'target'>> {
    const review: Omit<DefaultEnvironmentReview, 'target'> = {
      current: await this.currentDefault(tenantId, service),
      check: inputs.files.check,
      impact: null,
      serviceConfiguration: null,
    };
    const version = inputs.files.check.ok ? await inputs.version() : null;
    if (!version) return review;
    return {
      ...review,
      impact: inputs.withImpact
        ? await this.impacts.between(await this.published(service), version.next, service.builderChatId)
        : null,
      serviceConfiguration: await this.serviceConfigurationReview(version.next, version.development),
    };
  }

  async switchDefaultEnvironment(
    tenantId: string,
    id: string,
    submission: ServiceSubmission | undefined
  ): Promise<NamedEnvironment> {
    const service = await this.requirePublishedService(tenantId, id);
    const target = await this.requirePublishedTarget(tenantId, service, submission?.environmentId);
    const files = await this.checkedFiles(target.directory);
    const next = files.check.ok ? await this.publishedAt(service, target.environmentId) : null;
    if (!next) {
      throw new CustomServiceRefusal(409, 'check-failed', firstError(files.check), { problems: files.check.problems });
    }
    await this.saveNewlyRequired(next, await this.developmentOf(service), submission);
    await this.defaults.switchTo(service.id, target.environmentId);
    return { environmentId: target.environmentId, name: target.name };
  }

  private async serviceConfigurationReview(
    next: RegisteredService,
    development: RegisteredService | null
  ): Promise<ServiceConfigurationReview> {
    const owner = callersOwner(next);
    const [stored, read] = await Promise.all([this.store.rowIdOf(next, owner), this.store.read(next, owner)]);
    const missingFields = new Set(read.missing.map((path) => path.split('.')[0]));
    const fields = valueFieldsOf(next.manifest.serviceForm ?? []).filter(
      (field) => stored === null || missingFields.has(field.key)
    );
    const fromDevelopment = development ? (await this.store.read(development, callersOwner(development))).values : {};
    const asked = new Set(fields.map((field) => field.key));
    return {
      fields,
      missing: read.missing,
      fromDevelopment: fields.filter((field) => fromDevelopment[field.key] !== undefined).map((field) => field.key),
      newDefaults:
        stored === null
          ? []
          : defaultsMissingFrom(next.manifest.serviceForm ?? [], read.values).filter((entry) => !asked.has(entry.key)),
    };
  }

  private async saveNewlyRequired(
    next: RegisteredService,
    development: RegisteredService | null,
    submission: ServiceSubmission | undefined
  ): Promise<ServiceConfigurationSave | null> {
    const review = await this.serviceConfigurationReview(next, development);
    const values = submission?.values ?? {};
    const copied = submission?.copyFromDevelopment ?? [];
    const issues: ConfigurationIssue[] = [];
    if (!isPlainValues(values)) issues.push({ pointer: '/', message: 'must be an object of field values' });
    if (!Array.isArray(copied) || !copied.every((key) => typeof key === 'string')) {
      issues.push({ pointer: '/copyFromDevelopment', message: 'must list field keys' });
    }
    if (issues.length > 0) throw new InvalidConfigurationError(issues);
    const asked = new Set(review.fields.map((field) => field.key));
    const copyKeys = copied as string[];
    for (const key of copyKeys) {
      if (!review.fromDevelopment.includes(key)) {
        issues.push({ pointer: `/${key}`, message: 'has no value in Development to copy' });
      }
    }
    for (const key of Object.keys(values as ConfigurationValues)) {
      if (!asked.has(key)) issues.push({ pointer: `/${key}`, message: 'is not asked for by this Publish' });
    }
    if (issues.length > 0) throw new InvalidConfigurationError(issues);
    if (review.fields.length === 0) return null;

    const owner = callersOwner(next);
    const current = await this.store.read(next, owner);
    const fromDevelopment =
      development && copyKeys.length > 0
        ? await this.store.openedValues(development, callersOwner(development), copyKeys)
        : {};
    const saved = await this.store.saveAndReport(
      next,
      owner,
      { ...withoutStoredSecrets(current.values), ...(values as ConfigurationValues), ...fromDevelopment },
      { keepRenamedKeys: true }
    );
    await this.saveHooks.deferUntilPublished(next, owner, saved.previousStored);
    return saved;
  }

  private async checkedFiles(directory: string): Promise<CheckedFiles> {
    const folder = serviceAppFolder(this.storageMountPath, directory);
    const { json, check } = await readConfinedServiceFolder(folder);
    return {
      builtOnSdk1: isBuiltOnSdk1(json, vendoredSdkVersion(await readFileInFolder(folder, PACKAGE_FILE))),
      check: checkReportOf(check),
      manifest: check.manifest ?? null,
      manifestHash: check.manifest ? computeManifestHash(json) : null,
    };
  }

  private async developmentOf(service: CustomServiceRow): Promise<RegisteredService | null> {
    return servableOrNone(this.registry.development(service.id));
  }

  private async published(service: CustomServiceRow): Promise<RegisteredService | null> {
    if (service.defaultEnvironmentId === null) return null;
    return servableOrNone(this.registry.publishedCustom(service.id));
  }

  private async publishedAt(service: CustomServiceRow, environmentId: string): Promise<RegisteredService | null> {
    return servableOrNone(this.registry.publishedAt(service.id, environmentId));
  }

  private async currentDefault(tenantId: string, service: CustomServiceRow): Promise<NamedEnvironment | null> {
    if (service.defaultEnvironmentId === null) return null;
    const environment = await this.environments.findForTenant(tenantId, service.defaultEnvironmentId);
    return { environmentId: environment.id, name: environment.name };
  }

  private async defaultCommitOf(service: CustomServiceRow): Promise<string | null> {
    if (service.defaultEnvironmentId === null) return null;
    const instance = (await serviceInstancesOf(service.builderChatId)).find(
      (candidate) => candidate.environmentId === service.defaultEnvironmentId && !candidate.isDefault
    );
    return instance?.deployedCommitSha ?? null;
  }

  private async developmentInstance(builderChatId: string): Promise<ServiceInstance> {
    const development = (await serviceInstancesOf(builderChatId)).find((instance) => instance.isDefault);
    if (!development) throw new NotFoundException(`The builder chat ${builderChatId} has no Development`);
    return development;
  }

  private async requireService(tenantId: string, id: string): Promise<CustomServiceRow> {
    const service = await this.repository.findInTenant(tenantId, id);
    if (!service) throw new NotFoundException(`External Service ${id} not found`);
    return service;
  }

  private async requirePublishedService(tenantId: string, id: string): Promise<CustomServiceRow> {
    const service = await this.requireService(tenantId, id);
    if (service.defaultEnvironmentId === null) {
      throw new CustomServiceRefusal(409, 'not-published', `\`${service.slug}\` has not been published yet`);
    }
    return service;
  }

  private async requireTarget(tenantId: string, environmentId: unknown): Promise<NamedEnvironment> {
    const environment =
      typeof environmentId === 'string'
        ? (await this.environments.listForTenant(tenantId)).find((candidate) => candidate.id === environmentId)
        : undefined;
    if (!environment || environment.isDefault) {
      throw new CustomServiceRefusal(
        400,
        'invalid-environment',
        'Choose one of your Organization’s environments other than Development'
      );
    }
    return { environmentId: environment.id, name: environment.name };
  }

  private async requirePublishedTarget(
    tenantId: string,
    service: CustomServiceRow,
    environmentId: unknown
  ): Promise<NamedEnvironment & { directory: string }> {
    const target = await this.requireTarget(tenantId, environmentId);
    const instance = (await serviceInstancesOf(service.builderChatId)).find(
      (candidate) => candidate.environmentId === target.environmentId && !candidate.isDefault
    );
    if (!instance?.deployedCommitSha) {
      throw new CustomServiceRefusal(
        409,
        'not-published',
        `\`${service.slug}\` has no published version in ${target.name}`
      );
    }
    return { ...target, directory: instance.directory };
  }
}
