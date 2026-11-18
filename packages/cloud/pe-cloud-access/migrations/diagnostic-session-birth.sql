CREATE TABLE IF NOT EXISTS public.pe_diagnostic_session_birth (
  account_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  path text NOT NULL,
  identity text NOT NULL,
  prefix_bytes integer NOT NULL CHECK (prefix_bytes BETWEEN 1 AND 4096),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (account_id, session_id)
);
