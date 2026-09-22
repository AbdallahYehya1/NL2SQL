import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pointAtTestDatabase } from "../helpers/db";
import { closePools, getAdminPool } from "@/lib/database/client";
import { deleteDataset, importDataset } from "@/lib/datasets/import-service";
import { ImportError, UNSUPPORTED_SQL_MESSAGE, getUploadLimits } from "@/lib/datasets/limits";
import { ADVERSARIAL_QUESTIONS, BENCHMARK, NEGATIVE_CASES } from "../evaluation/benchmark";
import { generateHr, generateSales } from "../evaluation/heldout/data";
import { loadHeldoutDatasets, matchGold, removeHeldoutDatasets, routedTables, runAsDataset, runGold, type LoadedHeldoutDatasets } from "../evaluation/heldout/harness";
import { HELDOUT, HELDOUT_NEGATIVES, HELDOUT_TOTAL } from "../evaluation/heldout/questions";
import { UPLOAD_CORPUS } from "../evaluation/heldout/upload-corpus";

pointAtTestDatabase();

const SESSION = "sess-heldout-fixtures";
let pool: pg.Pool;
let loaded: LoadedHeldoutDatasets;

beforeAll(async () => {
  pool = getAdminPool();
  loaded = await loadHeldoutDatasets(pool, { sessionId: SESSION, clientHash: "heldout-fixtures" });
}, 120_000);

afterAll(async () => {
  if (loaded) await removeHeldoutDatasets(pool, [loaded.ids.hr, loaded.ids.sales]);
  await pool.query("DELETE FROM nl2sql.datasets WHERE session_id = $1", [SESSION]);
  await closePools();
});

describe("held-out benchmark: structure", () => {
  it("has 40 questions in the required categories, including negatives", () => {
    expect(HELDOUT.length + HELDOUT_NEGATIVES.length).toBe(HELDOUT_TOTAL);
    expect(HELDOUT_TOTAL).toBe(40);
    const cats = new Set(HELDOUT.map((c) => c.category));
    expect([...cats].sort()).toEqual(["ambiguous_phrasing", "multi_table", "simple", "temporal"]);
    expect(new Set(HELDOUT.map((c) => c.dataset))).toEqual(new Set(["hr", "sales", "demo"]));
    expect(new Set(HELDOUT_NEGATIVES.map((n) => n.kind)).size).toBeGreaterThanOrEqual(6);
    expect(new Set([...HELDOUT.map((c) => c.id), ...HELDOUT_NEGATIVES.map((n) => n.id)]).size).toBe(HELDOUT_TOTAL); // unique ids
  });

  it("is genuinely held out: no question repeats one from the development benchmark (39 answerable, 8 negative, 4 adversarial)", () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const dev = new Set([...BENCHMARK.map((b) => b.question), ...NEGATIVE_CASES.map((n) => n.question), ...ADVERSARIAL_QUESTIONS].map(norm));
    for (const c of [...HELDOUT, ...HELDOUT_NEGATIVES]) expect(dev.has(norm(c.question)), c.question).toBe(false);
  });

  it("gold answers live only in the evaluation fixtures: no held-out question, id or gold SQL appears in the application source", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const source = walk(path.resolve(process.cwd(), "src")).map((f) => fs.readFileSync(f, "utf8")).join("\n").toLowerCase();
    for (const c of HELDOUT) {
      expect(source.includes(c.question.toLowerCase()), `question ${c.id} found in src`).toBe(false);
      expect(source.includes(c.goldSql.toLowerCase()), `gold SQL ${c.id} found in src`).toBe(false);
    }
    for (const n of HELDOUT_NEGATIVES) expect(source.includes(n.question.toLowerCase()), n.id).toBe(false);
  });
});

