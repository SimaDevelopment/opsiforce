import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sdkVersion } from '@opsiforce/external-service-sdk';
import { manifestFileName, readServiceFolder } from '@opsiforce/external-service-sdk/service-folder';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments } from '../../../db/schema';
import { isWorkspaceJunk } from '../../common/workspace-junk';
import { collectEntries, fitsOnVolume, openZip, readNamedEntry, writeConfinedEntry } from '../../common/zip-reader';
import { packExportArchive } from '../../export/export-archive';
import {
  EXPORT_MANIFEST_FILE,
  exportFormatUnsupported,
  exportStampOf,
  wrongExportKind,
} from '../../export/export-manifest';
import { GitService, type CommittedFile } from '../../git/git.service';
import { importsRootPath } from '../../project/project-import.types';
import { scanKeyLike } from '../../store/gate';
import {
  acceptsSdk,
  BUILT_ON_SDK_1,
  isBuiltOnSdk1,
  PACKAGE_FILE,
  SERVICE_APP_FOLDER,
  vendoredSdkVersion,
} from '../registry/published-service-files';
import { CustomServiceRefusal } from './custom-service-refusal';
import { CustomServiceRepository, type CustomServiceRow } from './custom-service.repository';
import { CustomServices, type CustomServiceCreator } from './custom-services.service';
import {
  notAServiceExport,
  SERVICE_EXPORT_FORMAT_VERSION,
  SERVICE_EXPORT_KIND,
  serviceExportFileName,
  serviceImportRefused,
  type ImportServiceRequest,
  type ServiceCopy,
  type ServiceCopyRequest,
  type ServiceExportFile,
  type ServiceExportManifest,
  type ServiceExportPreview,
  type ServiceImportProblem,
} from './service-export';

const APP_PREFIX = `${SERVICE_APP_FOLDER}/`;
const FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
const MAX_IMPORTED_FILE_NAME_LENGTH = 200;

interface CommittedApp {
  service: CustomServiceRow;
  files: CommittedFile[];
}

@Injectable()
export class ServiceCopies {
  private readonly storageMountPath: string;
  private readonly importsRoot: string;

  constructor(
    private readonly config: ConfigService,
    private readonly repository: CustomServiceRepository,
    private readonly services: CustomServices,
    private readonly git: GitService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
    this.importsRoot = importsRootPath(this.storageMountPath);
  }

  async exportFile(tenantId: string, id: string): Promise<ServiceExportFile> {
    const { service, files } = await this.committedApp(tenantId, id);
    const manifest: ServiceExportManifest = {
      kind: SERVICE_EXPORT_KIND,
      stamp: {
        ...exportStampOf(this.config, SERVICE_EXPORT_FORMAT_VERSION),
        sdkVersion: vendoredSdkVersion(packageJsonOf(files)),
      },
      service: { name: service.name, slug: service.slug },
    };
    const archive = await packExportArchive(
      manifest,
      files.map(({ path, content, executable }) => ({ path: `${APP_PREFIX}${path}`, content, executable }))
    );
    return { fileName: serviceExportFileName(service.slug), archive };
  }

  async preview(tenantId: string, id: string): Promise<ServiceExportPreview> {
    return { hits: scanKeyLike((await this.committedApp(tenantId, id)).files) };
  }

  async duplicate(creator: CustomServiceCreator, id: string, request: ServiceCopyRequest): Promise<ServiceCopy> {
    const { service, files } = await this.committedApp(creator.tenantId, id);
    const copy = await this.services.create(creator, request, {
      files,
      commitMessage: `Copied from ${service.name}`,
    });
    return { service: copy, warnings: [] };
  }

