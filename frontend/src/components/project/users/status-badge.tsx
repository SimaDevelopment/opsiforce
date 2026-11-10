import type { AppUserStatus } from '~/api/app-users';
import { Badge } from '~/components/ui/badge';

export type DisplayStatus = AppUserStatus | 'locked';

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  locked: 'Locked',
  disabled: 'Disabled',
};

const VARIANTS = { active: 'success', invited: 'info', locked: 'warning', disabled: 'secondary' } as const;

export function StatusBadge(props: { status: DisplayStatus }) {
  return (
    <Badge variant={VARIANTS[props.status]} class="shrink-0 px-2 py-0 text-[11px] font-medium">
      {STATUS_LABELS[props.status]}
    </Badge>
  );
}
