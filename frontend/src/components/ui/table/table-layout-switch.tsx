import { LayoutList, Table as TableIcon } from '~/components/icons';
import { createPersistedSignal } from '~/lib/persisted-signal';
import { ViewToggle, type ViewToggleOption } from '../view-toggle';

export type TableLayoutChoice = 'cards' | 'table';

const TABLE_LAYOUT_OPTIONS: ViewToggleOption<TableLayoutChoice>[] = [
  { value: 'cards', label: 'Show as cards', icon: LayoutList },
  { value: 'table', label: 'Show as table', icon: TableIcon },
];

export interface TableLayoutPreference {
  choice: () => TableLayoutChoice;
  setChoice: (choice: TableLayoutChoice) => void;
}

export function createTableLayoutPreference(storageKey: string): TableLayoutPreference {
  const [choice, setChoice] = createPersistedSignal<TableLayoutChoice>(storageKey, 'cards');
  return { choice, setChoice };
}

export function TableLayoutSwitch(props: { preference: TableLayoutPreference }) {
  return (
    <ViewToggle
      value={props.preference.choice()}
      options={TABLE_LAYOUT_OPTIONS}
      onChange={props.preference.setChoice}
    />
  );
}
