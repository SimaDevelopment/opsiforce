import { For, Show, createSignal, createEffect, createMemo } from 'solid-js';
import { toast } from 'solid-sonner';
import { useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import {
  api,
  podClassApi,
  type Project,
  type PodClass,
  type UpdateProjectPodClassDto,
  type RequestLogMode,
} from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { useRestartProjectEnvironment } from '~/api/environments';
import { Permission } from '~/constants/permissions';
import { CircleDollarSign, Clock, Cpu, RotateCcw, ScrollText } from '~/components/icons';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '~/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '~/components/ui/tabs';
import { Button } from '~/components/ui/button';
import { BudgetRow } from '~/components/ui/budget-row';
import { TimeoutRow } from '~/components/ui/timeout-row';
import { RequestLoggingControls } from '~/components/ui/request-logging-controls';
import { ResourcesSelector } from '~/components/project/resources-selector';
import { Skeleton } from '~/components/ui/skeleton';
import { MIN_IDLE_TIMEOUT_LABEL, MIN_IDLE_TIMEOUT_MS, msToUnit, unitToMs } from '~/lib/duration-units';
import { coresToMillicores, gibToMib, mibToGib, millicoresToCores, trimNumber } from '~/lib/pod-resources';
import { type BudgetConfig } from '~/constants/budget';

interface BudgetEntry {
  keyType: 'chat' | 'backend';
  maxBudget: number | null;
  budgetDuration: string | null;
  currentUsage: number;
}

const KEY_TYPE_LABELS: Record<string, string> = {
  chat: 'Agent (Chat)',
  backend: 'App Backend',
};

interface BudgetDraft {
  budget: string;
  duration: string;
}

export function ProjectSettings(props: {
  projectId: string;
  activeEnvironmentId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const { hasPermission } = usePermissions();
  const canBudgets = () => hasPermission(Permission.manageProjectBudgetSettings);
  const canTimeouts = () => hasPermission(Permission.manageProjectTimeoutSettings);
  const canPod = () => hasPermission(Permission.manageProjectPodSettings);
  const canLogging = () => hasPermission(Permission.manageProjectLoggingSettings);
  const defaultTab = createMemo(() =>
    canBudgets() ? 'budgets' : canTimeouts() ? 'timeouts' : canPod() ? 'resources' : 'logging'
  );
  const [activeTab, setActiveTab] = createSignal(defaultTab());
  const [budgetDrafts, setBudgetDrafts] = createSignal<Record<string, BudgetDraft>>({});
  const [projectBudgetDraft, setProjectBudgetDraft] = createSignal('');
  const [projectDurationDraft, setProjectDurationDraft] = createSignal('1M');
  const [agentValue, setAgentValue] = createSignal('');
  const [agentUnit, setAgentUnit] = createSignal('minutes');
  const [appValue, setAppValue] = createSignal('');
  const [appUnit, setAppUnit] = createSignal('days');
  const [loggingMode, setLoggingMode] = createSignal<RequestLogMode>('full');
  const [loggingBodyLimitKb, setLoggingBodyLimitKb] = createSignal('');
  const [podClassDraft, setPodClassDraft] = createSignal<PodClass>('small');
  const [cpuCoresDraft, setCpuCoresDraft] = createSignal('');
  const [memRequestGibDraft, setMemRequestGibDraft] = createSignal('');
  const [memLimitGibDraft, setMemLimitGibDraft] = createSignal('');
  const [budgetsDirty, setBudgetsDirty] = createSignal(false);
  const [timeoutsDirty, setTimeoutsDirty] = createSignal(false);
  const [loggingDirty, setLoggingDirty] = createSignal(false);
  const [podDirty, setPodDirty] = createSignal(false);
  const [podNeedsRestart, setPodNeedsRestart] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const restartEnvironment = useRestartProjectEnvironment();
  const restartTargetEnvId = () => props.activeEnvironmentId ?? props.projectId;

  const podClasses = createAppQuery(() => ({
    queryKey: ['pod-classes'],
    queryFn: () => podClassApi.catalog(),
    enabled: props.open && canPod(),
  }));

  const customLimitError = () =>
    podClassDraft() === 'custom' && (parseFloat(memLimitGibDraft()) || 0) < (parseFloat(memRequestGibDraft()) || 0);

  const project = createAppQuery(() => ({
    queryKey: ['projects', props.projectId],
    queryFn: () => api.get<Project>(`/projects/${props.projectId}`),
    enabled: props.open,
  }));

  const budgets = createAppQuery(() => ({
    queryKey: ['projects', props.projectId, 'budgets'],
    queryFn: () => api.get<BudgetEntry[]>(`/usage/projects/${props.projectId}/budgets`),
    enabled: props.open,
  }));

  const projectBudget = createAppQuery(() => ({
    queryKey: ['projects', props.projectId, 'budget'],
    queryFn: () => api.get<BudgetConfig>(`/usage/projects/${props.projectId}/budget`),
    enabled: props.open,
  }));

  createEffect(() => {
    if (budgets.data) {
      const drafts: Record<string, BudgetDraft> = {};
      for (const entry of budgets.data) {
        drafts[entry.keyType] = {
          budget: entry.maxBudget != null ? String(entry.maxBudget) : '',
          duration: entry.budgetDuration ?? '1M',
        };
      }
      setBudgetDrafts(drafts);
      setBudgetsDirty(false);
    }
  });

  createEffect(() => {
    if (projectBudget.data) {
      setProjectBudgetDraft(projectBudget.data.maxBudget != null ? String(projectBudget.data.maxBudget) : '');
      setProjectDurationDraft(projectBudget.data.budgetDuration ?? '1M');
    }
  });

  createEffect(() => {
    if (project.data) {
      const agent = msToUnit(project.data.timeoutIdle);
      setAgentValue(agent.value);
      setAgentUnit(agent.unit);
      const app = msToUnit(project.data.appTimeoutIdle);
      setAppValue(app.value);
      setAppUnit(app.unit);
      setTimeoutsDirty(false);
    }
  });

  createEffect(() => {
    if (project.data) {
      setPodClassDraft(project.data.podClass);
      setCpuCoresDraft(trimNumber(millicoresToCores(project.data.cpuMillicores)));
      setMemRequestGibDraft(trimNumber(mibToGib(project.data.memoryRequestMib)));
      setMemLimitGibDraft(trimNumber(mibToGib(project.data.memoryLimitMib)));
      setPodDirty(false);
    }
  });

  createEffect(() => {
    if (project.data) {
      setLoggingMode(project.data.requestLogMode);
      setLoggingBodyLimitKb(String(Math.round(project.data.requestLogBodyLimit / 1024)));
      setLoggingDirty(false);
    }
  });

  function updateBudgetDraft(keyType: string, field: keyof BudgetDraft, value: string) {
    setBudgetDrafts((prev) => ({ ...prev, [keyType]: { ...prev[keyType], [field]: value } }));
    setBudgetsDirty(true);
  }

  const isDirty = () =>
    activeTab() === 'budgets'
      ? budgetsDirty()
      : activeTab() === 'timeouts'
        ? timeoutsDirty()
        : activeTab() === 'logging'
          ? loggingDirty()
          : podDirty();

  async function handleSave() {
    setSaving(true);
    try {
      if (activeTab() === 'budgets') {
        const updates: Promise<unknown>[] = [];
        const projectBudgetValue = parseFloat(projectBudgetDraft());
        if (!isNaN(projectBudgetValue)) {
          updates.push(
            api.put(`/usage/projects/${props.projectId}/budget`, {
              maxBudget: projectBudgetValue,
              budgetDuration: projectDurationDraft(),
            })
          );
        }
        for (const [keyType, draft] of Object.entries(budgetDrafts())) {
          updates.push(
            api.put(`/usage/projects/${props.projectId}/budgets`, {
              keyType,
              maxBudget: parseFloat(draft.budget) || 0,
              budgetDuration: draft.duration,
            })
          );
        }
        await Promise.all(updates);
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['projects', props.projectId, 'budgets'] }),
          qc.invalidateQueries({ queryKey: ['projects', props.projectId, 'budget'] }),
        ]);
        toast.success('Budgets updated');
      } else if (activeTab() === 'timeouts') {
        const projectData = project.data;
        if (!projectData) throw new Error('Project not loaded');

        const timeoutIdle = unitToMs(agentValue(), agentUnit(), projectData.timeoutIdle);
        const appTimeoutIdle = unitToMs(appValue(), appUnit(), projectData.appTimeoutIdle);
        if (timeoutIdle < MIN_IDLE_TIMEOUT_MS || appTimeoutIdle < MIN_IDLE_TIMEOUT_MS) {
          toast.error(`Idle timeouts must be at least ${MIN_IDLE_TIMEOUT_LABEL}`);
          return;
        }

        await api.patch(`/projects/${props.projectId}`, { timeoutIdle, appTimeoutIdle });
        await qc.invalidateQueries({ queryKey: ['projects', props.projectId] });
        toast.success('Timeouts updated');
      } else if (activeTab() === 'logging') {
        const kb = parseFloat(loggingBodyLimitKb());
        const bodyLimit = Number.isFinite(kb) ? Math.max(0, Math.round(kb * 1024)) : undefined;
        await api.put(`/projects/${props.projectId}/logging`, {
          mode: loggingMode(),
          bodyLimit,
        });
        await qc.invalidateQueries({ queryKey: ['projects', props.projectId] });
        toast.success('Request logging updated');
      } else {
        const podClass = podClassDraft();
        const dto: UpdateProjectPodClassDto =
          podClass === 'custom'
            ? {
                podClass,
                cpuMillicores: coresToMillicores(parseFloat(cpuCoresDraft()) || 0),
                memoryRequestMib: gibToMib(parseFloat(memRequestGibDraft()) || 0),
                memoryLimitMib: gibToMib(parseFloat(memLimitGibDraft()) || 0),
              }
            : { podClass };
        await podClassApi.update(props.projectId, dto);
        await qc.invalidateQueries({ queryKey: ['projects', props.projectId] });
        setPodNeedsRestart(true);
        toast.success('Resources updated');
      }
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function handleOpenChange(open: boolean) {
    if (!open) setPodNeedsRestart(false);
    props.onOpenChange(open);
  }

  function handleCancel() {
    handleOpenChange(false);
  }

  async function handleRestartToApply() {
    try {
      await restartEnvironment.mutateAsync({ projectId: props.projectId, environmentId: restartTargetEnvId() });
      setPodNeedsRestart(false);
      toast.success('Restarting to apply new resources');
    } catch {
      toast.error('Failed to restart');
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent align="top" class="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogTitle>Project Settings</DialogTitle>
        <DialogDescription>
          Configure budgets, timeouts, resources, and request logging for this project.
        </DialogDescription>

        <Tabs defaultValue={defaultTab()} class="mt-4 flex min-h-0 flex-1 flex-col" onChange={setActiveTab}>
          <TabsList class="shrink-0">
            <Show when={canBudgets()}>
              <TabsTrigger value="budgets">
                <CircleDollarSign class="w-3.5 h-3.5 mr-1.5" />
                Budgets
              </TabsTrigger>
            </Show>
            <Show when={canTimeouts()}>
              <TabsTrigger value="timeouts">
                <Clock class="w-3.5 h-3.5 mr-1.5" />
                Timeouts
              </TabsTrigger>
            </Show>
            <Show when={canPod()}>
              <TabsTrigger value="resources">
                <Cpu class="w-3.5 h-3.5 mr-1.5" />
                Resources
              </TabsTrigger>
            </Show>
            <Show when={canLogging()}>
              <TabsTrigger value="logging">
                <ScrollText class="w-3.5 h-3.5 mr-1.5" />
                Logging
              </TabsTrigger>
            </Show>
          </TabsList>

          <div class="mt-3 min-h-0 overflow-y-auto pr-1">
            <Show when={canBudgets()}>
              <TabsContent value="budgets" class="mt-0">
                <div class="space-y-3">
                  <BudgetRow
                    label="Project Budget"
                    currentBudget={projectBudget.data?.maxBudget ?? null}
                    currentSpend={projectBudget.data?.currentUsage ?? 0}
                    draftBudget={projectBudgetDraft()}
                    draftDuration={projectDurationDraft()}
                    onBudgetChange={(v) => {
                      setProjectBudgetDraft(v);
                      setBudgetsDirty(true);
                    }}
                    onDurationChange={(v) => {
                      setProjectDurationDraft(v);
                      setBudgetsDirty(true);
                    }}
                  />
                  <Show
                    when={budgets.data && budgets.data.length > 0}
                    fallback={
                      <Show
                        when={budgets.isLoading}
                        fallback={<p class="text-xs text-muted-foreground py-4 text-center">No API keys configured.</p>}
                      >
                        <div class="space-y-2 py-2">
                          <Skeleton class="h-8 w-full" />
                          <Skeleton class="h-8 w-full" />
                        </div>
                      </Show>
                    }
                  >
                    <For each={budgets.data}>
                      {(entry) => (
                        <BudgetRow
                          label={KEY_TYPE_LABELS[entry.keyType] ?? entry.keyType}
                          currentBudget={entry.maxBudget}
                          currentSpend={entry.currentUsage}
                          draftBudget={budgetDrafts()[entry.keyType]?.budget ?? ''}
                          draftDuration={budgetDrafts()[entry.keyType]?.duration ?? '1M'}
                          onBudgetChange={(v) => updateBudgetDraft(entry.keyType, 'budget', v)}
                          onDurationChange={(v) => updateBudgetDraft(entry.keyType, 'duration', v)}
                        />
                      )}
                    </For>
                  </Show>
                </div>
              </TabsContent>
            </Show>

            <Show when={canTimeouts()}>
              <TabsContent value="timeouts" class="mt-0">
                <div class="space-y-3">
                  <TimeoutRow
                    label="Agent Idle Timeout"
                    description={`How long the coding agent can be idle before pod suspends. Minimum ${MIN_IDLE_TIMEOUT_LABEL}.`}
                    placeholder="30"
                    value={agentValue()}
                    unit={agentUnit()}
                    onValueChange={(v) => {
                      setAgentValue(v);
                      setTimeoutsDirty(true);
                    }}
                    onUnitChange={(v) => {
                      setAgentUnit(v);
                      setTimeoutsDirty(true);
                    }}
                  />
                  <TimeoutRow
                    label="App Idle Timeout"
                    description={`How long the webapp preview stays alive without visitors. Minimum ${MIN_IDLE_TIMEOUT_LABEL}.`}
                    placeholder="7"
                    value={appValue()}
                    unit={appUnit()}
                    onValueChange={(v) => {
                      setAppValue(v);
                      setTimeoutsDirty(true);
                    }}
                    onUnitChange={(v) => {
                      setAppUnit(v);
                      setTimeoutsDirty(true);
                    }}
                  />
                </div>
              </TabsContent>
            </Show>

            <Show when={canPod()}>
              <TabsContent value="resources" class="mt-0">
                <div class="space-y-3">
                  <ResourcesSelector
                    catalog={podClasses.data}
                    selectedClass={podClassDraft()}
                    cpuCores={cpuCoresDraft()}
                    memRequestGib={memRequestGibDraft()}
                    memLimitGib={memLimitGibDraft()}
                    limitError={customLimitError()}
                    disabled={saving()}
                    onSelectClass={(c) => {
                      setPodClassDraft(c);
                      setPodDirty(true);
                    }}
                    onCpuChange={(v) => {
                      setCpuCoresDraft(v);
                      setPodDirty(true);
                    }}
                    onMemRequestChange={(v) => {
                      setMemRequestGibDraft(v);
                      setPodDirty(true);
                    }}
                    onMemLimitChange={(v) => {
                      setMemLimitGibDraft(v);
                      setPodDirty(true);
                    }}
                  />
                  <Show
                    when={podNeedsRestart()}
                    fallback={
                      <p class="text-xs text-muted-foreground/70">
                        Resources apply the next time the environment restarts or resumes.
                      </p>
                    }
                  >
                    <div class="flex items-center justify-between gap-2 rounded-lg border border-border bg-accent/30 p-3">
                      <p class="text-xs text-muted-foreground">Restart the environment to apply the new size.</p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restartEnvironment.isPending}
                        onClick={handleRestartToApply}
                      >
                        <RotateCcw class="w-3.5 h-3.5 mr-1.5" />
                        {restartEnvironment.isPending ? 'Restarting...' : 'Restart to apply'}
                      </Button>
                    </div>
                  </Show>
                </div>
              </TabsContent>
            </Show>

            <Show when={canLogging()}>
              <TabsContent value="logging" class="mt-0">
                <div class="space-y-3">
                  <p class="text-xs text-muted-foreground">
                    Control how this app's HTTP requests are recorded. Lighter levels reduce proxy overhead and memory
                    use for high-traffic apps.
                  </p>
                  <RequestLoggingControls
                    mode={loggingMode()}
                    bodyLimitKb={loggingBodyLimitKb()}
                    onModeChange={(m) => {
                      setLoggingMode(m);
                      setLoggingDirty(true);
                    }}
                    onBodyLimitKbChange={(v) => {
                      setLoggingBodyLimitKb(v);
                      setLoggingDirty(true);
                    }}
                  />
                </div>
              </TabsContent>
            </Show>
          </div>
        </Tabs>

        <div class="mt-4 flex shrink-0 justify-end gap-2">
          <Button size="sm" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!isDirty() || saving() || customLimitError()} onClick={handleSave}>
            {saving() ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
