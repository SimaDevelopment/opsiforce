# Resources are a Project-level snapshot of Resources presets the platform and each Organization define

A Project's pod size is chosen from named Resources presets or as Custom numbers. The sizes that make sense change as workloads move out of the pod (a Project that calls dedicated services needs far less CPU than one that runs everything itself), they differ between Organizations, and whoever changes one has to choose between "only new Projects" and "every Project, now".

**Resources are stored per `Project`, in a 1:1 `project_pod_settings` row that names its preset (`preset_id`, null for Custom) and holds `cpu_millicores`, `memory_request_mib` and `memory_limit_mib`; the row's numbers are what the pod runs at. Resources presets are rows in `resource_presets`: no `tenant_id` means a platform preset offered to every Organization, a `tenant_id` means one Organization's own. A `tenant_resource_preset_overrides` row gives one Organization its own numbers for a platform preset. A preset's numbers reach a Project only at a choice, a create, or an explicit apply to all.** Concretely:

- **Numbers-authoritative rows.** Choosing a preset copies the Organization's current numbers for it into the row; Custom stores the typed numbers clamped to the Custom bounds. `buildPodSpec` reads the three integers and never looks a preset up, so one `SELECT` answers "why 4Gi".
- **Any preset can be added, renamed and deleted.** Names are unique within the platform and within an Organization, and an Organization's own preset may not take a platform preset's name. Deleting one sets `preset_id` to null on every row that named it, so those Projects and Agents become Custom at the numbers they ran at, and nothing restarts. An Agent row is first given the numbers its Organization had for the preset.
- **One default, overridable per Organization.** `resource_presets.is_default` marks the platform default, which cannot be deleted while it is the default; `tenant_settings.default_resource_preset_id` overrides it for one Organization and falls back to the platform default when its preset is deleted. A Project starts at the default when its Agent has no Resources of its own.
- **Platform value unless overridden, per preset.** An Organization with no override row for a platform preset uses the platform's numbers live; removing its row returns it to them. This is the Limits rule ([ADR-0076](0076-organization-limits-are-key-value-rows-that-follow-the-platform-value-unless-overridden.md)), for the same reason: a platform change reaches every Organization nobody has set by hand.
- **Save for new Projects, or apply to all.** A numbers change asks which. New Projects get the new numbers either way. Apply to all also rewrites the rows of every Project on that preset in scope (for a platform preset, every Organization without its own numbers for it) and restarts their running pods at most one every few seconds across the whole queue; sleeping pods start at the new size on their next wake. Custom Projects are never touched.
- **An Agent on a preset carries the preset, not its numbers.** A Project's numbers come from its own Organization's preset at create ([ADR-0093](0093-an-agent-sets-the-resources-and-ready-projects-of-the-projects-created-from-it.md)); only Custom carries its own numbers.
- **Two permissions.** `can_manage_platform_resources` is Platform-scope, has its own Keycloak group and is never in the admin bundle: it manages the platform's presets and default, a Built-in Agent's platform Resources, and any Organization's presets. `can_manage_tenant_resources` is in the admin bundle and manages only the caller's own Organization. An Organization may set any numbers within the same upper bounds as Custom.
- **One gate per Project.** `can_manage_project_pod_settings` gates `PUT /projects/:id/pod-class`, which picks a preset or Custom numbers for one Project.

## Considered options

- **Per-`ProjectEnvironment` storage** (Production sized above Development): diverges from the Project-level budget and timeout policy and adds per-environment UI; kept as a deferred override.
- **Live preset resolution** (`buildPodSpec` reads the current preset numbers on every build): every preset edit then resizes every Project on its next restart, so "new Projects only" cannot exist, and a row stops describing its pod.
- **A fixed set of presets with editable numbers**: Small, Medium and Large can be retuned but nobody can add a size between them or one only one Organization needs, and the code keeps names an administrator cannot change.
- **Blocking the delete of a preset still in use**: an administrator would have to resize every Project first only to retire a name, though those Projects run fine at the numbers they have.
- **Copying the platform presets into each Organization at creation**: a later platform change would reach only Organizations created after it, and a copied value is indistinguishable from a chosen one.
- **Platform apply to all also resetting Organizations that set their own numbers**: it would undo another administrator's deliberate choice.
- **Restarting each pod only when it next goes idle**: no chat is interrupted, but an apply to all would take up to the idle timeout to land and stay invisible until then.
- **An Organization may not exceed the platform's numbers**: an Organization is meant to retune its own presets in both directions; the shared upper bounds still cap a single pod.

## Consequences

- A published Production pod runs at the same Resources as Development.
- Apply to all interrupts chats in progress on the restarted pods; the confirmation shows how many Projects and running pods it reaches.
- A Ready Project of a Built-in Agent is built at its platform Resources, and a claim takes only a slot whose numbers match what the claiming Organization would get, so an Organization with its own numbers or its own choice for that Agent always waits for a fresh pod. Every preset change asks the pool to recycle slots whose numbers no longer match.
- Applying a size is always a pod recreate, never an in-place resize; resources are immutable on a running pod.
- An export carries the preset's name; an import takes the importing Organization's preset of that name, or Custom at the carried numbers when there is none.
- Agent Update Job pods use fixed numbers in code, outside the presets.
