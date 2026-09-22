import { defineConfig, loadEnv } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { resolveBrand } from "./branding";

import { OC_PACKAGES_ROOT, opencodeMessageStamp, opencodeResolver } from "./vite-plugins/index.ts";

export default defineConfig(({ mode }) => ({
  plugins: [
    {
      name: "deployment-branding",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          const brand = resolveBrand(loadEnv(mode, import.meta.dirname));
          const values: Record<string, string> = {
            NAME: brand.name,
            FAVICON: brand.favicon,
            APPLE_TOUCH_ICON: brand.appleTouchIcon,
            MANIFEST: brand.manifest,
            THEME_COLOR: brand.themeColor,
          };
          return html.replace(/__BRAND_(\w+)__/g, (placeholder, key: string) => {
            const value = values[key];
            return value === undefined ? placeholder : value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
          });
        },
      },
    },
    opencodeResolver(),
    opencodeMessageStamp(),
    tanstackRouter({
      target: "solid",
      autoCodeSplitting: mode !== "production",
    }),
    solidPlugin(),
    tailwindcss(),
  ],
  resolve: {
    // Array form so CSS entry points can be matched by pattern. Tailwind resolves
    // `@import` itself rather than going through the plugin above, so the
    // stylesheet patterns from each package's exports map are mirrored here.
    alias: [
      { find: "@/", replacement: path.join(OC_PACKAGES_ROOT, "app/src") + "/" },
      { find: "~/", replacement: path.resolve(import.meta.dirname, "src") + "/" },
      {
        find: /^@opencode-ai\/session-ui\/v2\/(.*\.css)$/,
        replacement: path.join(OC_PACKAGES_ROOT, "session-ui/src/v2/components/$1"),
      },
      {
        find: "@opencode-ai/ui/button.css",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/actions/button/button.css"),
      },
      {
        find: "@opencode-ai/ui/file-tree.css",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/file-tree.css"),
      },
      {
        find: "@opencode-ai/ui/text-input.css",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/forms/text-input/text-input.css"),
      },
      {
        find: "@opencode-ai/ui/styles/tokens",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/tokens/index.css"),
      },
      {
        find: "@opencode-ai/ui/styles/tailwind",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/tailwind/index.css"),
      },
      {
        find: "@opencode-ai/ui/styles",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/index.css"),
      },
      {
        find: "@opencode-ai/session-ui/styles",
        replacement: path.join(OC_PACKAGES_ROOT, "session-ui/src/styles/index.css"),
      },
    ],
  },
  server: {
    port: 8084,
    allowedHosts: ["host.minikube.internal", ".opsiforce.localtest.me"],
    proxy: {
      "/api": {
        target: "http://localhost:3010",
        changeOrigin: true,
        ws: true,
      },
      "/ms-api": {
        target: process.env.VITE_USER_MS_URL || "http://localhost:4112",
        changeOrigin: true,
      },
      "/ms-assets": {
        target: process.env.VITE_USER_MS_URL || "http://localhost:4112",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  worker: {
    format: "es",
    // Workers bundle in a separate environment that does not inherit the top-level
    // plugins, so the resolver is registered again here — session-ui's markdown and
    // pierre workers import @opencode-ai/* directly.
    plugins: () => [opencodeResolver()],
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
}));
