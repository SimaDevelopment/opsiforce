# Built-in vendor settings live in Service configuration, and every sealed secret is bound to its place

A Built-in External Service needs vendor settings (a receiving domain, a signing key, an API URL) just as a Custom External Service does, and a Custom one keeps them in its Service configuration edited in the UI. The Gate decrypts a Service configuration and hands the plaintext to code an Organization wrote ([ADR-0078](0078-an-external-service-receives-its-secrets-with-each-call-from-the-gate.md)), so a ciphertext that opens anywhere would reach that code.

**Everything about the outside system lives in the built-in's Service configuration. Only facts about the deployment stay environment variables. Every sealed value carries the place it belongs to as AES-GCM associated data.** Concretely:

- **Vendor settings are Service configuration.** Incoming email's receiving domain and Mailgun signing key, and WhatsApp's API URL, are fields of their Service forms, set by the platform operator in the UI. A deployment that still sets the older environment variables has them imported once at boot, while nothing is stored.
- **Deployment facts stay environment variables.** These are the platform's public URL (`OPSIFORCE_PUBLIC_URL`) and the master key (`EXTERNAL_SERVICES_ENCRYPTION_KEY`, which also seals linked accounts). The public URL is never taken from a request's `Host` header. The backend refuses to start without a well-formed key, and the chart refuses to install without one, rather than generating it.
- **A sealed value decrypts only where it was sealed.** Its associated data names the service by its id, its owner (`platform` or the tenant id) and the field path with item ids, for example `<service id>|acme|workspaces.li_x.token`. The id, not the slug: a draft's slug can still change, and a built-in shipped later may take a slug an Organization already uses. A ciphertext copied into another row fails with `secret-unreadable` and never reaches a pod. The copy could come from someone with database write access but no key, or from a save that keeps a stored secret under the wrong item. Without this, database access alone would turn any Organization's secret into plaintext inside another Organization's service.
- **A service is Available only while its Service configuration is valid** against its Service form. Until then it is offered to no Organization, and the Gate refuses its calls. There is no separate on/off switch.

## Considered options

- **Keeping the built-ins' vendor settings in environment variables.** Rejected: built-ins and custom services would differ in shape, and replacing a Mailgun key would need a redeploy.
- **The chart generating the master key on first install.** Rejected: Helm's `lookup` sees nothing under ArgoCD or `helm template`, so every sync would mint a new key and make every stored secret unreadable.
- **An external key manager, and key rotation with a key id in each envelope.** Not adopted now. The Gate decrypts on every call, so a key manager means a network round-trip per call. Rotation helps only after a key leak, and can be added later by reading envelopes without a key id as the first key.
