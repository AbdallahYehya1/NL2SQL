-- Staging area for chunked dataset uploads. Vercel serverless functions reject request bodies over 4.5 MB, so a
-- large file is split into chunks client-side, POSTed one request at a time, and reassembled here once every chunk
-- has arrived (see src/lib/datasets/chunked-upload.ts). Rows are deleted once an upload finalizes (success or
-- failure) and any abandoned upload's rows are purged after a few hours (purgeStaleChunks, same pattern as
-- purgeExpiredDatasets for datasets themselves).

CREATE TABLE nl2sql.upload_chunks (
  upload_id     uuid    NOT NULL,
  session_id    text    NOT NULL,        -- owner check: a chunk can only be reassembled by the session that sent it
  file_index    integer NOT NULL,        -- 0-based position among the files in this upload
  file_name     text    NOT NULL,
  chunk_index   integer NOT NULL,        -- 0-based position within the file
  total_chunks  integer NOT NULL,
  chunk_bytes   bytea   NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, file_index, chunk_index)
);
CREATE INDEX idx_upload_chunks_created ON nl2sql.upload_chunks(created_at);
ALTER TABLE nl2sql.upload_chunks ENABLE ROW LEVEL SECURITY;   -- no policies: only the owner connection (admin pool) reads it
