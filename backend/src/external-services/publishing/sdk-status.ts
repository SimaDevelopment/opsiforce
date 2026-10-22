import { sdkVersion } from '@opsiforce/external-service-sdk';
import { sdkPackageVersion } from '@opsiforce/external-service-sdk/server';

export type SdkStatusKind = 'current' | 'upgrade-available' | 'needs-upgrade' | 'unknown';

export interface SdkStatus {
  vendored: string | null;
  latest: string;
  status: SdkStatusKind;
}

function parts(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlder(a: number[], b: number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

export function sdkStatusOf(
  vendored: string | null,
  latest = sdkPackageVersion,
  acceptedMajor = sdkVersion
): SdkStatus {
  const own = vendored === null ? null : parts(vendored);
  const newest = parts(latest);
  if (!own || !newest) return { vendored, latest, status: 'unknown' };
  if ((own[0] ?? 0) < acceptedMajor) return { vendored, latest, status: 'needs-upgrade' };
  return { vendored, latest, status: isOlder(own, newest) ? 'upgrade-available' : 'current' };
}
