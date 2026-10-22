import { existsSync, readFileSync } from "fs";
import path from "path";
import { loadEnv, type Plugin } from "vite";

type Brand = {
  name: string;
  icon: string;
  favicon: string;
  appleTouchIcon: string;
  manifest: string;
  themeColor: string;
};

const DEFAULT_THEME_COLOR = "#000000";

const OPSIFORCE_BRAND: Brand = {
  name: "Opsiforce",
  icon: "/assets/icons/brands/opsiforce.svg",
  favicon: "/favicon/favicon.svg",
  appleTouchIcon: "/favicon/opsiforce_180.svg",
  manifest: "/manifest.webmanifest",
  themeColor: DEFAULT_THEME_COLOR,
};

function brandFromManifest(publicDir: string, manifestUrl: string): Brand {
  const manifestFile = path.join(publicDir, manifestUrl);
  if (!existsSync(manifestFile)) {
    throw new Error(`VITE_BRAND_MANIFEST points to ${manifestUrl}, but ${manifestFile} does not exist`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const name = manifest.name;
  const icon = manifest.icons?.[0]?.src;
  if (typeof name !== "string" || !name || typeof icon !== "string" || !icon) {
    throw new Error(`${manifestFile} must define "name" and "icons[0].src"`);
  }
  return {
    name,
    icon,
    favicon: icon,
    appleTouchIcon: icon,
    manifest: manifestUrl,
    themeColor: manifest.theme_color || DEFAULT_THEME_COLOR,
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function deploymentBranding(): Plugin {
  let brand = OPSIFORCE_BRAND;

  return {
    name: "deployment-branding",
    config(config, { mode }) {
      const root = path.resolve(config.root ?? process.cwd());
      const publicDir = path.resolve(root, typeof config.publicDir === "string" ? config.publicDir : "public");
      const manifestUrl = loadEnv(mode, config.envDir ?? root, "VITE_BRAND_").VITE_BRAND_MANIFEST;
      brand = manifestUrl ? brandFromManifest(publicDir, manifestUrl) : OPSIFORCE_BRAND;
      return {
        define: {
          __BRAND__: JSON.stringify({ name: brand.name, icon: brand.icon }),
        },
      };
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const values: Record<string, string> = {
          NAME: brand.name,
          FAVICON: brand.favicon,
          APPLE_TOUCH_ICON: brand.appleTouchIcon,
          MANIFEST: brand.manifest,
          THEME_COLOR: brand.themeColor,
        };
        return html.replace(/__BRAND_(\w+)__/g, (placeholder, key: string) => {
          const value = values[key];
          return value === undefined ? placeholder : escapeHtml(value);
        });
      },
    },
  };
}
