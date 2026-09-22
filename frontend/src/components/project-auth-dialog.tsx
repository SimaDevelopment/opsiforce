import { Show } from 'solid-js';
import { usePermissions } from '~/api/permissions';
import { Permission } from '~/constants/permissions';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '~/components/ui/dialog';
import { ProjectAuthTab } from '~/components/project-auth';

export function ProjectAuthDialog(props: {
  projectId: string;
  environmentId: string;
  environmentName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { hasPermission } = usePermissions();
  const canManageAuth = () => hasPermission(Permission.manageProjectAuthSettings);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-2xl">
        <DialogTitle>App Auth{props.environmentName ? ` — ${props.environmentName}` : ''}</DialogTitle>
        <DialogDescription>Configure how visitors sign in to this environment's app.</DialogDescription>
        <div class="mt-4">
          <Show when={props.open}>
            <Show
              when={canManageAuth()}
              fallback={
                <div class="rounded-lg border border-border bg-muted/30 p-4 text-center">
                  <p class="text-sm text-muted-foreground">You do not have permission to manage project auth.</p>
                </div>
              }
            >
              <ProjectAuthTab projectId={props.projectId} environmentId={props.environmentId} />
            </Show>
          </Show>
        </div>
      </DialogContent>
    </Dialog>
  );
}
