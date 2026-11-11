import { For, Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { useCreateAppUserRole, useDeleteAppUserRole, useUpdateAppUserRole, type AppUserRole } from '~/api/app-users';
import { Pencil, Plus, Tag, Trash2 } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { cn } from '~/lib/cn';
import { INPUT_CLASS } from './fields';
import { roleNameError, toRoleName } from './role-picker';

const SUGGESTED_ROLES = [
  { name: 'admin', description: 'Manages everything in the App' },
  { name: 'editor', description: 'Creates and changes content' },
  { name: 'viewer', description: 'Reads, but can’t change anything' },
];

function RoleForm(props: {
  initial?: AppUserRole;
  saving: boolean;
  onSave: (dto: { name: string; description: string | null }) => void;
  onCancel: () => void;
  error: string | null;
}) {
  const [name, setName] = createSignal(props.initial?.name ?? '');
  const [description, setDescription] = createSignal(props.initial?.description ?? '');
  const [attempted, setAttempted] = createSignal(false);
  const nameError = () => (attempted() ? roleNameError(toRoleName(name())) : null);

  const cancelOnEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    props.onCancel();
  };

  return (
    <form
      class="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-start"
      novalidate
      onSubmit={(e) => {
        e.preventDefault();
        setAttempted(true);
        if (roleNameError(toRoleName(name()))) return;
        props.onSave({ name: toRoleName(name()), description: description().trim() || null });
      }}
    >
      <div class="space-y-1.5">
        <input
          ref={(el) => queueMicrotask(() => el.focus())}
          name="role-name"
          onKeyDown={cancelOnEscape}
          aria-label="Role name"
          placeholder="editor"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          aria-invalid={nameError() || props.error ? true : undefined}
          class={cn(INPUT_CLASS, 'font-mono')}
        />
        <Show when={nameError() ?? props.error}>
          {(message) => <p class="text-xs text-destructive">{message()}</p>}
        </Show>
      </div>
      <input
        name="role-description"
        onKeyDown={cancelOnEscape}
        aria-label="Description"
        placeholder="What this role may do (optional)"
        autocomplete="off"
        value={description()}
        onInput={(e) => setDescription(e.currentTarget.value)}
        class={INPUT_CLASS}
      />
      <div class="flex gap-2">
        <Button type="button" variant="ghost" size="sm" class="h-9" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" class="h-9" loading={props.saving}>
          {props.initial ? 'Save Role' : 'Add Role'}
        </Button>
      </div>
    </form>
  );
}