describe("held-out datasets go through the real upload path", () => {
  it("HR (.sql) imports with the expected structure and real foreign keys", () => {
    expect(loaded.hrStats).toEqual({ tables: 5, columns: 5 * 0 + 3 + 3 + 7 + 4 + 6, rows: 6 + 12 + 72 + 72 + 96, relationships: 4 });
  });

  it("Sales (.csv) imports; the importer SUGGESTS exactly the five true relationships (no false positives) and they become real FKs once confirmed", () => {
    const s = loaded.relationshipSuggestions;
    expect(s.unexpected).toEqual([]);
    expect(s.missed).toEqual([]);
    expect(s.correct).toHaveLength(5);
    expect(loaded.salesStats.tables).toBe(6);
    expect(loaded.salesStats.relationships).toBe(5);
  });
});

describe("held-out gold queries", () => {
  it("every gold query (and alternative) validates and executes as the dataset's read-only role, with a non-empty result", async () => {
    for (const c of HELDOUT) {
      const gold = await runGold(loaded.contexts[c.dataset], c);
      expect(gold.ok, `${c.id}: ${gold.error}`).toBe(true);
      expect(gold.rows.length, `${c.id} returned no rows`).toBeGreaterThan(0);
    }
  });

  it("gold results are unambiguous: no ties at the boundary of any top-N / max question", async () => {
    const q = async (id: string, sql: string) => {
      const c = HELDOUT.find((x) => x.id === id)!;
      const r = await runAsDataset(loaded.contexts[c.dataset], sql);
      expect(r.success, id).toBe(true);
      return r.success ? r.rows : [];
    };
    const hrTop = await q("hr-03", "SELECT amount FROM salaries ORDER BY amount DESC LIMIT 7");
    expect(hrTop[4].amount).not.toBe(hrTop[5].amount);
    const s3 = await q("sales-03", "SELECT SUM(quantity) AS q FROM order_items GROUP BY product_id ORDER BY q DESC LIMIT 4");
    expect(s3[2].q).toBeGreaterThan(s3[3].q as number);
    const s5 = await q("sales-05", "SELECT COUNT(*) AS n FROM orders GROUP BY customer_id ORDER BY n DESC LIMIT 4");
    expect(s5[0].n).toBeGreaterThan(s5[1].n as number);
    expect(s5[2].n).toBeGreaterThan(s5[3].n as number); // sales-11 (top 3)
    const s11 = await q("sales-11", "SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.name ORDER BY COUNT(*) DESC LIMIT 3");
    expect(s11).toHaveLength(3);
    const hire = await q("hr-11", "SELECT hire_date FROM employees ORDER BY hire_date LIMIT 2");
    expect(hire[0].hire_date).not.toBe(hire[1].hire_date);
    const eng = await q("hr-10", "SELECT s.amount FROM salaries s JOIN employees e ON e.id = s.employee_id JOIN departments d ON d.id = e.department_id WHERE d.name = 'Engineering' ORDER BY s.amount DESC LIMIT 2");
    expect(eng[0].amount).not.toBe(eng[1].amount);
    // demo: single-answer questions really have a single answer
    const sup = await q("demo-01", "SELECT rating FROM suppliers ORDER BY rating DESC LIMIT 2");
    expect(sup[0].rating).not.toBe(sup[1].rating);
    const wh = await q("demo-04", "SELECT SUM(quantity_on_hand) AS s FROM warehouse_inventory GROUP BY warehouse_id ORDER BY s DESC LIMIT 2");
    expect(wh[0].s).toBeGreaterThan(wh[1].s as number);
  });

  it("gold SQL agrees with an independent JavaScript oracle computed from the generator data (a wrong gold query cannot hide)", async () => {
    const hr = generateHr();
    const sales = generateSales();
    const one = async (id: string) => {
      const c = HELDOUT.find((x) => x.id === id)!;
      const g = await runGold(loaded.contexts[c.dataset], c);
      expect(g.ok, id).toBe(true);
      return g.rows;
    };
    const num = (v: unknown) => Number(v);

    expect(num((await one("hr-01"))[0].n)).toBe(hr.employees.length);
    expect(num((await one("hr-02"))[0].avg_salary)).toBeCloseTo(hr.salaries.reduce((a, s) => a + s.amount, 0) / hr.salaries.length, 2);
    const top5 = [...hr.salaries].sort((a, b) => b.amount - a.amount).slice(0, 5).map((s) => hr.employees.find((e) => e.id === s.employeeId)!.fullName);
    expect((await one("hr-03")).map((r) => r.full_name)).toEqual(top5);
    expect(num((await one("hr-07"))[0].n)).toBe(hr.employees.filter((e) => e.hireDate.startsWith("2021")).length);
    expect(num((await one("hr-09"))[0].n)).toBe(hr.leaveRequests.filter((l) => l.status === "approved" && l.startDate.startsWith("2024-03")).length);
    const eng = hr.employees.filter((e) => e.departmentId === 1).map((e) => ({ e, s: hr.salaries.find((s) => s.employeeId === e.id)!.amount })).sort((a, b) => b.s - a.s)[0];
    expect((await one("hr-10"))[0].full_name).toBe(eng.e.fullName);
    expect((await one("hr-11"))[0].full_name).toBe([...hr.employees].sort((a, b) => a.hireDate.localeCompare(b.hireDate))[0].fullName);
    expect(num((await one("hr-12"))[0].n)).toBe(hr.employees.filter((e) => e.departmentId === 2 && e.status === "on_leave").length);

    expect(num((await one("sales-01"))[0].n)).toBe(sales.customers.length);
    expect(num((await one("sales-02"))[0].total_value)).toBeCloseTo(sales.orderItems.reduce((a, i) => a + i.quantity * i.unitPrice, 0), 2);
    expect(num((await one("sales-08"))[0].n)).toBe(sales.orders.filter((o) => o.orderDate.startsWith("2023")).length);
    expect(num((await one("sales-12"))[0].n)).toBe(sales.orders.filter((o) => o.status === "cancelled").length);
    const perCustomer = new Map<number, number>();
    for (const o of sales.orders) perCustomer.set(o.customerId, (perCustomer.get(o.customerId) ?? 0) + 1);
    const best = [...perCustomer.entries()].sort((a, b) => b[1] - a[1])[0];
    expect((await one("sales-05"))[0].name).toBe(sales.customers.find((c) => c.id === best[0])!.name);
    const germany = new Set(sales.customers.filter((c) => c.country === "Germany").map((c) => c.id));
    expect(num((await one("sales-06"))[0].n)).toBe(sales.orders.filter((o) => germany.has(o.customerId)).length);
    const qty = new Map<number, number>();
    for (const i of sales.orderItems) qty.set(i.productId, (qty.get(i.productId) ?? 0) + i.quantity);
    const top3 = [...qty.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => sales.products.find((p) => p.id === id)!.name);
    expect((await one("sales-03")).map((r) => r.name)).toEqual(top3);
  });

  it("the alternative representations really are the same answer (month as date vs number; year as number vs date)", async () => {
    for (const id of ["hr-08", "sales-07"]) {
      const c = HELDOUT.find((x) => x.id === id)!;
      const gold = await runGold(loaded.contexts[c.dataset], c);
      // the alternative, run as a "model answer", must be accepted through the alternative path
      const alt = await runAsDataset(loaded.contexts[c.dataset], c.altGoldSql![0]);
      expect(alt.success).toBe(true);
      if (alt.success) expect(matchGold(gold, alt.columns, alt.rows).match, id).toBe(true);
    }
  });

  it("a wrong answer is NOT accepted by the comparison", async () => {
    const c = HELDOUT.find((x) => x.id === "hr-04")!;
    const gold = await runGold(loaded.contexts.hr, c);
    const wrong = await runAsDataset(loaded.contexts.hr, "SELECT d.name, COUNT(*) + 1 AS employees FROM employees e JOIN departments d ON d.id = e.department_id GROUP BY d.name");
    expect(wrong.success && matchGold(gold, wrong.columns, wrong.rows).match).toBe(false);
  });
});

