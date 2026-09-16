import { For, Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { ENVIRONMENT_SLUG_MAX_LENGTH, ENVIRONMENT_SLUG_PATTERN, slugifyEnvironmentName } from '~/lib/app-url';
import { deriveEnvironmentShortName, isEnvironmentShortNameValid } from '~/lib/environment-label';
import { BadgeLabelInput } from './badge-label-input';
import { useCreateEnvironment, useDeleteEnvironment, useEnvironments, type Environment } from '~/api/environments';
import { Button } from '~/components/ui/button';
import { ColorPicker } from '~/components/ui/color-picker';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { Skeleton } from '~/components/ui/skeleton';
import { Plus } from '~/components/icons';
import { EnvironmentRow } from './environment-row';

const DEFAULT_CREATE_COLOR = '#F97316';

export function TenantEnvironmentsSection(props: { active: boolean }) {
  const environments = useEnvironments({ enabled: () => props.active });
  const create = useCreateEnvironment();
  const remove = useDeleteEnvironment();

  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal('');
  const [slug, setSlug] = createSignal('');
  const [slugEdited, setSlugEdited] = createSignal(false);
  const [shortName, setShortName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [color, setColor] = createSignal(DEFAULT_CREATE_COLOR);
  const [colorEdited, setColorEdited] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<Environment | null>(null);

  const resetForm = () => {
    setName('');
    setSlug('');
    setSlugEdited(false);
    setShortName('');
    setDescription('');
    setColor(DEFAULT_CREATE_COLOR);
    setColorEdited(false);
    setCreating(false);
  };

  const onNameInput = (value: string) => {
    setName(value);
    if (!slugEdited()) setSlug(slugifyEnvironmentName(value));
  };

  const slugValid = () => ENVIRONMENT_SLUG_PATTERN.test(slug());
  const slugTaken = () => environments.data?.some((env) => env.slug === slug()) === true;
  const slugError = () => {
    if (!slug()) return 'A URL slug is required';
    if (!slugValid()) return 'Lowercase letters, digits, and dashes only; no leading or trailing dash';
    if (slugTaken()) return `'${slug()}' is already used by another environment`;
    return null;
  };
  const canSubmit = () => name().trim().length > 0 && slugError() === null && isEnvironmentShortNameValid(shortName());

  const submitCreate = async () => {
    if (!canSubmit()) return;
    try {
      await create.mutateAsync({
        name: name().trim(),
        slug: slug(),
        shortName: shortName().trim() || undefined,
        description: description().trim() || undefined,
        color: colorEdited() ? color() : undefined,
      });
      toast.success('Environment created');
      resetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create environment');
    }
  };

  const confirmDelete = () => {
    const env = pendingDelete();
    if (!env) return;
    remove.mutate(env.id, {
      onSuccess: () => toast.success(`${env.name} deleted`),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete environment'),
    });
  };

  return (
    <>
      <div class="space-y-2">
        <Show
          when={!environments.isPending}
          fallback={
            <div class="space-y-2">
              <Skeleton class="h-12 w-full" />
              <Skeleton class="h-12 w-full" />
            </div>
          }
        >
          <For each={environments.data}>
            {(env) => <EnvironmentRow environment={env} onRequestDelete={setPendingDelete} />}
          </For>
        </Show>

        <Show
          when={creating()}
          fallback={
            <Button size="sm" variant="outline" class="w-full" onClick={() => setCreating(true)}>
              <Plus class="h-3.5 w-3.5" />
              Add environment
            </Button>
          }
        >
          <div class="space-y-2 rounded-md border border-dashed border-border p-2.5">
            <input
              type="text"
              value={name()}
              onInput={(e) => onNameInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit()) submitCreate();
              }}
              class="h-8 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="e.g. Staging"
              autofocus
            />
            <div class="space-y-1">
              <input
                type="text"
                value={slug()}
                maxLength={ENVIRONMENT_SLUG_MAX_LENGTH}
                onInput={(e) => {
                  setSlugEdited(true);
                  setSlug(e.currentTarget.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit()) submitCreate();
                }}
                class="h-8 w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs shadow-sm transition-colors placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="URL slug, e.g. staging"
              />
              <Show
                when={slug() && slugError() === null}
                fallback={
                  <Show when={slug()}>
                    <p class="text-xs text-destructive">{slugError()}</p>
                  </Show>
                }
              >
                <p class="break-all text-xs text-muted-foreground">
                  App URLs will look like{' '}
                  <span class="font-mono">
                    {'<app-id>'}-{slug()}.{import.meta.env.VITE_WEBAPP_DOMAIN}
                  </span>
                </p>
              </Show>
              <p class="text-xs text-muted-foreground">
                The slug becomes part of every app URL in this environment and cannot be changed later.
              </p>
            </div>
            <BadgeLabelInput
              value={shortName()}
              onInput={setShortName}
              onEnter={submitCreate}
              placeholder="Badge label (optional)"
              hint={
                <p class="text-xs text-muted-foreground">
                  Shown on project cards
                  <Show when={!shortName().trim() && slug()}>
                    {' '}
                    — defaults to <span class="font-mono">{deriveEnvironmentShortName(slug())}</span>
                  </Show>
                  .
                </p>
              }
            />
            <input
              type="text"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              class="h-8 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Description (optional)"
            />
            <div class="space-y-1">
              <span class="text-xs text-muted-foreground">Color</span>
              <ColorPicker
                value={color()}
                onChange={(hex) => {
                  setColorEdited(true);
                  setColor(hex);
                }}
              />
              <Show when={!colorEdited()}>
                <p class="text-xs text-muted-foreground">
                  A distinct color is assigned automatically; adjust it here if you like.
                </p>
              </Show>
            </div>
            <div class="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={resetForm}>
                Cancel
              </Button>
              <Button size="sm" onClick={submitCreate} loading={create.isPending} disabled={!canSubmit()}>
                Create
              </Button>
            </div>
          </div>
        </Show>
      </div>

      <ConfirmDialog
        open={pendingDelete() !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete environment"
        description={`This deletes the ${pendingDelete()?.name ?? ''} environment from the organization. Projects can no longer publish to it. This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </>
  );
}
