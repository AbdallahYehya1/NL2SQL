# Implementation Audit

_Date of audit: 2026-09-21 — performed before any project code was written._

## What existed

| Area | State |
|------|-------|
| Repository | Empty directory `D:\Projects\AI\NL2SQL`, not a git repository. The GitHub remote (`AbdallahYehya1/NL2SQL`) contained no refs. |
| Framework | None. |
| Package manager | Node 22.9 / npm 10.8 available. pnpm not installed → **npm** is used. |
| Database | None. Docker is available, so a local `pgvector/pgvector:pg16` container is used for development and integration tests. No Supabase project credentials were available in the environment. |
| AI provider | No API keys present in the environment. |
| Existing code / config / env files | None. Nothing was overwritten. |

## What had to be built

Everything: Next.js app, 20-table schema + seed, metadata registry, retrieval/routing, sub-schema builder, LLM provider abstraction, SQL generator / corrector / formatter, AST-based validator, sandboxed executor, orchestrator, API routes, dashboard UI, history + trace storage, tests, evaluation harness, and documentation.

## Environment consequences

* **Database work is verified against real PostgreSQL 16 + pgvector** (local Docker). Supabase itself was not reachable from the build environment, so Supabase-specific steps (pooler URL, role grants) are documented but were only exercised against vanilla Postgres. This is called out again in `DEPLOYMENT.md` and the README.
* **No LLM credentials were available**, so anything requiring a live model (SQL generation quality, correction success rate) can only be measured once `AI_API_KEY` is configured. `EVALUATION.md` reports only numbers that were actually produced and states which metrics were not run.

---

# Final hardening audit (2026-09-21)

Performed after the dataset-upload feature, before the portfolio/evaluation work. Method: read the code and the tests, then attack them; do not trust the docs.

## Baseline (before any change)

lint ✅ · typecheck ✅ · unit **279/279** ✅ · integration **114/114** ✅ · production build ✅ · offline eval: routing 39/39, precision 0.816, 2.7 of 20 tables, unsafe SQL 64/64, gold 39/39, scope/ambiguity 8/8 — all identical to the previous report.

## Architecture checklist

| Claim | Verified how | Result |
|-------|--------------|--------|
| `processQuestion({ question, datasetId })` resolves a `DatasetContext` explicitly | read `orchestrator.ts`; new test asserts every stage call receives the dataset | ✅ (plain-string form and missing `datasetId` default to `demo` — documented) |
| Dataset-specific registry, validator allow-list, executor, retrieval/routing, history, embeddings | code + tests | ✅ |
| Built-in `demo` is just a context | `getBuiltinContext()` | ✅ |
| SQL importer, CSV importer, catalog introspection, metadata generation, relationship suggestions | code + unit/integration tests | ✅ |
| Ownership / status checks, deletion, TTL | route + integration tests | ✅ (API-level tests were missing → added) |
| **No hidden demo-specific assumptions in the generic engine** | grep of `src/lib` + new architecture test | ❌ **4 leaks found and fixed** (below) |

## Findings and what was done

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | Uploaded table named `pg_class` (etc.) shadows `pg_catalog` at run time while the validator treats it as "a dataset table" → catalog **name** disclosure across datasets | medium | fixed in validator + importer; tests |
| 2 | `INSERT … RETURNING` accepted (AST field renamed in the newer grammar) and `CREATE INDEX CONCURRENTLY` accepted-then-failed | low | fixed; ~110-statement hostile table test |
| 3 | Migration 2 `SET search_path` (session-level) hid the `extensions` schema from migration 3 → **first Supabase deploy would fail** | high (deployment) | fixed (`SET LOCAL`, includes `extensions`); non-superuser simulation test |
| 4 | Total upload size checked only via `Content-Length` | low | enforced on parsed files too |
| 5 | Privacy statement "never row data reaches the LLM" was false for result summaries | medium (honesty) | uploaded datasets use the local summary; UI + docs corrected; test |
| 6 | Demo-specific text in the generic engine: clarification question ("revenue, orders, units sold"), scope reason ("retail database domain"), write-request nouns (`customer|order|product…`), demo suggested questions in the store | low | moved into dataset metadata / derived from the dataset; unit tests; architecture guard test |
| 7 | Unexpected import errors were not logged server-side | low | logged (SQLSTATE + message stem only, so uploaded values never reach logs) |
| 8 | Active dataset expiring mid-session left the selector on a dead dataset | UX | falls back to the demo with an explanation |
| 9 | Test gaps: API ownership/processing/deleted/malformed requests; catalog access via generated SQL; non-superuser permission model; PostgreSQL 17 | — | added (`api-routes`, `managed-postgres-permissions`, catalog tests; CI matrix 16/17) |

