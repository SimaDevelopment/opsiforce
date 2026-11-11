import { For, Show, createSignal } from 'solid-js';
import { ROLE_NAME_PATTERN, useCreateAppUserRole, type AppUserRole } from '~/api/app-users';
import { Check, Plus } from '~/components/icons';
import { cn } from '~/lib/cn';

export const roleNameError = (name: string) =>
  ROLE_NAME_PATTERN.test(name)
    ? null
    : 'Use lowercase letters, digits, - or _, like editor or team-lead (up to 40 characters)';

export const toRoleName = (text: string) => text.trim().toLowerCase().replace(/\s+/g, '-');

export function RolePicker(props: {
  projectId: string;
  roles: AppUserRole[];
  value: string[];
  onChange: (roles: string[]) => void;
  disabled?: boolean;
  labelledBy?: string;
}) {
  const create = useCreateAppUserRole(() => props.projectId);
  const [adding, setAdding] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const toggle = (name: string) =>
    props.onChange(props.value.includes(name) ? props.value.filter((r) => r !== name) : [...props.value, name]);

  const addRole = () => {
    const name = toRoleName(draft());
    const invalid = roleNameError(name);
    if (invalid) return setError(invalid);
    create.mutate(
      { name },
      {
        onSuccess: (role) => {
          props.onChange([...props.value, role.name]);
          setDraft('');
          setError(null);
          setAdding(false);
        },
        onError: (e) => setError((e as Error).message),
      }
    );
  };

  return (
    <div class="space-y-2">
      <div role="group" aria-labelledby={props.labelledBy} class="flex flex-wrap gap-1.5">
        <For each={props.roles}>
          {(role) => {
            const selected = () => props.value.includes(role.name);
            return (
              <button
                type="button"
                aria-pressed={selected()}
                title={role.description ?? undefined}
                disabled={props.disabled}
                onClick={() => toggle(role.name)}
                class={cn(
                  'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                  selected()
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                )}
              >
                <Show when={selected()}>
                  <Check class="h-3 w-3" aria-hidden="true" />
                </Show>
                {role.name}
              </button>
            );
          }}
        </For>
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => setAdding(true)}
              class="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              <Plus class="h-3 w-3" aria-hidden="true" />
              New Role
            </button>
          }
        >
          <span class="inline-flex h-7 items-center gap-1 rounded-full border border-border pl-2.5 pr-1">
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              name="new-role"
              aria-label="New role name"
              placeholder="editor"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              value={draft()}
              onInput={(e) => {
                setDraft(e.currentTarget.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addRole();
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setAdding(false);
                }
              }}
              class="w-24 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={addRole}
              disabled={create.isPending}
              class="rounded-full px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Add
            </button>
          </span>
        </Show>
      </div>
      <Show when={error()}>
        <p class="text-xs text-destructive">{error()}</p>
      </Show>
      <Show when={props.roles.length === 0 && !adding()}>
        <p class="text-xs text-muted-foreground">
          No roles yet. Roles reach the App as the X-Oidc-Roles header, so it can give people different access.
        </p>
      </Show>
    </div>
  );
}

export function RoleBadges(props: { roles: string[]; empty?: string }) {
  return (
    <Show
      when={props.roles.length > 0}
      fallback={<span class="text-xs text-muted-foreground">{props.empty ?? 'No roles'}</span>}
    >
      <span class="flex flex-wrap gap-1">
        <For each={props.roles}>
          {(role) => (
            <span
              class="inline-flex h-5 items-center rounded-full border border-border bg-muted/40 px-2 font-mono text-[11px] text-foreground"
              translate="no"
            >
              {role}
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}
