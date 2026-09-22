# Security

Threat model: the SQL comes from an LLM that reads untrusted user text, so it must be treated as attacker-controlled.
**Nothing relies on the prompt saying “don't do bad things”.** Safety is enforced by deterministic code and by the
database, in layers, so that a failure of any single layer is not enough.

```
LLM output ──► 1 static checks ──► 2 real PostgreSQL parser + AST policy ──► 3 executor re-validation
                                                                                │
   4 read-only role  ◄── 5 READ ONLY txn ◄── 6 timeouts / row cap ◄────────────┘
```

## Layer 1 — static checks (`src/lib/database/validator.ts`)

* Empty SQL, > 4,000 characters, control characters → rejected.
* **Any comment** (`--`, `/* */`) → rejected (comments are the classic way to hide or split payloads).
* Bare write/DDL/admin keywords (`INSERT UPDATE DELETE MERGE DROP ALTER TRUNCATE CREATE GRANT REVOKE COPY CALL EXECUTE
  VACUUM …`) are rejected after string literals and quoted identifiers are blanked out, so `WHERE name = 'delete'` is fine.

## Layer 2 — AST validation

The SQL is parsed with **libpg-query — PostgreSQL's own parser compiled to WASM** — not with regexes, so the validator
and the server agree on what the text means. Then:

| Rule | Detail |
|------|--------|
| Exactly one statement | `SELECT 1; DROP TABLE x` → `MULTIPLE_STATEMENTS` |
| Root must be `SelectStmt` | `WITH … SELECT` allowed; `EXPLAIN`, `SET`, `DO`, `COPY`, transactions, … are not |
| No data-modifying nodes anywhere | `INSERT/UPDATE/DELETE/MERGE` inside CTEs are found by the tree walk |
| No `SELECT … INTO`, no `FOR UPDATE/SHARE` | |
| **Table allow-list** | Only the tables of the **selected dataset** (built from its registry; plus CTE names). Anything else → `UNKNOWN_TABLE` (with the list of real tables) |
| **Schema allow-list** | Unqualified or the selected dataset's own schema only (`shop` for the demo, `ds_<hex>` for an upload). `public.`, `nl2sql.`, another dataset's schema, `pg_catalog.`, `information_schema.`, `auth.`, cross-database → rejected |
| System catalogs | `pg_*` / `information_schema` → `SYSTEM_ACCESS`, checked **before** the dataset lookup (see audit finding 1) |
| **Function allow-list** | ~120 aggregate/window/math/string/date functions. `pg_sleep`, `set_config`, `pg_read_file`, `dblink`, `lo_*`, `nextval`, `version`, `current_setting`, `query_to_xml`, user-defined functions … are not on it |
| Session identity | `CURRENT_USER`, `SESSION_USER`, `CURRENT_SCHEMA`, … rejected |
| `::regclass` and other `reg*` casts, schema-qualified operators, `$1` parameters | rejected |
| Column existence | `alias.column` and single-table unqualified columns are checked against the registry → `UNKNOWN_COLUMN` (fast hallucination catch; the DB is the final judge for complex scopes) |
| Complexity | ≤ 15 tables, ≤ 8 CTEs, ≤ 6,000 AST nodes, nesting depth ≤ 60 |

`validateSql()` returns the cleaned SQL. `executeQuery()` only accepts the branded type `ValidatedSql`, so unvalidated
strings cannot be passed by mistake at compile time.

## Layer 3 — the executor re-validates

`executeQuery()` runs `validateSql()` again on whatever it is given. Even a caller that forges the brand (as the test
suite does on purpose) cannot execute anything the validator rejects (`VALIDATION_FAILED`). The lower-level
`runInSandbox()` exists only so tests can prove layers 4–6 work without layers 1–3.

## Layers 4–6 — the database refuses even if everything above failed

