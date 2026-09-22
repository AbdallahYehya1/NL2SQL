# Portfolio summary

A technical summary for an interviewer or reviewer: what problem this solves, how, what is actually proven, and what is not. Numbers link back to [EVALUATION.md](EVALUATION.md); nothing here is rounded up.

## Problem

Letting people ask a relational database questions in plain English is hard for reasons that are more about *engineering* than about the model:

* A real schema has dozens of tables. Putting all of it in the prompt is slow, expensive and makes the model worse; picking the right subset is a retrieval problem.
* The model has to be told what the columns *mean* (is revenue gross or net? which date counts?). Names alone are not enough.
* The output is **SQL written by a model that reads untrusted text**. It can be wrong, and — under prompt injection — hostile.
* Models fail in ordinary ways: a hallucinated column, a type error, a wrong join. A useful system has to notice and recover, not just fail.
* "Does it work?" is not answerable by trying three questions.

## Solution

An agentic pipeline over a **metadata registry**, with deterministic code wherever correctness or safety matters and the LLM used only for three jobs: understanding the question, writing SQL, and phrasing the answer.

* **Route, don't dump.** Retrieval scores every table/column/metric, picks the relevant tables, and adds the *bridge* tables a join needs through the foreign-key graph. The generator sees only that sub-schema.
* **Validate with the database's own parser.** `libpg-query` (PostgreSQL's parser compiled to WASM) produces the AST; the policy is enforced on the tree, not with regexes.
* **Execute in a sandbox the database enforces.** Read-only role, `READ ONLY` transaction, timeout, cursor row cap, pinned `search_path`.
* **Correct with evidence.** On failure the agent receives the real error and must diagnose before repairing.
* **Generic over datasets.** The same pipeline answers questions about the built-in demo and about small datasets a user uploads.

## Agentic behaviour

```
Analyze → Retrieve → Generate → Validate → Execute → Diagnose → Correct → (Validate → Execute) → Answer
```

* **Analyze**: deterministic rules first (write requests, pasted SQL, off-topic, vague), then one structured LLM call for scope, ambiguity and synonyms. Strong lexical evidence can overrule a wrong model "out of scope".
* **Retrieve / route**: lexical scoring always; pgvector similarity if an embedder is configured. Relationship expansion connects the selected tables.
* **Generate**: structured JSON (`sql`, `explanation`, `tables_used`, `assumptions`), Zod-validated, one repair round-trip.
* **Validate → Execute**: two independent gates; a rejected write is never sent to the corrector.
* **Diagnose → Correct**: bounded (3 attempts), records every attempt, never repeats a failed query.

## Security

Generating SQL is dangerous because the author is a model steered by untrusted input, and "please don't drop tables" in a prompt is not a control. So safety is layered, and each layer is tested with the previous ones *bypassed*: ownership → status → AST validation → dataset-specific allow-list → read-only role → `READ ONLY` transaction → timeout → row cap → pinned `search_path` → database roles + RLS. The point of the layering is that the database, not the validator, has the last word. Details and the audit findings: [SECURITY.md](SECURITY.md).

## Dataset isolation

Every uploaded dataset gets **its own schema and its own read-only role**. If isolation lived only in the validator, a validator bug would expose other datasets; with per-dataset roles a bug still cannot read them, because PostgreSQL refuses. The same pipeline can therefore serve many datasets without any of them being trusted with another's data. (One honest exception, documented and tested: PostgreSQL lets every role read catalog *names*, so hiding those is the validator's job.)

## Metadata from the catalog, not from claims

An uploaded file can say anything about itself. So types, keys, relationships, row counts and sample values are read back from `pg_catalog` after the import; descriptions come from `COMMENT ON`, else an optional LLM that sees structure only (its output is filtered against the real structure and labelled AI-generated), else a template. For CSVs, where no constraints exist, relationships are only *suggested* with evidence ("all 150 non-null values exist in customers.id") and become real foreign keys only when the user confirms.

## Evaluation

Three benchmarks, deliberately separate, each with its denominator and a 95 % confidence interval:

1. **Development benchmark** (39 questions on the demo). It was used to tune the system, so it is **not** an independent accuracy figure.
2. **Held-out benchmark** (40 questions, written and frozen before its first run): two *uploaded* datasets (an HR `.sql` file and a six-file sales/inventory `.csv` set) plus new demo questions and 8 negative cases. Measures routing, SQL validity, execution, result accuracy and natural self-correction separately, end to end through upload → import → introspection → metadata → pipeline.
3. **Fault injection** for the correction agent: known-good SQL is deliberately broken. It says how the agent behaves on six fault types, **not** how often models fail naturally — that is measured separately in (2) and reported as counts.

Limits stated up front: one free third-party model, one run, small samples (wide intervals), lexical-only retrieval, and no embedding evaluation because no embedding provider was available.

### Headline results (details and caveats in [EVALUATION.md](EVALUATION.md))

