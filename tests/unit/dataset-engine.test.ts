import { describe, expect, it } from "vitest";
import { createDatasetContext, getBuiltinContext } from "@/lib/datasets/context";
import { describeSchemaWithLlm } from "@/lib/datasets/describe";
import { looksSensitive, type IntrospectedSchema } from "@/lib/datasets/introspect";
import { buildRegistryFromIntrospection } from "@/lib/datasets/metadata-builder";
import { quoteIdent, sqlName, assertSafeIdent } from "@/lib/datasets/sql-util";
import { suggestQuestions } from "@/lib/datasets/suggestions";
import { renderSubSchema } from "@/lib/ai/prompts/common";
import { buildQuestionAnalysisPrompt } from "@/lib/ai/prompts/question-analysis";
import { validateSql } from "@/lib/database/validator";
import { retrieveMetadata } from "@/lib/nl2sql/metadata-retriever";
import { analyzeWithRules, outOfScopeMessage } from "@/lib/nl2sql/question-analyzer";
import { route } from "@/lib/nl2sql/router";
import { buildSubSchema } from "@/lib/nl2sql/sub-schema-builder";
import { ScriptedProvider } from "../helpers/scripted-provider";
import { fixtureContext } from "../helpers/datasets";

const hr = fixtureContext("ds_aaaaaaaaaa", "Company HR");

describe("the validator's allow-list is built from the selected dataset", () => {
  it("accepts only that dataset's tables (unqualified or schema-qualified with its own schema)", async () => {
    expect((await validateSql("SELECT d.name, AVG(s.amount) FROM departments d JOIN employees e ON e.department_id = d.id JOIN salaries s ON s.employee_id = e.id GROUP BY d.name", hr)).valid).toBe(true);
    expect((await validateSql("SELECT * FROM ds_aaaaaaaaaa.employees", hr)).valid).toBe(true);
  });

  it("rejects the application schema, other datasets, the demo tables and system catalogs", async () => {
    for (const sql of [
      "SELECT * FROM nl2sql.users",
      "SELECT * FROM nl2sql.query_runs",
      "SELECT * FROM ds_bbbbbbbbbb.employees",
      "SELECT * FROM shop.orders",
      "SELECT * FROM orders", // a demo table name is not part of this dataset
      "SELECT * FROM public.employees",
      "SELECT * FROM pg_catalog.pg_tables",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM pg_shadow",
    ]) {
      const r = await validateSql(sql, hr);
      expect(r.valid, sql).toBe(false);
    }
    expect((await validateSql("SELECT * FROM ds_bbbbbbbbbb.employees", hr)).issues[0].code).toBe("FORBIDDEN_SCHEMA");
    expect((await validateSql("SELECT * FROM orders", hr)).issues[0].message).toContain("Available tables: departments, employees, salaries");
  });

  it("checks columns against the dataset's registry", async () => {
    const r = await validateSql("SELECT e.password FROM employees e", hr);
    expect(r.issues[0].code).toBe("UNKNOWN_COLUMN");
    expect(r.issues[0].message).toContain("department_id");
  });

  it("keeps every other rule: single statement, read-only, no comments, allow-listed functions", async () => {
    for (const sql of ["DROP TABLE customers;", "DELETE FROM employees", "UPDATE employees SET name = 'x'", "SELECT 1; SELECT 2", "SELECT * FROM employees -- x", "SELECT pg_sleep(9) FROM employees"]) {
      expect((await validateSql(sql, hr)).valid, sql).toBe(false);
    }
  });

  it("the built-in demo context still validates its own tables and refuses the dataset's", async () => {
    const demo = getBuiltinContext();
    expect((await validateSql("SELECT COUNT(*) FROM orders", demo)).valid).toBe(true);
    expect((await validateSql("SELECT COUNT(*) FROM salaries", demo)).valid).toBe(false);
  });
});

