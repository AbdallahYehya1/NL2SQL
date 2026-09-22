-- Extensions and schemas.
--   shop   : the demo e-commerce / retail analytics domain (what users ask questions about)
--   nl2sql : application tables (query history, embeddings, feedback)
-- Neither schema is exposed through the Supabase Data API (which only exposes `public` by default).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS shop;
CREATE SCHEMA IF NOT EXISTS nl2sql;