| | Result |
|---|---|
| Held-out, 32 answerable questions on 2 uploaded datasets + demo, free model (self-reported `gpt-oss-20b`), one run | **29/32 correct end to end = 90.6 %** (95 % CI 75.8–96.8). Automatic metric 30/32; one match was coincidental (found by reading the SQL) |
| Generated SQL that passed validation / executed / matched gold | **30/30 / 30/30 / 29 of 30 after review** — the model rarely wrote bad SQL; its errors were *wrong refusals* on colloquial wording (2) |
| Negative questions (write requests, injection, off-topic, impossible, sensitive) | 8/8 produced no answer; 7 refused by design, 1 provider-output error; databases unchanged |
| Upload path, 74 files | 50/50 malicious SQL rejected, 13/13 malformed rejected, 11/11 valid imported, 0 residue |
| Natural self-correction | not exercised (n = 0) — reported as such rather than inferred from fault injection |
| Fault injection (injected failures, clearly labelled) | **11/12 repaired and result-correct** (91.7 %, CI 64.6–98.5); the miss was a provider HTTP 502 during the correction call, not a wrong repair |
| Embeddings / "semantic" retrieval | not evaluated — no embedding model was available |

## Engineering challenges

* **Dynamic schema routing.** Scoring must work with no curated metadata (uploads) and with a lot of it (demo). Lexical scoring with synonyms and stemming, an "explicit table mention" floor, metric-driven table inclusion for curated datasets and column-driven inclusion for uploads, plus FK-graph bridging.
* **SQL safety.** A parser-based policy needs an allow-list for tables, schemas *and* functions; an audit then found that a table named `pg_class` could shadow the system catalog (PostgreSQL searches `pg_catalog` first). Fixed in two layers and regression-tested.
* **Dataset isolation.** Per-dataset roles and RLS, verified with validation bypassed, and re-verified as a *non-superuser* owner with pgvector in an `extensions` schema — which surfaced a migration bug that would have broken a managed deployment.
* **LLM unreliability.** A free model that returns 502s, empty output, non-JSON, or refuses a valid question: retries, JSON repair, deterministic overrides of clearly wrong verdicts, and honest reporting of what still fails.
* **Self-correction.** Bounded, evidence-driven, never touches writes; evaluated under **injected** faults (clearly labelled). In the held-out run no generated query failed, so there is no natural correction rate to report — the two are never mixed.
* **Serverless upload constraints.** No filesystem, no worker, a 4.5 MB body limit and a 60 s function: hence the streaming import, all-or-nothing transaction and deliberately small limits.
* **Generic metadata generation.** Deterministic, catalog-derived, with optional LLM prose that can annotate but never change structure.
* **Honest privacy.** Auditing my own claims found one that was false (result rows were sent to the model for summaries); the behaviour was changed to match the promise.

## CV version

Accurate, and only claims what was measured or built. (No deployment is claimed: a real Supabase/Vercel deployment has not been verified.)

* Built **Agentic NL2SQL**, a natural-language-to-SQL system (Next.js, TypeScript, PostgreSQL/pgvector): a metadata registry drives dynamic schema routing to a minimal sub-schema; an OpenAI-compatible LLM writes the SQL; a **PostgreSQL-parser AST validator** and a read-only, timeout- and row-capped executor gate it; a bounded **self-correction** agent repairs failures from the real database error.
* Designed **SQL/CSV dataset ingestion** into per-dataset isolated PostgreSQL schemas with dedicated read-only roles and Row Level Security; metadata is generated by **catalog introspection**, and CSV relationships are only suggested until confirmed. Ten-layer defence in depth, tested with earlier layers bypassed; a security audit found and fixed a system-catalog shadowing flaw and a migration bug that would have broken a managed-Postgres deploy.
* Evaluated on a **frozen held-out benchmark** of two uploaded datasets (29/32 answerable questions correct end to end, 90.6 %, 95 % CI 76–97, free ~20B-class model, lexical retrieval; failures analysed, not hidden) plus a 74-file upload corpus (50/50 malicious SQL files rejected).
* Shipped 550 automated tests (unit + integration against real PostgreSQL 16/17 in CI), an evaluation harness with confidence intervals, and documentation that separates what is verified from what is not.

## What I would say if asked…

* **"How do you know this works?"** — A three-layer answer: 397 unit and 153 integration tests against a real PostgreSQL (including 110+ hostile-SQL cases and isolation tests with validation bypassed); a development benchmark; and a held-out benchmark on uploaded datasets with confidence intervals, whose failures are analysed rather than hidden.
* **"How do you stop generated SQL doing something dangerous?"** — Ten layers, the last five enforced by PostgreSQL itself; each tested with the earlier ones bypassed.
* **"Does it only work with your demo database?"** — No. The pipeline is dataset-aware and can ingest small SQL or CSV datasets into isolated PostgreSQL schemas, introspect their real catalog, build metadata, and answer questions against them. Quality on such schemas depends on how well the schema names and documents itself.
* **"Can I upload a production database?"** — Not with this demo version. It intentionally supports small synthetic datasets; larger or production ingestion would need object storage, background processing, stronger authentication and additional security controls.
* **"Is it deployed?"** — The database half is: migrations, seed, roles, RLS and the dataset-upload feature (role creation, grants, isolation) were verified end to end against a real Supabase project on 2026-09-22, which also caught the migration bug the local simulation predicted. The app itself has not been deployed to Vercel yet; the remaining checklist is in [DEPLOYMENT.md](DEPLOYMENT.md).