describe("routing on the uploaded datasets (deterministic, no LLM) — informational, not asserted against a target", () => {
  it("routing runs for every question and never returns more tables than the schema has (its quality is reported by the evaluation, not asserted here)", async () => {
    for (const c of HELDOUT) {
      const ctx = loaded.contexts[c.dataset];
      const r = await routedTables(ctx, c.question);
      expect(r.tables.length, c.id).toBeLessThanOrEqual(ctx.index.tableNames.length);
    }
  });
});

describe("upload corpus: the real importer against valid, malformed and malicious files", () => {
  const limits = { ...getUploadLimits(), maxUploadsPerHour: 100000, maxDatasetsPerSession: 100000 };
  const counts = async () => ({
    schemas: (await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ds\\_%'")).rows[0].n as number,
    roles: (await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'nl2sql\\_ro\\_%'")).rows[0].n as number,
    orders: (await pool.query("SELECT count(*)::int AS n FROM shop.orders")).rows[0].n as number,
    runs: (await pool.query("SELECT count(*)::int AS n FROM nl2sql.query_runs")).rows[0].n as number,
    grants: (await pool.query("SELECT count(*)::int AS n FROM pg_auth_members")).rows[0].n as number,
  });

  it("valid files are imported; malformed files are rejected with a readable reason; malicious SQL is rejected with the standard message; rejections leave nothing behind", async () => {
    const results: { id: string; kind: string; ok: boolean; message?: string; details?: string[] }[] = [];
    const created: string[] = [];
    const base = await counts();
    // measure the schemas/roles left by rejected files only: import valid ones first, remember them, delete them at the end
    let residueBaseline = base;
    for (const c of UPLOAD_CORPUS) {
      const before = c.kind.startsWith("valid") ? null : await counts();
      try {
        const ds = await importDataset({ name: c.id, files: c.files, generateDescriptions: false }, { pool, sessionId: SESSION, clientHash: "heldout-corpus", limits });
        created.push(ds.id);
        results.push({ id: c.id, kind: c.kind, ok: true });
        residueBaseline = await counts();
      } catch (e) {
        expect(e).toBeInstanceOf(ImportError);
        results.push({ id: c.id, kind: c.kind, ok: false, message: (e as ImportError).message, details: (e as ImportError).details });
        if (before) expect(await counts(), `${c.id} left something behind`).toEqual(before);
      }
    }
    for (const id of created) await deleteDataset(pool, id).catch(() => undefined);

    const of = (k: string) => results.filter((r) => r.kind === k);
    expect(of("valid_sql").filter((r) => !r.ok), "valid SQL rejected").toEqual([]);
    expect(of("valid_csv").filter((r) => !r.ok), "valid CSV rejected").toEqual([]);
    expect(of("malformed_sql").filter((r) => r.ok), "malformed SQL accepted").toEqual([]);
    expect(of("malformed_csv").filter((r) => r.ok), "malformed CSV accepted").toEqual([]);
    expect(of("malicious_sql").filter((r) => r.ok), "malicious SQL accepted").toEqual([]);
    for (const r of of("malicious_sql")) expect(r.message, r.id).toBe(UNSUPPORTED_SQL_MESSAGE);
    for (const r of of("malformed_sql").concat(of("malformed_csv"))) {
      expect(r.message, r.id).toBeTruthy();
      if (r.message === UNSUPPORTED_SQL_MESSAGE) expect(r.details?.length, `${r.id}: the generic message must come with line-specific details`).toBeGreaterThan(0);
    }
    void residueBaseline;
    // after deleting everything the corpus created, the cluster is back to where it started
    expect(await counts()).toEqual(base);
  }, 180_000);
});
