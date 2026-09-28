import { Show } from 'solid-js';
import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { toast } from 'solid-sonner';
import { limitRefusalMessage } from '~/api/limits';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { api, type Project } from '~/api/client';
import { projectKeys } from '~/api/projects';
import { Ban } from '~/components/icons';
import { Button } from '~/components/ui/button';

export function ProjectDisabled(props: { projectId: string }) {
  const qc = useQueryClient();
  const { hasPermission } = usePermissions();
  const canDisable = () => hasPermission(Permission.disableProject);

  const enableProject = createMutation(() => ({
    mutationFn: () => api.post<Project>(`/projects/${props.projectId}/enable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
    onError: (err) => toast.error(limitRefusalMessage(err, 'Failed to enable project')),
  }));

  return (
    <div class="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      <Ban class="w-8 h-8" />
      <p class="text-sm font-medium">This project is disabled</p>
      <Show when={canDisable()}>
        <Button
          size="sm"
          class="mt-1"
          loading={enableProject.isPending}
          onClick={() => enableProject.mutate(undefined as never)}
        >
          Enable Project
        </Button>
      </Show>
    </div>
  );
}
