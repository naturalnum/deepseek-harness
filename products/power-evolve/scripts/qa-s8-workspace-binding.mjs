/** QA-only V27 storage evidence; requires built application libraries, a local trial POSIX mount and serial single-writer use. */
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { SafePosix } from '../application/lib/platform/safe-posix.js'
import { storageBinding } from '../application/lib/platform/workspace-binding-types.js'

/**
 * Inspect or prepare QA files under the owner's current ready binding while recovery and new dispatch wait.
 * @param {object} db - Connected, idle PostgreSQL client used serially by this driver.
 * @param {string} root - Absolute, locally mounted managed storage root from this trial's private configuration.
 * @param {object} selection - Username, Session and Workspace IDs; optional expectedBinding and succeeded executionId.
 * @param {Function} inspect - Short local filesystem callback; never submit commands or wait for Platform work here.
 * @returns {Promise<object>} Current binding and callback value; missing bindings, active commands and retired execution snapshots reject without legacy fallback.
 */
export async function withEvidenceWorkspace(db, root, selection, inspect) {
  assert(isAbsolute(root), 'QA storage root must be an absolute local POSIX path')
  await db.query('BEGIN')
  try {
    const versions = (await db.query('SELECT version FROM pe_schema')).rows
    assert(versions.length === 1 && versions[0].version === 27, 'QA binding evidence requires schema 27')
    const owner = (await db.query(`SELECT id FROM pe_users WHERE username=$1 AND enabled
      AND deleted_at IS NULL FOR SHARE`, [selection.username])).rows[0]
    assert(owner, 'QA binding evidence requires an active owner')
    const workspace = (await db.query(`SELECT w.id,w.binding_generation,w.binding_state
      FROM pe_sessions session JOIN pe_workspaces w ON w.id=session.workspace_id AND w.user_id=session.user_id
      WHERE session.id=$1 AND session.user_id=$2 AND w.id=$3 FOR SHARE OF w`,
    [selection.sessionId, owner.id, selection.workspaceId])).rows[0]
    assert(workspace?.binding_state === 'ready', 'QA Session must own a ready Workspace binding')
    const location = (await db.query(`SELECT b.space_id,b.root_relative_path,s.root_key,s.root_state
      FROM pe_workspace_bindings b JOIN pe_storage_spaces s ON s.id=b.space_id AND s.user_id=b.user_id
      WHERE b.workspace_id=$1 AND b.user_id=$2 FOR SHARE OF b,s`, [workspace.id, owner.id])).rows[0]
    assert(location?.root_state === 'ready', 'QA Workspace must have registered ready storage')
    const binding = storageBinding.parse({ workspaceId: workspace.id, spaceId: location.space_id,
      rootKey: location.root_key, rootRelativePath: location.root_relative_path,
      generation: Number(workspace.binding_generation) })
    if (selection.expectedBinding) assert.deepEqual(binding, storageBinding.parse(selection.expectedBinding),
      'QA binding changed after input preparation')
    if (selection.executionId) {
      const executed = (await db.query(`SELECT i.binding_snapshot FROM pe_cloud_executions e
        JOIN pe_sandbox_instances i ON i.session_id=e.session_id AND i.user_id=e.user_id
        WHERE e.id=$1 AND e.session_id=$2 AND e.user_id=$3 AND e.state='succeeded' AND e.pod_uid IS NOT NULL
          AND ((i.pod_uid=e.pod_uid AND i.runner_instance_id=e.runner_instance_id)
            OR (i.state='deleted' AND i.stop_pod_uid=e.pod_uid))`,
      [selection.executionId, selection.sessionId, owner.id])).rows[0]
      assert(executed, 'QA execution Pod binding snapshot is unavailable or has been replaced')
      assert.deepEqual(binding, storageBinding.parse(executed.binding_snapshot),
        'QA current binding differs from the execution Pod binding')
    }
    const active = await db.query(`SELECT id FROM pe_cloud_executions WHERE session_id=$1 AND user_id=$2
      AND state IN ('queued','starting','running','cancelling','uncertain') LIMIT 1`, [selection.sessionId, owner.id])
    assert.equal(active.rowCount, 0, 'QA storage evidence requires no active or uncertain Session command')
    const safe = new SafePosix(root)
    await safe.init()
    assert(await safe.probeDirectory(binding), 'QA binding directory is missing')
    const value = await inspect(safe.path(binding))
    await db.query('COMMIT')
    return { binding, value }
  } catch (error) {
    try { await db.query('ROLLBACK') }
    catch (_disconnected) { /* Preserve the evidence failure; the owning driver closes the client. */ }
    throw error
  }
}
