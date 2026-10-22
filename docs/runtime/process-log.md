---
kind: explanation
terms: [Process Log]
adrs: [0091]
---

# Process Log

> Where does the output of every process in a pod go, how long is it kept, and how does an Agent read it?

## How it works

### Writing

- A [Process Log](../../GLOSSARY.md) is written by `log-writer`: `guard` pipes its command's stdout and stderr through it, and it passes the output on unchanged and appends each line, prefixed with a UTC timestamp to the millisecond, to `/workspace/data/logs/<process>.log` ([Pod Tools](pod-tools.md)).
- `guard` writes its own lines and the lifecycle events of its command — `started`, `crashed`, `stopped`, `signal`, `gave_up`, with exit code, uptime and restart count — into the same file through `log-writer --line` and `--event`, between runs, so each file has one writer at a time and takes no lock ([ADR-0091](../adr/0091-process-logs-are-rotated-files-with-one-writer-each-and-the-request-log-is-written-only-from-outside-the-pod.md)).
- Lines are buffered and written every half second or every hundred lines; a stored line is cut at 10 KB while the passed-on output stays whole.
- A process name becomes a file name with every character outside letters, digits, `.`, `_` and `-` replaced by `_`.

### Retention

- A file that would grow past 10 MB is renamed to `<process>.log.1`, the older copies shift to `.2` and `.3`, and the fourth is deleted, so one process keeps at most 40 MB.
- A streaming writer on start and hourly, and any writer when it rotates, deletes every log file in the directory last written more than three days ago, its own active file excepted; no backend job sweeps the directory.
- A writer that finds its file gone or replaced reopens the path before its next write.

### Reading

- `process-logs` in the agent image merges a process's files, oldest first, and every process by timestamp; `--since`, `--grep`, `--events`, `--lines`, `--list` and `--follow` narrow it, and each line names its process when more than one is read.
- The `platform` [Skill](../../GLOSSARY.md) teaches the [Agent](../../GLOSSARY.md) to run `process-logs --events --since 2m` and an error grep after every round of edits; the files are plain text, so `tail` and `grep` work too.
- OpenCode's permission rules deny the Agent edits under `data/logs/` ([Agent](../agent-system/agent.md)).

## Edge cases

- When the log directory cannot be written, `log-writer` reports it once on stderr, keeps passing output through and tries again on the next flush.
- When a Process Log file is deleted by another writer's age sweep while its process is idle, the lines of at most one flush are lost.
- When a workspace's `data/database.db` holds `process_logs` and `process_events` tables, nothing reads or writes them; [Migrate process logs to files](../operations/migrate-process-logs-to-files.md) moves their rows into the log directory and drops them.

## Code

- `proxy/cmd/agent-log-writer/` — the writer, its rotation and its age sweep.
- `agent-config/scripts/guard.sh` — the supervisor that feeds it lines and events.
- `agent-config/scripts/process-logs.sh` — the reader, installed as `process-logs`.

## Related

- [Pod Tools](pod-tools.md) — the guarded processes whose output this is.
- [Request Logging](../gateways/request-logging.md) — the App's HTTP traffic, kept in the request log instead.
