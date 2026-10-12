import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import { useProject } from '~/api/projects';
import { createDocumentTitle } from '~/lib/create-document-title';
import { projectTitleOf } from '~/lib/project-title';
import { ProjectView } from '~/pages/project';

export const Route = createFileRoute('/projects/$projectId')({
  validateSearch: (search: Record<string, unknown>) => ({
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
    promptId: typeof search.promptId === 'string' ? search.promptId : undefined,
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
      search: { prompt: undefined, promptId: undefined },
      replace: true,
    });

  return (
    <ProjectView
      projectId={params().projectId}
      initialPrompt={initialPrompt}
      onInitialPromptAdmitted={consumeInitialPrompt}
    />
  );
}
