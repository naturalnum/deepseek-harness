-- Tenant adapter settings, public catalogs and private provider credentials remain Platform-owned.
CREATE TABLE pe_tenant_model_settings (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  namespace text NOT NULL CHECK(namespace IN ('llm-deepseek','llm-pi-ai')),
  configuration json NOT NULL CHECK(json_typeof(configuration)='object'),
  revision integer NOT NULL CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,namespace)
);
CREATE TABLE pe_tenant_model_catalog (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  provider text NOT NULL CHECK(length(provider)>0),
  model_id text NOT NULL CHECK(length(model_id)>0),
  descriptor json NOT NULL CHECK(json_typeof(descriptor)='object'),
  max_tokens integer NOT NULL CHECK(max_tokens>0),
  PRIMARY KEY(user_id,provider,model_id)
);
CREATE TABLE pe_tenant_model_credentials (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  reference text NOT NULL CHECK(reference ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  version_id uuid NOT NULL,
  sealed bytea NOT NULL CHECK(octet_length(sealed)>=29),
  revision integer NOT NULL CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,reference)
);
CREATE TABLE pe_tenant_model_credential_records (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  provider text NOT NULL CHECK(length(provider)>0),
  version_id uuid NOT NULL,
  sealed bytea NOT NULL CHECK(octet_length(sealed)>=29),
  revision integer NOT NULL CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,provider)
);
CREATE TABLE pe_tenant_model_credential_tickets (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id uuid NOT NULL,
  reference text NOT NULL CHECK(reference ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  size_bytes integer NOT NULL CHECK(size_bytes>0),
  credential_version integer NOT NULL CHECK(credential_version>0),
  token_digest text NOT NULL UNIQUE CHECK(token_digest ~ '^[a-f0-9]{64}$'),
  body_digest text CHECK(body_digest ~ '^[a-f0-9]{64}$'),
  discovery json CHECK(discovery IS NULL OR json_typeof(discovery)='object'),
  result json CHECK(result IS NULL OR json_typeof(result)='object'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY(user_id,request_id)
);
CREATE INDEX pe_tenant_model_ticket_expiry ON pe_tenant_model_credential_tickets(user_id,expires_at) WHERE consumed_at IS NULL;

CREATE TABLE pe_tenant_model_preparations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  provider text NOT NULL,
  model_id text NOT NULL,
  configuration json NOT NULL CHECK(json_typeof(configuration)='array'),
  credential_version integer NOT NULL CHECK(credential_version>0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  operation_id uuid REFERENCES pe_operations(id)
);
CREATE INDEX pe_tenant_model_preparations_pending ON pe_tenant_model_preparations(user_id,expires_at) WHERE consumed_at IS NULL;
