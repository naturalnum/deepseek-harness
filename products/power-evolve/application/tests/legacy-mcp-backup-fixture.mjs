/** Historical database rows for migration/backup tests; current runtime APIs require V25 authority. */
import { randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { transaction } from '../lib/platform/database.js'
import { McpCredentialCipher } from '../lib/platform/mcp-credentials.js'
import { mcpCatalogDigest, mcpCatalogTools } from '../lib/platform/mcp-catalog.js'

/** Seed an empty native Session using the columns present in V21. */
export async function seedV21Session(pool, owner) {
  const sessionId = randomUUID(), workspaceId = randomUUID()
  await transaction(pool, async client => {
    await client.query("INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Workspace',true)",
      [workspaceId, owner.userId])
    await client.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header)
      VALUES($1,$2,$3,$4,$5)`, [sessionId, owner.userId, workspaceId, randomUUID(),
      { id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }])
  })
  return { sessionId }
}

/** Seed the original V22 configuration, encrypted credential, directory and completed check. */
export async function seedV22Mcp(pool, owner, sessionId, key, bearerToken, rawTools) {
  const connectionId = randomUUID(), catalogId = randomUUID(), checkId = randomUUID()
  const configuration = { displayName: 'MCP storage fixture', serverUrl: 'https://fixture.example.test/mcp',
    serverName: `c_${connectionId.replaceAll('-', '')}`, authentication: 'bearer', headerNames: [], secretConfigured: true }
  const tools = mcpCatalogTools(connectionId, rawTools)
  const sealed = new McpCredentialCipher(key).seal({ kind: 'connection', userId: owner.userId,
    resourceId: connectionId, configurationRevision: 1, credentialRevision: 1 }, { formatVersion: 1, bearerToken })
  await transaction(pool, async client => {
    await client.query(`INSERT INTO pe_mcp_remote_connections(id,user_id,server_name,revision,configuration_revision,enabled)
      VALUES($1,$2,$3,1,1,true)`, [connectionId, owner.userId, configuration.serverName])
    await client.query(`INSERT INTO pe_mcp_configuration_versions(connection_id,user_id,configuration_revision,
      credential_revision,configuration) VALUES($1,$2,1,1,$3::json)`, [connectionId, owner.userId, JSON.stringify(configuration)])
    await client.query(`INSERT INTO pe_mcp_credential_versions(connection_id,user_id,configuration_revision,
      credential_revision,format_version,sealed) VALUES($1,$2,1,1,1,$3)`, [connectionId, owner.userId, sealed])
    await client.query(`INSERT INTO pe_mcp_catalog_versions(id,user_id,connection_id,configuration_revision,
      credential_revision,catalog_digest,tools) VALUES($1,$2,$3,1,1,$4,$5::json)`,
      [catalogId, owner.userId, connectionId, mcpCatalogDigest(rawTools), JSON.stringify(tools)])
    await client.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1', [connectionId, catalogId])
    await client.query(`INSERT INTO pe_mcp_checks(id,user_id,session_id,connection_id,connection_revision,
      configuration_revision,credential_revision,state,catalog_id,discovered_tools,expires_at)
      VALUES($1,$2,$3,$4,1,1,1,'succeeded',$5,$6,now()+interval '1 hour')`,
      [checkId, owner.userId, sessionId, connectionId, catalogId, tools.length])
  })
  return { checkId, catalogId, connectionId }
}
