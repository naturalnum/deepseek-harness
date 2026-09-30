/** Candidate V22 management tables; the integrator owns migration application/version advancement. */
export const mcpConnectionsSchemaV22 = `
CREATE TABLE pe_mcp_remote_connections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  server_name text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  configuration_revision integer NOT NULL CHECK(configuration_revision>0),
  enabled boolean NOT NULL, deleted_at timestamptz, current_catalog_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id), UNIQUE(user_id,server_name)
);
CREATE TABLE pe_mcp_configuration_versions (
  connection_id uuid NOT NULL, user_id uuid NOT NULL,
  configuration_revision integer NOT NULL CHECK(configuration_revision>0),
  credential_revision integer CHECK(credential_revision>0),
  configuration json NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,user_id,configuration_revision),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id)
);
ALTER TABLE pe_mcp_remote_connections ADD CONSTRAINT pe_mcp_remote_configuration
  FOREIGN KEY(id,user_id,configuration_revision)
  REFERENCES pe_mcp_configuration_versions(connection_id,user_id,configuration_revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE pe_mcp_credential_versions (
  connection_id uuid NOT NULL, user_id uuid NOT NULL,
  configuration_revision integer NOT NULL, credential_revision integer NOT NULL CHECK(credential_revision>0),
  format_version integer NOT NULL CHECK(format_version=1), sealed bytea NOT NULL CHECK(octet_length(sealed)>=29),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,user_id,configuration_revision,credential_revision),
  FOREIGN KEY(connection_id,user_id,configuration_revision)
    REFERENCES pe_mcp_configuration_versions(connection_id,user_id,configuration_revision)
);
CREATE TABLE pe_mcp_management_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('create','update','toggle','delete','draft','check')),
  metadata_digest text NOT NULL CHECK(metadata_digest ~ '^[a-f0-9]{64}$'),
  secret_digest text CHECK(secret_digest ~ '^[a-f0-9]{64}$'), result json,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,request_id)
);
CREATE TABLE pe_mcp_credential_tickets (
  user_id uuid NOT NULL, request_id uuid NOT NULL, token_digest text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK(purpose IN ('create','update','draft')), input json NOT NULL,
  resource_id uuid NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 19 AND 16384),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  PRIMARY KEY(user_id,request_id),
  FOREIGN KEY(user_id,request_id) REFERENCES pe_mcp_management_requests(user_id,request_id)
);
CREATE TABLE pe_mcp_drafts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id), session_id uuid NOT NULL REFERENCES pe_sessions(id),
  source_connection_id uuid, source_revision integer, configuration json NOT NULL,
  configuration_revision integer NOT NULL CHECK(configuration_revision=1),
  credential_revision integer CHECK(credential_revision=1), credential_sealed bytea,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(id,user_id), FOREIGN KEY(source_connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id),
  CHECK((source_connection_id IS NULL)=(source_revision IS NULL)),
  CHECK((credential_revision IS NULL)=(credential_sealed IS NULL))
);
CREATE TABLE pe_mcp_checks (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id), session_id uuid NOT NULL REFERENCES pe_sessions(id),
  connection_id uuid, draft_id uuid, connection_revision integer,
  configuration_revision integer NOT NULL CHECK(configuration_revision>0), credential_revision integer,
  state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled','expired')),
  catalog_id uuid, discovered_tools integer CHECK(discovered_tools>=0), error_code text,
  cancel_requested boolean NOT NULL DEFAULT false, lease_owner uuid,
  lease_epoch integer NOT NULL DEFAULT 0, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(id,user_id), FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id),
  FOREIGN KEY(draft_id,user_id) REFERENCES pe_mcp_drafts(id,user_id),
  CHECK((connection_id IS NOT NULL)<>(draft_id IS NOT NULL)),
  CHECK((connection_id IS NULL)=(connection_revision IS NULL))
);
CREATE INDEX pe_mcp_checks_work ON pe_mcp_checks(created_at,id) WHERE state IN ('queued','running');
CREATE TABLE pe_mcp_catalog_versions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id), connection_id uuid, draft_id uuid,
  configuration_revision integer NOT NULL CHECK(configuration_revision>0), credential_revision integer,
  catalog_digest text NOT NULL CHECK(catalog_digest ~ '^[a-f0-9]{64}$'), tools json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id),
  FOREIGN KEY(draft_id,user_id) REFERENCES pe_mcp_drafts(id,user_id),
  CHECK((connection_id IS NOT NULL)<>(draft_id IS NOT NULL))
);
CREATE UNIQUE INDEX pe_mcp_catalog_connection_digest
  ON pe_mcp_catalog_versions(connection_id,configuration_revision,COALESCE(credential_revision,0),catalog_digest)
  WHERE connection_id IS NOT NULL;
CREATE UNIQUE INDEX pe_mcp_catalog_draft_digest
  ON pe_mcp_catalog_versions(draft_id,COALESCE(credential_revision,0),catalog_digest) WHERE draft_id IS NOT NULL;
ALTER TABLE pe_mcp_remote_connections ADD CONSTRAINT pe_mcp_remote_catalog
  FOREIGN KEY(current_catalog_id,user_id) REFERENCES pe_mcp_catalog_versions(id,user_id);
ALTER TABLE pe_mcp_checks ADD CONSTRAINT pe_mcp_check_catalog
  FOREIGN KEY(catalog_id,user_id) REFERENCES pe_mcp_catalog_versions(id,user_id);
CREATE FUNCTION pe_mcp_reject_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MCP snapshots are immutable'; END; $$;
CREATE TRIGGER pe_mcp_configuration_immutable BEFORE UPDATE OR DELETE ON pe_mcp_configuration_versions
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();
CREATE TRIGGER pe_mcp_credential_immutable BEFORE UPDATE OR DELETE ON pe_mcp_credential_versions
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();
CREATE TRIGGER pe_mcp_draft_immutable BEFORE UPDATE ON pe_mcp_drafts
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();
CREATE TRIGGER pe_mcp_catalog_immutable BEFORE UPDATE ON pe_mcp_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();
`
