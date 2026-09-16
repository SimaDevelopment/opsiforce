# Apps reach non-LLM services through the backend-owned Service Gateway

Agents run LLM-generated code, so a real Mailgun, Twilio or S3 key inside a pod is a key usable from anywhere with the provider's full scope, shared by every Project, with no per-project revocation, rate limit or attribution. Every Project instead holds one gateway token, and the backend's Service Gateway validates it, resolves the Project, ProjectEnvironment and tenant, and forwards to the real provider with centrally held credentials; Apps never see a provider key. The endpoint is public to the cluster and authenticates on the token alone, because pods call it without the edge's identity headers.

## Considered options

- **Inject per-project provider keys.** Rejected: most providers cannot mint scoped keys per project, and a leak is still a full-scope key.
- **Route non-LLM traffic through Bifrost.** Rejected: Bifrost is an LLM gateway; its keys, budgets and revocation are the wrong model for email or webhooks.

## Consequences

- The gateway token is the one credential a pod carries for platform services, so Schedules (cron registration), App readiness (the go-live push) and the external-services agent endpoints all ride it rather than minting their own.
- Gateway keys live in their own table, separate from LLM virtual keys, so Bifrost revocation and budget code never touches them.
- The provider forces the sender identity, so an Agent can send but never impersonate or manage the provider account.
