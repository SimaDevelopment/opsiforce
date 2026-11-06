import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';

export interface SelectOption {
  value: string;
  label: string;
}

/** A plain list of choices; every option needs a non-empty value, or the trigger shows nothing. */
export function OptionSelect(props: {
  options: SelectOption[];
  value: string;
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      value={props.options.find((option) => option.value === props.value) ?? null}
      disabled={props.disabled}
      onChange={(option) => {
        if (option && option.value !== props.value) props.onChange(option.value);
      }}
      itemComponent={(itemProps) => <SelectItem item={itemProps.item}>{itemProps.item.rawValue.label}</SelectItem>}
    >
      <SelectTrigger aria-label={props.ariaLabel}>
        <SelectValue<SelectOption>>{(state) => <span>{state.selectedOption()?.label}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}
