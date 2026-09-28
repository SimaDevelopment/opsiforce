# Agent-owned file changes need no OpenCode reload call

Agent Updates and Store deliveries rewrite the agent-owned files in a workspace (`/workspace/.opencode/opencode.json`, `agents/<name>.md`, `skills/`), and the running OpenCode must pick them up without a restart. OpenCode watches every config root it discovers, including `.opencode/`, and rebuilds config, agents, skills and plugins within seconds of a change, with no new process.

**Writing the files is the reload; nothing restarts OpenCode.** An Agent Update is recorded as applied once its Job succeeds and a running pod has been told. The watcher is inotify, which raises no event on a node that did not perform the write, so a writer that must confirm activation asks `agent-control` for `POST /notify-config-change`. The handler creates and deletes a marker under `.opencode/`, `.opencode/agents/` or `.opencode/skills/`, one per requested target, and the writer then reads the pod's `:4096` proxy back (`GET /api/skill`) before it reports success ([ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)). Every writer into a live pod does this: the Store skill fan-out and the pool claim with the `skills` target, and the Agent Update Job with `agents`, plus `config` and `skills` when it changed them.

A pod recreate is the only lever for changes outside the watched roots: the opencode binary, environment variables, and template files a running pod cannot absorb. A workspace migration declares it with `requiresPodRecreate`.

## Considered options

- **Call `DELETE /api/debug/location` after writing.** Rejected: it is a debug route with no stability promise, and the watcher makes it redundant.
- **Inject config through `OPENCODE_CONFIG_CONTENT` instead of workspace files.** Rejected: environment variables cannot hot-reload, which would bring the restart back.

## Consequences

- Profile-only rollouts (prompt, skills, model or effort) are zero-downtime.
- When the Job cannot reach a running pod, or the pod does not serve the Job's skills, the update waits as reload-pending and the pod is recreated once its session is idle.
- A session's own stored model selection still wins over the agent default for that session; a variant change reaches sessions that have not pinned one.
- A hung opencode process is handled by the pod's health checks and `guard`, not by the update pipeline.
