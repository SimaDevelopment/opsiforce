import { updatePersisted } from './persisted-signal';

/**
 * "Go up" from a project.
 *
 * A breadcrumb promises that the step above it is somewhere you can get to,
 * but workspaces and folders are not pages in this product — they are groups
 * in the sidebar. Clicking a crumb therefore unfolds that group where the
 * sidebar shows it, and leaves the user on the project they were working in.
 *
 * These keys are the sidebar's own fold state, owned here so the sidebar and
 * the breadcrumb write one record rather than two copies of its name.
 */

export const WORKSPACE_FOLDED_KEY = 'opsiforce:workspace:folded';
export const FOLDER_EXPANDED_KEY = 'opsiforce:folder:expanded';

export function revealInSidebar(target: { workspace?: string; folder?: string }): void {
  const { workspace, folder } = target;
  if (workspace)
    updatePersisted<Record<string, boolean>>(WORKSPACE_FOLDED_KEY, {}, (prev) => ({ ...prev, [workspace]: false }));
  if (folder)
    updatePersisted<Record<string, boolean>>(FOLDER_EXPANDED_KEY, {}, (prev) => ({ ...prev, [folder]: true }));

  const group = folder ?? workspace;
  if (!group || typeof document === 'undefined') return;
  // after the unfold has rendered, bring the group into view in the sidebar
  requestAnimationFrame(() =>
    document.querySelector(`[data-sidebar-group="${CSS.escape(group)}"]`)?.scrollIntoView({ block: 'nearest' })
  );
}
