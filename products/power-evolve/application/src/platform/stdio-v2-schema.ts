/** Adjacent generic STDIO migration; old command facts and digests retain their original values. */

const executionTables = [['pe_cloud_executions', 'cloud'], ['pe_desktop_executions', 'desktop']] as const
const executionColumns = executionTables.map(([table, target]) => `
ALTER TABLE ${table} ADD COLUMN execution_kind text NOT NULL DEFAULT 'legacy_command'
  CHECK (execution_kind IN ('legacy_command','stdio_v2'));
ALTER TABLE ${table} ADD COLUMN execution_target text NOT NULL DEFAULT '${target}'
  CHECK (execution_target='${target}');
ALTER TABLE ${table} ADD COLUMN origin_kind text NOT NULL DEFAULT 'operation'
  CHECK (origin_kind IN ('operation','stdio_discovery'));
ALTER TABLE ${table} ADD COLUMN task_version integer;
ALTER TABLE ${table} ADD COLUMN stdio_phase text;
ALTER TABLE ${table} ADD COLUMN stdio_task json;
ALTER TABLE ${table} ADD COLUMN stdio_action_id uuid;
ALTER TABLE ${table} ALTER COLUMN operation_id DROP NOT NULL;
ALTER TABLE ${table} ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE ${table} ALTER COLUMN command DROP NOT NULL;
ALTER TABLE ${table} ALTER COLUMN cwd DROP NOT NULL;
ALTER TABLE ${table} ALTER COLUMN continuation_request_id DROP NOT NULL;
ALTER TABLE ${table} ADD CONSTRAINT ${table}_task_branch CHECK (
  (execution_kind='legacy_command' AND origin_kind='operation'
    AND task_version IS NULL AND stdio_phase IS NULL AND stdio_task IS NULL AND stdio_action_id IS NULL
    AND operation_id IS NOT NULL AND call_id IS NOT NULL AND command IS NOT NULL AND cwd IS NOT NULL
    AND continuation_request_id IS NOT NULL)
  OR (execution_kind='stdio_v2' AND task_version IS NOT NULL AND task_version=2
    AND stdio_phase IS NOT NULL AND stdio_phase='discover' AND origin_kind='stdio_discovery'
    AND stdio_task IS NOT NULL AND (json_typeof(stdio_task)='object') IS TRUE AND stdio_action_id IS NOT NULL
    AND operation_id IS NULL AND call_id IS NULL AND command IS NULL AND cwd IS NULL
    AND continuation_request_id IS NULL)
  OR (execution_kind='stdio_v2' AND task_version IS NOT NULL AND task_version=2
    AND stdio_phase IS NOT NULL AND stdio_phase='call' AND origin_kind='operation'
    AND stdio_task IS NOT NULL AND (json_typeof(stdio_task)='object') IS TRUE AND stdio_action_id IS NOT NULL
    AND operation_id IS NOT NULL AND call_id IS NOT NULL AND command IS NULL AND cwd IS NULL
    AND continuation_request_id IS NOT NULL));
ALTER TABLE ${table} ADD CONSTRAINT ${table}_stdio_identity
  UNIQUE(id,user_id,session_id,stdio_phase,stdio_action_id);
ALTER TABLE ${table} ADD CONSTRAINT ${table}_stdio_action_unique UNIQUE(stdio_action_id);
`).join('\n')

const executionReferences = executionTables.map(([table, target]) => `
ALTER TABLE ${table} ADD CONSTRAINT ${table}_stdio_action
  FOREIGN KEY(stdio_action_id,user_id,session_id,stdio_phase,execution_target,id,request_digest)
  REFERENCES pe_stdio_v2_actions(id,user_id,session_id,phase,execution_target,execution_id,task_digest)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pe_stdio_v2_actions ADD CONSTRAINT pe_stdio_v2_actions_${target}_execution
  FOREIGN KEY(${target}_execution_id,user_id,session_id,phase,id)
  REFERENCES ${table}(id,user_id,session_id,stdio_phase,stdio_action_id)
  DEFERRABLE INITIALLY DEFERRED;
`).join('\n')

