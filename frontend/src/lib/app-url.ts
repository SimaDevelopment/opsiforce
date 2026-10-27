export const ENVIRONMENT_SLUG_MAX_LENGTH = 26;
export const ENVIRONMENT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ENDS_LIKE_AN_APP_SHORT_ID = /(?:^|-)[0-9a-f]{12,}$/;

type AddressedEnvironment = { slug: string | null; shortId: string };

export function readableAppUrl(appSlug: string, environment: AddressedEnvironment): string {
  return `https://${appSlug}${appHostSuffix(environment)}/`;
}

export function appHostSuffix(environment: AddressedEnvironment): string {
  return `-${environment.slug}-${environment.shortId}.${import.meta.env.VITE_WEBAPP_DOMAIN}`;
}

export function endsLikeAnAppShortId(environmentSlug: string): boolean {
  return ENDS_LIKE_AN_APP_SHORT_ID.test(environmentSlug);
}

export function slugifyEnvironmentName(name: string): string {
  return slugify(name, ENVIRONMENT_SLUG_MAX_LENGTH);
}

export function slugify(name: string, maxLength: number): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}
