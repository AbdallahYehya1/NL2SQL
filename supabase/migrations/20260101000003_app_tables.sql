-- Application tables (schema nl2sql).

-- pgvector may live in `public` (plain PostgreSQL) or `extensions` (Supabase): make both visible for the vector type / operator class.
SET LOCAL search_path = nl2sql, public, extensions;

CREATE TABLE nl2sql.query_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         text,                -- anonymous per-browser id (cookie); scopes the history list
  client_hash        text,                -- salted hash of the client IP; used only for rate limiting
  user_question      text NOT NULL,
  generated_sql      text,
  tables_used        text[] NOT NULL DEFAULT '{}',
  columns_used       text[] NOT NULL DEFAULT '{}',
  attempt_count      integer NOT NULL DEFAULT 0,
  status             text NOT NULL CHECK (status IN ('success','no_results','out_of_scope','needs_clarification','error')),
  error              text,
  answer             text,
  row_count          integer,             -- only the count is stored, never the result rows
  execution_time_ms  integer,
  total_latency_ms   integer,
  provider           text,
  model              text,
  trace              jsonb,               -- full agent trace (see docs/AI_PIPELINE.md)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_query_runs_session ON nl2sql.query_runs(session_id, created_at DESC);
CREATE INDEX idx_query_runs_client  ON nl2sql.query_runs(client_hash, created_at DESC);

CREATE TABLE nl2sql.feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES nl2sql.query_runs(id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating IN (-1, 1)),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Embeddings of registry metadata for semantic retrieval. 768 dimensions (see docs/DECISIONS.md).
CREATE TABLE nl2sql.metadata_embeddings (
  item_id       text PRIMARY KEY,         -- e.g. "table:orders", "column:orders.status", "metric:revenue"
  kind          text NOT NULL CHECK (kind IN ('table','column','metric')),
  table_name    text,
  column_name   text,
  content       text NOT NULL,
  content_hash  text NOT NULL,
  model         text NOT NULL,
  embedding     vector(768) NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_metadata_embeddings_hnsw
  ON nl2sql.metadata_embeddings USING hnsw (embedding vector_cosine_ops);
