-- User-provided datasets: every dataset lives in its OWN schema (ds_<hex>) with its OWN read-only role, and every
-- application row (history, embeddings) is tagged with the dataset it belongs to.
-- The built-in e-commerce demo is the dataset with id 'demo' (schema `shop`, role `nl2sql_readonly`).

CREATE TABLE nl2sql.datasets (
  id                        text PRIMARY KEY,                       -- 'demo' or ds_<hex>
  name                      text NOT NULL,
  source_type               text NOT NULL CHECK (source_type IN ('builtin','sql','csv')),
  status                    text NOT NULL CHECK (status IN ('processing','ready','failed','deleted')),
  schema_name               text NOT NULL UNIQUE,                   -- PostgreSQL schema holding the tables
  role_name                 text,                                   -- dedicated read-only role (NULL for the demo)
  session_id                text,                                   -- anonymous owner; NULL = visible to everyone (demo)
  client_hash               text,                                   -- salted IP hash, upload rate limiting only
  table_count               integer NOT NULL DEFAULT 0,
  column_count              integer NOT NULL DEFAULT 0,
  row_count                 bigint  NOT NULL DEFAULT 0,
  relationship_count        integer NOT NULL DEFAULT 0,
  error                     text,
  metadata                  jsonb,                                  -- the generated metadata registry
  suggested_relationships   jsonb,                                  -- CSV: candidate foreign keys awaiting user confirmation
  embedding_status          text,                                   -- 'embedded' | 'skipped: <reason>'
  descriptions_generated_by text,                                   -- NULL | 'llm'
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_datasets_session ON nl2sql.datasets(session_id, created_at DESC);
CREATE INDEX idx_datasets_client  ON nl2sql.datasets(client_hash, created_at DESC);
ALTER TABLE nl2sql.datasets ENABLE ROW LEVEL SECURITY;              -- no policies: only the owner connection can read it

INSERT INTO nl2sql.datasets (id, name, source_type, status, schema_name, table_count)
VALUES ('demo', 'E-commerce Demo', 'builtin', 'ready', 'shop', 20);

-- Query history remembers which dataset each question ran against.
ALTER TABLE nl2sql.query_runs ADD COLUMN dataset_id text NOT NULL DEFAULT 'demo';
CREATE INDEX idx_query_runs_dataset ON nl2sql.query_runs(session_id, dataset_id, created_at DESC);

-- Embeddings are scoped by dataset: PRIMARY KEY (dataset_id, item_id), and every search filters on dataset_id.
ALTER TABLE nl2sql.metadata_embeddings ADD COLUMN dataset_id text NOT NULL DEFAULT 'demo';
ALTER TABLE nl2sql.metadata_embeddings DROP CONSTRAINT metadata_embeddings_pkey;
ALTER TABLE nl2sql.metadata_embeddings ADD PRIMARY KEY (dataset_id, item_id);
CREATE INDEX idx_metadata_embeddings_dataset ON nl2sql.metadata_embeddings(dataset_id);
