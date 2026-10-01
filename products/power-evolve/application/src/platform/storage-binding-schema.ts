/** V27 separates stable Workspaces from owned POSIX storage and retains recovery intent. */
export const schemaV27 = `
CREATE TABLE pe_storage_spaces (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  root_key uuid NOT NULL UNIQUE, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  is_default boolean NOT NULL DEFAULT false,
  root_state text NOT NULL CHECK(root_state IN ('provisioning','ready')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id)
);
CREATE UNIQUE INDEX pe_storage_spaces_default ON pe_storage_spaces(user_id) WHERE is_default;
CREATE FUNCTION pe_storage_root_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.root_key IS DISTINCT FROM OLD.root_key OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Storage root identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_storage_root_immutable BEFORE UPDATE OF root_key,user_id ON pe_storage_spaces
  FOR EACH ROW EXECUTE FUNCTION pe_storage_root_immutable();
INSERT INTO pe_storage_spaces(id,user_id,root_key,title,is_default,root_state,created_at)
  SELECT id,user_id,id,title,false,'ready',created_at FROM pe_workspaces;
ALTER TABLE pe_workspaces ADD COLUMN binding_generation bigint NOT NULL DEFAULT 1 CHECK(binding_generation>=1);
ALTER TABLE pe_workspaces ADD COLUMN binding_state text NOT NULL DEFAULT 'provisioning'
  CHECK(binding_state IN ('provisioning','ready','missing','recovering','blocked'));
ALTER TABLE pe_workspaces ADD COLUMN recovery_request_id uuid;
ALTER TABLE pe_workspaces ADD COLUMN create_storage_target jsonb;
ALTER TABLE pe_workspaces ADD COLUMN binding_updated_at timestamptz NOT NULL DEFAULT now();
UPDATE pe_workspaces SET binding_state='ready';
CREATE TABLE pe_workspace_bindings (
  workspace_id uuid PRIMARY KEY, user_id uuid NOT NULL,
  space_id uuid NOT NULL, root_relative_path text NOT NULL DEFAULT '' CHECK(length(root_relative_path)<=512),
  FOREIGN KEY(workspace_id,user_id) REFERENCES pe_workspaces(id,user_id),
  FOREIGN KEY(space_id,user_id) REFERENCES pe_storage_spaces(id,user_id)
);
CREATE INDEX pe_workspace_bindings_space ON pe_workspace_bindings(space_id,root_relative_path);
INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path)
  SELECT id,user_id,id,'' FROM pe_workspaces;
CREATE TABLE pe_storage_directory_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  space_id uuid NOT NULL, parent_path text NOT NULL, name text NOT NULL,
  state text NOT NULL CHECK(state IN ('accepted','completed')), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id), FOREIGN KEY(space_id,user_id) REFERENCES pe_storage_spaces(id,user_id),
  CHECK((state='completed')=(result IS NOT NULL))
);
CREATE TABLE pe_workspace_binding_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL, workspace_id uuid NOT NULL,
  space_id uuid NOT NULL, root_relative_path text NOT NULL CHECK(length(root_relative_path)<=512),
  expected_generation bigint NOT NULL CHECK(expected_generation>=1),
  state text NOT NULL CHECK(state IN ('accepted','stopping','completed','blocked')),
  stop_target jsonb NOT NULL, stop_proof jsonb,
  lease_owner uuid, lease_until timestamptz, lease_epoch bigint NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),
  error_code text, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id), UNIQUE(user_id,request_id,workspace_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES pe_workspaces(id,user_id),
  FOREIGN KEY(space_id,user_id) REFERENCES pe_storage_spaces(id,user_id),
  CHECK((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK((state='completed')=(result IS NOT NULL)),
  CHECK((state='blocked')=(error_code IS NOT NULL))
);
CREATE INDEX pe_workspace_binding_requests_pending ON pe_workspace_binding_requests(created_at)
  WHERE state IN ('accepted','stopping');
ALTER TABLE pe_workspaces ADD CONSTRAINT pe_workspace_recovery_request
  FOREIGN KEY(user_id,recovery_request_id,id)
  REFERENCES pe_workspace_binding_requests(user_id,request_id,workspace_id);
ALTER TABLE pe_file_mutations ADD COLUMN binding_generation bigint NOT NULL DEFAULT 1 CHECK(binding_generation>=1);
ALTER TABLE pe_mount_slots ADD COLUMN binding_snapshot jsonb;
ALTER TABLE pe_sandbox_instances ADD COLUMN binding_snapshot jsonb;
UPDATE pe_mount_slots m SET binding_snapshot=jsonb_build_object(
  'workspaceId',w.id,'spaceId',b.space_id,'rootKey',s.root_key,
  'rootRelativePath',b.root_relative_path,'generation',w.binding_generation)
  FROM pe_workspaces w JOIN pe_workspace_bindings b ON b.workspace_id=w.id
  JOIN pe_storage_spaces s ON s.id=b.space_id WHERE m.workspace_id=w.id AND m.state<>'free';
UPDATE pe_sandbox_instances i SET binding_snapshot=jsonb_build_object(
  'workspaceId',w.id,'spaceId',b.space_id,'rootKey',s.root_key,
  'rootRelativePath',b.root_relative_path,'generation',w.binding_generation)
  FROM pe_sessions session JOIN pe_workspaces w ON w.id=session.workspace_id
  JOIN pe_workspace_bindings b ON b.workspace_id=w.id JOIN pe_storage_spaces s ON s.id=b.space_id
  WHERE i.session_id=session.id AND i.state<>'deleted';
UPDATE pe_schema SET version=27 WHERE version=26;
`
