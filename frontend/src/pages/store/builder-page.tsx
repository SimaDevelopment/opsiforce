import { Show, createSignal } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Link, useNavigate } from '@tanstack/solid-router';
import { ApiError } from '~/api/client';
import {
  useBuilderChatFor,
  useForgetBuilderChat,
  envSearch,
  subjectPath,
  useRefreshBuilderSubject,
  type BuilderChat,
  type BuilderSubject,
  type BuilderSubjectRef,
} from '~/api/builder';
import { useDevelopmentService } from '~/api/external-service-views';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { PaneStrip } from '~/components/ui/pane-strip';
import { Bot, Cable, ChevronLeft, Files, KeyRound, MessageSquare } from '~/components/icons';
import { DevelopmentConfigurationDialog } from '~/components/external-service/development-configuration-dialog';
import { ProjectTitleLabel } from '~/components/project/project-header';
import { DisabledBadge, FOCUS_RING } from '~/components/store/store-list';
import { ProjectView } from '~/pages/project';
import { cn } from '~/lib/cn';

const SUBJECT_ICON = { agent: Bot, skill: Files, external_service: Cable } as const;

const SUBJECT_NOUN = { agent: 'Agent', skill: 'Skill', external_service: 'External Service' } as const;

function subjectLabel(subject: BuilderSubject): string {
  return subject.displayName ?? subject.name;
}

function builderLabel(type: BuilderSubjectRef['type']): string {
  return type === 'external_service' ? 'External Service Builder' : 'Builder';
}

