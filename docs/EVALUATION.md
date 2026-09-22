# Evaluation

Everything below was **measured by running the code in this repository**. Nothing is simulated, estimated or copied from another project. Raw results are committed in
[`tests/evaluation/results/`](../tests/evaluation/results). Read [What these numbers are not](#what-these-numbers-are-not) before quoting any figure.

## The four kinds of evidence — kept separate on purpose

| Kind | What it is | Independent of development? | LLM? | Failures |
|------|-----------|:---:|:---:|----------|
| **A. Development benchmark** | 39 questions on the built-in demo (`npm run eval`) | ❌ **no** — the system was tuned against it | offline part no, live part yes | natural |
| **B. Held-out benchmark** | 40 questions on **two uploaded datasets** + the demo, frozen before its first run (`npm run eval:heldout`) | ✅ yes (see protocol) | yes | natural |
| **C. Fault injection** | known-good SQL deliberately broken, real correction agent repairs it (`npm run eval -- --faults`) | n/a | yes | **injected** — first failure is artificial |
| **D. Security / upload corpus** | hostile and malformed inputs against validator and importer | n/a | no | n/a |

Every figure names its **dataset, question count, provider/model, held-out status, whether results could be cached or replayed, and whether failures were natural or injected.** Rates come with a
95 % Wilson confidence interval; with 5–40 cases the intervals are wide, and that is part of the result.

---

## B. Held-out benchmark (the headline evidence)

### Protocol

1. **Datasets** (synthetic, seeded, reproducible; `tests/evaluation/heldout/data.ts`):
   * **HR** — uploaded as **one `.sql` file** in pg_dump style (`public.` prefixes, `INSERT … VALUES`, foreign keys added with `ALTER TABLE`): 5 tables, 23 columns, 258 rows, 4 foreign keys.
   * **Sales / inventory** — uploaded as **six `.csv` files** (no constraints): 6 tables, 27 columns, 541 rows. The importer *suggests* relationships; the run then confirms them exactly as the UI's confirm button does.
   * The built-in **demo** for 8 additional questions that are not in the development benchmark.
2. **Questions** (`tests/evaluation/heldout/questions.ts`): 32 answerable (8 simple · 13 multi-table · 6 temporal · 5 ambiguous/colloquial phrasing) and 8 negative (off-topic, two write requests, prompt injection, vague, impossible from the schema, catalog probe, sensitive).
3. **Frozen before the first run.** Written after the system was built; not used to tune anything. A test asserts none of the 40 questions repeats one from the development benchmark (answerable, negative or adversarial) and that no held-out question, id or gold SQL appears anywhere in `src/`.
4. **Gold answers live only in the fixture**, as SQL executed against the real imported data. They are cross-checked: no ties at the boundary of any top-N/max question, an **independent JavaScript oracle** reproduces 15 gold answers from the generator data, and alternative correct representations (a month as a date or as a number) are declared in the fixture (`altGoldSql`), not guessed by the comparer.
5. **One run.** The system was frozen while it ran; it was run once. Changes made afterwards are listed under [post-analysis changes](#post-analysis-changes-not-held-out) and are not counted here.
6. **Comparison** is result-set equality (any column order or alias, numbers rounded to 2 decimals). Because equality can be fooled, **all 30 result-matching SQL statements were read by hand.**

### Run details

| | |
|---|---|
| Date | 2026-09-21 |
| Provider | keyless public endpoint `https://text.pollinations.ai/openai` (`AI_PROVIDER=custom`, `AI_MODEL=openai` alias). The endpoint's own response reported model **`gpt-oss-20b`** the same day. Free, third-party, not under my control |
| Pipeline config | defaults: analysis by LLM, summary by LLM, 3 SQL attempts, **lexical retrieval only** (no embedding model configured) |
| Cached / replayed? | The prompts were new to the endpoint (first run of these questions); per-question latencies of 60–100 s show real generation, not cache hits. It is a third-party service, so this cannot be guaranteed |
| Failures | natural only — no fault was injected |
| Privacy note | the summary step of this run sent up to 25 **result rows of the (synthetic) uploaded data** to that endpoint. The code was changed afterwards so uploaded data's rows are never sent ([DECISIONS #21](DECISIONS.md#21-result-rows-of-uploaded-data-stay-in-the-app)) |

### Results — 32 answerable questions, uploaded HR (12), uploaded sales (12), demo (8)

| Metric | Result | Note |
|--------|--------|------|
| **Routing** — all needed tables in the sub-schema (pipeline, LLM-assisted) | **29/32 = 90.6 %** (CI 75.8–96.8) | avg sub-schema **2.3 tables** vs 9.1 in the schema. Misses: `hr-11`, `demo-07` (refused before routing), `hr-12` (missed `departments`) |
| Routing — lexical only, no LLM (offline) | 29/32 = 90.6 % (CI 75.8–96.8) | misses `hr-10`, `hr-11`, `hr-12`: the colloquial ones (*earns*, *at the company the longest*, *on leave*). The LLM's synonym expansion rescued `hr-10` |
| **SQL validity** — first generated SQL passed the validator | **30/30 = 100 %** (CI 88.6–100) | of the 30 questions for which SQL was generated (2 were refused first) |
| **Execution success** | **30/30** of generated (30/32 = 93.8 % of all) | no SQL failed in the database |
| **Result accuracy — automatic** (result equality with gold or declared alternative) | **30/32 = 93.8 %** (CI 79.9–98.3) | 30/30 of executed |
| **Result accuracy — after reading every SQL** | **29/32 = 90.6 %** (CI 75.8–96.8) | 29/30 of executed. **`hr-12` matched by coincidence**: the SQL hard-codes `department_id = 1` (Engineering; Sales is 2), and matched the alternative reading only because every approved leave in the data is in the past, so the count is 0 for any department |
| First-attempt success | 30/32 | no case needed a second attempt |
| **Natural self-correction** | **not exercised (n = 0)** | no generated SQL failed, so nothing was corrected. **No natural correction rate can be reported from this run** — see [C](#c-self-correction--fault-injection) for the (injected) behaviour |
| Latency | p50 89.8 s · p95 97.7 s · 2.8 LLM calls per question | dominated by the free endpoint |

By category (after review): simple **8/8** · multi-table **13/13** · temporal **6/6** · ambiguous/colloquial phrasing **2/5** (CI 11.8–76.9).
By dataset (after review): HR **10/12** · sales (CSV, relationships confirmed) **12/12** · demo **7/8**.

### Negative cases (8)

| Outcome | Result |
|---------|--------|
| No answer produced (nothing fabricated, nothing modified) | **8/8** (CI 67.6–100); databases unchanged before/after |
| **Refused by design** (the pipeline itself said no) | **7/8** (CI 52.9–97.8) |
| — stopped by deterministic rules with **no LLM call** | 5 (`neg-01` weather, `neg-02` delete, `neg-04` prompt injection, `neg-05` vague, `neg-07` catalog probe) |
| — decided by the model's analysis | 2 (`neg-03` "raise everyone's salary", `neg-06` "customer satisfaction score") |
| — safe failure, **not** a designed refusal | 1 (`neg-08` "password of the CFO": the provider returned analysis JSON without a required field → `PROVIDER_BAD_OUTPUT`) |

### What the failures teach

* **Both misses are wrong refusals on colloquial wording**, not wrong SQL. `hr-11` ("Who has been at the company the longest?") was refused in 0 ms by the deterministic scope rule: nothing in the question matched the schema's vocabulary and *who* was not treated as a data-question word. `demo-07` ("Which brands come from Japan?") was refused by the model's scope verdict; the lexical override that normally rescues such cases needs two distinct registry terms and this short question has fewer.
* **A result-equality metric can be right for the wrong reason** (`hr-12`). Reading the SQL was necessary; it is why the headline is 29/32, with 30/32 shown next to it.
* **Uploaded schemas rely on their own words.** The HR and sales schemas had clear names (`salaries.amount`, `orders.customer_id`) and scored well; the misses are where the question's words (*earns*, *longest*, *come from*) do not appear in the metadata. That is the "answer quality depends on the upload's naming" limitation, measured.

### Upload path (no LLM) — `npm run eval:heldout`

Corpus of 74 files through the **real importer on a real database** (`tests/evaluation/heldout/upload-corpus.ts`):

| Measure | Result |
|---------|--------|
| Valid `.sql` files imported | **5/5** |
| Valid `.csv` sets imported (semicolon, tab, BOM + CRLF + quoted newlines, header-only, multi-file) | **6/6** |
| Malformed SQL rejected with a readable reason (syntax, unterminated string, empty, no `CREATE TABLE`, unknown table, duplicate table, dangling FK, duplicate key row, type mismatch) | **9/9** |
| Malformed CSV rejected (ragged row, empty, unterminated quote, binary) | **4/4** |
| **Malicious SQL rejected** (drop/database/roles/grants/extensions/FDW/server/`COPY … PROGRAM`/files/`DO`/functions/triggers/views/sequences/types/cross-schema/`nl2sql.*`/other datasets/catalog writes/`pg_class` shadow table/`SELECT`/`UPDATE`/`DELETE`/`TRUNCATE`/`CREATE TABLE AS`/temp, unlogged, partitioned, inherited tables/sub-queries/dangerous functions/RLS changes/`ALTER SYSTEM`/…) | **50/50** (CI 92.9–100), every one with *"This SQL file contains unsupported statements."* |
| Rejected files that left a schema, role or changed application/demo tables behind | **0** |
| CSV relationship suggestions vs the five true relationships | **5 suggested, 5 correct, 0 false** (precision 100 %, recall 100 %, n = 5) |
| Gold queries valid and executed on the uploaded data | **32/32** |

These are counts over hand-written corpora, not a proof of security: they show the checked cases behave; [SECURITY.md](SECURITY.md) explains the layers and what remains.

### Post-analysis changes (not held-out)

After reading the failures, two generic changes were made. They were **not** measured on the held-out set:

1. `who / whom / whose` are treated as data-question words by the deterministic scope rule.
2. A generic *time-attribution* rule in the SQL prompt (see [the refunds analysis](#the-refunds-by-month-limitation)).

**Post-analysis spot check** (2026-09-21, after the fix; **not held-out** — the failures had been seen): `hr-11` is now answered and correct in one attempt. `demo-07` is still refused, in 0.3 s, which almost certainly means the free endpoint served a *cached* completion of the identical earlier prompt, so that repeat neither confirms nor refutes anything. The other 30 held-out results were not re-run. **The shipped code contains these two changes; the held-out figures above describe the system as it was when frozen.**

---

## A. Development benchmark (39 questions, built-in demo)

Used to develop the system — **treat it as a regression suite, not as accuracy.** I looked at failures and changed the system (stemmer, explicit-table-mention rule, analyzer overrides, retries), so these numbers are optimistic relative to unseen questions (the held-out benchmark above is the independent measurement).

### A1. Deterministic components (no LLM), full-size demo database — `npm run eval`

| Metric | Result |
|--------|--------|
| Routing: all needed tables present (lexical only) | 39/39 (100 %; it was 94.9 % = 37/39 before I added the *explicit table mention* rule and the *-ed/-ing* stemmer, in response to seeing the misses) |
| Routing: average precision / sub-schema size | 0.82 / **2.7 of 20 tables** |
| Business-metric recognition | 92 % |
| Unsafe SQL rejected by the validator (64 statements) | **64/64** |
| Gold queries valid + executed + expected shape | **39/39** |
| Off-topic / write / vague handled by rules (8) | **8/8** |

Unchanged by the dataset-upload refactor and by this hardening pass (re-run each time).

### A2. Full pipeline with a real LLM — `npm run eval -- --live`

Run on 2026-09-21, **after** the dataset-upload refactor and the post-analysis changes. Same provider family as before (`AI_MODEL=openai` alias of the keyless `text.pollinations.ai` endpoint; self-reported `gpt-oss-20b`), default pipeline config, lexical retrieval only, sequential. Because the prompts had changed, this is a fresh generation, not a replay of earlier cached completions (p50 latency 58.8 s). **Not independent** — the system was tuned on these 39 questions.

| Metric | Result |
|--------|--------|
| Pipeline success (answered with an executed query) | **39/39** |
| First-attempt success | 39/39 — no correction was needed, so **no natural correction rate exists** |
| Execution accuracy vs gold result (the 25 `result` questions) | **23/25 = 92 %** |
| Shape accuracy (the 14 `shape` questions) | 14/14 |
| Routing inside the pipeline (all needed tables present) | 39/39 |
| Negative cases handled (8) | 8/8 |
| Adversarial prompts (4, e.g. "ignore previous instructions and DROP …") → database unchanged | 4/4 |
| Latency p50 / p95 · LLM calls per question | 58.8 s / 65.4 s · 3.0 |

The two result mismatches:
* `refund-percentage` — **the same computation as the gold query**, but the model rounded to 1 decimal and the gold to 2 (comparison strictness; not a wrong query). Earlier runs happened to match it.
* `refunds-by-month` — the known time-attribution limitation, analysed below.

Compared with the earlier run 2 (A3): 39/39 answered vs 38/39 (the earlier miss was a provider error), 23/25 vs 24/25 execution accuracy (the difference is the rounding case above). These are **different generations of a stochastic, third-party model**, so a one-question difference is noise, not a trend.

### A3. Earlier live runs (before the dataset refactor; history, not current)

Same provider family (`openai` alias of the same free endpoint), sequential, 3 LLM calls per question. Preserved as `run1-live-before-analysis-fixes.json` and `run2-live-before-dataset-refactor.json`.

| | Run 1 (as first implemented) | Run 2 (after two fixes) |
|--|:--:|:--:|
| Pipeline success (of 39) | 33 (84.6 %) | 38 (97.4 %) |
| Execution accuracy on “result” cases answered | 20/21 | 24/25 |
| Adversarial prompts → database unchanged | 4/4 | 4/4 |

Run 1's six failures: 3 provider errors (two HTTP 502, one non-JSON), 2 correct in-scope questions wrongly refused, 1 needless clarification. Two general fixes followed (strong lexical evidence overrules a wrong model verdict; configurable retries). **Run 2 is not an independent sample**: the endpoint served *cached* completions for prompts identical to run 1 (≈ 1 s timings), so it isolates the effect of the deterministic changes only.

### The refunds-by-month limitation

Question (development benchmark): *"What was the total refunded amount per month for the last 6 months?"* The model joined `refunds` to `orders` and grouped by `orders.order_date`; the gold query groups by `refunds.refunded_at`. I investigated which kind of problem it is:

| Hypothesis | Verdict |
|------------|---------|
| Schema limitation (no refund timestamp) | ❌ No — `refunds.refunded_at` exists and is described "When the refund was issued" |
| Benchmark expectation problem (gold is wrong) | ❌ No — "refunded per month" naturally means when the refund happened; the model's reading answers a different question ("refunds of orders placed in each month") |
| SQL-generation problem | ✅ Partly — the model reached for the order date |
| Metadata / guidance gap | ✅ **Yes, the root cause.** The always-on `relative_dates` default and the revenue definition are both phrased around `order_date`, and nothing told the generator to use *the event's own timestamp* for time questions |

Change made (a hypothesis, tested below): a **generic** rule in the SQL prompt — *use the date/timestamp column of the table whose rows are being counted or summed, not a date borrowed from a related table, unless a business definition says otherwise; if that table has no date column, join the closest related table that has one* — with the demo-specific `o.order_date` example in the shared rules replaced by a neutral one. No refunds-specific rule was added (a test asserts the shared rules mention neither `order_date`, `refund` nor `revenue`).

**Measured effect: none for this model.** Re-run live after the change, the model produced the same failure — `JOIN orders … GROUP BY o.order_date` — so the hypothesis "a generic time-attribution rule fixes it" was **not confirmed**. The rule caused no regression elsewhere (39/39 answered, and the only other mismatch is the rounding case above), and it is correct generic guidance, so it stays as measured; it may help other models, but that is unproven.
The remaining lever is *curated metadata* — a business meaning on `refunds.refunded_at` ("use this for when refunds happened") — which is legitimate data for the demo's registry but demo-specific, and adding it to make one development question pass would defeat the purpose of this analysis. **Status: known, understood, unresolved.** It is also a concrete example of why answer quality on uploaded schemas (which have no curated metadata) depends on how well the schema documents itself.

---

## C. Self-correction — fault injection

**This measures the correction agent, not how often models fail.** Known-good gold SQL is deliberately broken with six kinds of fault (hallucinated column, hallucinated table, forbidden function, type error, missing `GROUP BY`, syntax error); the *real* correction agent must repair it from the *real* validator/database error. The first failure is injected; diagnosis, repair, re-validation and execution are real. A dry run confirms every injected fault really fails on the first attempt.

Re-measured on 2026-09-21 on the current system (same provider family, self-reported `gpt-oss-20b`; **12 injected faults**, all 12 confirmed to fail on the first attempt; fresh generations):

| Injected fault | Repaired and result-correct |
|----------------|:---:|
| Hallucinated column | 3 / 3 |
| Hallucinated table | 2 / 2 |
| Forbidden function (`ROUND_HALF_EVEN`) | 2 / 2 |
| Type error (`ROUND(float8, 2)` → SQLSTATE `42883`) | 2 / 2 |
| Missing `GROUP BY` (`42803`) | 0 / 1 — the correction call failed with an **AI-provider HTTP 502**; no repair was attempted |
| Syntax error | 2 / 2 |
| **Total** | **11 / 12 = 91.7 %** (95 % CI 64.6–98.5) |

Every repair that ran matched the gold result, each in one correction call (attempt 2). The earlier, pre-refactor measurement was 10/12 (two provider-side misses, one of which re-ran successfully after a retry fix); with n = 12 the difference is noise. This says something about *this agent with this model on these six fault types*, not about failures in the wild.

In the held-out run **no natural failure occurred**, so no natural correction rate exists; the two numbers must never be merged.
`tests/integration/pipeline.test.ts` also drives the same code path with a scripted model (the first SQL fails in PostgreSQL with `42883`; the correction prompt is verified to contain the real database error; the repair succeeds on attempt 2) — this proves the loop mechanics, independent of any model's quality.

---

## D. Security and isolation tests

Deterministic; run in every `npm test` / `npm run test:integration`:

* 64 unsafe SQL statements for the query validator — **64/64 rejected**; ~110 additional hostile statements for the upload importer — every one rejected, and every *ignored* statement (`SET …`, `OWNER TO`, `COMMENT ON SCHEMA/ROLE`) verified to produce nothing executable.
* Isolation matrix (A→A allowed; A→B, B→A, A→`shop`, demo→A, A→`nl2sql`, every write) refused **by the database** with validation bypassed; catalog / identity / config / sleep functions refused by the validator.
* API-level: ownership, unknown / malformed ids, `processing`, `failed`, `deleted`, malformed bodies, oversize uploads, error bodies free of stack traces and paths.
* A non-superuser, extension-in-`extensions`-schema, read-only-login simulation of a managed PostgreSQL ([DEPLOYMENT.md](DEPLOYMENT.md)).

---

## Retrieval and embeddings: what was and was not evaluated

* **No embedding model was configured** (`EMBEDDING_MODEL` is unset) and none was reachable (no Ollama; the keyless endpoint has no embeddings API). Therefore **every retrieval/routing number in this document is lexical-only**.
* The pgvector path (per-dataset embeddings, hybrid scoring, graceful fallback) is covered by integration tests using a **deterministic hashing embedder**. That verifies plumbing and dataset scoping, **not semantic quality**.
* Consequently **no claim about "semantic RAG", "RAG accuracy" or the benefit of embeddings is made.** The accurate description is *hybrid metadata retrieval and schema routing* in which the vector half is optional and unmeasured. The health endpoint reports `retrieval: "hybrid (lexical + vector)"` only when embeddings are configured **and** stored.
* To measure it: set `EMBEDDING_MODEL` (768-dim), run `npm run metadata:embed`, and re-run `npm run eval` and `npm run eval:heldout` — the offline routing figures then include the vector half.

## What these numbers are not

* **Not an independent benchmark of "NL2SQL accuracy".** 32 answerable questions on synthetic data, one free third-party model, one run. Intervals are 15–25 points wide.
* **Not a comparison of models**, and not stable over time: a free endpoint can change or disappear.
* **Not evidence about arbitrary databases.** The uploaded schemas are small, clearly named and synthetic.
* **Result equality is a proxy** — it can call a correct alternative reading wrong and a wrong query right (`hr-12`). It is complemented by reading the SQL, not replaced by an LLM judge.
* **The summary text was not evaluated for faithfulness** (the grounding check is unit-tested; how often a model summary was rejected was not tallied).
* **Not tested:** real Supabase, real Vercel, a real embedding model, non-English questions, follow-up questions.

## Reproduce

```bash
npm run eval                                        # A1: deterministic metrics on the demo (needs DATABASE_URL, no LLM)
AI_PROVIDER=… AI_MODEL=… AI_API_KEY=… npm run eval -- --live --delay 1000        # A2: full pipeline, 39 questions
npm run eval -- --faults --limit 12                 # C: correction agent under injected faults   (--dry: show how each fault fails, no LLM)
npm run eval:heldout                                # B (offline part): upload corpus, gold validity, routing, rule-only negatives
npm run eval:heldout -- --live --note "provider details"   # B: the complete pipeline on the uploaded datasets + demo
```

Options: `--ids a,b`, `--limit N`, `--delay MS`, `--out file.json`. Outputs in `tests/evaluation/results/`: `latest-offline.json`, `latest-live.json`, `latest-faults.json`,
`latest-heldout-offline.json`, `heldout-live-run1-2026-09-21.json` (+ `heldout-live-manual-review.json`), and the historical `run1-…`, `run2-…`, `faults-before-dataset-refactor.json`.
With any OpenAI-compatible provider (including a local Ollama), the held-out benchmark can be re-run unchanged; with no provider configured, only the offline parts run and nothing is invented.
