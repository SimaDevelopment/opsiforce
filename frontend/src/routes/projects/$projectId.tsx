import { createFileRoute, useNavigate } from '@tanstack/solid-router';
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