export function RolesView(props: { projectId: string; roles: AppUserRole[] }) {
  const projectId = () => props.projectId;
  const create = useCreateAppUserRole(projectId);
  const update = useUpdateAppUserRole(projectId);
  const remove = useDeleteAppUserRole(projectId);
  const [adding, setAdding] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<AppUserRole | null>(null);
  const [deleteOpen, setDeleteOpen] = createSignal(false);

  const missingSuggestions = () => SUGGESTED_ROLES.filter((s) => !props.roles.some((r) => r.name === s.name));

  const addRole = (dto: { name: string; description: string | null }) =>
    create.mutate(dto, {
      onSuccess: () => {
        setAdding(false);
        setError(null);
      },
      onError: (e) => setError((e as Error).message),
    });

  const saveRole = (role: AppUserRole, dto: { name: string; description: string | null }) =>
    update.mutate(
      { id: role.id, dto },
      {
        onSuccess: () => {
          setEditingId(null);
          setError(null);
          if (dto.name !== role.name) toast.success(`Renamed ${role.name} to ${dto.name} for everyone who holds it`);
        },
        onError: (e) => setError((e as Error).message),
      }
    );

  return (
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section class="space-y-3" aria-labelledby="roles-heading">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 id="roles-heading" class="text-sm font-semibold text-foreground">
              Roles
            </h2>
            <p class="text-xs text-muted-foreground leading-snug">
              Give each user any number of roles. The App reads them to decide what each person can do.
            </p>
          </div>
          <Show when={!adding()}>
            <Button
              size="sm"
              variant="outline"
              class="shrink-0"
              onClick={() => {
                setEditingId(null);
                setError(null);
                setAdding(true);
              }}
            >
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              New Role
            </Button>
          </Show>
        </div>

        <Show when={adding()}>
          <div class="rounded-xl border border-border bg-card p-3">
            <RoleForm saving={create.isPending} error={error()} onSave={addRole} onCancel={() => setAdding(false)} />
          </div>
        </Show>

        <Show
          when={props.roles.length > 0}
          fallback={
            <Show when={!adding()}>
              <div class="rounded-xl border border-dashed border-border p-4">
                <div class="flex items-center gap-2">
                  <Tag class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <p class="text-sm font-medium">No roles yet</p>
                </div>
                <p class="mt-1 text-xs text-muted-foreground">
                  Without roles every user gets the same access. Start from a common one:
                </p>
                <div class="mt-3 flex flex-wrap gap-2">
                  <For each={missingSuggestions()}>
                    {(suggestion) => (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={create.isPending}
                        onClick={() => create.mutate(suggestion)}
                        title={suggestion.description}
                      >
                        <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                        <span class="font-mono">{suggestion.name}</span>
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          }
        >
          <ul class="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            <For each={props.roles}>
              {(role) => (
                <li class="px-3 py-2.5">
                  <Show
                    when={editingId() === role.id}
                    fallback={
                      <div class="flex items-center gap-3">
                        <div class="min-w-0 flex-1">
                          <p class="font-mono text-sm" translate="no">
                            {role.name}
                          </p>
                          <p class="truncate text-xs text-muted-foreground">{role.description ?? 'No description'}</p>
                        </div>
                        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {role.members === 1 ? '1 user' : `${role.members} users`}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          class="h-8 w-8 shrink-0"
                          aria-label={`Edit role ${role.name}`}
                          onClick={() => {
                            setAdding(false);
                            setError(null);
                            setEditingId(role.id);
                          }}
                        >
                          <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          class="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                          aria-label={`Delete role ${role.name}`}
                          onClick={() => {
                            setDeleting(role);
                            setDeleteOpen(true);
                          }}
                        >
                          <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    }
                  >
                    <RoleForm
                      initial={role}
                      saving={update.isPending}
                      error={error()}
                      onSave={(dto) => saveRole(role, dto)}
                      onCancel={() => setEditingId(null)}
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={missingSuggestions().length > 0 && !adding()}>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Suggested:
              <For each={missingSuggestions()}>
                {(suggestion) => (
                  <button
                    type="button"
                    disabled={create.isPending}
                    onClick={() => create.mutate(suggestion)}
                    title={suggestion.description}
                    class="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2 font-mono text-[11px] transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <Plus class="h-3 w-3" aria-hidden="true" />
                    {suggestion.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>

      <aside
        class="space-y-3 rounded-xl border border-border bg-muted/20 p-4 text-xs"
        aria-labelledby="headers-heading"
      >
        <h2 id="headers-heading" class="text-sm font-semibold text-foreground">
          What the App receives
        </h2>
        <p class="text-muted-foreground leading-snug">
          After someone signs in, every request reaches the App with these headers. Requests can’t fake them: the gate
          replaces any the browser sends.
        </p>
        <dl class="space-y-2 font-mono">
          <div>
            <dt class="text-foreground">X-Oidc-Subject</dt>
            <dd class="text-muted-foreground">The user’s id, which never changes</dd>
          </div>
          <div>
            <dt class="text-foreground">X-Oidc-Email</dt>
            <dd class="text-muted-foreground">grace@example-org.com</dd>
          </div>
          <div>
            <dt class="text-foreground">X-Oidc-Name</dt>
            <dd class="text-muted-foreground">Grace Hopper, or empty</dd>
          </div>
          <div>
            <dt class="text-foreground">X-Oidc-Roles</dt>
            <dd class="text-muted-foreground">["admin","editor"], or []</dd>
          </div>
        </dl>
        <p class="text-muted-foreground leading-snug">
          New sign-ins get role changes right away; people already signed in get them within 5 minutes. Sending someone
          to /oidc/logout signs them out.
        </p>
      </aside>

      <ConfirmDialog
        open={deleteOpen()}
        onOpenChange={setDeleteOpen}
        title={`Delete the ${deleting()?.name ?? ''} role?`}
        description={
          deleting()?.members
            ? `${deleting()?.members === 1 ? '1 user loses' : `${deleting()?.members} users lose`} this role within 5 minutes. Their accounts stay.`
            : 'No one holds this role.'
        }
        confirmLabel="Delete Role"
        variant="destructive"
        onConfirm={() => {
          const role = deleting();
          if (role)
            remove.mutate(role.id, { onError: (e) => toast.error(`Failed to delete: ${(e as Error).message}`) });
        }}
      />
    </div>
  );
}
