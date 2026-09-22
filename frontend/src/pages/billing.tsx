import { Show, For, createSignal, createEffect } from 'solid-js';
import { useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api, type Project } from '~/api/client';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { Wallet, Settings } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { SettingsSection } from '~/components/settings/settings-section';
import { ProjectSettings } from '~/components/project-settings';
import { DURATION_OPTIONS, durationLabel, type BudgetConfig } from '~/constants/budget';
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldIncrementTrigger,
  NumberFieldDecrementTrigger,
} from '~/components/ui/number-field';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '~/components/ui/table';
import { toast } from 'solid-sonner';

interface TenantBudget {
  tenantBudget: number | null;
  budgetDuration: string | null;
  currentUsage: number;
}

export function BillingPage() {
  const qc = useQueryClient();
  const { hasPermission } = usePermissions();
  const canManage = () => hasPermission(Permission.manageTenantBudget);
  const canSeeSettings = () =>
    hasPermission(Permission.manageProjectBudgetSettings) || hasPermission(Permission.manageProjectTimeoutSettings);

  const [editing, setEditing] = createSignal(false);
  const [draftBudget, setDraftBudget] = createSignal('');
  const [draftDuration, setDraftDuration] = createSignal('1M');
  const [saving, setSaving] = createSignal(false);
  const [settingsProjectId, setSettingsProjectId] = createSignal<string | null>(null);

  const tenantBudget = createAppQuery(() => ({
    queryKey: ['tenant', 'budget'],
    queryFn: () => api.get<TenantBudget>('/usage/tenant/budget'),
  }));

  const projectList = createAppQuery(() => ({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/projects'),
  }));

  createEffect(() => {
    if (tenantBudget.data) {
      setDraftBudget(tenantBudget.data.tenantBudget != null ? String(tenantBudget.data.tenantBudget) : '');
      setDraftDuration(tenantBudget.data.budgetDuration ?? '1M');
    }
  });

  const spend = () => tenantBudget.data?.currentUsage ?? 0;
  const limit = () => tenantBudget.data?.tenantBudget ?? null;
  const hasBudget = () => {
    const b = limit();
    return b != null && b > 0;
  };
  const pct = () => {
    const b = limit();
    return b && b > 0 ? Math.min((spend() / b) * 100, 100) : 0;
  };

  async function handleSave() {
    setSaving(true);
    try {
      await api.put('/usage/tenant/budget', {
        tenantBudget: parseFloat(draftBudget()) || 0,
        budgetDuration: draftDuration(),
      });
      await qc.invalidateQueries({ queryKey: ['tenant', 'budget'] });
      setEditing(false);
    } catch {
      toast.error('Failed to save budget');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SettingsSection icon={Wallet} title="Billing" description="This organization's spend and budget.">
        <div class="space-y-6">
          <div class="rounded-lg border border-border p-4 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">Budget</span>
              <Show when={canManage() && !editing()}>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </Show>
            </div>

            <Show when={hasBudget()}>
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-xs text-muted-foreground">
                  <span class="tabular-nums">
                    ${spend().toFixed(2)} / ${limit()}
                  </span>
                  <span>{durationLabel(tenantBudget.data?.budgetDuration ?? null)}</span>
                </div>
                <div class="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all"
                    classList={{
                      'bg-primary': pct() < 80,
                      'bg-yellow-500': pct() >= 80 && pct() < 100,
                      'bg-destructive': pct() >= 100,
                    }}
                    style={{ width: `${pct()}%` }}
                  />
                </div>
              </div>
            </Show>

            <Show when={!hasBudget() && !editing()}>
              <p class="text-xs text-muted-foreground">No budget set.</p>
            </Show>

            <Show when={editing()}>
              <div class="flex items-end gap-2">
                <NumberField
                  class="flex-1"
                  minValue={0}
                  step={1}
                  value={draftBudget()}
                  onChange={(v) => setDraftBudget(v)}
                >
                  <label class="text-xs text-muted-foreground mb-1 block">Max budget (USD)</label>
                  <NumberFieldGroup>
                    <NumberFieldInput placeholder="0 = unlimited" />
                    <NumberFieldIncrementTrigger />
                    <NumberFieldDecrementTrigger />
                  </NumberFieldGroup>
                </NumberField>
                <div class="w-28">
                  <label class="text-xs text-muted-foreground mb-1 block">Period</label>
                  <Select
                    options={DURATION_OPTIONS}
                    optionValue="value"
                    optionTextValue="label"
                    value={DURATION_OPTIONS.find((d) => d.value === draftDuration()) ?? null}
                    onChange={(opt) => {
                      if (opt) setDraftDuration(opt.value);
                    }}
                    itemComponent={(itemProps) => (
                      <SelectItem item={itemProps.item}>{itemProps.item.rawValue.label}</SelectItem>
                    )}
                  >
                    <SelectTrigger>
                      <SelectValue<(typeof DURATION_OPTIONS)[0]>>
                        {(state) => <span>{state.selectedOption()?.label ?? 'Select'}</span>}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              </div>
              <div class="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={saving()} onClick={handleSave}>
                  {saving() ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </Show>
          </div>

          <div class="space-y-2">
            <span class="text-sm font-medium">Projects</span>
            <Show
              when={projectList.data && projectList.data.length > 0}
              fallback={
                <div class="rounded-lg border border-dashed border-border p-6 text-center">
                  <p class="text-xs text-muted-foreground">No projects yet.</p>
                </div>
              }
            >
              <div class="rounded-lg border border-border overflow-hidden bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead class="text-right">Usage</TableHead>
                      <TableHead class="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <For each={projectList.data}>
                      {(project) => (
                        <ProjectRow
                          project={project}
                          canSeeSettings={canSeeSettings()}
                          onSettings={() => setSettingsProjectId(project.id)}
                        />
                      )}
                    </For>
                  </TableBody>
                </Table>
              </div>
            </Show>
          </div>
        </div>
      </SettingsSection>

      <Show when={settingsProjectId()}>
        {(id) => (
          <ProjectSettings
            projectId={id()}
            open={true}
            onOpenChange={(open) => {
              if (!open) setSettingsProjectId(null);
            }}
          />
        )}
      </Show>
    </>
  );
}

function ProjectRow(props: { project: Project; canSeeSettings: boolean; onSettings: () => void }) {
  const budget = createAppQuery(() => ({
    queryKey: ['projects', props.project.id, 'budget'],
    queryFn: () => api.get<BudgetConfig & { currentUsage: number }>(`/usage/projects/${props.project.id}/budget`),
  }));

  const name = () => props.project.title ?? `Project ${props.project.id.slice(0, 8)}`;
  const maxBudget = () => budget.data?.maxBudget ?? null;
  const currentUsage = () => budget.data?.currentUsage ?? 0;
  const hasBudget = () => {
    const b = maxBudget();
    return b != null && b > 0;
  };

  return (
    <TableRow>
      <TableCell class="text-xs font-medium">{name()}</TableCell>
      <TableCell class="text-right text-xs tabular-nums text-muted-foreground">
        ${currentUsage().toFixed(2)}
        <Show when={hasBudget()}>
          {' / $'}
          {maxBudget()}
        </Show>
      </TableCell>
      <TableCell class="text-right pr-2">
        <Show when={props.canSeeSettings}>
          <Button
            variant="ghost"
            size="icon"
            class="w-6 h-6 text-muted-foreground hover:text-foreground"
            onClick={props.onSettings}
            aria-label="Project settings"
          >
            <Settings class="w-3.5 h-3.5" />
          </Button>
        </Show>
      </TableCell>
    </TableRow>
  );
}
