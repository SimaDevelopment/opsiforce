# Apps reach non-LLM services through the backend-owned Service Gateway

Agents run LLM-generated code, so a real Mailgun, Whapi or GitHub key inside a pod is a key usable from anywhere with the provider's full scope, shared by every Project, with no per-project revocation, rate limit or attribution. **Every ProjectEnvironment instead holds one `service` gateway token, and the backend validates it, resolves the Project, ProjectEnvironment and tenant, and reaches the outside system itself with credentials it keeps; an App never sees a provider key.** The endpoints are public to the cluster and authenticate on the token alone, because pods call them without the edge's identity headers. The one exception is a Custom External Service's own pod: it is the program that speaks to the outside system, so it fetches its Service configuration's secrets from the backend with its own key and holds them only in memory ([ADR-0078](0078-an-external-service-fetches-its-configurations-from-the-backend-by-the-caller-identity-and-holds-them-only-in-memory.md)); the Apps that call it never see them.

## Considered options

- **Inject per-project provider keys.** Rejected: most providers cannot mint scoped keys per project, and a leak is still a full-scope key.
- **Route non-LLM traffic through Bifrost.** Rejected: Bifrost is an LLM gateway; its keys, budgets and revocation are the wrong model for email or webhooks.

## Consequences

- The `service` gateway token is the credential a pod uses for platform services, so Schedules (cron registration), App readiness (the go-live push), Agent Status and the Gate all ride it rather than minting their own. The same key reaches the platform API only as the `public-api` External Service through the Gate ([ADR-0062](0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)).
- Gateway keys live in their own table (`project_gateway_keys`, one `service` key per ProjectEnvironment), separate from LLM virtual keys, so Bifrost revocation and budget code never touches them.
- The Built-in External Services that hold a provider account (Incoming email, WhatsApp) are inbound only: they declare Events and no Service route that sends as the account or manages it, so a Project receives through the account but can never send as it. Anything a Custom External Service can do to its outside system is what its Service routes pass, decided by its own Service policy against the calling Project's configuration ([ADR-0046](0046-an-external-service-owns-its-api-and-its-service-policy-the-gate-only-identifies-the-caller-finds-the-service-and-forwards-the-call-untouched.md)).
