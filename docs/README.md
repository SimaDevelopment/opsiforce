# Opsiforce Documentation

> Opsiforce is a self-hostable platform that embeds an AI coding assistant (powered by [OpenCode](https://github.com/sst/opencode)). A user converses with an agent inside an isolated Kubernetes pod to build an app, then promotes that app from its working environment to production-like ones. Each running unit, a **ProjectEnvironment**, gets its own pod with persistent storage; a **Project** is the shell that groups them. Vocabulary is in [CONTEXT.md](../CONTEXT.md), the *why* behind decisions is in the [ADRs](adr/README.md), and the rules for these pages are in [CONVENTIONS.md](CONVENTIONS.md).

**Runtime** (`runtime/`)
- [Request Flows](runtime/request-flows.md) — how a request reaches the right pod through the edge, the runtime proxies and the ensure gate
- [Pod Lifecycle](runtime/pod-lifecycle.md) — how a pod comes to exist, recovers and suspends, with Kubernetes as the source of truth
- [Pods](runtime/pods.md) — the Admin view of an Organization's running pods and their keep-alive
- [Pending Project Pools](runtime/pending-project-pools.md) — how "New Project" claims an already-running environment
- [Persistence](runtime/persistence.md) — what survives a pod swap, where it lives, resume and cleanup
- [Storage](runtime/storage.md) — how disk usage on the shared volume is measured and attributed
- [Resources](runtime/resources.md) — how a Project's pod size is chosen, stored and applied
- [Pod Tools](runtime/pod-tools.md) — the five processes in a pod and how VS Code and the DB viewer reach the browser

**Projects** (`projects/`)
- [Environments](projects/environments.md) — the two-entity model, public URLs, App Auth and the Environments switcher
- [Publish](projects/publish.md) — moving an App from Development into an environment, Environment Variables and the publish stages
- [Duplication](projects/duplication.md) — copying a whole Project with its working state
- [Export and Import](projects/export-import.md) — carrying a Project to another deployment as a file
- [App](projects/app.md) — per-environment App Details and runtime identity
- [App Readiness](projects/app-readiness.md) — how Go-live and serving are pushed from the pod
- [Schedule](projects/schedule.md) — agent-registered cron jobs owned by one environment
- [Files](projects/files.md) — the curated view of an environment's workspace files, uploads and deletes
- [File preview](projects/file-preview.md) — reading a deliverable in the side panel and the inline content endpoint
- [File Downloads](projects/file-downloads.md) — how a `/workspace/...` chat link becomes a download
- [Dictation](projects/dictation.md) — speech into the prompt draft and what decides availability

**Agent system** (`agent-system/`)
- [Agent](agent-system/agent.md) — the profile, how it reaches a workspace, the model and the model catalog
- [Custom Agents](agent-system/custom-agents.md) — the Agents an Organization authors, one Profile per Environment, publishing and retiring
- [Skill](agent-system/skills.md) — the catalog, the publish gate, Versions and what an Agent pins
- [Dynamic Delivery](agent-system/dynamic-delivery.md) — who writes which file in a workspace, and when a change reaches one
- [Platform Skill](agent-system/platform-skill.md) — the shared skill carrying the App contract every Agent runs under
- [Skill & Agent Builder](agent-system/skill-agent-builder.md) — authoring by conversation, chat visibility and the test Project
- [Agent Updates](agent-system/agent-updates.md) — bringing existing workspaces in line with a newer profile
- [Agent Status](agent-system/agent-status.md) — the Working/Idle signal behind the sidebar spinner
- [Document Generation](agent-system/document-generation.md) — the baked docx, pptx, xlsx and pdf stack and the Generated files convention

**Gateways** (`gateways/`)
- [LLM Gateway](gateways/llm-gateway.md) — Bifrost, per-Project virtual keys, budgets and provider routing
- [Codex Proxy](gateways/codex-proxy.md) — the host-run subscription bridge the standalone stack uses
- [Service Gateway](gateways/service-gateway.md) — one per-Project token for non-LLM services and platform pushes
- [Request Logging](gateways/request-logging.md) — how much of an App's traffic the app-mode proxy records

**External services** (`external-services/`)
- [Service template](external-services/service-template.md) — the audience-first routes, ingest, storage, doorbell and metering every inbound service plugs into
- [Incoming Email](external-services/incoming-email.md) — a receiving address per environment
- [WhatsApp](external-services/whatsapp.md) — platform-global channels and per-environment chat allowlists

**Public API** (`public-api/`)
- [API Token](public-api/api-token.md) — who calls the API, how a program signs in and which Organization it acts in
- [Connection](public-api/connection.md) — connecting to an environment and then talking to its Agent in native opencode
- [Public API contract](public-api/contract.md) — the resources, Errors, the compatibility policy and where it is built

**Organization** (`organization/`)
- [Settings](organization/settings.md) — the configuration surface and how its sections are gated
- [Admin](organization/admin.md) — the operational surface and its pages
- [Permissions](organization/permissions.md) — how permissions flow from the identity provider and what the backend enforces
- [Workspaces](organization/workspaces.md) — grouping Projects, membership-based visibility and moves
- [Folder](organization/folder.md) — a single-level label for Projects inside a Workspace
- [Defaults](organization/defaults.md) — what platform and Organization defaults seed and leave out
- [Integrations](organization/integrations.md) — mapping an Organization to its managed identity provider tenant

**Frontend** (`frontend/`)
- [OpenCode Embed](frontend/opencode-embed.md) — how OpenCode's chat renders inline and reaches the pod
- [Query Adapter](frontend/query-adapter.md) — why reads use `createAppQuery` and what it changes
- [Job Dock](frontend/job-dock.md) — one progress surface for publish, duplicate, export and import

**Backend** (`backend/`)
- [Testing](backend/testing.md) — what the backend tests drive, what is real and what is faked

**Operations** (`operations/`)
- [Quickstart](operations/quickstart.md) — stand up the local stack with `yarn dev`
- [Commands](operations/commands.md) — day-to-day checks, database tasks and local ports
- [Local orchestration](operations/local-orchestration.md) — the tunnel, Tilt and the static identity
- [Deployment](operations/deployment.md) — ship to a cluster through CI in dependency order
- [Deploy to Azure (AKS)](operations/deploy-azure.md) — the platform contract for self-hosting on Azure
- [Upgrade opencode](operations/upgrade-opencode.md) — move the agent image to a new opencode build
- [Roll out the Agent & Skill Platform](operations/agent-skill-platform-rollout.md) — the per-environment values, the image bump and the checks that prove delivery works
- [Add a permission](operations/add-a-permission.md) — Pulumi, frontend and backend steps
- [Add an external service](operations/add-an-external-service.md) — one definition, one barrel line, one skill
- [Onboard a WhatsApp number](operations/onboard-a-whatsapp-number.md) — provider channel, registration, allowlisting