export function BuilderPage(props: { subject: BuilderSubjectRef; returnEnv?: string }) {
  const navigate = useNavigate();
  const chat = useBuilderChatFor(() => props.subject);
  const refresh = useRefreshBuilderSubject();
  const forget = useForgetBuilderChat();
  const backToSubject = () => navigate({ to: subjectPath(props.subject), search: envSearch(props.returnEnv) });
  const refreshSubject = () => refresh(props.subject);

  return (
    <div class="flex h-full w-full flex-col overflow-hidden">
      <BuilderBar subject={chat.data?.subject} target={props.subject} returnEnv={props.returnEnv} />
      <div class="min-h-0 flex-1">
        <Show when={!chat.isError} fallback={<ChatUnavailable error={chat.error} onBack={backToSubject} />}>
          <Show
            when={chat.data}
            fallback={
              <div class="flex h-full items-center justify-center">
                <Spinner />
              </div>
            }
          >
            {(data) => (
              <Show when={data().id} keyed>
                <BuilderStrip
                  chat={data()}
                  onChanged={refreshSubject}
                  onGone={() => {
                    forget(props.subject);
                    backToSubject();
                  }}
                />
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

function BuilderBar(props: { subject: BuilderSubject | undefined; target: BuilderSubjectRef; returnEnv?: string }) {
  const icon = () => SUBJECT_ICON[props.target.type];
  return (
    <div class="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1.5">
      <Link
        to={subjectPath(props.target)}
        search={envSearch(props.returnEnv)}
        class={cn(
          'inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          FOCUS_RING
        )}
      >
        <ChevronLeft class="h-4 w-4 shrink-0" aria-hidden="true" />
        <Dynamic component={icon()} class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span class="truncate font-medium text-foreground">
          {props.subject ? subjectLabel(props.subject) : SUBJECT_NOUN[props.target.type]}
        </span>
      </Link>
      <span class="text-muted-foreground/60" aria-hidden="true">
        /
      </span>
      <span class="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
        <MessageSquare class="h-3.5 w-3.5" aria-hidden="true" />
        {builderLabel(props.target.type)}
      </span>
      <Show when={props.subject?.disabled}>
        <DisabledBadge />
      </Show>
      <Show when={props.target.type === 'external_service'}>
        <DevelopmentConfigurationButton serviceId={props.target.id} />
      </Show>
    </div>
  );
}

function DevelopmentConfigurationButton(props: { serviceId: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <Button size="sm" variant="outline" class="ml-auto" onClick={() => setOpen(true)}>
        <KeyRound class="h-3.5 w-3.5" aria-hidden="true" />
        Development configuration
      </Button>
      <DevelopmentConfigurationDialog serviceId={props.serviceId} open={open()} onClose={() => setOpen(false)} />
    </>
  );
}

function BuilderStrip(props: { chat: BuilderChat; onChanged: () => void; onGone: () => void }) {
  const testProjectId = () => props.chat.testProject?.id;
  const [renamingTestProject, setRenamingTestProject] = createSignal(false);
  const [revealTestProject, setRevealTestProject] = createSignal(0);

  return (
    <PaneStrip
      hasSecond={testProjectId() !== undefined}
      revealSecond={revealTestProject()}
      first={
        <ProjectView
          projectId={props.chat.id}
          initialPrompt={() => undefined}
          onInitialPromptAdmitted={() => {}}
          onGone={props.onGone}
          onStatusEvent={props.onChanged}
          showSkillsAndServices={false}
          headerLabel={<span class="shrink-0 text-sm font-medium">{builderLabel(props.chat.subject.type)}</span>}
          footer={<ComposerNote chat={props.chat} />}
        />
      }
      second={
        <Show when={testProjectId()} keyed>
          {(id) => (
            <ProjectView
              projectId={id}
              initialPrompt={() => undefined}
              onInitialPromptAdmitted={() => {}}
              onGone={props.onChanged}
              onPreviewVisible={() => setRevealTestProject((token) => token + 1)}
              headerLabel={
                <ProjectTitleLabel
                  projectId={id}
                  editing={renamingTestProject()}
                  onEditDone={() => setRenamingTestProject(false)}
                />
              }
              onRename={() => setRenamingTestProject(true)}
              deleteDescription="Its pod and everything in its workspace go with it. The Builder can create a new one."
            />
          )}
        </Show>
      }
    />
  );
}

function ComposerNote(props: { chat: BuilderChat }) {
  return (
    <Show when={props.chat.subject.type !== 'external_service'} fallback={<ServiceComposerNote chat={props.chat} />}>
      <EntryComposerNote chat={props.chat} />
    </Show>
  );
}

function ServiceComposerNote(props: { chat: BuilderChat }) {
  const unprompted = () => props.chat.lastPromptAt === null;
  const development = useDevelopmentService(() => props.chat.subject.id, unprompted);
  const holdsOperations = () => Object.keys(development.data?.manifest.operations ?? {}).length > 0;
  return (
    <Show when={unprompted() && !development.isPending}>
      <p class="shrink-0 text-balance border-t border-border bg-background px-3 py-2 text-center text-xs text-muted-foreground">
        <Show
          when={holdsOperations()}
          fallback={
            <>
              Tell the External Service Builder what {subjectLabel(props.chat.subject)} should connect to. It proposes
              the service's forms and Operations for your approval, then writes and tests them here; publishing stays
              with you on the service's page.
            </>
          }
        >
          {subjectLabel(props.chat.subject)} already has its forms and Operations. Fill in its Development
          configuration, then ask the External Service Builder to test it here; publishing stays with you on the
          service's page.
        </Show>
      </p>
    </Show>
  );
}

function EntryComposerNote(props: { chat: BuilderChat }) {
  const noun = () => props.chat.subject.type;
  return (
    <Show when={props.chat.lastPromptAt === null}>
      <p class="shrink-0 text-balance border-t border-border bg-background px-3 py-2 text-center text-xs text-muted-foreground">
        Tell the Builder what {subjectLabel(props.chat.subject)} should do. It writes the {noun()}
        {props.chat.subject.type === 'agent' ? ', tries it in a test project' : ''} and saves it here; publishing,
        sharing and deleting stay on the {noun()}'s page.
      </p>
    </Show>
  );
}

function ChatUnavailable(props: { error: unknown; onBack: () => void }) {
  const message = () => {
    if (props.error instanceof ApiError && props.error.status === 404) {
      return "This isn't visible to you. It may be private to its creator, or it was deleted.";
    }
    return props.error instanceof ApiError ? props.error.message : 'The Builder could not be opened.';
  };
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p class="max-w-md text-pretty text-sm text-muted-foreground">{message()}</p>
      <Button size="sm" variant="outline" onClick={props.onBack}>
        Go back
      </Button>
    </div>
  );
}
