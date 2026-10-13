--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14


--
-- Name: pe_account_identity_defaults(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_account_identity_defaults() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.display_name := COALESCE(NEW.display_name,NEW.username);
  RETURN NEW;
END;
$$;


--
-- Name: pe_account_identity_preserved(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_account_identity_preserved() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Account identity requires a tombstone'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'Account identity is immutable';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Account tombstone is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: pe_mcp_reject_version_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_mcp_reject_version_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'MCP snapshots are immutable'; END; $$;


--
-- Name: pe_office_preview_keep_cancelled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_office_preview_keep_cancelled() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.request_digest IS NULL AND (NEW.request_digest IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.generation IS DISTINCT FROM OLD.generation) THEN
    RAISE EXCEPTION 'Office cancellation cannot become an admission' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: pe_session_workspace_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_session_workspace_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'Session Workspace is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: pe_ssh_reject_version_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_ssh_reject_version_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'SSH versions are immutable'; END; $$;


--
-- Name: pe_stdio_v2_exclude_closed_start(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_stdio_v2_exclude_closed_start() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM id FROM pe_stdio_v2_actions WHERE id=NEW.action_id FOR UPDATE;
  IF TG_TABLE_NAME='pe_stdio_v2_no_start_closures' THEN
    IF EXISTS(SELECT 1 FROM pe_stdio_v2_start_permits WHERE action_id=NEW.action_id)
      OR EXISTS(SELECT 1 FROM pe_stdio_v2_results WHERE action_id=NEW.action_id) THEN
      RAISE EXCEPTION 'STDIO start authority conflicts with no-start closure' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM pe_stdio_v2_no_start_closures WHERE action_id=NEW.action_id) THEN
    RAISE EXCEPTION 'STDIO no-start closure excludes start authority and Runner results' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: pe_stdio_v2_keep_execution(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_stdio_v2_keep_execution() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: pe_stdio_v2_keep_no_start_operation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_stdio_v2_keep_no_start_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.source_stdio_v2_no_start_action_id IS DISTINCT FROM OLD.source_stdio_v2_no_start_action_id
    OR (OLD.source_stdio_v2_no_start_action_id IS NOT NULL AND ROW(NEW.id,NEW.session_id,NEW.request_id,
      NEW.source,NEW.source_stdio_v2_phase,NEW.mcp_root_operation_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.request_id,
      OLD.source,OLD.source_stdio_v2_phase,OLD.mcp_root_operation_id)) THEN
    RAISE EXCEPTION 'STDIO no-start operation source cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: pe_stdio_v2_keep_operation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_stdio_v2_keep_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: pe_stdio_v2_keep_original(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_stdio_v2_keep_original() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'STDIO original record cannot be replaced' USING ERRCODE='23514';
END;
$$;


--
-- Name: pe_stdio_v2_keep_task(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_stdio_v2_keep_task() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: pe_stdio_v2_match_execution(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_stdio_v2_match_execution() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: pe_storage_root_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pe_storage_root_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.root_key IS DISTINCT FROM OLD.root_key OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Storage root identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;




--
-- Name: pe_account_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_account_audit (
    id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    kind text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pe_account_audit_kind_check CHECK ((kind = ANY (ARRAY['bootstrap'::text, 'create'::text, 'update'::text, 'delete'::text, 'reset-password'::text, 'change-password'::text]))),
    CONSTRAINT pe_account_audit_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 16384)))
);


--
-- Name: pe_account_bootstrap; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_account_bootstrap (
    singleton boolean NOT NULL,
    user_id uuid NOT NULL,
    username text NOT NULL,
    mode text NOT NULL,
    completed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pe_account_bootstrap_mode_check CHECK ((mode = ANY (ARRAY['create'::text, 'existing'::text]))),
    CONSTRAINT pe_account_bootstrap_singleton_check CHECK (singleton)
);


--
-- Name: pe_account_mutations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_account_mutations (
    actor_user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    kind text NOT NULL,
    target_user_id uuid NOT NULL,
    request_digest text NOT NULL,
    password_verifier text,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pe_account_mutations_check CHECK ((((kind = 'change-password'::text) AND (password_verifier IS NOT NULL)) OR ((kind <> 'change-password'::text) AND (password_verifier IS NULL)))),
    CONSTRAINT pe_account_mutations_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text, 'reset-password'::text, 'change-password'::text]))),
    CONSTRAINT pe_account_mutations_password_verifier_check CHECK ((password_verifier ~ '^[a-f0-9]{32}:[a-f0-9]{128}$'::text)),
    CONSTRAINT pe_account_mutations_receipt_check CHECK (((jsonb_typeof(receipt) = 'object'::text) AND (octet_length((receipt)::text) <= 131072))),
    CONSTRAINT pe_account_mutations_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_attempts (
    operation_id uuid NOT NULL,
    epoch integer NOT NULL,
    worker_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: pe_builtin_skill_install_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_builtin_skill_install_requests (
    request_id uuid NOT NULL,
    user_id uuid NOT NULL,
    catalog_id text NOT NULL,
    version text NOT NULL,
    archive_digest text NOT NULL,
    package_version_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_builtin_skill_install_requests_archive_digest_check CHECK ((archive_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_builtin_skill_install_requests_catalog_id_check CHECK (((length(catalog_id) >= 1) AND (length(catalog_id) <= 128))),
    CONSTRAINT pe_builtin_skill_install_requests_version_check CHECK (((length(version) >= 1) AND (length(version) <= 64)))
);


--
-- Name: pe_cloud_execution_resolutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_cloud_execution_resolutions (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    request_digest text NOT NULL,
    fingerprint text NOT NULL,
    workspace_id uuid NOT NULL,
    mount_generation bigint NOT NULL,
    sandbox_name text NOT NULL,
    pod_uid uuid NOT NULL,
    runner_instance_id uuid NOT NULL,
    binding_snapshot jsonb NOT NULL,
    execution_request_digest text NOT NULL,
    runner_request_digest text,
    note text NOT NULL,
    state text NOT NULL,
    observed_result json,
    stop_evidence jsonb,
    final_execution_state text,
    continuation_request_id uuid NOT NULL,
    continuation_queued boolean DEFAULT false NOT NULL,
    error_code text,
    lease_owner uuid,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_cloud_execution_resolutions_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT pe_cloud_execution_resolutions_binding_snapshot_check CHECK ((jsonb_typeof(binding_snapshot) = 'object'::text)),
    CONSTRAINT pe_cloud_execution_resolutions_check CHECK (((lease_owner IS NULL) = (lease_until IS NULL))),
    CONSTRAINT pe_cloud_execution_resolutions_check1 CHECK (((state <> 'completed'::text) OR ((final_execution_state IS NOT NULL) AND (stop_evidence IS NOT NULL) AND (error_code IS NULL)))),
    CONSTRAINT pe_cloud_execution_resolutions_check2 CHECK (((state = 'completed'::text) OR ((final_execution_state IS NULL) AND (NOT continuation_queued)))),
    CONSTRAINT pe_cloud_execution_resolutions_check3 CHECK (((state = 'blocked'::text) = (error_code IS NOT NULL))),
    CONSTRAINT pe_cloud_execution_resolutions_execution_request_digest_check CHECK ((execution_request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_cloud_execution_resolutions_final_execution_state_check CHECK ((final_execution_state = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text, 'closed_unknown'::text]))),
    CONSTRAINT pe_cloud_execution_resolutions_fingerprint_check CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_cloud_execution_resolutions_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT pe_cloud_execution_resolutions_mount_generation_check CHECK ((mount_generation > 0)),
    CONSTRAINT pe_cloud_execution_resolutions_note_check CHECK ((char_length(note) <= 500)),
    CONSTRAINT pe_cloud_execution_resolutions_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_cloud_execution_resolutions_runner_request_digest_check CHECK ((runner_request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_cloud_execution_resolutions_state_check CHECK ((state = ANY (ARRAY['accepted'::text, 'stopping'::text, 'completed'::text, 'blocked'::text])))
);


--
-- Name: pe_cloud_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_cloud_executions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    operation_id uuid,
    call_id text,
    command text,
    cwd text,
    request_digest text NOT NULL,
    state text NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    result json,
    error_code text,
    sandbox_name text,
    pod_uid uuid,
    runner_instance_id uuid,
    lease_owner uuid,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    continuation_request_id uuid DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatch_request json,
    execution_kind text DEFAULT 'legacy_command'::text NOT NULL,
    execution_target text DEFAULT 'cloud'::text NOT NULL,
    origin_kind text DEFAULT 'operation'::text NOT NULL,
    task_version integer,
    stdio_phase text,
    stdio_task json,
    stdio_action_id uuid,
    CONSTRAINT pe_cloud_executions_execution_kind_check CHECK ((execution_kind = ANY (ARRAY['legacy_command'::text, 'stdio_v2'::text]))),
    CONSTRAINT pe_cloud_executions_execution_target_check CHECK ((execution_target = 'cloud'::text)),
    CONSTRAINT pe_cloud_executions_origin_kind_check CHECK ((origin_kind = ANY (ARRAY['operation'::text, 'stdio_discovery'::text]))),
    CONSTRAINT pe_cloud_executions_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'cancelling'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'uncertain'::text, 'closed_unknown'::text]))),
    CONSTRAINT pe_cloud_executions_task_branch CHECK ((((execution_kind = 'legacy_command'::text) AND (origin_kind = 'operation'::text) AND (task_version IS NULL) AND (stdio_phase IS NULL) AND (stdio_task IS NULL) AND (stdio_action_id IS NULL) AND (operation_id IS NOT NULL) AND (call_id IS NOT NULL) AND (command IS NOT NULL) AND (cwd IS NOT NULL) AND (continuation_request_id IS NOT NULL)) OR ((execution_kind = 'stdio_v2'::text) AND (task_version IS NOT NULL) AND (task_version = 2) AND (stdio_phase IS NOT NULL) AND (stdio_phase = 'discover'::text) AND (origin_kind = 'stdio_discovery'::text) AND (stdio_task IS NOT NULL) AND ((json_typeof(stdio_task) = 'object'::text) IS TRUE) AND (stdio_action_id IS NOT NULL) AND (operation_id IS NULL) AND (call_id IS NULL) AND (command IS NULL) AND (cwd IS NULL) AND (continuation_request_id IS NULL)) OR ((execution_kind = 'stdio_v2'::text) AND (task_version IS NOT NULL) AND (task_version = 2) AND (stdio_phase IS NOT NULL) AND (stdio_phase = 'call'::text) AND (origin_kind = 'operation'::text) AND (stdio_task IS NOT NULL) AND ((json_typeof(stdio_task) = 'object'::text) IS TRUE) AND (stdio_action_id IS NOT NULL) AND (operation_id IS NOT NULL) AND (call_id IS NOT NULL) AND (command IS NULL) AND (cwd IS NULL) AND (continuation_request_id IS NOT NULL))))
);


--
-- Name: pe_connector_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_connector_actions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    call_id text NOT NULL,
    action text NOT NULL,
    request jsonb NOT NULL,
    request_digest text NOT NULL,
    state text NOT NULL,
    result json,
    error_code text,
    decided_at timestamp with time zone,
    lease_owner uuid,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    continuation_request_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT pe_connector_actions_action_check CHECK ((action = 'trial_note_append'::text)),
    CONSTRAINT pe_connector_actions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'rejected'::text, 'approved'::text, 'dispatching'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text])))
);


--
-- Name: pe_connector_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_connector_permissions (
    user_id uuid NOT NULL,
    capability text NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_connector_permissions_capability_check CHECK ((capability = ANY (ARRAY['trial_note_query'::text, 'trial_note_append'::text])))
);


--
-- Name: pe_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_credentials (
    digest text NOT NULL,
    user_id uuid NOT NULL,
    audience text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    credential_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT pe_credentials_audience_check CHECK ((audience = ANY (ARRAY['agent'::text, 'approval'::text, 'account'::text]))),
    CONSTRAINT pe_credentials_credential_version_check CHECK ((credential_version > 0))
);


--
-- Name: pe_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_events (
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    event json NOT NULL
);


--
-- Name: pe_file_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_file_uploads (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    path text NOT NULL,
    digest text NOT NULL,
    mime text NOT NULL,
    size bigint NOT NULL,
    binding_generation bigint DEFAULT 1 NOT NULL,
    CONSTRAINT pe_file_mutations_binding_generation_check CHECK ((binding_generation >= 1))
);


--
-- Name: pe_login_attempt_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_login_attempt_windows (
    account_digest text NOT NULL,
    window_since timestamp with time zone NOT NULL,
    attempts integer NOT NULL,
    CONSTRAINT pe_login_attempt_windows_account_digest_check CHECK ((account_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_login_attempt_windows_attempts_check CHECK ((attempts > 0))
);


--
-- Name: pe_login_global_window; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_login_global_window (
    singleton boolean DEFAULT true NOT NULL,
    window_since timestamp with time zone NOT NULL,
    attempts integer NOT NULL,
    tracked_accounts integer DEFAULT 0 NOT NULL,
    CONSTRAINT pe_login_global_window_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT pe_login_global_window_singleton_check CHECK (singleton),
    CONSTRAINT pe_login_global_window_tracked_accounts_check CHECK ((tracked_accounts >= 0))
);


--
-- Name: pe_mcp_action_chains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_action_chains (
    root_operation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    max_calls integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    stopped_at timestamp with time zone,
    error_code text,
    CONSTRAINT pe_mcp_action_chains_calls_check CHECK ((calls >= 0)),
    CONSTRAINT pe_mcp_action_chains_max_calls_check CHECK ((max_calls > 0))
);


--
-- Name: pe_mcp_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_actions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    root_operation_id uuid NOT NULL,
    call_key text NOT NULL,
    tool json NOT NULL,
    arguments json NOT NULL,
    request_digest text NOT NULL,
    state text NOT NULL,
    decision text,
    permission_id uuid,
    result json,
    error_code text,
    dispatch_id uuid,
    dispatch_at timestamp with time zone,
    decided_at timestamp with time zone,
    lease_owner uuid,
    lease_epoch integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    continuation_request_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_actions_check CHECK (((dispatch_id IS NULL) = (dispatch_at IS NULL))),
    CONSTRAINT pe_mcp_actions_decision_check CHECK ((decision = ANY (ARRAY['reject'::text, 'once'::text, 'session'::text, 'persistent'::text]))),
    CONSTRAINT pe_mcp_actions_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_mcp_actions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'preparing'::text, 'dispatch-intent'::text, 'succeeded'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text, 'uncertain'::text])))
);


