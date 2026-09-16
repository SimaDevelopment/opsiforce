import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import { createSignal, For, Show } from 'solid-js';
import { toast } from 'solid-sonner';
import { type Project } from '~/api/client';
import { useCreateDefaultProject } from '~/api/default-project-target';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { EXAMPLES, type Example } from '~/data/examples';
import { ArrowUp, LoaderCircle, Upload } from '~/components/icons';
import { ProjectImportDialog } from '~/components/project/project-import-dialog';
import { cn } from '~/lib/cn';
import { opencodeMessageId } from '~/lib/opencode-id';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function ExampleCard(props: { example: Example; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      class="group flex items-start gap-3 text-left p-3.5 rounded-xl border border-border bg-card hover:bg-accent/40 hover:border-border/70 transition-all duration-150 active:scale-95"
    >
      <div
        class={cn(
          'w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-base leading-none bg-gradient-to-br',
          props.example.gradient
        )}
      >
        {props.example.icon}
      </div>
      <div class="flex flex-col gap-0.5 min-w-0 pt-px">
        <span class="text-xs font-semibold text-foreground leading-tight truncate">{props.example.title}</span>
        <span class="text-xs text-muted-foreground leading-snug line-clamp-2">{props.example.description}</span>
      </div>
    </button>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const createDefaultProject = useCreateDefaultProject();
  const { hasPermission } = usePermissions();
  const canImport = () => hasPermission(Permission.importProject);
  const [prompt, setPrompt] = createSignal('');
  const [focused, setFocused] = createSignal(false);
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
    } catch {
      toast.error('Failed to create project');
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
      <div class="h-full overflow-y-auto">
        <div
          class="flex flex-col items-center px-6 pb-16 min-h-full"
          style={{
            background: 'radial-gradient(ellipse 80% 40% at 50% 0%, hsl(var(--primary)/0.035) 0%, transparent 100%)',
            'padding-top': 'clamp(2.5rem, 8vh, 5rem)',
          }}
        >
          <div class="w-full max-w-2xl flex flex-col gap-10">
            {/* ── Header ── */}
            <div class="flex flex-col items-center gap-5 text-center">
              <div class="relative">
                <div class="w-11 h-11 rounded-2xl bg-foreground/5 border border-foreground/10 flex items-center justify-center shadow-sm">
                  <img alt="Opsiforce" src="/assets/icons/brands/opsiforce.svg" class="w-6 h-6" />
                </div>
              </div>
              <div class="flex flex-col gap-2">
                <h1 class="text-3xl font-semibold tracking-tight text-foreground leading-tight">
                  What do you want to automate?
                </h1>
                <p class="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto">
                  Describe what you need and an AI agent will build it for you.
                </p>
              </div>
            </div>

            <div
              class={cn(
                'rounded-2xl border bg-card overflow-hidden transition-all duration-150',
                focused() ? 'border-foreground/20 ring ring-foreground/10 shadow-sm' : 'border-border shadow-sm'
              )}
            >
              <textarea
                placeholder="e.g. Build a sales dashboard with monthly revenue charts, a top products table, and period-over-period comparison…"
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                rows={4}
                class="w-full px-4 pt-4 pb-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 resize-none outline-none leading-relaxed"
              />
              <div class="flex items-center justify-between px-3.5 py-2.5">
                <span class="text-xs text-muted-foreground/40 select-none tracking-tight">
                  Enter to send · Shift+Enter for new line
                </span>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting() || !createDefaultProject.hasDestination()}
                  class={cn(
                    'flex items-center gap-1.5 h-7 px-3 rounded-lg text-xs font-medium',
                    'bg-foreground text-background',
                    'transition-all duration-150 hover:bg-foreground/80 active:scale-95',
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
                  class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Upload size={13} />
                  <span>Import a project export file</span>
                </button>
              </div>
            </Show>

            <div>
              <div class="flex items-center gap-3 mb-4">
                <span class="text-xs font-semibold text-muted-foreground/50 uppercase tracking-widest">
                  Start from an example
                </span>
                <div class="flex-1 h-px bg-border/60" />
              </div>
              <div class="grid grid-cols-2 gap-2.5">
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
