import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import { useImportAgent, type AgentDetail, type AgentImportNote, type AgentImportProblem } from '~/api/agents';
import { cancelImportUploadSession, createImportUploadSession, uploadImportChunks } from '~/api/import';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { AlertTriangle, Info, Upload } from '~/components/icons';
import { slugify } from '~/lib/app-url';
import { ENTRY_SLUG_MAX_LENGTH, EntryNameField, isNameUnavailable } from './entry-name-field';

type Phase = 'form' | 'uploading' | 'importing' | 'notes';

interface UploadedFile {
  file: File;
  uploadId: string;
}

export function ImportAgentDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const importAgent = useImportAgent();
  const [file, setFile] = createSignal<File | null>(null);
  const [name, setName] = createSignal('');
  const [phase, setPhase] = createSignal<Phase>('form');
  const [bytesSent, setBytesSent] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [problems, setProblems] = createSignal<AgentImportProblem[]>([]);
  const [unavailableSlug, setUnavailableSlug] = createSignal<string | null>(null);
  const [imported, setImported] = createSignal<{ agent: AgentDetail; notes: AgentImportNote[] } | null>(null);
  let uploaded: UploadedFile | null = null;
  let upload: AbortController | null = null;
  let attempt = 0;

  const trimmed = () => name().trim();
  const slug = () => slugify(trimmed(), ENTRY_SLUG_MAX_LENGTH.agent);
  const unavailable = () => unavailableSlug() !== null && unavailableSlug() === slug();
  const busy = () => phase() === 'uploading' || phase() === 'importing';
  const closable = () => phase() !== 'importing';
  const nameInvalid = () => trimmed().length > 0 && slug().length === 0;
  const canSubmit = () => file() !== null && !busy() && !unavailable() && !nameInvalid();
  const percent = () => {
    const size = file()?.size ?? 0;
    return size > 0 ? Math.min(100, Math.round((bytesSent() / size) * 100)) : 0;
  };
  const otherProblems = () => problems().filter((problem) => problem.kind !== 'name');

  const discardUpload = () => {
    upload?.abort();
    upload = null;
    if (uploaded) cancelImportUploadSession(uploaded.uploadId);
    uploaded = null;
  };

  const reset = () => {
    setFile(null);
    setName('');
    setPhase('form');
    setBytesSent(0);
    setError(null);
    setProblems([]);
    setUnavailableSlug(null);
    setImported(null);
  };

  const close = () => {
    attempt += 1;
    discardUpload();
    reset();
    props.onOpenChange(false);
  };

  const openAgent = (agent: AgentDetail) => {
    close();
    void navigate({ to: '/store/agents/$id', params: { id: agent.id } });
  };

  const uploadOnce = async (chosen: File): Promise<string> => {
    if (uploaded?.file === chosen) return uploaded.uploadId;
    discardUpload();
    setPhase('uploading');
    setBytesSent(0);
    const session = await createImportUploadSession(chosen.size);
    uploaded = { file: chosen, uploadId: session.uploadId };
    upload = new AbortController();
    await uploadImportChunks({
      file: chosen,
      uploadId: session.uploadId,
      chunkSize: session.chunkSize,
      startIndex: 0,
      signal: upload.signal,
      onProgress: setBytesSent,
      onChunkConfirmed: () => {},
    });
    upload = null;
    return session.uploadId;
  };

  const showRefusal = (caught: unknown) => {
    if (!(caught instanceof ApiError)) {
      setError(caught instanceof Error ? caught.message : 'The agent could not be imported.');
      return;
    }
    const refused = Array.isArray(caught.details.problems) ? (caught.details.problems as AgentImportProblem[]) : [];
    setProblems(refused);
    if (isNameUnavailable(caught)) {
      const fromFile = typeof caught.details.nameFromFile === 'string' ? caught.details.nameFromFile : '';
      if (!trimmed()) setName(fromFile);
      setUnavailableSlug(slug());
      return;
    }
    if (caught.status === 400) uploaded = null;
    if (refused.length === 0) setError(caught.message);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const chosen = file();
    if (!chosen || !canSubmit()) return;
    setError(null);
    setProblems([]);
    const current = ++attempt;
    try {
      const uploadId = await uploadOnce(chosen);
      setPhase('importing');
      const result = await importAgent.mutateAsync({ uploadId, displayName: trimmed() || null });
      uploaded = null;
      toast.success(`Imported ${result.agent.displayName ?? result.agent.name}`);
      if (result.notes.length === 0) {
        openAgent(result.agent);
        return;
      }
      setImported(result);
      setPhase('notes');
    } catch (caught) {
      if (current !== attempt) return;
      setPhase('form');
      showRefusal(caught);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) props.onOpenChange(true);
        else if (closable()) close();
      }}
    >
      <DialogContent hideClose={!closable()}>
        <Switch>
          <Match when={phase() === 'notes' && imported()}>
            {(result) => (
              <>
                <DialogHeader>
                  <DialogTitle>Imported {result().agent.displayName ?? result().agent.name}</DialogTitle>
                  <DialogDescription>
                    The agent is private to you. A few things changed on the way in.
                  </DialogDescription>
                </DialogHeader>
                <ul class="mt-4 space-y-2 text-xs">
                  <For each={result().notes}>
                    {(note) => (
                      <li class="flex gap-2">
                        <Info class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span>{note.message}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <DialogFooter class="mt-4">
                  <Button size="sm" onClick={() => openAgent(result().agent)}>
                    Open agent
                  </Button>
                </DialogFooter>
              </>
            )}
          </Match>
          <Match when={phase() !== 'notes'}>
            <form onSubmit={(event) => void submit(event)}>
              <DialogHeader>
                <DialogTitle>Import agent</DialogTitle>
                <DialogDescription>
                  Creates a new private agent from an agent export file, with its prompt, model, skills and Template.
                  New projects can pick it after its first publish.
                </DialogDescription>
              </DialogHeader>

              <div class="mt-4 space-y-3">
                <div>
                  <label for="import-agent-file" class="mb-1 block text-xs font-medium text-muted-foreground">
                    Export file
                  </label>
                  <input
                    id="import-agent-file"
                    type="file"
                    accept=".zip,application/zip"
                    disabled={busy()}
                    onChange={(event) => {
                      setFile(event.currentTarget.files?.[0] ?? null);
                      setError(null);
                      setProblems([]);
                      setUnavailableSlug(null);
                    }}
                    class="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-accent"
                  />
                </div>
                <div>
                  <EntryNameField
                    id="import-agent-name"
                    label="Name (optional)"
                    value={name()}
                    slug={slug()}
                    unavailable={unavailable()}
                    placeholder="Name from the file"
                    onInput={(value) => {
                      setName(value);
                      setError(null);
                    }}
                  />
                </div>

                <Show when={phase() === 'uploading'}>
                  <div aria-live="polite">
                    <div class="mb-1 flex justify-between text-xs text-muted-foreground">
                      <span>Uploading…</span>
                      <span>{percent()}%</span>
                    </div>
                    <div
                      class="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent()}
                    >
                      <div class="h-full bg-primary transition-[width]" style={{ width: `${percent()}%` }} />
                    </div>
                  </div>
                </Show>
                <Show when={phase() === 'importing'}>
                  <p class="text-xs text-muted-foreground" aria-live="polite">
                    Checking the file and creating the agent…
                  </p>
                </Show>

                <Show when={otherProblems().length > 0}>
                  <div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert">
                    <div class="flex gap-2 font-medium text-destructive">
                      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Nothing was imported. Fix these and import again:</span>
                    </div>
                    <ul class="mt-2 list-disc space-y-1 pl-5">
                      <For each={otherProblems()}>{(problem) => <li>{problem.message}</li>}</For>
                    </ul>
                  </div>
                </Show>
                <Show when={error()}>
                  <p class="text-xs text-destructive" role="alert">
                    {error()}
                  </p>
                </Show>
              </div>

              <DialogFooter class="mt-4">
                <Button type="button" size="sm" variant="outline" onClick={close} disabled={!closable()}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!canSubmit()} loading={busy()}>
                  <Upload class="h-3.5 w-3.5" aria-hidden="true" />
                  Import
                </Button>
              </DialogFooter>
            </form>
          </Match>
        </Switch>
      </DialogContent>
    </Dialog>
  );
}