--
-- Name: pe_mcp_catalog_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_catalog_versions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    connection_id uuid,
    draft_id uuid,
    configuration_revision integer NOT NULL,
    credential_revision integer,
    catalog_digest text NOT NULL,
    tools json NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_catalog_versions_catalog_digest_check CHECK ((catalog_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_mcp_catalog_versions_check CHECK (((connection_id IS NOT NULL) <> (draft_id IS NOT NULL))),
    CONSTRAINT pe_mcp_catalog_versions_configuration_revision_check CHECK ((configuration_revision > 0))
);


--
-- Name: pe_mcp_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_checks (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    connection_id uuid,
    draft_id uuid,
    connection_revision integer,
    configuration_revision integer NOT NULL,
    credential_revision integer,
    state text NOT NULL,
    catalog_id uuid,
    discovered_tools integer,
    error_code text,
    cancel_requested boolean DEFAULT false NOT NULL,
    lease_owner uuid,
    lease_epoch integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT pe_mcp_checks_check CHECK (((connection_id IS NOT NULL) <> (draft_id IS NOT NULL))),
    CONSTRAINT pe_mcp_checks_check1 CHECK (((connection_id IS NULL) = (connection_revision IS NULL))),
    CONSTRAINT pe_mcp_checks_configuration_revision_check CHECK ((configuration_revision > 0)),
    CONSTRAINT pe_mcp_checks_discovered_tools_check CHECK ((discovered_tools >= 0)),
    CONSTRAINT pe_mcp_checks_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'expired'::text])))
);


--
-- Name: pe_mcp_configuration_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_configuration_versions (
    connection_id uuid NOT NULL,
    user_id uuid NOT NULL,
    configuration_revision integer NOT NULL,
    credential_revision integer,
    configuration json NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_configuration_versions_configuration_revision_check CHECK ((configuration_revision > 0)),
    CONSTRAINT pe_mcp_configuration_versions_credential_revision_check CHECK ((credential_revision > 0))
);


--
-- Name: pe_mcp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    install_request_id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_connections_name_check CHECK (((length(name) >= 1) AND (length(name) <= 80))),
    CONSTRAINT pe_mcp_connections_revision_check CHECK ((revision > 0))
);


--
-- Name: pe_mcp_credential_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_credential_tickets (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    token_digest text NOT NULL,
    purpose text NOT NULL,
    input json NOT NULL,
    resource_id uuid NOT NULL,
    size_bytes integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT pe_mcp_credential_tickets_purpose_check CHECK ((purpose = ANY (ARRAY['create'::text, 'update'::text, 'draft'::text]))),
    CONSTRAINT pe_mcp_credential_tickets_size_bytes_check CHECK (((size_bytes >= 19) AND (size_bytes <= 16384)))
);


--
-- Name: pe_mcp_credential_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_credential_versions (
    connection_id uuid NOT NULL,
    user_id uuid NOT NULL,
    configuration_revision integer NOT NULL,
    credential_revision integer NOT NULL,
    format_version integer NOT NULL,
    sealed bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_credential_versions_credential_revision_check CHECK ((credential_revision > 0)),
    CONSTRAINT pe_mcp_credential_versions_format_version_check CHECK ((format_version = 1)),
    CONSTRAINT pe_mcp_credential_versions_sealed_check CHECK ((octet_length(sealed) >= 29))
);


--
-- Name: pe_mcp_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_drafts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    source_connection_id uuid,
    source_revision integer,
    configuration json NOT NULL,
    configuration_revision integer NOT NULL,
    credential_revision integer,
    credential_sealed bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT pe_mcp_drafts_check CHECK (((source_connection_id IS NULL) = (source_revision IS NULL))),
    CONSTRAINT pe_mcp_drafts_check1 CHECK (((credential_revision IS NULL) = (credential_sealed IS NULL))),
    CONSTRAINT pe_mcp_drafts_configuration_revision_check CHECK ((configuration_revision = 1)),
    CONSTRAINT pe_mcp_drafts_credential_revision_check CHECK ((credential_revision = 1))
);


