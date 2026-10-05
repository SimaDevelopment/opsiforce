# Worktrees

`MAIN=$(git worktree list | head -1 | cut -d' ' -f1)` is the main checkout, `W` the worktree root. Tilt deploys from `MAIN`: never commit or merge there; an integration branch gets its own worktree.

## Setup

`yarn` fails in a fresh worktree. Never run `yarn install` or create a root `node_modules`; reuse the main checkout's PnP install:

```sh
sed -e 's#"\.\./\.\./\.yarn/berry#"../../../../../.yarn/berry#g' \
    -e 's#"\./\.yarn/__virtual__#"../../../.yarn/__virtual__#g' \
    -e 's#"\./\.yarn/unplugged#"../../../.yarn/unplugged#g' \
    $MAIN/.pnp.cjs > $W/.pnp.cjs
cp $MAIN/.pnp.loader.mjs $W/.pnp.loader.mjs
ln -s $MAIN/packages/opsiforce/.scratch $W/packages/opsiforce/.scratch
```

Add no other symlinks, or Node reports "multiple pnpapi instances".

## Checks

Smoke tests only; the real gate is `yarn ts` and `yarn exec oxlint src` in `MAIN` after merging.

- **tsc** (from `backend/` or `frontend/`; ignore `TS2688 ... 'vite/client'`):
  `node -r $W/.pnp.cjs $(node -e "require('$W/.pnp.cjs').setup();console.log(require.resolve('typescript/bin/tsc'))") --noEmit -p tsconfig.json`
- **Vitest** (from `backend/`, needs Docker; locate it with `node -r $W/.pnp.cjs -e "console.log(require.resolve('vitest/package.json'))"`):
  `NODE_OPTIONS="-r $W/.pnp.cjs --experimental-loader $W/.pnp.loader.mjs" node <vitest dir>/vitest.mjs run --maxWorkers=3 [path]`
- **oxlint** (from the workspace dir; `--type-aware` and the frontend jsPlugins don't run here):
  `node -r $MAIN/.pnp.cjs $(ls -d $MAIN/.yarn/unplugged/oxlint-virtual-*/node_modules/oxlint/bin/oxlint | head -1) -c ../.oxlintrc.json src`
- **oxfmt**, only on files you edited:
  `NODE_OPTIONS="-r $MAIN/.pnp.cjs --experimental-loader $MAIN/.pnp.loader.mjs" node $MAIN/.yarn/unplugged/oxfmt-virtual-*/node_modules/oxfmt/bin/oxfmt -c ../.oxfmtrc.json <files>`
- **Migrations**: drizzle-kit doesn't work here. Copy the last `meta/NNNN_snapshot.json`, edit it, give it a new `id` with `prevId` = the old one, then add the `.sql` and its `_journal.json` entry.
- **New routes**: `routeTree.gen.ts` can only be regenerated in `MAIN`; flag it.
