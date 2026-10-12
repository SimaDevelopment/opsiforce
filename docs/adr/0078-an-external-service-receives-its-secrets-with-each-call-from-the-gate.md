# An External Service receives its secrets with each call from the Gate, and trusts only calls carrying its own Gateway Key

A Custom External Service runs as an App in a pod whose one container also holds an Agent, its shell and code-server, all as root with one shared environment, and an App's port is reachable from any pod in the cluster. So any secret that sits in the pod can be read by the Agent there, and a service that holds secrets could be driven by any pod that reaches its address, past every check of the Gate.

**The backend keeps every `secret` field sealed, and the Gate decrypts the Service configuration and hands it to the service inside each call it forwards, together with the Project configuration; the service trusts a call only when it carries that pod's own Gateway Key.** Concretely:

- **Every entry point is a call from the backend.** Operations, option callbacks, info, buttons, after-save hooks and verification of what arrives all carry `context.serviceConfiguration`, and those made for a ProjectEnvironment carry `context.projectConfiguration` too. Nothing is fetched at start, cached by the platform in the pod or written to its volume, so a saved or rotated value applies at the next call. A Built-in External Service receives the same context in-process.
- **A call carries only the items its Project configuration uses.** A `list` field is cut down to the items that the Project configuration references through options taken from the Service configuration. A Project given WhatsApp's Sales number never receives the Support number's token. Top-level fields and lists that no Project field references travel whole. A Service-form callback or button receives the item being edited, and verification of what arrives receives the whole Service configuration because no Project is known yet.
- **The Gate proves itself with the target pod's own Gateway Key.** It sends that ProjectEnvironment's `service` key as `x-opsiforce-gate`, and the SDK rejects any request without a constant-time match against `SERVICE_GATEWAY_API_KEY` before a handler runs. Only the backend and that pod hold the key, and Development and Production hold different ones, so a pod that guesses a service's address gets `401`.
- **Secrets are guarded against accidents, not against the people who build the service.** The SDK hands each `secret` field over as a `Secret` whose JSON and string forms are masked, and the Gate fails a call whose response body contains any secret value it sent, so an Agent calling the service never receives one. The call log never stores a call's context. The builder Agent shares a container with the Organization's real secrets and can reveal them on purpose, so only holders of `can_manage_tenant_external_services` may build a Custom External Service. That is the same permission that sets its Service configuration.

A Custom External Service's own pod is therefore the one App that sees provider secrets ([ADR-0044](0044-apps-reach-non-llm-services-through-the-backend-owned-service-gateway.md)); the Apps that call it never do.

## Considered options

- **Fetching the Service configuration once at start with the pod's Gateway Key and holding it in memory.** Rejected: anything in the pod holding the key could fetch the secrets at will, a reload channel would be needed for every save, and a service holding secrets in memory would act on them for any caller that reached its address.
- **Never letting secrets into the pod: the backend sends each outgoing request and fills secrets in only for hosts the Service manifest allows.** Rejected as the mechanism: a database driver speaks its own wire protocol, not HTTP, and many vendor SDKs accept no custom fetch. A reporting database could not be served at all.
- **Writing secrets into the App's Environment Variables file.** Rejected: that file is plaintext on the volume, and every save restarts the App.
- **A Production pod for a service that runs only the App.** Rejected: a service's ProjectEnvironments stay like every other Project's. The building permission already limits who reaches them.
- **Signing each call with an HMAC over body, time and call id, or a NetworkPolicy admitting only the backend.** Not adopted now: the key check stops every forged caller in a cluster whose pod traffic cannot be read, and it works on clusters whose network plugin enforces no policies. A NetworkPolicy remains possible as a second layer.

## Consequences

- A service cannot keep a long-lived connection to its outside system (Slack Socket Mode, a Discord gateway) open between calls, because it has no secrets between calls. Pods are suspended when idle anyway.
- The master encryption key is used on every call through the Gate, not only when a configuration is saved.
