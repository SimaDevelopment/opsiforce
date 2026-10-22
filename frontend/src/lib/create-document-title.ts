import { createEffect, createRoot, createSignal, onCleanup } from 'solid-js';

type PageTitle = () => string | undefined;

const brandTitleFromIndexHtml: string = import.meta.hot?.data.brandTitleFromIndexHtml ?? document.title;
if (import.meta.hot) import.meta.hot.data.brandTitleFromIndexHtml = brandTitleFromIndexHtml;

const [mountedPageTitles, setMountedPageTitles] = createSignal<PageTitle[]>([]);

function innermostPageTitle(): string | undefined {
  const titles = mountedPageTitles();
  for (let index = titles.length - 1; index >= 0; index--) {
    const title = titles[index]();
    if (title) return title;
  }
  return undefined;
}

createRoot(() => {
  createEffect(() => {
    const title = innermostPageTitle();
    document.title = title ? `${title} · ${brandTitleFromIndexHtml}` : brandTitleFromIndexHtml;
  });
});

export function createDocumentTitle(pageTitle: PageTitle) {
  setMountedPageTitles((titles) => [...titles, pageTitle]);
  onCleanup(() => setMountedPageTitles((titles) => titles.filter((title) => title !== pageTitle)));
}
