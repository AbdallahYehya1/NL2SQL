# Design decisions

Short records of the choices that shaped the project, with the trade-off made. Written to be explainable in an interview.

## 1. Modular monolith on Next.js, not a separate backend

Route handlers call plain TypeScript modules. One deployable, one language, free on Vercel, trivial local setup.
Modules under `src/lib` do not import Next.js (except `http.ts`), so they can move to FastAPI later.
*Trade-off:* long LLM calls run inside a serverless function (`maxDuration = 60`); a queue/worker would be needed
for very slow models.

## 2. Direct `pg` connection instead of `supabase-js` / PostgREST

The pipeline needs raw SQL execution with `SET LOCAL ROLE`, `READ ONLY` transactions, cursors and pgvector queries —
none of which the REST API offers. So the app uses `DATABASE_URL` (Supabase pooler or any Postgres) and **no Supabase
client library**. Consequently the example env file has no `NEXT_PUBLIC_SUPABASE_*` keys: they would be unused, and
"include only required variables" applies. Supabase provides Postgres, pgvector, RLS and management.
*Trade-off:* Supabase Auth is not wired in (see 10).

## 3. Two schemas, one read-only role, RLS everywhere

`shop` (demo data, readable by LLM SQL) and `nl2sql` (history/embeddings, not readable). Generated SQL executes as
`nl2sql_readonly`. This makes the *database* enforce read-only and table scope even if the validator had a bug
(tested by bypassing it). See [SECURITY.md](SECURITY.md).

## 4. AST-based validation with libpg-query

Regex/keyword filters are trivially bypassed (comments, casing, unicode, CTE-wrapped writes). PostgreSQL's own parser,
compiled to WASM, means the validator and the server agree on syntax. The function policy is an **allow-list**.
*Trade-off:* a ~1 MB WASM dependency and a possible false rejection of an exotic function (the correction loop handles it).

## 5. Hybrid retrieval with a guaranteed lexical fallback

Vector search (pgvector) finds semantic matches (“biggest spenders” → customer lifetime value); lexical search finds
exact names, synonyms and phrases. Blending them is stronger than either, but embeddings need an API and a one-off
sync, so the system must run without them: no `EMBEDDING_MODEL` → lexical only, and the trace says why. I do not claim
semantic search in a deployment where embeddings are not configured. Embedding size is fixed at **768** because a
pgvector column has a fixed dimension; 768 is native for many open models and requestable (`dimensions`) from
OpenAI/Gemini embeddings.

## 6. Routing is deterministic; there is no LLM “routing” prompt

The brief lists a *metadata routing* prompt. I chose not to spend an LLM round-trip on it: lexical + vector scores
plus foreign-key graph expansion select tables in a few milliseconds, are fully reproducible, are unit-tested, and
score 100 % table recall on the benchmark (39/39, see [EVALUATION.md](EVALUATION.md) for the caveat about tuning on it).
The LLM still influences routing through the analyzer's `concepts`/`search_terms`. An LLM re-ranker would be a
straightforward addition behind a flag if a larger schema needed it.

## 7. Business semantics live in the registry, not in the prompt text

“Revenue” could mean gross/net, online/in-store, completed/all orders. Those definitions are data
(`definitions.ts → METRICS/DEFAULTS`), retrieved with the question and rendered into the prompt. Answers are therefore
consistent across questions (`SUM(order_items.line_total)` over completed orders everywhere), and changing a definition
is a one-line edit. `orders.total_amount` is defined as the sum of line totals so order-level and line-level revenue agree.

## 8. Ambiguity: clarify only when it matters, otherwise a documented default

Bare “What were the sales?” → clarification with options. “Top 5 products by sales” → default to online revenue, recorded
as an assumption. Deterministic guards override the model in both directions when lexical evidence is strong (≥ 2 registry
terms, or a named business measure): observed with a real free model during evaluation — it asked for a period on
“top 5 products by revenue” and declared “How many customers came from each acquisition channel?” out of scope. Weak
evidence (0–1 domain terms) still defers to the model, so “How many people live in Cairo?” is refused.
*Trade-off:* a determined user could phrase an off-topic question with two domain words; the SQL then simply returns
whatever the schema can answer, and all safety layers still apply.

## 9. Bounded self-correction: 3 SQL attempts

`MAX_SQL_ATTEMPTS = 3` means one generation plus up to two repairs (configurable to 5). The correction agent must return a
`diagnosis` before the fix, sees earlier failures, and is stopped if it repeats a failed query. Write attempts are never
“corrected”. Three attempts fit the 60 s serverless budget with a free model.

## 10. No authentication in the MVP

Auth would not change the NL2SQL logic and the data is a public demo. Instead: per-browser anonymous session cookie for
history, DB-backed IP-hash rate limiting, and a read-only sandbox. Adding Supabase Auth later means replacing
`getSessionId()` and adding RLS policies keyed on `auth.uid()` for `nl2sql.query_runs`.

## 11. Integer ids, deterministic seed anchored to “today”

Readable results and reproducible data. Data is generated for the 24 months ending on the seed date so relative-date
questions (“last month”) always return rows; the anchor can be pinned with `SEED_ANCHOR_DATE`.