* **Dedicated least-privilege role `nl2sql_readonly`** (migration 4): `USAGE` on schema `shop`, `SELECT` on its tables,
  nothing else — no access to `nl2sql` (history, embeddings) or any other schema. Two ways to use it:
  * `READONLY_DATABASE_URL` — the connection *logs in as* that role (recommended in production), or
  * `SET LOCAL ROLE nl2sql_readonly` inside the transaction using `DATABASE_URL` (default; fails closed if the role
    is unavailable).
* **`BEGIN READ ONLY`** transaction, always `ROLLBACK`ed, so even a hypothetical write cannot commit.
* `statement_timeout` (default 8 s), `lock_timeout`, `idle_in_transaction_session_timeout`, and `search_path` pinned to `shop`.
* **Row cap**: results are fetched through a server-side cursor (`FETCH FORWARD maxRows+1`), so at most 201 rows ever
  leave the database, whatever the query. `truncated` is reported to the UI.

The integration tests (`tests/integration/executor.test.ts`) prove each of these against a real PostgreSQL: `DELETE`,
`UPDATE`, `INSERT`, `TRUNCATE`, `DROP`, `CREATE` and reads of `nl2sql.*` all fail *at the database* when the validator
is bypassed, and nothing persists.

## Uploaded datasets

Uploaded SQL/CSV is untrusted input too. Full description in [DATASET_UPLOAD.md](DATASET_UPLOAD.md); the security-relevant summary:

| Threat | Control | Test |
|--------|---------|------|
| Uploaded SQL modifies / reads application tables (`nl2sql.*`) | Whole file parsed with PostgreSQL's parser and checked against an allow-list **before any execution**; any qualified name other than `public.` is rejected; `DROP`, `DELETE`, `GRANT`, `COPY`, roles, extensions, FDW, `DO`, functions … are rejected (*"This SQL file contains unsupported statements."*). No partial execution | `tests/unit/sql-import.test.ts`, `tests/integration/datasets.test.ts` (application tables unchanged, no schema/role left) |
| Uploaded SQL escapes its schema | Executed in one transaction on a fresh schema with `search_path` pinned; `public.` prefixes removed AST-guided; tripwire aborts if relations appear outside the schema | integration |
| Admin / file / network features | `COPY … PROGRAM`, server-side files, extensions, FDW, roles are not in the allow-list | unit |
| Cross-dataset access (A reads B) | Per-dataset schema **and** per-dataset NOLOGIN role; validator allow-list built from the selected dataset; executor re-validates; verified with validation bypassed | integration ("Dataset A cannot query Dataset B") |
| Access to another user's dataset | Ownership check on every load/query/delete (anonymous session); unknown or foreign ids answer "not found" | integration |
| Injection through names | CSV table/column names are sanitised to `[a-z0-9_]`, identifiers always quoted, values bound as parameters; generated schema/role names are validated (`ds_<hex>`) before use | unit |
| Resource abuse | 4 MB / 50k rows / 30 tables / 60 columns limits, 45 s import timeout, 5 datasets per session, 6 uploads per client-hour, 72 h expiry | integration |
| Sensitive data leaking to the LLM or metadata | The model sees the question, the names/types/descriptions of the relevant tables and columns and a few bounded example values (categorical-only, dropped for PII-looking columns/values) — never whole tables. **Result rows of an uploaded dataset are never sent to the model** (their summary is built locally). The optional AI-written descriptions use structure only. Uploaded content is never logged; history stores no rows | unit (`orchestrator.test.ts`, `dataset-engine.test.ts`) + integration |
| Uploaded table named like a system catalog (`pg_class`) shadows `pg_catalog` | Rejected at upload (SQL) / prefixed (CSV); the validator also refuses catalog names before consulting the dataset | unit + integration (audit finding 1) |

## Defence in depth at query time — what stops what, and where it is tested

