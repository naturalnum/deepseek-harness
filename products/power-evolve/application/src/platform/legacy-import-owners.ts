/** Required pure subsystem owners for every retained Schema 37 target table. */
import { LegacyImportError } from './legacy-import-codec.ts'
import type { LegacyImportOwners, LegacyOwnerContext } from './legacy-import-preflight.ts'

/** Fixed subsystem membership; adjacent native projection/input tables have no source rows. */
export const LEGACY_IMPORT_OWNER_TABLES = Object.freeze({
  'schema-cut': Object.freeze(['pe_schema']),
  'identity-account-global': Object.freeze(['pe_account_audit', 'pe_account_bootstrap', 'pe_account_mutations', 'pe_credentials', 'pe_login_attempt_windows', 'pe_login_global_window', 'pe_platform_admission_policy', 'pe_plugin_mutations', 'pe_settings_mutations', 'pe_user_models', 'pe_user_plugins', 'pe_users']),
  'sessions-history-operation': Object.freeze(['pe_attempts', 'pe_events', 'pe_operations', 'pe_sessions']),
  'files-skills-office': Object.freeze(['pe_builtin_skill_install_requests', 'pe_file_uploads', 'pe_office_preview_jobs', 'pe_skill_package_versions', 'pe_skill_upload_intents', 'pe_storage_spaces', 'pe_user_skills', 'pe_workspace_bindings', 'pe_workspaces']),
  'execution-stop-connector': Object.freeze(['pe_cloud_execution_resolutions', 'pe_cloud_executions', 'pe_connector_actions', 'pe_connector_permissions', 'pe_mount_slots', 'pe_sandbox_instances']),
  'remote-mcp': Object.freeze(['pe_mcp_action_chains', 'pe_mcp_actions', 'pe_mcp_catalog_versions', 'pe_mcp_checks', 'pe_mcp_configuration_versions', 'pe_mcp_connections', 'pe_mcp_credential_tickets', 'pe_mcp_credential_versions', 'pe_mcp_drafts', 'pe_mcp_management_requests', 'pe_mcp_permissions', 'pe_mcp_remote_connections', 'pe_mcp_updates']),
  'ssh': Object.freeze(['pe_ssh_calls', 'pe_ssh_configuration_versions', 'pe_ssh_connections', 'pe_ssh_credential_versions', 'pe_ssh_execute_actions', 'pe_ssh_management_requests', 'pe_ssh_updates', 'pe_ssh_upload_intents']),
  'stdio': Object.freeze(['pe_stdio_mcp_calls', 'pe_stdio_mcp_connections', 'pe_stdio_mcp_updates', 'pe_stdio_v2_actions', 'pe_stdio_v2_catalogs', 'pe_stdio_v2_configurations', 'pe_stdio_v2_connections', 'pe_stdio_v2_decisions', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_management_requests', 'pe_stdio_v2_no_start_closures', 'pe_stdio_v2_observations', 'pe_stdio_v2_preparations', 'pe_stdio_v2_results', 'pe_stdio_v2_start_permits']),
} as const)

/** One trusted subsystem owning row semantics and typed JSON identity declarations. */
export interface LegacyRowOwner {
  readonly validateRow: LegacyImportOwners['validateRow']
  readonly references: LegacyImportOwners['references']
}

/** Explicit row providers and independent export/stop/file evidence validators. */
export interface LegacyImportOwnerBindings {
  readonly rows: Readonly<Partial<Record<string, LegacyRowOwner>>>
  readonly verifyCut: LegacyImportOwners['verifyCut']
  readonly verifyStopped: LegacyImportOwners['verifyStopped']
  readonly verifyFiles: LegacyImportOwners['verifyFiles']
}

/** Resolve all retained table owners before parsing any candidate packet.
 * @param bindings Explicit pure providers for every retained table and independent evidence.
 * @returns Frozen dispatch; missing or extra providers reject rather than granting a default validator.
 */
export function createLegacyImportOwners(bindings: LegacyImportOwnerBindings): LegacyImportOwners {
  const tables = Object.values(LEGACY_IMPORT_OWNER_TABLES).flat()
  const rows = new Map<string, LegacyRowOwner>()
  if (Object.keys(bindings.rows).length !== tables.length
    || Object.keys(bindings.rows).some(table => !tables.some(item => item === table))) {
    throw new LegacyImportError('row_owner_inventory')
  }
  for (const table of tables) {
    const owner = bindings.rows[table]
    if (!owner || typeof owner.validateRow !== 'function' || typeof owner.references !== 'function') {
      throw new LegacyImportError('row_owner_missing', table)
    }
    rows.set(table, Object.freeze({ validateRow: owner.validateRow, references: owner.references }))
  }
  const rowOwner = (context: LegacyOwnerContext): LegacyRowOwner => {
    const owner = rows.get(context.row.table)
    if (!owner) throw new LegacyImportError('row_owner_missing', context.row.table)
    return owner
  }
  return Object.freeze({ verifyCut: bindings.verifyCut, verifyStopped: bindings.verifyStopped, verifyFiles: bindings.verifyFiles,
    validateRow: (context: LegacyOwnerContext) => { rowOwner(context).validateRow(context) },
    references: (context: LegacyOwnerContext) => rowOwner(context).references(context),
  })
}
