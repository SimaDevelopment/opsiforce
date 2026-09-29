# Apps reach non-LLM services through the backend-owned Service Gateway

Agents run LLM-generated code, so a real Mailgun, Twilio or S3 key inside a pod is a key usable from anywhere with the provider's full scope, shared by every Project, with no per-project revocation, rate limit or attribution. **Every ProjectEnvironment instead holds one `service` gateway token, and the backend's Service Gateway validates it, resolves the Project, ProjectEnvironment and tenant, and forwards to the real provider with centrally held credentials; Apps never see a provider key.** The endpoint is public to the cluster and authenticates on the token alone, because pods call it without the edge's identity headers.

## Considered options

- **Inject per-project provider keys.** Rejected: most providers cannot mint scoped keys per project, and a leak is still a full-scope key.
- **Route non-LLM traffic through Bifrost.** Rejected: Bifrost is an LLM gateway; its keys, budgets and revocation are the wrong model for email or webhooks.

## Consequences

- The `service` gateway token is the credential a pod uses for platform services, so Schedules (cron registration), App readiness (the go-live push), Agent Status and the external-services agent endpoints all ride it rather than minting their own. A pod whose Agent may call the platform API also carries a separate `platform-api` key ([ADR-0062](0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)).
- Gateway keys live in their own table (`project_gateway_keys`, with a `purpose` of `service` or `platform-api`), separate from LLM virtual keys, so Bifrost revocation and budget code never touches them.
- The provider forces the sender identity, so an Agent can send but never impersonate or manage the provider account.
