export async function run(ctx) {
  if (!ctx.commandExists('yarn')) {
    throw new Error(
      'yarn is not on PATH. The prerequisites step enables it via corepack — re-run `yarn dev` so that step completes first.'
    );
  }
  ctx.note(`installing workspace dependencies with yarn ${ctx.versions.exact.yarn} (PnP) — generates .pnp.cjs…`);
  ctx.run('yarn', ['install'], { cwd: ctx.paths.packageRoot });
  ctx.note('workspace dependencies installed (backend, frontend, linked-account-proxy).');
}
