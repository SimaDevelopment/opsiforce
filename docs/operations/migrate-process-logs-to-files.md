---
kind: operations
---

# Migrate process logs to files

> Bring every existing workspace of a deployment onto [Process Logs](../../GLOSSARY.md): every agent pod on the new image, no `process_logs` or `process_events` tables, no corrupt request log, no Agent instructions naming the tables.

Agent image `0.38.0` carries the new `log-writer` and the `process-logs` command, and a pod only gets them by starting on that image; nothing restarts a running pod for you, so step 1 restarts every pod still on an older one, Built-in or Custom Agent, Development or published. Workspace content is the script's job: `migrate-process-logs-to-files.mjs` copies the tables' recent rows into `data/logs/`, drops the tables, moves a corrupt `data/database.db` aside, and replaces a `platform` Skill copy that still teaches the tables ([Process Log](../runtime/process-log.md), [ADR-0091](../adr/0091-process-logs-are-rotated-files-with-one-writer-each-and-the-request-log-is-written-only-from-outside-the-pod.md)). It runs from the backend pod, which mounts every workspace, and only after the restarts, because an old `log-writer` keeps writing the tables.

## Prerequisites

- `kubectl` access to the deployment's namespace, written `$NS` below.
- Agent image `0.38.0` deployed, then a backend whose image holds the script: `kubectl -n $NS exec <backend> -- ls /app/packages/opsiforce/agent-config/scripts/migrate-process-logs-to-files.mjs` succeeds. `<backend>` is what `kubectl -n $NS get deploy -o name | grep opsiforce-backend` prints, such as `deployment.apps/opsiforce-backend`.
- New pods get `0.38.0` or later: `kubectl -n $NS exec <backend> -- printenv AGENT_CONTAINER_IMAGE` names that tag, or prints nothing and `kubectl -n $NS exec <backend> -- cat /app/packages/opsiforce/agent-config/agent-image-version.json` does. Otherwise step 1 brings pods back on the old image.

## Steps

1. **Restart every pod on an old image.** List the agent pods:

   ```bash
   kubectl -n $NS get pods -l app=opsiforce-agent -o custom-columns='POD:.metadata.name,IMAGE:.spec.containers[0].image'
   ```

   Save the list, then delete every pod whose image tag is below `0.38.0` in one command: `kubectl -n $NS delete pod <pod> <pod> … --wait=false`. The backend recreates each on the current image within a minute, workspace intact; an open chat reconnects and a published App is unavailable for that minute. A suspended environment has no pod and starts on the new image when next opened. A pod comes back under the same name, so run the listing again until every pod reads `0.38.0` or later and is `Running`; that is done.

2. **Dry-run.** It changes nothing and prints one JSON line per workspace:

   ```bash
   kubectl -n $NS exec <backend> -- node /app/packages/opsiforce/agent-config/scripts/migrate-process-logs-to-files.mjs \
     --platform-skill /app/packages/opsiforce/agent-config/skills/platform/SKILL.md \
     --scan /workspace-data/projects > dry-run.jsonl
   ```

   | `status` | Meaning |
   |---|---|
   | `would-migrate` | Tables present: `rows` is what will be copied (the last 72 hours), `droppedOlderRows` what goes with the tables |
   | `would-quarantine` | SQLite reports the file corrupt; `error` says how |
   | `already-migrated` | Nothing to do |
   | `no-database` | No `data/database.db` yet, or one moved aside before; the proxy creates it on the App's next request |
   | `failed` | Names an error the script cannot handle |

   `platformSkill: "would-replace"` marks a `platform` copy the apply replaces; `files` is a preview whose stamps differ from the apply's. Done when you have read every line that is not `already-migrated` or `no-database`.

3. **Apply.** Run the step 2 command with `--apply`, redirected to `apply.jsonl`. Per workspace, in one transaction, it writes `data/logs/<process>.log.imported-<stamp>`, drops both tables and compacts the file; it moves a corrupt file to `data/database.db.corrupt-<stamp>`, after which the proxy writes a fresh one; and it replaces a stale `platform` copy. A re-run skips finished work. Done when every line is `migrated`, `quarantined`, `already-migrated` or `no-database`.

4. **Report:** the pods restarted; workspaces migrated and quarantined, with each quarantine's `error`; rows copied and `droppedOlderRows`; `platform` copies replaced; every `failed` line; and any `needsReview` path in `apply.jsonl`, a workspace file that still names the tables.

## Verify

- The step 1 listing shows no image below `0.38.0`, and the step 2 command, run again, prints only `already-migrated` and `no-database`, with no `would-replace`.
- In a running pod, `kubectl -n $NS exec <pod> -c opencode -- process-logs --list` lists its processes, and `kubectl -n $NS exec <pod> -c opencode -- sqlite3 -readonly /workspace/data/database.db .tables` prints `app_requests` or nothing, nothing until the App's first request.
