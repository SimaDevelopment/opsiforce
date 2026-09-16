import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { api, type Project } from '~/api/client';
import { projectKeys } from '~/api/projects';
import { AlertTriangle } from '~/components/icons';
import { Button } from '~/components/ui/button';

export function ProjectFailed(props: { projectId: string }) {
  const qc = useQueryClient();

  const retry = createMutation(() => ({
    mutationFn: () => api.post<Project>(`/projects/${props.projectId}/restart`),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  }));

  return (
    <div class="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground px-6 text-center">
      <AlertTriangle class="w-8 h-8 text-destructive" />
      <p class="text-sm font-medium">This project couldn't start</p>
      <p class="text-xs max-w-md">
        The agent container image is unavailable. Ask your administrator to verify the deployment, then retry.
      </p>
      <Button size="sm" class="mt-1" loading={retry.isPending} onClick={() => retry.mutate(undefined as never)}>
        Retry
      </Button>
    </div>
  );
}
