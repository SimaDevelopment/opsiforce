# Agent pods are reached by DNS name; the database stores no address

Every call to an agent pod, from the Go runtime proxies, the Gate and the backend alike, connects to `<pod name>.opsiforce-agents.<namespace>.svc.cluster.local`. One headless Service, `opsiforce-agents` in `helm/opsiforce/templates/` (`clusterIP: None`, `publishNotReadyAddresses: true`, selecting `app=opsiforce-agent`), and the pod's `hostname` and `subdomain` give each pod that name; cluster DNS keeps it pointing at the pod's current IP. A ProjectEnvironment's status alone says whether its pod is running (`active` on an enabled Project), and a pool claim asks the pod informer which slots are Ready. Nothing in the database holds a pod address, so nothing has to be repaired when one changes.

The runtime proxies and the backend present every request to a pod as `Host: localhost:<port>`: the pod name is only where they connect. The public address still reaches the App in `X-Forwarded-Host` and `X-Forwarded-Proto`, and the Gate keeps the caller's `Host`. The backend calls pods on `node:http` because Node's `fetch` drops a `Host` it is given.

We chose this because a stored IP goes stale whenever a pod comes back on a restarted node with a new address while keeping its name: no delete event fires, and every reader that trusts the row calls an address that now times out or, worse, belongs to another tenant's pod. Kubernetes already resolves names to current addresses; the platform only has to ask by name. `localhost` is the one host every common dev server accepts by default (Vite, webpack-dev-server, Django with empty `ALLOWED_HOSTS`), and an App may be built on any stack. It is not a security boundary: App Auth runs in the Go proxy before the request is rewritten, and the App's backend already sees every request from inside the pod.

## Considered options

- **A Service per pod.** Rejected: one Kubernetes object to create, garbage-collect and watch per environment, for a name a pod's `hostname` and `subdomain` give for free.
- **Keep the IP and repair it on every path.** Rejected: each reader needs its own repair, and a reader without one retries a dead address indefinitely.
- **Present the public `Host` to the pod.** Rejected: every stack with a strict host check would need per-App configuration naming the platform's domains.
- **A front door inside the pod on port 3000.** Rejected: an App that hard-codes 3000 instead of `$APP_PORT` would collide with it.

## Consequences

- A pod created without `hostname` and `subdomain` has no DNS name; deleting it lets the delete watcher recreate a running environment's pod with one ([ADR-0019](0019-externally-deleted-pods-recreated-eagerly.md)).
- Disabling a Project suspends its environments, so status alone is never `active` without a pod being expected.
- The headless Service makes the list of agent pods one DNS query away inside the cluster.
