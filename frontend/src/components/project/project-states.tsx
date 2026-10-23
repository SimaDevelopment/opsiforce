import { Show } from 'solid-js';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { toast } from 'solid-sonner';
import { api, type Project } from '~/api/client';
import { useRestartProjectEnvironment } from '~/api/environments';
import { limitRefusalMessage } from '~/api/limits';
import { usePermissions } from '~/api/permissions';
import { projectKeys } from '~/api/projects';
import { AlertTriangle, Ban, MessageSquare, Unplug } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Permission } from '~/constants/permissions';
import { ProjectStatePanel } from './project-state-panel';
import type { ConnectionProblem } from './use-opencode-connection';

interface EnvironmentRef {
  projectId: string;
  environmentId: string;
}

function useCanRestart(): () => boolean {
  const { hasPermission } = usePermissions();
  return () => hasPermission(Permission.restartProject);
}

function RestartProjectButton(props: EnvironmentRef & { variant?: 'default' | 'outline' }) {
  const restart = useRestartProjectEnvironment();

  return (
    <Button
      size="sm"
      variant={props.variant}
      loading={restart.isPending}
      onClick={() =>
        restart.mutate(
          { projectId: props.projectId, environmentId: props.environmentId },
          { onError: () => toast.error('Could not restart the project') }
        )
      }
    >
      Restart project
    </Button>
  );
}

export function ProjectConnecting(props: { starting: boolean }) {
  return <ProjectStatePanel busy title={props.starting ? 'Starting this project' : 'Connecting to this project'} />;
}

export function ProjectDisabled(props: { projectId: string }) {
  const qc = useQueryClient();
  const { hasPermission } = usePermissions();
  const canEnable = () => hasPermission(Permission.disableProject);

  const enableProject = createMutation(() => ({
    mutationFn: () => api.post<Project>(`/projects/${props.projectId}/enable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
    onError: (err) => toast.error(limitRefusalMessage(err, 'Failed to enable project')),
  }));

  return (
    <ProjectStatePanel
      icon={Ban}
      title="This project is disabled"
      description={
        canEnable()
          ? 'Its agent and app stay stopped until you enable it.'
          : 'Its agent and app stay stopped until someone with access enables it.'
      }
    >
      <Show when={canEnable()}>
        <Button size="sm" loading={enableProject.isPending} onClick={() => enableProject.mutate(undefined as never)}>
          Enable project
        </Button>
      </Show>
    </ProjectStatePanel>
  );
}

export function ProjectFailed(props: EnvironmentRef) {
  const canRestart = useCanRestart();

  return (
    <ProjectStatePanel
      icon={AlertTriangle}
      tone="danger"
      title="This project couldn't start"
      description={canRestart() ? 'Restarting usually fixes this.' : 'Ask someone with access to restart it.'}
    >
      <Show when={canRestart()}>
        <RestartProjectButton projectId={props.projectId} environmentId={props.environmentId} />
      </Show>
    </ProjectStatePanel>
  );
}

export function ProjectConnectionProblem(props: EnvironmentRef & { problem: ConnectionProblem; onRetry: () => void }) {
  const canRestart = useCanRestart();

  return (
    <Show
      when={props.problem === 'unreachable'}
      fallback={
        <ProjectStatePanel
          icon={MessageSquare}
          tone="warning"
          title="Your message wasn't confirmed"
          description="Try again to send the same message. It won't be sent twice."
        >
          <Button size="sm" onClick={() => props.onRetry()}>
            Try again
          </Button>
        </ProjectStatePanel>
      }
    >
      <ProjectStatePanel
        icon={Unplug}
        tone="warning"
        title="Couldn't connect to this project"
        description={
          canRestart()
            ? "The agent didn't answer. Try again, or restart the project if this keeps happening."
            : "The agent didn't answer. Try again in a moment."
        }
      >
        <Button size="sm" onClick={() => props.onRetry()}>
          Try again
        </Button>
        <Show when={canRestart()}>
          <RestartProjectButton projectId={props.projectId} environmentId={props.environmentId} variant="outline" />
        </Show>
      </ProjectStatePanel>
    </Show>
  );
}
