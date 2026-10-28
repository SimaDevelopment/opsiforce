import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import { createSignal, For, Show } from 'solid-js';
import { toast } from 'solid-sonner';
import { type Project } from '~/api/client';
import { limitRefusalMessage } from '~/api/limits';
import { useCreateDefaultProject } from '~/api/default-project-target';
import { usePermissions } from '~/api/permissions';
import { EXAMPLES, type Example } from '~/data/examples';
import { ArrowUp, LoaderCircle, Upload } from '~/components/icons';
import { ProjectImportDialog } from '~/components/project/project-import-dialog';
import { Lattice } from '~/components/ui/lattice';
import { cn } from '~/lib/cn';
import { opencodeMessageId } from '~/lib/opencode-id';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function ExampleCard(props: { example: Example; onClick: () => void }) {
  return (
    <button onClick={props.onClick} class="of-ex fr">
      {/* the tile carries the brand tint, never a per-item colour: identity
          here comes from type and surface (see the redesign brief) */}
      <span class="tile">
        <props.example.icon class="w-4 h-4" />
      </span>
      <span class="flex flex-col gap-0.5 min-w-0 pt-px">
        <b class="t-ui-med t-strong truncate">{props.example.title}</b>
        <span class="t-meta t-sub line-clamp-2">{props.example.description}</span>
      </span>
    </button>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const createDefaultProject = useCreateDefaultProject();
  const { hasPermission } = usePermissions();
  const canImport = () => hasPermission('can_import_project');
  const [prompt, setPrompt] = createSignal('');
  const [importOpen, setImportOpen] = createSignal(false);

  const goToProject = (project: Project) => {
    const text = prompt().trim();
    navigate({
      to: '/projects/$projectId',
      params: { projectId: project.id },
      search: text ? { prompt: text, promptId: opencodeMessageId() } : { prompt: undefined, promptId: undefined },
    });
  };

  const isSubmitting = () => createDefaultProject.isPending();

  const handleSubmit = async () => {
    if (isSubmitting()) return;
    try {
      const project = await createDefaultProject.createProject();
      toast.success('Project created');
      goToProject(project);
    } catch (err) {
      toast.error(limitRefusalMessage(err, 'Failed to create project'));
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <>
      <div class="h-full overflow-y-auto relative">
        {/* the one brand field: the lattice behind the hero, masked so it
            fades out rather than ending on a line */}
        <div class="of-home-field" aria-hidden="true">
          <Lattice />
        </div>
        <div
          class="relative flex flex-col items-center px-4 sm:px-6 pb-16 min-h-full"
          style={{
            'padding-top': 'clamp(2.5rem, 8vh, 5rem)',
          }}
        >
          <div class="w-full max-w-3xl flex flex-col gap-9">
            {/* ── Header ──
                Left-aligned and set in display type: the composer is the hero
                of this screen, so the heading leads into it instead of a
                centred logo lockup competing with it. */}
            <div class="flex flex-col gap-2">
              <h1 class="t-display" style={{ color: 'var(--ink-strong)' }}>
                What do you want to automate?
              </h1>
              <p class="t-body t-sub max-w-xl">Describe what you need and an AI agent will build it for you.</p>
            </div>

            <div class="of-composer">
              <textarea
                placeholder="e.g. Build a sales dashboard with monthly revenue charts, a top products table, and period-over-period comparison…"
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                rows={4}
              />
              <div class="of-composer-foot">
                <span class="t-meta t-sub select-none flex-1">Enter to send · Shift+Enter for new line</span>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting() || !createDefaultProject.hasDestination()}
                  class={cn(
                    'of-btn of-btn-primary fr',
                    'disabled:opacity-35 disabled:cursor-not-allowed disabled:active:scale-100'
                  )}
                >
                  {isSubmitting() ? (
                    <>
                      <LoaderCircle class="animate-spin" size={13} />
                      <span>Creating…</span>
                    </>
                  ) : (
                    <>
                      <span>Apply</span>
                      <ArrowUp size={14} stroke-width={2.5} />
                    </>
                  )}
                </button>
              </div>
            </div>

            <Show when={canImport()}>
              <div class="-mt-6 flex justify-center">
                <button
                  onClick={() => setImportOpen(true)}
                  class="of-chip of-chip-btn fr"
                >
                  <Upload size={13} />
                  <span>Import a project export file</span>
                </button>
              </div>
            </Show>

            <div>
              <div class="of-sec-label mb-3">
                <span>Start from an example</span>
                <span class="line" />
              </div>
              <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <For each={EXAMPLES}>
                  {(ex) => (
                    <ExampleCard
                      example={ex}
                      onClick={() => {
                        setPrompt(ex.prompt);
                        handleSubmit();
                      }}
                    />
                  )}
                </For>
              </div>
            </div>
          </div>
        </div>
      </div>
      <ProjectImportDialog open={importOpen()} onOpenChange={setImportOpen} />
    </>
  );
}
