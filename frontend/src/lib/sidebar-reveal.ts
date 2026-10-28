/**
 * "Go up" from a project.
 *
 * A breadcrumb promises that the step above it is somewhere you can get to,
 * but workspaces and folders are not pages in this product — they are groups
 * in the sidebar. Clicking a crumb therefore unfolds that group and goes
 * home, which is the honest equivalent of navigating up: you end on the list
 * with the thing you clicked open.
 *
 * The fold state is the same persisted record the sidebar reads, so this is a
 * write to shared state rather than a second source of truth.
 */

const FOLDED_KEY = 'opsiforce:workspace:folded';
const FOLDER_EXPANDED_KEY = 'opsiforce:folder:expanded';

function patch(key: string, apply: (value: Record<string, boolean>) => void): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(key);
    const value: Record<string, boolean> = raw ? JSON.parse(raw) : {};
    apply(value);
    const next = JSON.stringify(value);
    window.localStorage.setItem(key, next);
    // the sidebar's persisted signals listen for this in the same tab
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: next }));
  } catch {
    // a blocked or unparsable store just means the group keeps its fold state
  }
}

export function revealInSidebar(target: { workspace?: string; folder?: string }): void {
  if (target.workspace) {
    patch(FOLDED_KEY, (folded) => {
      folded[target.workspace as string] = false;
    });
  }
  if (target.folder) {
    patch(FOLDER_EXPANDED_KEY, (expanded) => {
      expanded[target.folder as string] = true;
    });
  }
}
