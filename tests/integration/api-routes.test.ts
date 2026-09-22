import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pointAtTestDatabase } from "../helpers/db";
import { closePools, getAdminPool } from "@/lib/database/client";
import { deleteDataset, importDataset } from "@/lib/datasets/import-service";
import { COMPANY_SQL, CUSTOMERS_CSV, ORDERS_CSV, TEST_LIMITS } from "../helpers/datasets";

/**
 * API route behaviour with a real database. Only the framework boundary `next/headers` (per-request cookies / headers) is stubbed with a
 * cookie jar so the route handlers can run outside a Next request; ownership, status checks, import, deletion and queries are all real.
 */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { name: k, value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

pointAtTestDatabase();

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const as = (sid: string | undefined) => {
  jar.clear();
  if (sid) jar.set("nl2sql_sid", sid);
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, body: unknown, method = "POST") => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

let pool: pg.Pool;
let owned: string; // ready dataset owned by A
let processing: string; // row stuck in 'processing', owned by A
let failedId: string;
const created: string[] = [];

beforeAll(async () => {
  pool = getAdminPool();
  const ds = await importDataset({ name: "API HR", files: [{ name: "hr.sql", text: COMPANY_SQL }], generateDescriptions: false }, { pool, sessionId: SESSION_A, clientHash: "api-test-A", limits: TEST_LIMITS });
  owned = ds.id;
  created.push(owned);
  processing = "ds_0a0a0a0a0a";
  failedId = "ds_0b0b0b0b0b";
  await pool.query(
    `INSERT INTO nl2sql.datasets (id, name, source_type, status, schema_name, session_id) VALUES
       ($1, 'Still processing', 'sql', 'processing', $1, $3), ($2, 'Broken', 'csv', 'failed', $2, $3)`,
    [processing, failedId, SESSION_A],
  );
});

afterAll(async () => {
  for (const id of created) await deleteDataset(pool, id).catch(() => undefined);
  await pool.query("DELETE FROM nl2sql.datasets WHERE id IN ($1, $2)", [processing, failedId]);
  await pool.query("DELETE FROM nl2sql.datasets WHERE client_hash LIKE 'api-test-%' OR session_id IN ($1, $2)", [SESSION_A, SESSION_B]);
  await pool.query("DELETE FROM nl2sql.query_runs WHERE session_id IN ($1, $2)", [SESSION_A, SESSION_B]);
  await closePools();
});

describe("GET /api/datasets", () => {
  it("lists the demo plus only the datasets of the calling session", async () => {
    const { GET } = await import("@/app/api/datasets/route");
    as(SESSION_A);
    const a = await (await GET()).json();
    expect(a.datasets.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining(["demo", owned]));
    as(SESSION_B);
    const b = await (await GET()).json();
    expect(b.datasets.map((d: { id: string }) => d.id)).toEqual(["demo"]);
    as(undefined);
    expect((await (await GET()).json()).datasets.map((d: { id: string }) => d.id)).toEqual(["demo"]);
  });

  it("publishes the limits and never returns credentials or SQL text", async () => {
    const { GET } = await import("@/app/api/datasets/route");
    as(SESSION_A);
    const body = await (await GET()).json();
    expect(body.limits).toMatchObject({ maxRows: expect.any(Number), ttlHours: 72, maxFiles: 10 });
    expect(JSON.stringify(body)).not.toMatch(/password|postgres(ql)?:\/\/|DATABASE_URL/i);
  });
});

describe("GET/DELETE /api/datasets/[id] — ownership and existence", () => {
  it("returns details to the owner, 404 to another session and to unknown / malformed ids", async () => {
    const { GET } = await import("@/app/api/datasets/[id]/route");
    as(SESSION_A);
    const ok = await GET(new Request("http://localhost"), params(owned));
    expect(ok.status).toBe(200);
    expect((await ok.json()).tables.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["employees"]));
    as(SESSION_B);
    expect((await GET(new Request("http://localhost"), params(owned))).status).toBe(404);
    as(SESSION_A);
    for (const id of ["ds_ffffffffff", "nope", "../../etc/passwd", "ds_x'; DROP TABLE nl2sql.datasets;--", ""]) {
      expect((await GET(new Request("http://localhost"), params(id))).status, id).toBe(404);
    }
  });

  it("only the owner can delete; deleting drops the schema and role and later requests get 404", async () => {
    const { GET, DELETE } = await import("@/app/api/datasets/[id]/route");
    const { POST: query } = await import("@/app/api/query/route");
    const ds = await importDataset({ name: "To delete", files: [{ name: "hr.sql", text: COMPANY_SQL }], generateDescriptions: false }, { pool, sessionId: SESSION_A, clientHash: "api-test-A", limits: TEST_LIMITS });
    created.push(ds.id);

    as(SESSION_B);
    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), params(ds.id))).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [ds.id])).rowCount).toBe(1); // untouched

    as(SESSION_A);
    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), params(ds.id))).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [ds.id])).rowCount).toBe(0);
    expect((await GET(new Request("http://localhost"), params(ds.id))).status).toBe(404); // a deleted dataset is gone for its owner too
    const res = await query(jsonReq("/api/query", { question: "How many employees are there?", datasetId: ds.id }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("DATASET_NOT_FOUND");
  });

  it("the demo dataset cannot be deleted", async () => {
    const { DELETE } = await import("@/app/api/datasets/[id]/route");
    as(SESSION_A);
    const res = await DELETE(new Request("http://localhost", { method: "DELETE" }), params("demo"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await pool.query("SELECT 1 FROM nl2sql.datasets WHERE id = 'demo' AND status = 'ready'")).rowCount).toBe(1);
  });
});