--
-- Name: pe_mcp_management_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_management_requests (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    purpose text NOT NULL,
    metadata_digest text NOT NULL,
    secret_digest text,
    result json,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_management_requests_metadata_digest_check CHECK ((metadata_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_mcp_management_requests_purpose_check CHECK ((purpose = ANY (ARRAY['create'::text, 'update'::text, 'toggle'::text, 'delete'::text, 'draft'::text, 'check'::text]))),
    CONSTRAINT pe_mcp_management_requests_secret_digest_check CHECK ((secret_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_mcp_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_permissions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid,
    connection_id uuid NOT NULL,
    connection_revision integer NOT NULL,
    configuration_revision integer NOT NULL,
    credential_revision integer,
    catalog_id uuid NOT NULL,
    tool_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: pe_mcp_remote_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_remote_connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    server_name text NOT NULL,
    revision integer NOT NULL,
    configuration_revision integer NOT NULL,
    enabled boolean NOT NULL,
    deleted_at timestamp with time zone,
    current_catalog_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_remote_connections_configuration_revision_check CHECK ((configuration_revision > 0)),
    CONSTRAINT pe_mcp_remote_connections_revision_check CHECK ((revision > 0))
);


--
-- Name: pe_mcp_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mcp_updates (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    request_digest text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_mcp_updates_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_mount_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_mount_slots (
    user_id uuid NOT NULL,
    session_id uuid,
    workspace_id uuid,
    generation bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'free'::text NOT NULL,
    pod_uid uuid,
    runner_instance_id uuid,
    stop_pod_uid uuid,
    stop_evidence jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    binding_snapshot jsonb,
    CONSTRAINT pe_mount_slots_check CHECK ((((state = 'free'::text) AND (session_id IS NULL) AND (workspace_id IS NULL) AND (pod_uid IS NULL) AND (runner_instance_id IS NULL)) OR ((state = 'reserved'::text) AND (session_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (pod_uid IS NULL) AND (runner_instance_id IS NULL)) OR ((state = ANY (ARRAY['ready'::text, 'stopping'::text])) AND (session_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (pod_uid IS NOT NULL) AND (runner_instance_id IS NOT NULL)) OR ((state = 'unknown'::text) AND (session_id IS NOT NULL) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT pe_mount_slots_check1 CHECK (((stop_pod_uid IS NULL) = (stop_evidence IS NULL))),
    CONSTRAINT pe_mount_slots_generation_check CHECK ((generation >= 0)),
    CONSTRAINT pe_mount_slots_state_check CHECK ((state = ANY (ARRAY['free'::text, 'reserved'::text, 'ready'::text, 'stopping'::text, 'unknown'::text])))
);


--
-- Name: pe_office_preview_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_office_preview_jobs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    request_id text NOT NULL,
    generation text NOT NULL,
    request_digest text,
    request jsonb,
    session_id uuid,
    workspace_id uuid,
    binding_snapshot jsonb,
    source_snapshot jsonb,
    converter_snapshot jsonb,
    state text NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    error_code text,
    deadline_at timestamp with time zone,
    lease_owner uuid,
    lease_epoch integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    parser_slot integer,
    creation_intent jsonb,
    pod_identity jsonb,
    worker_observation jsonb,
    stop_evidence jsonb,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT pe_office_preview_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT pe_office_preview_jobs_binding_snapshot_check CHECK (((binding_snapshot IS NULL) OR (jsonb_typeof(binding_snapshot) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_check CHECK (((lease_owner IS NULL) = (lease_until IS NULL))),
    CONSTRAINT pe_office_preview_jobs_check1 CHECK (((state = ANY (ARRAY['failed'::text, 'blocked'::text])) = (error_code IS NOT NULL))),
    CONSTRAINT pe_office_preview_jobs_check2 CHECK (((state = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT pe_office_preview_jobs_check3 CHECK ((((request_digest IS NULL) AND (state = 'cancelled'::text) AND cancel_requested AND (request IS NULL) AND (session_id IS NULL) AND (workspace_id IS NULL) AND (binding_snapshot IS NULL) AND (source_snapshot IS NULL) AND (converter_snapshot IS NULL) AND (deadline_at IS NULL) AND (creation_intent IS NULL) AND (pod_identity IS NULL) AND (worker_observation IS NULL) AND (stop_evidence IS NULL) AND (result IS NULL) AND (lease_owner IS NULL) AND (lease_until IS NULL) AND (lease_epoch = 0) AND (attempts = 0) AND (parser_slot IS NULL)) OR ((request_digest IS NOT NULL) AND (request IS NOT NULL) AND (session_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (binding_snapshot IS NOT NULL) AND (source_snapshot IS NOT NULL) AND (converter_snapshot IS NOT NULL) AND (deadline_at IS NOT NULL)))),
    CONSTRAINT pe_office_preview_jobs_check4 CHECK (((parser_slot IS NULL) OR ((creation_intent IS NOT NULL) AND (state = ANY (ARRAY['creating'::text, 'running'::text, 'stopping'::text, 'blocked'::text]))))),
    CONSTRAINT pe_office_preview_jobs_check5 CHECK (((creation_intent IS NULL) OR (parser_slot IS NOT NULL) OR ((state = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) AND (stop_evidence IS NOT NULL)))),
    CONSTRAINT pe_office_preview_jobs_check6 CHECK (((pod_identity IS NULL) OR (creation_intent IS NOT NULL))),
    CONSTRAINT pe_office_preview_jobs_check7 CHECK (((worker_observation IS NULL) OR (pod_identity IS NOT NULL))),
    CONSTRAINT pe_office_preview_jobs_check8 CHECK (((stop_evidence IS NULL) OR (creation_intent IS NOT NULL))),
    CONSTRAINT pe_office_preview_jobs_check9 CHECK (((state <> 'succeeded'::text) OR ((result IS NOT NULL) AND (stop_evidence IS NOT NULL)))),
    CONSTRAINT pe_office_preview_jobs_converter_snapshot_check CHECK (((converter_snapshot IS NULL) OR (jsonb_typeof(converter_snapshot) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_creation_intent_check CHECK (((creation_intent IS NULL) OR (jsonb_typeof(creation_intent) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_error_code_check CHECK ((error_code = ANY (ARRAY['input-too-large'::text, 'output-too-large'::text, 'invalid-document'::text, 'unsupported-format'::text, 'invalid-output'::text, 'timeout'::text, 'unavailable'::text, 'failed'::text, 'busy'::text, 'source-changed'::text]))),
    CONSTRAINT pe_office_preview_jobs_generation_check CHECK ((generation ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_office_preview_jobs_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT pe_office_preview_jobs_parser_slot_check CHECK ((parser_slot >= 0)),
    CONSTRAINT pe_office_preview_jobs_pod_identity_check CHECK (((pod_identity IS NULL) OR (jsonb_typeof(pod_identity) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_request_check CHECK (((request IS NULL) OR (jsonb_typeof(request) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_office_preview_jobs_request_id_check CHECK ((((length(request_id) >= 1) AND (length(request_id) <= 128)) AND (request_id !~ '[[:cntrl:]]'::text))),
    CONSTRAINT pe_office_preview_jobs_result_check CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_source_snapshot_check CHECK (((source_snapshot IS NULL) OR (jsonb_typeof(source_snapshot) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'creating'::text, 'running'::text, 'stopping'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'blocked'::text]))),
    CONSTRAINT pe_office_preview_jobs_stop_evidence_check CHECK (((stop_evidence IS NULL) OR (jsonb_typeof(stop_evidence) = 'object'::text))),
    CONSTRAINT pe_office_preview_jobs_worker_observation_check CHECK (((worker_observation IS NULL) OR (jsonb_typeof(worker_observation) = 'object'::text)))
);


--
-- Name: pe_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_operations (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    request_id uuid NOT NULL,
    input text NOT NULL,
    settings jsonb NOT NULL,
    state text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    skill_selection jsonb DEFAULT '[]'::jsonb NOT NULL,
    source text DEFAULT 'user'::text NOT NULL,
    source_action_id uuid,
    source_execution_id uuid,
    execution_target jsonb DEFAULT '{"kind": "cloud"}'::jsonb NOT NULL,
    mcp_selection jsonb DEFAULT '[]'::jsonb NOT NULL,
    stdio_mcp_selection jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_stdio_mcp_call_id uuid,
    ssh_selection jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_ssh_execute_action_id uuid,
    remote_mcp_selection json DEFAULT '[]'::json NOT NULL,
    mcp_root_operation_id uuid,
    mcp_chain_cancelled_at timestamp with time zone,
    source_mcp_action_id uuid,
    stdio_v2_selection json DEFAULT '[]'::json NOT NULL,
    source_stdio_v2_action_id uuid,
    source_stdio_v2_phase text,
    source_stdio_v2_no_start_action_id uuid,
    CONSTRAINT pe_operations_cloud_target CHECK ((execution_target = '{"kind": "cloud"}'::jsonb)),
    CONSTRAINT pe_operations_source_action CHECK ((((source = 'user'::text) AND (num_nonnulls(source_action_id, source_execution_id, source_stdio_mcp_call_id, source_ssh_execute_action_id, source_mcp_action_id, source_stdio_v2_action_id, source_stdio_v2_no_start_action_id) = 0) AND (source_stdio_v2_phase IS NULL)) OR ((source <> 'user'::text) AND (num_nonnulls(source_action_id, source_execution_id, source_stdio_mcp_call_id, source_ssh_execute_action_id, source_mcp_action_id, source_stdio_v2_action_id, source_stdio_v2_no_start_action_id) = 1) AND (
CASE source
    WHEN 'platform_action'::text THEN source_action_id
    WHEN 'sandbox_result'::text THEN source_execution_id
    WHEN 'stdio_mcp_result'::text THEN source_stdio_mcp_call_id
    WHEN 'ssh_execute_result'::text THEN source_ssh_execute_action_id
    WHEN 'remote_mcp_result'::text THEN source_mcp_action_id
    WHEN 'stdio_v2_result'::text THEN source_stdio_v2_action_id
    WHEN 'stdio_v2_no_start'::text THEN source_stdio_v2_no_start_action_id
    ELSE NULL::uuid
END IS NOT NULL) AND (((source = ANY (ARRAY['stdio_v2_result'::text, 'stdio_v2_no_start'::text])) AND (source_stdio_v2_phase = 'call'::text)) OR ((source <> ALL (ARRAY['stdio_v2_result'::text, 'stdio_v2_no_start'::text])) AND (source_stdio_v2_phase IS NULL)))))),
    CONSTRAINT pe_operations_source_check CHECK ((source = ANY (ARRAY['user'::text, 'platform_action'::text, 'sandbox_result'::text, 'stdio_mcp_result'::text, 'ssh_execute_result'::text, 'remote_mcp_result'::text, 'stdio_v2_result'::text, 'stdio_v2_no_start'::text]))),
    CONSTRAINT pe_operations_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: pe_platform_admission_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_platform_admission_policy (
    singleton boolean DEFAULT true NOT NULL,
    login_window_ms integer NOT NULL,
    login_attempts_per_window integer NOT NULL,
    login_tracked_accounts integer NOT NULL,
    login_global_attempts_per_window integer NOT NULL,
    sandbox_concurrency integer NOT NULL,
    CONSTRAINT pe_platform_admission_policy_login_attempts_per_window_check CHECK ((login_attempts_per_window > 0)),
    CONSTRAINT pe_platform_admission_policy_login_global_attempts_per_wi_check CHECK ((login_global_attempts_per_window > 0)),
    CONSTRAINT pe_platform_admission_policy_login_tracked_accounts_check CHECK ((login_tracked_accounts > 0)),
    CONSTRAINT pe_platform_admission_policy_login_window_ms_check CHECK ((login_window_ms >= 1000)),
    CONSTRAINT pe_platform_admission_policy_sandbox_concurrency_check CHECK ((sandbox_concurrency > 0)),
    CONSTRAINT pe_platform_admission_policy_singleton_check CHECK (singleton)
);


--
-- Name: pe_plugin_mutations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_plugin_mutations (
    user_id uuid NOT NULL,
    plugin_id text NOT NULL,
    request_id uuid NOT NULL,
    request_digest text NOT NULL,
    result_enabled boolean NOT NULL,
    result_revision integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_plugin_mutations_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_plugin_mutations_result_revision_check CHECK ((result_revision > 0))
);


--
-- Name: pe_sandbox_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_sandbox_instances (
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    state text NOT NULL,
    pod_uid uuid,
    runner_instance_id uuid,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stop_pod_uid uuid,
    stop_evidence jsonb,
    binding_snapshot jsonb,
    CONSTRAINT pe_sandbox_instances_state_check CHECK ((state = ANY (ARRAY['creating'::text, 'ready'::text, 'deleting'::text, 'deleted'::text, 'unknown'::text])))
);


--
-- Name: pe_schema; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_schema (
    version integer NOT NULL,
    family text DEFAULT 'cloud-native'::text NOT NULL,
    CONSTRAINT pe_schema_family_check CHECK ((family = 'cloud-native'::text))
);


--
-- Name: pe_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    create_request_id uuid NOT NULL,
    header jsonb NOT NULL,
    event_count integer DEFAULT 0 NOT NULL,
    event_bytes bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_epoch integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    grant_digest text,
    workspace_id uuid NOT NULL
);


--
-- Name: pe_settings_mutations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_settings_mutations (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    request_digest text NOT NULL,
    result_settings jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_settings_mutations_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_skill_package_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_skill_package_versions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    version text NOT NULL,
    archive_digest text NOT NULL,
    archive_size integer NOT NULL,
    instruction_digest text NOT NULL,
    manifest_digest text NOT NULL,
    manifest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pe_skill_upload_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_skill_upload_intents (
    request_id uuid NOT NULL,
    user_id uuid NOT NULL,
    size_bytes integer NOT NULL,
    archive_digest text NOT NULL,
    token_digest text,
    expires_at timestamp with time zone,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_skill_upload_intents_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 1048576)))
);


--
-- Name: pe_ssh_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_calls (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    connection_revision integer NOT NULL,
    credential_revision integer NOT NULL,
    operation_id uuid,
    kind text NOT NULL,
    request_digest text NOT NULL,
    state text NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    cleanup_complete boolean DEFAULT false NOT NULL,
    destination jsonb,
    pod_uid uuid,
    runner_instance_id uuid,
    dispatch_digest text,
    dispatch_owner uuid,
    dispatch_epoch integer,
    result jsonb,
    error_code text,
    lease_owner uuid,
    lease_epoch integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_ssh_calls_check CHECK ((((kind = 'ssh.authenticate'::text) AND (operation_id IS NULL)) OR ((kind = 'ssh.execute'::text) AND (operation_id IS NOT NULL)))),
    CONSTRAINT pe_ssh_calls_check1 CHECK ((((pod_uid IS NULL) AND (runner_instance_id IS NULL)) OR ((pod_uid IS NOT NULL) AND (runner_instance_id IS NOT NULL) AND (destination IS NOT NULL)))),
    CONSTRAINT pe_ssh_calls_check2 CHECK ((((dispatch_digest IS NULL) AND (dispatch_owner IS NULL) AND (dispatch_epoch IS NULL)) OR ((dispatch_digest IS NOT NULL) AND (dispatch_owner IS NOT NULL) AND (dispatch_epoch IS NOT NULL) AND (pod_uid IS NOT NULL) AND (runner_instance_id IS NOT NULL)))),
    CONSTRAINT pe_ssh_calls_check3 CHECK (((state <> ALL (ARRAY['ready'::text, 'dispatch-intent'::text, 'running'::text])) OR (pod_uid IS NOT NULL))),
    CONSTRAINT pe_ssh_calls_check4 CHECK (((state <> ALL (ARRAY['dispatch-intent'::text, 'running'::text])) OR (dispatch_digest IS NOT NULL))),
    CONSTRAINT pe_ssh_calls_connection_revision_check CHECK ((connection_revision > 0)),
    CONSTRAINT pe_ssh_calls_credential_revision_check CHECK ((credential_revision > 0)),
    CONSTRAINT pe_ssh_calls_dispatch_digest_check CHECK (((dispatch_digest IS NULL) OR (dispatch_digest ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT pe_ssh_calls_dispatch_epoch_check CHECK (((dispatch_epoch IS NULL) OR (dispatch_epoch > 0))),
    CONSTRAINT pe_ssh_calls_kind_check CHECK ((kind = ANY (ARRAY['ssh.authenticate'::text, 'ssh.execute'::text]))),
    CONSTRAINT pe_ssh_calls_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT pe_ssh_calls_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_ssh_calls_state_check CHECK ((state = ANY (ARRAY['accepted'::text, 'preparing'::text, 'ready'::text, 'dispatch-intent'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text, 'cancelled'::text])))
);


--
-- Name: pe_ssh_configuration_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_configuration_versions (
    connection_id uuid NOT NULL,
    user_id uuid NOT NULL,
    revision integer NOT NULL,
    credential_revision integer NOT NULL,
    display_name text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    username text NOT NULL,
    host_key_sha256 text NOT NULL,
    working_directory text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_ssh_configuration_versions_credential_revision_check CHECK ((credential_revision > 0)),
    CONSTRAINT pe_ssh_configuration_versions_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 100))),
    CONSTRAINT pe_ssh_configuration_versions_host_check CHECK (((length(host) >= 1) AND (length(host) <= 253))),
    CONSTRAINT pe_ssh_configuration_versions_host_key_sha256_check CHECK ((host_key_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$'::text)),
    CONSTRAINT pe_ssh_configuration_versions_port_check CHECK (((port >= 1) AND (port <= 65535))),
    CONSTRAINT pe_ssh_configuration_versions_revision_check CHECK ((revision > 0)),
    CONSTRAINT pe_ssh_configuration_versions_username_check CHECK (((length(username) >= 1) AND (length(username) <= 100))),
    CONSTRAINT pe_ssh_configuration_versions_working_directory_check CHECK (((working_directory IS NULL) OR (((length(working_directory) >= 1) AND (length(working_directory) <= 1024)) AND (working_directory !~ '[[:cntrl:]]'::text))))
);


--
-- Name: pe_ssh_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    install_request_id uuid NOT NULL,
    install_digest text NOT NULL,
    display_name text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    username text NOT NULL,
    host_key_sha256 text NOT NULL,
    credential_kind text NOT NULL,
    credential_revision integer DEFAULT 1 NOT NULL,
    encrypted_credential bytea NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT pe_ssh_connections_credential_kind_check CHECK ((credential_kind = ANY (ARRAY['password'::text, 'private_key'::text]))),
    CONSTRAINT pe_ssh_connections_credential_revision_check CHECK ((credential_revision > 0)),
    CONSTRAINT pe_ssh_connections_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 100))),
    CONSTRAINT pe_ssh_connections_host_check CHECK (((length(host) >= 1) AND (length(host) <= 253))),
    CONSTRAINT pe_ssh_connections_host_key_sha256_check CHECK ((host_key_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$'::text)),
    CONSTRAINT pe_ssh_connections_install_digest_check CHECK ((install_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_ssh_connections_port_check CHECK (((port >= 1) AND (port <= 65535))),
    CONSTRAINT pe_ssh_connections_revision_check CHECK ((revision > 0)),
    CONSTRAINT pe_ssh_connections_username_check CHECK (((length(username) >= 1) AND (length(username) <= 100))),
    CONSTRAINT pe_ssh_deleted_disabled CHECK (((deleted_at IS NULL) OR (enabled = false)))
);


--
-- Name: pe_ssh_credential_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_credential_versions (
    connection_id uuid NOT NULL,
    user_id uuid NOT NULL,
    credential_revision integer NOT NULL,
    credential_kind text NOT NULL,
    format_version integer NOT NULL,
    aad_request_id uuid,
    encrypted_credential bytea NOT NULL,
    passphrase_configured boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_ssh_credential_versions_check CHECK ((((format_version = 1) AND (credential_kind = 'password'::text) AND (aad_request_id IS NOT NULL) AND (NOT passphrase_configured)) OR ((format_version = 2) AND (aad_request_id IS NULL)))),
    CONSTRAINT pe_ssh_credential_versions_check1 CHECK (((credential_kind = 'private_key'::text) OR (NOT passphrase_configured))),
    CONSTRAINT pe_ssh_credential_versions_credential_kind_check CHECK ((credential_kind = ANY (ARRAY['password'::text, 'private_key'::text]))),
    CONSTRAINT pe_ssh_credential_versions_credential_revision_check CHECK ((credential_revision > 0)),
    CONSTRAINT pe_ssh_credential_versions_encrypted_credential_check CHECK (((octet_length(encrypted_credential) >= 29) AND (octet_length(encrypted_credential) <= 65564))),
    CONSTRAINT pe_ssh_credential_versions_format_version_check CHECK ((format_version = ANY (ARRAY[1, 2])))
);


--
-- Name: pe_ssh_execute_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_execute_actions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    call_key text NOT NULL,
    connection_id uuid NOT NULL,
    connection_revision integer NOT NULL,
    credential_revision integer NOT NULL,
    command_sealed bytea NOT NULL,
    request_digest text NOT NULL,
    state text NOT NULL,
    result_sealed bytea,
    error_code text,
    decided_at timestamp with time zone,
    continuation_request_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_ssh_execute_actions_call_key_check CHECK (((length(call_key) >= 1) AND (length(call_key) <= 100))),
    CONSTRAINT pe_ssh_execute_actions_command_sealed_check CHECK (((octet_length(command_sealed) >= 29) AND (octet_length(command_sealed) <= 16412))),
    CONSTRAINT pe_ssh_execute_actions_connection_revision_check CHECK ((connection_revision > 0)),
    CONSTRAINT pe_ssh_execute_actions_credential_revision_check CHECK ((credential_revision > 0)),
    CONSTRAINT pe_ssh_execute_actions_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_ssh_execute_actions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'rejected'::text, 'approved'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text, 'cancelled'::text])))
);


--
-- Name: pe_ssh_management_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_management_requests (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    purpose text NOT NULL,
    request_format_version integer NOT NULL,
    request_digest text NOT NULL,
    input jsonb NOT NULL,
    connection_id uuid,
    base_revision integer,
    base_credential_revision integer,
    size_bytes integer,
    secret_digest text,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT pe_ssh_management_requests_base_credential_revision_check CHECK ((base_credential_revision > 0)),
    CONSTRAINT pe_ssh_management_requests_base_revision_check CHECK ((base_revision > 0)),
    CONSTRAINT pe_ssh_management_requests_check CHECK (((result IS NULL) = (completed_at IS NULL))),
    CONSTRAINT pe_ssh_management_requests_check1 CHECK (((result IS NULL) OR (connection_id IS NOT NULL))),
    CONSTRAINT pe_ssh_management_requests_check2 CHECK ((((purpose = 'create'::text) AND (base_revision IS NULL) AND (base_credential_revision IS NULL)) OR ((purpose <> 'create'::text) AND (base_revision IS NOT NULL) AND (base_credential_revision IS NOT NULL)))),
    CONSTRAINT pe_ssh_management_requests_purpose_check CHECK ((purpose = ANY (ARRAY['create'::text, 'update'::text, 'toggle'::text, 'delete'::text]))),
    CONSTRAINT pe_ssh_management_requests_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_ssh_management_requests_request_format_version_check CHECK ((request_format_version = ANY (ARRAY[1, 2]))),
    CONSTRAINT pe_ssh_management_requests_secret_digest_check CHECK ((secret_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_ssh_management_requests_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 65536)))
);


--
-- Name: pe_ssh_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_updates (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    request_digest text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_ssh_updates_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_ssh_upload_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_ssh_upload_intents (
    request_id uuid NOT NULL,
    user_id uuid NOT NULL,
    request_digest text NOT NULL,
    config jsonb NOT NULL,
    size_bytes integer NOT NULL,
    secret_digest text,
    token_digest text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    format_version integer DEFAULT 1 NOT NULL,
    purpose text DEFAULT 'create'::text NOT NULL,
    verification_failures integer DEFAULT 0 NOT NULL,
    CONSTRAINT pe_ssh_upload_intents_format_version_check CHECK ((format_version = ANY (ARRAY[1, 2]))),
    CONSTRAINT pe_ssh_upload_intents_purpose_check CHECK ((purpose = ANY (ARRAY['create'::text, 'update'::text]))),
    CONSTRAINT pe_ssh_upload_intents_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_ssh_upload_intents_secret_digest_check CHECK (((secret_digest IS NULL) OR (secret_digest ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT pe_ssh_upload_intents_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 65536))),
    CONSTRAINT pe_ssh_upload_intents_token_digest_check CHECK ((token_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_ssh_upload_intents_verification_failures_check CHECK ((verification_failures >= 0))
);


--
-- Name: pe_stdio_mcp_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_mcp_calls (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    connection_revision integer NOT NULL,
    call_key text NOT NULL,
    state text NOT NULL,
    pod_uid uuid,
    runner_instance_id uuid,
    dispatch_digest text,
    result text,
    error_code text,
    cleanup_complete boolean DEFAULT false NOT NULL,
    lease_owner uuid,
    lease_epoch integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    continuation_request_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_mcp_calls_call_key_check CHECK (((length(call_key) >= 1) AND (length(call_key) <= 100))),
    CONSTRAINT pe_stdio_mcp_calls_check CHECK ((((pod_uid IS NULL) AND (runner_instance_id IS NULL)) OR ((pod_uid IS NOT NULL) AND (runner_instance_id IS NOT NULL)))),
    CONSTRAINT pe_stdio_mcp_calls_check1 CHECK (((state <> ALL (ARRAY['ready'::text, 'dispatch-intent'::text, 'running'::text])) OR (pod_uid IS NOT NULL))),
    CONSTRAINT pe_stdio_mcp_calls_check2 CHECK (((state <> ALL (ARRAY['dispatch-intent'::text, 'running'::text])) OR (dispatch_digest IS NOT NULL))),
    CONSTRAINT pe_stdio_mcp_calls_connection_revision_check CHECK ((connection_revision > 0)),
    CONSTRAINT pe_stdio_mcp_calls_dispatch_digest_check CHECK (((dispatch_digest IS NULL) OR (dispatch_digest ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT pe_stdio_mcp_calls_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT pe_stdio_mcp_calls_result_check CHECK (((result IS NULL) OR (octet_length(result) <= 8192))),
    CONSTRAINT pe_stdio_mcp_calls_state_check CHECK ((state = ANY (ARRAY['accepted'::text, 'preparing'::text, 'ready'::text, 'dispatch-intent'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text])))
);


--
-- Name: pe_stdio_mcp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_mcp_connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    install_request_id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_mcp_connections_name_check CHECK (((length(name) >= 1) AND (length(name) <= 80))),
    CONSTRAINT pe_stdio_mcp_connections_revision_check CHECK ((revision > 0))
);


--
-- Name: pe_stdio_mcp_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_mcp_updates (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    request_digest text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_mcp_updates_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_stdio_v2_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_actions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    config_revision integer NOT NULL,
    config_digest text NOT NULL,
    phase text NOT NULL,
    execution_target text NOT NULL,
    execution_id uuid NOT NULL,
    cloud_execution_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (execution_target = 'cloud'::text) THEN execution_id
    ELSE NULL::uuid
END) STORED,
    request_id uuid,
    operation_id uuid,
    root_operation_id uuid,
    call_id text,
    task json NOT NULL,
    task_digest text NOT NULL,
    state text NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    error_code text,
    lease_owner uuid,
    lease_until timestamp with time zone,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    continuation_request_id uuid,
    continuation_queued boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_actions_check CHECK (((lease_owner IS NULL) = (lease_until IS NULL))),
    CONSTRAINT pe_stdio_v2_actions_check1 CHECK ((((phase = 'discover'::text) AND (request_id IS NOT NULL) AND (operation_id IS NULL) AND (root_operation_id IS NULL) AND (call_id IS NULL) AND (continuation_request_id IS NULL) AND (NOT continuation_queued)) OR ((phase = 'call'::text) AND (request_id IS NULL) AND (operation_id IS NOT NULL) AND (root_operation_id IS NOT NULL) AND (call_id IS NOT NULL) AND (continuation_request_id IS NOT NULL)))),
    CONSTRAINT pe_stdio_v2_actions_execution_target_check CHECK ((execution_target = 'cloud'::text)),
    CONSTRAINT pe_stdio_v2_actions_lease_epoch_check CHECK ((lease_epoch >= 0)),
    CONSTRAINT pe_stdio_v2_actions_phase_check CHECK ((phase = ANY (ARRAY['discover'::text, 'call'::text]))),
    CONSTRAINT pe_stdio_v2_actions_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'preparing'::text, 'pending'::text, 'approved'::text, 'dispatch-intent'::text, 'running'::text, 'stopping'::text, 'blocked'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'rejected'::text, 'expired'::text]))),
    CONSTRAINT pe_stdio_v2_actions_task_check CHECK (((json_typeof(task) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_actions_task_digest_check CHECK ((task_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_stdio_v2_catalogs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_catalogs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    config_revision integer NOT NULL,
    config_digest text NOT NULL,
    action_id uuid NOT NULL,
    session_id uuid NOT NULL,
    phase text NOT NULL,
    raw_catalog json NOT NULL,
    image_expectation json NOT NULL,
    catalog_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_catalogs_catalog_digest_check CHECK ((catalog_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_stdio_v2_catalogs_image_expectation_check CHECK (((json_typeof(image_expectation) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_catalogs_phase_check CHECK ((phase = 'discover'::text)),
    CONSTRAINT pe_stdio_v2_catalogs_raw_catalog_check CHECK (((json_typeof(raw_catalog) = 'array'::text) IS TRUE))
);


--
-- Name: pe_stdio_v2_configurations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_configurations (
    connection_id uuid NOT NULL,
    user_id uuid NOT NULL,
    revision integer NOT NULL,
    configuration json NOT NULL,
    config_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_configurations_config_digest_check CHECK ((config_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_stdio_v2_configurations_configuration_check CHECK (((json_typeof(configuration) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_configurations_revision_check CHECK ((revision > 0))
);


--
-- Name: pe_stdio_v2_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    revision integer NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    current_catalog_id uuid,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_connections_check CHECK (((deleted_at IS NULL) OR (NOT enabled))),
    CONSTRAINT pe_stdio_v2_connections_revision_check CHECK ((revision > 0))
);


--
-- Name: pe_stdio_v2_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_decisions (
    action_id uuid NOT NULL,
    user_id uuid NOT NULL,
    fingerprint text NOT NULL,
    decision text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_decisions_decision_check CHECK ((decision = ANY (ARRAY['once'::text, 'reject'::text])))
);


--
-- Name: pe_stdio_v2_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_dispatches (
    action_id uuid NOT NULL,
    dispatch json NOT NULL,
    dispatch_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_dispatches_dispatch_check CHECK (((json_typeof(dispatch) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_dispatches_dispatch_digest_check CHECK ((dispatch_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_stdio_v2_management_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_management_requests (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    purpose text NOT NULL,
    request json NOT NULL,
    request_digest text NOT NULL,
    receipt json NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_management_requests_purpose_check CHECK ((purpose = ANY (ARRAY['create'::text, 'update'::text, 'toggle'::text, 'delete'::text, 'check'::text]))),
    CONSTRAINT pe_stdio_v2_management_requests_request_digest_check CHECK ((request_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_stdio_v2_no_start_closures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_no_start_closures (
    action_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    phase text NOT NULL,
    execution_target text NOT NULL,
    execution_id uuid NOT NULL,
    task_digest text NOT NULL,
    prepared_digest text,
    worker_id uuid NOT NULL,
    lease_epoch bigint NOT NULL,
    receipt json NOT NULL,
    receipt_digest text NOT NULL,
    closed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pe_stdio_v2_no_start_closures_execution_target_check CHECK ((execution_target = 'cloud'::text)),
    CONSTRAINT pe_stdio_v2_no_start_closures_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT pe_stdio_v2_no_start_closures_phase_check CHECK ((phase = ANY (ARRAY['discover'::text, 'call'::text]))),
    CONSTRAINT pe_stdio_v2_no_start_closures_prepared_digest_check CHECK (((prepared_digest IS NULL) OR (prepared_digest ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT pe_stdio_v2_no_start_closures_receipt_check CHECK (((json_typeof(receipt) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_no_start_closures_receipt_digest_check CHECK ((receipt_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_stdio_v2_no_start_closures_task_digest_check CHECK ((task_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_stdio_v2_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_observations (
    id uuid NOT NULL,
    action_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    lease_epoch bigint NOT NULL,
    observation json NOT NULL,
    observation_digest text NOT NULL,
    stop_evidence json,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pe_stdio_v2_observations_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT pe_stdio_v2_observations_observation_check CHECK (((json_typeof(observation) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_observations_observation_digest_check CHECK ((observation_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_stdio_v2_observations_stop_evidence_check CHECK (((stop_evidence IS NULL) OR ((json_typeof(stop_evidence) = 'object'::text) IS TRUE)))
);


--
-- Name: pe_stdio_v2_preparations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_preparations (
    action_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    phase text NOT NULL,
    execution_target text NOT NULL,
    execution_id uuid NOT NULL,
    task_digest text NOT NULL,
    prepared json NOT NULL,
    prepared_digest text NOT NULL,
    approval_binding json NOT NULL,
    fingerprint text NOT NULL,
    approval_epoch integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_preparations_approval_binding_check CHECK (((json_typeof(approval_binding) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_preparations_approval_epoch_check CHECK ((approval_epoch = 1)),
    CONSTRAINT pe_stdio_v2_preparations_cloud_target CHECK ((execution_target = 'cloud'::text)),
    CONSTRAINT pe_stdio_v2_preparations_fingerprint_check CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_stdio_v2_preparations_prepared_check CHECK (((json_typeof(prepared) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_preparations_prepared_digest_check CHECK ((prepared_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: pe_stdio_v2_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_results (
    action_id uuid NOT NULL,
    result json NOT NULL,
    result_digest text NOT NULL,
    observation json NOT NULL,
    stop_evidence json NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_stdio_v2_results_observation_check CHECK (((json_typeof(observation) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_results_result_digest_check CHECK ((result_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT pe_stdio_v2_results_stop_evidence_check CHECK (((json_typeof(stop_evidence) = 'object'::text) IS TRUE))
);


--
-- Name: pe_stdio_v2_start_permits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_stdio_v2_start_permits (
    action_id uuid NOT NULL,
    permit_id uuid NOT NULL,
    authorization_request_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    task_digest text NOT NULL,
    prepared_digest text NOT NULL,
    fingerprint text NOT NULL,
    decision text NOT NULL,
    executor_owner json NOT NULL,
    permit json NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT pe_stdio_v2_start_permits_check CHECK ((expires_at > issued_at)),
    CONSTRAINT pe_stdio_v2_start_permits_decision_check CHECK ((decision = 'once'::text)),
    CONSTRAINT pe_stdio_v2_start_permits_executor_owner_check CHECK (((json_typeof(executor_owner) = 'object'::text) IS TRUE)),
    CONSTRAINT pe_stdio_v2_start_permits_permit_check CHECK (((json_typeof(permit) = 'object'::text) IS TRUE))
);


--
-- Name: pe_storage_spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_storage_spaces (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    root_key uuid NOT NULL,
    title text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    root_state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_storage_spaces_root_state_check CHECK ((root_state = ANY (ARRAY['provisioning'::text, 'ready'::text]))),
    CONSTRAINT pe_storage_spaces_title_check CHECK (((length(title) >= 1) AND (length(title) <= 80)))
);


--
-- Name: pe_user_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_user_models (
    user_id uuid NOT NULL,
    model_id text NOT NULL,
    label text NOT NULL,
    max_tokens integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT pe_user_models_label_check CHECK (((length(label) >= 1) AND (length(label) <= 100))),
    CONSTRAINT pe_user_models_max_tokens_check CHECK (((max_tokens >= 1) AND (max_tokens <= 8192))),
    CONSTRAINT pe_user_models_model_id_check CHECK (((length(model_id) >= 1) AND (length(model_id) <= 100)))
);


--
-- Name: pe_user_plugins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_user_plugins (
    user_id uuid NOT NULL,
    plugin_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_user_plugins_plugin_id_check CHECK ((plugin_id = 'notes'::text)),
    CONSTRAINT pe_user_plugins_revision_check CHECK ((revision > 0))
);


--
-- Name: pe_user_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_user_skills (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    digest text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'text'::text NOT NULL,
    package_version_id uuid,
    revoked_at timestamp with time zone,
    CONSTRAINT pe_user_skills_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'package'::text])))
);


--
-- Name: pe_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_users (
    id uuid NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    settings jsonb NOT NULL,
    last_claim_at timestamp with time zone,
    display_name text NOT NULL,
    role text DEFAULT 'USER'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    account_revision integer DEFAULT 1 NOT NULL,
    credential_version integer DEFAULT 1 NOT NULL,
    password_change_required boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pe_users_account_revision_check CHECK ((account_revision > 0)),
    CONSTRAINT pe_users_credential_version_check CHECK ((credential_version > 0)),
    CONSTRAINT pe_users_deleted_disabled CHECK (((deleted_at IS NULL) OR (enabled = false))),
    CONSTRAINT pe_users_display_name CHECK (((length(display_name) >= 1) AND (length(display_name) <= 200))),
    CONSTRAINT pe_users_role_check CHECK ((role = ANY (ARRAY['ADMIN'::text, 'USER'::text])))
);


--
-- Name: pe_workspace_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_workspace_bindings (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    space_id uuid NOT NULL,
    root_relative_path text DEFAULT ''::text NOT NULL,
    CONSTRAINT pe_workspace_bindings_root_relative_path_check CHECK ((length(root_relative_path) <= 512))
);


--
-- Name: pe_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_workspaces (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    title text DEFAULT 'Workspace'::text NOT NULL,
    is_default boolean DEFAULT true NOT NULL,
    create_request_id uuid,
    binding_generation bigint DEFAULT 1 NOT NULL,
    binding_state text DEFAULT 'provisioning'::text NOT NULL,
    binding_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pe_workspaces_binding_generation_check CHECK ((binding_generation >= 1)),
    CONSTRAINT pe_workspaces_binding_state_check CHECK ((binding_state = ANY (ARRAY['provisioning'::text, 'ready'::text]))),
    CONSTRAINT pe_workspaces_title_check CHECK (((length(title) >= 1) AND (length(title) <= 80)))
);


--
-- Name: pe_account_audit pe_account_audit_actor_user_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_audit
    ADD CONSTRAINT pe_account_audit_actor_user_id_request_id_key UNIQUE (actor_user_id, request_id);


--
-- Name: pe_account_audit pe_account_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_audit
    ADD CONSTRAINT pe_account_audit_pkey PRIMARY KEY (id);


--
-- Name: pe_account_bootstrap pe_account_bootstrap_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_bootstrap
    ADD CONSTRAINT pe_account_bootstrap_pkey PRIMARY KEY (singleton);


--
-- Name: pe_account_mutations pe_account_mutations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_mutations
    ADD CONSTRAINT pe_account_mutations_pkey PRIMARY KEY (actor_user_id, request_id);


--
-- Name: pe_attempts pe_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_attempts
    ADD CONSTRAINT pe_attempts_pkey PRIMARY KEY (operation_id, epoch);


--
-- Name: pe_builtin_skill_install_requests pe_builtin_skill_install_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_builtin_skill_install_requests
    ADD CONSTRAINT pe_builtin_skill_install_requests_pkey PRIMARY KEY (request_id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolutions_continuation_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolutions_continuation_request_id_key UNIQUE (continuation_request_id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolutions_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolutions_execution_id_key UNIQUE (execution_id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolutions_pkey PRIMARY KEY (id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolutions_user_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolutions_user_id_request_id_key UNIQUE (user_id, request_id);


--
-- Name: pe_cloud_executions pe_cloud_executions_continuation_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_continuation_request_id_key UNIQUE (continuation_request_id);


--
-- Name: pe_cloud_executions pe_cloud_executions_operation_id_call_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_operation_id_call_id_key UNIQUE (operation_id, call_id);


--
-- Name: pe_cloud_executions pe_cloud_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_pkey PRIMARY KEY (id);


--
-- Name: pe_cloud_executions pe_cloud_executions_resolution_owner; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_resolution_owner UNIQUE (id, user_id, session_id);


--
-- Name: pe_cloud_executions pe_cloud_executions_stdio_action_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_stdio_action_unique UNIQUE (stdio_action_id);


--
-- Name: pe_cloud_executions pe_cloud_executions_stdio_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_stdio_identity UNIQUE (id, user_id, session_id, stdio_phase, stdio_action_id);


--
-- Name: pe_connector_actions pe_connector_actions_operation_id_action_request_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_actions
    ADD CONSTRAINT pe_connector_actions_operation_id_action_request_digest_key UNIQUE (operation_id, action, request_digest);


--
-- Name: pe_connector_actions pe_connector_actions_operation_id_call_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_actions
    ADD CONSTRAINT pe_connector_actions_operation_id_call_id_key UNIQUE (operation_id, call_id);


--
-- Name: pe_connector_actions pe_connector_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_actions
    ADD CONSTRAINT pe_connector_actions_pkey PRIMARY KEY (id);


--
-- Name: pe_connector_permissions pe_connector_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_permissions
    ADD CONSTRAINT pe_connector_permissions_pkey PRIMARY KEY (user_id, capability);


--
-- Name: pe_credentials pe_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_credentials
    ADD CONSTRAINT pe_credentials_pkey PRIMARY KEY (digest);


--
-- Name: pe_events pe_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_events
    ADD CONSTRAINT pe_events_pkey PRIMARY KEY (session_id, seq);


--
-- Name: pe_file_uploads pe_file_mutations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_file_uploads
    ADD CONSTRAINT pe_file_mutations_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_login_attempt_windows pe_login_attempt_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_login_attempt_windows
    ADD CONSTRAINT pe_login_attempt_windows_pkey PRIMARY KEY (account_digest);


--
-- Name: pe_login_global_window pe_login_global_window_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_login_global_window
    ADD CONSTRAINT pe_login_global_window_pkey PRIMARY KEY (singleton);


--
-- Name: pe_mcp_action_chains pe_mcp_action_chains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_action_chains
    ADD CONSTRAINT pe_mcp_action_chains_pkey PRIMARY KEY (root_operation_id);


--
-- Name: pe_mcp_actions pe_mcp_actions_continuation_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_continuation_request_id_key UNIQUE (continuation_request_id);


--
-- Name: pe_mcp_actions pe_mcp_actions_dispatch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_dispatch_id_key UNIQUE (dispatch_id);


--
-- Name: pe_mcp_actions pe_mcp_actions_operation_id_call_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_operation_id_call_key_key UNIQUE (operation_id, call_key);


--
-- Name: pe_mcp_actions pe_mcp_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_pkey PRIMARY KEY (id);


--
-- Name: pe_mcp_catalog_versions pe_mcp_catalog_versions_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_catalog_versions
    ADD CONSTRAINT pe_mcp_catalog_versions_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_mcp_catalog_versions pe_mcp_catalog_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_catalog_versions
    ADD CONSTRAINT pe_mcp_catalog_versions_pkey PRIMARY KEY (id);


--
-- Name: pe_mcp_checks pe_mcp_checks_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_checks
    ADD CONSTRAINT pe_mcp_checks_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_mcp_checks pe_mcp_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_checks
    ADD CONSTRAINT pe_mcp_checks_pkey PRIMARY KEY (id);


--
-- Name: pe_mcp_configuration_versions pe_mcp_configuration_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_configuration_versions
    ADD CONSTRAINT pe_mcp_configuration_versions_pkey PRIMARY KEY (connection_id, user_id, configuration_revision);


--
-- Name: pe_mcp_connections pe_mcp_connections_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_connections
    ADD CONSTRAINT pe_mcp_connections_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_mcp_connections pe_mcp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_connections
    ADD CONSTRAINT pe_mcp_connections_pkey PRIMARY KEY (id);


--
-- Name: pe_mcp_connections pe_mcp_connections_user_id_install_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_connections
    ADD CONSTRAINT pe_mcp_connections_user_id_install_request_id_key UNIQUE (user_id, install_request_id);


--
-- Name: pe_mcp_connections pe_mcp_connections_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_connections
    ADD CONSTRAINT pe_mcp_connections_user_id_key UNIQUE (user_id);


--
-- Name: pe_mcp_credential_tickets pe_mcp_credential_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_credential_tickets
    ADD CONSTRAINT pe_mcp_credential_tickets_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_mcp_credential_tickets pe_mcp_credential_tickets_token_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_credential_tickets
    ADD CONSTRAINT pe_mcp_credential_tickets_token_digest_key UNIQUE (token_digest);


--
-- Name: pe_mcp_credential_versions pe_mcp_credential_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_credential_versions
    ADD CONSTRAINT pe_mcp_credential_versions_pkey PRIMARY KEY (connection_id, user_id, configuration_revision, credential_revision);


--
-- Name: pe_mcp_drafts pe_mcp_drafts_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_drafts
    ADD CONSTRAINT pe_mcp_drafts_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_mcp_drafts pe_mcp_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_drafts
    ADD CONSTRAINT pe_mcp_drafts_pkey PRIMARY KEY (id);


--
-- Name: pe_mcp_management_requests pe_mcp_management_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_management_requests
    ADD CONSTRAINT pe_mcp_management_requests_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_mcp_permissions pe_mcp_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_permissions
    ADD CONSTRAINT pe_mcp_permissions_pkey PRIMARY KEY (id);


--
-- Name: pe_mcp_remote_connections pe_mcp_remote_connections_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_remote_connections
    ADD CONSTRAINT pe_mcp_remote_connections_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_mcp_remote_connections pe_mcp_remote_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_remote_connections
    ADD CONSTRAINT pe_mcp_remote_connections_pkey PRIMARY KEY (id);


--
-- Name: pe_mcp_remote_connections pe_mcp_remote_connections_user_id_server_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_remote_connections
    ADD CONSTRAINT pe_mcp_remote_connections_user_id_server_name_key UNIQUE (user_id, server_name);


--
-- Name: pe_mcp_updates pe_mcp_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_updates
    ADD CONSTRAINT pe_mcp_updates_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_mount_slots pe_mount_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mount_slots
    ADD CONSTRAINT pe_mount_slots_pkey PRIMARY KEY (user_id);


--
-- Name: pe_office_preview_jobs pe_office_preview_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_preview_jobs
    ADD CONSTRAINT pe_office_preview_jobs_pkey PRIMARY KEY (id);


--
-- Name: pe_office_preview_jobs pe_office_preview_jobs_user_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_preview_jobs
    ADD CONSTRAINT pe_office_preview_jobs_user_id_request_id_key UNIQUE (user_id, request_id);


--
-- Name: pe_operations pe_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_pkey PRIMARY KEY (id);


--
-- Name: pe_operations pe_operations_session_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_session_id_request_id_key UNIQUE (session_id, request_id);


--
-- Name: pe_operations pe_operations_stdio_session; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_stdio_session UNIQUE (id, session_id);


--
-- Name: pe_platform_admission_policy pe_platform_admission_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_platform_admission_policy
    ADD CONSTRAINT pe_platform_admission_policy_pkey PRIMARY KEY (singleton);


--
-- Name: pe_plugin_mutations pe_plugin_mutations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_plugin_mutations
    ADD CONSTRAINT pe_plugin_mutations_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_sandbox_instances pe_sandbox_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sandbox_instances
    ADD CONSTRAINT pe_sandbox_instances_pkey PRIMARY KEY (session_id);


--
-- Name: pe_schema pe_schema_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_schema
    ADD CONSTRAINT pe_schema_pkey PRIMARY KEY (version);


--
-- Name: pe_sessions pe_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sessions
    ADD CONSTRAINT pe_sessions_pkey PRIMARY KEY (id);


--
-- Name: pe_sessions pe_sessions_stdio_owner; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sessions
    ADD CONSTRAINT pe_sessions_stdio_owner UNIQUE (id, user_id);


--
-- Name: pe_sessions pe_sessions_user_id_create_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sessions
    ADD CONSTRAINT pe_sessions_user_id_create_request_id_key UNIQUE (user_id, create_request_id);


--
-- Name: pe_settings_mutations pe_settings_mutations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_settings_mutations
    ADD CONSTRAINT pe_settings_mutations_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_skill_package_versions pe_skill_package_versions_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_package_versions
    ADD CONSTRAINT pe_skill_package_versions_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_skill_package_versions pe_skill_package_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_package_versions
    ADD CONSTRAINT pe_skill_package_versions_pkey PRIMARY KEY (id);


--
-- Name: pe_skill_package_versions pe_skill_package_versions_user_id_archive_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_package_versions
    ADD CONSTRAINT pe_skill_package_versions_user_id_archive_digest_key UNIQUE (user_id, archive_digest);


--
-- Name: pe_skill_package_versions pe_skill_package_versions_user_id_name_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_package_versions
    ADD CONSTRAINT pe_skill_package_versions_user_id_name_version_key UNIQUE (user_id, name, version);


--
-- Name: pe_skill_upload_intents pe_skill_upload_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_upload_intents
    ADD CONSTRAINT pe_skill_upload_intents_pkey PRIMARY KEY (request_id);


--
-- Name: pe_skill_upload_intents pe_skill_upload_intents_token_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_upload_intents
    ADD CONSTRAINT pe_skill_upload_intents_token_digest_key UNIQUE (token_digest);


--
-- Name: pe_ssh_calls pe_ssh_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_calls
    ADD CONSTRAINT pe_ssh_calls_pkey PRIMARY KEY (id);


--
-- Name: pe_ssh_calls pe_ssh_calls_user_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_calls
    ADD CONSTRAINT pe_ssh_calls_user_id_request_id_key UNIQUE (user_id, request_id);


--
-- Name: pe_ssh_configuration_versions pe_ssh_configuration_versions_connection_id_user_id_revisio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_configuration_versions
    ADD CONSTRAINT pe_ssh_configuration_versions_connection_id_user_id_revisio_key UNIQUE (connection_id, user_id, revision, credential_revision);


--
-- Name: pe_ssh_configuration_versions pe_ssh_configuration_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_configuration_versions
    ADD CONSTRAINT pe_ssh_configuration_versions_pkey PRIMARY KEY (connection_id, revision);


--
-- Name: pe_ssh_connections pe_ssh_connections_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_connections
    ADD CONSTRAINT pe_ssh_connections_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_ssh_connections pe_ssh_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_connections
    ADD CONSTRAINT pe_ssh_connections_pkey PRIMARY KEY (id);


--
-- Name: pe_ssh_connections pe_ssh_connections_user_id_install_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_connections
    ADD CONSTRAINT pe_ssh_connections_user_id_install_request_id_key UNIQUE (user_id, install_request_id);


--
-- Name: pe_ssh_credential_versions pe_ssh_credential_versions_connection_id_user_id_credential_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_credential_versions
    ADD CONSTRAINT pe_ssh_credential_versions_connection_id_user_id_credential_key UNIQUE (connection_id, user_id, credential_revision);


--
-- Name: pe_ssh_credential_versions pe_ssh_credential_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_credential_versions
    ADD CONSTRAINT pe_ssh_credential_versions_pkey PRIMARY KEY (connection_id, credential_revision);


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_continuation_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_continuation_request_id_key UNIQUE (continuation_request_id);


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_operation_id_call_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_operation_id_call_key_key UNIQUE (operation_id, call_key);


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_operation_id_key UNIQUE (operation_id);


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_pkey PRIMARY KEY (id);


--
-- Name: pe_ssh_management_requests pe_ssh_management_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_management_requests
    ADD CONSTRAINT pe_ssh_management_requests_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_ssh_updates pe_ssh_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_updates
    ADD CONSTRAINT pe_ssh_updates_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_ssh_upload_intents pe_ssh_upload_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_upload_intents
    ADD CONSTRAINT pe_ssh_upload_intents_pkey PRIMARY KEY (request_id);


--
-- Name: pe_ssh_upload_intents pe_ssh_upload_intents_token_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_upload_intents
    ADD CONSTRAINT pe_ssh_upload_intents_token_digest_key UNIQUE (token_digest);


--
-- Name: pe_stdio_mcp_calls pe_stdio_mcp_calls_continuation_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_calls
    ADD CONSTRAINT pe_stdio_mcp_calls_continuation_request_id_key UNIQUE (continuation_request_id);


--
-- Name: pe_stdio_mcp_calls pe_stdio_mcp_calls_operation_id_call_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_calls
    ADD CONSTRAINT pe_stdio_mcp_calls_operation_id_call_key_key UNIQUE (operation_id, call_key);


--
-- Name: pe_stdio_mcp_calls pe_stdio_mcp_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_calls
    ADD CONSTRAINT pe_stdio_mcp_calls_pkey PRIMARY KEY (id);


--
-- Name: pe_stdio_mcp_connections pe_stdio_mcp_connections_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_connections
    ADD CONSTRAINT pe_stdio_mcp_connections_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_stdio_mcp_connections pe_stdio_mcp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_connections
    ADD CONSTRAINT pe_stdio_mcp_connections_pkey PRIMARY KEY (id);


--
-- Name: pe_stdio_mcp_connections pe_stdio_mcp_connections_user_id_install_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_connections
    ADD CONSTRAINT pe_stdio_mcp_connections_user_id_install_request_id_key UNIQUE (user_id, install_request_id);


--
-- Name: pe_stdio_mcp_connections pe_stdio_mcp_connections_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_connections
    ADD CONSTRAINT pe_stdio_mcp_connections_user_id_key UNIQUE (user_id);


--
-- Name: pe_stdio_mcp_updates pe_stdio_mcp_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_updates
    ADD CONSTRAINT pe_stdio_mcp_updates_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_continuation_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_continuation_request_id_key UNIQUE (continuation_request_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_execution_id_key UNIQUE (execution_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_id_session_id_phase_continuation_reques_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_id_session_id_phase_continuation_reques_key UNIQUE (id, session_id, phase, continuation_request_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_id_session_id_phase_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_id_session_id_phase_key UNIQUE (id, session_id, phase);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_id_user_id_session_id_connection_id_con_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_id_user_id_session_id_connection_id_con_key UNIQUE (id, user_id, session_id, connection_id, config_revision, config_digest, phase);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_id_user_id_session_id_phase_execution_t_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_id_user_id_session_id_phase_execution_t_key UNIQUE (id, user_id, session_id, phase, execution_target, execution_id, task_digest);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_operation_id_call_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_operation_id_call_id_key UNIQUE (operation_id, call_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_pkey PRIMARY KEY (id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_user_id_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_user_id_request_id_key UNIQUE (user_id, request_id);


--
-- Name: pe_stdio_v2_catalogs pe_stdio_v2_catalogs_action_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_catalogs
    ADD CONSTRAINT pe_stdio_v2_catalogs_action_id_key UNIQUE (action_id);


--
-- Name: pe_stdio_v2_catalogs pe_stdio_v2_catalogs_id_user_id_connection_id_config_revisi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_catalogs
    ADD CONSTRAINT pe_stdio_v2_catalogs_id_user_id_connection_id_config_revisi_key UNIQUE (id, user_id, connection_id, config_revision);


--
-- Name: pe_stdio_v2_catalogs pe_stdio_v2_catalogs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_catalogs
    ADD CONSTRAINT pe_stdio_v2_catalogs_pkey PRIMARY KEY (id);


--
-- Name: pe_stdio_v2_configurations pe_stdio_v2_configurations_connection_id_user_id_revision_c_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_configurations
    ADD CONSTRAINT pe_stdio_v2_configurations_connection_id_user_id_revision_c_key UNIQUE (connection_id, user_id, revision, config_digest);


--
-- Name: pe_stdio_v2_configurations pe_stdio_v2_configurations_connection_id_user_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_configurations
    ADD CONSTRAINT pe_stdio_v2_configurations_connection_id_user_id_revision_key UNIQUE (connection_id, user_id, revision);


--
-- Name: pe_stdio_v2_configurations pe_stdio_v2_configurations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_configurations
    ADD CONSTRAINT pe_stdio_v2_configurations_pkey PRIMARY KEY (connection_id, revision);


--
-- Name: pe_stdio_v2_connections pe_stdio_v2_connections_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_connections
    ADD CONSTRAINT pe_stdio_v2_connections_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_stdio_v2_connections pe_stdio_v2_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_connections
    ADD CONSTRAINT pe_stdio_v2_connections_pkey PRIMARY KEY (id);


--
-- Name: pe_stdio_v2_decisions pe_stdio_v2_decisions_action_id_decision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_decisions
    ADD CONSTRAINT pe_stdio_v2_decisions_action_id_decision_key UNIQUE (action_id, decision);


--
-- Name: pe_stdio_v2_decisions pe_stdio_v2_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_decisions
    ADD CONSTRAINT pe_stdio_v2_decisions_pkey PRIMARY KEY (action_id);


--
-- Name: pe_stdio_v2_dispatches pe_stdio_v2_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_dispatches
    ADD CONSTRAINT pe_stdio_v2_dispatches_pkey PRIMARY KEY (action_id);


--
-- Name: pe_stdio_v2_management_requests pe_stdio_v2_management_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_management_requests
    ADD CONSTRAINT pe_stdio_v2_management_requests_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: pe_stdio_v2_no_start_closures pe_stdio_v2_no_start_closures_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_no_start_closures
    ADD CONSTRAINT pe_stdio_v2_no_start_closures_execution_id_key UNIQUE (execution_id);


--
-- Name: pe_stdio_v2_no_start_closures pe_stdio_v2_no_start_closures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_no_start_closures
    ADD CONSTRAINT pe_stdio_v2_no_start_closures_pkey PRIMARY KEY (action_id);


--
-- Name: pe_stdio_v2_observations pe_stdio_v2_observations_action_id_observation_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_observations
    ADD CONSTRAINT pe_stdio_v2_observations_action_id_observation_digest_key UNIQUE (action_id, observation_digest);


--
-- Name: pe_stdio_v2_observations pe_stdio_v2_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_observations
    ADD CONSTRAINT pe_stdio_v2_observations_pkey PRIMARY KEY (id);


--
-- Name: pe_stdio_v2_preparations pe_stdio_v2_preparations_action_id_execution_id_task_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_preparations
    ADD CONSTRAINT pe_stdio_v2_preparations_action_id_execution_id_task_digest_key UNIQUE (action_id, execution_id, task_digest, prepared_digest, fingerprint, expires_at);


--
-- Name: pe_stdio_v2_preparations pe_stdio_v2_preparations_action_id_user_id_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_preparations
    ADD CONSTRAINT pe_stdio_v2_preparations_action_id_user_id_fingerprint_key UNIQUE (action_id, user_id, fingerprint);


--
-- Name: pe_stdio_v2_preparations pe_stdio_v2_preparations_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_preparations
    ADD CONSTRAINT pe_stdio_v2_preparations_execution_id_key UNIQUE (execution_id);


--
-- Name: pe_stdio_v2_preparations pe_stdio_v2_preparations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_preparations
    ADD CONSTRAINT pe_stdio_v2_preparations_pkey PRIMARY KEY (action_id);


--
-- Name: pe_stdio_v2_results pe_stdio_v2_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_results
    ADD CONSTRAINT pe_stdio_v2_results_pkey PRIMARY KEY (action_id);


--
-- Name: pe_stdio_v2_start_permits pe_stdio_v2_start_permits_execution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_start_permits
    ADD CONSTRAINT pe_stdio_v2_start_permits_execution_id_key UNIQUE (execution_id);


--
-- Name: pe_stdio_v2_start_permits pe_stdio_v2_start_permits_permit_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_start_permits
    ADD CONSTRAINT pe_stdio_v2_start_permits_permit_id_key UNIQUE (permit_id);


--
-- Name: pe_stdio_v2_start_permits pe_stdio_v2_start_permits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_start_permits
    ADD CONSTRAINT pe_stdio_v2_start_permits_pkey PRIMARY KEY (action_id);


--
-- Name: pe_storage_spaces pe_storage_spaces_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_storage_spaces
    ADD CONSTRAINT pe_storage_spaces_id_user_id_key UNIQUE (id, user_id);


--
-- Name: pe_storage_spaces pe_storage_spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_storage_spaces
    ADD CONSTRAINT pe_storage_spaces_pkey PRIMARY KEY (id);


--
-- Name: pe_storage_spaces pe_storage_spaces_root_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_storage_spaces
    ADD CONSTRAINT pe_storage_spaces_root_key_key UNIQUE (root_key);


--
-- Name: pe_user_models pe_user_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_models
    ADD CONSTRAINT pe_user_models_pkey PRIMARY KEY (user_id, model_id);


--
-- Name: pe_user_plugins pe_user_plugins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_plugins
    ADD CONSTRAINT pe_user_plugins_pkey PRIMARY KEY (user_id, plugin_id);


--
-- Name: pe_user_skills pe_user_skills_id_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_skills
    ADD CONSTRAINT pe_user_skills_id_user UNIQUE (id, user_id);


--
-- Name: pe_user_skills pe_user_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_skills
    ADD CONSTRAINT pe_user_skills_pkey PRIMARY KEY (id);


--
-- Name: pe_user_skills pe_user_skills_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_skills
    ADD CONSTRAINT pe_user_skills_user_id_name_key UNIQUE (user_id, name);


--
-- Name: pe_users pe_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_users
    ADD CONSTRAINT pe_users_pkey PRIMARY KEY (id);


--
-- Name: pe_users pe_users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_users
    ADD CONSTRAINT pe_users_username_key UNIQUE (username);


--
-- Name: pe_workspace_bindings pe_workspace_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_workspace_bindings
    ADD CONSTRAINT pe_workspace_bindings_pkey PRIMARY KEY (workspace_id);


--
-- Name: pe_workspaces pe_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_workspaces
    ADD CONSTRAINT pe_workspaces_pkey PRIMARY KEY (id);


--
-- Name: pe_builtin_skill_install_requests_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_builtin_skill_install_requests_user ON public.pe_builtin_skill_install_requests USING btree (user_id, catalog_id);


--
-- Name: pe_cloud_execution_resolutions_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_cloud_execution_resolutions_pending ON public.pe_cloud_execution_resolutions USING btree (lease_until, created_at) WHERE (state = ANY (ARRAY['accepted'::text, 'stopping'::text]));


--
-- Name: pe_cloud_execution_resolutions_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_cloud_execution_resolutions_slot ON public.pe_cloud_execution_resolutions USING btree (user_id, mount_generation, pod_uid);


--
-- Name: pe_cloud_executions_active_leases; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_cloud_executions_active_leases ON public.pe_cloud_executions USING btree (lease_until) WHERE ((lease_owner IS NOT NULL) AND (state = ANY (ARRAY['starting'::text, 'running'::text, 'cancelling'::text, 'uncertain'::text])));


--
-- Name: pe_cloud_executions_one_live_per_session; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_cloud_executions_one_live_per_session ON public.pe_cloud_executions USING btree (session_id) WHERE (state = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'cancelling'::text, 'uncertain'::text]));


--
-- Name: pe_cloud_executions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_cloud_executions_user ON public.pe_cloud_executions USING btree (user_id, created_at DESC);


--
-- Name: pe_connector_actions_continuation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_connector_actions_continuation ON public.pe_connector_actions USING btree (continuation_request_id);


--
-- Name: pe_connector_actions_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_connector_actions_dispatch ON public.pe_connector_actions USING btree (created_at) WHERE (state = ANY (ARRAY['approved'::text, 'dispatching'::text, 'uncertain'::text]));


--
-- Name: pe_connector_actions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_connector_actions_user ON public.pe_connector_actions USING btree (user_id, created_at DESC);


--
-- Name: pe_credentials_expiration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_credentials_expiration ON public.pe_credentials USING btree (expires_at);


--
-- Name: pe_credentials_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_credentials_user ON public.pe_credentials USING btree (user_id);


--
-- Name: pe_login_attempt_windows_expiration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_login_attempt_windows_expiration ON public.pe_login_attempt_windows USING btree (window_since);


--
-- Name: pe_mcp_actions_work; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_mcp_actions_work ON public.pe_mcp_actions USING btree (created_at, id) WHERE (state = ANY (ARRAY['pending'::text, 'approved'::text, 'preparing'::text, 'dispatch-intent'::text]));


--
-- Name: pe_mcp_catalog_connection_digest; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_mcp_catalog_connection_digest ON public.pe_mcp_catalog_versions USING btree (connection_id, configuration_revision, COALESCE(credential_revision, 0), catalog_digest) WHERE (connection_id IS NOT NULL);


--
-- Name: pe_mcp_catalog_draft_digest; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_mcp_catalog_draft_digest ON public.pe_mcp_catalog_versions USING btree (draft_id, COALESCE(credential_revision, 0), catalog_digest) WHERE (draft_id IS NOT NULL);


--
-- Name: pe_mcp_checks_work; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_mcp_checks_work ON public.pe_mcp_checks USING btree (created_at, id) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: pe_mcp_permissions_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_mcp_permissions_live ON public.pe_mcp_permissions USING btree (user_id, connection_id, tool_id) WHERE (revoked_at IS NULL);


--
-- Name: pe_office_preview_parser_slots; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_office_preview_parser_slots ON public.pe_office_preview_jobs USING btree (parser_slot) WHERE (parser_slot IS NOT NULL);


--
-- Name: pe_office_preview_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_office_preview_pending ON public.pe_office_preview_jobs USING btree (created_at) WHERE (state = ANY (ARRAY['queued'::text, 'creating'::text, 'running'::text, 'stopping'::text, 'blocked'::text]));


--
-- Name: pe_office_preview_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_office_preview_user ON public.pe_office_preview_jobs USING btree (user_id, created_at DESC);


--
-- Name: pe_operations_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_operations_pending ON public.pe_operations USING btree (created_at) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: pe_sandbox_instances_live_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_sandbox_instances_live_name ON public.pe_sandbox_instances USING btree (name) WHERE (state = ANY (ARRAY['creating'::text, 'ready'::text, 'deleting'::text, 'unknown'::text]));


--
-- Name: pe_sessions_grant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_sessions_grant ON public.pe_sessions USING btree (grant_digest) WHERE (grant_digest IS NOT NULL);


--
-- Name: pe_sessions_owned_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_sessions_owned_workspace_id ON public.pe_sessions USING btree (id, user_id, workspace_id);


--
-- Name: pe_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_sessions_user ON public.pe_sessions USING btree (user_id, created_at DESC);


--
-- Name: pe_sessions_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_sessions_workspace ON public.pe_sessions USING btree (workspace_id, updated_at DESC, id);


--
-- Name: pe_skill_package_versions_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_skill_package_versions_skill ON public.pe_skill_package_versions USING btree (skill_id, created_at);


--
-- Name: pe_skill_upload_intents_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_skill_upload_intents_expiry ON public.pe_skill_upload_intents USING btree (expires_at);


--
-- Name: pe_ssh_calls_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_ssh_calls_claim ON public.pe_ssh_calls USING btree (created_at, id) WHERE (state = ANY (ARRAY['accepted'::text, 'preparing'::text, 'ready'::text, 'dispatch-intent'::text, 'running'::text, 'uncertain'::text]));


--
-- Name: pe_ssh_calls_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_ssh_calls_user ON public.pe_ssh_calls USING btree (user_id, created_at DESC, id DESC);


--
-- Name: pe_ssh_connections_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_ssh_connections_user ON public.pe_ssh_connections USING btree (user_id, created_at DESC);


--
-- Name: pe_ssh_execute_actions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_ssh_execute_actions_user ON public.pe_ssh_execute_actions USING btree (user_id, created_at DESC, id DESC);


--
-- Name: pe_ssh_upload_intents_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_ssh_upload_intents_user ON public.pe_ssh_upload_intents USING btree (user_id, expires_at DESC);


--
-- Name: pe_stdio_mcp_calls_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_stdio_mcp_calls_claim ON public.pe_stdio_mcp_calls USING btree (created_at, id) WHERE (state = ANY (ARRAY['accepted'::text, 'preparing'::text, 'ready'::text, 'dispatch-intent'::text, 'running'::text]));


--
-- Name: pe_stdio_mcp_calls_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_stdio_mcp_calls_cleanup ON public.pe_stdio_mcp_calls USING btree (updated_at, id) WHERE ((cleanup_complete = false) AND (state = ANY (ARRAY['succeeded'::text, 'failed'::text, 'uncertain'::text])));


--
-- Name: pe_stdio_v2_actions_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_stdio_v2_actions_pending ON public.pe_stdio_v2_actions USING btree (created_at, id) WHERE (state = ANY (ARRAY['queued'::text, 'preparing'::text, 'approved'::text, 'dispatch-intent'::text, 'running'::text, 'stopping'::text, 'blocked'::text]));


--
-- Name: pe_storage_spaces_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_storage_spaces_default ON public.pe_storage_spaces USING btree (user_id) WHERE is_default;


--
-- Name: pe_user_skills_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_user_skills_user ON public.pe_user_skills USING btree (user_id, name);


--
-- Name: pe_users_username_folded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_users_username_folded ON public.pe_users USING btree (lower(username));


--
-- Name: pe_workspace_bindings_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_workspace_bindings_space ON public.pe_workspace_bindings USING btree (space_id, root_relative_path);


--
-- Name: pe_workspaces_create_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_workspaces_create_request ON public.pe_workspaces USING btree (user_id, create_request_id) WHERE (create_request_id IS NOT NULL);


--
-- Name: pe_workspaces_default_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_workspaces_default_user ON public.pe_workspaces USING btree (user_id) WHERE is_default;


--
-- Name: pe_workspaces_owned_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pe_workspaces_owned_id ON public.pe_workspaces USING btree (id, user_id);


--
-- Name: pe_users pe_account_identity_defaults; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_account_identity_defaults BEFORE INSERT ON public.pe_users FOR EACH ROW EXECUTE FUNCTION public.pe_account_identity_defaults();


--
-- Name: pe_users pe_account_identity_preserved; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_account_identity_preserved BEFORE DELETE OR UPDATE ON public.pe_users FOR EACH ROW EXECUTE FUNCTION public.pe_account_identity_preserved();


--
-- Name: pe_cloud_executions pe_cloud_executions_stdio_match; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER pe_cloud_executions_stdio_match AFTER INSERT OR UPDATE ON public.pe_cloud_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_match_execution();


--
-- Name: pe_cloud_executions pe_cloud_executions_stdio_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_cloud_executions_stdio_original BEFORE UPDATE ON public.pe_cloud_executions FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_execution();


--
-- Name: pe_mcp_catalog_versions pe_mcp_catalog_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_mcp_catalog_immutable BEFORE UPDATE ON public.pe_mcp_catalog_versions FOR EACH ROW EXECUTE FUNCTION public.pe_mcp_reject_version_update();


--
-- Name: pe_mcp_configuration_versions pe_mcp_configuration_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_mcp_configuration_immutable BEFORE DELETE OR UPDATE ON public.pe_mcp_configuration_versions FOR EACH ROW EXECUTE FUNCTION public.pe_mcp_reject_version_update();


--
-- Name: pe_mcp_credential_versions pe_mcp_credential_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_mcp_credential_immutable BEFORE DELETE OR UPDATE ON public.pe_mcp_credential_versions FOR EACH ROW EXECUTE FUNCTION public.pe_mcp_reject_version_update();


--
-- Name: pe_mcp_drafts pe_mcp_draft_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_mcp_draft_immutable BEFORE UPDATE ON public.pe_mcp_drafts FOR EACH ROW EXECUTE FUNCTION public.pe_mcp_reject_version_update();


--
-- Name: pe_office_preview_jobs pe_office_preview_cancelled; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_office_preview_cancelled BEFORE UPDATE ON public.pe_office_preview_jobs FOR EACH ROW EXECUTE FUNCTION public.pe_office_preview_keep_cancelled();


--
-- Name: pe_operations pe_operations_stdio_no_start_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_operations_stdio_no_start_original BEFORE UPDATE ON public.pe_operations FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_no_start_operation();


--
-- Name: pe_operations pe_operations_stdio_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_operations_stdio_original BEFORE UPDATE ON public.pe_operations FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_operation();


--
-- Name: pe_sessions pe_session_workspace_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_session_workspace_immutable BEFORE UPDATE OF workspace_id ON public.pe_sessions FOR EACH ROW EXECUTE FUNCTION public.pe_session_workspace_immutable();


--
-- Name: pe_ssh_configuration_versions pe_ssh_configuration_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_ssh_configuration_immutable BEFORE DELETE OR UPDATE ON public.pe_ssh_configuration_versions FOR EACH ROW EXECUTE FUNCTION public.pe_ssh_reject_version_update();


--
-- Name: pe_ssh_credential_versions pe_ssh_credential_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_ssh_credential_immutable BEFORE DELETE OR UPDATE ON public.pe_ssh_credential_versions FOR EACH ROW EXECUTE FUNCTION public.pe_ssh_reject_version_update();


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_actions_original BEFORE UPDATE ON public.pe_stdio_v2_actions FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_task();


--
-- Name: pe_stdio_v2_catalogs pe_stdio_v2_catalogs_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_catalogs_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_catalogs FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_configurations pe_stdio_v2_configurations_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_configurations_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_configurations FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_decisions pe_stdio_v2_decisions_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_decisions_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_decisions FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_dispatches pe_stdio_v2_dispatches_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_dispatches_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_dispatches FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_management_requests pe_stdio_v2_management_requests_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_management_requests_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_management_requests FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_no_start_closures pe_stdio_v2_no_start_closures_exclude_closed_start; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER pe_stdio_v2_no_start_closures_exclude_closed_start AFTER INSERT ON public.pe_stdio_v2_no_start_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_exclude_closed_start();


--
-- Name: pe_stdio_v2_no_start_closures pe_stdio_v2_no_start_closures_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_no_start_closures_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_no_start_closures FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_observations pe_stdio_v2_observations_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_observations_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_observations FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_preparations pe_stdio_v2_preparations_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_preparations_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_preparations FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_results pe_stdio_v2_results_exclude_closed_start; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER pe_stdio_v2_results_exclude_closed_start AFTER INSERT ON public.pe_stdio_v2_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_exclude_closed_start();


--
-- Name: pe_stdio_v2_results pe_stdio_v2_results_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_results_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_results FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_stdio_v2_start_permits pe_stdio_v2_start_permits_exclude_closed_start; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER pe_stdio_v2_start_permits_exclude_closed_start AFTER INSERT ON public.pe_stdio_v2_start_permits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_exclude_closed_start();


--
-- Name: pe_stdio_v2_start_permits pe_stdio_v2_start_permits_original; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_stdio_v2_start_permits_original BEFORE DELETE OR UPDATE ON public.pe_stdio_v2_start_permits FOR EACH ROW EXECUTE FUNCTION public.pe_stdio_v2_keep_original();


--
-- Name: pe_storage_spaces pe_storage_root_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pe_storage_root_immutable BEFORE UPDATE OF root_key, user_id ON public.pe_storage_spaces FOR EACH ROW EXECUTE FUNCTION public.pe_storage_root_immutable();


--
-- Name: pe_account_audit pe_account_audit_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_audit
    ADD CONSTRAINT pe_account_audit_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_account_audit pe_account_audit_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_audit
    ADD CONSTRAINT pe_account_audit_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_account_bootstrap pe_account_bootstrap_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_bootstrap
    ADD CONSTRAINT pe_account_bootstrap_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_account_mutations pe_account_mutations_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_mutations
    ADD CONSTRAINT pe_account_mutations_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_account_mutations pe_account_mutations_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_account_mutations
    ADD CONSTRAINT pe_account_mutations_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_attempts pe_attempts_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_attempts
    ADD CONSTRAINT pe_attempts_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_builtin_skill_install_requests pe_builtin_skill_install_reques_package_version_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_builtin_skill_install_requests
    ADD CONSTRAINT pe_builtin_skill_install_reques_package_version_id_user_id_fkey FOREIGN KEY (package_version_id, user_id) REFERENCES public.pe_skill_package_versions(id, user_id);


--
-- Name: pe_builtin_skill_install_requests pe_builtin_skill_install_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_builtin_skill_install_requests
    ADD CONSTRAINT pe_builtin_skill_install_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolution_execution_id_user_id_session_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolution_execution_id_user_id_session_fkey FOREIGN KEY (execution_id, user_id, session_id) REFERENCES public.pe_cloud_executions(id, user_id, session_id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolutions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolutions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolutions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolutions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_cloud_execution_resolutions pe_cloud_execution_resolutions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_execution_resolutions
    ADD CONSTRAINT pe_cloud_execution_resolutions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.pe_workspaces(id);


--
-- Name: pe_cloud_executions pe_cloud_executions_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_cloud_executions pe_cloud_executions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_cloud_executions pe_cloud_executions_stdio_action; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_stdio_action FOREIGN KEY (stdio_action_id, user_id, session_id, stdio_phase, execution_target, id, request_digest) REFERENCES public.pe_stdio_v2_actions(id, user_id, session_id, phase, execution_target, execution_id, task_digest) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: pe_cloud_executions pe_cloud_executions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_cloud_executions
    ADD CONSTRAINT pe_cloud_executions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_connector_actions pe_connector_actions_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_actions
    ADD CONSTRAINT pe_connector_actions_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_connector_actions pe_connector_actions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_actions
    ADD CONSTRAINT pe_connector_actions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_connector_actions pe_connector_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_actions
    ADD CONSTRAINT pe_connector_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_connector_permissions pe_connector_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_connector_permissions
    ADD CONSTRAINT pe_connector_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_credentials pe_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_credentials
    ADD CONSTRAINT pe_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_events pe_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_events
    ADD CONSTRAINT pe_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_file_uploads pe_file_mutations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_file_uploads
    ADD CONSTRAINT pe_file_mutations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_file_uploads pe_file_mutations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_file_uploads
    ADD CONSTRAINT pe_file_mutations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.pe_workspaces(id);


--
-- Name: pe_mcp_action_chains pe_mcp_action_chains_root_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_action_chains
    ADD CONSTRAINT pe_mcp_action_chains_root_operation_id_fkey FOREIGN KEY (root_operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_mcp_action_chains pe_mcp_action_chains_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_action_chains
    ADD CONSTRAINT pe_mcp_action_chains_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_mcp_action_chains pe_mcp_action_chains_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_action_chains
    ADD CONSTRAINT pe_mcp_action_chains_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_actions pe_mcp_actions_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_mcp_actions pe_mcp_actions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.pe_mcp_permissions(id);


--
-- Name: pe_mcp_actions pe_mcp_actions_root_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_root_operation_id_fkey FOREIGN KEY (root_operation_id) REFERENCES public.pe_mcp_action_chains(root_operation_id);


--
-- Name: pe_mcp_actions pe_mcp_actions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_mcp_actions pe_mcp_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_actions
    ADD CONSTRAINT pe_mcp_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_catalog_versions pe_mcp_catalog_versions_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_catalog_versions
    ADD CONSTRAINT pe_mcp_catalog_versions_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_mcp_remote_connections(id, user_id);


--
-- Name: pe_mcp_catalog_versions pe_mcp_catalog_versions_draft_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_catalog_versions
    ADD CONSTRAINT pe_mcp_catalog_versions_draft_id_user_id_fkey FOREIGN KEY (draft_id, user_id) REFERENCES public.pe_mcp_drafts(id, user_id);


--
-- Name: pe_mcp_catalog_versions pe_mcp_catalog_versions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_catalog_versions
    ADD CONSTRAINT pe_mcp_catalog_versions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_checks pe_mcp_check_catalog; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_checks
    ADD CONSTRAINT pe_mcp_check_catalog FOREIGN KEY (catalog_id, user_id) REFERENCES public.pe_mcp_catalog_versions(id, user_id);


--
-- Name: pe_mcp_checks pe_mcp_checks_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_checks
    ADD CONSTRAINT pe_mcp_checks_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_mcp_remote_connections(id, user_id);


--
-- Name: pe_mcp_checks pe_mcp_checks_draft_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_checks
    ADD CONSTRAINT pe_mcp_checks_draft_id_user_id_fkey FOREIGN KEY (draft_id, user_id) REFERENCES public.pe_mcp_drafts(id, user_id);


--
-- Name: pe_mcp_checks pe_mcp_checks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_checks
    ADD CONSTRAINT pe_mcp_checks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_mcp_checks pe_mcp_checks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_checks
    ADD CONSTRAINT pe_mcp_checks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_configuration_versions pe_mcp_configuration_versions_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_configuration_versions
    ADD CONSTRAINT pe_mcp_configuration_versions_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_mcp_remote_connections(id, user_id);


--
-- Name: pe_mcp_connections pe_mcp_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_connections
    ADD CONSTRAINT pe_mcp_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_credential_tickets pe_mcp_credential_tickets_user_id_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_credential_tickets
    ADD CONSTRAINT pe_mcp_credential_tickets_user_id_request_id_fkey FOREIGN KEY (user_id, request_id) REFERENCES public.pe_mcp_management_requests(user_id, request_id);


--
-- Name: pe_mcp_credential_versions pe_mcp_credential_versions_connection_id_user_id_configura_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_credential_versions
    ADD CONSTRAINT pe_mcp_credential_versions_connection_id_user_id_configura_fkey FOREIGN KEY (connection_id, user_id, configuration_revision) REFERENCES public.pe_mcp_configuration_versions(connection_id, user_id, configuration_revision);


--
-- Name: pe_mcp_drafts pe_mcp_drafts_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_drafts
    ADD CONSTRAINT pe_mcp_drafts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_mcp_drafts pe_mcp_drafts_source_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_drafts
    ADD CONSTRAINT pe_mcp_drafts_source_connection_id_user_id_fkey FOREIGN KEY (source_connection_id, user_id) REFERENCES public.pe_mcp_remote_connections(id, user_id);


--
-- Name: pe_mcp_drafts pe_mcp_drafts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_drafts
    ADD CONSTRAINT pe_mcp_drafts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_management_requests pe_mcp_management_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_management_requests
    ADD CONSTRAINT pe_mcp_management_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_permissions pe_mcp_permissions_catalog_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_permissions
    ADD CONSTRAINT pe_mcp_permissions_catalog_id_user_id_fkey FOREIGN KEY (catalog_id, user_id) REFERENCES public.pe_mcp_catalog_versions(id, user_id);


--
-- Name: pe_mcp_permissions pe_mcp_permissions_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_permissions
    ADD CONSTRAINT pe_mcp_permissions_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_mcp_remote_connections(id, user_id);


--
-- Name: pe_mcp_permissions pe_mcp_permissions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_permissions
    ADD CONSTRAINT pe_mcp_permissions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_mcp_permissions pe_mcp_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_permissions
    ADD CONSTRAINT pe_mcp_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_remote_connections pe_mcp_remote_catalog; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_remote_connections
    ADD CONSTRAINT pe_mcp_remote_catalog FOREIGN KEY (current_catalog_id, user_id) REFERENCES public.pe_mcp_catalog_versions(id, user_id);


--
-- Name: pe_mcp_remote_connections pe_mcp_remote_configuration; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_remote_connections
    ADD CONSTRAINT pe_mcp_remote_configuration FOREIGN KEY (id, user_id, configuration_revision) REFERENCES public.pe_mcp_configuration_versions(connection_id, user_id, configuration_revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: pe_mcp_remote_connections pe_mcp_remote_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_remote_connections
    ADD CONSTRAINT pe_mcp_remote_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mcp_updates pe_mcp_updates_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_updates
    ADD CONSTRAINT pe_mcp_updates_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_mcp_connections(id, user_id);


--
-- Name: pe_mcp_updates pe_mcp_updates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mcp_updates
    ADD CONSTRAINT pe_mcp_updates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_mount_slots pe_mount_slots_session_id_user_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mount_slots
    ADD CONSTRAINT pe_mount_slots_session_id_user_id_workspace_id_fkey FOREIGN KEY (session_id, user_id, workspace_id) REFERENCES public.pe_sessions(id, user_id, workspace_id);


--
-- Name: pe_mount_slots pe_mount_slots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_mount_slots
    ADD CONSTRAINT pe_mount_slots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_office_preview_jobs pe_office_preview_jobs_session_id_user_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_preview_jobs
    ADD CONSTRAINT pe_office_preview_jobs_session_id_user_id_workspace_id_fkey FOREIGN KEY (session_id, user_id, workspace_id) REFERENCES public.pe_sessions(id, user_id, workspace_id);


--
-- Name: pe_office_preview_jobs pe_office_preview_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_preview_jobs
    ADD CONSTRAINT pe_office_preview_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_office_preview_jobs pe_office_preview_jobs_workspace_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_preview_jobs
    ADD CONSTRAINT pe_office_preview_jobs_workspace_id_user_id_fkey FOREIGN KEY (workspace_id, user_id) REFERENCES public.pe_workspaces(id, user_id);


--
-- Name: pe_operations pe_operations_mcp_root_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_mcp_root_operation_id_fkey FOREIGN KEY (mcp_root_operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_operations pe_operations_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_operations pe_operations_source_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_source_action_id_fkey FOREIGN KEY (source_action_id) REFERENCES public.pe_connector_actions(id);


--
-- Name: pe_operations pe_operations_source_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_source_execution_id_fkey FOREIGN KEY (source_execution_id) REFERENCES public.pe_cloud_executions(id);


--
-- Name: pe_operations pe_operations_source_mcp_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_source_mcp_action_id_fkey FOREIGN KEY (source_mcp_action_id) REFERENCES public.pe_mcp_actions(id);


--
-- Name: pe_operations pe_operations_source_ssh_execute_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_source_ssh_execute_action_id_fkey FOREIGN KEY (source_ssh_execute_action_id) REFERENCES public.pe_ssh_execute_actions(id);


--
-- Name: pe_operations pe_operations_source_stdio_mcp_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_source_stdio_mcp_call_id_fkey FOREIGN KEY (source_stdio_mcp_call_id) REFERENCES public.pe_stdio_mcp_calls(id);


--
-- Name: pe_operations pe_operations_stdio_v2_no_start_closure; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_stdio_v2_no_start_closure FOREIGN KEY (source_stdio_v2_no_start_action_id) REFERENCES public.pe_stdio_v2_no_start_closures(action_id);


--
-- Name: pe_operations pe_operations_stdio_v2_no_start_source; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_stdio_v2_no_start_source FOREIGN KEY (source_stdio_v2_no_start_action_id, session_id, source_stdio_v2_phase, request_id) REFERENCES public.pe_stdio_v2_actions(id, session_id, phase, continuation_request_id);


--
-- Name: pe_operations pe_operations_stdio_v2_result; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_stdio_v2_result FOREIGN KEY (source_stdio_v2_action_id) REFERENCES public.pe_stdio_v2_results(action_id);


--
-- Name: pe_operations pe_operations_stdio_v2_source; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_operations
    ADD CONSTRAINT pe_operations_stdio_v2_source FOREIGN KEY (source_stdio_v2_action_id, session_id, source_stdio_v2_phase, request_id) REFERENCES public.pe_stdio_v2_actions(id, session_id, phase, continuation_request_id);


--
-- Name: pe_plugin_mutations pe_plugin_mutations_user_id_plugin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_plugin_mutations
    ADD CONSTRAINT pe_plugin_mutations_user_id_plugin_id_fkey FOREIGN KEY (user_id, plugin_id) REFERENCES public.pe_user_plugins(user_id, plugin_id);


--
-- Name: pe_sandbox_instances pe_sandbox_instances_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sandbox_instances
    ADD CONSTRAINT pe_sandbox_instances_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_sandbox_instances pe_sandbox_instances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sandbox_instances
    ADD CONSTRAINT pe_sandbox_instances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_sessions pe_sessions_owned_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sessions
    ADD CONSTRAINT pe_sessions_owned_workspace FOREIGN KEY (workspace_id, user_id) REFERENCES public.pe_workspaces(id, user_id);


--
-- Name: pe_sessions pe_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_sessions
    ADD CONSTRAINT pe_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_settings_mutations pe_settings_mutations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_settings_mutations
    ADD CONSTRAINT pe_settings_mutations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_skill_package_versions pe_skill_package_versions_skill_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_package_versions
    ADD CONSTRAINT pe_skill_package_versions_skill_id_user_id_fkey FOREIGN KEY (skill_id, user_id) REFERENCES public.pe_user_skills(id, user_id);


--
-- Name: pe_skill_package_versions pe_skill_package_versions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_package_versions
    ADD CONSTRAINT pe_skill_package_versions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_skill_upload_intents pe_skill_upload_intents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_skill_upload_intents
    ADD CONSTRAINT pe_skill_upload_intents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_ssh_execute_actions pe_ssh_action_configuration; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_action_configuration FOREIGN KEY (connection_id, user_id, connection_revision, credential_revision) REFERENCES public.pe_ssh_configuration_versions(connection_id, user_id, revision, credential_revision);


--
-- Name: pe_ssh_calls pe_ssh_call_configuration; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_calls
    ADD CONSTRAINT pe_ssh_call_configuration FOREIGN KEY (connection_id, user_id, connection_revision, credential_revision) REFERENCES public.pe_ssh_configuration_versions(connection_id, user_id, revision, credential_revision);


--
-- Name: pe_ssh_calls pe_ssh_calls_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_calls
    ADD CONSTRAINT pe_ssh_calls_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_ssh_connections(id, user_id);


--
-- Name: pe_ssh_calls pe_ssh_calls_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_calls
    ADD CONSTRAINT pe_ssh_calls_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_ssh_calls pe_ssh_calls_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_calls
    ADD CONSTRAINT pe_ssh_calls_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_ssh_configuration_versions pe_ssh_configuration_versions_connection_id_user_id_creden_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_configuration_versions
    ADD CONSTRAINT pe_ssh_configuration_versions_connection_id_user_id_creden_fkey FOREIGN KEY (connection_id, user_id, credential_revision) REFERENCES public.pe_ssh_credential_versions(connection_id, user_id, credential_revision);


--
-- Name: pe_ssh_configuration_versions pe_ssh_configuration_versions_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_configuration_versions
    ADD CONSTRAINT pe_ssh_configuration_versions_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_ssh_connections(id, user_id);


--
-- Name: pe_ssh_connections pe_ssh_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_connections
    ADD CONSTRAINT pe_ssh_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_ssh_credential_versions pe_ssh_credential_versions_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_credential_versions
    ADD CONSTRAINT pe_ssh_credential_versions_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_ssh_connections(id, user_id);


--
-- Name: pe_ssh_connections pe_ssh_current_configuration; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_connections
    ADD CONSTRAINT pe_ssh_current_configuration FOREIGN KEY (id, user_id, revision, credential_revision) REFERENCES public.pe_ssh_configuration_versions(connection_id, user_id, revision, credential_revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_ssh_connections(id, user_id);


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.pe_sessions(id);


--
-- Name: pe_ssh_execute_actions pe_ssh_execute_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_execute_actions
    ADD CONSTRAINT pe_ssh_execute_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_ssh_management_requests pe_ssh_management_requests_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_management_requests
    ADD CONSTRAINT pe_ssh_management_requests_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_ssh_connections(id, user_id);


--
-- Name: pe_ssh_management_requests pe_ssh_management_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_management_requests
    ADD CONSTRAINT pe_ssh_management_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_ssh_updates pe_ssh_updates_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_updates
    ADD CONSTRAINT pe_ssh_updates_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_ssh_connections(id, user_id);


--
-- Name: pe_ssh_updates pe_ssh_updates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_updates
    ADD CONSTRAINT pe_ssh_updates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_ssh_upload_intents pe_ssh_upload_intents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_upload_intents
    ADD CONSTRAINT pe_ssh_upload_intents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_ssh_upload_intents pe_ssh_upload_request; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_ssh_upload_intents
    ADD CONSTRAINT pe_ssh_upload_request FOREIGN KEY (user_id, request_id) REFERENCES public.pe_ssh_management_requests(user_id, request_id);


--
-- Name: pe_stdio_mcp_calls pe_stdio_mcp_calls_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_calls
    ADD CONSTRAINT pe_stdio_mcp_calls_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_stdio_mcp_connections(id, user_id);


--
-- Name: pe_stdio_mcp_calls pe_stdio_mcp_calls_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_calls
    ADD CONSTRAINT pe_stdio_mcp_calls_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.pe_operations(id);


--
-- Name: pe_stdio_mcp_calls pe_stdio_mcp_calls_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_calls
    ADD CONSTRAINT pe_stdio_mcp_calls_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_stdio_mcp_connections pe_stdio_mcp_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_connections
    ADD CONSTRAINT pe_stdio_mcp_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_stdio_mcp_updates pe_stdio_mcp_updates_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_updates
    ADD CONSTRAINT pe_stdio_mcp_updates_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_stdio_mcp_connections(id, user_id);


--
-- Name: pe_stdio_mcp_updates pe_stdio_mcp_updates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_mcp_updates
    ADD CONSTRAINT pe_stdio_mcp_updates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_cloud_execution; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_cloud_execution FOREIGN KEY (cloud_execution_id, user_id, session_id, phase, id) REFERENCES public.pe_cloud_executions(id, user_id, session_id, stdio_phase, stdio_action_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_connection_id_user_id_config_revision__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_connection_id_user_id_config_revision__fkey FOREIGN KEY (connection_id, user_id, config_revision, config_digest) REFERENCES public.pe_stdio_v2_configurations(connection_id, user_id, revision, config_digest);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_operation_id_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_operation_id_session_id_fkey FOREIGN KEY (operation_id, session_id) REFERENCES public.pe_operations(id, session_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_root_operation_id_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_root_operation_id_session_id_fkey FOREIGN KEY (root_operation_id, session_id) REFERENCES public.pe_operations(id, session_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_session_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_session_id_user_id_fkey FOREIGN KEY (session_id, user_id) REFERENCES public.pe_sessions(id, user_id);


--
-- Name: pe_stdio_v2_actions pe_stdio_v2_actions_user_id_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_actions
    ADD CONSTRAINT pe_stdio_v2_actions_user_id_request_id_fkey FOREIGN KEY (user_id, request_id) REFERENCES public.pe_stdio_v2_management_requests(user_id, request_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: pe_stdio_v2_catalogs pe_stdio_v2_catalogs_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_catalogs
    ADD CONSTRAINT pe_stdio_v2_catalogs_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.pe_stdio_v2_results(action_id);


--
-- Name: pe_stdio_v2_catalogs pe_stdio_v2_catalogs_action_id_user_id_session_id_connecti_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_catalogs
    ADD CONSTRAINT pe_stdio_v2_catalogs_action_id_user_id_session_id_connecti_fkey FOREIGN KEY (action_id, user_id, session_id, connection_id, config_revision, config_digest, phase) REFERENCES public.pe_stdio_v2_actions(id, user_id, session_id, connection_id, config_revision, config_digest, phase);


--
-- Name: pe_stdio_v2_catalogs pe_stdio_v2_catalogs_connection_id_user_id_config_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_catalogs
    ADD CONSTRAINT pe_stdio_v2_catalogs_connection_id_user_id_config_revision_fkey FOREIGN KEY (connection_id, user_id, config_revision, config_digest) REFERENCES public.pe_stdio_v2_configurations(connection_id, user_id, revision, config_digest);


--
-- Name: pe_stdio_v2_configurations pe_stdio_v2_configurations_connection_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_configurations
    ADD CONSTRAINT pe_stdio_v2_configurations_connection_id_user_id_fkey FOREIGN KEY (connection_id, user_id) REFERENCES public.pe_stdio_v2_connections(id, user_id);


--
-- Name: pe_stdio_v2_connections pe_stdio_v2_connections_current_catalog; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_connections
    ADD CONSTRAINT pe_stdio_v2_connections_current_catalog FOREIGN KEY (current_catalog_id, user_id, id, revision) REFERENCES public.pe_stdio_v2_catalogs(id, user_id, connection_id, config_revision);


--
-- Name: pe_stdio_v2_connections pe_stdio_v2_connections_current_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_connections
    ADD CONSTRAINT pe_stdio_v2_connections_current_config FOREIGN KEY (id, user_id, revision) REFERENCES public.pe_stdio_v2_configurations(connection_id, user_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: pe_stdio_v2_connections pe_stdio_v2_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_connections
    ADD CONSTRAINT pe_stdio_v2_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_stdio_v2_decisions pe_stdio_v2_decisions_action_id_user_id_fingerprint_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_decisions
    ADD CONSTRAINT pe_stdio_v2_decisions_action_id_user_id_fingerprint_fkey FOREIGN KEY (action_id, user_id, fingerprint) REFERENCES public.pe_stdio_v2_preparations(action_id, user_id, fingerprint);


--
-- Name: pe_stdio_v2_dispatches pe_stdio_v2_dispatches_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_dispatches
    ADD CONSTRAINT pe_stdio_v2_dispatches_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.pe_stdio_v2_start_permits(action_id);


--
-- Name: pe_stdio_v2_management_requests pe_stdio_v2_management_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_management_requests
    ADD CONSTRAINT pe_stdio_v2_management_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_stdio_v2_no_start_closures pe_stdio_v2_no_start_closures_action_id_user_id_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_no_start_closures
    ADD CONSTRAINT pe_stdio_v2_no_start_closures_action_id_user_id_session_id_fkey FOREIGN KEY (action_id, user_id, session_id, phase, execution_target, execution_id, task_digest) REFERENCES public.pe_stdio_v2_actions(id, user_id, session_id, phase, execution_target, execution_id, task_digest);


--
-- Name: pe_stdio_v2_observations pe_stdio_v2_observations_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_observations
    ADD CONSTRAINT pe_stdio_v2_observations_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.pe_stdio_v2_actions(id);


--
-- Name: pe_stdio_v2_preparations pe_stdio_v2_preparations_action_id_user_id_session_id_phas_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_preparations
    ADD CONSTRAINT pe_stdio_v2_preparations_action_id_user_id_session_id_phas_fkey FOREIGN KEY (action_id, user_id, session_id, phase, execution_target, execution_id, task_digest) REFERENCES public.pe_stdio_v2_actions(id, user_id, session_id, phase, execution_target, execution_id, task_digest);


--
-- Name: pe_stdio_v2_results pe_stdio_v2_results_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_results
    ADD CONSTRAINT pe_stdio_v2_results_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.pe_stdio_v2_actions(id);


--
-- Name: pe_stdio_v2_start_permits pe_stdio_v2_start_permits_action_id_decision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_start_permits
    ADD CONSTRAINT pe_stdio_v2_start_permits_action_id_decision_fkey FOREIGN KEY (action_id, decision) REFERENCES public.pe_stdio_v2_decisions(action_id, decision);


--
-- Name: pe_stdio_v2_start_permits pe_stdio_v2_start_permits_action_id_execution_id_task_dige_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_stdio_v2_start_permits
    ADD CONSTRAINT pe_stdio_v2_start_permits_action_id_execution_id_task_dige_fkey FOREIGN KEY (action_id, execution_id, task_digest, prepared_digest, fingerprint, expires_at) REFERENCES public.pe_stdio_v2_preparations(action_id, execution_id, task_digest, prepared_digest, fingerprint, expires_at);


--
-- Name: pe_storage_spaces pe_storage_spaces_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_storage_spaces
    ADD CONSTRAINT pe_storage_spaces_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_user_models pe_user_models_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_models
    ADD CONSTRAINT pe_user_models_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_user_plugins pe_user_plugins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_plugins
    ADD CONSTRAINT pe_user_plugins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_user_skills pe_user_skills_package_version; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_skills
    ADD CONSTRAINT pe_user_skills_package_version FOREIGN KEY (package_version_id, user_id) REFERENCES public.pe_skill_package_versions(id, user_id);


--
-- Name: pe_user_skills pe_user_skills_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_user_skills
    ADD CONSTRAINT pe_user_skills_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- Name: pe_workspace_bindings pe_workspace_bindings_space_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_workspace_bindings
    ADD CONSTRAINT pe_workspace_bindings_space_id_user_id_fkey FOREIGN KEY (space_id, user_id) REFERENCES public.pe_storage_spaces(id, user_id);


--
-- Name: pe_workspace_bindings pe_workspace_bindings_workspace_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_workspace_bindings
    ADD CONSTRAINT pe_workspace_bindings_workspace_id_user_id_fkey FOREIGN KEY (workspace_id, user_id) REFERENCES public.pe_workspaces(id, user_id);


--
-- Name: pe_workspaces pe_workspaces_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_workspaces
    ADD CONSTRAINT pe_workspaces_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.pe_users(id);


--
-- PostgreSQL database dump complete
--

-- Native browser preferences are tenant-owned; they never modify a shared DSH Profile.
CREATE TABLE public.pe_native_preferences (
  user_id uuid NOT NULL REFERENCES public.pe_users(id),
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 200),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, namespace)
);
