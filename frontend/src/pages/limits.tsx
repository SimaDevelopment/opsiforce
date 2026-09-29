import { For, Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  useFollowPlatformLimit,
  usePlatformLimits,
  useSetPlatformLimit,
  useSetTenantLimit,
  type LimitKey,
  type PlatformLimitsView,
  type TenantLimit,
  type TenantLimits,
} from '~/api/limits';
import { AlertTriangle, Building2, Gauge, Globe, Pencil, RefreshCw } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import {
  NumberField,
  NumberFieldDecrementTrigger,
  NumberFieldGroup,
  NumberFieldIncrementTrigger,
  NumberFieldInput,
} from '~/components/ui/number-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Skeleton } from '~/components/ui/skeleton';
import { SettingsSection } from '~/components/settings/settings-section';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

const LIMIT_LABELS: Record<LimitKey, string> = {
  projects: 'Projects',
};

type Mode = 'platform' | 'none' | 'custom';

const MODES: { value: Mode; label: string }[] = [
  { value: 'platform', label: 'Platform value' },
  { value: 'none', label: 'No limit' },
  { value: 'custom', label: 'Custom' },
];

function formatLimit(value: number | null): string {
  return value === null ? 'No limit' : String(value);
}

function draftOf(value: number | null): string {
  return value === null ? '' : String(value);
}

