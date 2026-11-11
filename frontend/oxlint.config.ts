// Single frontend oxlint config, auto-discovered by the CLI (no -c flag needed).
// Merges the shared opsiforce base (JS configs don't support `extends`, so it is imported)
// with frontend-native rules and two ESLint-ecosystem plugins run via oxlint jsPlugins:
//  - eslint-plugin-solid: Solid reactivity / tracking-scope rules
//  - @tanstack/eslint-plugin-query: solid-query correctness (queryKey deps, unstable deps)
// Yarn PnP: both plugins are `unplugged` in the root package.json so they exist at a real
// on-disk path, resolved here at load time (no version hash to hardcode). The tanstack plugin
// must be loaded via its modern ESM entry file — handing oxlint the package directory resolves
// the legacy CJS `main`, whose interop double-wraps the default export and breaks registration.
import { createRequire } from 'node:module'
import base from '../.oxlintrc.json' with { type: 'json' }

const require = createRequire(import.meta.url)
const resolvePluginDir = (pkg: string) => {
  const entry = require.resolve(pkg)
  const marker = `/node_modules/${pkg}`
  return entry.slice(0, entry.indexOf(marker) + marker.length)
}

export default {
  ...base,
  plugins: [...base.plugins, 'jsx-a11y'],
  env: { browser: true, es2022: true },
  jsPlugins: [
    resolvePluginDir('eslint-plugin-solid'),
    resolvePluginDir('@tanstack/eslint-plugin-query') + '/build/modern/index.js',
  ],
  rules: {
    ...base.rules,
    'no-unassigned-vars': 'off',
    'jsx-a11y/label-has-associated-control': 'warn',
    'jsx-a11y/control-has-associated-label': 'warn',
    'jsx-a11y/click-events-have-key-events': 'warn',
    'jsx-a11y/no-static-element-interactions': 'warn',
    'jsx-a11y/iframe-has-title': 'warn',
    'jsx-a11y/prefer-tag-over-role': 'warn',
    'solid/reactivity': 'warn',
    'solid/no-destructure': 'warn',
    'solid/components-return-once': 'warn',
    'solid/prefer-for': 'warn',
    'solid/no-innerhtml': 'warn',
    'solid/jsx-no-undef': 'warn',
    'solid/no-react-specific-props': 'warn',
    '@tanstack/query/exhaustive-deps': 'warn',
    '@tanstack/query/no-rest-destructuring': 'warn',
    '@tanstack/query/stable-query-client': 'warn',
    '@tanstack/query/no-unstable-deps': 'warn',
    '@tanstack/query/no-void-query-fn': 'warn',
    '@tanstack/query/infinite-query-property-order': 'warn',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'solid-sonner',
            importNames: ['toast'],
            message: "Import toast from '~/lib/toast' so it lands in the platform Toaster, not OpenCode's.",
          },
        ],
      },
    ],
  },
  overrides: [...base.overrides, { files: ['src/lib/toast.ts'], rules: { 'no-restricted-imports': 'off' } }],
}
