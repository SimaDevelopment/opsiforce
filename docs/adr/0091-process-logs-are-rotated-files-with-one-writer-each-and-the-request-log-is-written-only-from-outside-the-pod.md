# Process logs are rotated files with one writer each, and the request log is written only from outside the pod

A pod's Process Logs are plain text files under `data/logs/`, one per supervised process, each written by one `log-writer` at a time, the one its guard runs: every line carries a UTC timestamp, lifecycle events are lines in the same file, a file rotates at 10 MB keeping three older copies, and any file older than three days is removed by the writers themselves. The request log is the `app_requests` table of `data/database.db`, the file's only table: the app-mode runtime proxy inserts into it, and a backend job every three days deletes rows older than three days, 1,000 at a time with a short pause between batches. Both run outside the pod, so nothing inside a Kata guest writes the file.

We chose this because SQLite's byte-range locks taken inside a Kata guest are not seen by a process outside it: virtio-fs does not forward them to the host, and a lock held in the guest is granted again on the worker. Any SQLite file written from both sides of that boundary has uncoordinated writers and can be corrupted. Files with one appending writer each need no lock at all, so nothing depends on locks crossing the boundary; the request log keeps SQL, which its readers lean on, because both its writers sit outside the guest, where the shared volume does coordinate their locks. The cleanup deletes in batches because one large delete holds the write lock for seconds, and the proxy's single logging routine, which serves every Project, waits on that lock and drops the entries that arrive meanwhile.

## Considered options

- **Dot-file locks instead of POSIX locks.** Rejected: SQLite's `unix-dotfile` VFS has to be chosen by every connection, the proxy's, the backend's and every ad-hoc `sqlite3` an Agent runs included; one connection that forgets corrupts the file again.
- **A separate SQLite file for process logs.** Rejected: each process still has its own log-writer, so the pod alone holds several writers of the one file, and the backend's retention job still writes it from outside the guest.
- **Request-log retention in the app-mode proxy.** Rejected: its delete runs on the same routine that logs for every Project, so a large one stalls logging exactly as a backend delete holding the lock does, and a Project with no traffic would never be cleaned.
- **One `DELETE` per run.** Rejected: a backlog of 150,000 rows held the lock for about four seconds and the proxy dropped 267 of 300 entries that arrived meanwhile; in batches of 1,000 it dropped 74, against 21 with no cleanup running.
- **One owning service for every record, or a server database.** Rejected: a new always-on component and network hop per log line for data that is disposable by design, and Agents would lose `tail` and `grep`.

## Consequences

- An Agent reads process output with the `process-logs` command or plain `tail`/`grep`, not SQL; Datasette shows only the request log.
- Retention is bounded per process (four files of at most 10 MB) and in time (three days), and nothing outside the pod has to sweep it.
- A writer reopens its file when it disappears, so a file removed by another writer's age sweep loses at most the lines of one flush.
- A Project's request log holds up to six days of rows just before a cleanup run: three of retention plus three between runs.
- Readers inside the pod — Datasette and the Agent's `sqlite3 -readonly` — open the request log read-only, so a journal they cannot see the proxy's lock on is refused rather than rolled back; a read can fail and be retried, never write.