## 12. Result summaries are grounded or discarded

A model may only restate numbers present in the rows. A check extracts every number in its text and compares with the
data; any invented figure causes fallback to a deterministic summary. Empty results never reach the model.

## 13. Own small UI kit instead of the shadcn CLI

The components (`Button`, `Card`, `Badge`, `Skeleton`) follow shadcn/ui conventions (Tailwind, `cva`, `cn`) but were
written by hand: the project needs four primitives and the CLI needs network access and interactive prompts.

## 14. Tests use test doubles only for the LLM

Unit/integration tests inject a scripted `AIProvider` (and a hashing embedder for pgvector plumbing) so control flow is
deterministic; **everything else is real** (real PostgreSQL, real validator, real executor). The application itself never
contains mock AI responses or fake data. LLM-dependent quality metrics come from `npm run eval -- --live` against a real
model, and only actually measured numbers are documented.

## 15. Datasets: a schema and a role per dataset, and a context object instead of globals

Uploaded data lives in its own PostgreSQL schema with its own NOLOGIN read-only role, so isolation is enforced by the **database**
(privileges), not only by the validator. I considered one shared schema with a `dataset_id` column (needs rewriting every query) and a
database per dataset (impossible on Supabase free tier). To make the engine generic the demo-specific globals were replaced by a
`DatasetContext` (schema, role, registry, indexes) that every stage receives; the demo is simply the context with id `demo`, and
documented defaults became data (`always`/`whenTables`/`whenMetrics`). *Trade-off:* roles are cluster-level objects that must be cleaned up
(delete, TTL, `db:reset`), and creating roles needs `CREATEROLE`.

## 16. Uploaded SQL is validated, not sandboxed

Executing arbitrary uploaded SQL, even in a fresh schema, leaves too much surface (functions, `DO`, `COPY PROGRAM`, extensions, other schemas).
Instead the whole file is parsed by PostgreSQL's own parser and only a small allow-list of relational DDL plus literal `INSERT`s is ever
executed — all or nothing — with `public.` prefixes removed via AST locations. `COPY`, functions, views, enums and arrays are deliberately unsupported.
*Trade-off:* real-world dumps (pg_dump with COPY, sequences, enums) must be simplified by hand.

## 17. CSV relationships are suggestions until confirmed

A column called `customer_id` is not proof of a foreign key. The importer suggests a relationship only when the target key is unique and
non-null and **every** value exists in it (checked with SQL), shows the evidence, and adds nothing to the metadata until the user confirms
— at which point it becomes a real constraint the database enforces.

## 18. Metadata for uploads: structure from the catalog, words optionally from an LLM

Structure (types, keys, relationships, counts) always comes from `pg_catalog`. Descriptions come from `COMMENT ON`, else a deterministic
template, else (opt-in) an LLM that sees names/types only and whose output is filtered against the real structure and labelled AI-generated.
Sample values are bounded and categorical-only, and dropped for anything that looks personal.

## 19. Test the deployment permission model, not just the code

Every test ran as a PostgreSQL superuser, but Supabase's `postgres` role is not one and installs pgvector in an `extensions` schema. Instead of
asserting "should work", `managed-postgres-permissions.test.ts` runs the migrations, seed, dataset import, isolation checks, deletion and TTL purge as a
`CREATEROLE` non-superuser with the extension in its own schema and a dedicated read-only login. It immediately found a real bug (a session-level
`SET search_path` in a migration leaked into the next one), which would have broken the first Supabase deploy. *Trade-off:* it is a simulation on
vanilla PostgreSQL; it proves nothing about Supabase's pooler or platform restrictions, and the docs say so.

## 20. The held-out benchmark is frozen before it is run, and gold answers never enter the engine

The 39-question development benchmark was used to tune the system, so it cannot be presented as independent accuracy. A second benchmark
(40 questions on two uploaded datasets and the demo) was written first, checked for unambiguous gold answers (no ties at top-N boundaries, an independent
JavaScript oracle for a subset of gold queries, a test that no question or gold SQL appears anywhere in `src/`), and then run **once** before any
analysis-driven change. Later changes are reported as post-analysis runs, not as held-out results. Datasets are synthetic and seeded, so gold answers are
reproducible; alternatives (a month as a date or as a number) are declared in the fixture, not guessed by the comparer.

## 21. Result rows of uploaded data stay in the app

The privacy promise ("only bounded metadata reaches the LLM") was false for the result summary, which sent up to 25 rows to the model. For uploaded
datasets the summary is now always deterministic (built locally from the rows); the model-written summary remains an option for the built-in synthetic
demo only. *Trade-off:* uploaded-data answers read a little more mechanically.

## 22. Catalog names are refused before the dataset is consulted

PostgreSQL resolves an unqualified `pg_class` to `pg_catalog` even when a schema on the `search_path` has a table with that name, so "is this name in the dataset?" is
the wrong first question. The validator asks "is this a system name?" first, and uploads may not create such tables. The database role cannot hide catalog *names* (every
role can read `pg_catalog`), so this remains a validator-level guarantee, and a test documents that limit.
