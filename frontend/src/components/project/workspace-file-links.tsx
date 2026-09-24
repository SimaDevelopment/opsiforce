import { onCleanup, onMount } from 'solid-js';
import { GENERATED_FILES_DIRECTORY, downloadFile } from '~/api/files';
import { fileExtensionOf } from '~/lib/file-extension';
import { fileNameOf, isPreviewableFile } from './preview/file-preview-format';

const WORKSPACE_PREFIX = '/workspace/';
const CARD_ATTRIBUTE = 'data-workspace-file-card';
const DOWNLOAD_ATTRIBUTE = 'data-workspace-file-download';
const DOWNLOAD_ICON_PATHS = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'];

export interface WorkspaceFileLinksProps {
  projectId: string;
  environmentId: string;
  host: () => HTMLElement;
  onPreviewFile: (path: string) => void;
}

export function WorkspaceFileLinks(props: WorkspaceFileLinksProps) {
  let decorationFrame = 0;

  const download = (relativePath: string) =>
    downloadFile(props.projectId, props.environmentId, {
      name: fileNameOf(relativePath),
      path: relativePath,
    });

  const handleClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!anchor) return;

    const relativePath = workspacePathOf(anchor);
    if (!relativePath) return;

    event.preventDefault();
    event.stopPropagation();

    if (target.closest(`[${DOWNLOAD_ATTRIBUTE}]`) || !isPreviewableFile(fileNameOf(relativePath))) {
      download(relativePath);
      return;
    }
    props.onPreviewFile(relativePath);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest(`[${DOWNLOAD_ATTRIBUTE}]`);
    if (!action) return;

    const anchor = action.closest('a');
    const relativePath = anchor ? workspacePathOf(anchor) : null;
    if (!relativePath) return;

    event.preventDefault();
    event.stopPropagation();
    download(relativePath);
  };

  const observer = new MutationObserver(() => {
    if (decorationFrame) return;
    decorationFrame = requestAnimationFrame(() => {
      decorationFrame = 0;
      decorateGeneratedFileLinks(props.host());
    });
  });

  onMount(() => {
    const host = props.host();
    host.addEventListener('click', handleClick, true);
    host.addEventListener('keydown', handleKeyDown, true);
    observer.observe(host, { childList: true, subtree: true });
    decorateGeneratedFileLinks(host);

    onCleanup(() => {
      host.removeEventListener('click', handleClick, true);
      host.removeEventListener('keydown', handleKeyDown, true);
      observer.disconnect();
      if (decorationFrame) cancelAnimationFrame(decorationFrame);
    });
  });

  return null;
}

function workspacePathOf(anchor: Element): string | null {
  const href = anchor.getAttribute('href');
  if (!href) return null;

  let pathname: string;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    pathname = url.pathname;
  } catch {
    return null;
  }

  if (!pathname.startsWith(WORKSPACE_PREFIX)) return null;
  try {
    return decodeURIComponent(pathname.slice(WORKSPACE_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

function decorateGeneratedFileLinks(host: HTMLElement): void {
  for (const anchor of host.querySelectorAll(`a[href*="${WORKSPACE_PREFIX}"]`)) {
    const relativePath = workspacePathOf(anchor);
    if (!relativePath || !relativePath.startsWith(`${GENERATED_FILES_DIRECTORY}/`)) continue;
    decorateFileCard(anchor, relativePath);
  }
}

function decorateFileCard(anchor: Element, relativePath: string): void {
  const name = fileNameOf(relativePath);
  anchor.setAttribute(CARD_ATTRIBUTE, '');
  anchor.setAttribute('data-file-type', fileExtensionOf(name).slice(0, 4) || 'file');
  if (anchor.querySelector(`[${DOWNLOAD_ATTRIBUTE}]`)) return;
  anchor.appendChild(createDownloadAction(name));
}

function createDownloadAction(name: string): HTMLElement {
  const action = document.createElement('span');
  action.setAttribute(DOWNLOAD_ATTRIBUTE, '');
  action.setAttribute('role', 'button');
  action.setAttribute('tabindex', '0');
  action.setAttribute('aria-label', `Download ${name}`);
  action.title = 'Download';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const definition of DOWNLOAD_ICON_PATHS) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.appendChild(path);
  }
  action.appendChild(svg);
  return action;
}
