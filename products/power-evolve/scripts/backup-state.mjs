/** Read backup file integrity and durable work state without launching a trial. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Inventory sorted file bytes, modes and literal symlink targets without following links.
 * @param directory Stopped source or private backup directory.
 * @returns Entries used by the existing format-1/2 backup integrity checks.
 */
export async function inventoryBackupTree(directory) {
  const entries = []
  async function walk(path, relative) {
    const value = await lstat(path)
    if (value.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name)
    } else if (value.isFile()) {
      entries.push({ path: relative, kind: 'file', size: value.size,
        sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mode: value.mode & 0o7777 })
    } else if (value.isSymbolicLink()) {
      entries.push({ path: relative, kind: 'symlink', target: await readlink(path) })
    } else throw new Error('Unsupported backup file type')
  }
  try {
    await walk(directory, '')
    return entries
  } catch (_inventoryError) { throw new Error('Cannot inspect backup POSIX inventory') }
}

/** Inspect schema 18+ work and package metadata through one read-only PostgreSQL connection.
 * @param Client PostgreSQL Client constructor supplied by the caller.
 * @param url Private PostgreSQL connection URL, excluded from all diagnostics.
 * @returns The trial's schema, active counts, package rows and MCP/SSH history counts.
 */
export async function inspectBackupState(Client, url) {
  let client
  try {
    client = new Client({ connectionString: url, connectionTimeoutMillis: 10000,
      statement_timeout: 5000, query_timeout: 6000, options: '-c default_transaction_read_only=on' })
    await client.connect()
    const query = text => client.query({ text, query_timeout: 6000 })
    const schema = await query('SELECT version FROM pe_schema')
    // Cleaned SSH quarantine stays uncertain; approved actions still need durable finalization and continuation.
    const active = await query(`SELECT
      (SELECT count(*)::integer FROM pe_operations WHERE state IN ('queued','running')) AS operations,
      (SELECT count(*)::integer FROM pe_cloud_executions WHERE state IN ('queued','starting','running','cancelling','uncertain')) AS executions,
      (SELECT count(*)::integer FROM pe_connector_actions WHERE state IN ('approved','dispatching','uncertain')) AS "connectorActions",
      (SELECT count(*)::integer FROM pe_desktop_executions WHERE state IN ('queued','running','cancelling','uncertain')) AS "desktopExecutions",
      (SELECT count(*)::integer FROM pe_stdio_mcp_calls WHERE state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain')) AS stdio,
      (SELECT count(*)::integer FROM pe_ssh_calls c
        WHERE c.state IN ('accepted','preparing','ready','dispatch-intent','running')
          OR (c.state='uncertain' AND (c.cleanup_complete IS NOT TRUE
            OR (c.kind='ssh.execute' AND NOT EXISTS (
              SELECT 1 FROM pe_ssh_execute_actions a WHERE a.id=c.id AND a.user_id=c.user_id
                AND a.operation_id=c.operation_id AND a.connection_id=c.connection_id
                AND a.connection_revision=c.connection_revision AND a.credential_revision=c.credential_revision
                AND a.request_digest=c.request_digest AND a.state='uncertain'))))) AS ssh,
      (SELECT count(*)::integer FROM pe_ssh_execute_actions WHERE state='approved') AS sshActions`)
    const { rows: [ssh] } = await query(`SELECT
      (SELECT count(*) FROM pe_ssh_connections)+(SELECT count(*) FROM pe_ssh_calls)
        +(SELECT count(*) FROM pe_ssh_execute_actions) AS records,
      (SELECT count(*) FROM pe_ssh_calls WHERE state='uncertain' AND cleanup_complete=true) AS quarantined`)
    let mcpRecords = 0
    if (schema.rows[0]?.version >= 22) {
      active.rows[0].mcpChecks = (await query("SELECT count(*)::integer AS n FROM pe_mcp_checks WHERE state IN ('queued','running')")).rows[0].n
      mcpRecords = (await query('SELECT (SELECT count(*) FROM pe_mcp_remote_connections)+(SELECT count(*) FROM pe_mcp_drafts) AS n')).rows[0].n
    }
    if (schema.rows[0]?.version >= 23) {
      // Pending human review needs a fresh decision; terminal MCP uncertainty remains uncertainty after restore.
      active.rows[0].mcpActions = (await query("SELECT count(*)::integer AS n FROM pe_mcp_actions WHERE state IN ('approved','preparing','dispatch-intent')")).rows[0].n
    }
    if (schema.rows[0]?.version >= 27) {
      active.rows[0].workspaceRecoveries = (await query(
        "SELECT count(*)::integer AS n FROM pe_workspace_binding_requests WHERE state IN ('accepted','stopping')")).rows[0].n
      active.rows[0].storageDirectories = (await query(
        "SELECT count(*)::integer AS n FROM pe_storage_directory_requests WHERE state='accepted'")).rows[0].n
    }
    if (schema.rows[0]?.version >= 28) {
      active.rows[0].cloudResolutions = (await query(
        "SELECT count(*)::integer AS n FROM pe_cloud_execution_resolutions WHERE state IN ('accepted','stopping')")).rows[0].n
    }
    if (schema.rows[0]?.version >= 32) {
      active.rows[0].officePreviews = (await query(`SELECT count(*)::integer AS n FROM pe_office_preview_jobs
        WHERE state IN ('queued','creating','running','stopping','blocked') OR parser_slot IS NOT NULL`)).rows[0].n
    }
    const packages = await query('SELECT user_id,archive_digest,manifest_digest,manifest FROM pe_skill_package_versions')
    return { schema: schema.rows[0]?.version, active: active.rows[0], packages: packages.rows,
      mcpRecords: Number(mcpRecords), sshRecords: Number(ssh.records), sshQuarantined: Number(ssh.quarantined) }
  } catch (_stateError) { throw new Error('Cannot inspect backup PostgreSQL state') }
  finally {
    try { await client?.end() }
    catch (_closeError) { /* Preserve the inspection outcome without exposing connection diagnostics. */ }
  }
}

/** Reject a backup until durable work has settled; pending human review remains eligible.
 * @param state Result of inspectBackupState after all source writers have stopped.
 * @returns Completion when schema 18+ has no active work.
 */
export function requireIdleBackupState(state) {
  if (!Number.isInteger(state.schema) || state.schema < 18
    || Object.values(state.active).some(count => count !== 0)) {
    const connector = state.active.connectorActions > 0
      ? '; connector work must settle or reconcile before backup' : ''
    throw new Error(`Backup requires schema 18+ with no active operations, Runner calls, connector/desktop work or MCP discovery/dispatch${connector}`)
  }
}
