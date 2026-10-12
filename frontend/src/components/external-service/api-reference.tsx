import { Show, createMemo, type JSX } from 'solid-js';
import { ApiError } from '~/api/client';
import { useServiceOpenApi } from '~/api/external-service-publishing';
import type { ExternalServiceOrigin } from '~/api/external-service-views';
import { ExternalLink } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';

const SCALAR_BUNDLE_URL = '/api/v1/docs/js/scalar.js';

type OpenApiDocument = Record<string, unknown> & { servers?: { url: string }[] };

function withAbsoluteServers(document: OpenApiDocument): OpenApiDocument {
  return {
    ...document,
    servers: document.servers?.map((server) => ({ ...server, url: new URL(server.url, window.location.origin).href })),
  };
}

function scalarPage(document: OpenApiDocument, title: string): string {
  const configuration = JSON.stringify({
    content: withAbsoluteServers(document),
    hideClientButton: true,
    hideTestRequestButton: true,
    hideDarkModeToggle: true,
    forceDarkModeState: 'light',
    withDefaultFonts: false,
  }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title.replace(/[<&>]/g, '')}</title></head><body><div id="app"></div><script src="${new URL(SCALAR_BUNDLE_URL, window.location.origin).href}"></script><script>Scalar.createApiReference('#app', ${configuration});</script></body></html>`;
}

function openInNewTab(page: string): void {
  const url = URL.createObjectURL(new Blob([page], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ServiceApiReference(props: {
  serviceId: string;
  origin: ExternalServiceOrigin;
  displayName: string;
  asOperator: boolean;
  children?: JSX.Element;
}) {
  const document = useServiceOpenApi(
    () => props.origin,
    () => props.serviceId,
    () => props.asOperator
  );
  const page = createMemo(() => (document.data ? scalarPage(document.data, `${props.displayName} API`) : null));
  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">{props.children}</div>
        <Show when={page()}>
          {(ready) => (
            <Button size="sm" variant="outline" class="shrink-0" onClick={() => openInNewTab(ready())}>
              <ExternalLink class="h-3.5 w-3.5" aria-hidden="true" />
              Open in new tab
            </Button>
          )}
        </Show>
      </div>
      <Show
        when={page()}
        fallback={
          <Show
            when={document.isError}
            fallback={
              <div class="flex justify-center py-10">
                <Spinner />
              </div>
            }
          >
            <p class="text-xs text-muted-foreground" role="alert">
              {document.error instanceof ApiError ? document.error.message : "The service's API could not be read."}
            </p>
          </Show>
        }
      >
        {(ready) => (
          <iframe
            title={`${props.displayName} API reference`}
            class="h-[75vh] w-full rounded-xl border border-border bg-background"
            srcdoc={ready()}
          />
        )}
      </Show>
    </div>
  );
}
