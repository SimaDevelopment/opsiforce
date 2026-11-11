import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { OC_PACKAGES_ROOT } from "./opencode-packages.ts";

// OpenCode's stylesheet asks for its fonts at /assets/… (Inter, the terminal's
// Nerd Font), files its own app ships in public/assets. The embed compiles that
// stylesheet but not that public dir, so those requests failed. Serving the
// vendored files at the same paths, in dev and in the build, makes the embed's
// @font-face resolve, and lets the shell load Inter from the one URL as well.
const ASSETS_DIR = path.join(OC_PACKAGES_ROOT, "app/public/assets");
const URL_PREFIX = "/assets/";

const CONTENT_TYPE: Record<string, string> = { ".ttf": "font/ttf", ".woff2": "font/woff2", ".woff": "font/woff" };

const assetNames = () => fs.readdirSync(ASSETS_DIR).filter((name) => fs.statSync(path.join(ASSETS_DIR, name)).isFile());

export function opencodePublicAssets(): Plugin {
  return {
    name: "opencode-public-assets",
    configureServer(server) {
      const names = new Set(assetNames());
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        const name = url.startsWith(URL_PREFIX) ? url.slice(URL_PREFIX.length) : "";
        if (!names.has(name)) return next();
        res.setHeader("Content-Type", CONTENT_TYPE[path.extname(name)] ?? "application/octet-stream");
        fs.createReadStream(path.join(ASSETS_DIR, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of assetNames()) {
        this.emitFile({ type: "asset", fileName: `assets/${name}`, source: fs.readFileSync(path.join(ASSETS_DIR, name)) });
      }
    },
  };
}
