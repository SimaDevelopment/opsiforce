import { splitProps, type JSX, type ParentProps } from 'solid-js';
import { cn } from '~/lib/cn';

export function TableCell(props: ParentProps<JSX.TdHTMLAttributes<HTMLTableCellElement> & { label?: string }>) {
  const [local, rest] = splitProps(props, ['class', 'children', 'label']);
  return (
    <td
      class={cn('px-3 py-2.5 align-middle [&:has([role=checkbox])]:pr-0', local.class)}
      data-label={local.label}
      {...rest}
    >
      {local.children}
    </td>
  );
}
