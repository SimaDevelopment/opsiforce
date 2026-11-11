# Agent pods reach only the platform services they call and the internet, and only platform roles reach them

One static NetworkPolicy, `opsiforce-agents` in `helm/opsiforce/templates/`, selects every `app=opsiforce-agent` pod and is installed with the infrastructure chart. Agent pods may open connections to DNS (port 53), to pods labelled `opsiforce.io/serves-agent-pods` (the backend and the agent runtime proxy), to Bifrost on 8080, to the ingress controller's namespace (Service hosts and every App's Public URL) and to any address outside the private ranges (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`, the last covering cloud metadata). Pods labelled `opsiforce.io/controls-agent-pods` (the backend) may reach every port of an agent pod, pods labelled `opsiforce.io/reaches-agent-pods` (the five runtime proxies) only OpenCode, the App, code-server and Datasette, and nothing else may reach an agent pod at all, other agent pods included. Agent pods mount no Kubernetes API token. The Skill & Agent Builder opens its Test Project's App at its Public URL, through Traefik and the app proxy like any visitor, so no agent needs another agent's pod.

We chose this because agents run arbitrary code, and without it any agent can drive another Organization's OpenCode (agent-control adds the password to every request), open its code-server (`--auth none`) and Datasette, and call Postgres, Redis, Keycloak and the runtime proxies behind the edge's identity check. A Kubernetes NetworkPolicy keyed on labels needs no per-Project objects, and the role labels sit on the callers' own charts, so release names (`opsiforce-backend-<suffix>` on hosted clusters, `opsiforce-backend` locally) never enter the policy. The Builder's browser was the only flow that reached a child pod; the Public URL checks the App the way a user meets it (app proxy, App Auth, cookie stripping) instead of the bare dev server.

## Considered options

- **Select callers by their `app` label.** Rejected: the label carries the Helm release name, which differs per environment, and the infrastructure chart does not know the other releases.
- **A policy per Project or per Organization.** Rejected: a NetworkPolicy cannot express "same Organization", so this means objects the backend creates and garbage-collects for every Project, for a relation no agent flow needs.
- **Let Builder pods reach other agent pods' App port.** Rejected: a NetworkPolicy cannot narrow it to the Builder's own Test Project, so every Builder could read every Organization's Apps while skipping App Auth, which only the Go app proxy enforces.
- **Run the Builder's browser inside the Test Project.** Rejected: Chromium would compete with the App it judges for the child's CPU, and every screenshot would have to be copied back to the Builder.

## Consequences

- Locally, CoreDNS sends `*.apps.opsiforce.localtest.me` to Traefik, and agent-browser accepts the local certificate through its own backend setting, because Chromium does not read the pod's CA bundle; a hosted cluster that mounts its own CA bundle keeps certificate checks.
- On the first deploy the policy goes live about a minute before the backend and the runtime proxies carry their labels, so chat, Apps and pod gateway calls fail for that minute, once.
- The policy is only as strong as the cluster's network plugin: a CNI without NetworkPolicy support ignores it silently. The local kindnet enforces it, but not for traffic to the node's own address, so a local agent still reaches the kube-apiserver and kubelet there.
- A new platform service that agent pods call needs `opsiforce.io/serves-agent-pods`, and one that calls agent pods needs `opsiforce.io/reaches-agent-pods` (or `controls-agent-pods` for the control port), or its calls time out.
- Anyone who can create a pod in the namespace can give it a role label; the policy separates agents from the platform, not namespace administrators from agents.
