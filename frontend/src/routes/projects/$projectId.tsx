import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import { useProject } from '~/api/projects';
import { ConfigureDeepLink } from '~/components/project/external-services/configure-deep-link';
import { createDocumentTitle } from '~/lib/create-document-title';
import { projectTitleOf } from '~/lib/project-title';
import { ProjectView } from '~/pages/project';

interface ProjectSearch {
  prompt: string | undefined;
  promptId: string | undefined;
  configure?: string;
  field?: string;
  environment?: string;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export const Route = createFileRoute('/projects/$projectId')({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
    promptId: typeof search.promptId === 'string' ? search.promptId : undefined,
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

  const initialPrompt = () => {
    const { prompt, promptId } = search();
    return prompt && promptId ? { id: promptId, text: prompt } : undefined;
  };

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
