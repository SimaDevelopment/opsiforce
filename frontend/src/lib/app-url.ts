export const ENVIRONMENT_SLUG_MAX_LENGTH = 26;
export const ENVIRONMENT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function appHostLabel(environmentId: string, slug: string | null | undefined): string {
  return slug ? `${environmentId}-${slug}` : environmentId;
}

export function appPublicUrl(environmentId: string, slug: string | null | undefined): string {
  return `https://${appHostLabel(environmentId, slug)}.${import.meta.env.VITE_WEBAPP_DOMAIN}/`;
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
