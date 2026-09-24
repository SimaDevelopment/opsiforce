# Opsiforce

AI coding-assistant platform: users converse with an agent inside a Kubernetes pod to build apps, and can promote those apps from a working environment to production-like environments.

## Language

### Organization

**Organization**:
The top-level customer account a user works inside — owner of its Workspaces, Users, Billing, Defaults, Integrations, and Environment registry. A user may belong to several and switches between them in the selector (shown by display name and a building mark). Its technical name is **tenant** — the `tenants` table, the `*_tenant_*` permissions, the API — which must never surface in user-facing copy. Prefer omitting the noun entirely where context already makes the scope obvious.
_Avoid_: Tenant (internal name only — never user-facing); Account (collides with the user's login); Workspace (a grouping *within* an Organization, not the Organization itself)

**Workspace**:
A grouping of Projects within an Organization that decides who sees them: a shared Workspace is visible to its explicit members only, and every Project sits in exactly one Workspace or in Public. Folders group Projects inside a Workspace.
_Avoid_: Team, Group, Space (non-canonical); Organization (the account that owns Workspaces); Files (the project tab, a different thing)

**Personal Workspace**:
The one private Workspace a member gets in an Organization, created on first sign-in, visible to and manageable by nobody else. Organizations can switch Personal Workspaces off, in which case existing ones are hidden rather than deleted.
_Avoid_: Private workspace (the internal type name, not user-facing copy); My workspace, Home

**Public Workspace**:
The Organization-wide surface for Projects that belong to no Workspace, visible to every member of the Organization. Placing a Project there widens its audience to the whole Organization.
_Avoid_: Unassigned (retired label); Default workspace, Shared (a shared Workspace is member-scoped, Public is not)

**Folder**:
A named, single-level grouping of Projects within a Workspace — an organizational label, not ownership: deleting a Folder releases its Projects to the Workspace; an empty Folder is fine. A Project sits either directly in its Workspace or in exactly one of its Folders, and a Folder's name is unique within its Workspace. Folders exist in shared Workspaces and the private Personal Workspace, never in Public. Moving a Folder to another Workspace carries its Projects and follows the same rules as moving the Projects themselves.
_Avoid_: Group (vague — collides with UI grouping); Directory (filesystem connotation); Subfolder, nested folders (out of scope — one level only)

### Projects & Environments

**Project**:
The durable shell a user owns — identity, ownership, and cross-environment policy. It holds no running state of its own; it groups one or more ProjectEnvironments, each running its own App.
_Avoid_: App (a Project is not the thing that gets built — it groups several; see App)

**Environment**:
A tenant-scoped, named target a Project can run in and a Custom Agent can publish to (name + description). Every tenant has two protected Environments — **Development** and **Production** — created with the tenant; admins add others (e.g. Staging). A protected Environment cannot be renamed or deleted, and neither can one holding a Custom Agent's Agent Profile or named as its Default environment (Agent). The set of Environments is the list of publish targets offered to every Project and every Custom Agent in the tenant.
_Avoid_: Tier, Target, Deployment target

**Environment Slug**:
The short, immutable, URL-safe identifier an Environment carries alongside its name, shown as the environment suffix in an App's public URL. Fixed for the protected Environments (`dev` for Development, `prod` for Production); for a custom Environment it is prefilled from the whole name at creation and editable that one time before saving (it must be unique within the tenant), then immutable — renames never change it, so published URLs outlive renames. The slug is an identifier, not user-facing copy, so the "avoid Prod" rule does not apply to it.
_Avoid_: Suffix (its position in the URL, not the concept); Code

**Environment Color**:
The color an Organization gives an Environment as its visual identity — the one hue that stands for that Environment wherever environments are shown at a glance (today, the environment markers beside a Project in the sidebar). Every Environment has one: the protected Development and Production Environments are seeded with defaults, and any Environment's color — protected ones included — can be changed by an admin from the Environment registry in Settings. It answers *which* Environment this is, and is deliberately a different axis from the status colors that signal *how* a running environment is doing (active, starting, suspended, failed) — a suspended Production is still "Production" and keeps its color.
_Avoid_: Status color (the orthogonal running-state axis, not identity); Label color; Theme; Tag

**Badge Label**:
The editable short text (two to five letters or digits) shown on an Environment's sidebar badge, over the Environment Color as background. When empty, the badge falls back to the Environment Slug's first letters, uppercased.
_Avoid_: Short name (the stored identifier, not user-facing copy); Abbreviation; Tag

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
_Avoid_: Deploy, Release, Promote, Redeploy; conflating with Publish (Skill) or Publish (Agent), disambiguated by object: Apps and Agent Profiles publish to Environments, Skills publish to the Store

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

**Disable (Project)**:
Stopping a Project without losing it: every ProjectEnvironment's pod is deleted and its timeouts cleared, while the workspace, the transcript and every row survive. Reversible by Enable, which starts the environments again. The canonical word for taking anything out of use — an ordinary Project, a Builder chat and a test Project, whose pods stop, and a Skill or a Custom Agent, which leaves the catalog (Disable (Skill), Disable (Agent)).
_Avoid_: Archive (retired — the Store says Disable too); Deactivate, Suspend, Pause, Stop (non-canonical)

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
The LLM an Agent runs on, named directly as a provider/model pair together with a variant. For Built-in Agents it comes from agent-config and changing it is a platform rollout; a Custom Agent names its own in each Agent Profile, validated against the platform's model catalog — a model or variant the running distribution does not carry cannot be saved.
_Avoid_: Model Preset (retired 2026-09-17 — Agents name the model directly); Default model (it is **not** a configurable default — Defaults covers timeouts and budgets only)

**Custom Agent**:
An Agent authored in the platform rather than shipped in the image, owned by one Organization and carrying a Visibility. It consists of what its author writes — identity, plus one Agent Profile per Environment holding instructions, the Agent Model and its Skills — and nothing else: a Custom Agent has no starter template and no workspace migrations, so its Projects open on an empty workspace and the agent starts from a template before it builds — it lays the platform's web-app template through `web-app`, or creates the skeleton a scaffold Skill the Skill & Agent Builder constructed describes — as the Architecture section of its instructions directs, which also states what the Agent changes about that template so every Project of it starts from one shape. It becomes pickable for new Projects only once it has an Agent Profile in its Default environment (Agent).
_Avoid_: Dynamic agent, User agent, Tenant agent (non-canonical); Global agent (retired — Custom Agents never span Organizations); Base Agent, chassis (retired 2026-09-17 — a Custom Agent rides the platform's shared runtime, not a chosen Built-in Agent)

**Built-in Agent**:
An Agent shipped in the platform's agent image and registered in agent-config — identity, instructions, skills, starter template, workspace migrations and Agent Model all come from code, and changing any of them is a platform rollout that reaches existing Projects through Agent Updates. The registry is the source of which Built-in Agents exist and which are current. The sibling of Custom Agent, the only kind with a template and migrations, and the only kind whose Skills reach Projects that already exist.
_Avoid_: Baked Agent (retired term, renamed 2026-08-28); System agent, Platform agent (non-canonical)

**Agent Profile**:
An Agent's definition in one scope. A Custom Agent has exactly one Profile per Environment — its instructions, its Agent Model, and its Skills — where the Development one is what its author edits and every other one is a copy placed there by a Publish (Agent). A Built-in Agent has exactly one Profile per Organization, holding only its Skills, since its instructions and Agent Model come from the image; it is parked at the Development Environment but its Skills apply on every Environment. Profiles carry no versions and no history — editing overwrites the Development Profile, and publishing overwrites the target's.
_Avoid_: Version, Release, Publication, Snapshot (retired — a Profile is an Environment's current state, not a point in a history); Draft (the Development Profile *is* the draft)

**Publish (Agent)**:
Copying a Custom Agent's Development Profile onto another Environment's Profile, overwriting whatever was there, so that Projects created from that Environment afterwards get the new definition. Existing Projects are untouched, and the overwritten content is not kept. Shares the verb with the App and Skill senses deliberately — the object disambiguates.
_Avoid_: Deploy, Release, Promote (reserved against the environment vocabulary); conflating with Publish, which moves an App's source between Environments

**Default environment (Agent)**:
The Environment a Custom Agent's new Projects are created from — one per Agent, set by a holder of `can_manage_agents`. Until the Agent has an Agent Profile there, the Agent is not offered in the picker at all. Choosing Development is the fast-iteration mode: each new Project picks up whatever Development holds at that moment.
_Avoid_: Default Environment unqualified (the tenant registry's default row is Development, a different concept); Active environment (the workspace's current view)

**Disable (Agent)**:
An Organization taking an Agent out of use for itself — one of its own Custom Agents or a Built-in Agent it does not want: hidden from the Agent picker and closed to new Projects, while existing Projects keep running unchanged. Reversible by Enable. Another Organization is unaffected. An Organization always keeps at least one Built-in Agent enabled, and the Skill & Agent Builder is never disabled. A Custom Agent never published beyond Development, or disabled, can be deleted outright once no Project runs on it, and its test Projects go with it; a Built-in Agent that leaves the registry simply stops being offered.
_Avoid_: Delete (the permanent sibling); Archive, Deactivate (non-canonical)

**Duplicate (Custom Agent)**:
Forking any Agent a member can see — a public Custom Agent, a Built-in Agent, or their own private one — into a new private Custom Agent they own, carrying its identity, instructions, Agent Model and Skills into the new Agent's Development Profile. The way to base a new Agent on one that already works, and the only way back from a Visibility already made public.
_Avoid_: Copy, Clone, Fork (non-canonical); Base Agent (retired); Lineage (nothing records what a Duplicate was copied from)

**Platform Skill**:
The built-in skill named `platform`, shipped in the agent image and laid into every workspace, carrying the facts every Agent needs about running here — the App contract, that the pod is disposable and the workspace durable, where uploads and generated files live, the gateway and its environment variables, the two read-only databases and how to query them, what must never be installed — so an Agent's own prompt never restates them. Agent Updates refresh it in every existing Project of every Agent kind; its name is reserved, and it cannot be removed from an Agent's Skills.
_Avoid_: Harness (not a term — the thing is a skill); Base prompt, System preamble (nothing is prepended to an Agent's prompt; the prompt is the author's body alone)

**App contract**:
The three things the platform needs from an App to run it in any stack: an executable `/workspace/app/startup.sh` the pod runs, restarts and re-runs in a published Environment; a server answering on `$APP_PORT`; and `app/app.meta.json` naming the App. Any HTTP answer on the port is serving, and serving plus the file present is live. The starter template satisfies it out of the box; a Custom Agent's App satisfies it by laying a template that does, or by writing the files.
_Avoid_: Start command (startup.sh already is one); Health check route (no route is required); Manifest (the meta file holds a name and description only)

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

### Skills & the Skill Store

**Skill**:
A named instruction package — a directory with a `SKILL.md` and optional supporting files — that an Agent loads on demand when a task matches its description. Every Skill is either Built-in or Custom; a Custom Skill belongs to exactly one Organization while a Built-in one is the platform's and is offered to all. A Skill becomes active for an Agent only by being added to that Agent's Skills.
_Avoid_: Plugin, Extension, Command (non-canonical); Tool (a different Agent capability concept); Global skill (retired — authored Skills never span Organizations)

**Built-in Skill**:
A Skill shipped in the platform's agent image and reconciled into the catalog from code — changing or retiring one is a platform rollout. The sibling of Custom Skill, and the exact counterpart of Built-in Agent: one that leaves the image simply stops being offered, while its stored content survives so Agents that already pinned it keep working.
_Avoid_: Platform skill, System skill (non-canonical); Deprecated (retired term — leaving the image is the whole mechanism)

**Custom Skill**:
A Skill authored in the platform rather than shipped in the image — through the Skill & Agent Builder or the Store's form — owned by one Organization and carrying a Visibility. The sibling of Built-in Skill.
_Avoid_: Dynamic skill, User skill, Tenant skill (non-canonical)

**Visibility**:
Whether an authored Skill or Custom Agent is **private** — listed, pickable and editable only for the member who created it — or **public**, meaning every member of the Organization can see and use it and every permission holder can edit, disable or delete it. Making something public is irreversible and hands it to the Organization; the way back is to Duplicate. Private means unlisted, never secret: what an Agent carries is written into its Project's workspace, so anyone who can see the Project can read it.
_Avoid_: Shared (a shared Workspace is member-scoped — Visibility is Organization-wide); Published (reserved for the Skill and App senses); Scope (retired — there is no scope above the Organization)

**Skill Version**:
The immutable snapshot of a Skill's content created each time it is published, and the only form in which a Skill's content exists — there is no unpublished content. A Skill named in the Store before its Builder chat has written it holds no Version yet, and nothing can pin it until one exists. An Agent's Skills each pin one Version, and a Version, once published, never changes.
_Avoid_: Revision, Draft Revision (retired — the Builder chat holds the work in progress, and nothing unfinished is stored); Release

**Publish (Skill)**:
Validating a Skill's content and freezing it as the Skill's next Version, which makes it available to add to the Organization's Agents. This is the only way a Skill's content is written: there is no separate save, so every Version marks an author saying the content is ready. Failing validation refuses the write and returns the errors to whoever submitted it. Shares the verb with the environment sense deliberately — the object disambiguates: Apps publish to Environments, Skills publish to the Store.
_Avoid_: Release, Promote (reserved against the environment vocabulary); Deploy; Save (there is no save short of publishing)

**Agent Skills**:
The Skills an Agent carries, each pinned to one Skill Version — added and removed while editing the Agent, and never two with the same name. One mechanism for both Agent kinds: the set hangs off an Agent Profile either way, and only the moment it is read differs. A Built-in Agent's Skills are read at delivery time, so a change reaches the Organization's existing Projects; a Custom Agent's reach only Projects created afterwards. Removing a Skill is the only way it stops applying — retiring it in the Store never silently changes an Agent.
_Avoid_: Attachment, Attach, Detach (retired 2026-09-17 — the relationship needs no noun of its own); Install (implies a copy); Assignment, Enable

**Update available**:
The state of a Skill on an Agent whose pinned Skill Version is behind that Skill's newest one. Purely a prompt to a human — nothing upgrades on its own, and upgrading is a deliberate act on one Agent's one Skill.
_Avoid_: Outdated, Stale (judgemental — a pin behind the newest Version is a valid state); Auto-update (retired — nothing updates itself)

**Skill Store**:
The catalog where members browse their Organization's Skills — Built-in and public Custom ones, plus their own private ones — inspect their contents, and add them to Agents. It is the Skills tab of Store, not a destination of its own.
_Avoid_: Marketplace (implies cross-Organization publishing or commerce — out of scope); Library, Hub (non-canonical); Store (the containing section, which also holds Agents)

**Disable (Skill)**:
An Organization taking a Skill out of use for itself — one of its own or a Built-in Skill: hidden from the Store and closed to new use, while every Agent that already carries it keeps working unchanged. Reversible by Enable. Another Organization is unaffected, and the Platform Skill is never disabled.
_Avoid_: Delete (the separate, permanent act); Archive (retired); Unpublish, Revoke, Deprecate (retired — nothing withdraws a Skill from Agents that already carry it)

**Delete (Skill)**:
Permanently removing a Skill and its Versions. Available for a disabled Skill once no Agent carries it — the attempt is refused while any does, naming them. The one act with no undo.
_Avoid_: Remove (the act of taking a Skill off one Agent); Disable (the reversible sibling)

**Duplicate (Skill)**:
Forking any Skill a member can see — a public one, a Built-in one, or their own private one — into a new private Skill they own, whose first Version copies the original's content. What it was copied from is not recorded. The way to vary content someone else published, and the only way back from a Visibility that has already been made public.
_Avoid_: Copy, Clone, Fork (non-canonical — Duplicate is the house verb, as for Projects); Import (the `.skill` route, which crosses Organizations)

**Dynamic Delivery**:
How what an Agent carries reaches a Project's workspace. A Project's files are laid when the Project is created and are never re-laid by a restart. For a Built-in Agent, a change to its Skills reaches every existing Project of the Organization silently — no pod restart, no interruption, running conversations unaffected; the Agent simply has the new state from its next message — and a change to its image content arrives the same way through Agent Updates. A Custom Agent's content is written once, when the Project is created, and never re-derived. Propagation is prompt but not instantaneous, and a Project that has not yet received a change is shown as such, never silently behind.
_Avoid_: Sync, Push, Install (mechanism words); Update (collides with Agent Updates, the image-version pipeline)

**Skill & Agent Builder**:
The Built-in Agent that authors Skills and Custom Agents through conversation. Reached from a Skill's or a Custom Agent's page in the Store rather than the project workspace, and shipped in every distribution. It interviews, drafts in conversation, publishes on its author's word, and tests a Custom Agent it wrote by conversing with it in a test Project rather than trusting its own transcript; everything it writes is judged as the permissions of the user who opened the Builder chat, and its pod may create and edit but never delete, rename, disable or make anything public.
_Avoid_: Builder alone in user-facing copy (ambiguous beside app-builder); Studio, Workshop, Creator, Copilot (non-canonical); conflating with app-builder (the Agent that builds Apps)

**Builder chat**:
The one authoring conversation that belongs to a Skill or a Custom Agent — its **subject** — with the Skill & Agent Builder. A subject has at most one: New skill and New agent name the entry and open its chat, and the entry's page opens the same chat again later. Whoever may see the subject, with the permission matching it, may open and prompt its chat, so it widens when the subject is made public. It is where unfinished work lives: nothing half-written is stored anywhere else. From the chat the Builder publishes the Skill's Versions, or writes the Agent's Development Agent Profile, its Skills and its description, and runs a test Project; Publish (Agent) to another Environment, renaming, making anything public, Disable and Delete stay on the subject's page. The pod reads its subject from the platform API. Carried by a kind-stamped Project — plumbing that never appears in workspaces or the project list — deleted to start the conversation over, and deleted with its subject.
_Avoid_: Builder Project (retired — a Builder chat is not a workspace artifact); Builder session (collides with the runtime's session); chat visibility (retired — who opens a chat follows its subject); chat list (there is none — a chat is reached from its subject)

**chat kind**:
The facet a Builder chat is stamped with when it is made — Skill or Agent, following its subject — choosing which authoring skill opens the conversation. The same column marks a test Project, and its absence is what makes a Project an ordinary one that lists show.
_Avoid_: Project type, Project kind unqualified (the column is internal — users see Skill chat / Agent chat); Mode

**test Project**:
A throwaway Project the Skill & Agent Builder creates on a Custom Agent it authored, from that Agent's Development Agent Profile, to converse with the child and verify its claims inside the child's pod. One live per Builder chat — starting a new test deletes the previous one, and deleting the chat deletes it — hidden from every project list and reachable from the chat that made it, where whoever may open the chat opens it beside the chat as an ordinary Project. Single-use: Dynamic Delivery freezes the definition at creation, so testing an edit needs a new one.
_Avoid_: Sandbox, Eval, Preview project (non-canonical); Draft project (there is no draft — the Development Profile is what runs)

### Schedules

**Schedule**:
A recurring cron job an agent registers against an endpoint in the App, owned by **one ProjectEnvironment** — it fires only against that environment's running App. Publishing copies Development's chosen schedules into the target environment, so a same-named schedule can exist and fire **independently** in several environments (the copies are intentional, not duplicates).
_Avoid_: Cron job (the mechanism, not the domain concept); Job (collides with BullMQ jobs and publish jobs)

### Public API

**API Token**:
The credential a program — the CLI, an integration, another Agent — presents to call the public API on a user's behalf. Today it is the bearer token the deployment's identity provider issues when that user signs in, so it carries exactly the Organization memberships and permissions they hold in the UI; a token issued by Opsiforce itself is a possible later form of the same concept. The public API selects the Organization it acts in with the same organization header the UI already sends (implicit when the caller belongs to exactly one), and its documentation speaks of Organizations, never of the internal tenant vocabulary.
_Avoid_: Client key; API key (non-canonical); Personal access token (canonical only in other products); Tenant header (internal name — never user-facing)

**Gateway Key**:
The per-ProjectEnvironment `gw-` token a pod holds, carrying a purpose: the `service` key every pod has for Schedules, external services and platform pushes, and a `platform-api` key minted only for Projects whose Agent declares the capability, presented to the public API and the runtime proxy as a bearer. Never a user credential — the platform resolves it to the human who created the Project.
_Avoid_: API key (collides with API Token); Pod token, Service token unqualified (the purpose is the distinction)

**Agent Caller**:
A public-API caller whose credential is a Gateway Key: it acts as the human who created its Project, with that person's permissions as the platform last saw them and without needing `can_use_public_api`, and reaches only the routes opened to it — Projects it created itself with full creator authority, Skills and Custom Agents with every verb except Delete, Disable and making public. Its Projects record which Project's pod made them, and the chain stops at depth two. At launch only the Skill & Agent Builder's pods are Agent Callers.
_Avoid_: Bot (a service account is an ordinary user); Machine user; Pod identity (the identity is the human's)

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

**Store**:
The third sibling beside Settings and Admin, reached from the avatar dropdown at `/store`, where a member browses the Organization's catalog of Agents and Skills and, with `can_manage_skills` or `can_manage_agents`, authors them — each through its own Builder chat. Its two sections, Agents and Skills, sit in a tab bar and are open to every member because consuming the catalog is free. It contains the Skill Store, which is its Skills section rather than a separate destination. The test for where a view belongs: if it browses or authors the catalog, it is Store; if it shows what is running now, it is Admin; if it changes stored configuration, it is Settings.
_Avoid_: Marketplace, Catalog, Library (non-canonical — say Store); Skill Store (one tab within Store, not the whole); Settings, Admin (the sibling destinations)

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
