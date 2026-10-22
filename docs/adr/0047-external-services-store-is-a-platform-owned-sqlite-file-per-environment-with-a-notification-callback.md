# External-services store is a platform-owned SQLite file per environment with a notification callback

Each ProjectEnvironment gets one `data/external-services.db` beside its workspace, with one `events` and one `event_files` table shared by every External Service and each file's bytes on disk next to it; the backend is the sole writer, the platform owns the schema through an ordered migration list whose applied version lives in the file's `PRAGMA user_version`, and a Service manifest adds no DDL: an Event's `data` is JSON the service shapes and its Service skill documents, never checked by the platform. A delivery is handled shortly — the service verifies its webhook and picks the receivers, and the platform stores the Event for each of them and queues the doorbell before it answers ([ADR-0084](0084-an-external-service-delivers-its-events-to-the-projectenvironments-it-chooses-and-the-platform-keeps-them-and-wakes-the-app.md)) — and the doorbell then tells the App which Event ids arrived: the callback is a notification, not a delivery, because the Event is already durable and the App reads it from the file.

## Considered options

- **Store in the App's own database.** Rejected: platform tables inside the App's migration story.
- **Store in the request log's database.** Rejected: that file is disposable by design.
- **Deliver the Event in the callback.** Rejected: two data paths to keep equal; the schema is the whole contract, and catching up after downtime is the same read as the live path.

## Consequences

- Idempotency is a unique index on service, Event type and key; a redelivered Event is stored once and counted once.
- `app_delivered_at IS NULL` is the only "never delivered" marker; the doorbell retries with backoff and wakes the App ([ADR-0084](0084-an-external-service-delivers-its-events-to-the-projectenvironments-it-chooses-and-the-platform-keeps-them-and-wakes-the-app.md)), and a ring that never lands is still not data loss.
- A Built-in External Service's Usage rows outlive tenant data: the Organization reference is durable while Project and environment references null out on delete, so Usage history survives deletion and the counter can only undercount. A Custom service keeps its own Usage ([ADR-0092](0092-an-external-service-keeps-its-own-call-log-and-usage-and-the-platform-only-reads-them.md)).