## Verified and left unchanged

Import allow-list (89 of 111 extra hostile statements rejected, the other 22 are dropped — never executed — and covered by a test), transactional all-or-nothing import, per-dataset roles and RLS, read-only execution layers, limits (4 MB / 2 MB / 10 files / 30 tables / 400 columns / 50k rows / 45 s / 5 per session / 6 per client-hour / 72 h — **not increased**), no filesystem / worker / Docker at run time, `libpg-query.wasm` present in the traced files of every route that parses SQL.

## Not verifiable here

A real embedding model — no embedding provider was available. See [EVALUATION.md](EVALUATION.md). (A real Vercel deployment *was*
subsequently verified — see below.)

---

# Real Supabase verification (2026-09-22)

A real Supabase project (region `eu-west-1`, PostgreSQL 17.6) was verified end to end, superseding the "not verifiable here" note above for
Supabase specifically. Full detail in [DEPLOYMENT.md](DEPLOYMENT.md#real-supabase-verification-2026-09-22); summary: migrations (including the
search_path fix) applied cleanly, `npm run db:seed` produced the exact documented volumes, the dedicated `nl2sql_readonly` login and the
transaction-mode pooler (the connection the deployed app actually uses) both work with the executor's real `SET LOCAL` sequence, a real dataset
upload exercised `CREATE ROLE`/grants/RLS on the managed platform successfully, a malicious upload was rejected with no residue, and every test
artifact was deleted and confirmed gone afterward. New finding: the plain direct-connection host (`db.<ref>.supabase.co:5432`) is IPv6-only and
unreachable from an IPv4-only network — the session pooler must be used instead for anything run from a normal laptop/CI runner; this is now
called out in DEPLOYMENT.md. (Vercel was unverified at the time this section was written; see the entry below.)

---

# Real Vercel verification (2026-09-22)

Deployed from this local directory (Vercel CLI, no GitHub integration needed) to a real Vercel project, backed by the Supabase project
above and Groq (`openai/gpt-oss-120b`, free tier) as the LLM. Live at https://nl-2-sql-seven.vercel.app. Full detail in
[DEPLOYMENT.md](DEPLOYMENT.md#real-vercel-verification-2026-09-22); summary:

- **New deployment bug found and fixed**: the pre-existing Vercel project had no Framework Preset configured (`framework: null`), so the
  first build failed with `The Output Directory "public" is empty` — Vercel fell back to static-site detection instead of the Next.js
  builder. Fixed with `PATCH /v9/projects/{id} {"framework":"nextjs"}`. This is a real, previously-undocumented deployment gotcha, now
  captured in the deployment checklist.
- `GET /api/health` → `ok: true`. A real question through the live HTTP API answered correctly in 2.9 s (cold start included).
- A CSV dataset was uploaded through the live HTTP API (not just the code path against Supabase directly), queried correctly, deleted, and
  confirmed gone on Supabase afterward — closing the one item the Supabase-only verification pass had left open.
- Groq's free tier (`AI_PROVIDER=groq`) replaces the ~90 s/question free endpoint used for evaluation; it comfortably fits inside Vercel's
  60 s function limit.
