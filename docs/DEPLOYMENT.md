# Deployment (Supabase + Vercel)

## Verification status (read this first)

**Both Supabase and Vercel are now verified against a real project and a real deployment** (below).

| Area | Status | Evidence |
|------|--------|----------|
| Migrations, seed, app on PostgreSQL 16 + pgvector (Docker) | ✅ verified | full test suite |
| Same on PostgreSQL 17 | ✅ verified | full integration suite (all tests) run against `pgvector/pgvector:pg17` |
| Non-superuser owner role, pgvector, dedicated read-only login, dataset role/grants/RLS (local simulation) | ✅ verified | `tests/integration/managed-postgres-permissions.test.ts` |
| **A real Supabase project** (eu-west-1, PostgreSQL 17.6): migrations, seed, roles, RLS, dataset upload, isolation, cleanup | ✅ **verified 2026-09-22** | [below](#real-supabase-verification-2026-09-22) |
| `next build` / `next start`, Node runtime, no filesystem / worker / Docker at run time | ✅ verified locally | production build; source scan (no `fs`, `child_process`, `worker_threads`) |
| **A real Vercel deployment**, live at the Supabase project above, Groq as the LLM provider | ✅ **verified 2026-09-22** | [below](#real-vercel-verification-2026-09-22) |
| Real embedding model + pgvector retrieval quality | ❌ **not evaluated** | no embedding provider available (see [EVALUATION.md](EVALUATION.md)) |

**Migration bug found by the local simulation (fixed, then confirmed fixed on the real project below).** Migration 2 used a session-level
`SET search_path = shop, public`. Because the migrator applies files on one connection, it leaked into migration 3, which then could not find
the `vector` type when pgvector lives outside `public`. Migrations now use `SET LOCAL` (scoped to their own transaction) and always include
`extensions` in the search path.

### Real Supabase verification (2026-09-22)

Run against a live, empty Supabase project (region `eu-west-1`, Postgres 17.6) — not a branch, not a simulation. Nothing outside this
project's own schemas/roles/data was touched; every test artifact created during verification was deleted afterward and confirmed gone.

| Check | Result |
|-------|--------|
| **Direct connection** (`db.<ref>.supabase.co:5432`) | ⚠️ **IPv6-only** (AAAA record, no A record) — unreachable from an IPv4-only network/host. Use a pooler instead unless you have the IPv4 add-on or IPv6 egress |
| **Session pooler** (`aws-<N>-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`) | ✅ works; used for migrate/seed/admin operations below. The exact pooler node number (`aws-0-`, `aws-1-`, …) isn't predictable from the region name alone — copy it from *Connect* in the dashboard, or try `aws-0-`/`aws-1-`; a wrong node fails fast with `tenant/user … not found`, not a timeout |
| **Transaction pooler** (same host, port `6543`) — the connection the deployed app actually uses | ✅ **verified**: the executor's exact `BEGIN READ ONLY → SET LOCAL statement_timeout/lock_timeout/search_path → DECLARE CURSOR → FETCH` sequence runs correctly through it. This was previously just a documented assumption ("safe with transaction pooling") — now empirically confirmed |
| `npm run db:migrate` (all 5 migrations, including the search_path fix) | ✅ applied cleanly |
| `CREATE EXTENSION IF NOT EXISTS vector` (migration 1, no `WITH SCHEMA`) | ✅ succeeded — landed in **`public`** (this project had no pre-existing `extensions` schema; nothing had enabled pgvector via the dashboard first). Harmless: the app doesn't depend on which schema it's in, only that `public`/`extensions` are both on the search path where needed |
| Connecting role (`postgres`) | not superuser; `CREATEDB` ✅, `CREATEROLE` ✅, `BYPASSRLS` ✅ (Supabase's owner role bypasses RLS by default — stricter than the local simulation, which explicitly denies it; doesn't affect the dataset/demo roles the app creates, which do **not** bypass RLS) |
| `npm run db:seed` | ✅ exact documented volumes (10,984 orders, 1,800 customers, …) |
| `nl2sql_readonly`: created NOLOGIN by migration 4; `ALTER ROLE … LOGIN PASSWORD '…'` | ✅ succeeds; `READONLY_DATABASE_URL` with user `nl2sql_readonly.<project-ref>` connects through the pooler and answers `SELECT COUNT(*) FROM orders` via the real `validateSql`/`executeQuery` code path |
| Defence in depth with validation bypassed | ✅ `nl2sql.query_runs` refused (permission); a write refused |
| **Dataset upload** (`importDataset`) on the managed platform: `CREATE ROLE`, schema, RLS, `GRANT … TO nl2sql_readonly` (previously an untested ⚠️ item) | ✅ role and 2 tables created, RLS on both, query through `SET LOCAL ROLE` from the `READONLY_DATABASE_URL` login returned the correct joined/grouped result |
| Dataset deletion | ✅ role and schema fully removed; a tombstone row (`status = 'deleted'`) remains in `nl2sql.datasets`, by design |
| Malicious upload (`DROP TABLE nl2sql.query_runs; GRANT ALL …`) | ✅ rejected with *"This SQL file contains unsupported statements."*, line numbers included, zero schemas created, `nl2sql.query_runs` untouched |

At this point in verification, the HTTP/Vercel layer was still unconfirmed; that gap is closed below.

### Real Vercel verification (2026-09-22)

Deployed from this local directory with the Vercel CLI (`vercel deploy --prod`, no GitHub integration needed), to the user's
pre-existing Vercel project, using the real Supabase project above (transaction pooler, port `6543`) and **Groq** (`AI_PROVIDER=groq`,
`AI_MODEL=openai/gpt-oss-120b`, free tier) as the LLM provider. Live at **https://nl-2-sql-seven.vercel.app**.

| Check | Result |
|-------|--------|
| `vercel link` / `vercel deploy --prod` from a personal-account access token | ✅ works once the token is a genuine account-scoped token (see the note below on token pitfalls) |
| **Project had no Framework Preset configured** (`framework: null` — it had been created empty in the dashboard, never auto-detected) | ⚠️ **first deploy failed**: `The Output Directory "public" is empty` (Vercel fell back to static-site output detection). Fixed with one API call: `PATCH /v9/projects/{id} {"framework":"nextjs"}` (or set it in the dashboard: *Project Settings → General → Framework Preset → Next.js*). **New checklist item, not previously documented** |
| Build on Vercel (`npm run build` inside the Vercel builder) | ✅ compiled successfully, all routes built (static `/`, `/datasets`, `/datasets/new`; dynamic `/api/*`, `/datasets/[id]`) |
| `libpg-query.wasm` in the deployed function | ✅ no manual `outputFileTracingIncludes` change was needed — confirmed by the SQL-parsing routes below actually working |
| `GET /api/health` | ✅ `{"ok":true,"ai":{"provider":"groq","model":"openai/gpt-oss-120b","configured":true},"database":{"configured":true,"reachable":true},"retrieval":"lexical"}` |
| Real question through the live HTTP API ("How many customers are there?") | ✅ correct SQL and answer (1,800), **2.9 s total** — first-question cold start included |
| CSV dataset upload through the live HTTP API (not just the code path) | ✅ streamed NDJSON progress, `status: ready`, 1 table / 3 rows |
| Question against that uploaded dataset, live | ✅ `SELECT ROUND(AVG(v.score)::numeric, 2) …` → 85.33, matches the input data exactly |
| Cleanup | ✅ dataset deleted through the live API; schema and role confirmed gone on Supabase afterward |
| Cold start | one request timed out client-side at 30 s before the app had ever been hit; every request after that answered in 2–3 s. Expect a slow first request after idle periods |

**Token pitfall (new finding).** The first two access tokens tried both failed with `"User not found"` on `whoami`/`/v2/user` even though
they were "real" tokens copy-pasted correctly — one turned out to be stale/invalid, and one was created against a specific pre-existing
project rather than as a plain account token. A token that fails `/v2/user` but succeeds on `/v2/teams` (a different error, `forbidden`
rather than `not_found`) is a sign worth chasing rather than assuming any prefix/format is wrong; in this case `vercel link` still found
and correctly linked the pre-existing project once a working token was in hand.

### First-deploy checklist for a *new* Vercel + Supabase pair (start to finish)

1. `npm run db:migrate` against the Supabase **session pooler** (not the direct-connection host — see above). `npm run db:seed`.
2. `ALTER ROLE nl2sql_readonly LOGIN PASSWORD '…'`; set `READONLY_DATABASE_URL` with user `nl2sql_readonly.<project-ref>`.
3. Create the Vercel project (`vercel link`) and set env vars for Production + Preview (`DATABASE_URL`/`READONLY_DATABASE_URL` on the
   **transaction pooler**, port `6543`; `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY`; `RATE_LIMIT_SALT`).
4. **Confirm the Framework Preset is `nextjs`** (`GET /v9/projects/{id}` → `framework`) before the first deploy — an empty/manually-created
   project does not auto-detect this, and the first build will fail on output-directory detection otherwise.
5. `vercel deploy --prod`. `GET /api/health` → `ok: true`.
6. Ask a real question through `/api/query` → answered.
7. Upload a tiny CSV through `/api/datasets/upload`, ask a question about it, delete it, confirm the schema/role are gone on Supabase.

## 1. Supabase

1. **Create a project** (free tier is enough: the seeded data is a few MB). Choose a region close to your Vercel region.
2. **Get the connection string**: *Project Settings → Database → Connect*.
   * For Vercel/serverless use the **Transaction pooler** (port `6543`). The app uses `pg` without prepared statements
     and only session-local settings inside explicit transactions (`SET LOCAL`), which are **confirmed** safe with
     transaction pooling (verified against a real project, above).
   * For running migrations from your laptop use the **Session pooler** (port `5432`, host
     `aws-<N>-<region>.pooler.supabase.com`, user `postgres.<project-ref>`). ⚠️ The plain **direct connection**
     (`db.<project-ref>.supabase.co:5432`) is **IPv6-only** on most Supabase projects and will fail with `ENOTFOUND`
     from an IPv4-only network — use the session pooler instead unless you know you have IPv6 egress or the IPv4 add-on.
3. **Apply the schema and seed data** from your machine:
   ```bash
   cp .env.example .env.local        # set DATABASE_URL to the Supabase URI
   npm install
   npm run db:migrate                # extensions, 20 tables, app tables, role + RLS, datasets
   npm run db:seed                   # ~11k orders, 1.8k customers, … (a few seconds)
   npm run db:status                 # confirm row counts
   ```
   (Alternatively run the five files in `supabase/migrations/` in the SQL editor / with `supabase db push`, then
   `npm run db:seed`.)
4. **pgvector**: migration 1 runs `CREATE EXTENSION IF NOT EXISTS vector;`. ✅ Confirmed to succeed unattended on a fresh
   project (lands in `public` if nothing enabled it first via the dashboard; either location works). If your role may
   not create extensions, enable *vector* in *Database → Extensions* first.
5. **Read-only execution (recommended)** — give the sandbox role its own login so LLM-generated SQL never runs on the
   owner connection. In the SQL editor:
   ```sql
   ALTER ROLE nl2sql_readonly LOGIN PASSWORD '<a-long-random-password>';
   ```
   Then set `READONLY_DATABASE_URL` to the same pooler URL with the user `nl2sql_readonly.<project-ref>` (Supabase
   pooler usernames are `role.project-ref`) and that password. ⚠️ If you skip this, the app uses
   `SET LOCAL ROLE nl2sql_readonly` on `DATABASE_URL`; migration 4 grants the connecting user membership so this works, and
   the app fails closed with a clear error if it does not. Verify with a question after deploying.
6. **Data API**: the `shop` and `nl2sql` schemas are not exposed (only `public` is), and RLS is enabled on all their
   tables. Leave *Exposed schemas* alone.
7. **Optional embeddings**: after choosing an embedding model (768-dim), set `EMBEDDING_MODEL` (+ key) and run
   ```bash
   npm run metadata:embed
   ```
   once (and again whenever you edit the registry; unchanged items are skipped). Without it the app uses lexical
   retrieval. The **Health** endpoint reports `retrieval: "hybrid (lexical + vector)"` when vectors are stored.

### Uploaded datasets (optional feature)

Nothing extra to configure, but note:

* Each upload creates a **schema and a role**. The connecting user (Supabase's `postgres`) needs `CREATEROLE` (it has it) and the app
  grants each dataset role to itself and to `nl2sql_readonly` so `SET ROLE` works; ✅ verified end to end against a real Supabase
  project (role creation, grants, RLS, query through the read-only login, deletion) — see the verification table above.
* Roles are cluster-level objects: the app drops them when a dataset is deleted or expires (72 h, `DATASET_TTL_HOURS`; expiry runs
  opportunistically on each upload). If you ever drop the database by hand, also drop `nl2sql_ro_*` roles (`db:reset` does it for you).
* **Vercel limits:** request bodies are capped at 4.5 MB, so uploads are capped at 4 MB; the import runs inside one `maxDuration = 60`
  function with a 45 s database timeout (50,000 rows max). The upload response streams progress, which keeps the function alive.
  Larger datasets would need a queue/worker or object storage — out of scope.
* Storage: each dataset is small (≤ 4 MB of input); the free tier is not a concern with the 5-datasets-per-session and 72 h limits.
* Use `READONLY_DATABASE_URL` as before; dataset roles are reached with `SET LOCAL ROLE` from it.

### Reset

```bash
npm run db:reset      # drops schemas shop + nl2sql + all uploaded ds_* schemas/roles, re-migrates, re-seeds (destructive!)
```

## 2. Choose an LLM (free / low-cost)

Set `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` (server-side only). Any OpenAI-compatible endpoint works.

| Provider | Notes |
|----------|-------|
| `openrouter` | Many models, including `:free` variants. Pick one from openrouter.ai/models filtered to “free” and “structured outputs / JSON”. Availability and rate limits of free models change often. |
| `groq` | Fast inference with a free tier for open models. |
| `gemini` | Google's OpenAI-compatible endpoint; also offers a free embedding model (set `EMBEDDING_PROVIDER=gemini`). |
| `ollama` | Fully local/free (`AI_BASE_URL` defaults to `http://localhost:11434/v1`); not reachable from Vercel. |
| `custom` | Any other compatible server via `AI_BASE_URL`. |

Model IDs are deliberately not hard-coded anywhere. Prefer an instruction-tuned model of ≥ 30B parameters (or a
current mid-size commercial model) — SQL generation quality drops sharply with tiny models. Expect **3 LLM calls per
question** (analysis, SQL, summary); set `ANALYSIS_MODE=rules` and/or `SUMMARY_MODE=deterministic` to cut it to 1–2 on
tight free-tier limits.

## 3. Vercel

1. Push the repository to GitHub and **Import** it in Vercel (framework: Next.js). ⚠️ **Verify the Framework Preset is actually set to
   "Next.js"** (*Project Settings → General*) — importing from GitHub normally auto-detects it, but a project created empty first (e.g.
   from the CLI before any code exists) does not, and the first build then fails with `The Output Directory "public" is empty` (hit and
   fixed during real verification, above). Alternatively deploy straight from a local clone with the Vercel CLI (`vercel link && vercel
   deploy --prod`) — no GitHub connection required.
2. **Environment variables** (Production + Preview), all server-side:

   | Variable | Required | Value |
   |----------|:--------:|-------|
   | `DATABASE_URL` | ✅ | Supabase pooler URI (port 6543) |
   | `READONLY_DATABASE_URL` | recommended | pooler URI for `nl2sql_readonly` |
   | `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` | ✅ | your provider |
   | `AI_BASE_URL` | only for `custom` | |
   | `EMBEDDING_MODEL` (+ `EMBEDDING_PROVIDER/API_KEY`) | optional | enables vector search |
   | `RATE_LIMIT_SALT` | recommended | any random string |

   Do **not** add `NEXT_PUBLIC_` prefixes; nothing is meant for the browser.
3. **Deploy.** The query route sets `maxDuration = 60`. ⚠️ On the Hobby plan check your plan's function-duration limit;
   slow free models can approach it — **Groq's free tier did not** (a full question, including a cold start, took under 3 s in real
   verification). Region: pick the Vercel region nearest your Supabase project to keep DB round-trips short.
4. **Verify**: open `/api/health` → `{"ok": true, …}` (database reachable, AI configured). Then ask “Top 5 products by
   revenue”. If the setup banner shows on the home page, follow its message. The very first request after a cold start can take
   30 s+; a request while the function is warm is fast.
5. **Runtime notes**: Node.js runtime (not Edge) because of `pg` and the WASM SQL parser; `serverExternalPackages` keeps
   `pg` and `libpg-query` out of the bundle; no filesystem access at runtime; no long-lived state (rate limits and history
   are in Postgres); pools are `max: 3` per instance. The build's file traces for `/api/query`, `/api/datasets/upload` and
   `/api/datasets/[id]/relationships` (`.next/server/app/api/**/route.js.nft.json`) were checked locally and include `libpg-query.wasm`, which is what
   Vercel bundles into each function. ⚠️ If a deployment ever returns 500 on the first query, check that file is present
   and add it to `outputFileTracingIncludes` in `next.config.ts`.

## 4. Pre-deploy checklist (run locally)

```bash
npm run lint && npm run typecheck && npm test && npm run test:integration && npm run build
```

`npm run test:integration` needs a Postgres with pgvector reachable at `TEST_ADMIN_URL` (default
`postgresql://postgres:postgres@127.0.0.1:54329/postgres`); see the README for the one-line Docker command. It creates and
drops its own `nl2sql_test` database — it never touches your data.

## 5. CI

`.github/workflows/ci.yml` runs lint, typecheck, unit tests, a pgvector service container for integration tests, and the
production build on every push and pull request. No secrets are required.
