import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sdkVersion, type ServiceManifest } from '@opsiforce/external-service-sdk';
import { computeManifestHash } from '@opsiforce/external-service-sdk/server';
import { manifestFileName, readServiceFolder } from '@opsiforce/external-service-sdk/service-folder';
import { SERVICE_SKILL_FILE } from './built-in-services';

export const SERVICE_APP_FOLDER = 'app';

export const PACKAGE_FILE = 'package.json';

const SDK_PACKAGE = '@opsiforce/external-service-sdk';

const VENDORED_SDK_VERSION = /external-service-sdk-(\d+\.\d+\.\d+[^/]*)\.tgz$/;

export interface PublishedServiceFiles {
  manifest: ServiceManifest;
  manifestHash: string;
  icon: string | null;
  serviceSkill: string | null;
  sdkVersion: string | null;
}

export class UnservableServiceFiles extends Error {}

export interface ReadServiceFiles {
  files: PublishedServiceFiles;
  changed: boolean;
}

interface CachedRead {
  stamp: string;
  files: PublishedServiceFiles;
}

async function fileStampOf(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function folderStampOf(folder: string): Promise<string> {
  const stamps = await Promise.all(
    [manifestFileName, PACKAGE_FILE, SERVICE_SKILL_FILE].map((file) => fileStampOf(join(folder, file)))
  );
  return stamps.join('|');
}

export function vendoredSdkVersion(packageJson: string | null): string | null {
  if (packageJson === null) return null;
  try {
    const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, unknown> };
    const dependency = parsed.dependencies?.[SDK_PACKAGE];
    if (typeof dependency !== 'string') return null;
    return VENDORED_SDK_VERSION.exec(dependency)?.[1] ?? dependency.replace(/^[\^~]/, '');
  } catch {
    return null;
  }
}

export function acceptsSdk(vendored: string | null): boolean {
  return vendored === null || Number(vendored.split('.')[0]) === sdkVersion;
}

@Injectable()
export class PublishedServiceFilesReader {
  private readonly storageMountPath: string;
  private readonly cache = new Map<string, CachedRead>();

  constructor(config: ConfigService) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async read(directory: string): Promise<ReadServiceFiles> {
    const folder = join(this.storageMountPath, directory, SERVICE_APP_FOLDER);
    const stamp = await folderStampOf(folder);
    const cached = this.cache.get(folder);
    if (cached?.stamp === stamp) return { files: cached.files, changed: false };

    const files = await this.readFolder(folder);
    if ((await folderStampOf(folder)) !== stamp) return { files, changed: false };
    this.cache.set(folder, { stamp, files });
    return { files, changed: true };
  }

  private async readFolder(folder: string): Promise<PublishedServiceFiles> {
    const { json, check } = await readServiceFolder(folder, { origin: 'custom' });
    if (!check.ok || !check.manifest) {
      const first = check.problems.find((problem) => problem.severity === 'error');
      throw new UnservableServiceFiles(
        first ? `${first.path}: ${first.message}` : `${manifestFileName} does not pass check`
      );
    }
    const vendored = vendoredSdkVersion(await readOptional(join(folder, PACKAGE_FILE)));
    if (!acceptsSdk(vendored)) {
      throw new UnservableServiceFiles(`SDK ${vendored} is not an SDK ${sdkVersion}.x`);
    }
    return {
      manifest: check.manifest,
      manifestHash: computeManifestHash(json),
      icon: check.manifest.icon ? await readOptional(join(folder, check.manifest.icon)) : null,
      serviceSkill: await readOptional(join(folder, SERVICE_SKILL_FILE)),
      sdkVersion: vendored,
    };
  }
}
