import { For, Show, createEffect, createSignal, untrack } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { useQueryClient } from '@tanstack/solid-query';
import { toast } from 'solid-sonner';
import { ApiError, type ProjectStatus } from '~/api/client';
import { useProjectStatus, useRenameProject } from '~/api/projects';
import {
  builderKeys,
  CHAT_KIND_LABEL,
  useArchiveBuilderChat,
  useBuilderChat,
  useDeleteBuilderChat,
  useDeleteTestProject,
  useRestoreBuilderChat,
  useSetBuilderChatVisibility,
  type BuilderChat,
  type ChatVisibility,
} from '~/api/builder';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ChevronLeft,
  EllipsisVertical,
  Globe,
  Lock,
  MessageSquare,
  Trash2,
} from '~/components/icons';
import { ProjectChatTab } from '~/components/project/project-chat-tab';
import { ProjectView } from '~/pages/project';
import { ProjectDisabled } from '~/components/project/project-disabled';
import { ProjectFailed } from '~/components/project/project-failed';
import { useOpenCodeConnection, type InitialPrompt } from '~/components/project/use-opencode-connection';
import { builderChatTitle, KindIcon, ProducedChip } from '~/components/store/builder-chat-list';
import { cn } from '~/lib/cn';
import { FOCUS_RING } from '~/components/store/store-list';

const COMPOSER_NOTE =
  'This chat can write and test a skill or agent, and run it in a test project. Publishing a skill or agent to another environment, making one public, archiving and deleting stay in the Store.';

type ChatPaneView = 'chat' | 'test';