  async importFrom(
    creator: CustomServiceCreator,
    archivePath: string,
    request: ImportServiceRequest
  ): Promise<ServiceCopy> {
    const manifest = await readServiceManifest(archivePath);
    const workDir = join(this.importsRoot, `.service-import-${randomUUID()}`);
    try {
      const appDir = join(workDir, SERVICE_APP_FOLDER);
      await unpackApp(archivePath, appDir);
      const files = await readFolderFiles(appDir);
      if (!files.some((file) => file.path === manifestFileName)) {
        throw notAServiceExport(`The file has no ${APP_PREFIX}${manifestFileName}`);
      }
      const warnings = await warningsFor(appDir, files);
      const named = {
        name: givenOr(request.name, manifest.service.name, 'name'),
        slug: givenOr(request.slug, manifest.service.slug, 'slug'),
      };
      const service = await this.services
        .create(creator, named, {
          files,
          commitMessage: `Imported from ${importedFileName(request.fileName, manifest)}`,
        })
        .catch((error: unknown) => {
          if (!(error instanceof CustomServiceRefusal)) throw error;
          throw new CustomServiceRefusal(error.status, error.code, error.detail, {
            ...error.extensions,
            nameFromFile: manifest.service.name,
            slugFromFile: manifest.service.slug,
          });
        });
      return { service, warnings };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async committedApp(tenantId: string, id: string): Promise<CommittedApp> {
    const service = await this.repository.findInTenant(tenantId, id);
    if (!service) throw new NotFoundException(`External Service ${id} not found`);
    const workspace = join(this.storageMountPath, await developmentDirectoryOf(service.builderChatId));
    const files = (await this.git.committedFiles(workspace, SERVICE_APP_FOLDER)).filter(
      (file) => !isWorkspaceJunk(file.path)
    );
    if (files.length === 0) {
      throw new CustomServiceRefusal(
        409,
        'nothing-committed',
        `\`${service.slug}\` has no committed files yet; ask its builder to commit its work first`
      );
    }
    return { service, files };
  }
}

async function developmentDirectoryOf(builderChatId: string): Promise<string> {
  const [development] = await db
    .select({ directory: projectEnvironments.directory })
    .from(projectEnvironments)
    .where(and(eq(projectEnvironments.projectId, builderChatId), eq(projectEnvironments.isDefault, true)));
  if (!development) throw new NotFoundException(`The builder chat ${builderChatId} has no Development`);
  return development.directory;
}

function packageJsonOf(files: CommittedFile[]): string | null {
  return files.find((file) => file.path === PACKAGE_FILE)?.content.toString('utf8') ?? null;
}

function importedFileName(given: unknown, manifest: ServiceExportManifest): string {
  const name = typeof given === 'string' ? basename(given.trim()).slice(0, MAX_IMPORTED_FILE_NAME_LENGTH) : '';
  return name || serviceExportFileName(manifest.service.slug);
}

function givenOr(value: unknown, fallback: string, field: 'name' | 'slug'): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new CustomServiceRefusal(400, `invalid-${field}`, `The ${field} must be text`);
  return value;
}

async function warningsFor(appDir: string, files: CommittedFile[]): Promise<string[]> {
  const { json, check } = await readServiceFolder(appDir);
  const vendored = vendoredSdkVersion(packageJsonOf(files));
  if (isBuiltOnSdk1(json, vendored)) return [`${BUILT_ON_SDK_1}; Publish refuses it until then`];
  const warnings: string[] = [];
  if (!check.ok) {
    const first = check.problems.find((problem) => problem.severity === 'error');
    warnings.push(
      `${first ? `${first.path}: ${first.message}` : `${manifestFileName} does not pass check`}; the builder must fix it before you can publish`
    );
  }
  if (!acceptsSdk(vendored)) {
    warnings.push(
      `It is built on SDK ${vendored}, and this deployment runs SDK ${sdkVersion}.x; the builder must upgrade it before you can publish`
    );
  }
  return warnings;
}

async function readServiceManifest(archivePath: string): Promise<ServiceExportManifest> {
  let parsed: unknown;
  try {
    const zip = await openZip(archivePath);
    try {
      const buffer = await readNamedEntry(zip, EXPORT_MANIFEST_FILE);
      if (!buffer) throw notAServiceExport(`The file isn't an export: it has no ${EXPORT_MANIFEST_FILE}`);
      parsed = JSON.parse(buffer.toString('utf8'));
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw notAServiceExport("The file isn't a readable export zip");
  }
  return assertServiceManifest(parsed);
}

function assertServiceManifest(parsed: unknown): ServiceExportManifest {
  if (typeof parsed !== 'object' || parsed === null) throw notAServiceExport(`${EXPORT_MANIFEST_FILE} is malformed`);
  const manifest = parsed as Partial<ServiceExportManifest> & { kind?: unknown };

  const wrongKind = wrongExportKind(manifest, SERVICE_EXPORT_KIND);
  if (wrongKind) throw notAServiceExport(wrongKind);

  const version = manifest.stamp?.exportFormatVersion;
  if (typeof version !== 'number') throw notAServiceExport(`${EXPORT_MANIFEST_FILE} has no exportFormatVersion`);
  if (version > SERVICE_EXPORT_FORMAT_VERSION) throw exportFormatUnsupported(version, SERVICE_EXPORT_FORMAT_VERSION);

  if (typeof manifest.service?.name !== 'string' || typeof manifest.service.slug !== 'string') {
    throw notAServiceExport(`${EXPORT_MANIFEST_FILE} is malformed`);
  }
  return manifest as ServiceExportManifest;
}

async function unpackApp(archivePath: string, appDir: string): Promise<void> {
  const root = resolve(appDir);
  await mkdir(root, { recursive: true });
  const problems: ServiceImportProblem[] = [];
  const zip = await openZip(archivePath);
  try {
    const entries = await collectEntries(zip);
    if (!(await fitsOnVolume(root, entries, APP_PREFIX, FREE_SPACE_RESERVE_BYTES))) {
      throw serviceImportRefused([
        { path: APP_PREFIX, message: "The service unpacks to more than this deployment's storage has room for" },
      ]);
    }
    for (const entry of entries) {
      if (entry.fileName.endsWith('/') || !entry.fileName.startsWith(APP_PREFIX)) continue;
      if (isWorkspaceJunk(entry.fileName)) continue;
      const path = entry.fileName.slice(APP_PREFIX.length);
      if (!(await writeConfinedEntry(zip, entry, root, path))) {
        problems.push({
          path,
          message: `${APP_PREFIX}${path}: only regular files inside ${APP_PREFIX} can be imported`,
        });
      }
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw notAServiceExport(`The file can't be unpacked: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    zip.close();
  }
  if (problems.length > 0) throw serviceImportRefused(problems);
}

async function readFolderFiles(folder: string): Promise<CommittedFile[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const files: CommittedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    files.push({
      path: relative(folder, absolute).split('\\').join('/'),
      content: await readFile(absolute),
      executable: ((await stat(absolute)).mode & 0o111) !== 0,
    });
  }
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
