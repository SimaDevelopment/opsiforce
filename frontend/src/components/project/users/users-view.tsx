import { For, Show, createMemo, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  displayStatus,
  useDeleteAppUser,
  useUpdateAppUser,
  type AppUser,
  type AppUsersOverview,
} from '~/api/app-users';
import {
  Ban,
  CircleCheck,
  EllipsisVertical,
  LayoutGrid,
  Lock,
  Mail,
  Pencil,
  Tag,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from '~/components/icons';
import { FilterChips, ListToolbar, SearchInput } from '~/components/store/store-list';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { EmptyState } from '~/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cn } from '~/lib/cn';
import { formatAgo } from '~/lib/format-duration';
import { elapsedSince, useNow } from '~/lib/use-now';
import { EditUserDialog } from './edit-user-dialog';
import { RoleBadges } from './role-picker';
import { STATUS_LABELS, StatusBadge, type DisplayStatus } from './status-badge';

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const STATUS_FILTERS: (DisplayStatus | 'all')[] = ['all', 'active', 'invited', 'locked', 'disabled'];
const STATUS_ICONS = { all: LayoutGrid, active: CircleCheck, invited: Mail, locked: Lock, disabled: Ban } as const;
const ALL_ROLES = '__all__';

function RoleSelect(props: { roles: { name: string }[]; value: string; onChange: (value: string) => void }) {
  const options = () => [
    { id: ALL_ROLES, label: 'All roles' },
    ...props.roles.map((r) => ({ id: r.name, label: r.name })),
  ];
  const selected = () => options().find((option) => option.id === (props.value || ALL_ROLES)) ?? options()[0];
  return (
    <Select<{ id: string; label: string }>
      options={options()}
      optionValue="id"
      optionTextValue="label"
      value={selected()}
      onChange={(option) => option && props.onChange(option.id === ALL_ROLES ? '' : option.id)}
      itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue.label}</SelectItem>}
    >
      <SelectTrigger
        aria-label="Filter by role"
        class="h-9 w-auto shrink-0 gap-2 px-3 text-sm shadow-sm hover:bg-accent/40"
      >
        <Tag class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <SelectValue<{ id: string; label: string }> class="text-sm">
          {(state) => state.selectedOption()?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}
const CHECKBOX_CLASS = 'h-4 w-4 cursor-pointer rounded border-border accent-[var(--primary)]';

function initials(user: AppUser): string {
  const source = user.name?.trim() || user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function matches(user: AppUser, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || user.email.includes(q) || (user.name ?? '').toLowerCase().includes(q);
}

const CLOCK_MS = 30_000;

function LastSignIn(props: { user: AppUser; now: number }) {
  return (
    <Show
      when={displayStatus(props.user, props.now) === 'locked' && props.user.lockedUntil}
      fallback={
        <Show when={props.user.lastSignInAt} fallback={<span class="text-muted-foreground">Never</span>}>
          {(at) => (
            <time datetime={at()} title={DATE_TIME.format(new Date(at()))}>
              {formatAgo(elapsedSince(props.now, new Date(at()).getTime()))}
            </time>
          )}
        </Show>
      }
    >
      {(until) => <span class="of-ink of-tone-needs-you">Unlocks at {TIME.format(new Date(until()))}</span>}
    </Show>
  );
}

export function UsersView(props: {
  projectId: string;
  overview: AppUsersOverview;
  linkEnvironmentId?: string;
  appUrl?: string;
  onInvite: () => void;
}) {
  const projectId = () => props.projectId;
  const update = useUpdateAppUser(projectId);
  const remove = useDeleteAppUser(projectId);
  const [search, setSearch] = createSignal('');
  const [roleFilter, setRoleFilter] = createSignal('');
  const [statusFilter, setStatusFilter] = createSignal<DisplayStatus | 'all'>('all');
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [deleting, setDeleting] = createSignal<AppUser[]>([]);
  const [deleteOpen, setDeleteOpen] = createSignal(false);

  const now = useNow(CLOCK_MS);
  const users = () => props.overview.users;
  const shown = createMemo(() =>
    users().filter(
      (user) =>
        matches(user, search()) &&
        (!roleFilter() || user.roles.includes(roleFilter())) &&
        (statusFilter() === 'all' || displayStatus(user, now()) === statusFilter())
    )
  );
  const filtering = () => !!search().trim() || !!roleFilter() || statusFilter() !== 'all';
  const editing = () => users().find((user) => user.id === editingId()) ?? null;
  const selectedUsers = () => shown().filter((user) => selected().has(user.id));
  const allShownSelected = () => shown().length > 0 && shown().every((user) => selected().has(user.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allShownSelected() ? new Set<string>() : new Set(shown().map((u) => u.id)));

  const openEditor = (user: AppUser) => {
    setEditingId(user.id);
    setEditorOpen(true);
  };

  const setDisabled = async (targets: AppUser[], disabled: boolean) => {
    const changing = targets.filter((user) => (user.status === 'disabled') !== disabled);
    try {
      await Promise.all(changing.map((user) => update.mutateAsync({ id: user.id, dto: { disabled } })));
      const who = changing.length === 1 ? changing[0].email : `${changing.length} users`;
      toast.success(disabled ? `Disabled ${who}. They’re signed out within 5 minutes.` : `Enabled ${who}`);
      setSelected(new Set<string>());
    } catch (e) {
      toast.error(`Failed to ${disabled ? 'disable' : 'enable'}: ${(e as Error).message}`);
    }
  };

  const askDelete = (targets: AppUser[]) => {
    setDeleting(targets);
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    const targets = deleting();
    try {
      await Promise.all(targets.map((user) => remove.mutateAsync(user.id)));
      toast.success(targets.length === 1 ? `Deleted ${targets[0].email}` : `Deleted ${targets.length} users`);
      setSelected(new Set<string>());
    } catch (e) {
      toast.error(`Failed to delete: ${(e as Error).message}`);
    }
  };

  const deleteDescription = () => {
    const targets = deleting();
    const who = targets.length === 1 ? targets[0].email : `These ${targets.length} users`;
    return `${who} ${targets.length === 1 ? 'is' : 'are'} signed out within 5 minutes and can’t sign in with ${targets.length === 1 ? 'this account' : 'these accounts'} again. To block someone for now, disable them instead.`;
  };

  return (
    <div class="space-y-3">
      <Show
        when={users().length > 0}
        fallback={
          <EmptyState
            icon={Users}
            title="No users yet"
            description="Invite the people who should sign in to this App. They choose their own password from the link you send."
            action={
              <Button size="sm" onClick={props.onInvite}>
                <UserPlus class="h-3.5 w-3.5" aria-hidden="true" />
                Invite User
              </Button>
            }
          />
        }
      >
        <ListToolbar
          search={<SearchInput value={search()} onInput={setSearch} label="Search by name or email" />}
          sort={<RoleSelect roles={props.overview.roles} value={roleFilter()} onChange={setRoleFilter} />}
          filters={
            <FilterChips
              label="Status"
              value={statusFilter()}
              onChange={setStatusFilter}
              options={STATUS_FILTERS.map((status) => ({
                id: status,
                label: status === 'all' ? 'All' : STATUS_LABELS[status],
                icon: STATUS_ICONS[status],
                count: status === 'all' ? users().length : users().filter((u) => displayStatus(u, now()) === status).length,
              }))}
            />
          }
        />

        <Show
          when={shown().length > 0}
          fallback={
            <div class="rounded-xl border border-dashed border-border px-4 py-8 text-center">
              <p class="text-sm text-muted-foreground">No users match these filters.</p>
              <Button
                size="sm"
                variant="link"
                onClick={() => {
                  setSearch('');
                  setRoleFilter('');
                  setStatusFilter('all');
                }}
              >
                Clear Filters
              </Button>
            </div>
          }
        >
          <div class="overflow-hidden rounded-xl border border-border bg-card">
            <div
              role="region"
              aria-label="Bulk actions"
              class={cn(
                'flex h-11 items-center gap-1 border-b border-border px-4',
                selectedUsers().length > 0 && 'bg-primary/5'
              )}
            >
              <span class="mr-auto text-xs font-medium tabular-nums text-muted-foreground">
                {selectedUsers().length > 0
                  ? `${selectedUsers().length} selected`
                  : filtering()
                    ? `Showing ${shown().length} of ${users().length} users`
                    : `${users().length} ${users().length === 1 ? 'user' : 'users'}`}
              </span>
              <Show when={selectedUsers().length > 0}>
                <Button size="sm" variant="ghost" class="h-7" onClick={() => void setDisabled(selectedUsers(), false)}>
                  <UserCheck class="h-3.5 w-3.5" aria-hidden="true" />
                  Enable
                </Button>
                <Button size="sm" variant="ghost" class="h-7" onClick={() => void setDisabled(selectedUsers(), true)}>
                  <Ban class="h-3.5 w-3.5" aria-hidden="true" />
                  Disable
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  class="h-7 text-destructive hover:text-destructive"
                  onClick={() => askDelete(selectedUsers())}
                >
                  <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                  Delete
                </Button>
              </Show>
            </div>
            <Table layout="responsive">
              <TableHeader>
                <TableRow>
                  <TableHead class="w-10 pl-4">
                    <input
                      type="checkbox"
                      aria-label={allShownSelected() ? 'Deselect all users' : 'Select all users'}
                      checked={allShownSelected()}
                      onChange={toggleAll}
                      class={CHECKBOX_CLASS}
                    />
                  </TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead class="w-12 pr-4">
                    <span class="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For each={shown()}>
                  {(user) => (
                    <TableRow
                      class={cn('cursor-pointer', selected().has(user.id) && 'bg-primary/5')}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button, input, a, [role="menuitem"]')) return;
                        openEditor(user);
                      }}
                    >
                      <TableCell class="pl-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${user.email}`}
                          checked={selected().has(user.id)}
                          onChange={() => toggle(user.id)}
                          class={CHECKBOX_CLASS}
                        />
                      </TableCell>
                      <TableCell>
                        <div class="flex min-w-0 items-center gap-3">
                          <span
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
                            aria-hidden="true"
                          >
                            {initials(user)}
                          </span>
                          <div class="min-w-0">
                            <button
                              type="button"
                              class="block max-w-full truncate text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
                              onClick={() => openEditor(user)}
                              translate="no"
                            >
                              {user.name ?? user.email}
                            </button>
                            <Show when={user.name}>
                              <p class="truncate text-xs text-muted-foreground" translate="no">
                                {user.email}
                              </p>
                            </Show>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell label="Roles">
                        <RoleBadges roles={user.roles} />
                      </TableCell>
                      <TableCell label="Status">
                        <StatusBadge status={displayStatus(user, now())} />
                      </TableCell>
                      <TableCell label="Last sign-in" class="whitespace-nowrap text-xs">
                        <LastSignIn user={user} now={now()} />
                      </TableCell>
                      <TableCell class="pr-2 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            class="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            aria-label={`Actions for ${user.email}`}
                          >
                            <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent class="min-w-44">
                            <DropdownMenuItem onSelect={() => openEditor(user)}>
                              <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={update.isPending}
                              onSelect={() => void setDisabled([user], user.status !== 'disabled')}
                            >
                              <Show
                                when={user.status === 'disabled'}
                                fallback={<Ban class="h-3.5 w-3.5" aria-hidden="true" />}
                              >
                                <UserCheck class="h-3.5 w-3.5" aria-hidden="true" />
                              </Show>
                              {user.status === 'disabled' ? 'Enable' : 'Disable'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              class="text-destructive data-[highlighted]:text-destructive"
                              onSelect={() => askDelete([user])}
                            >
                              <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )}
                </For>
              </TableBody>
            </Table>
          </div>
        </Show>
      </Show>

      <EditUserDialog
        projectId={props.projectId}
        user={editing()}
        roles={props.overview.roles}
        linkEnvironmentId={props.linkEnvironmentId}
        appUrl={props.appUrl}
        canEmail={props.overview.email}
        now={now()}
        open={editorOpen()}
        onOpenChange={setEditorOpen}
      />

      <ConfirmDialog
        open={deleteOpen()}
        onOpenChange={setDeleteOpen}
        title={deleting().length === 1 ? 'Delete User?' : `Delete ${deleting().length} Users?`}
        description={deleteDescription()}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
