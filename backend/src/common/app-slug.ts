import slugify from 'slugify';
import { LEADING_UUID, type AppAddress } from './app-host';

const DNS_LABEL_MAX_LENGTH = 63;
const APP_SLUG_FOR_UNREADABLE_NAMES = 'app';
const RESERVED_HYPHENS = /^[a-z0-9]{2}--/;

export type AppSlugBudget = Pick<AppAddress, 'environmentSlug' | 'shortId'>;

function appSlugLengthBudget({ environmentSlug, shortId }: AppSlugBudget): number {
  return DNS_LABEL_MAX_LENGTH - ((environmentSlug ?? '').length + 1) - (shortId.length + 1);
}

export function toAppSlug(text: string | null, budget: AppSlugBudget): string {
  const appSlug = slugify(text ?? '', { lower: true })
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, appSlugLengthBudget(budget))
    .replace(/-+$/, '');
  return appSlug && !LEADING_UUID.test(appSlug) ? appSlug : APP_SLUG_FOR_UNREADABLE_NAMES;
}

export function appSlugBrokenRule(appSlug: string, budget: AppSlugBudget, environmentName: string): string | null {
  const lengthBudget = appSlugLengthBudget(budget);
  if (appSlug.length === 0) return 'Enter the readable part of the address';
  if (/[^a-z0-9-]/.test(appSlug)) return 'Use only lowercase letters, digits and dashes';
  if (appSlug.startsWith('-') || appSlug.endsWith('-')) return "Can't start or end with a dash";
  if (RESERVED_HYPHENS.test(appSlug)) return "Can't have dashes as the 3rd and 4th characters";
  if (appSlug.length > lengthBudget) return `At most ${lengthBudget} characters in ${environmentName}`;
  if (LEADING_UUID.test(appSlug)) return "Can't start with a UUID";
  return null;
}