/** Separate raw generic tasks, preparations, human decisions and once permits with exact owner bindings. */
export const schemaV34 = `
${executionColumns}
ALTER TABLE pe_sessions ADD CONSTRAINT pe_sessions_stdio_owner UNIQUE(id,user_id);
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_session UNIQUE(id,session_id);
ALTER TABLE pe_devices ADD CONSTRAINT pe_devices_stdio_owner UNIQUE(id,user_id);
ALTER TABLE pe_device_directories ADD CONSTRAINT pe_device_directories_stdio_owner UNIQUE(id,device_id,user_id);
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_owned_device
  FOREIGN KEY(device_id,user_id) REFERENCES pe_devices(id,user_id);
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_owned_directory
  FOREIGN KEY(directory_id,device_id,user_id) REFERENCES pe_device_directories(id,device_id,user_id);

CREATE TABLE pe_stdio_v2_connections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  revision integer NOT NULL CHECK (revision>0), enabled boolean NOT NULL DEFAULT false,
  current_catalog_id uuid, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id), CHECK (deleted_at IS NULL OR NOT enabled)
);
CREATE TABLE pe_stdio_v2_configurations (
  connection_id uuid NOT NULL, user_id uuid NOT NULL, revision integer NOT NULL CHECK (revision>0),
  configuration json NOT NULL CHECK ((json_typeof(configuration)='object') IS TRUE),
  config_digest text NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,revision),
  UNIQUE(connection_id,user_id,revision,config_digest), UNIQUE(connection_id,user_id,revision),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_stdio_v2_connections(id,user_id)
);
ALTER TABLE pe_stdio_v2_connections ADD CONSTRAINT pe_stdio_v2_connections_current_config
  FOREIGN KEY(id,user_id,revision) REFERENCES pe_stdio_v2_configurations(connection_id,user_id,revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE pe_stdio_v2_management_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('create','update','toggle','delete','check')),
  request json NOT NULL, request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  receipt json NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,request_id)
);
CREATE TABLE pe_stdio_v2_actions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid NOT NULL,
  connection_id uuid NOT NULL, config_revision integer NOT NULL, config_digest text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('discover','call')),
  execution_target text NOT NULL CHECK (execution_target IN ('cloud','desktop')),
  execution_id uuid NOT NULL UNIQUE,
  cloud_execution_id uuid GENERATED ALWAYS AS
    (CASE WHEN execution_target='cloud' THEN execution_id END) STORED,
  desktop_execution_id uuid GENERATED ALWAYS AS
    (CASE WHEN execution_target='desktop' THEN execution_id END) STORED,
  request_id uuid, operation_id uuid, root_operation_id uuid, call_id text,
  task json NOT NULL CHECK ((json_typeof(task)='object') IS TRUE),
  task_digest text NOT NULL CHECK (task_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('queued','preparing','pending','approved','dispatch-intent',
    'running','stopping','blocked','succeeded','failed','cancelled','rejected','expired')),
  cancel_requested boolean NOT NULL DEFAULT false, error_code text,
  lease_owner uuid, lease_until timestamptz, lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  continuation_request_id uuid UNIQUE, continuation_queued boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,call_id), UNIQUE(user_id,request_id), UNIQUE(id,session_id,phase),
  UNIQUE(id,session_id,phase,continuation_request_id),
  UNIQUE(id,user_id,session_id,connection_id,config_revision,config_digest,phase),
  UNIQUE(id,user_id,session_id,phase,execution_target,execution_id,task_digest),
  FOREIGN KEY(session_id,user_id) REFERENCES pe_sessions(id,user_id),
  FOREIGN KEY(connection_id,user_id,config_revision,config_digest)
    REFERENCES pe_stdio_v2_configurations(connection_id,user_id,revision,config_digest),
  FOREIGN KEY(user_id,request_id) REFERENCES pe_stdio_v2_management_requests(user_id,request_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(operation_id,session_id) REFERENCES pe_operations(id,session_id),
  FOREIGN KEY(root_operation_id,session_id) REFERENCES pe_operations(id,session_id),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK ((phase='discover' AND request_id IS NOT NULL AND operation_id IS NULL AND root_operation_id IS NULL
      AND call_id IS NULL AND continuation_request_id IS NULL AND NOT continuation_queued)
    OR (phase='call' AND request_id IS NULL AND operation_id IS NOT NULL AND root_operation_id IS NOT NULL
      AND call_id IS NOT NULL AND continuation_request_id IS NOT NULL))
);
${executionReferences}
CREATE INDEX pe_stdio_v2_actions_pending ON pe_stdio_v2_actions(created_at,id)
  WHERE state IN ('queued','preparing','approved','dispatch-intent','running','stopping','blocked');

CREATE TABLE pe_stdio_v2_preparations (
  action_id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid NOT NULL,
  phase text NOT NULL, execution_target text NOT NULL, execution_id uuid NOT NULL UNIQUE,
  task_digest text NOT NULL, prepared json NOT NULL CHECK ((json_typeof(prepared)='object') IS TRUE),
  prepared_digest text NOT NULL CHECK (prepared_digest ~ '^[a-f0-9]{64}$'),
  approval_binding json NOT NULL CHECK ((json_typeof(approval_binding)='object') IS TRUE),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  approval_epoch integer NOT NULL CHECK (approval_epoch=1), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(action_id,user_id,fingerprint),
  UNIQUE(action_id,execution_id,task_digest,prepared_digest,fingerprint,expires_at),
  FOREIGN KEY(action_id,user_id,session_id,phase,execution_target,execution_id,task_digest)
    REFERENCES pe_stdio_v2_actions(id,user_id,session_id,phase,execution_target,execution_id,task_digest)
);
CREATE TABLE pe_stdio_v2_decisions (
  action_id uuid PRIMARY KEY, user_id uuid NOT NULL, fingerprint text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('once','reject')), decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(action_id,decision), FOREIGN KEY(action_id,user_id,fingerprint)
    REFERENCES pe_stdio_v2_preparations(action_id,user_id,fingerprint)
);
CREATE TABLE pe_stdio_v2_start_permits (
  action_id uuid PRIMARY KEY, permit_id uuid NOT NULL UNIQUE,
  authorization_request_id uuid NOT NULL, execution_id uuid NOT NULL UNIQUE,
  task_digest text NOT NULL, prepared_digest text NOT NULL, fingerprint text NOT NULL,
  decision text NOT NULL CHECK (decision='once'),
  executor_owner json NOT NULL CHECK ((json_typeof(executor_owner)='object') IS TRUE),
  permit json NOT NULL CHECK ((json_typeof(permit)='object') IS TRUE),
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
  FOREIGN KEY(action_id,decision) REFERENCES pe_stdio_v2_decisions(action_id,decision),
  FOREIGN KEY(action_id,execution_id,task_digest,prepared_digest,fingerprint,expires_at)
    REFERENCES pe_stdio_v2_preparations(action_id,execution_id,task_digest,prepared_digest,fingerprint,expires_at)
);
CREATE TABLE pe_stdio_v2_dispatches (
  action_id uuid PRIMARY KEY REFERENCES pe_stdio_v2_start_permits(action_id),
  dispatch json NOT NULL CHECK ((json_typeof(dispatch)='object') IS TRUE),
  dispatch_digest text NOT NULL CHECK (dispatch_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pe_stdio_v2_results (
  action_id uuid PRIMARY KEY REFERENCES pe_stdio_v2_actions(id),
  result json NOT NULL, result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  observation json NOT NULL CHECK ((json_typeof(observation)='object') IS TRUE),
  stop_evidence json NOT NULL CHECK ((json_typeof(stop_evidence)='object') IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pe_stdio_v2_catalogs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, connection_id uuid NOT NULL,
  config_revision integer NOT NULL, config_digest text NOT NULL,
  action_id uuid NOT NULL UNIQUE, session_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase='discover'),
  raw_catalog json NOT NULL CHECK ((json_typeof(raw_catalog)='array') IS TRUE),
  image_expectation json NOT NULL CHECK ((json_typeof(image_expectation)='object') IS TRUE),
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id,connection_id,config_revision),
  FOREIGN KEY(connection_id,user_id,config_revision,config_digest)
    REFERENCES pe_stdio_v2_configurations(connection_id,user_id,revision,config_digest),
  FOREIGN KEY(action_id,user_id,session_id,connection_id,config_revision,config_digest,phase)
    REFERENCES pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase),
  FOREIGN KEY(action_id) REFERENCES pe_stdio_v2_results(action_id)
);
ALTER TABLE pe_stdio_v2_connections ADD CONSTRAINT pe_stdio_v2_connections_current_catalog
  FOREIGN KEY(current_catalog_id,user_id,id,revision)
    REFERENCES pe_stdio_v2_catalogs(id,user_id,connection_id,config_revision);

CREATE FUNCTION pe_stdio_v2_keep_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'STDIO original record cannot be replaced' USING ERRCODE='23514';
END;
$$;
${['configurations', 'management_requests', 'preparations', 'decisions', 'start_permits', 'dispatches', 'results', 'catalogs']
  .map(name => `CREATE TRIGGER pe_stdio_v2_${name}_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_${name}
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();`).join('\n')}
CREATE FUNCTION pe_stdio_v2_keep_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.user_id,NEW.session_id,NEW.connection_id,NEW.config_revision,NEW.config_digest,NEW.phase,
    NEW.execution_target,NEW.execution_id,NEW.request_id,NEW.operation_id,NEW.root_operation_id,NEW.call_id,
    NEW.task::text,NEW.task_digest,NEW.continuation_request_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.session_id,OLD.connection_id,OLD.config_revision,OLD.config_digest,
    OLD.phase,OLD.execution_target,OLD.execution_id,OLD.request_id,OLD.operation_id,OLD.root_operation_id,OLD.call_id,
    OLD.task::text,OLD.task_digest,OLD.continuation_request_id) THEN
    RAISE EXCEPTION 'STDIO accepted task cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_stdio_v2_actions_original BEFORE UPDATE ON pe_stdio_v2_actions
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_task();

CREATE FUNCTION pe_stdio_v2_keep_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_kind IS DISTINCT FROM OLD.execution_kind
    OR (OLD.execution_kind='stdio_v2' AND ROW(NEW.id,NEW.user_id,NEW.session_id,NEW.operation_id,NEW.call_id,
      NEW.execution_target,NEW.origin_kind,NEW.task_version,NEW.stdio_phase,NEW.stdio_task::text,
      NEW.stdio_action_id,NEW.request_digest,NEW.continuation_request_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.session_id,OLD.operation_id,OLD.call_id,
      OLD.execution_target,OLD.origin_kind,OLD.task_version,OLD.stdio_phase,OLD.stdio_task::text,
      OLD.stdio_action_id,OLD.request_digest,OLD.continuation_request_id)) THEN
    RAISE EXCEPTION 'STDIO original execution cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION pe_stdio_v2_match_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected pe_stdio_v2_actions%ROWTYPE;
BEGIN
  IF NEW.execution_kind='stdio_v2' THEN
    SELECT * INTO expected FROM pe_stdio_v2_actions WHERE id=NEW.stdio_action_id;
    IF NOT FOUND OR ROW(NEW.stdio_task::text,NEW.operation_id,NEW.call_id,NEW.continuation_request_id)
      IS DISTINCT FROM ROW(expected.task::text,expected.operation_id,expected.call_id,expected.continuation_request_id) THEN
      RAISE EXCEPTION 'STDIO execution does not match original action' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
${executionTables.map(([table]) => `CREATE TRIGGER ${table}_stdio_original BEFORE UPDATE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_execution();
CREATE CONSTRAINT TRIGGER ${table}_stdio_match AFTER INSERT OR UPDATE ON ${table}
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_match_execution();`).join('\n')}

ALTER TABLE pe_operations ADD COLUMN stdio_v2_selection json NOT NULL DEFAULT '[]'::json;
ALTER TABLE pe_operations ADD COLUMN source_stdio_v2_action_id uuid;
ALTER TABLE pe_operations ADD COLUMN source_stdio_v2_phase text;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_v2_source
  FOREIGN KEY(source_stdio_v2_action_id,session_id,source_stdio_v2_phase,request_id)
    REFERENCES pe_stdio_v2_actions(id,session_id,phase,continuation_request_id);
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_v2_result
  FOREIGN KEY(source_stdio_v2_action_id) REFERENCES pe_stdio_v2_results(action_id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK(source IN ('user','platform_action','sandbox_result','desktop_result','stdio_mcp_result',
    'ssh_execute_result','remote_mcp_result','stdio_v2_result'));
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK(
  (source='user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id)=0
    AND source_stdio_v2_phase IS NULL)
  OR (source<>'user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id)=1
    AND CASE source WHEN 'platform_action' THEN source_action_id
      WHEN 'sandbox_result' THEN source_execution_id WHEN 'desktop_result' THEN source_desktop_execution_id
      WHEN 'stdio_mcp_result' THEN source_stdio_mcp_call_id WHEN 'ssh_execute_result' THEN source_ssh_execute_action_id
      WHEN 'remote_mcp_result' THEN source_mcp_action_id WHEN 'stdio_v2_result' THEN source_stdio_v2_action_id END IS NOT NULL
    AND ((source='stdio_v2_result' AND source_stdio_v2_phase IS NOT NULL AND source_stdio_v2_phase='call')
      OR (source<>'stdio_v2_result' AND source_stdio_v2_phase IS NULL))));
CREATE FUNCTION pe_stdio_v2_keep_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stdio_v2_selection::text IS DISTINCT FROM OLD.stdio_v2_selection::text
    OR (OLD.source_stdio_v2_action_id IS NOT NULL AND ROW(NEW.id,NEW.session_id,NEW.request_id,NEW.source,
      NEW.source_stdio_v2_action_id,NEW.source_stdio_v2_phase)
      IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.request_id,OLD.source,
      OLD.source_stdio_v2_action_id,OLD.source_stdio_v2_phase)) THEN
    RAISE EXCEPTION 'STDIO original operation cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_operations_stdio_original BEFORE UPDATE ON pe_operations
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_operation();
UPDATE pe_schema SET version=34 WHERE version=33;
`