| # | Layer | Enforced by | Tested in |
|---|-------|-------------|-----------|
| 1 | Dataset ownership | `loadDatasetContext` (anonymous session cookie must own the dataset; foreign and unknown ids both answer "not found") | `datasets.test.ts`, `api-routes.test.ts` |
| 2 | Dataset status | only `ready` datasets are loadable (`processing` / `failed` → 409, `deleted` → 404) | `datasets.test.ts`, `api-routes.test.ts` |
| 3 | Dataset-specific AST validation | `validateSql(sql, dataset)` | `validator.test.ts`, `dataset-engine.test.ts` |
| 4 | Dataset-specific table / schema allow-list | built from the dataset's registry | `dataset-engine.test.ts`, `datasets.test.ts` |
| 5 | Read-only role | per-dataset NOLOGIN role with `USAGE`+`SELECT` on its schema only | `datasets.test.ts` (runs forbidden SQL with validation bypassed) |
| 6 | `READ ONLY` transaction | executor | `executor.test.ts`, `datasets.test.ts` |
| 7 | Statement timeout | `SET LOCAL statement_timeout` | `executor.test.ts` |
| 8 | Row cap | server-side cursor, at most `maxRows + 1` rows leave the database | `executor.test.ts` |
| 9 | Pinned `search_path` | the dataset schema only | `executor.test.ts` |
| 10 | Database-level isolation | roles + RLS (a dataset role cannot read another dataset, the demo, or `nl2sql`) | `datasets.test.ts`, `managed-postgres-permissions.test.ts` |

Isolation matrix that is asserted, with validation bypassed where the row says so: A→A allowed; A→B, B→A, A→`shop`, demo→A, A→`nl2sql` refused by the database; A→catalogs (`pg_*`, `information_schema`, `current_setting`, `set_config`, `pg_sleep`, `version()`, …) refused by the validator; every write form refused by the database.

## Security audit (final hardening pass)

This pass read the code and attacked it rather than re-reading the docs. Findings that were fixed, and limits that remain:

