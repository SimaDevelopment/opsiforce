import { LayoutGrid, List } from '~/components/icons';
import { ViewToggle, type ViewToggleOption } from '~/components/ui/view-toggle';

export type FilesViewMode = 'table' | 'cards';

const FILES_VIEW_OPTIONS: ViewToggleOption<FilesViewMode>[] = [
  { value: 'table', label: 'Table view', icon: List },
  { value: 'cards', label: 'Card view', icon: LayoutGrid },
];

export interface FilesViewToggleProps {
  mode: FilesViewMode;
  onChange: (mode: FilesViewMode) => void;
}

export function FilesViewToggle(props: FilesViewToggleProps) {
  return <ViewToggle value={props.mode} options={FILES_VIEW_OPTIONS} onChange={props.onChange} />;
}
