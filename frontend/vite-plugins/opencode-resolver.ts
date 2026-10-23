import path from "path";
import fs from "fs";
import type { Plugin } from "vite";

import { OC_PACKAGES_ROOT } from "./opencode-packages.ts";

// Every vendored opencode package ships an `exports` map in its package.json.
// Honouring it directly keeps this resolver correct across upgrades — the previous
// hand-copied table drifted the moment upstream moved a file.
const OC_PACKAGE_DIRS: Record<string, string> = {
  app: "app",
  ui: "ui",
  core: "core",
  schema: "schema",
  "session-ui": "session-ui",
  plugin: "plugin",
  "effect-drizzle-sqlite": "effect-drizzle-sqlite",
  sdk: "sdk",
  client: "client",
  util: "util",
  theme: "theme",
  protocol: "protocol",
  ai: "ai",
  codemode: "codemode",
  "gui-extensions": "gui-extensions",
  "plugin-browser": "plugin-browser",
};

const exportsCache = new Map<string, Record<string, unknown> | null>();

function packageExports(pkgDir: string): Record<string, unknown> | null {
  if (!exportsCache.has(pkgDir)) {
    const manifest = path.join(OC_PACKAGES_ROOT, pkgDir, "package.json");
    let parsed: Record<string, unknown> | null = null;
    if (fs.existsSync(manifest)) {
      try {
        parsed = (JSON.parse(fs.readFileSync(manifest, "utf8")).exports ?? null) as Record<string, unknown> | null;
      } catch {
        parsed = null;
      }
    }
    exportsCache.set(pkgDir, parsed);
  }
  return exportsCache.get(pkgDir) ?? null;
}

/** Pick a file target out of an exports entry, which may be a string or a conditions object. */
function exportTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const conditions = entry as Record<string, unknown>;
    for (const key of ["solid", "import", "module", "default", "types"]) {
      const resolved = exportTarget(conditions[key]);
      if (resolved) return resolved;
    }
  }
  return null;
}

function resolveFromExports(pkgDir: string, subpath: string): string | null {
  const map = packageExports(pkgDir);
  if (!map) return null;
  const key = subpath ? `./${subpath}` : ".";
  const root = path.join(OC_PACKAGES_ROOT, pkgDir);

  const exact = exportTarget(map[key]);
  if (exact) {
    const resolved = path.join(root, exact);
    if (fs.existsSync(resolved)) return resolved;
  }

  // Wildcard patterns, longest prefix first so "./context/*" beats "./*".
  const wildcards = Object.keys(map)
    .filter((candidate) => candidate.includes("*"))
    .sort((a, b) => b.length - a.length);
  for (const pattern of wildcards) {
    const [prefix, suffix = ""] = pattern.split("*");
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const rest = key.slice(prefix.length, key.length - suffix.length);
    const target = exportTarget(map[pattern]);
    if (!target) continue;
    const resolved = path.join(root, target.replace("*", rest));
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

/** Fallback for imports an exports map does not cover: probe <pkg>/src/<subpath>. */
function resolveFromSource(pkgDir: string, subpath: string): string | null {
  const root = path.join(OC_PACKAGES_ROOT, pkgDir, "src");
  const target = subpath || "index";
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    const candidate = path.join(root, target + suffix);
    if (suffix === "" && !/\.[a-z]+$/.test(target)) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function opencodeResolver(): Plugin {
  return {
    name: "opencode-resolver",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith("@opencode/")) return null;
      const [specifier, query] = source.split("?", 2);
      const rest = specifier.slice("@opencode/".length);
      const [name, ...segments] = rest.split("/");
      const pkgDir = OC_PACKAGE_DIRS[name];
      if (!pkgDir) return null;
      const subpath = segments.join("/");
      const resolved = resolveFromExports(pkgDir, subpath) ?? resolveFromSource(pkgDir, subpath);
      return resolved && query !== undefined ? `${resolved}?${query}` : resolved;
    },
  };
}