describe("POST /api/query — dataset resolution and malformed requests", () => {
  it("malformed JSON, missing / empty / too-long question → 400 with a readable message", async () => {
    const { POST } = await import("@/app/api/query/route");
    as(SESSION_A);
    for (const body of ["{not json", "null", "{}", { question: "" }, { question: 42 }, { question: "x".repeat(600) }]) {
      const res = await POST(jsonReq("/api/query", body));
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toBeTruthy();
    }
  });

  it("unknown dataset → 404; another session's dataset → 404 (indistinguishable from unknown)", async () => {
    const { POST } = await import("@/app/api/query/route");
    as(SESSION_A);
    const unknown = await POST(jsonReq("/api/query", { question: "How many employees are there?", datasetId: "ds_ffffffffff" }));
    expect(unknown.status).toBe(404);
    as(SESSION_B);
    const foreign = await POST(jsonReq("/api/query", { question: "How many employees are there?", datasetId: owned }));
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error).toEqual({ code: "DATASET_NOT_FOUND", message: "Dataset not found." });
  });

  it("a dataset that is still processing or failed → 409 DATASET_NOT_READY", async () => {
    const { POST } = await import("@/app/api/query/route");
    as(SESSION_A);
    for (const id of [processing, failedId]) {
      const res = await POST(jsonReq("/api/query", { question: "How many rows are there?", datasetId: id }));
      expect(res.status, id).toBe(409);
      expect((await res.json()).error.code).toBe("DATASET_NOT_READY");
    }
  });

  it("error bodies never contain stack traces, file paths, SQL internals or connection strings", async () => {
    const { POST } = await import("@/app/api/query/route");
    as(SESSION_A);
    const texts: string[] = [];
    for (const body of ["{bad", { question: "" }, { question: "q", datasetId: "ds_ffffffffff" }, { question: "q", datasetId: processing }]) {
      texts.push(await (await POST(jsonReq("/api/query", body))).text());
    }
    expect(texts.join("\n")).not.toMatch(/\bat \S+\.(ts|js):\d+|[A-Z]:\\|\/home\/|node_modules|postgres(ql)?:\/\/|password|stack/i);
  });
});

describe("POST /api/datasets/[id]/activate", () => {
  it("owner can activate a ready dataset (cookie is a UI default only); not-ready → 409; foreign/unknown → 404", async () => {
    const { POST } = await import("@/app/api/datasets/[id]/activate/route");
    as(SESSION_A);
    const ok = await POST(new Request("http://localhost", { method: "POST" }), params(owned));
    expect(ok.status).toBe(200);
    expect(jar.get("nl2sql_dataset")).toBe(owned);
    expect((await POST(new Request("http://localhost", { method: "POST" }), params(processing))).status).toBe(409);
    expect((await POST(new Request("http://localhost", { method: "POST" }), params("ds_ffffffffff"))).status).toBe(404);
    as(SESSION_B);
    expect((await POST(new Request("http://localhost", { method: "POST" }), params(owned))).status).toBe(404);
    expect(jar.has("nl2sql_dataset")).toBe(false);
  });
});

describe("POST /api/datasets/[id]/relationships", () => {
  it("rejects malformed bodies (400) and other sessions (404); unsuggested relationships cannot be confirmed", async () => {
    const { POST } = await import("@/app/api/datasets/[id]/relationships/route");
    as(SESSION_A);
    expect((await POST(jsonReq("/x", "{bad"), params(owned))).status).toBe(400);
    expect((await POST(jsonReq("/x", { confirm: "yes" }), params(owned))).status).toBe(400);
    expect((await POST(jsonReq("/x", { confirm: Array(61).fill({ fromTable: "a", fromColumn: "b", toTable: "c", toColumn: "d" }) }), params(owned))).status).toBe(400);
    as(SESSION_B);
    expect((await POST(jsonReq("/x", { confirm: [] }), params(owned))).status).toBe(404);
    as(SESSION_A);
    const res = await POST(jsonReq("/x", { confirm: [{ fromTable: "salaries", fromColumn: "amount", toTable: "departments", toColumn: "id" }] }), params(owned));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await pool.query(`SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.contype = 'f'`, [owned])).rows[0].n).toBe(2); // still only the file's own 2 FKs
  });
});

