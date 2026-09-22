export function resolveBrand(env: Record<string, string | undefined>) {
  return {
    name: env.VITE_BRAND_NAME || 'Opsiforce',
    icon: env.VITE_BRAND_ICON || '/assets/icons/brands/opsiforce.svg',
    favicon: env.VITE_BRAND_ICON || '/favicon/favicon.svg',
    appleTouchIcon: env.VITE_BRAND_ICON || '/favicon/opsiforce_180.svg',
    manifest: env.VITE_BRAND_MANIFEST || '/manifest.webmanifest',
    themeColor: env.VITE_BRAND_THEME_COLOR || '#000000',
  };
}
