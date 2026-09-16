import { Show, type ParentProps } from 'solid-js';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from './dialog';
import { Button } from './button';

export type ConfirmDialogProps = ParentProps<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
  onConfirm: () => void;
}>;

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-sm">
        <DialogTitle>{props.title}</DialogTitle>
        <Show when={props.description}>{(description) => <DialogDescription>{description()}</DialogDescription>}</Show>
        {props.children}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            {props.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={props.variant ?? 'default'}
            size="sm"
            onClick={() => {
              props.onConfirm();
              props.onOpenChange(false);
            }}
          >
            {props.confirmLabel ?? 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
