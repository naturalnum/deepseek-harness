-- Adjacent, disposable cross-Host native assistant presentation.
-- Canonical Session events remain in pe_events; JSON text preserves native strings.
CREATE TABLE pe_native_presentations (
  session_id uuid PRIMARY KEY REFERENCES pe_sessions(id) ON DELETE CASCADE,
  epoch integer NOT NULL CHECK (epoch > 0),
  publisher_id uuid NOT NULL,
  last_ordinal bigint NOT NULL CHECK (last_ordinal >= 0 AND last_ordinal <= 9007199254740991),
  state_json text NOT NULL,
  last_batch_id uuid,
  last_batch_json text,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((last_batch_id IS NULL) = (last_batch_json IS NULL))
);
CREATE TABLE pe_native_presentation_entries (
  session_id uuid NOT NULL REFERENCES pe_native_presentations(session_id) ON DELETE CASCADE,
  ordinal bigint NOT NULL CHECK (ordinal > 0 AND ordinal <= 9007199254740991),
  item_json text NOT NULL,
  item_bytes integer NOT NULL CHECK (item_bytes > 0),
  PRIMARY KEY(session_id,ordinal),
  CHECK (item_bytes = octet_length(item_json))
);
