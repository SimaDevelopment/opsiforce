# A Publish carries the App's data only when asked, by mirroring Development's data folder, and replaces nothing the target owns unless chosen

A Publish moves the App's source with git ([ADR-0004](0004-git-based-incremental-publish.md)): what git tracks is overwritten in the target, and what it ignores, the App's database included, stays where it is. Organizations want two things beyond that: to ship Development's data on purpose ("make Production exactly what I tested", seeded lookup tables, a database built from fixtures), and to keep a Publish from replacing what belongs to the target.

**A Publish carries only the App's source unless asked: Publish with data replaces the target's `app/data/` with Development's, and User uploads and Generated files never leave their environment.** The target also keeps its own App Details ([ADR-0016](0016-app-details-are-per-environment.md)), and its own Project configurations unless they are chosen ([ADR-0095](0095-a-service-manifest-can-connect-every-new-project-to-the-service.md)). Concretely:

- **Publish with data mirrors `app/data/` and nothing else.** `app/data/` is the App's state by the platform's contract: the `platform` and `docker` skills tell every agent to keep databases, the files an App keeps, and database containers' data directories there. The workspace root's `data/` (request log, process logs, received events), `.xdg/` (the agent conversation), `.opencode/`, `.opsiforce/`, `app/opsiforce.env.json`, installed dependencies and build output are never carried.
- **Mirror, not merge.** The target's `app/data/` is moved aside to `.opsiforce/replaced-app-data/` and Development's is copied in its place with owners and modes kept, so the target ends holding exactly Development's data.
- **Both Apps stop for the copy.** Development is held in `publishing` with its pod deleted while its `app/data/` is copied, and starts again afterwards when it was running; the request is refused while Development is starting or its agent is mid-turn. The target's pod stops before its data is replaced and is recreated as on every Publish.
- **A failed Publish restores the data.** The moved-aside `app/data/` is put back beside the code and Environment Variables that ADR-0004 already restores, and deleted once the Publish succeeds. There is no lasting undo.
- **Guarded per Publish.** The toggle is off by default and never remembered. It is unavailable while Development holds no App data, so it can never empty the target, and over an environment that already runs it is confirmed by typing the Environment's name. It is gated by `can_publish_project`. The publish job's report records that it carried data in an `app-data` line.
- **User uploads and Generated files never leave their environment.** `user_uploaded_files/` and `generated_files/` join the platform's ignore list, and each Publish adds missing platform entries to Development's `.gitignore` and untracks those folders before it commits. The next Publish removes the copies earlier Publishes placed in a target, and a file the App needs at runtime belongs in `app/`. Duplicate and Export still carry them, as they carry everything git ignores ([ADR-0011](0011-duplication-reuses-git-publish-path.md)); files already committed stay in git history.
- **Everything else stays as it is.** Environment Variables and Schedules are still chosen in the form, App Auth is still seeded at the first Publish only, and switched-off Skills still follow Development.

We chose `app/data/` because it is the one folder that is the App's by contract: everything else git ignores is either the platform's own per-environment state, the agent's, or rebuilt by `startup.sh`. We chose mirror because an overlay leaves the target's files beside Development's. A rollback journal that a crash left in the target replays onto Development's copied database, which then passes `PRAGMA integrity_check` while holding the target's old rows; as SQLite does with the starter App's journal settings. We stop Development because a database server an App runs in Docker keeps its data directory in `app/data/<name>`, and a file copy of a running server is unusable, while a SQLite database copied live with its journal comes through intact (1,200 of 1,200 trials). We reuse `can_publish_project` because a Publish can already ship code that deletes the target's data.

## Considered options

- **Copy everything git ignores, as Duplicate does.** Rejected: the target would get Development's request log, process logs and queued received events, its Environment Variables (a live payment key replaced by a test key) and Development's agent conversation.
- **Copy every `data/` folder.** Rejected: the workspace root's `data/` holds the platform's records, not the App's.
- **Copy live, without stopping Development.** Rejected for database servers, whose data directories are not consistent while they run.
- **Keep the replaced data after a success as a one-step undo.** Rejected: it needs an undo control, storage and a retention rule for a mistake the typed confirmation already guards against.
- **A permission of its own.** Rejected: it adds group setup in every Organization without a boundary that `can_publish_project` does not already cross.
- **A toggle for User uploads and Generated files, or for App Details.** Rejected: uploads and deliverables belong to the conversation, and App Details are already per environment.

## Consequences

- A target running Publish with data is down from the moment its pod stops until the new App serves, which now includes the copy.
- Data that names its own environment, such as absolute links to Development's Public URL, webhook registrations at an outside system or stored OAuth tokens, arrives in the target as it was in Development.
- During the Publish, the target's volume briefly holds both the moved-aside data and Development's copy.
