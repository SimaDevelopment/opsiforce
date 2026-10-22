import { For, type Component, type JSX } from 'solid-js';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';

export interface SettingsDialogTab {
  value: string;
  label: string;
  icon: Component<{ class?: string }>;
  content: () => JSX.Element;
}

export function SettingsDialog(props: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: SettingsDialogTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent align="top" class="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.description}</DialogDescription>

        <Tabs value={props.activeTab} onChange={props.onTabChange} class="mt-4 flex min-h-0 flex-1 flex-col">
          <TabsList class="shrink-0">
            <For each={props.tabs}>
              {(tab) => (
                <TabsTrigger value={tab.value}>
                  <tab.icon class="w-3.5 h-3.5 mr-1.5" />
                  {tab.label}
                </TabsTrigger>
              )}
            </For>
          </TabsList>

          <div class="mt-3 min-h-0 overflow-y-auto pr-1">
            <For each={props.tabs}>
              {(tab) => (
                <TabsContent value={tab.value} class="mt-0">
                  {tab.content()}
                </TabsContent>
              )}
            </For>
          </div>
        </Tabs>

        <div class="mt-4 flex shrink-0 justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!props.canSave || props.saving} onClick={() => props.onSave()}>
            {props.saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
