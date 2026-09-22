-- Least-privilege role used to execute LLM-generated SQL, plus Row Level Security.
--
-- nl2sql_readonly:
--   * has USAGE on schema `shop` and SELECT on its tables — nothing else
--   * has no access to schema nl2sql (history, embeddings) or any other schema
-- Login is NOT enabled here (no password in migrations). Either:
--   (a) set READONLY_DATABASE_URL and run: ALTER ROLE nl2sql_readonly LOGIN PASSWORD '...';   or
--   (b) leave it unset — the app then runs `SET LOCAL ROLE nl2sql_readonly` inside a READ ONLY transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nl2sql_readonly') THEN
    CREATE ROLE nl2sql_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- Allow the migrating/connecting user to `SET ROLE nl2sql_readonly` (option b). Harmless if already a member.
DO $$
BEGIN
  EXECUTE format('GRANT nl2sql_readonly TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not grant nl2sql_readonly to %: %', current_user, SQLERRM;
END
$$;

REVOKE ALL ON SCHEMA shop, nl2sql FROM PUBLIC;
GRANT USAGE ON SCHEMA shop TO nl2sql_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA shop TO nl2sql_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA shop GRANT SELECT ON TABLES TO nl2sql_readonly;

-- Row Level Security on every table. Only the read-only role gets an (unrestricted SELECT) policy on the
-- demo data; app tables get no policies, so the Supabase anon/authenticated roles see nothing even if
-- the schema were ever exposed. The server connects as the table owner, which bypasses RLS.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('shop', 'nl2sql') LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
    IF r.schemaname = 'shop' THEN
      EXECUTE format('CREATE POLICY readonly_select ON %I.%I FOR SELECT TO nl2sql_readonly USING (true)',
                     r.schemaname, r.tablename);
    END IF;
  END LOOP;
END
$$;
