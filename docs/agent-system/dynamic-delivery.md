---
kind: explanation
terms: [Dynamic Delivery]
adrs: [0060]
---

# Dynamic Delivery

> How what an Agent carries reaches a Project's workspace, who owns which file there, and when a change propagates?

## How it works

### Who owns what

- A workspace's `.opencode/` is written by two processes, so [ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md) splits it by an explicit ownership list rather than by timing. The **image script** owns `opencode.json` (rebuilt from the image file by allow-list, carrying forward `default_agent` and any `agents.<slug>` block the package does not ship), `agents/<package>.md`, and exactly the Skill names it recorded as `ownedSkills` in `/workspace/.opsiforce/agents/<package>.json`. The **backend** owns everything else it writes: a [Custom Agent](custom-agents.md)'s `agents/<slug>.md` and the Organization's pinned Skills.
- The ledger is the contract. It is written last on a first boot, so its presence means provisioning finished, and its `ownedSkills` — not the newest registry — is what the fan-out compares against, because a workspace whose Job has not run yet still holds the old set on disk.
- The backend writes **first**, over the storage mount and before the pod exists, so a Project boots on its Agent from the very first prompt. For a Custom Agent that starts with its [Template](../../CONTEXT.md), laid into the workspace root from the same Environment as the prompt and Skills; for a fresh Agent [Builder chat](../../CONTEXT.md), with the subject's Development Template laid into `template/`. A [pool](../runtime/pending-project-pools.md) slot has no Organization yet, so its claim does this as the last step, into the slot's already running pod, then asks it to reload its Skills and confirms they are served; any failure from there on destroys the slot rather than returning one Organization's files to another.
- The writer recognises a correct file and leaves it alone rather than rewriting identical bytes, and updates a Skill's contents in place rather than replacing its directory, so neither a restart nor an unchanged delivery raises a spurious reload.

### When a change propagates

- A **[Built-in Agent](custom-agents.md)**'s Skills are read at delivery time, so adding, removing or re-pinning one reaches every existing Project of that Organization on every Environment, with no pod restart and no interruption to a running conversation.
- A **Custom Agent**'s definition is written once, when the Project is created, and never re-derived. Editing the Agent, restarting the environment and republishing all leave `.opencode/` byte-identical.
- The image's content reaches existing workspaces through [Agent Updates](agent-updates.md) instead. On a Built-in Agent's Project that includes the [Platform Skill](platform-skill.md); on a Custom Agent's Project `platform` is a pinned Skill delivery wrote at create, which the Job leaves alone ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- Propagation is prompt but not instantaneous. `project_skill_delivery_state` records `converged`, what is still `pending` and what was `omitted` per ProjectEnvironment, and the Store reports a Project that has not yet received a change rather than showing it as current.
- A write failure is recorded against the environment and re-queued on a 5/15/30/60-minute ladder, which outlives the queue's own attempt budget; the job itself never fails.

### Making a running pod notice

- The write lands over the storage mount from another node, where the runtime's own file watcher raises no event, so after a fan-out write the backend asks `agent-control` inside the pod to create and delete a marker under `.opencode/skills/`, then polls `GET /api/skill` through the pod's credential-free `:4096` proxy until the served set matches ([ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)). The pool claim and the Agent Updates Job send the same notice after writing into a running pod; only the create path needs none, since it writes before the pod exists.
- `agent-control` reloads each named target independently — config republishes only when the parsed config differs, the agent plugin filters to paths under `agents/`, and skills own their own watches — so one marker never stands in for another. The marker leaves nothing behind: it never appears in `GET /api/skill` or `GET /api/agent`, and the directory it was created in is unchanged afterwards.

### The critical section

- An [Agent Updates](agent-updates.md) Job and the backend both write `.opencode/`, so a `running` row in `project_agent_updates` is a durable claim on that workspace: while it is held, a Skill delivery to the same environment defers rather than interleaving. The Job's own post-run reconcile is exempted by id, so the two land as one unit.
- The Job runs in two modes. **`content`** rebuilds the config, the package prompt and the owned Skills and stamps the ledger; it runs on every Environment and never recreates a pod. **`full`** adds the workspace migrations that edit the app tree and so runs on the default Environment only, because a published Environment receives that tree from Development through git and applying migrations there would diverge it.
- On a Built-in Agent's Project, when the package's composed Skills and the Organization's Skills share a name, the package wins in both modes: the Job takes the directory, the name joins `ownedSkills`, and the fan-out records it in `omitted_skills` instead of writing the Organization's copy. On a Custom Agent's Project the Job skips a name the backend already wrote and never owns it, so the pinned copy wins ([ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)).
- What a package ships is the set the image composes: the shared pool minus the package's exclusions in `agent-config/package-skills.json`, plus its own skills. Delivery at create and the Store's listing read that one set, so only a real name clash is omitted. An Organization's pin on a shared Skill its package leaves out — `web-app` or `dates` on Makara App Builder — is neither refused nor dropped: it is delivered like any other Organization Skill, and the Store shows it under the Organization's Skills rather than under the package's.

## Edge cases

- When a Job releases a name it previously owned, it deletes the directory it owned; the fan-out therefore treats a pinned Skill missing from disk as changed whatever the delivery row says, or the Organization's Skill would stay gone while every surface reported convergence.
- When a ProjectEnvironment is an unclaimed or claiming pool slot, the fan-out skips it, since the claim delivers; a suspended or disabled one has a workspace and no pod, so it is written to without a notice and its next pod reads the files at boot.
- When a backend is killed mid-Job, the surviving Kubernetes Job keeps writing; the boot reaper finds it by the `opsiforce.io/agent-update-id` label, restarts the row's clock, and fails the row only once no writer is left.
- When an export/import round trip lands a Project in an Organization without its Agent, the recorded slug wins over the row the import fell back to, so the pod keeps running the prompt the export carried.

## Code

- `backend/src/delivery/` — the workspace writer, the create and claim path, the fan-out and its ledger, and the pod reload client.
- `backend/src/agent-update/` — the sweep, the two Job modes, the claim and the boot reaper.
- `agent-config/scripts/agent-workspace-migrate.mjs` — the image script: first-boot provisioning, the owned-skill plan and the ledger.
- `proxy/cmd/agent-control/` — the in-pod marker handler the backend calls to make a watcher fire.

## Related

- [Agent Updates](agent-updates.md) — the image-version pipeline the Jobs belong to.
- [Skill](skills.md) — what is being delivered, and how a Version is pinned.
- [Custom Agents](custom-agents.md) — why a Custom Agent's Project is frozen at creation.
- [Agent](agent.md) — first boot, the package layout and the ownership list's other half.
