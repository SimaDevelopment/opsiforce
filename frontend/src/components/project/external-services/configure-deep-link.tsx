import { Show } from 'solid-js';
import { useProjectEnvironments } from '~/api/environments';
import { useProjectExternalServices, type ProjectEnvironmentRef } from '~/api/project-external-services';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { ProjectConfigurationDialog } from './project-configuration-dialog';

interface ConfigureDeepLinkProps {
  projectId: string;
  projectEnvironmentId: string;
  slug: string | undefined;
  field: string | undefined;
  onClose: () => void;
}

export function ConfigureDeepLink(props: ConfigureDeepLinkProps) {
  return (
    <Show when={props.slug} keyed>
      {(slug) => <LinkedConfiguration {...props} slug={slug} />}
    </Show>
  );
}

function LinkedConfiguration(props: ConfigureDeepLinkProps & { slug: string }) {
  const environment = (): ProjectEnvironmentRef => ({
    projectId: props.projectId,
    projectEnvironmentId: props.projectEnvironmentId,
  });
  const services = useProjectExternalServices(environment);
  const environments = useProjectEnvironments(() => props.projectId);
  const environmentName = () =>
    environments.data?.find((candidate) => candidate.id === props.projectEnvironmentId)?.name ?? 'Development';
  const linked = () => services.data?.services.find((service) => service.slug === props.slug);
  const unknownService = () => services.isError || (services.data !== undefined && linked() === undefined);

  return (
    <>
      <ProjectConfigurationDialog
        environment={environment()}
        environmentName={environmentName()}
        serviceId={linked()?.id ?? null}
        focusedField={props.field}
        onClose={props.onClose}
      />
      <Dialog open={unknownService()} onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent class="max-w-md">
          <DialogHeader>
            <DialogTitle>External service not found</DialogTitle>
            <DialogDescription>
              No External Service <code class="font-mono">{props.slug}</code> is available to this Project.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
