import { Show } from 'solid-js';
import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import { BuilderChatPage } from '~/pages/store/builder-chat';

export const Route = createFileRoute('/store/builder/$id')({
  validateSearch: (search: Record<string, unknown>) => ({
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
    promptId: typeof search.promptId === 'string' ? search.promptId : undefined,
  }),
  component: BuilderChatRoute,
});

function BuilderChatRoute() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();

  const initialPrompt = () => {
    const { prompt, promptId } = search();
    return prompt && promptId ? { id: promptId, text: prompt } : undefined;
  };

  const consumeInitialPrompt = () =>
    navigate({
      to: '/store/builder/$id',
      params: { id: params().id },
      search: { prompt: undefined, promptId: undefined },
      replace: true,
    });

  return (
    <Show when={params().id} keyed>
      {(id) => (
        <BuilderChatPage chatId={id} initialPrompt={initialPrompt} onInitialPromptAdmitted={consumeInitialPrompt} />
      )}
    </Show>
  );
}
