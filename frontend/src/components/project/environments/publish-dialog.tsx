import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { Switch, SwitchControl, SwitchLabel, SwitchThumb } from '~/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { TextField, TextFieldInput, TextFieldLabel } from '~/components/ui/text-field';
import { GitBranch, Rocket } from '~/components/icons';
import { usePublish, usePublishForm, type PublishFormVariable, type PublishTarget } from '~/api/publish';
import { useProjects } from '~/api/projects';
import { useJobDock } from '~/components/project/jobs/job-dock-context';

type VariableGroupId = 'fresh' | 'custom' | 'same';

const DEFAULT_OPEN_GROUPS: Record<VariableGroupId, boolean> = { fresh: true, custom: true, same: false };

function ChoiceRow(props: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label class="flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-2.5 py-2 transition-colors hover:bg-accent/50">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
        class="h-3.5 w-3.5 shrink-0 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <span class="min-w-0 flex-1 truncate text-xs text-foreground">{props.label}</span>
      <Show when={props.hint}>
        <span class="min-w-0 max-w-[55%] truncate text-right text-[0.6875rem] text-muted-foreground">{props.hint}</span>
      </Show>
    </label>
  );
}

function chosen(selection: Record<string, boolean>): string[] {
  return Object.entries(selection)
    .filter(([, on]) => on)
    .map(([choiceId]) => choiceId);
}

