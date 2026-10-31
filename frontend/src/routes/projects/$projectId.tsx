import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import { useProject } from '~/api/projects';
import { ConfigureDeepLink } from '~/components/project/external-services/configure-deep-link';
import {
  initialPromptOf,
  initialPromptSearchOf,
  type InitialPromptSearch,
} from '~/components/project/initial-prompt-search';
import { createDocumentTitle } from '~/lib/create-document-title';
import { projectTitleOf } from '~/lib/project-title';
import { ProjectView } from '~/pages/project';
import { ProjectTitleLabel } from '~/components/project/project-header';

interface ProjectSearch extends InitialPromptSearch {
  configure?: string;
  field?: string;
  environment?: string;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export const Route = createFileRoute('/projects/$projectId')({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    ...initialPromptSearchOf(search),
    configure: optionalText(search.configure),
    field: optionalText(search.field),
    environment: optionalText(search.environment),
  }),
  component: ProjectPage,
});

function ProjectPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const project = useProject(() => params().projectId);
  createDocumentTitle(() => project.data && projectTitleOf(project.data));

  const initialPrompt = () => initialPromptOf(search());

  const consumeInitialPrompt = () =>
    navigate({
      to: '/projects/$projectId',
      params: { projectId: params().projectId },
      search: (previous) => ({ ...previous, prompt: undefined, promptId: undefined }),
      replace: true,
    });

  const closeConfigure = () =>
    navigate({
      to: '/projects/$projectId',
      params: { projectId: params().projectId },
      search: (previous) => ({
        prompt: previous.prompt,
        promptId: previous.promptId,
      }),
      replace: true,
    });

  return (
    <>
      <ProjectView
        projectId={params().projectId}
        initialPrompt={initialPrompt}
        onInitialPromptAdmitted={consumeInitialPrompt}
        /* The band had no title at all on this route: a project screen that
           never says which project, or which workspace it belongs to. */
        headerLabel={<ProjectTitleLabel projectId={params().projectId} />}
      />
      <ConfigureDeepLink
        projectId={params().projectId}
        projectEnvironmentId={search().environment ?? params().projectId}
        slug={search().configure}
        field={search().field}
        onClose={closeConfigure}
      />
    </>
  );
}
