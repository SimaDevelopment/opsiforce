import { createFileRoute } from '@tanstack/solid-router';
import { DEFAULT_SKILL_FILE, SkillPage } from '~/pages/store/skill-page';

export interface SkillPageSearch {
  v?: number;
  file: string;
  agent?: string;
}

function validateSearch(search: Record<string, unknown>): SkillPageSearch {
  const version = Number(search.v);
  return {
    ...(Number.isInteger(version) && version > 0 ? { v: version } : {}),
    file: typeof search.file === 'string' && search.file ? search.file : DEFAULT_SKILL_FILE,
    ...(typeof search.agent === 'string' && search.agent ? { agent: search.agent } : {}),
  };
}

export const Route = createFileRoute('/store/skills/$id/')({
  component: StoreSkill,
  validateSearch,
});

function StoreSkill() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <SkillPage
      skillId={params().id}
      version={search().v}
      file={search().file}
      fromAgentId={search().agent}
      onVersion={(v) => navigate({ search: (prev) => ({ ...prev, v }), replace: true })}
      onFile={(file) => navigate({ search: (prev) => ({ ...prev, file }), replace: true })}
    />
  );
}