export interface PublishDialogProps {
  projectId: string;
  target: PublishTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PublishDialog(props: PublishDialogProps) {
  const projectId = () => props.projectId;
  const targetId = () => props.target?.environmentId ?? null;
  const targetName = () => props.target?.name ?? 'this environment';

  const [variables, setVariables] = createSignal<Record<string, string>>({});
  const [scheduleSelection, setScheduleSelection] = createSignal<Record<string, boolean>>({});
  const [serviceSelection, setServiceSelection] = createSignal<Record<string, boolean>>({});
  const [withData, setWithData] = createSignal(false);
  const [typedName, setTypedName] = createSignal('');
  const [openGroups, setOpenGroups] = createSignal(DEFAULT_OPEN_GROUPS);
  const [tab, setTab] = createSignal('variables');
  const [confirmOpen, setConfirmOpen] = createSignal(false);

  const projects = useProjects({ enabled: () => props.open });
  const devAuthIsManual = () => projects.data?.find((p) => p.id === props.projectId)?.authMode === 'manual';

  const form = usePublishForm(projectId, targetId, { enabled: () => props.open });
  const publish = usePublish();
  const jobDock = useJobDock();

  createEffect(() => {
    const data = form.data;
    if (!data) return;
    if (data.environmentId !== targetId()) return;
    setVariables(Object.fromEntries(data.variables.map((v) => [v.key, v.value])));
    setScheduleSelection(Object.fromEntries(data.schedules.map((s) => [s.id, s.selected])));
    setServiceSelection(Object.fromEntries(data.services.map((s) => [s.id, s.selected])));
    setWithData(false);
    setOpenGroups(DEFAULT_OPEN_GROUPS);
    setTab('variables');
  });

  const close = () => {
    props.onOpenChange(false);
    setTimeout(() => {
      setVariables({});
      setScheduleSelection({});
      setServiceSelection({});
      setWithData(false);
      setTypedName('');
      setOpenGroups(DEFAULT_OPEN_GROUPS);
      setConfirmOpen(false);
    }, 200);
  };

  const isFirstPublish = createMemo(() => form.data?.isFirstPublish ?? !props.target?.projectEnvironmentId);

  const submitLabel = () => (isFirstPublish() ? 'Publish' : 'Publish update');

  const formVariables = () => form.data?.variables ?? [];
  const formSchedules = () => form.data?.schedules ?? [];
  const formServices = () => form.data?.services ?? [];
  const replacesData = () => withData() && !isFirstPublish();
  const confirmBlocked = () => replacesData() && typedName().trim() !== targetName();

  const groups = createMemo(() =>
    [
      {
        id: 'fresh' as VariableGroupId,
        name: `New in ${targetName()}`,
        tone: 'of-tone-needs-you',
        note: 'prefilled from Development',
        hint: `Set real ${targetName()} values before publishing.`,
        attention: true,
        variables: formVariables().filter((v) => v.isNew),
      },
      {
        id: 'custom' as VariableGroupId,
        name: 'Different from Development',
        tone: 'of-tone-done',
        note: 'kept as-is on publish',
        attention: false,
        variables: formVariables().filter((v) => !v.isNew && v.value !== v.devValue),
      },
      {
        id: 'same' as VariableGroupId,
        name: 'Same as Development',
        tone: 'of-tone-running',
        note: 'identical in both environments',
        attention: false,
        variables: formVariables().filter((v) => !v.isNew && v.value === v.devValue),
      },
    ].filter((group) => group.variables.length > 0)
  );

  const unreviewedKeys = createMemo(() =>
    formVariables()
      .filter((v) => v.isNew && (variables()[v.key] ?? '') === v.devValue)
      .map((v) => v.key)
  );

  const selectedScheduleCount = () => Object.values(scheduleSelection()).filter(Boolean).length;

  const toggleGroup = (id: VariableGroupId) => setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));

  const runPublish = async () => {
    const id = targetId();
    const target = props.target;
    if (!id || !target) return;
    try {
      await publish.mutateAsync({
        projectId: projectId(),
        dto: {
          environmentId: id,
          variables: variables(),
          scheduleIds: chosen(scheduleSelection()),
          serviceIds: chosen(serviceSelection()),
          withData: withData(),
        },
      });
      jobDock.trackPublish({
        projectId: projectId(),
        environmentId: id,
        environmentName: target.name,
      });
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start publish');
    }
  };

  const variableRow = (variable: PublishFormVariable, attention: boolean) => (
    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-2 sm:flex-nowrap"
      classList={{ 'of-wash of-tone-needs-you': attention }}
    >
      <code
        class="min-w-0 flex-1 truncate font-mono text-xs text-foreground sm:w-[38%] sm:flex-none"
        title={variable.key}
      >
        {variable.key}
      </code>
      <input
        type="text"
        value={variables()[variable.key] ?? ''}
        onInput={(e) => setVariables((prev) => ({ ...prev, [variable.key]: e.currentTarget.value }))}
        class="order-last h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:order-none sm:flex-1"
        placeholder="value"
        aria-label={`${variable.key} value in ${targetName()}`}
      />
      <span class="of-ink of-tone-done w-11 shrink-0 text-right text-[0.625rem]">
        <Show when={(variables()[variable.key] ?? '') !== variable.value}>edited</Show>
      </span>
    </div>
  );

  const variablesPanel = () => (
    <div class="space-y-4">
      <For each={groups()}>
        {(group) => (
          <div>
            <div class="flex min-w-0 items-center gap-2 pb-1.5">
              <span class={`of-dot h-1.5 w-1.5 ${group.tone}`} />
              <span class="whitespace-nowrap text-xs font-medium text-foreground">{group.name}</span>
              <span class="text-[0.6875rem] text-muted-foreground">{group.variables.length}</span>
              <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground">— {group.note}</span>
              <button
                class="mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                aria-expanded={openGroups()[group.id]}
                onClick={() => toggleGroup(group.id)}
              >
                {openGroups()[group.id] ? 'Hide' : 'Show'}
              </button>
            </div>
            <Show when={openGroups()[group.id]}>
              <div
                class="of-hair divide-y divide-border overflow-hidden rounded-md border"
                classList={{ 'of-tone-needs-you': group.attention, 'of-tone-neutral': !group.attention }}
              >
                <For each={group.variables}>{(variable) => variableRow(variable, group.attention)}</For>
              </div>
              <Show when={group.hint}>
                <p class="mt-1.5 text-[0.6875rem] text-muted-foreground">{group.hint}</p>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </div>
  );

  const schedulesPanel = () => (
    <div class="space-y-2">
      <p class="text-xs text-muted-foreground">Choose which schedules run in this environment.</p>
      <div class="space-y-1">
        <For each={formSchedules()}>
          {(schedule) => (
            <ChoiceRow
              label={schedule.name}
              checked={scheduleSelection()[schedule.id] ?? false}
              onChange={(checked) => setScheduleSelection((prev) => ({ ...prev, [schedule.id]: checked }))}
            />
          )}
        </For>
      </div>
    </div>
  );

  const servicesPanel = () => (
    <div class="space-y-2">
      <p class="text-xs font-medium text-foreground">External Services</p>
      <p class="text-xs text-muted-foreground">
        Choose which services get Development's configuration in {targetName()}.
      </p>
      <div class="space-y-1">
        <For each={formServices()}>
          {(service) => (
            <ChoiceRow
              label={service.name}
              hint={service.targetHasOwn ? `replaces ${targetName()}'s own configuration` : `connects ${targetName()}`}
              checked={serviceSelection()[service.id] ?? false}
              onChange={(checked) => setServiceSelection((prev) => ({ ...prev, [service.id]: checked }))}
            />
          )}
        </For>
      </div>
    </div>
  );

  const dataPanel = (developmentHasData: boolean) => (
    <div class="rounded-md border border-border px-3 py-2.5" classList={{ 'of-wash of-tone-failed': replacesData() }}>
      <Switch checked={withData()} onChange={setWithData} disabled={!developmentHasData} class="gap-2.5">
        <SwitchControl>
          <SwitchThumb />
        </SwitchControl>
        <SwitchLabel class="text-xs text-foreground">Replace {targetName()}'s data with Development's</SwitchLabel>
      </Switch>
      <p class="mt-1.5 text-xs text-muted-foreground">
        {!developmentHasData
          ? 'Development has no data to copy.'
          : !withData()
            ? `${targetName()} keeps its own data.`
            : isFirstPublish()
              ? `${targetName()} starts with a copy of Development's data. Development pauses while it is copied.`
              : `${targetName()}'s data is deleted and replaced with Development's. Development pauses while it is copied.`}
      </p>
    </div>
  );

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent class="flex max-h-[90vh] w-[calc(100%-1.5rem)] max-w-2xl flex-col p-4 sm:w-full sm:p-6">
        <DialogTitle class="flex items-center gap-2">
          <Rocket class="h-4 w-4 shrink-0 text-primary" />
          {isFirstPublish() ? `Publish to ${targetName()}` : `Publish update to ${targetName()}`}
        </DialogTitle>
        <DialogDescription>
          {isFirstPublish()
            ? `Publish your Development app and run it in ${targetName()}.`
            : `Publish your latest Development changes to the app running in ${targetName()}.`}
        </DialogDescription>

        <div class="-ml-1 -mr-2 mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden py-1 pl-1 pr-2">
          <Show when={devAuthIsManual()}>
            <p class="of-note of-tone-needs-you text-xs">
              Development uses manual OIDC auth, which the new environment inherits. After publishing, register the new
              environment's callback URL (shown in its Auth dialog) with your identity provider, or sign-in there will
              fail.
            </p>
          </Show>

          <Show when={targetId()}>
            <Show when={!form.isPending} fallback={<Skeleton class="h-24 w-full" />}>
              <Show when={form.data}>
                {(data) => (
                  <>
                    <Show when={formVariables().length > 0 && formSchedules().length > 0}>
                      <Tabs value={tab()} onChange={setTab}>
                        <TabsList>
                          <TabsTrigger value="variables">
                            Environment variables
                            <Show
                              when={unreviewedKeys().length > 0}
                              fallback={
                                <Badge variant="secondary" class="ml-1.5 rounded-full px-1.5 py-0 text-[0.625rem]">
                                  {formVariables().length}
                                </Badge>
                              }
                            >
                              <Badge variant="warning" class="ml-1.5 rounded-full px-1.5 py-0 text-[0.625rem]">
                                {unreviewedKeys().length} to review
                              </Badge>
                            </Show>
                          </TabsTrigger>
                          <TabsTrigger value="schedules">
                            Schedules
                            <Badge variant="secondary" class="ml-1.5 rounded-full px-1.5 py-0 text-[0.625rem]">
                              {selectedScheduleCount()} of {formSchedules().length}
                            </Badge>
                          </TabsTrigger>
                        </TabsList>
                        <TabsContent value="variables">{variablesPanel()}</TabsContent>
                        <TabsContent value="schedules">{schedulesPanel()}</TabsContent>
                      </Tabs>
                    </Show>

                    <Show when={formVariables().length > 0 && formSchedules().length === 0}>{variablesPanel()}</Show>

                    <Show when={formVariables().length === 0 && formSchedules().length > 0}>
                      <div class="space-y-2">
                        <p class="text-xs font-medium text-foreground">Schedules</p>
                        {schedulesPanel()}
                      </div>
                    </Show>

                    <Show when={formVariables().length === 0 && formSchedules().length === 0}>
                      <p class="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                        No variables or schedules to configure.{' '}
                        {data().isFirstPublish
                          ? 'This is the first publish to this environment.'
                          : 'Publishing again updates the running app.'}
                      </p>
                    </Show>

                    <Show when={formServices().length > 0}>{servicesPanel()}</Show>

                    {dataPanel(data().developmentHasData)}
                  </>
                )}
              </Show>
            </Show>
          </Show>
        </div>

        <div class="mt-5 flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Show when={unreviewedKeys().length > 0}>
            <span class="mr-auto flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
              <span class="of-dot of-tone-needs-you h-1.5 w-1.5" />
              <span class="truncate">
                {unreviewedKeys().length} new{' '}
                {unreviewedKeys().length === 1 ? 'variable still carries its' : 'variables still carry their'}{' '}
                Development value
              </span>
            </span>
          </Show>
          <Button size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setTypedName('');
              setConfirmOpen(true);
            }}
            loading={publish.isPending}
            disabled={!targetId() || form.isPending}
          >
            <GitBranch class="h-3.5 w-3.5" />
            {submitLabel()}
          </Button>
        </div>
      </DialogContent>

      <ConfirmDialog
        open={confirmOpen()}
        onOpenChange={setConfirmOpen}
        title={isFirstPublish() ? `Publish to ${targetName()}?` : `Publish update to ${targetName()}?`}
        description={
          isFirstPublish()
            ? withData()
              ? `This publishes your Development app with a copy of its data to ${targetName()} and starts it there.`
              : `This publishes your Development app to ${targetName()} and starts it there.`
            : undefined
        }
        confirmLabel={submitLabel()}
        variant={isFirstPublish() ? 'default' : 'destructive'}
        confirmDisabled={confirmBlocked()}
        onConfirm={runPublish}
      >
        <Show when={replacesData()}>
          <div class="mt-3 space-y-2">
            <p class="of-note of-tone-failed text-xs">
              {targetName()}'s data is deleted and replaced with Development's. This can't be undone.
            </p>
            <TextField value={typedName()} onChange={setTypedName} class="gap-1.5">
              <TextFieldLabel>
                Type{' '}
                <span class="font-mono text-foreground" translate="no">
                  {targetName()}
                </span>{' '}
                to confirm
              </TextFieldLabel>
              <TextFieldInput
                name="confirmEnvironment"
                autocomplete="off"
                autocapitalize="none"
                autocorrect="off"
                spellcheck={false}
                class="font-mono"
              />
            </TextField>
          </div>
        </Show>
        <Show when={unreviewedKeys().length > 0}>
          <div class="of-note of-tone-needs-you mt-3 flex-col text-xs">
            <p class="font-medium">
              {unreviewedKeys().length} new {unreviewedKeys().length === 1 ? 'variable' : 'variables'} will go live with
              Development values:
            </p>
            <ul class="mt-1.5 space-y-0.5 font-mono text-[0.6875rem]">
              <For each={unreviewedKeys()}>{(key) => <li class="truncate">{key}</li>}</For>
            </ul>
          </div>
        </Show>
      </ConfirmDialog>
    </Dialog>
  );
}
