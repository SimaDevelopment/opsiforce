# Opsiforce Documentation

> Opsiforce is a self-hostable platform that embeds an AI coding assistant (powered by [OpenCode](https://github.com/sst/opencode)). A user converses with an agent inside an isolated Kubernetes pod to build an app, then promotes that app from its working environment to production-like ones. Each running unit, a **ProjectEnvironment**, gets its own pod with persistent storage; a **Project** is the shell that groups them. Vocabulary is in [GLOSSARY.md](../GLOSSARY.md), the *why* behind decisions is in the [ADRs](adr/README.md), and the rules for these pages are in [CONVENTIONS.md](CONVENTIONS.md).

**Runtime** (`runtime/`)
- [Request Flows](runtime/request-flows.md) — how a request reaches the right pod through the edge, the runtime proxies and the ensure gate
- [Pod Lifecycle](runtime/pod-lifecycle.md) — how a pod comes to exist, recovers and suspends, with Kubernetes as the source of truth
- [Pods](runtime/pods.md) — the Admin view of an Organization's running pods and their keep-alive
- [Pending Project Pools](runtime/pending-project-pools.md) — how "New Project" claims an already-running environment
- [Persistence](runtime/persistence.md) — what survives a pod swap, where it lives, resume and cleanup
- [Storage](runtime/storage.md) — how disk usage on the shared volume is measured and attributed
- [Resources](runtime/resources.md) — how a Project's pod size is chosen, stored and applied
- [Pod Tools](runtime/pod-tools.md) — the five processes in a pod and how VS Code and the DB viewer reach the browser
- [Process Log](runtime/process-log.md) — where each pod process's output and lifecycle events go, their rotation and how an Agent reads them

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
- [Template](agent-system/template.md) — the files a Custom Agent's new Projects start with, how they are saved, published and laid
- [Agent Copies](agent-system/agent-copies.md) — Duplicate, Export and Import of an Agent into a new Custom Agent
- [Skill](agent-system/skills.md) — the catalog, the publish gate, Versions and what an Agent pins
- [Dynamic Delivery](agent-system/dynamic-delivery.md) — who writes which file in a workspace, and when a change reaches one
- [Switch off (Skill)](agent-system/switch-off-skill.md) — one environment hiding a Skill from its agent, and the chat bar's Skills popover
- [Platform Skill](agent-system/platform-skill.md) — the shared skill carrying the App contract every Agent runs under
- [Skill & Agent Builder](agent-system/skill-agent-builder.md) — authoring by conversation, one chat per Skill or Agent
- [Test Project](agent-system/test-project.md) — the one Project a Builder chat tests its subject in, and its Update and Reset
- [Agent Updates](agent-system/agent-updates.md) — bringing existing workspaces in line with a newer profile
- [Agent Status](agent-system/agent-status.md) — the Working/Idle signal behind the sidebar spinner
- [Document Generation](agent-system/document-generation.md) — the baked docx, pptx, xlsx and pdf stack and the Generated files convention

**Gateways** (`gateways/`)
- [LLM Gateway](gateways/llm-gateway.md) — Bifrost, per-Project virtual keys, budgets and provider routing: providers and weights of both keys owned by the UI
- [Linked-account Proxy](gateways/linked-account-proxy.md) — the stateless in-cluster proxy that serves signed-in ChatGPT accounts
- [Service Gateway](gateways/service-gateway.md) — one per-environment key for External Services, the runtime proxy and platform pushes
- [Request Logging](gateways/request-logging.md) — how much of an App's traffic the app-mode proxy records

**External services** (`external-services/`)
- [Service manifest](external-services/service-manifest.md) — what an External Service is made of: the folder, `service.json`, its routes and the SDK
- [Gate](external-services/gate.md) — how a pod's call reaches a service's Service host, the Caller identity it carries, and the platform's own form calls and hooks
- [Configuration](external-services/configuration.md) — the Service and Project configurations: storage, sealing, Available, saves, Rotate and after-save hooks
- [Event](external-services/events.md) — webhooks into Events: the Webhook address, delivery to chosen environments, the per-environment store and the doorbell
- [Call log](external-services/call-log.md) — what each call records, retention, Usage and who reads them
- [Service skill](external-services/service-skill.md) — a service's Skill in the Store, given per Agent or per configured Project, and how it reaches Projects
- [External Service Builder](external-services/external-service-builder.md) — writing, testing, publishing and retiring a Custom External Service, and its Default environment
- [Service copies](external-services/service-copies.md) — Duplicate, Export and Import of a Custom External Service as a new service
- [Public API built-in](external-services/public-api.md) — `/api/v1` as the `public-api` External Service a pod calls on its Service host
- [Incoming Email](external-services/incoming-email.md) — a receiving address per environment
- [WhatsApp](external-services/whatsapp.md) — numbers in the Service configuration, chats per environment, the v1 import

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
- [Model provider](organization/model-provider.md) — where an Organization's model requests go, per Base format, and how a save reaches its Projects' keys, for Agents and for Apps
- [Custom model provider](organization/custom-model-provider.md) — adding, testing, editing, re-entering and deleting an Organization's own providers
- [Opsiforce model provider](organization/opsiforce-model-provider.md) — the platform providers every Organization gets, global `opsiforce-*` providers and the fresh-install seed
- [Model provider access](organization/model-provider-access.md) — which Organizations get each Built-in, and the access dialog
- [Azure connection](organization/azure-connection.md) — connecting an Azure AI Foundry resource as a model provider
- [Linked account](organization/linked-account.md) — signing a ChatGPT account in as a Model provider, and what ends a sign-in
- [Defaults](organization/defaults.md) — what platform and Organization defaults seed and leave out
- [Limit](organization/limit.md) — the most an Organization may hold, the platform value it follows and how creates enforce it
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
- [Air-Gapped Single-Node Deployment](operations/air-gapped-single-node.md) — client-provided host packages, container images, repositories, and network access for one disconnected machine
- [Cut over from Helm](operations/cutover-from-helm.md) — move an existing environment's traffic onto Settings → Model providers and `custom-openai-1` off the Codex OAuth Dock, steps 1–6 with their checks
- [Upgrade opencode](operations/upgrade-opencode.md) — move the agent image to a new opencode build
- [Migrate process logs to files](operations/migrate-process-logs-to-files.md) — move existing workspaces off the `process_logs`/`process_events` tables, from the backend pod
- [Roll out the Agent & Skill Platform](operations/agent-skill-platform-rollout.md) — the per-environment values, the image bump and the checks that prove delivery works
- [Add a permission](operations/add-a-permission.md) — Pulumi, frontend and backend steps
- [Add an external service](operations/add-an-external-service.md) — a folder with a Service manifest, its `service.ts` and a Service skill, and one commit
- [Onboard a WhatsApp number](operations/onboard-a-whatsapp-number.md) — Whapi channel, the number item, QR link, picking chats