describe("the generic engine works from metadata alone (no hard-coded table names)", () => {
  it("routes a question over an uploaded schema to the right tables and join path", async () => {
    const q = "Which department has the highest average salary?";
    const ret = await retrieveMetadata(q, { dataset: hr });
    const routing = route(ret.items, ret.method, ret.vectorUnavailableReason, hr);
    const sub = buildSubSchema(routing, undefined, hr);
    const names = sub.tables.map((t) => t.name).sort();
    expect(names).toEqual(["departments", "employees", "salaries"]); // employees is a join bridge
    expect(sub.tables.find((t) => t.name === "employees")!.bridgeOnly).toBe(true);
    expect(sub.relationships.map((r) => `${r.fromTable}.${r.fromColumn}=${r.toTable}.${r.toColumn}`).sort()).toEqual(["employees.department_id=departments.id", "salaries.employee_id=employees.id"]);
    expect(sub.tables.every((t) => !["orders", "products", "customers"].includes(t.name))).toBe(true);
  });

  it("never returns metadata of another dataset", async () => {
    const other = createDatasetContext({
      id: "ds_bbbbbbbbbb",
      name: "Other",
      sourceType: "sql",
      schemaName: "ds_bbbbbbbbbb",
      registry: buildRegistryFromIntrospection({
        tables: [{ name: "spaceships", rowCount: 1, primaryKey: ["id"], foreignKeys: [], uniqueKeys: [], columns: [{ name: "id", type: "integer", nullable: false, hasDefault: false, distinctCount: 1, sampleValues: [] }] }],
      }),
    });
    const inHr = await retrieveMetadata("how many spaceships are there", { dataset: hr });
    expect(inHr.items.every((i) => !i.id.includes("spaceships"))).toBe(true);
    const inOther = await retrieveMetadata("how many spaceships are there", { dataset: other });
    expect(inOther.items[0].id).toContain("spaceships");
    expect(hr.lexical).not.toBe(other.lexical);
  });

  it("documented defaults come from data: uploaded datasets get the generic ones, the demo keeps its own", async () => {
    const ret = await retrieveMetadata("average salary per department", { dataset: hr });
    const sub = buildSubSchema(route(ret.items, ret.method, undefined, hr), undefined, hr);
    expect(sub.defaults.map((d) => d.name).sort()).toEqual(["counting", "ranking", "relative_dates", "rounding"]);
    const demo = getBuiltinContext();
    const dret = await retrieveMetadata("revenue by category", { dataset: demo });
    const dsub = buildSubSchema(route(dret.items, dret.method, undefined, demo), undefined, demo);
    expect(dsub.defaults.map((d) => d.name)).toEqual(expect.arrayContaining(["revenue_scope", "category"]));
  });

  it("question analysis and refusals name the dataset's own topics", () => {
    expect(outOfScopeMessage(hr)).toContain("departments");
    expect(outOfScopeMessage(hr)).not.toContain("revenue");
    expect(analyzeWithRules("What's the weather today?", hr.lexical, hr).decision).toBe("out_of_scope");
    expect(analyzeWithRules("How many employees are there?", hr.lexical, hr).decision).toBe("proceed");
    expect(analyzeWithRules("What were the sales?", hr.lexical, hr).intent.clarificationOptions).toEqual(hr.clarificationOptions);
    const prompt = buildQuestionAnalysisPrompt("q", hr);
    expect(prompt.system).toContain("- employees:");
    expect(prompt.system).not.toContain("online orders");
  });

  it("no demo vocabulary leaks into another dataset's clarification, scope reason or write-request rules", () => {
    const demo = getBuiltinContext();
    const vague = analyzeWithRules("What were the sales?", hr.lexical, hr).intent;
    expect(vague.clarificationQuestion).toBe(hr.clarificationQuestion);
    expect(vague.clarificationQuestion).not.toMatch(/revenue|orders|units sold/i);
    expect(analyzeWithRules("What were the sales?", demo.lexical, demo).intent.clarificationQuestion).toContain("revenue");
    const weather = analyzeWithRules("What's the weather today?", hr.lexical, hr).intent;
    expect(weather.scopeReason).not.toMatch(/retail|write|read-only|modify/i); // (the orchestrator picks the refusal wording from this text)

    // soft write verbs are recognised for THIS dataset's own tables / columns (salary, department), not for a fixed list of demo nouns
    for (const q of ["Add a new salary for Ada", "please remove all departments", "Modify the department name", "change the salaries", "Create a new employee"]) {
      expect(analyzeWithRules(q, hr.lexical, hr).decision, q).toBe("out_of_scope");
    }
    // ... and a read question that merely contains such a word is not refused
    for (const q of ["How many departments are there?", "Which employee has the highest salary?", "What is the average salary change per department?"]) {
      expect(analyzeWithRules(q, hr.lexical, hr).decision, q).toBe("proceed");
    }
    // demo nouns are not special-cased for other datasets: "remove the products" is only a write request where `products` is a table
    expect(analyzeWithRules("Change the products", demo.lexical, demo).decision).toBe("out_of_scope");
    expect(analyzeWithRules("Change the products", hr.lexical, hr).intent.scopeReason).not.toMatch(/write/i); // (refused as off-topic instead)
  });

  it("prompts quote names that need quoting", () => {
    const ctx = createDatasetContext({
      id: "ds_cccccccccc",
      name: "Quoting",
      sourceType: "sql",
      schemaName: "ds_cccccccccc",
      registry: buildRegistryFromIntrospection({
        tables: [{ name: "user", rowCount: 0, primaryKey: [], foreignKeys: [], uniqueKeys: [], columns: [{ name: "Order", type: "text", nullable: true, hasDefault: false, distinctCount: 0, sampleValues: [] }] }],
      }),
    });
    const text = renderSubSchema(buildSubSchema({ method: "lexical", items: [], tableScores: [], selectedTables: ["user"], bridgeTables: [], matchedMetrics: [] }, [], ctx));
    expect(text).toContain('TABLE "user"');
    expect(text).toContain('"Order" text');
    expect(text).toContain("must be written in double quotes");
    expect(sqlName("orders")).toBe("orders");
    expect(sqlName("Mixed")).toBe('"Mixed"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(() => assertSafeIdent('x"; drop')).toThrow();
    expect(() => assertSafeIdent("ds_0123456789")).not.toThrow();
  });
});

describe("metadata is generated from the real structure", () => {
  it("builds the same registry format as the built-in demo: types, nullability, keys, relationships, row counts", () => {
    const reg = hr.registry;
    expect(reg.tables.map((t) => t.name)).toEqual(["departments", "employees", "salaries"]);
    const emp = reg.tables.find((t) => t.name === "employees")!;
    expect(emp.primaryKey).toEqual(["id"]);
    expect(emp.rowCount).toBe(5);
    expect(emp.columns.find((c) => c.name === "department_id")).toMatchObject({ nullable: true, references: { table: "departments", column: "id" } });
    expect(reg.tables[2].columns.find((c) => c.name === "amount")).toMatchObject({ type: "numeric(10,2)", nullable: false });
    expect(reg.relationships).toHaveLength(2);
    expect(reg.tables[0].columns.find((c) => c.name === "name")!.sampleValues).toEqual(["Engineering", "HR", "Sales"]);
    expect(emp.synonyms).toEqual(expect.arrayContaining(["employee", "employees"]));
    expect(reg.metrics).toEqual([]);
  });

  it("marks where each description came from; database comments beat templates and LLM text", () => {
    const schema: IntrospectedSchema = {
      tables: [{ name: "t", comment: "From COMMENT ON", rowCount: 1, primaryKey: [], foreignKeys: [], uniqueKeys: [], columns: [{ name: "a", type: "text", nullable: true, hasDefault: false, distinctCount: 1, sampleValues: [] }] }],
    };
    const plain = buildRegistryFromIntrospection(schema);
    expect(plain.tables[0]).toMatchObject({ description: "From COMMENT ON", descriptionSource: "database" });
    expect(plain.tables[0].columns[0].descriptionSource).toBe("generated");
    const withLlm = buildRegistryFromIntrospection(schema, { llm: { tables: { t: "LLM table text" }, columns: { t: { a: "LLM column text" } } } });
    expect(withLlm.tables[0].description).toBe("From COMMENT ON"); // structure/DB always wins
    expect(withLlm.tables[0].columns[0]).toMatchObject({ description: "LLM column text", descriptionSource: "llm" });
  });

  it("suggests deterministic starter questions from the structure", () => {
    const qs = suggestQuestions(hr.registry);
    expect(qs.length).toBeGreaterThan(2);
    expect(qs.join(" ")).toMatch(/average amount for each (employee|department)/);
    expect(qs.every((q) => q.endsWith("?"))).toBe(true);
  });
});

describe("LLM-generated descriptions annotate but never change structure", () => {
  const schema: IntrospectedSchema = {
    tables: [{ name: "employees", rowCount: 2, primaryKey: ["id"], foreignKeys: [], uniqueKeys: [], columns: [{ name: "id", type: "integer", nullable: false, hasDefault: true, distinctCount: 2, sampleValues: ["SECRET-VALUE-1"] }] }],
  };
  it("drops hallucinated tables and columns and sends structure only (no data)", async () => {
    const provider = new ScriptedProvider({
      "dataset descriptions": [{ tables: [{ name: "employees", description: "People who work here", columns: [{ name: "id", description: "Identifier" }, { name: "ghost_col", description: "invented" }] }, { name: "ghost_table", description: "invented", columns: [] }] }],
    });
    const out = await describeSchemaWithLlm(provider, "HR", schema);
    expect(out.tables).toEqual({ employees: "People who work here" });
    expect(out.columns).toEqual({ employees: { id: "Identifier" } });
    const sent = provider.callsFor("dataset descriptions")[0];
    expect(sent.prompt).toContain("employees");
    expect(sent.prompt).not.toContain("SECRET-VALUE-1");
  });
});

describe("sensitive-value protection", () => {
  it("never keeps sample values for PII-looking columns or values", () => {
    expect(looksSensitive("email", [])).toBe(true);
    expect(looksSensitive("Password_hash", [])).toBe(true);
    expect(looksSensitive("phone_number", [])).toBe(true);
    expect(looksSensitive("street_address", [])).toBe(true);
    expect(looksSensitive("notes", ["reach me at a.b@example.com"])).toBe(false); // free text containing an email is not an email value
    expect(looksSensitive("contact", ["a.b@example.com"])).toBe(true);
    expect(looksSensitive("contact", ["+1 (555) 123-4567"])).toBe(true);
    expect(looksSensitive("api", ["sk_live_abcdefghijklmnopqrstuvwxyz012345"])).toBe(true);
    expect(looksSensitive("status", ["active", "left"])).toBe(false);
    expect(looksSensitive("department", ["Engineering"])).toBe(false);
  });
});

describe("system-catalog shadowing (security audit finding)", () => {
  // PostgreSQL searches pg_catalog first, so an unqualified `pg_class` reads the REAL catalog even when a dataset owns a table of that name.
  // The validator must therefore refuse catalog names even if a (forged / legacy) registry declares such a table.
  const shadow = createDatasetContext({
    id: "ds_dddddddddd",
    name: "Shadow",
    sourceType: "sql",
    schemaName: "ds_dddddddddd",
    registry: buildRegistryFromIntrospection({
      tables: [{ name: "pg_class", rowCount: 1, primaryKey: ["id"], foreignKeys: [], uniqueKeys: [], columns: [{ name: "id", type: "integer", nullable: false, hasDefault: false, distinctCount: 1, sampleValues: [] }] }],
    }),
  });

  it("refuses system-catalog names even when the dataset declares a table with that name", async () => {
    for (const sql of ["SELECT * FROM pg_class", "SELECT id FROM ds_dddddddddd.pg_class", "SELECT * FROM PG_CLASS", "SELECT * FROM information_schema.tables"]) {
      const r = await validateSql(sql, shadow);
      expect(r.valid, sql).toBe(false);
      expect(r.issues[0].code, sql).toMatch(/SYSTEM_ACCESS|FORBIDDEN_SCHEMA/);
    }
  });
});

describe("post-analysis generic fixes from the held-out benchmark", () => {
  it("'who' questions are data questions (a person-oriented question is not refused as off-topic)", () => {
    // held-out run: "Who has been at the company the longest?" was refused in 0 ms because 'who' was not a data-question word
    expect(analyzeWithRules("Who has been at the company the longest?", hr.lexical, hr).decision).toBe("proceed");
    expect(analyzeWithRules("Whose salary is highest?", hr.lexical, hr).decision).toBe("proceed");
    // off-topic 'who' questions are still refused
    expect(analyzeWithRules("Who is the president of France?", hr.lexical, hr).decision).toBe("out_of_scope");
    expect(analyzeWithRules("What's the weather like?", hr.lexical, hr).decision).toBe("out_of_scope");
  });

  it("the SQL rules carry the generic time-attribution guidance and no demo-specific column in their examples", async () => {
    const { SQL_RULES } = await import("@/lib/ai/prompts/common");
    expect(SQL_RULES).toMatch(/Time attribution/);
    expect(SQL_RULES).toMatch(/table whose rows are being counted or summed/);
    expect(SQL_RULES).not.toMatch(/order_date|refund|revenue/i);
  });
});
