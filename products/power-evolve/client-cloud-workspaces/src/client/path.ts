/** Native creation carries an explicit retry identity and an optional private directory selection. */
import { workspaceCreateSelection, type WorkspaceCreateSelection } from '@power-evolve/contracts/workspace-binding'

/** Encode a creation selection for the native Workspace Controller.
 * @param selection - creation input with an owner-scoped stable request identity.
 * @returns an opaque transport value; it never names a physical filesystem path.
 */
export function cloudWorkspaceSelectionPath(selection: WorkspaceCreateSelection): string {
  return `power-evolve-cloud-selection:${encodeURIComponent(JSON.stringify(workspaceCreateSelection.parse(selection)))}`
}
