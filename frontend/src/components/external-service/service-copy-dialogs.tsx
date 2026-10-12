import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import { builderPath } from '~/api/builder';
import { ApiError } from '~/api/client';
import {
  downloadServiceExport,
  useDuplicateService,
  useImportService,
  useServiceExportPreview,
  type ServiceCopy,
  type ServiceImportProblem,
} from '~/api/external-service-copies';
import { cancelImportUploadSession, createImportUploadSession, uploadImportChunks } from '~/api/import';
import { AlertTriangle, Upload } from '~/components/icons';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { ServiceNameFields, createServiceNaming } from './service-name-fields';

interface CopiedService {
  id: string;
  slug: string;
  displayName: string;
}

const COMMITTED_ONLY =
  "Only what the builder has committed travels: work it hasn't committed yet is left out. Configurations, secrets, Calls, the builder chat and its Test Project stay here.";

function refusalMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

function useOpenBuilder() {
  const navigate = useNavigate();
  return (copy: ServiceCopy) => {
    toast.success(`Created ${copy.service.displayName}`);
    void navigate({ to: builderPath({ type: 'external_service', id: copy.service.id }) });
  };
}

export function DuplicateServiceDialog(props: {
  service: CopiedService;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const duplicate = useDuplicateService(() => props.service.id);
  const openBuilder = useOpenBuilder();
  const naming = createServiceNaming(`${props.service.displayName} copy`, `${props.service.slug}-copy`.slice(0, 31));
  const [error, setError] = createSignal<string | null>(null);
  const canSubmit = () => naming.valid() && !duplicate.isPending;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit()) return;
    setError(null);
    try {
      const copy = await duplicate.mutateAsync({ name: naming.name().trim(), slug: naming.slug() });
      props.onOpenChange(false);
      openBuilder(copy);
    } catch (caught) {
      if (naming.placeSlugRefusal(caught)) return;
      setError(refusalMessage(caught, 'The External Service could not be duplicated.'));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Duplicate {props.service.displayName}</DialogTitle>
            <DialogDescription>
              Creates a new Draft service with its own builder chat, starting from this service's code. {COMMITTED_ONLY}
            </DialogDescription>
          </DialogHeader>
          <div class="mt-4 flex flex-col gap-4">
            <ServiceNameFields id="duplicate-service" naming={naming} onEdit={() => setError(null)} />
            <Show when={error()}>
              <p class="text-xs text-destructive" role="alert">
                {error()}
              </p>
            </Show>
          </div>
          <DialogFooter class="mt-4">
            <Button type="button" variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit()} loading={duplicate.isPending}>
              Duplicate and open the chat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ExportServiceDialog(props: {
  service: CopiedService;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useServiceExportPreview(
    () => props.service.id,
    () => props.open
  );
  const refused = () => preview.error instanceof ApiError && preview.error.status >= 400 && preview.error.status < 500;

  const download = () => {
    downloadServiceExport(props.service.id, props.service.slug);
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export {props.service.displayName}</DialogTitle>
          <DialogDescription>
            The file carries this service's code, to import as a new Draft into another Organization or deployment.{' '}
            {COMMITTED_ONLY}
          </DialogDescription>
        </DialogHeader>
        <div class="mt-4">
          <Show
            when={!preview.isPending}
            fallback={
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size="sm" /> Checking for key-like strings…
              </div>
            }
          >
            <Show
              when={!preview.error}
              fallback={
                <Show
                  when={refused()}
                  fallback={
                    <p class="text-xs text-amber-900" role="alert">
                      The file couldn't be checked for keys or secrets. You can still download it; check it before you
                      share it.
                    </p>
                  }
                >
                  <p class="text-xs text-destructive" role="alert">
                    {refusalMessage(preview.error, 'The service could not be checked for export.')}
                  </p>
                </Show>
              }
            >
              <Show when={(preview.data?.hits.length ?? 0) > 0}>
                <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <div class="flex gap-2 font-medium">
                    <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>These look like keys or secrets. Check them before you share the file.</span>
                  </div>
                  <ul class="mt-2 space-y-1 pl-5">
                    <For each={preview.data?.hits ?? []}>
                      {(hit) => (
                        <li>
                          <span class="font-mono">app/{hit.path}</span> — {hit.reason}
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
        <DialogFooter class="mt-4">
          <Button type="button" variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={preview.isPending || refused()} onClick={download}>
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ImportPhase = 'form' | 'uploading' | 'importing' | 'warnings';

export function ImportServiceDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const importService = useImportService();
  const openBuilder = useOpenBuilder();
  const naming = createServiceNaming();
  const [file, setFile] = createSignal<File | null>(null);
  const [named, setNamed] = createSignal(false);
  const [phase, setPhase] = createSignal<ImportPhase>('form');
  const [bytesSent, setBytesSent] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [problems, setProblems] = createSignal<ServiceImportProblem[]>([]);
  const [imported, setImported] = createSignal<ServiceCopy | null>(null);
  let uploaded: { file: File; uploadId: string } | null = null;
  let upload: AbortController | null = null;
  let attempt = 0;

  const busy = () => phase() === 'uploading' || phase() === 'importing';
  const closable = () => phase() !== 'importing';
  const canSubmit = () => file() !== null && !busy() && (!named() || naming.valid());
  const percent = () => {
    const size = file()?.size ?? 0;
    return size > 0 ? Math.min(100, Math.round((bytesSent() / size) * 100)) : 0;
  };

  const discardUpload = () => {
    upload?.abort();
    upload = null;
    if (uploaded) cancelImportUploadSession(uploaded.uploadId);
    uploaded = null;
  };

  const close = () => {
    attempt += 1;
    discardUpload();
    setFile(null);
    naming.reset();
    setNamed(false);
    setPhase('form');
    setBytesSent(0);
    setError(null);
    setProblems([]);
    setImported(null);
    props.onOpenChange(false);
  };

  const uploadOnce = async (chosen: File, current: number): Promise<string | null> => {
    if (uploaded?.file === chosen) return uploaded.uploadId;
    discardUpload();
    setPhase('uploading');
    setBytesSent(0);
    const session = await createImportUploadSession(chosen.size);
    if (current !== attempt) {
      cancelImportUploadSession(session.uploadId);
      return null;
    }
    upload = new AbortController();
    try {
      await uploadImportChunks({
        file: chosen,
        uploadId: session.uploadId,
        chunkSize: session.chunkSize,
        startIndex: 0,
        signal: upload.signal,
        onProgress: setBytesSent,
        onChunkConfirmed: () => {},
      });
    } catch (caught) {
      upload = null;
      cancelImportUploadSession(session.uploadId);
      throw caught;
    }
    upload = null;
    if (current !== attempt) {
      cancelImportUploadSession(session.uploadId);
      return null;
    }
    uploaded = { file: chosen, uploadId: session.uploadId };
    return session.uploadId;
  };

  const showRefusal = (caught: unknown) => {
    if (!(caught instanceof ApiError)) {
      setError(caught instanceof Error ? caught.message : 'The External Service could not be imported.');
      return;
    }
    if (!named()) {
      const fromFile = (key: string) => (typeof caught.details[key] === 'string' ? caught.details[key] : null);
      const name = fromFile('nameFromFile');
      if (name !== null) {
        naming.reset(name, fromFile('slugFromFile'));
        setNamed(true);
      }
    }
    if (naming.placeSlugRefusal(caught)) return;
    if (caught.status === 400) uploaded = null;
    const refused = Array.isArray(caught.details.problems) ? (caught.details.problems as ServiceImportProblem[]) : [];
    setProblems(refused);
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
      const uploadId = await uploadOnce(chosen, current);
      if (uploadId === null) return;
      setPhase('importing');
      const copy = await importService.mutateAsync(
        named()
          ? { uploadId, fileName: chosen.name, name: naming.name().trim(), slug: naming.slug() }
          : { uploadId, fileName: chosen.name }
      );
      uploaded = null;
      if (copy.warnings.length === 0) {
        close();
        openBuilder(copy);
        return;
      }
      setImported(copy);
      setPhase('warnings');
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
          <Match when={phase() === 'warnings' && imported()}>
            {(copy) => (
              <>
                <DialogHeader>
                  <DialogTitle>Imported {copy().service.displayName} as a Draft</DialogTitle>
                  <DialogDescription>Its builder has work to do before you can publish it.</DialogDescription>
                </DialogHeader>
                <ul class="mt-4 space-y-2 text-xs">
                  <For each={copy().warnings}>
                    {(warning) => (
                      <li class="flex gap-2">
                        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                        <span>{warning}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <DialogFooter class="mt-4">
                  <Button
                    size="sm"
                    onClick={() => {
                      const opened = copy();
                      close();
                      openBuilder(opened);
                    }}
                  >
                    Open the builder chat
                  </Button>
                </DialogFooter>
              </>
            )}
          </Match>
          <Match when={phase() !== 'warnings'}>
            <form onSubmit={(event) => void submit(event)}>
              <DialogHeader>
                <DialogTitle>Import service</DialogTitle>
                <DialogDescription>
                  Creates a new Draft External Service with its own builder chat from a service export file. You fill in
                  its Service configuration, test it and publish it, as for any Draft. Only the builder's committed work
                  is in the file.
                </DialogDescription>
              </DialogHeader>

              <div class="mt-4 flex flex-col gap-4">
                <div>
                  <label for="import-service-file" class="mb-1 block text-xs font-medium text-muted-foreground">
                    Export file
                  </label>
                  <input
                    id="import-service-file"
                    type="file"
                    accept=".zip,application/zip"
                    disabled={busy()}
                    onChange={(event) => {
                      setFile(event.currentTarget.files?.[0] ?? null);
                      setError(null);
                      setProblems([]);
                    }}
                    class="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-accent"
                  />
                </div>
                <Show
                  when={named()}
                  fallback={
                    <button
                      type="button"
                      class="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      onClick={() => setNamed(true)}
                      disabled={busy()}
                    >
                      Choose a name and slug instead of the file's
                    </button>
                  }
                >
                  <ServiceNameFields
                    id="import-service"
                    naming={naming}
                    disabled={busy()}
                    onEdit={() => setError(null)}
                  />
                </Show>

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
                    Checking the file and creating the service…
                  </p>
                </Show>

                <Show when={problems().length > 0}>
                  <div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert">
                    <div class="flex gap-2 font-medium text-destructive">
                      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Nothing was imported. Fix these and import again:</span>
                    </div>
                    <ul class="mt-2 list-disc space-y-1 pl-5">
                      <For each={problems()}>{(problem) => <li>{problem.message}</li>}</For>
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