1. **Fixed — an uploaded table named like a system catalog could read the real catalog.** PostgreSQL always searches `pg_catalog` *first*, so with a dataset table called `pg_class`, the query `SELECT * FROM pg_class` was accepted by the validator (the name was "in the dataset") but resolved to the real catalog at run time (verified on a live server: 571 catalog rows instead of the dataset's 1). Impact: disclosure of other datasets' schema/table/column *names* (not row data). Fix in two layers: uploads with `pg_*` / `information_schema` table names are rejected (CSV file names are prefixed), and the validator now refuses catalog-looking names *before* consulting the dataset. Regression tests at unit and integration level.
2. **Fixed — documented rejections that were not enforced.** `INSERT … RETURNING` was accepted because the newer PostgreSQL grammar renamed the AST field the check looked at; `CREATE INDEX CONCURRENTLY` would only fail at run time (it cannot run in the import transaction). Both are now rejected up front, and a table-driven test of ~110 hostile statements (rules, policies, `ALTER SYSTEM`, large objects, `SET session_authorization`, catalog writes, psql meta-commands, …) asserts every one is rejected and that every *ignored* statement (`SET …`, `OWNER TO`, `COMMENT ON SCHEMA/ROLE`) produces nothing executable.
3. **Fixed — total upload size was only checked through the `Content-Length` header.** A chunked request bypassed it (each file could be under its own limit while the total exceeded 4 MB). The total is now enforced on the parsed files too. Unexpected import failures are now logged server-side; the user sees only a friendly reason.
4. **Fixed — privacy claim did not match the code.** The UI and docs said row data never reaches the model, but the result summary sent up to 25 result rows. For uploaded datasets the summary is now always built locally; the model receives only the question and (bounded) schema information.
5. **Limit, by design — catalog *names* are readable by any PostgreSQL role.** The dataset role cannot read other datasets' *data*, but PostgreSQL lets every role read `pg_catalog`, so schema/table names are visible at the database level. Protection against catalog access is therefore the validator's job (layers 3–4); this is asserted explicitly in `datasets.test.ts` ("KNOWN LIMIT").
6. **Limit — metadata is untrusted prompt input.** Table/column names and `COMMENT ON` text of an upload are placed into the LLM prompt. A hostile name could try to steer the model. The blast radius is the uploader's *own* session (datasets are private to it), and anything the model then writes still passes layers 3–10, so the worst case is a wrong or useless answer for the uploader, not access to anyone else's data.
7. **Verified — non-superuser deployment.** The application must not need superuser rights. `managed-postgres-permissions.test.ts` runs migrations, seeding, import (schema + role + grants + RLS), querying through a dedicated `nl2sql_readonly` login, isolation, deletion and TTL purge as a `CREATEROLE` non-superuser with pgvector in an `extensions` schema — the closest local model of Supabase. It found a real deployment bug (a session-level `SET search_path` in migration 2 hid `extensions` from migration 3), now fixed. This is a simulation, not a Supabase test (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## Row Level Security

RLS is enabled on every `shop`, `nl2sql` and uploaded-dataset table (each dataset table gets a `SELECT` policy for that dataset's role only). `shop` tables have one policy (`SELECT` for `nl2sql_readonly`);
`nl2sql` tables have **no** policies, so Supabase's `anon` / `authenticated` API roles can read nothing even if the schemas
were ever exposed. The server connects as the table owner, which bypasses RLS. A test asserts RLS is on for all 24 tables.

## Application-level controls

| Concern | Control |
|---------|---------|
| Secrets | All configuration is server-side env vars; **no** `NEXT_PUBLIC_*` variables exist. `.env*` is git-ignored except `.env.example`. `/api/health` reports only booleans/counts. |
| DB error leakage | Errors are classified by SQLSTATE; users see generic messages. The sanitised database message (connection strings, IPs, passwords scrubbed) is only shown to the correction agent and the trace. Connection-level errors are never exposed. |
| Prompt injection | The question is delimited in `<question>` tags and prompts say to treat it as data — but this is defence in depth only. Deterministic rules reject write requests / pasted SQL before any model call; anything the model then produces still goes through layers 1–6. |
| Write requests | “Delete all customers” and embedded commands such as “…; also drop table products” → rejected by rules before any LLM call (`out_of_scope`, read-only message). A model-generated write statement is rejected outright (`SQL_REJECTED`) and **never** sent to the correction agent. |
| Abuse / cost | DB-backed rate limit (12 questions/min per hashed client IP; the IP is stored only as a salted SHA-256), 500-character question cap, bounded correction loop, 4,000-character SQL cap, query timeout. |
| Privacy | `query_runs` stores the question, SQL and trace but **never result rows** (only the row count). History is scoped by an anonymous httpOnly session cookie. |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`; `X-Powered-By` removed. |
| Authentication | Deliberately out of scope for the MVP (public demo). The session cookie scopes history; it is not an auth mechanism. Add Supabase Auth before exposing non-demo data. |

## Test evidence

* `tests/unit/validator.test.ts` — 15 legitimate queries accepted; **64 malicious queries** (`tests/evaluation/unsafe-sql.ts`:
  DDL/DML, stacked statements, comment tricks, data-modifying CTEs, dangerous functions, system catalogs, other schemas, …)
  each rejected, with specific error codes.
* `tests/integration/executor.test.ts` — database-level refusal, timeout, row cap, dedicated login role.
* `tests/integration/pipeline.test.ts` — a model that emits `DELETE FROM customers` cannot change the database.
* `npm run eval` — unsafe-SQL rejection rate over the same 64 statements (see [EVALUATION.md](EVALUATION.md)).

## Known gaps

* Datasets are private to an **anonymous browser session** (httpOnly cookie), not to an authenticated user. Anyone who obtains the cookie owns the datasets; clearing cookies orphans them until the 72 h expiry.
* Uploaded names and comments are untrusted prompt input (finding 6).
* No compliance claim of any kind (HIPAA, GDPR, SOC 2, …) is made; the project is not designed for sensitive or production data.
* The column check is conservative: unqualified columns in multi-table queries are left to the database.
* The function allow-list may reject a legitimate but unusual function; the correction loop then asks for a rewrite.
* An expensive-but-valid query (large cross join within the 8 s timeout) still consumes database time; the
  timeout, row cap and rate limit bound the damage but do not eliminate it.
* No authentication; anyone with the URL can ask questions (subject to the rate limit).
