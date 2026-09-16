# Opsiforce

AI coding-assistant platform: users converse with an agent inside a Kubernetes pod to build apps, and can promote those apps from a working environment to production-like environments.

## Language

### Organization

**Organization**:
The top-level customer account a user works inside — owner of its Workspaces, Users, Billing, Defaults, Integrations, and Environment registry. A user may belong to several and switches between them in the selector (shown by display name and a building mark). Its technical name is **tenant** — the `tenants` table, the `*_tenant_*` permissions, the API — which must never surface in user-facing copy. Prefer omitting the noun entirely where context already makes the scope obvious.
_Avoid_: Tenant (internal name only — never user-facing); Account (collides with the user's login); Workspace (a grouping *within* an Organization, not the Organization itself)

**Folder**:
A named, single-level grouping of Projects within a Workspace — an organizational label, not ownership: deleting a Folder releases its Projects to the Workspace; an empty Folder is fine. A Project sits either directly in its Workspace or in exactly one of its Folders, and a Folder's name is unique within its Workspace. Folders exist in shared Workspaces and the private Personal Workspace, never in Public. Moving a Folder to another Workspace carries its Projects and follows the same rules as moving the Projects themselves.
_Avoid_: Group (vague — collides with UI grouping); Directory (filesystem connotation); Subfolder, nested folders (out of scope — one level only)

### Projects & Environments

**Project**:
The durable shell a user owns — identity, ownership, and cross-environment policy. It holds no running state of its own; it groups one or more ProjectEnvironments, each running its own App.
_Avoid_: App (a Project is not the thing that gets built — it groups several; see App)

**Environment**:
A tenant-scoped, named target a Project can run in (name + description). Every tenant has two protected Environments — **Development** and **Production** — created with the tenant; admins add others (e.g. Staging). A protected Environment cannot be renamed or deleted. The set of Environments is the list of publish targets offered to every Project in the tenant.
_Avoid_: Tier, Target, Deployment target

**Environment Slug**:
The short, immutable, URL-safe identifier an Environment carries alongside its name, shown as the environment suffix in an App's public URL. Fixed for the protected Environments (`dev` for Development, `prod` for Production); for a custom Environment it is prefilled from the whole name at creation and editable that one time before saving (it must be unique within the tenant), then immutable — renames never change it, so published URLs outlive renames. The slug is an identifier, not user-facing copy, so the "avoid Prod" rule does not apply to it.
_Avoid_: Suffix (its position in the URL, not the concept); Short name; Code

**Environment Color**:
The color an Organization gives an Environment as its visual identity — the one hue that stands for that Environment wherever environments are shown at a glance (today, the environment markers beside a Project in the sidebar). Every Environment has one: the protected Development and Production Environments are seeded with defaults, and any Environment's color — protected ones included — can be changed by an admin from the Environment registry in Settings. It answers *which* Environment this is, and is deliberately a different axis from the status colors that signal *how* a running environment is doing (active, starting, suspended, failed) — a suspended Production is still "Production" and keeps its color.
_Avoid_: Status color (the orthogonal running-state axis, not identity); Label color; Theme; Tag

**ProjectEnvironment**:
A per-Project instance of an Environment — the thing that actually runs. It owns the runtime state (its files, pod, URLs, and service-gateway key); it shares the Project's LLM virtual keys rather than owning its own. Every Project has one bound to Development; publishing creates additional ones bound to other Environments.
_Avoid_: Instance, Deployment, Env

**Development**:
The default protected Environment present in every tenant. Every Project's working ProjectEnvironment is bound to it. It is never the destination of a publish and cannot be renamed or deleted.
_Avoid_: Dev env, working copy

**Production**:
The second protected Environment present in every tenant — the conventional target for publishing the App's live version. Beyond being guaranteed to exist and protected from rename/delete, it behaves like any other publish target.
_Avoid_: Prod (non-canonical in user-facing copy); Live

**App**:
The application the agent builds inside a ProjectEnvironment, served at that environment's public URL. Each ProjectEnvironment runs its own App, carrying its own App Details — so one Project groups several Apps (one per environment), the same source captured at different published moments. Distinct from the Project (the shell that groups them).
_Avoid_: Project (when you mean the built application); "one App per Project" (retired — each ProjectEnvironment is its own App)

**App Details**:
An App's human-facing identity — its name and description — carried per ProjectEnvironment, since each environment is its own App. First published by the agent when that environment's App goes live, then re-curated by humans against whichever environment they are viewing; the running App reads its own name at runtime. A published App's Details begin as a copy of Development's at publish and evolve independently afterwards.
_Avoid_: App metadata (vague); Project title (the Project shell's label — a different thing); project-level identity (retired — App Details belong to each App/environment, not the Project)

**Go-live**:
The moment an App first exists and is running in a ProjectEnvironment — for Development, when the agent finishes the first feature, it builds and boots, and the agent publishes App Details; for a published environment, when its freshly-deployed pod first serves. Go-live is decoupled from "done": it happens before the agent's feature testing, which follows with the App already live. Each environment goes live independently. Before its App goes live an environment has a pod but no App; that environment's app pane appears only once it happens.
_Avoid_: Detection (the platform's inward-facing name for noticing the same moment); App ready, Launch; Deploy/Publish (which moves an already-live App between Environments)

**Publish**:
The act of materializing or updating a non-Development ProjectEnvironment from the Development one's files, so the App runs in a chosen Environment. Publishing over an already-running environment is a **Publish update**.
_Avoid_: Deploy, Release, Promote, Redeploy

**Duplicate**:
Creating a new Project in the same tenant and workspace from an existing one, preserving its working state in full — App source and history, the agent conversation, the App's databases, Environment Variables, settings, Resources, and App Details. The duplicate is independent: it gets its own keys, and its Schedules arrive **paused** so no automation fires twice. Only the Development ProjectEnvironment is duplicated — published environments are re-created by publishing from the duplicate.
_Avoid_: Copy, Clone, Fork (non-canonical); conflating with Publish (which transports App source only, never working state)

**Export**:
Producing a Project export from a Project's Development working state, to carry it to a *different* Opsiforce deployment. The cross-deployment sibling of Duplicate — same bundle and carry-rules — but the destination is another instance reached through a file rather than a local copy. Only the Development ProjectEnvironment is exported.
_Avoid_: Share; Download (the chat file-download is a different feature); conflating with Publish (which moves App source between Environments within one deployment) or Duplicate (same-deployment copy)

**Import**:
Creating a new, independent Project on this deployment from a Project export — the consume side of Export. The result behaves like a freshly duplicated Project: its own keys, Schedules paused.
_Avoid_: Restore (implies returning to the deployment it left); Upload (the transport, not the act)

**Project export**:
The opaque, versioned file an Export produces and an Import consumes — a sealed copy of a Project's Development working state, meaningful only when imported back into an Opsiforce deployment, never read or edited on its own.
_Avoid_: Workflow (colloquial — maps to no entity; the exported unit is a Project); Workspace export (Workspace is the Org-level project grouping, a different thing); Blueprint, Template, Package (non-canonical)

**Active environment**:
The one ProjectEnvironment the project workspace is currently showing — chat, code, DB, and the app pane all follow it. Chosen by clicking an environment in the Environments panel, or via **View environment** after a Publish completes; defaults to Development. Viewing changes nothing about the environment itself — it only re-points the workspace.
_Avoid_: Current env, Selected env (spell out "environment"); conflating with Development (the default, not a synonym)

**Environment Variables**:
The per-ProjectEnvironment configuration values (string keys and values) the App reads when it starts — API keys, base URLs, flags. Each ProjectEnvironment carries its own set; values are set at publish or edited directly per environment, and changes take effect only when the App restarts.
_Avoid_: Secrets (they may hold secrets but are not only secrets); the pod's process env (platform plumbing, a different thing)

**Restart (environment)**:
Recreating a ProjectEnvironment's pod from scratch — the row-level Restart action. Distinct from the lighter **App restart** that applying Environment Variables performs, which restarts only the App's processes inside the running pod.
_Avoid_: Reboot; conflating with App restart

**App Auth**:
Per-ProjectEnvironment control over how visitors sign in to the App at that environment's URL — one of **public** (anyone), **manual** (the owner's own OIDC provider), or **managed** (a shared identity provider configured by the platform operator, scoped to the tenant). Each ProjectEnvironment carries its own; a newly published environment is **seeded once** from Development's setting at first publish, then managed independently per environment.
_Avoid_: Project auth (it is not project-wide — each environment has its own); Login, SSO (non-canonical)

**Auth mode**:
The chosen App Auth setting for one ProjectEnvironment — `public`, `manual`, or `managed` (the stored identifier is `auth_mode`).
_Avoid_: Auth type, Auth provider

**Resources**:
The CPU/memory size of a Project's agent pod, chosen as a class — Small, Medium, Large, or Custom. A project-level policy: one choice applies to every one of the Project's ProjectEnvironment pods (Development and any published target alike).
_Avoid_: Pod class (the internal identifier — never user-facing); Environment size (collides with Environment); Tier, Machine size, Compute (non-canonical — say Resources)

### Agents

**Agent**:
The AI coding assistant a user converses with inside a ProjectEnvironment's pod. The platform ships one — **app-builder** — as the default. An Agent is a profile: identity, instructions, skills, and the Model it runs on.
_Avoid_: Bot, Assistant (non-canonical)

**Agent Model**:
The LLM an Agent runs on. A platform-level property of the Agent profile, uniform across every tenant and Project — not a tenant- or project-configurable setting. Changing it is a platform rollout, not a default anyone tunes.
_Avoid_: Default model (it is **not** a configurable default — Defaults covers timeouts and budgets only)

**Agent Status**:
Whether an Agent is **Working** — processing a run it was prompted to do, including any mid-run provider retries — or **Idle** (no run in flight; a suspended or absent pod is simply Idle, not a third state). Carried per ProjectEnvironment, since each environment has its own Agent; a Project counts as Working when any of its environments' Agents is, shown at-a-glance beside the project in the sidebar. Distinct from Keep-alive's *agent activity*, which is the user's traffic touching the pod — not the Agent thinking.
_Avoid_: Agent activity (a Keep-alive kind — user-driven traffic, a different concept); Busy (the engine's wire value, not user-facing copy); Running (collides with pod lifecycle)

**Prompt**:
The single chat input a user composes and sends to the Agent — one turn's worth of instruction. Sending a Prompt is the canonical act of interacting with a Project's Agent, distinct from merely viewing or navigating the Project. A Prompt sent while the Agent is already working is either _steered_ (folded into the running turn) or _queued_ (starts the next turn once the Agent is idle); a queued Prompt waits until a new turn begins.
_Avoid_: Message (ambiguous — also covers the Agent's reply); Query, Command

**Dictation**:
Speaking into the chat instead of typing — a recording made from the prompt's mic button is transcribed to text and inserted into the prompt draft for review; nothing is sent until the user sends. The audio is transient input, never a stored artifact. The spoken language is auto-detected by default, with an explicit per-browser language override.
_Avoid_: Voice message (implies the audio itself is attached or kept); Voice chat, Speech-to-text (the mechanism, not the feature); Transcription (the backend step, not the user-facing act)

**Session**:
The primary OpenCode conversation a ProjectEnvironment carries — the durable thread of Prompts and Agent replies every surface shares. "Prompting a Project" means prompting that environment's primary Session; the UI, a program connecting through the public API, and any channel wired to the Project all read and write the same thread. The platform resolves and remembers the binding during a Connection; a caller never has to pick it. Other native Sessions may exist in the environment — opencode allows them and a native client can create them — and they are not the platform's concern: they never become the primary one.
_Avoid_: Chat, Conversation, Thread (non-canonical); Run (Trello shorthand for a Project)

**Connection**:
The act of making a ProjectEnvironment's OpenCode runtime usable, and the descriptor that answers it. One operation behind both the app and the public API: it authorizes the Project, wakes the environment inside a single budget, resolves and persists the primary Session, and reports where the runtime is (`baseUrl`, `openapiUrl`), which Session to open, and which build answered. A successful Connection describes a runtime that is usable now — not a promise it will not restart.
_Avoid_: Handshake, Session open (a Connection binds a Session, it does not create the conversation); Attach

### Files

**Files**:
The project workspace tab where a user sees and manages the Active environment's workspace files — User uploads, Generated files, and any stray files the Agent left at the workspace root — with folder drill-down and breadcrumbs. Visible to every project member; the App's source, platform data, and dotfiles never appear in it.
_Avoid_: File browser, File manager (dev-tool connotation — it is a curated view, not the filesystem); Workspace (the Org-level Project grouping — a different thing)

**User uploads**:
Files a user added to a ProjectEnvironment — attached in chat or uploaded from the Files tab — kept durably in the environment's upload area with their original folder layout preserved.
_Avoid_: Attachments (implies message-scoped; uploads are durable workspace files, not parts of a Prompt)

**Generated files**:
The Agent's finished deliverables — documents, reports, exports — saved by convention into the environment's designated output folder, which the Files tab surfaces as its own section. The folder comes into existence on first write; deliverables the Agent drops elsewhere still surface in the tab as other files.
_Avoid_: Artifacts (claude.ai's concept — different mechanics); Outputs (vague); Generated app (the App source — a different thing entirely)

**File preview**:
Reading a finished workspace file in the project's right side panel instead of downloading it — opened by clicking a file link the Agent posted in chat, or a file in the Files tab. It shares the panel with the App preview through an App | File switcher, shows one file at a time, and never opens or switches modes on its own. Formats outside the supported set are not an error state: they offer a download instead.
_Avoid_: Artifact preview (implies claude.ai's streaming artifacts; this is finished files only); Viewer, File viewer (suggests a separate surface — it is the same panel the App preview uses); App preview (the running App in that panel — the other mode, not this one)

**Document conversion**:
Turning a Word or PowerPoint deliverable into a PDF so File preview can render it, on a shared in-cluster converter the Agent cannot reach. It runs as a job — the panel is told a conversion is pending, then shown the PDF — and the result is transient, so reopening the same file converts it again. An unconvertible document offers a download instead of failing.
_Avoid_: Export (the Project Export & Import feature — a different thing); Rendering (the browser-side half of File preview); Caching, Cached PDF (there is no conversion cache — results are job plumbing)

### Schedules

**Schedule**:
A recurring cron job an agent registers against an endpoint in the App, owned by **one ProjectEnvironment** — it fires only against that environment's running App. Publishing copies Development's chosen schedules into the target environment, so a same-named schedule can exist and fire **independently** in several environments (the copies are intentional, not duplicates).
_Avoid_: Cron job (the mechanism, not the domain concept); Job (collides with BullMQ jobs and publish jobs)

### Public API

**API Token**:
The credential a program — the CLI, an integration, another Agent — presents to call the public API on a user's behalf. Today it is the bearer token the deployment's identity provider issues when that user signs in, so it carries exactly the Organization memberships and permissions they hold in the UI; a token issued by Opsiforce itself is a possible later form of the same concept. The public API selects the Organization it acts in with the same organization header the UI already sends (implicit when the caller belongs to exactly one), and its documentation speaks of Organizations, never of the internal tenant vocabulary.
_Avoid_: Client key; API key (non-canonical); Personal access token (canonical only in other products); Tenant header (internal name — never user-facing)

**Error**:
The public API's single error shape: every failed call, whatever its cause, answers with an Error that names the kind of failure (a stable, deployment-independent identifier a program can branch on), a fixed title for that kind, a per-occurrence explanation written for the caller, and the request id so support can find the call. It is the shape of `/api/v1` only — a failure on the runtime path is OpenCode's own error, or the edge's.
_Avoid_: Problem, Problem Details (the RFC's own words for the format — the media type stays `application/problem+json`, but the concept is called an Error here); Exception (internal, never crosses the API boundary)

### Request Logging

**Request Logging**:
Per-Project control over how much of its App's live traffic the app-mode proxy records to the Project's request log. Owner-set policy, alongside Resources, budgets, and timeouts.
_Avoid_: Access logging, tracing, audit log

**Logging level**:
The chosen verbosity — Off (record nothing), Metadata (method, path, status, latency, size, redacted headers; no bodies), or Full (metadata plus a bounded prefix of each body). An ordered scale from least to most recorded.
_Avoid_: Mode (the stored identifier `request_log_mode`); log level (in the DEBUG/INFO sense)

**Body limit**:
The byte cap on how much of each request/response body the Full level captures before truncating. The log holds a prefix, never the whole body.
_Avoid_: Buffer size, max body size (collides with upload limits)

### Runtime

**Keep-alive activity**:
The traffic that keeps a ProjectEnvironment's pod running, of two kinds: **agent activity** — the user working through the agent (chat, the code editor, the database viewer, file uploads) — and **app activity** — the running App's own traffic (its public and preview URLs, and scheduled runs). Each kind has its own idle timeout; the pod is suspended only once both kinds have been idle past their timeouts. "Why a pod is still alive" is always one of these two, never a finer reason.
_Avoid_: Chat (one input to agent activity, not a category of its own); Heartbeat, Ping (non-canonical)

### Administration

**Settings**:
The permission-gated surface where a member **configures** the Organization currently chosen in the selector — its Workspaces, Users, Billing, Defaults, Integrations, and Environment registry. One destination with one section per area; each section is independently gated, so a member sees only the areas they may manage. It changes stored configuration; the running-state counterpart is Admin.
_Avoid_: Tenant Settings (retired user-facing label — the old modal that held only Integrations + Environments); Config (non-canonical); Admin (the operational sibling — a separate destination, not a synonym for Settings); conflating with Defaults (one section within Settings, not the whole)

**Admin**:
The permission-gated surface where a member **observes and operates** running state — the counterpart to Settings, which configures it. A sibling destination reached from the avatar dropdown, built on the same left-rail layout (one page per area, each independently gated). Most pages show the Organization currently chosen in the selector (Pods, Usage); a page gated by a Platform-scope permission shows all Organizations at once and ignores the selector. Its first page is Pods. The test for where a view belongs: if it shows or acts on what is running now, it is Admin; if it changes stored configuration, it is Settings.
_Avoid_: Settings (the configuration sibling — a different destination); Admin panel, Console, Operations, Monitoring (non-canonical — say Admin); conflating with Pods (the first page within Admin, not the whole)

**Platform-scope permission**:
A permission whose view spans **all Organizations** rather than the one chosen in the selector — the `platform_` segment in its name marks the scope (e.g. `can_view_platform_storage`). Granting one is granting cross-Organization visibility, so its Keycloak group is never part of the default admin bundle. There is no "super admin": cross-Organization capability is a property of individual permissions, not of a role.
_Avoid_: Super admin, Global admin (role concepts — the system has only flat permissions); Cross-tenant permission (say Platform-scope)

**Storage**:
The Admin view of disk usage on the shared volume — one measured number per ProjectEnvironment directory, rolled up Environment → Project → Organization, plus Unattributed storage, reconciled against the volume's actual usage. Gated by a Platform-scope permission, so it shows all Organizations and ignores the selector. Read-only, current-state snapshot; sizes may lag recent writes.
_Avoid_: Disk usage, Quota (no quotas exist — the view only observes); Usage (the external-services Admin page — a different thing); Storage view per Organization (Platform-scope by definition)

**Pending deletion**:
Disk usage from an Organization's deleted Projects and ProjectEnvironments whose directories are retained until cleanup retention expires. Attributed to the Organization — it answers "why is this Organization's total bigger than the sum of its projects" — as one aggregate per Organization, never itemized (the project record is gone; a bare directory identifier tells an operator nothing).
_Avoid_: Tombstoned (reserve for directories attributable to no Organization); Deleted storage (non-canonical)

**Unattributed storage**:
Disk usage on the shared volume that belongs to no Organization: the **pool** (live unclaimed pool projects), **tombstoned** (retained deleted directories whose record names no Organization), **orphaned** (directories matching no record at all), **exports** and **imports** (transient archives), and **unaccounted** (the computed residual between everything measured and the volume's actual usage). An Organization's own retained deleted directories are NOT unattributed — they are its Pending deletion.
_Avoid_: Platform storage (reads as "all storage on the platform", which this is not); System storage (non-canonical); Orphaned (one bucket within, not the whole)

**Pods**:
The view of an Organization's running environment pods — one row per running ProjectEnvironment, grouped by Project — showing each pod's status, age, Resources, configured timeouts, and live Keep-alive activity (when it was last kept alive and by which kind). Read-only; the first page within Admin.
_Avoid_: Pod class (the Resources identifier — a different thing); Resources (the size policy, not the running instances); Instances (non-canonical)
