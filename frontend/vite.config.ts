import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

import {
  deploymentBranding,
  dropUnloadedOfficeFiles,
  OC_PACKAGES_ROOT,
  opencodeMessageStamp,
  opencodeResolver,
} from "./vite-plugins/index.ts";

const OFFICE_DEPS = ["@betteroffice/docx", "@betteroffice/fonts", "@betteroffice/pptx", "@betteroffice/xlsx"];

export default defineConfig(({ mode }) => ({
  plugins: [
    deploymentBranding(),
    opencodeResolver(),
    opencodeMessageStamp(),
    tanstackRouter({
      target: "solid",
      autoCodeSplitting: mode !== "production",
    }),
    solidPlugin(),
    tailwindcss(),
    dropUnloadedOfficeFiles(),
  ],
  resolve: {
    // Array form so CSS entry points can be matched by pattern. Tailwind resolves
    // `@import` itself rather than going through the plugin above, so the
    // stylesheet patterns from each package's exports map are mirrored here.
    alias: [
      { find: "@/", replacement: path.join(OC_PACKAGES_ROOT, "app/src") + "/" },
      { find: "~/", replacement: path.resolve(import.meta.dirname, "src") + "/" },
      {
        find: "@betteroffice/fonts-cjk",
        replacement: path.join(OC_PACKAGES_ROOT, "gui-extensions/src/microsoft-office/fonts-cjk.ts"),
      },
      {
        find: /^@opencode\/session-ui\/v2\/(.*\.css)$/,
        replacement: path.join(OC_PACKAGES_ROOT, "session-ui/src/v2/components/$1"),
      },
      {
        find: "@opencode/ui/button.css",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/actions/button/button.css"),
      },
      {
        find: "@opencode/ui/file-tree.css",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/file-tree.css"),
      },
      {
        find: "@opencode/ui/text-input.css",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/forms/text-input/text-input.css"),
      },
      {
        find: "@opencode/ui/styles/tokens",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/tokens/index.css"),
      },
      {
        find: "@opencode/ui/styles/tailwind",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/tailwind/index.css"),
      },
      {
        find: "@opencode/ui/styles",
        replacement: path.join(OC_PACKAGES_ROOT, "ui/src/styles/index.css"),
      },
      {
        find: "@opencode/session-ui/styles",
        replacement: path.join(OC_PACKAGES_ROOT, "session-ui/src/styles/index.css"),
      },
    ],
  },
  optimizeDeps: {
    exclude: OFFICE_DEPS,
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
    // pierre workers import @opencode/* directly.
    plugins: () => [opencodeResolver()],
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
}));
