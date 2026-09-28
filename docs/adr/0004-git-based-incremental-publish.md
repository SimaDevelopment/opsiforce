# Publish via git: a production environment is a checkout of the dev repo

The agent workspace is a git repository whose `.gitignore` separates app source (tracked) from runtime state (ignored: `data/` with the SQLite databases, `node_modules`, `**/.yarn/cache`, `**/.pnp.*`, `.opencode/`). **Publishing commits Development's working tree and makes each published `ProjectEnvironment` a `git clone --local` of the Development directory, `reset --hard` to that commit; the deployed SHA is recorded on the environment row.** A later publish fetches and resets in place, and rebuilds the target's `.git` from Development when its repository is unhealthy.

The `.gitignore` is already the deploy boundary, `reset --hard` is incremental and deletion-correct, ignored runtime state (the production database, installed dependencies) survives redeploys by construction, and rollback is `reset --hard <previous SHA>`.

## Considered options

- **Full re-copy each publish.** Rejected: slow on large apps, must hand-handle deleted files and explicitly preserve production's database and dependencies, and gives no rollback or history.
- **rsync-style incremental.** Rejected: no history or rollback, and a second ignore file to keep in step with `.gitignore`.

## Consequences

- The publish worker needs the `git` binary and auto-commits Development's working tree on every publish (the repository is platform-managed and invisible to users).
- `dist/` is git-ignored so production builds fresh rather than shipping Development's artifacts.
- **A deploy recreates the pod.** After the reset and the env-file write, the publish deletes and recreates the target's pod, waits for it to be ready, then waits for the App to serve; the production branch of `startup.sh` installs and builds. The running App is down from the recreate until the new one serves.
- **A failed redeploy rolls back by the same path:** `reset --hard` to the previous SHA, restore the env file, and recreate the pod again. Migrations are **forward-only**: a git rollback of code does not roll back schema.
- **Rollback restores more than code.** A publish also changes two things git does not track: the env file (`app/opsiforce.env.json`, git-ignored) and the environment's schedule set. The env file is backed up before it is overwritten and written back if the deploy fails. Schedules are reconciled **after** the App serves (upsert the desired, remove only the stale), so a failed publish never touches the live schedule set, and a reconcile that fails after a healthy deploy is logged without failing the publish.
- A failed **first** publish marks the environment failed and leaves its cloned directory, gateway key and row in place.
- Zero-downtime (blue-green) deploys are not built.
