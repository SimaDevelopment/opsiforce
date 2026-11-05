import { For, Show, createSignal, type JSX } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError, type PodResources } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import {
  useCreatePreset,
  useDeletePreset,
  useOrganizationPresets,
  usePlatformPresets,
  useRemoveOverride,
  useApplyPreset,
  useSetDefaultPreset,
  useUpdatePreset,
  type OrganizationPreset,
  type PresetApplied,
  type PresetApplyMode,
  type PresetBounds,
  type PresetScope,
  type PresetUsage,
  type TenantPresetsSummary,
} from '~/api/resource-presets';
import { ActionsMenu, ActionsMenuItem } from '~/components/actions-menu';
import { OptionSelect } from '~/components/resources/option-select';
import { AlertTriangle, Building2, Check, Cpu, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from '~/components/icons';
import { SettingsSection } from '~/components/settings/settings-section';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import {
  NumberField,
  NumberFieldDecrementTrigger,
  NumberFieldGroup,
  NumberFieldIncrementTrigger,
  NumberFieldInput,
  NumberFieldLabel,
} from '~/components/ui/number-field';
import { cn } from '~/lib/cn';
import { Skeleton } from '~/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { TextField, TextFieldInput, TextFieldLabel } from '~/components/ui/text-field';
import {
  coresToMillicores,
  describeResources,
  formatCores,
  formatGib,
  gibToMib,
  mibToGib,
  millicoresToCores,
  trimNumber,
} from '~/lib/pod-resources';

const PLATFORM_DEFAULT = 'platform-default';
const EMPTY_RESOURCES: PodResources = { cpuMillicores: 0, memoryRequestMib: 0, memoryLimitMib: 0 };

function describeMemory(resources: PodResources): string {
  if (resources.memoryRequestMib === resources.memoryLimitMib) return formatGib(resources.memoryLimitMib);
  return `${trimNumber(mibToGib(resources.memoryRequestMib))}–${formatGib(resources.memoryLimitMib)}`;
}

function SectionHeading(props: { title: string; description: string; action?: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="min-w-0 space-y-0.5">
        <h2 class="text-sm font-medium text-foreground">{props.title}</h2>
        <p class="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Show when={props.action}>{props.action}</Show>
    </div>
  );
}

function PresetStatus(props: { row: PresetUsage; onUpdate: () => void }) {
  return (
    <Show
      when={props.row.behind > 0}
      fallback={
        <Show when={props.row.projects > 0} fallback={<span class="text-xs text-muted-foreground">Not in use</span>}>
          <span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Check class="h-3 w-3" aria-hidden="true" />
            Up to date
          </span>
        </Show>
      }
    >
      <button
        type="button"
        class="of-ink of-tone-needs-you inline-flex items-center gap-1 rounded-md text-xs font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={`${props.row.behind} ${props.row.behind === 1 ? 'Project runs' : 'Projects run'} at older numbers`}
        onClick={(event) => {
          event.stopPropagation();
          props.onUpdate();
        }}
      >
        <RefreshCw class="h-3 w-3" aria-hidden="true" />
        Update {props.row.behind} {props.row.behind === 1 ? 'Project' : 'Projects'}
      </button>
    </Show>
  );
}

function appliedMessage(apply: PresetApplyMode, applied: PresetApplied): string {
  if (apply === 'new' || applied.projects === 0) return 'Saved';
  const projects = `Applied to ${applied.projects} ${applied.projects === 1 ? 'Project' : 'Projects'}`;
  if (applied.restarting === 0) return projects;
  return `${projects}, restarting ${applied.restarting} running ${applied.restarting === 1 ? 'pod' : 'pods'}`;
}

function failure(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function ResourcesPage() {
  const { hasPermission } = usePermissions();

  return (
    <SettingsSection
      icon={Cpu}
      title="Resources"
      description="The CPU and memory presets Projects and Agents pick from. Every organization uses the platform presets and can add its own."
      width="wide"
    >
      <Show
        when={hasPermission('can_manage_platform_resources')}
        fallback={<OrganizationPresets scope={{ kind: 'own' }} />}
      >
        <PlatformPresets />
      </Show>
    </SettingsSection>
  );
}

function PlatformPresets() {
  const view = usePlatformPresets();
  const scope = (): PresetScope => ({ kind: 'platform' });
  const create = useCreatePreset(scope);
  const update = useUpdatePreset(scope);
  const remove = useDeletePreset(scope);
  const applyAll = useApplyPreset(scope);
  const setDefault = useSetDefaultPreset(scope);
  const [editing, setEditing] = createSignal<TenantPresetsSummary | null>(null);

  return (
    <QueryState pending={view.isPending} error={view.isError} onRetry={() => view.refetch()}>
      <Show when={view.data}>
        {(data) => (
          <div class="space-y-8">
            <PresetList
              title="Platform presets"
              description="Offered to every organization. New Projects start at the default unless their Agent or organization picks another."
              bounds={data().bounds}
              pending={create.isPending}
              onCreate={(name, resources) => create.mutateAsync({ name, resources })}
              rows={data().presets.map((preset) => ({
                ...preset,
                badges: preset.isDefault ? ['Default'] : [],
                edit: {
                  name: preset.name,
                  resources: preset.resources,
                  save: (values, apply) => update.mutateAsync({ id: preset.id, ...values, apply }),
                },
                makeDefault: preset.isDefault ? undefined : () => setDefault.mutateAsync(preset.id),
                remove: preset.isDefault ? undefined : () => remove.mutateAsync(preset.id),
                applyAll: () => applyAll.mutateAsync(preset.id),
              }))}
            />

            <section class="space-y-3">
              <SectionHeading
                title="Organizations"
                description="Each organization can pick its own default, add its own presets and set its own values for platform presets."
              />
              <div class="rounded-lg border border-border overflow-hidden bg-card">
                <Table layout="responsive" layoutPreferenceKey="opsiforce:settings:resources-layout">
                  <TableHeader>
                    <TableRow>
                      <TableHead class="min-w-56">Organization</TableHead>
                      <TableHead class="w-48">Default</TableHead>
                      <TableHead class="w-40">Own presets</TableHead>
                      <TableHead class="w-40">Own values</TableHead>
                      <TableHead class="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <For each={data().tenants}>
                      {(tenant) => (
                        <TableRow class="cursor-pointer" onClick={() => setEditing(tenant)}>
                          <TableCell>
                            <div class="flex items-center gap-2">
                              <Building2 class="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                              <span class="text-sm font-medium truncate">{tenant.displayName}</span>
                            </div>
                          </TableCell>
                          <TableCell label="Default">
                            <span class="text-sm">{tenant.defaultPresetName ?? 'Platform default'}</span>
                          </TableCell>
                          <TableCell label="Own presets">
                            <span class="text-sm tabular-nums">{tenant.ownPresets}</span>
                          </TableCell>
                          <TableCell label="Own values">
                            <span class="text-sm tabular-nums">{tenant.overrides}</span>
                          </TableCell>
                          <TableCell class="text-right">
                            <Button
                              size="icon"
                              variant="ghost"
                              class="h-7 w-7"
                              aria-label={`Edit Resources of ${tenant.displayName}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditing(tenant);
                              }}
                            >
                              <Pencil class="w-3.5 h-3.5" aria-hidden="true" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      )}
                    </For>
                  </TableBody>
                </Table>
              </div>
            </section>

            <Show when={editing()}>
              {(tenant) => (
                <Dialog
                  open
                  onOpenChange={(open) => {
                    if (!open) setEditing(null);
                  }}
                >
                  <DialogContent class="flex max-w-4xl flex-col">
                    <DialogTitle>Resources for {tenant().displayName}</DialogTitle>
                    <DialogDescription>
                      Its default, its own presets and its own values for platform presets.
                    </DialogDescription>
                    <div class="mt-4 min-h-0 overflow-y-auto pr-1">
                      <OrganizationPresets scope={{ kind: 'tenant', tenantId: tenant().tenantId }} />
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </Show>
          </div>
        )}
      </Show>
    </QueryState>
  );
}

function OrganizationPresets(props: { scope: PresetScope }) {
  const scope = () => props.scope;
  const view = useOrganizationPresets(scope);
  const create = useCreatePreset(scope);
  const update = useUpdatePreset(scope);
  const remove = useDeletePreset(scope);
  const applyAll = useApplyPreset(scope);
  const removeOverride = useRemoveOverride(scope);
  const setDefault = useSetDefaultPreset(scope);

  const platformDefaultName = () =>
    view.data?.presets.find((preset) => preset.id === view.data?.platformDefaultPresetId)?.name ?? 'none';
  const defaultOptions = () => [
    { value: PLATFORM_DEFAULT, label: `Platform default (${platformDefaultName()})` },
    ...(view.data?.presets ?? []).map((preset) => ({ value: preset.id, label: preset.name })),
  ];

  const rowFor = (preset: OrganizationPreset): PresetRowModel => {
    const isDefault = preset.id === view.data?.defaultPresetId;
    const base = {
      ...preset,
      badges: [
        ...(preset.organization ? ['Organization'] : preset.overridden ? ['Own value'] : []),
        ...(isDefault ? ['Default'] : []),
      ],
      deleteNote:
        isDefault && view.data?.ownDefault ? 'New Projects here then start at the platform default.' : undefined,
      applyAll: () => applyAll.mutateAsync(preset.id),
    };
    if (preset.organization) {
      return {
        ...base,
        edit: {
          name: preset.name,
          resources: preset.resources,
          save: (values, apply) => update.mutateAsync({ id: preset.id, ...values, apply }),
        },
        remove: () => remove.mutateAsync(preset.id),
      };
    }
    return {
      ...base,
      edit: {
        name: null,
        label: preset.overridden ? 'Edit own value' : 'Set own value',
        savesUnchanged: !preset.overridden,
        resources: preset.resources,
        save: (values, apply) => update.mutateAsync({ id: preset.id, resources: values.resources, apply }),
      },
      usePlatformValue: preset.overridden
        ? {
            resources: preset.platformResources,
            save: (apply) => removeOverride.mutateAsync({ id: preset.id, apply }),
          }
        : undefined,
    };
  };

  return (
    <QueryState pending={view.isPending} error={view.isError} onRetry={() => view.refetch()}>
      <Show when={view.data}>
        {(data) => (
          <div class="space-y-8">
            <SectionHeading
              title="Default for new Projects"
              description="Used when an Agent has no Resources of its own."
              action={
                <div class="w-64 max-w-full">
                  <OptionSelect
                    options={defaultOptions()}
                    ariaLabel="Default for new Projects"
                    value={data().ownDefault ? (data().defaultPresetId ?? PLATFORM_DEFAULT) : PLATFORM_DEFAULT}
                    disabled={setDefault.isPending}
                    onChange={(value) =>
                      setDefault
                        .mutateAsync(value === PLATFORM_DEFAULT ? null : value)
                        .then(() => toast.success('Default saved'))
                        .catch((error: unknown) => toast.error(failure(error, 'Failed to save the default')))
                    }
                  />
                </div>
              }
            />
            <PresetList
              title="Presets"
              description="The platform presets, with this organization’s own values, and its own presets."
              bounds={data().bounds}
              pending={create.isPending}
              onCreate={(name, resources) => create.mutateAsync({ name, resources })}
              rows={data().presets.map(rowFor)}
            />
          </div>
        )}
      </Show>
    </QueryState>
  );
}

interface PresetEdit {
  /** null: the name is not editable here. */
  name: string | null;
  label?: string;
  /** Saving at the same numbers still means something: it creates the Organization's own value. */
  savesUnchanged?: boolean;
  resources: PodResources;
  save: (
    values: { name?: string; resources?: PodResources },
    apply: PresetApplyMode
  ) => Promise<{ applied: PresetApplied }>;
}

interface PresetRowModel extends PresetUsage {
  id: string;
  name: string;
  resources: PodResources;
  badges: string[];
  /** Said before deleting, beyond what happens to Projects and Agents. */
  deleteNote?: string;
  edit: PresetEdit;
  makeDefault?: () => Promise<unknown>;
  remove?: () => Promise<unknown>;
  usePlatformValue?: { resources: PodResources; save: (apply: PresetApplyMode) => Promise<{ applied: PresetApplied }> };
  applyAll: () => Promise<{ applied: PresetApplied }>;
}

function PresetList(props: {
  title: string;
  description: string;
  rows: PresetRowModel[];
  bounds: PresetBounds;
  pending: boolean;
  onCreate: (name: string, resources: PodResources) => Promise<unknown>;
}) {
  const [adding, setAdding] = createSignal(false);
  const [editing, setEditing] = createSignal<PresetRowModel | null>(null);
  const [deleting, setDeleting] = createSignal<PresetRowModel | null>(null);
  const [restoring, setRestoring] = createSignal<PresetRowModel | null>(null);
  const [applying, setApplying] = createSignal<PresetRowModel | null>(null);

  return (
    <section class="space-y-3">
      <SectionHeading
        title={props.title}
        description={props.description}
        action={
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus class="w-3.5 h-3.5" aria-hidden="true" />
            Add preset
          </Button>
        }
      />
      <div class="rounded-lg border border-border overflow-hidden bg-card">
        <Table layout="responsive">
          <TableHeader>
            <TableRow>
              <TableHead class="min-w-56">Preset</TableHead>
              <TableHead class="w-24">CPU</TableHead>
              <TableHead class="w-28">Memory</TableHead>
              <TableHead class="w-32">Projects</TableHead>
              <TableHead class="w-44">Status</TableHead>
              <TableHead class="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <For each={props.rows}>
              {(row) => (
                <TableRow class="cursor-pointer" onClick={() => setEditing(row)}>
                  <TableCell>
                    <div class="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        class="rounded-sm text-left text-sm font-medium break-words focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label={`${row.edit.label ?? 'Edit'} ${row.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditing(row);
                        }}
                      >
                        {row.name}
                      </button>
                      <For each={row.badges}>{(badge) => <Badge variant="outline">{badge}</Badge>}</For>
                    </div>
                  </TableCell>
                  <TableCell label="CPU">
                    <span class="text-sm tabular-nums">{formatCores(row.resources.cpuMillicores)}</span>
                  </TableCell>
                  <TableCell label="Memory">
                    <span class="text-sm tabular-nums" title="Guaranteed request – limit it may use up to">
                      {describeMemory(row.resources)}
                    </span>
                  </TableCell>
                  <TableCell label="Projects">
                    <span class="text-sm tabular-nums">
                      {row.projects}
                      <Show when={row.runningPods > 0}>
                        <span class="text-muted-foreground"> · {row.runningPods} running</span>
                      </Show>
                    </span>
                  </TableCell>
                  <TableCell label="Status">
                    <PresetStatus row={row} onUpdate={() => setApplying(row)} />
                  </TableCell>
                  <TableCell class="text-right" onClick={(event) => event.stopPropagation()}>
                    <ActionsMenu label={`Actions for ${row.name}`}>
                      <ActionsMenuItem icon={Pencil} onSelect={() => setEditing(row)}>
                        {row.edit.label ?? 'Edit'}
                      </ActionsMenuItem>
                      <Show when={row.usePlatformValue}>
                        <ActionsMenuItem icon={RotateCcw} onSelect={() => setRestoring(row)}>
                          Use platform value
                        </ActionsMenuItem>
                      </Show>
                      <Show when={row.behind > 0}>
                        <ActionsMenuItem icon={RefreshCw} onSelect={() => setApplying(row)}>
                          Apply to all Projects
                        </ActionsMenuItem>
                      </Show>
                      <Show when={row.makeDefault}>
                        {(makeDefault) => (
                          <ActionsMenuItem
                            icon={Check}
                            onSelect={() =>
                              void makeDefault()()
                                .then(() => toast.success(`${row.name} is the default`))
                                .catch((error: unknown) => toast.error(failure(error, 'Failed to set the default')))
                            }
                          >
                            Make default
                          </ActionsMenuItem>
                        )}
                      </Show>
                      <Show when={row.remove}>
                        <ActionsMenuItem icon={Trash2} destructive onSelect={() => setDeleting(row)}>
                          Delete
                        </ActionsMenuItem>
                      </Show>
                    </ActionsMenu>
                  </TableCell>
                </TableRow>
              )}
            </For>
          </TableBody>
        </Table>
      </div>

      <Show when={adding()}>
        <PresetDialog
          title="Add preset"
          name=""
          isNew
          resources={props.rows.find((row) => row.badges.includes('Default'))?.resources ?? props.bounds.min}
          bounds={props.bounds}
          usage={{ projects: 0, runningPods: 0, behind: 0, behindRunningPods: 0 }}
          onSave={async (values) => {
            await props.onCreate(values.name ?? '', values.resources);
            return 'Preset added';
          }}
          onClose={() => setAdding(false)}
        />
      </Show>

      <Show when={editing()}>
        {(row) => (
          <PresetDialog
            title={row().edit.name === null ? `${row().edit.label}: ${row().name}` : `Edit ${row().name}`}
            name={row().edit.name}
            savesUnchanged={row().edit.savesUnchanged}
            resources={row().edit.resources}
            bounds={props.bounds}
            usage={row()}
            onSave={async (values, apply) => {
              const changedName = values.name !== undefined && values.name !== row().name;
              const changedNumbers = !sameResources(values.resources, row().edit.resources) || row().edit.name === null;
              const result = await row().edit.save(
                {
                  name: changedName ? values.name : undefined,
                  resources: changedNumbers ? values.resources : undefined,
                },
                apply
              );
              return appliedMessage(apply, result.applied);
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </Show>

      <Show when={restoring()}>
        {(row) => (
          <ApplyDialog
            title={`Use the platform value for ${row().name}`}
            detail={`Back to ${describeResources(row().usePlatformValue?.resources ?? row().resources)}.`}
            usage={row()}
            onApply={async (apply) => {
              const result = await row().usePlatformValue?.save(apply);
              return result ? appliedMessage(apply, result.applied) : 'Saved';
            }}
            onClose={() => setRestoring(null)}
          />
        )}
      </Show>

      <ConfirmDialog
        open={applying() !== null}
        onOpenChange={(open) => {
          if (!open) setApplying(null);
        }}
        title={`Apply ${applying()?.name ?? 'preset'} to all Projects`}
        description={[
          `${applying()?.behind ?? 0} ${applying()?.behind === 1 ? 'Project runs' : 'Projects run'} at older numbers and ${applying()?.behind === 1 ? 'moves' : 'move'} to ${describeResources(applying()?.resources ?? EMPTY_RESOURCES)}.`,
          (applying()?.behindRunningPods ?? 0) > 0
            ? `${applying()?.behindRunningPods} running ${applying()?.behindRunningPods === 1 ? 'pod restarts' : 'pods restart'}; chats in progress stop.`
            : applying()?.behind === 1
              ? 'It isn’t running, so nothing restarts.'
              : 'None of them is running, so nothing restarts.',
        ].join(' ')}
        confirmLabel="Apply to all"
        onConfirm={() => {
          const row = applying();
          if (!row) return;
          void row
            .applyAll()
            .then((result) => toast.success(appliedMessage('all', result.applied)))
            .catch((error: unknown) => toast.error(failure(error, 'Failed to apply the preset')));
        }}
      />

      <ConfirmDialog
        open={deleting() !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting()?.name ?? 'preset'}`}
        description={[
          (deleting()?.projects ?? 0) > 0
            ? `${deleting()?.projects} ${deleting()?.projects === 1 ? 'Project keeps' : 'Projects keep'} running at the same numbers, as Custom. Agents on it do the same.`
            : 'Agents on it keep the same numbers, as Custom.',
          deleting()?.deleteNote,
        ]
          .filter(Boolean)
          .join(' ')}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          const row = deleting();
          if (!row?.remove) return;
          void row
            .remove()
            .then(() => toast.success(`${row.name} deleted`))
            .catch((error: unknown) => toast.error(failure(error, 'Failed to delete the preset')));
        }}
      />
    </section>
  );
}

function sameResources(a: PodResources, b: PodResources): boolean {
  return (
    a.cpuMillicores === b.cpuMillicores &&
    a.memoryRequestMib === b.memoryRequestMib &&
    a.memoryLimitMib === b.memoryLimitMib
  );
}

function boundsError(resources: PodResources, bounds: PresetBounds): string | null {
  const keys = ['cpuMillicores', 'memoryRequestMib', 'memoryLimitMib'] as const;
  if (keys.some((key) => resources[key] < bounds.min[key] || resources[key] > bounds.max[key])) {
    return `Allowed: ${describeResources(bounds.min)} to ${describeResources(bounds.max)}`;
  }
  if (resources.memoryLimitMib < resources.memoryRequestMib) return 'Memory limit must be at least the request';
  return null;
}

function PresetDialog(props: {
  title: string;
  name: string | null;
  isNew?: boolean;
  savesUnchanged?: boolean;
  resources: PodResources;
  bounds: PresetBounds;
  usage: PresetUsage;
  onSave: (values: { name?: string; resources: PodResources }, apply: PresetApplyMode) => Promise<string>;
  onClose: () => void;
}) {
  const [name, setName] = createSignal(props.name ?? '');
  const shown = {
    cpu: trimNumber(millicoresToCores(props.resources.cpuMillicores)),
    request: trimNumber(mibToGib(props.resources.memoryRequestMib)),
    limit: trimNumber(mibToGib(props.resources.memoryLimitMib)),
  };
  const [cpu, setCpu] = createSignal(shown.cpu);
  const [request, setRequest] = createSignal(shown.request);
  const [limit, setLimit] = createSignal(shown.limit);
  const [askingApply, setAskingApply] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const exactUnlessEdited = (text: string, initial: string, stored: number, convert: (value: number) => number) =>
    text === initial ? stored : convert(parseFloat(text) || 0);
  const resources = (): PodResources => ({
    cpuMillicores: exactUnlessEdited(cpu(), shown.cpu, props.resources.cpuMillicores, coresToMillicores),
    memoryRequestMib: exactUnlessEdited(request(), shown.request, props.resources.memoryRequestMib, gibToMib),
    memoryLimitMib: exactUnlessEdited(limit(), shown.limit, props.resources.memoryLimitMib, gibToMib),
  });
  const error = () => boundsError(resources(), props.bounds);
  const nameMissing = () => props.name !== null && name().trim() === '';
  const numbersChanged = () => !sameResources(resources(), props.resources);
  const changed = () =>
    props.isNew === true ||
    props.savesUnchanged === true ||
    numbersChanged() ||
    (props.name !== null && name().trim() !== props.name);

  const save = async (apply: PresetApplyMode) => {
    setSaving(true);
    try {
      const message = await props.onSave(
        { name: props.name === null ? undefined : name().trim(), resources: resources() },
        apply
      );
      toast.success(message);
      props.onClose();
    } catch (err) {
      toast.error(failure(err, 'Failed to save the preset'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent class="max-w-lg">
        <DialogTitle>{props.title}</DialogTitle>
        <Show
          when={!askingApply()}
          fallback={
            <ApplyChoice
              usage={props.usage}
              pending={saving()}
              onApply={(apply) => void save(apply)}
              onBack={() => setAskingApply(false)}
            />
          }
        >
          <div class="mt-4 space-y-3">
            <Show when={props.name !== null}>
              <TextField value={name()} onChange={setName}>
                <TextFieldLabel class="text-xs text-muted-foreground">Name</TextFieldLabel>
                <TextFieldInput maxLength={40} autocomplete="off" spellcheck={false} />
              </TextField>
            </Show>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ResourceInput
                label="CPU (vCPU)"
                step={0.05}
                min={millicoresToCores(props.bounds.min.cpuMillicores)}
                max={millicoresToCores(props.bounds.max.cpuMillicores)}
                value={cpu()}
                onChange={setCpu}
              />
              <ResourceInput
                label="Memory request (GiB)"
                step={0.5}
                min={mibToGib(props.bounds.min.memoryRequestMib)}
                max={mibToGib(props.bounds.max.memoryRequestMib)}
                value={request()}
                onChange={setRequest}
              />
              <ResourceInput
                label="Memory limit (GiB)"
                step={0.5}
                min={mibToGib(props.bounds.min.memoryLimitMib)}
                max={mibToGib(props.bounds.max.memoryLimitMib)}
                value={limit()}
                onChange={setLimit}
              />
            </div>
            <p class="text-xs text-muted-foreground">
              A pod is guaranteed the memory request and may use up to the limit.
            </p>
            <p class="min-h-4 text-xs text-destructive" aria-live="polite">
              {resources().memoryLimitMib < resources().memoryRequestMib
                ? 'Memory limit must be at least the request.'
                : ''}
            </p>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={error() !== null || nameMissing() || !changed() || saving()}
              onClick={() => {
                if (numbersChanged() && props.usage.projects > 0) setAskingApply(true);
                else void save('new');
              }}
            >
              {saving() ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Show>
      </DialogContent>
    </Dialog>
  );
}

function ApplyDialog(props: {
  title: string;
  detail: string;
  usage: PresetUsage;
  onApply: (apply: PresetApplyMode) => Promise<string>;
  onClose: () => void;
}) {
  const [saving, setSaving] = createSignal(false);
  const apply = async (mode: PresetApplyMode) => {
    setSaving(true);
    try {
      toast.success(await props.onApply(mode));
      props.onClose();
    } catch (err) {
      toast.error(failure(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.detail}</DialogDescription>
        <ApplyChoice
          usage={props.usage}
          pending={saving()}
          onApply={(mode) => void apply(mode)}
          backLabel="Cancel"
          onBack={() => props.onClose()}
        />
      </DialogContent>
    </Dialog>
  );
}

function ApplyChoice(props: {
  usage: PresetUsage;
  pending: boolean;
  backLabel?: string;
  onApply: (apply: PresetApplyMode) => void;
  onBack: () => void;
}) {
  return (
    <>
      <Show
        when={props.usage.projects > 0}
        fallback={
          <>
            <p class="mt-3 text-xs text-muted-foreground">No Project uses it yet, so only new Projects are affected.</p>
            <div class="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={props.pending} onClick={() => props.onBack()}>
                {props.backLabel ?? 'Back'}
              </Button>
              <Button size="sm" disabled={props.pending} onClick={() => props.onApply('new')}>
                {props.pending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </>
        }
      >
        <div class="mt-3 rounded-lg border border-border p-3 text-xs text-muted-foreground space-y-1">
          <p>New Projects get the new numbers either way. Existing Projects keep theirs unless you apply to all.</p>
          <p class="tabular-nums">
            {props.usage.projects} existing {props.usage.projects === 1 ? 'Project uses' : 'Projects use'} it.
          </p>
          <Show when={props.usage.runningPods > 0}>
            <p class="flex items-start gap-1.5">
              <AlertTriangle class="of-ink of-tone-needs-you w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
              Apply to all restarts {props.usage.runningPods} running {props.usage.runningPods === 1 ? 'pod' : 'pods'}.
              Chats in progress stop.
            </p>
          </Show>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={props.pending} onClick={() => props.onBack()}>
            {props.backLabel ?? 'Back'}
          </Button>
          <Button size="sm" variant="outline" disabled={props.pending} onClick={() => props.onApply('new')}>
            New Projects only
          </Button>
          <Button size="sm" disabled={props.pending} onClick={() => props.onApply('all')}>
            {props.pending ? 'Applying…' : 'Apply to all'}
          </Button>
        </div>
      </Show>
    </>
  );
}

function ResourceInput(props: {
  label: string;
  step: number;
  min: number;
  max: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const outOfRange = () => {
    const value = parseFloat(props.value);
    return Number.isNaN(value) || value < props.min || value > props.max;
  };
  return (
    <NumberField
      class="space-y-1"
      minValue={0}
      step={props.step}
      value={props.value}
      onChange={props.onChange}
      validationState={outOfRange() ? 'invalid' : 'valid'}
    >
      <NumberFieldLabel class="text-xs text-muted-foreground">{props.label}</NumberFieldLabel>
      <NumberFieldGroup>
        <NumberFieldInput aria-invalid={outOfRange()} />
        <NumberFieldIncrementTrigger />
        <NumberFieldDecrementTrigger />
      </NumberFieldGroup>
      <span class={cn('block text-xs tabular-nums', outOfRange() ? 'text-destructive' : 'text-muted-foreground/70')}>
        {trimNumber(props.min)}–{trimNumber(props.max)}
      </span>
    </NumberField>
  );
}

function QueryState(props: { pending: boolean; error: boolean; onRetry: () => void; children: JSX.Element }) {
  return (
    <>
      <Show when={props.pending}>
        <div class="rounded-lg border border-border overflow-hidden bg-card divide-y divide-border">
          <For each={[0, 1, 2]}>
            {() => (
              <div class="flex items-center gap-4 px-4 py-3.5">
                <Skeleton class="h-4 w-48" />
                <Skeleton class="h-4 w-20 ml-auto" />
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={!props.pending && props.error}>
        <div class="rounded-lg border border-dashed border-border text-center py-16 text-muted-foreground">
          <AlertTriangle class="of-ink of-tone-needs-you w-10 h-10 mx-auto mb-3 opacity-70" aria-hidden="true" />
          <p class="text-sm font-medium text-foreground">Couldn’t load the Resources</p>
          <Button variant="outline" size="sm" class="mt-4" onClick={() => props.onRetry()}>
            <RefreshCw class="w-3.5 h-3.5" aria-hidden="true" />
            Try again
          </Button>
        </div>
      </Show>
      {props.children}
    </>
  );
}
