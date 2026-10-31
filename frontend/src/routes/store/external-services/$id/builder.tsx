import { Show } from 'solid-js';
import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import {
  initialPromptOf,
  initialPromptSearchOf,
  type InitialPromptSearch,
} from '~/components/project/initial-prompt-search';
import { BuilderPage } from '~/pages/store/builder-page';

interface ExternalServiceBuilderSearch extends Partial<InitialPromptSearch> {
  configure?: 'development';
  field?: string;
}

export const Route = createFileRoute('/store/external-services/$id/builder')({
  validateSearch: (search: Record<string, unknown>): ExternalServiceBuilderSearch => ({
    ...initialPromptSearchOf(search),
    configure: search.configure === 'development' ? 'development' : undefined,
    field: typeof search.field === 'string' && search.field !== '' ? search.field : undefined,
  }),
  component: ExternalServiceBuilder,
});

function ExternalServiceBuilder() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();

  const initialPrompt = () => initialPromptOf(search());

  const consumeInitialPrompt = () =>
    navigate({
      to: '/store/external-services/$id/builder',
      params: { id: params().id },
      search: { configure: search().configure, field: search().field },
      replace: true,
    });

  const closeConfigurationLink = () =>
    navigate({
      to: '/store/external-services/$id/builder',
      params: { id: params().id },
      search: { prompt: search().prompt, promptId: search().promptId },
      replace: true,
    });

  return (
    <Show when={params().id} keyed>
      {(id) => (
        <BuilderPage
          subject={{ type: 'external_service', id }}
          initialPrompt={initialPrompt}
          onInitialPromptAdmitted={consumeInitialPrompt}
          configurationLink={search().configure === 'development' ? { field: search().field } : undefined}
          onConfigurationLinkClosed={closeConfigurationLink}
        />
      )}
    </Show>
  );
}