export function BuilderChatPage(props: {
  chatId: string;
  initialPrompt: () => InitialPrompt | undefined;
  onInitialPromptAdmitted: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const chatId = () => props.chatId;
  const chat = useBuilderChat(chatId);
  const statusQuery = useProjectStatus(chatId, {
    onEvent: () => qc.invalidateQueries({ queryKey: builderKeys.detail(chatId()) }),
  });
  const status = () => statusQuery.data?.status;

  const [view, setView] = createSignal<ChatPaneView>('chat');
  const [openedTestProjectId, setOpenedTestProjectId] = createSignal<string | null>(null);
  const testProject = () => chat.data?.testProject;

  const showTestProject = () => {
    const id = testProject()?.id;
    if (!id) return;
    setOpenedTestProjectId(id);
    setView('test');
  };

  createEffect(() => {
    const id = testProject()?.id ?? null;
    untrack(() => {
      if (!id) {
        setOpenedTestProjectId(null);
        setView('chat');
        return;
      }
      if (openedTestProjectId() && openedTestProjectId() !== id) setOpenedTestProjectId(id);
    });
  });

  const connection = useOpenCodeConnection({
    projectId: props.chatId,
    environmentId: chatId,
    status,
    currentTitle: () => statusQuery.data?.title,
    initialPrompt: () => props.initialPrompt(),
    onInitialPromptAdmitted: () => props.onInitialPromptAdmitted(),
  });

  const notFound = () => chat.error instanceof ApiError && chat.error.status === 404;

  return (
    <div class="flex h-full w-full flex-col overflow-hidden">
      <Show
        when={!notFound()}
        fallback={<ChatNotFound onBack={() => navigate({ to: '/store/builder', search: { filter: 'active' } })} />}
      >
        <Show
          when={chat.data}
          fallback={
            <div class="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          {(data) => (
            <>
              <BuilderChatHeader
                chat={data()}
                title={statusQuery.data?.title ?? data().title}
                view={view()}
                onView={setView}
                onShowTestProject={showTestProject}
              />
              <ProducedRow chat={data()} />

              <div
                class="flex min-h-0 flex-1 flex-col oc-chat-only"
                style={{ display: view() === 'chat' ? 'flex' : 'none' }}
              >
                <Show when={status() !== 'disabled'} fallback={<ProjectDisabled projectId={props.chatId} />}>
                  <Show when={status() !== 'failed'} fallback={<ProjectFailed projectId={props.chatId} />}>
                    <Show
                      when={connection.router()}
                      fallback={
                        <Show when={connection.error()} fallback={<Spinner label="Connecting..." />}>
                          {(message) => (
                            <div class="flex flex-col items-center justify-center gap-3 p-6" role="alert">
                              <p>{message()}</p>
                              <Button onClick={connection.retry}>Retry</Button>
                            </div>
                          )}
                        </Show>
                      }
                    >
                      {(router) => (
                        <ProjectChatTab
                          projectId={props.chatId}
                          environmentId={props.chatId}
                          router={router()}
                          currentTitle={statusQuery.data?.title ?? null}
                          onAgentIdle={() => {}}
                          onPreviewFile={() => {}}
                        />
                      )}
                    </Show>
                  </Show>
                </Show>
              </div>

              {/*
                Mounted once the reader first asks for it and kept mounted after that, hidden the
                way the chat above is: watching a child is a back-and-forth, and rebuilding this
                pane on every switch would reload its preview iframe, reset its scroll and reconnect
                its runtime each time. Keyed on the id so only a superseding create rebuilds it.
              */}
              <Show when={openedTestProjectId()} keyed>
                {(testProjectId) => (
                  <div class="flex min-h-0 flex-1 flex-col" style={{ display: view() === 'test' ? 'flex' : 'none' }}>
                    <ProjectView
                      projectId={testProjectId}
                      initialPrompt={() => undefined}
                      onInitialPromptAdmitted={() => {}}
                      onGone={() => setView('chat')}
                    />
                  </div>
                )}
              </Show>

              <Show when={view() === 'chat'}>
                <p class="shrink-0 border-t border-border bg-background px-3 py-2 text-center text-xs text-muted-foreground">
                  {COMPOSER_NOTE}
                </p>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

/** What this chat has already published, kept in sight while the conversation goes on. */
function ProducedRow(props: { chat: BuilderChat }) {
  return (
    <Show when={props.chat.produced.length > 0}>
      <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-background px-3 py-1.5">
        <span class="text-xs text-muted-foreground">Produced</span>
        <For each={props.chat.produced}>{(artifact) => <ProducedChip artifact={artifact} />}</For>
      </div>
    </Show>
  );
}

function ChatNotFound(props: { onBack: () => void }) {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p class="text-sm text-muted-foreground">This Builder chat does not exist, or it is private to another member.</p>
      <Button size="sm" variant="outline" onClick={props.onBack}>
        Back to the Builder
      </Button>
    </div>
  );
}

function BuilderChatHeader(props: {
  chat: BuilderChat;
  title: string | null;
  view: ChatPaneView;
  onView: (view: ChatPaneView) => void;
  onShowTestProject: () => void;
}) {
  const navigate = useNavigate();
  const back = () => navigate({ to: '/store/builder', search: { filter: 'active' } });

  return (
    <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 py-2">
      <div class="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={back}
          aria-label="Back to the Builder"
          class={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            FOCUS_RING
          )}
        >
          <ChevronLeft class="h-4 w-4" />
        </button>
        <ChatTitleInput chatId={props.chat.id} title={props.title ?? builderChatTitle(props.chat)} />
        <Badge variant="outline" class="shrink-0 gap-1 font-medium">
          <KindIcon kind={props.chat.kind} class="h-3 w-3" />
          {CHAT_KIND_LABEL[props.chat.kind]}
        </Badge>
        <Show
          when={props.chat.visibility === 'public'}
          fallback={
            <Badge
              variant="outline"
              class="shrink-0 gap-1 font-medium text-muted-foreground"
              title="Only you can open it"
            >
              <Lock class="h-3 w-3" aria-hidden="true" />
              Private
            </Badge>
          }
        >
          <Badge variant="secondary" class="shrink-0 gap-1 font-medium" title="Anyone in the organization can open it">
            <Globe class="h-3 w-3" aria-hidden="true" />
            Public
          </Badge>
        </Show>
        <Show when={props.chat.disabled}>
          <Badge variant="outline" class="shrink-0 font-medium text-muted-foreground">
            Archived
          </Badge>
        </Show>
      </div>

      <div class="flex shrink-0 items-center gap-1.5">
        <Show when={props.chat.testProject}>
          {(test) => (
            <TestProjectToggle
              status={test().environmentStatus}
              view={props.view}
              onShowChat={() => props.onView('chat')}
              onShowTestProject={props.onShowTestProject}
            />
          )}
        </Show>
        <BuilderChatMenu chat={props.chat} onBack={back} />
      </div>
    </div>
  );
}

function ChatTitleInput(props: { chatId: string; title: string }) {
  const qc = useQueryClient();
  const rename = useRenameProject();
  const [draft, setDraft] = createSignal<string | null>(null);

  const commit = () => {
    const next = draft()?.trim();
    setDraft(null);
    if (next === undefined || next === '' || next === props.title) return;
    rename.mutate(
      { id: props.chatId, title: next },
      { onSettled: () => qc.invalidateQueries({ queryKey: builderKeys.all }) }
    );
  };

  return (
    <input
      type="text"
      aria-label="Chat title"
      value={draft() ?? props.title}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
      class={cn(
        'min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium outline-none transition-colors hover:border-border',
        FOCUS_RING
      )}
    />
  );
}

function TestProjectToggle(props: {
  status: ProjectStatus;
  view: ChatPaneView;
  onShowChat: () => void;
  onShowTestProject: () => void;
}) {
  const showingTest = () => props.view === 'test';

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => (showingTest() ? props.onShowChat() : props.onShowTestProject())}
      title={showingTest() ? 'Back to the conversation' : "The Project this chat's agent is being tested in"}
    >
      <Show
        when={showingTest()}
        fallback={
          <>
            <AppWindow class="h-3.5 w-3.5" aria-hidden="true" />
            Test project
            <Show when={props.status === 'starting'}>
              <span class="text-muted-foreground">starting…</span>
            </Show>
          </>
        }
      >
        <MessageSquare class="h-3.5 w-3.5" aria-hidden="true" />
        Chat
      </Show>
    </Button>
  );
}

