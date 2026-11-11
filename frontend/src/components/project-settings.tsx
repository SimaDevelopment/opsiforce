import { For, Show, createSignal, createEffect, createMemo } from 'solid-js';
import { toast } from '~/lib/toast';
import { useQueryClient } from '@tanstack/solid-query';
import { projectKeys } from '~/api/projects';
import { workspaceKeys } from '~/api/workspaces';
import { createAppQuery } from '~/lib/create-app-query';
import { api, podClassApi, type InactivityCleanup, type Project, type RequestLogMode } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { useRestartProjectEnvironment } from '~/api/environments';
import { Archive, CircleDollarSign, Clock, Cpu, RotateCcw, ScrollText, Trash2 } from '~/components/icons';
import { SettingsDialog, type SettingsDialogTab } from '~/components/ui/settings-dialog';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { BudgetRow } from '~/components/ui/budget-row';
import { TimeoutRow } from '~/components/ui/timeout-row';
import { RequestLoggingControls } from '~/components/ui/request-logging-controls';
import { ResourcesSelector } from '~/components/resources/resources-selector';
import { createResourcesDraft } from '~/components/resources/resources-draft';
import { InactivityCleanupFields, createInactivityCleanupDraft } from '~/components/inactivity-cleanup-fields';
import { usePodClassCatalog } from '~/api/pod-classes';
import {
  CLEANUP_STEPS,
  capitalized,
  formatIdleFor,
  formatMoment,
  formatRelative,
  isDue,
  newlyDueCleanup,
  formatDuration,
  scheduledCleanups,
  type CleanupStep,
} from '~/lib/inactivity-cleanup';
import { Skeleton } from '~/components/ui/skeleton';
import { MIN_IDLE_TIMEOUT_LABEL, MIN_IDLE_TIMEOUT_MS, msToUnit, unitToMs } from '~/lib/duration-units';
import { type BudgetConfig } from '~/constants/budget';
import { cn } from '~/lib/cn';

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
  const canBudgets = () => hasPermission('can_manage_project_budget_settings');
  const canTimeouts = () => hasPermission('can_manage_project_timeout_settings');
  const canPod = () => hasPermission('can_manage_project_pod_settings');
  const canLogging = () => hasPermission('can_manage_project_logging_settings');
  const canSetCleanup = (step: CleanupStep) => hasPermission(step.permission);
  const canCleanup = () => CLEANUP_STEPS.some(canSetCleanup);
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
  const podDraft = createResourcesDraft();
  const cleanupDraft = createInactivityCleanupDraft();
  const [budgetsDirty, setBudgetsDirty] = createSignal(false);
  const [timeoutsDirty, setTimeoutsDirty] = createSignal(false);
  const [loggingDirty, setLoggingDirty] = createSignal(false);
  const [podNeedsRestart, setPodNeedsRestart] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [confirmDeleteNow, setConfirmDeleteNow] = createSignal(false);

  const restartEnvironment = useRestartProjectEnvironment();
  const restartTargetEnvId = () => props.activeEnvironmentId ?? props.projectId;

  const podClasses = usePodClassCatalog(() => props.open && canPod());

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
      podDraft.reset(project.data);
    }
  });

  createEffect(() => {
    if (project.data) cleanupDraft.reset(project.data);
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
    currentTab() === 'budgets'
      ? budgetsDirty()
      : currentTab() === 'timeouts'
        ? timeoutsDirty()
        : currentTab() === 'logging'
          ? loggingDirty()
          : currentTab() === 'cleanup'
            ? cleanupDraft.dirty()
            : podDraft.dirty();

  const cleanupDueOnSave = () => {
    const data = project.data;
    if (!data || currentTab() !== 'cleanup' || !cleanupDraft.dirty() || cleanupDraft.invalid()) return null;
    return newlyDueCleanup(data.lastActivityAt, data, cleanupDraft.toCleanup(), data.status === 'disabled');
  };

  function handleSave() {
    if (cleanupDueOnSave()?.step.destructive) {
      setConfirmDeleteNow(true);
      return;
    }
    void save();
  }

  async function save() {
    setSaving(true);
    try {
      if (currentTab() === 'budgets') {
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
      } else if (currentTab() === 'timeouts') {
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
      } else if (currentTab() === 'cleanup') {
        const cleanup = cleanupDraft.toCleanup();
        await api.patch(
          `/projects/${props.projectId}`,
          Object.fromEntries(CLEANUP_STEPS.filter(canSetCleanup).map((step) => [step.field, cleanup[step.field]]))
        );
        await Promise.all([
          qc.invalidateQueries({ queryKey: projectKeys.all }),
          qc.invalidateQueries({ queryKey: workspaceKeys.all }),
        ]);
        toast.success('Inactivity cleanup updated');
      } else if (currentTab() === 'logging') {
        const kb = parseFloat(loggingBodyLimitKb());
        const bodyLimit = Number.isFinite(kb) ? Math.max(0, Math.round(kb * 1024)) : undefined;
        await api.put(`/projects/${props.projectId}/logging`, {
          mode: loggingMode(),
          bodyLimit,
        });
        await qc.invalidateQueries({ queryKey: ['projects', props.projectId] });
        toast.success('Request logging updated');
      } else {
        await podClassApi.update(props.projectId, podDraft.toDto());
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

  async function handleRestartToApply() {
    try {
      await restartEnvironment.mutateAsync({ projectId: props.projectId, environmentId: restartTargetEnvId() });
      setPodNeedsRestart(false);
      toast.success('Restarting to apply new resources');
    } catch {
      toast.error('Failed to restart');
    }
  }

  const tabs = createMemo<SettingsDialogTab[]>(() => [
    ...(canBudgets() ? [{ value: 'budgets', label: 'Budgets', icon: CircleDollarSign, content: budgetsTab }] : []),
    ...(canTimeouts() ? [{ value: 'timeouts', label: 'Timeouts', icon: Clock, content: timeoutsTab }] : []),
    ...(canPod() ? [{ value: 'resources', label: 'Resources', icon: Cpu, content: resourcesTab }] : []),
    ...(canLogging() ? [{ value: 'logging', label: 'Logging', icon: ScrollText, content: loggingTab }] : []),
    ...(canCleanup() ? [{ value: 'cleanup', label: 'Cleanup', icon: Archive, content: cleanupTab }] : []),
  ]);

  const currentTab = () =>
    tabs().some((tab) => tab.value === activeTab()) ? activeTab() : (tabs()[0]?.value ?? defaultTab());

  function budgetsTab() {
    return (
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
    );
  }

  function timeoutsTab() {
    return (
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
    );
  }

  function resourcesTab() {
    return (
      <div class="space-y-3">
        <ResourcesSelector catalog={podClasses.data} draft={podDraft} disabled={saving()} current={project.data} />
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
            <Button size="sm" variant="outline" disabled={restartEnvironment.isPending} onClick={handleRestartToApply}>
              <RotateCcw class="w-3.5 h-3.5 mr-1.5" />
              {restartEnvironment.isPending ? 'Restarting…' : 'Restart to apply'}
            </Button>
          </div>
        </Show>
      </div>
    );
  }

  function cleanupTab() {
    return (
      <div class="space-y-3">
        <p class="text-xs text-muted-foreground text-pretty">
          This Project’s own rules, copied from its Agent or the Organization default when it was created.
        </p>
        <Show when={project.data}>
          {(data) => (
            <CleanupSchedule
              lastActivityAt={data().lastActivityAt}
              projectDisabled={data().status === 'disabled'}
              saved={data()}
              draft={cleanupDraft.invalid() ? null : cleanupDraft.toCleanup()}
            />
          )}
        </Show>
        <InactivityCleanupFields draft={cleanupDraft} disabled={saving()} locked={(step) => !canSetCleanup(step)} />
      </div>
    );
  }

  function loggingTab() {
    return (
      <div class="space-y-3">
        <p class="text-xs text-muted-foreground">
          Control how this app's HTTP requests are recorded. Lighter levels reduce proxy overhead and memory use for
          high-traffic apps.
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
    );
  }

  const tabInvalid = () =>
    currentTab() === 'resources'
      ? Boolean(podDraft.limitError())
      : currentTab() === 'cleanup' && cleanupDraft.invalid();

  return (
    <>
      <SettingsDialog
        title="Project Settings"
        description="Configure budgets, timeouts, resources, request logging, and inactivity cleanup for this project."
        open={props.open}
        onOpenChange={handleOpenChange}
        tabs={tabs()}
        activeTab={currentTab()}
        onTabChange={setActiveTab}
        canSave={isDirty() && !tabInvalid()}
        saving={saving()}
        onSave={handleSave}
      />
      <Show when={project.data && cleanupDueOnSave()}>
        {(due) => (
          <ConfirmDialog
            open={confirmDeleteNow()}
            onOpenChange={setConfirmDeleteNow}
            title={`${capitalized(due().step.action)} this Project within the hour?`}
            description={`It has had no activity for ${project.data ? formatIdleFor(project.data.lastActivityAt) : ''}, past the ${formatDuration(cleanupDraft.toCleanup()[due().step.field] ?? 0)} you set. ${[due().step.description, due().step.warning].filter(Boolean).join(' ')}`}
            confirmLabel={`Save and ${due().step.action}`}
            variant="destructive"
            onConfirm={() => void save()}
          />
        )}
      </Show>
    </>
  );
}

function CleanupSchedule(props: {
  lastActivityAt: string;
  projectDisabled: boolean;
  saved: InactivityCleanup;
  draft: InactivityCleanup | null;
}) {
  const shown = () => props.draft ?? props.saved;
  const lastActivity = () => new Date(props.lastActivityAt);
  const scheduled = (step: CleanupStep) =>
    scheduledCleanups(props.lastActivityAt, shown(), props.projectDisabled).find((cleanup) => cleanup.step === step);
  const dueOnSave = () =>
    props.draft && newlyDueCleanup(props.lastActivityAt, props.saved, props.draft, props.projectDisabled);

  return (
    <div class="space-y-2">
      <dl class="rounded-lg border border-border p-3 text-xs grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt class="text-muted-foreground">Last activity</dt>
        <dd class="text-foreground tabular-nums">
          {formatMoment(lastActivity())} · {formatRelative(lastActivity())}
        </dd>
        <For each={CLEANUP_STEPS}>
          {(step) => (
            <>
              <dt class="text-muted-foreground">{capitalized(step.action)}</dt>
              <dd>
                <Show
                  when={!(step.onlyEnabledProjects && props.projectDisabled)}
                  fallback={<span class="text-foreground">Already {step.done}</span>}
                >
                  <ScheduledStep step={step} at={scheduled(step)?.at ?? null} />
                </Show>
              </dd>
            </>
          )}
        </For>
      </dl>
      <Show when={dueOnSave()}>
        {(due) => (
          <p
            class={cn('of-note text-xs', due().step.destructive ? 'of-tone-failed' : 'of-tone-needs-you')}
            role="status"
          >
            <Show
              when={due().step.destructive}
              fallback={<Archive class="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />}
            >
              <Trash2 class="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
            </Show>
            <span>
              Saving {due().step.upcoming.toLowerCase()} this Project within the hour. It has had no activity for{' '}
              {formatIdleFor(props.lastActivityAt)}.
            </span>
          </p>
        )}
      </Show>
    </div>
  );
}

function ScheduledStep(props: { step: CleanupStep; at: Date | null }) {
  return (
    <Show when={props.at} fallback={<span class="text-muted-foreground">Never</span>}>
      {(at) => (
        <Show when={!isDue(at())} fallback={<span class="of-ink of-tone-failed font-medium">Within the hour</span>}>
          <span class={cn('tabular-nums', props.step.destructive ? 'of-ink of-tone-failed' : 'text-foreground')}>
            {props.step.upcoming} {formatMoment(at())} · {formatRelative(at())}
          </span>
        </Show>
      )}
    </Show>
  );
}