function parseLimit(draft: string): number | null | undefined {
  const trimmed = draft.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function LimitInput(props: { value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <NumberField class="w-32" minValue={0} step={1} value={props.value} onChange={props.onChange}>
      <NumberFieldGroup>
        <NumberFieldInput placeholder={props.placeholder} />
        <NumberFieldIncrementTrigger />
        <NumberFieldDecrementTrigger />
      </NumberFieldGroup>
    </NumberField>
  );
}

export function LimitsPage() {
  const view = usePlatformLimits();

  return (
    <SettingsSection
      icon={Gauge}
      title="Limits"
      description="Caps on how much an organization can create. Every organization uses the platform value unless it has its own."
      width="wide"
    >
      <Show when={view.isPending}>
        <LoadingState />
      </Show>

      <Show when={!view.isPending && view.isError}>
        <ErrorState onRetry={() => view.refetch()} />
      </Show>

      <Show when={view.data}>
        {(data) => (
          <div class="space-y-4">
            <PlatformCard view={data()} />
            <TenantsTable view={data()} />
          </div>
        )}
      </Show>
    </SettingsSection>
  );
}

function PlatformCard(props: { view: PlatformLimitsView }) {
  const setPlatformLimit = useSetPlatformLimit();
  const initialDrafts = () =>
    Object.fromEntries(props.view.platform.map((limit) => [limit.key, draftOf(limit.value)])) as Record<
      LimitKey,
      string
    >;
  const [drafts, setDrafts] = createSignal(initialDrafts());
  const changed = () => props.view.platform.filter((limit) => drafts()[limit.key] !== draftOf(limit.value));

  const save = async () => {
    const updates = changed().map((limit) => ({ key: limit.key, value: parseLimit(drafts()[limit.key]) }));
    if (updates.some((update) => update.value === undefined)) {
      toast.error('A limit must be a whole number, or empty for no limit');
      return;
    }
    try {
      for (const update of updates) {
        await setPlatformLimit.mutateAsync({ key: update.key, value: update.value ?? null });
      }
      toast.success('Platform limits updated');
    } catch {
      toast.error('Failed to update the platform limits');
    }
  };

  return (
    <div class="rounded-lg border border-border p-4 space-y-3">
      <div class="flex items-center gap-2">
        <Globe class="w-4 h-4 text-muted-foreground" />
        <span class="text-sm font-medium">Platform</span>
      </div>
      <p class="text-xs text-muted-foreground">
        Applies to every organization without its own value, including ones created later. Leave empty for no limit.
      </p>
      <For each={props.view.platform}>
        {(limit) => (
          <div class="rounded-lg border border-border p-3 flex items-center justify-between gap-4">
            <span class="text-xs font-medium text-foreground">{LIMIT_LABELS[limit.key]}</span>
            <LimitInput
              value={drafts()[limit.key]}
              placeholder="No limit"
              onChange={(value) => setDrafts({ ...drafts(), [limit.key]: value })}
            />
          </div>
        )}
      </For>
      <div class="flex justify-end pt-1">
        <Button size="sm" disabled={changed().length === 0 || setPlatformLimit.isPending} onClick={save}>
          {setPlatformLimit.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function TenantsTable(props: { view: PlatformLimitsView }) {
  const [editing, setEditing] = createSignal<TenantLimits | null>(null);
  const platformValue = (key: LimitKey) => props.view.platform.find((limit) => limit.key === key)?.value ?? null;

  return (
    <>
      <div class="rounded-lg border border-border overflow-hidden bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="min-w-56">Organization</TableHead>
              <For each={props.view.platform}>
                {(limit) => <TableHead class="w-40">{LIMIT_LABELS[limit.key]}</TableHead>}
              </For>
              <TableHead class="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <For each={props.view.tenants}>
              {(tenant) => (
                <TableRow>
                  <TableCell>
                    <div class="flex items-center gap-2">
                      <Building2 class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span class="text-sm font-medium truncate">{tenant.displayName}</span>
                    </div>
                  </TableCell>
                  <For each={tenant.limits}>{(limit) => <UsageCell limit={limit} />}</For>
                  <TableCell class="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      class="h-7 w-7"
                      aria-label={`Edit limits of ${tenant.displayName}`}
                      onClick={() => setEditing(tenant)}
                    >
                      <Pencil class="w-3.5 h-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              )}
            </For>
          </TableBody>
        </Table>
      </div>

      <Show when={editing()}>
        {(tenant) => (
          <TenantLimitsDialog tenant={tenant()} platformValue={platformValue} onClose={() => setEditing(null)} />
        )}
      </Show>
    </>
  );
}

function UsageCell(props: { limit: TenantLimit }) {
  const reached = () => props.limit.limit !== null && props.limit.used >= props.limit.limit;

  return (
    <TableCell>
      <span class="text-sm tabular-nums" classList={{ 'text-amber-600 dark:text-amber-500': reached() }}>
        {props.limit.used} / {formatLimit(props.limit.limit)}
      </span>
    </TableCell>
  );
}

interface Draft {
  mode: Mode;
  value: string;
}

function draftForLimit(limit: TenantLimit): Draft {
  if (!limit.overridden) return { mode: 'platform', value: '' };
  if (limit.limit === null) return { mode: 'none', value: '' };
  return { mode: 'custom', value: String(limit.limit) };
}

function TenantLimitsDialog(props: {
  tenant: TenantLimits;
  platformValue: (key: LimitKey) => number | null;
  onClose: () => void;
}) {
  const setTenantLimit = useSetTenantLimit();
  const followPlatformLimit = useFollowPlatformLimit();
  const [drafts, setDrafts] = createSignal(
    Object.fromEntries(props.tenant.limits.map((limit) => [limit.key, draftForLimit(limit)])) as Record<LimitKey, Draft>
  );
  const pending = () => setTenantLimit.isPending || followPlatformLimit.isPending;
  const updateDraft = (key: LimitKey, patch: Partial<Draft>) =>
    setDrafts({ ...drafts(), [key]: { ...drafts()[key], ...patch } });

  const save = async () => {
    const invalid = props.tenant.limits.some((limit) => {
      const draft = drafts()[limit.key];
      return draft.mode === 'custom' && typeof parseLimit(draft.value) !== 'number';
    });
    if (invalid) {
      toast.error('A custom limit must be a whole number');
      return;
    }
    try {
      for (const limit of props.tenant.limits) {
        const draft = drafts()[limit.key];
        const initial = draftForLimit(limit);
        if (draft.mode === initial.mode && draft.value === initial.value) continue;
        const target = { tenantId: props.tenant.tenantId, key: limit.key };
        if (draft.mode === 'platform') await followPlatformLimit.mutateAsync(target);
        else await setTenantLimit.mutateAsync({ ...target, value: draft.mode === 'none' ? null : Number(draft.value) });
      }
      toast.success(`Limits updated for ${props.tenant.displayName}`);
      props.onClose();
    } catch {
      toast.error('Failed to update the limits');
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
        <DialogTitle>Limits for {props.tenant.displayName}</DialogTitle>
        <DialogDescription>Use the platform value, remove the limit, or set this organization's own.</DialogDescription>

        <div class="mt-4 space-y-3">
          <For each={props.tenant.limits}>
            {(limit) => (
              <div class="rounded-lg border border-border p-3 space-y-2.5">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="text-xs font-medium text-foreground">{LIMIT_LABELS[limit.key]}</span>
                  <span class="text-xs text-muted-foreground tabular-nums">{limit.used} in use</span>
                </div>
                <div class="flex items-center gap-2">
                  <div class="w-44">
                    <Select
                      options={MODES}
                      optionValue="value"
                      optionTextValue="label"
                      value={MODES.find((mode) => mode.value === drafts()[limit.key].mode) ?? null}
                      onChange={(option) => {
                        if (option) updateDraft(limit.key, { mode: option.value });
                      }}
                      itemComponent={(itemProps) => (
                        <SelectItem item={itemProps.item}>{itemProps.item.rawValue.label}</SelectItem>
                      )}
                    >
                      <SelectTrigger>
                        <SelectValue<(typeof MODES)[0]>>
                          {(state) => <span>{state.selectedOption()?.label}</span>}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent />
                    </Select>
                  </div>
                  <Show when={drafts()[limit.key].mode === 'custom'}>
                    <LimitInput
                      value={drafts()[limit.key].value}
                      placeholder="0"
                      onChange={(value) => updateDraft(limit.key, { value })}
                    />
                  </Show>
                  <Show when={drafts()[limit.key].mode === 'platform'}>
                    <span class="text-xs text-muted-foreground">({formatLimit(props.platformValue(limit.key))})</span>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending()} onClick={save}>
            {pending() ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoadingState() {
  return (
    <div class="rounded-lg border border-border overflow-hidden bg-card divide-y divide-border">
      <For each={[0, 1, 2, 3]}>
        {() => (
          <div class="flex items-center gap-4 px-4 py-3.5">
            <Skeleton class="h-4 w-48" />
            <Skeleton class="h-4 w-20 ml-auto" />
          </div>
        )}
      </For>
    </div>
  );
}

function ErrorState(props: { onRetry: () => void }) {
  return (
    <div class="rounded-lg border border-dashed border-border text-center py-16 text-muted-foreground">
      <AlertTriangle class="w-10 h-10 mx-auto mb-3 text-amber-500 opacity-70" />
      <p class="text-sm font-medium text-foreground">Couldn't load the limits</p>
      <Button variant="outline" size="sm" class="mt-4" onClick={() => props.onRetry()}>
        <RefreshCw class="w-3.5 h-3.5" />
        Try again
      </Button>
    </div>
  );
}
