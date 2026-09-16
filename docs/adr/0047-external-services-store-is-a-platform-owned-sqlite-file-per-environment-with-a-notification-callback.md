# External-services store is a platform-owned SQLite file per environment with a notification callback

Each ProjectEnvironment gets one `data/external-services.db` beside its workspace, with one `messages` and one `attachments` table shared by every service; the backend is the sole writer, the platform owns the schema through an ordered migration list whose applied version lives in the file's `PRAGMA user_version`, and a service definition adds no DDL. A webhook is handled synchronously and shortly (verify, route, store, meter, 200), and only after the acknowledgement does the platform ring the App once with the stored row ids: the callback is a notification, not a delivery, because the row is already durable and the App reads it from the file. Routing outcomes are never a 5xx to the provider, since a message that routes nowhere is the sender's error and a non-2xx would only buy redelivery and duplicate rows.

## Considered options

- **Store in the App's own database.** Rejected: platform tables inside the App's migration story.
- **Store in the observability database.** Rejected: that file is disposable by design.
- **Deliver the message body in the callback and retry on failure.** Rejected: two data paths to keep equal; the schema is the whole contract and catching up after downtime is the same read as the live path.

## Consequences

- Idempotency is a unique index on service plus provider message id; a redelivered POST answers 200, writes nothing, meters nothing and rings nothing.
- `app_delivered_at IS NULL` is the only "never delivered" marker; there are no retries, and a missed callback is not data loss.
- Metering rows outlive tenant data: the Organization reference is durable while Project and environment references null out on delete, so usage history survives deletion and the counter can only undercount.
