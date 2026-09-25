# Agentic NL2SQL

A natural-language interface to relational databases. You ask a question in plain English; an **agentic pipeline** picks the relevant slice of the schema,
has an LLM write SQL, **validates it with PostgreSQL's own parser**, runs it **read-only in an isolated schema**, **repairs it if it fails**, and
explains the result with a full trace of every decision. It works on the built-in 20-table e-commerce demo **and on small SQL/CSV datasets that you upload** — each
one is imported into its own isolated PostgreSQL schema, its metadata is read back from the real catalog, and the same generic pipeline answers questions about it.

> Designed for **small synthetic datasets**, not for production database ingestion. See [Limitations](#limitations).

## What it does

```
question → dataset selection → question analysis → schema routing → minimal sub-schema
         → SQL generation → AST validation → read-only execution → self-correction loop → grounded answer
```

## Key capabilities

* **Dataset-aware, generic engine** — `processQuestion({ datasetId, question })`. The engine contains no table names; everything it knows about a dataset comes from a metadata registry (a test enforces this).
* **SQL / CSV dataset upload** — parse and validate the whole file first, import into an isolated schema in one transaction, introspect the real catalog, generate metadata, then ask questions.
* **PostgreSQL catalog introspection** — types, keys, relationships, row counts and bounded sample values come from `pg_catalog`, never from what the upload claims.
* **Metadata registry + hybrid schema retrieval** — lexical matching always; pgvector similarity when an embedding model is configured (off by default; not evaluated — see [Evaluation](#evaluation)).
* **Schema routing and a minimal sub-schema** — the LLM sees only the tables, columns and joins a question needs (2.2–2.7 tables on average, out of 9–20).
* **SQL AST validation** — single read-only `SELECT`, dataset-specific table/schema/function allow-lists, no comments, no writes anywhere in the tree.
* **Read-only execution in isolated dataset schemas** — per-dataset role, `READ ONLY` transaction, timeout, row cap, pinned `search_path`, Row Level Security.
* **Bounded self-correction** — the agent must *diagnose* the validator/database error before repairing; at most 3 attempts; never "repairs" a write.
* **Grounded answers, query history, execution trace** — model summaries are discarded if they invent a number; every run's trace is saved and shown.
* **Evaluation framework** — deterministic offline metrics, a live pipeline benchmark, a fault-injection test for self-correction, and a **held-out benchmark on uploaded datasets** (with confidence intervals).
* **Provider-agnostic** — any OpenAI-compatible API (OpenRouter, Groq, Gemini, Ollama, OpenAI, …) by environment variable; nothing is tied to one vendor.

## Architecture

**Asking a question** — every stage receives the selected dataset explicitly; nothing has a global "current dataset".

```mermaid
flowchart TD
    U([User]) --> DS["Dataset selection<br/>datasetId · ownership + status check"]
    DS --> QA["Question analysis<br/>deterministic rules + 1 LLM call"]
    QA -->|write request / off-topic / vague| STOP([Refusal or clarification<br/>no SQL generated])
    QA --> HR["Hybrid schema retrieval<br/>lexical always · vector if an embedder is configured"]
    HR --> SS["Minimal sub-schema<br/>routed tables + FK bridge tables"]
    SS --> GEN["SQL generation<br/>LLM, structured JSON"]
    GEN --> VAL["AST validation<br/>dataset-specific allow-list"]
    VAL --> EXE["Read-only execution<br/>dataset role · READ ONLY txn · timeout · row cap"]
    VAL -->|fixable issue| COR
    EXE -->|database error| COR["Self-correction loop<br/>diagnose → repair · ≤ 3 attempts"]
    COR --> VAL
    EXE --> FMT["Result formatting<br/>grounded summary"]
    FMT --> OUT([Answer · table · SQL · trace])
```

**Adding data** — uploads are untrusted; metadata is read back from the database, not from the file's claims.

```mermaid
flowchart LR
    UP(["SQL / CSV upload"]) --> V["Validate the whole file<br/>PostgreSQL AST allow-list · limits<br/>nothing is executed yet"]
    V --> ISO["Isolated dataset<br/>own schema ds_hex + own read-only role + RLS<br/>one transaction, all-or-nothing"]
    ISO --> INT["Catalog introspection<br/>types · keys · row counts · bounded samples"]
    INT --> META["Metadata registry<br/>descriptions: COMMENT ON › optional LLM › template"]
    META --> PIPE["The same generic pipeline<br/>processQuestion({ datasetId, question })"]
```

More: [Architecture](docs/ARCHITECTURE.md) · [AI pipeline](docs/AI_PIPELINE.md) · [Database](docs/DATABASE.md) · [Decisions](docs/DECISIONS.md).

## Dataset upload

Upload one `.sql` file (`CREATE TABLE`, constraints, `ALTER TABLE … ADD CONSTRAINT`, btree indexes, literal `INSERT … VALUES`, `COMMENT ON`) or 1–10 `.csv` files.
The **whole file is parsed and checked against an allow-list before anything runs**; a single unsupported statement (`DROP`, `GRANT`, `COPY`, roles, extensions, functions, other schemas, …) rejects the file with
*"This SQL file contains unsupported statements."* and nothing is executed. Accepted files are loaded into a fresh schema `ds_<hex>` with its own read-only role. CSV relationships are **only suggested**
(with evidence from the data) and become foreign keys only after you confirm them.

**Limits (demo-sized):** 40 MB per CSV/SQL file (files ≥ 4 MB upload automatically in chunks), 10 files, 30 tables, 400 columns, 300,000 rows, 45 s import, 5 datasets per browser session, 72 h lifetime.
**Synthetic, mock or non-sensitive data only.** Full details, supported syntax and the privacy model: [docs/DATASET_UPLOAD.md](docs/DATASET_UPLOAD.md).

## Security

LLM-written SQL is treated as attacker-controlled. Ten independent layers, each tested: dataset ownership → dataset status → dataset-specific AST validation → dataset-specific table/schema allow-list →
read-only role → `READ ONLY` transaction → statement timeout → row cap → pinned `search_path` → database-level isolation (roles + RLS). Isolation is asserted **with validation bypassed**, so it is the database — not just the
validator — that refuses cross-dataset reads, `nl2sql` access and every write. A dedicated audit pass found and fixed real defects (for example, an uploaded table named `pg_class` could have shadowed the system
catalog); they are listed in [docs/SECURITY.md](docs/SECURITY.md#security-audit-final-hardening-pass), together with the limits that remain.

## Evaluation

Different kinds of evidence, kept apart on purpose. **Every number below was produced by running this repository; nothing is simulated, cached or estimated.** Methodology, denominators and caveats: [docs/EVALUATION.md](docs/EVALUATION.md).

| Benchmark | What was measured | Result |
|-----------|-------------------|--------|
| **B. Held-out** — 40 questions, **2 uploaded datasets** (HR `.sql`, sales `.csv`) + demo; frozen before its first run; one run; free third-party model (self-reported `gpt-oss-20b`); lexical retrieval only; natural failures only | complete path: upload → import → introspection → metadata → routing → SQL → validation → execution → result | **29/32 answerable questions correct end to end = 90.6 %** (95 % CI 75.8–96.8); the automatic result-equality metric says 30/32, but one match was a coincidence found by reading the SQL. **All 30 generated queries were valid and executed on the first attempt.** The 2 misses were wrong *refusals* on colloquial wording. 8/8 negative questions produced no answer (7 refused by design, 1 provider-output error) and the databases were unchanged |
| **B. Upload path** — 74-file corpus, real importer | valid / malformed / malicious files | valid SQL 5/5 · valid CSV 6/6 · malformed rejected 13/13 · **malicious SQL rejected 50/50** · rejected files leaving residue 0 · CSV relationship suggestions 5 correct, 0 false (n = 5) |
| **A. Development** — 39 questions on the demo; **the system was tuned on these, so not independent** | offline: routing, validator, gold queries; live: full pipeline | offline: routing 39/39 (2.7 of 20 tables), 64/64 unsafe SQL rejected, 39/39 gold queries valid, 8/8 scope cases · live: 39/39 answered · execution accuracy 23/25 (one is a rounding-precision difference, one the known refunds time-attribution limitation) · 8/8 negatives · 4/4 adversarial prompts left the database unchanged · 0 natural corrections needed |
| **C. Fault injection** — 12 known-good queries deliberately broken (**injected**, not natural failures) | real correction agent repairing from real errors | **11/12 repaired and result-correct** (91.7 %, CI 64.6–98.5); the miss was a provider HTTP 502 during the correction call, not a wrong repair — re-measured 2026-09-21 |
| **Natural self-correction** | held-out run | **not exercised (n = 0)**: no generated query failed, so no natural correction rate can be reported |
| **Retrieval with embeddings** | — | **not evaluated** (no embedding model available); all routing numbers are lexical-only |
| Automated tests | unit + integration on a real PostgreSQL (CI: 16 and 17) | **397 unit + 153 integration = 550 passing** (integration also run on PostgreSQL 17: 153/153); lint, typecheck and the production build pass |

What the misses taught: uploaded schemas are answered well when their names are clear, and worst when the question's words (*earns*, *longest*, *come from*) do not appear in the metadata. Small samples, one model, one run — evidence, not a leaderboard score.

## Tech stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · React 19 · Recharts · PostgreSQL (tested on 16 and 17) with **pgvector** (optional retrieval) · `pg` · `libpg-query` (PostgreSQL's parser, WASM) · Zod ·
Vitest · ESLint. LLM access is a ~300-line OpenAI-compatible `fetch` client behind an `AIProvider` interface — no agent framework, no vendor SDK.

## Running locally

**Prerequisites:** Node.js ≥ 22, Docker (or a PostgreSQL 15+ with pgvector), and an LLM endpoint (an API key, a keyless OpenAI-compatible server, or a local Ollama).

```bash
# 1. PostgreSQL with pgvector
docker run -d --name nl2sql-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nl2sql \
  -p 127.0.0.1:54329:5432 pgvector/pgvector:pg16

# 2. Install and configure
npm install
cp .env.example .env.local
#    edit .env.local:  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/nl2sql
#                      AI_PROVIDER=openrouter  AI_MODEL=<a model id>  AI_API_KEY=<your key>

# 3. Create the schema and load the demo data
npm run db:migrate
npm run db:seed

# 4. Run
npm run dev              # http://localhost:3000
```

`GET /api/health` and the in-app banner tell you what is still missing. Tests and evaluation:

```bash
npm run lint && npm run typecheck
npm test                                  # unit tests (no services needed)
npm run test:integration                  # real PostgreSQL + pgvector; creates and drops its own databases
npm run eval                              # development benchmark, offline metrics (no LLM)
npm run eval -- --live                    # ... full pipeline with your LLM
npm run eval -- --faults                  # self-correction under injected faults
npm run eval:heldout                      # held-out benchmark, offline part (upload corpus, gold validity, routing)
npm run eval:heldout -- --live            # ... full pipeline on the uploaded datasets with your LLM
```

Integration tests expect a server at `TEST_ADMIN_URL` (default `postgresql://postgres:postgres@127.0.0.1:54329/postgres`, i.e. the Docker command above).

## Environment variables

| Variable | Required | Purpose |
|----------|:--------:|---------|
| `DATABASE_URL` | ✅ | Postgres/Supabase connection string (server-only) |
| `READONLY_DATABASE_URL` | – | Login as `nl2sql_readonly` (otherwise `SET LOCAL ROLE`) |
| `AI_PROVIDER` | ✅ | `openrouter` \| `openai` \| `groq` \| `gemini` \| `ollama` \| `custom` |
| `AI_MODEL` | ✅ | Model id for that provider (not hard-coded anywhere) |
| `AI_API_KEY` | ✅* | Provider key (*not needed for `ollama` or a keyless `custom` endpoint) |
| `AI_BASE_URL` | – | Required for `custom`; overrides a preset |
| `EMBEDDING_MODEL` (+ `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL`) | – | Enables pgvector retrieval (768-dimensional) |
| `DATASET_MAX_ROWS`, `DATASET_TTL_HOURS` | – | Upload limits (defaults 50,000 rows / 72 h) |
| `MAX_ROWS`, `QUERY_TIMEOUT_MS`, `MAX_SQL_ATTEMPTS`, `RATE_LIMIT_PER_MINUTE`, `ANALYSIS_MODE`, `SUMMARY_MODE`, … | – | Tuning; see [.env.example](.env.example) |

There are **no `NEXT_PUBLIC_*` variables**: nothing secret ever reaches the browser. The app talks to Postgres directly, so Supabase's URL / anon key / service-role key are not needed
([decision 2](docs/DECISIONS.md#2-direct-pg-connection-instead-of-supabase-js--postgrest)).

## Deployment

The target is **Vercel + Supabase** — and both are now live: [nl-2-sql-seven.vercel.app](https://nl-2-sql-seven.vercel.app), backed by the
real Supabase project below and Groq as the LLM.

| | Status |
|---|---|
| PostgreSQL 16 and 17 with pgvector; production build; no filesystem / worker / Docker needed at run time | ✅ tested |
| Non-superuser `CREATEROLE` owner, pgvector, dedicated read-only login (a *local simulation* of Supabase's permission model) | ✅ tested — and it found a real migration bug, now fixed |
| **A real Supabase project** (eu-west-1): migrations, seed, session + transaction poolers, roles/grants/RLS, dataset upload/isolation/cleanup | ✅ **verified 2026-09-22** — [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#real-supabase-verification-2026-09-22) |
| **A real Vercel deployment**: health check, a real question, a real dataset upload — all through the live HTTP API | ✅ **verified 2026-09-22** — [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#real-vercel-verification-2026-09-22) |

A GitHub Actions workflow runs lint, typecheck, unit and integration tests (PostgreSQL 16 and 17) and the production build. Vercel notes: the free public LLM endpoint used for the evaluation is far too slow
for a 60 s function (≈ 90 s per question); the deployed app uses `AI_PROVIDER=groq AI_MODEL=openai/gpt-oss-120b` (also free-tier) instead, and a real question through the live deployment took **2.9 s** end to end.

## Limitations

* **Not for production or sensitive data.** Uploaded datasets are a demo feature: small synthetic data, `.sql` (schema + `INSERT`) or `.csv`, no `COPY` / functions / views / enums / arrays. Larger or production ingestion would need object storage, background processing, authentication and more controls.
* **No accounts.** Datasets belong to an anonymous browser session (cookie), expire after 72 h and can be deleted at any time.
* **Answer quality on uploaded schemas depends on their names, comments and constraints.** Uploads have no curated business metrics; colloquial wording that does not match a column name is where the held-out benchmark shows the most misses.
* **Model-dependent.** Results come from one free, third-party model; latency is dominated by it. The safety layers hold regardless of model quality.
* **Vector retrieval is off by default and was not evaluated** (no embedding model was available). The retrieval numbers are lexical-only; the pgvector path is tested for plumbing with a deterministic hashing embedder, not for semantic quality.
* **Deployed on the free tiers of everything** (Supabase, Vercel Hobby, Groq): fine for a demo/portfolio, not sized for real traffic — no autoscaling headroom has been tested, and rate limits (Groq's free tier: 30 req/min, 8K tokens/min) will bite under concurrent use.
* Single-turn Q&A: no conversation memory. The column-existence check is conservative for complex multi-table scopes; the database is the final judge.

## Docs

[Architecture](docs/ARCHITECTURE.md) · [AI pipeline](docs/AI_PIPELINE.md) · [Database](docs/DATABASE.md) · [Dataset upload](docs/DATASET_UPLOAD.md) · [Security](docs/SECURITY.md) · [Evaluation](docs/EVALUATION.md) ·
[Deployment](docs/DEPLOYMENT.md) · [Decisions](docs/DECISIONS.md) · [Portfolio summary](docs/PORTFOLIO_SUMMARY.md) · [Implementation audit](docs/IMPLEMENTATION_AUDIT.md)