type PendingConfirm = 'delete-test-project' | 'delete-chat' | 'share' | 'unshare' | null;

function BuilderChatMenu(props: { chat: BuilderChat; onBack: () => void }) {
  const archive = useArchiveBuilderChat();
  const restore = useRestoreBuilderChat();
  const removeChat = useDeleteBuilderChat();
  const removeTestProject = useDeleteTestProject();
  const setVisibility = useSetBuilderChatVisibility(() => props.chat.id);
  const [confirm, setConfirm] = createSignal<PendingConfirm>(null);

  const producesNothing = () => props.chat.produced.length === 0;

  const onArchive = () => {
    archive.mutate(props.chat.id, {
      onSuccess: () =>
        toast.success('Chat archived.', {
          action: { label: 'Undo', onClick: () => restore.mutate(props.chat.id) },
        }),
      onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The chat could not be archived.'),
    });
  };

  const onDelete = () => {
    removeChat.mutate(props.chat.id, {
      onSuccess: () => {
        toast.success('Chat deleted.');
        props.onBack();
      },
      onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The chat could not be deleted.'),
    });
  };

  const onVisibility = (visibility: ChatVisibility) => {
    setVisibility.mutate(visibility, {
      onSuccess: () => toast.success(visibility === 'public' ? 'Chat is now public.' : 'Chat is private again.'),
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'The chat visibility could not be changed.'),
    });
  };

  const onDeleteTestProject = () => {
    removeTestProject.mutate(props.chat.id, {
      onSuccess: () => toast.success('Test project deleted.'),
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'The test project could not be deleted.'),
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          class={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            FOCUS_RING
          )}
          aria-label="Chat actions"
        >
          <EllipsisVertical class="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <Show when={props.chat.canShare}>
            <Show
              when={props.chat.visibility === 'public'}
              fallback={
                <DropdownMenuItem onSelect={() => setConfirm('share')}>
                  <Globe class="h-3.5 w-3.5 text-muted-foreground" />
                  Make public…
                </DropdownMenuItem>
              }
            >
              <DropdownMenuItem onSelect={() => setConfirm('unshare')}>
                <Lock class="h-3.5 w-3.5 text-muted-foreground" />
                Make private…
              </DropdownMenuItem>
            </Show>
            <DropdownMenuSeparator />
          </Show>
          <Show when={props.chat.testProject}>
            <DropdownMenuItem onSelect={() => setConfirm('delete-test-project')}>
              <Trash2 class="h-3.5 w-3.5 text-muted-foreground" />
              Delete test project
            </DropdownMenuItem>
          </Show>
          <Show
            when={props.chat.disabled}
            fallback={
              <DropdownMenuItem onSelect={onArchive}>
                <Archive class="h-3.5 w-3.5 text-muted-foreground" />
                Archive
              </DropdownMenuItem>
            }
          >
            <DropdownMenuItem onSelect={() => restore.mutate(props.chat.id)}>
              <ArchiveRestore class="h-3.5 w-3.5 text-muted-foreground" />
              Restore
            </DropdownMenuItem>
          </Show>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setConfirm('delete-chat')}>
            <Trash2 class="h-3.5 w-3.5 text-destructive" />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirm() === 'share'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Make this chat public?"
        description="Everyone in the organization who can author skills and agents will be able to open it, read the transcript, prompt it and use its test project. You can make it private again at any time."
        confirmLabel="Make public"
        onConfirm={() => onVisibility('public')}
      />

      <ConfirmDialog
        open={confirm() === 'unshare'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Make this chat private?"
        description="Only you will be able to open it and its test project again. Anything it has already published to the Store stays where it is."
        confirmLabel="Make private"
        onConfirm={() => onVisibility('private')}
      />

      <ConfirmDialog
        open={confirm() === 'delete-test-project'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete the test project?"
        description="Its pod and everything in its workspace go with it. The chat can create a new one."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={onDeleteTestProject}
      />

      <ConfirmDialog
        open={confirm() === 'delete-chat'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete this chat?"
        description={
          producesNothing()
            ? 'This chat has not produced a skill or an agent yet. Deleting it destroys the transcript, its workspace and any test project — nothing of this work survives. Archiving keeps all of it out of the way instead.'
            : 'The transcript, the workspace and any test project go with it. The skills and agents it has already published stay in the Store.'
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={onDelete}
      >
        <Show when={producesNothing() && !props.chat.disabled}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setConfirm(null);
              onArchive();
            }}
          >
            Archive instead
          </Button>
        </Show>
      </ConfirmDialog>
    </>
  );
}