describe("POST /api/datasets/upload — streaming import and its failure modes", () => {
  const events = async (res: Response) => (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: string; details?: string[]; dataset?: { id: string; name: string }; status?: number });
  const upload = async (files: { name: string; text: string }[], extra: Record<string, string> = {}) => {
    const { POST } = await import("@/app/api/datasets/upload/route");
    const form = new FormData();
    for (const f of files) form.append("files", new File([f.text], f.name));
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return POST(new Request("http://localhost/api/datasets/upload", { method: "POST", body: form }));
  };
  const schemaCount = async () => (await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ds\\_%'")).rows[0].n as number;

  it("a valid CSV pair imports, streams progress steps and ends with a done event owned by the caller", async () => {
    as(SESSION_B);
    const res = await upload([{ name: "customers.csv", text: CUSTOMERS_CSV }, { name: "orders.csv", text: ORDERS_CSV }], { name: "API CSV" });
    expect(res.headers.get("content-type")).toContain("ndjson");
    const ev = await events(res);
    expect(ev.filter((e) => e.type === "progress").length).toBeGreaterThanOrEqual(4);
    const done = ev[ev.length - 1];
    expect(done.type).toBe("done");
    created.push(done.dataset!.id);
    as(SESSION_A);
    const { GET } = await import("@/app/api/datasets/[id]/route");
    expect((await GET(new Request("http://localhost"), params(done.dataset!.id))).status).toBe(404); // A cannot see B's upload
  });

  it("malicious SQL → error event 'unsupported statements', HTTP-level success of the stream, nothing created", async () => {
    as(SESSION_A);
    const before = await schemaCount();
    const runsBefore = (await pool.query("SELECT count(*)::int AS n FROM nl2sql.query_runs")).rows[0].n as number;
    const ev = await events(await upload([{ name: "evil.sql", text: "CREATE TABLE t (id int);\nDROP TABLE nl2sql.query_runs;\nGRANT ALL ON ALL TABLES IN SCHEMA nl2sql TO PUBLIC;" }]));
    const last = ev[ev.length - 1];
    expect(last.type).toBe("error");
    expect(last.message).toBe("This SQL file contains unsupported statements.");
    expect(last.details!.join(" ")).toMatch(/line 2/);
    expect(await schemaCount()).toBe(before);
    // the statements aimed at nl2sql.query_runs did nothing: the table exists and has exactly the rows it had
    expect((await pool.query("SELECT count(*)::int AS n FROM nl2sql.query_runs")).rows[0].n).toBe(runsBefore);
  });

  it("malformed CSV, unsupported extension and mixed formats give readable errors", async () => {
    as(SESSION_A);
    const bad = await events(await upload([{ name: "a.csv", text: "id,name\n1,x\n2\n" }]));
    expect(bad[bad.length - 1].type).toBe("error");
    expect(bad[bad.length - 1].message).toMatch(/row|field|column/i);
    const ext = await events(await upload([{ name: "notes.txt", text: "hello" }]));
    expect(ext[ext.length - 1].type).toBe("error");
    const mixed = await events(await upload([{ name: "a.csv", text: "id\n1\n" }, { name: "b.sql", text: "CREATE TABLE t (id int);" }]));
    expect(mixed[mixed.length - 1].type).toBe("error");
  });

  it("malformed requests: no body / no files / too many files / oversize file", async () => {
    const { POST } = await import("@/app/api/datasets/upload/route");
    as(SESSION_A);
    expect((await POST(new Request("http://localhost/api/datasets/upload", { method: "POST", body: "not multipart" }))).status).toBe(400);
    expect((await upload([])).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.csv`, text: "id\n1\n" }));
    expect((await upload(many)).status).toBe(422);
    expect((await upload([{ name: "big.csv", text: "id\n" + "1\n".repeat(1_200_000) }])).status).toBe(413); // > 2 MB CSV
  });

  it("the total upload size is enforced on the parsed files even without a Content-Length header", async () => {
    as(SESSION_A);
    // 5 x 1.9 MB CSV files: each is below the per-file limit, together they exceed the 4 MB request limit
    const chunk = "id\n" + "1\n".repeat(950_000);
    const res = await upload(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.csv`, text: chunk })));
    expect(res.status).toBe(413);
  });
});
