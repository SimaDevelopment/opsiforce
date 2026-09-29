import { Show } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import { BuilderPage } from '~/pages/store/builder-page';

export const Route = createFileRoute('/store/skills/$id/builder')({
  component: SkillBuilder,
});

function SkillBuilder() {
  const params = Route.useParams();
  return (
    <Show when={params().id} keyed>
      {(id) => <BuilderPage subject={{ type: 'skill', id }} />}
    </Show>
  );
}
