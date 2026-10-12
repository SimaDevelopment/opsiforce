# The platform routes incoming Events by the same bounds as Operations, and wakes the App to receive them

An outside system sends one webhook per registration (a Whapi number, a Trello board, a GitHub repository) to the one URL it was given, while any number of ProjectEnvironments may want what it carries. The External Service's `inbound` handler verifies and parses the webhook but receives only the Service configuration — no Project configuration — and a service pod may never write into another Project's files.

**The service only turns a webhook into declared Events; the platform decides which ProjectEnvironments receive each one, from declarations alone, and keeps it for them.** Concretely:

- **Events are declared.** The Service manifest lists Event types (`"events": {"message.received": {title, description, data}}`), each with a JSON Schema for its `data`. `inbound` returns `{events: [{type, key, occurredAt, data, files?}], response?}`; `key` is the provider's id and drops duplicates. A `data` that does not fit its schema is dropped and logged as `invalid_event`.
- **Receiving is opt-in per type.** The platform generates one toggle per Event type on the Project form, stored under the reserved key `receive` beside `operations`, off for every type in a new configuration and for types added later. Publish (App) turns Receive off in Development for every type it carries to the target environment.
- **Routing reuses bounds.** `data` properties carry `boundTo` like Operation inputs; a ProjectEnvironment receives an Event only if `receive[type]` is on and every bound value passes the same check the Gate runs for its Operations. Event types without a bound are allowed only in a Custom External Service (meaning: every Project of that Organization that turned it on). The backend compiles the bounds into one JSONB containment query per Event over the Project configurations, behind a GIN index. A webhook nobody receives is still answered `200` and logged as `unmatched`.
- **One generic store.** Each receiving environment's `external-services.db` holds `events (id, service, type, key, occurred_at, received_at, data, app_delivered_at)` and `event_files`, with file bytes on disk beside it. No raw payload, no service-specific columns, no per-service tables. Events are kept for good; turning Receive off or narrowing a Project configuration never deletes what was delivered.
- **The doorbell is durable and wakes the App.** One coalesced job per environment × service is queued before the provider gets its `200`; it wakes the App as Schedules do, reads the undelivered Event ids at ring time, posts `{service, eventIds}`, and retries with backoff. A `404` or `501` marks the App as not wired until its next start. The doorbell carries no authentication: its body is ids into the App's own read-only database.

## Considered options

- **Service code picks the receivers.** Rejected: it holds no Project configurations, and a buggy handler would deliver one Project's board — or, for a Built-in External Service, one Organization's chats — to Projects whose configuration never allowed it.
- **A routing declaration separate from bounds.** Rejected: the two drift, and a Project could then hear from a chat it may not write to without anyone choosing that.
- **A routing index table written on every configuration save.** Rejected: the containment query reaches the same index without a second copy to keep in step.
- **Receive on by default.** Rejected: a Project configured only to send would silently start copying every message into its database.
- **Per-service tables with real columns.** Rejected: every manifest change would need an `ALTER TABLE` in every consumer environment's database.
- **Webhooks sent straight to the service App's own URL.** Rejected: the pod holds no secrets to verify the signature, App Auth would answer with a sign-in redirect, and the URL changes with the default environment.

## Consequences

- An App asleep when an Event arrives is woken for it, so a chatty source keeps a receiving App awake; Receive being off by default is what bounds that.
- An environment's `external-services.db` grows without limit; an App that only needs recent Events still cannot delete old ones.
- A Development environment receives real traffic only before its first Publish or after someone turns it back on.
