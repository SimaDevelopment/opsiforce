---
kind: operations
---

# Roll out the Agent & Skill Platform

> Deploy the Agent & Skill Platform to an environment and confirm the Store, the Builder and delivery all work there.

## Prerequisites

- The backend image built from this branch. It ships the whole `agent-config/` tree, so the Built-in Skill reconciler has something to read; a backend built without it refuses to boot rather than presenting an empty catalogue.
- The agent image built and pushed at the tag in `agent-config/agent-image-version.json`, **after** that file was bumped, and available to the cluster before the backend that names it. A Job that runs an older image than the backend names writes that image's content and stamps it with the new content version, and the sweep compares only the stamp — so the workspace is left stale and will not self-correct.
- Migrations `0062_agent-skill-platform-schema` through `0072_tenant-disabled-agents-and-skills` unapplied on the target database; the backend runs them on start.
- Every per-environment value the platform needs set for this environment. `.github/workflows/opsiforce.yml` sets them on the Helm upgrade, each naming a Service directly rather than the identity proxy:

  | Helm value | Environment variable | What it is |
  |---|---|---|
  | `config.gatewayUrl` | `SERVICE_GATEWAY_URL` | The backend's `/api/gateway` |
  | `config.platformApiUrl` | `OPSIFORCE_API_URL` | The backend's `/api/v1`, for a pod's Agent Caller |
  | `config.runtimeProxyUrl` | `OPSIFORCE_RUNTIME_PROXY_URL` | The agent runtime proxy, for a Builder reaching a child |
  | `config.externalServicesUrl` | `EXTERNAL_SERVICES_URL` | The external-services endpoints |
  | `config.backendUrl`, `proxy.backendService` | — | The backend the proxies resolve |

  `config.platformApiUrl` and `config.runtimeProxyUrl` have no defaults. An environment that mints a `platform-api` key without both refuses to spawn the pod, so a missing value fails at creation rather than inside an agent.

## Steps

1. Deploy the backend. It applies the migrations, reconciles the Agent registry, then reconciles the image's Skills into `skills` / `skill_versions` / `skill_version_files` and logs how many it found. Zero is a packaging fault, not an empty catalogue — the boot assertion should already have stopped it.
2. Set the agent image tag for the environment. Running pods keep the image they started on; nothing is recreated by this step.
3. Let the boot sweep run. It walks **every** ProjectEnvironment of every Agent and enqueues the ones whose ledger is behind the registry's content version, `full` on each Agent's default Environment and `content` everywhere else ([Agent Updates](../agent-system/agent-updates.md)). Jobs are TTL-cleaned within seconds, so read `project_agent_updates` rather than `kubectl get jobs`.
4. Confirm the `platform` Skill landed in a Project of each kind — a Built-in Agent's Project on a published Environment, and a Custom Agent's Project — by reading `GET /api/skill` on each pod's `:4096` proxy.
5. Open the Store as a member holding neither manage permission, then as one holding `can_manage_agents`, and confirm the tabs each sees.

## Verify

- `grep -rl '0060' docs/ --include='*.md'` names exactly one page's frontmatter, and the same for every ADR of this effort; no term appears in two pages' `terms`.
- `GET /api/v1/skills?filter=built_in` returns the image's Skills, `platform` among them, on the deployed environment — not `{"items":[]}`.
- From inside a Builder chat's pod, `sh /workspace/scripts/api.sh call GET /me` answers with the chat's creator, `source: gateway-key` and the chat's `builderSubject`. Backend health does not cover this: the pod reaches a different Service.
- A Builder chat and its test Project are absent from `GET /api/v1/projects`, from the sidebar and from every workspace list, while `GET /projects/{id}` answers for whoever may see the chat's Skill or Agent.
- Adding a Skill to a Built-in Agent in the Store reaches a running Project's pod within seconds, with the pod's UID and restart count unchanged.
