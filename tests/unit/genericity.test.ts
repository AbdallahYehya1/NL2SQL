import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { builtinIndex } from "@/lib/metadata/registry";

/**
 * Architecture guard: the generic NL2SQL engine must not know the demo database.
 *
 * Every file under src/lib is scanned (comments removed). Demo table names and the demo schema/role may only appear in the
 * files that DEFINE the built-in demo dataset or bind the demo's security defaults. Anything else that mentions them would be
 * a hidden demo-specific assumption that breaks uploaded datasets.
 */

const DEMO_WORDS = [...builtinIndex.tableNames, "shop", "nl2sql_readonly"];
const WORD = new RegExp(`\\b(${DEMO_WORDS.join("|")})\\b`, "g");

/** Files that legitimately contain demo vocabulary: `words` limits the exemption to those words ("*" = any), `why` explains it. */
const ALLOWED: Record<string, { words: string[] | "*"; why: string }> = {
  "metadata/definitions.ts": { words: "*", why: "the demo's curated registry data" },
  "metadata/registry.ts": { words: ["shop"], why: "DATA_SCHEMA = 'shop' (the built-in dataset's schema constant)" },
  "datasets/context.ts": { words: "*", why: "defines the built-in demo dataset context (description, topics, examples)" },
  "datasets/store.ts": { words: "*", why: "counts rows of the built-in demo tables for the dataset list" },
  "security/sql-policy.ts": { words: ["shop"], why: "ALLOWED_SCHEMA default = the demo schema" },
  "config.ts": { words: ["nl2sql_readonly"], why: "DB_EXECUTION_ROLE default = the demo dataset's read-only role" },
  "datasets/import-service.ts": { words: ["nl2sql_readonly"], why: "grants each dataset role to the demo's read-only role so SET ROLE works" },
  "datasets/metadata-builder.ts": { words: ["stores"], why: "the English verb in a description template ('the table that stores those things') — not a table name" },
  "format.ts": {
    words: ["customers", "orders", "products", "reviews"],
    why: "generic English nouns used to recognise a plain entity COUNT (e.g. total_customers) so the KPI display doesn't put a $ in front of it — applied to the last word of ANY numeric column name, for any dataset; not a reference to the demo's tables",
  },
};

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe("the generic engine contains no demo-specific table names", () => {
  const root = path.resolve(process.cwd(), "src/lib");
  const files = walk(root).filter((f) => f.endsWith(".ts"));

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("demo table names / schema appear only in the files that define the built-in dataset", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file).replace(/\\/g, "/");
      const allowed = ALLOWED[rel];
      if (allowed?.words === "*") continue;
      const hits = [...stripComments(fs.readFileSync(file, "utf8")).matchAll(WORD)].map((m) => m[1]).filter((w) => !allowed?.words.includes(w));
      if (hits.length) offenders.push(`${rel}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders, "demo-specific vocabulary found in generic engine code — move it into dataset metadata").toEqual([]);
  });

  it("the allow-list is tight: every exemption is actually used (it cannot silently grow stale)", () => {
    const stale: string[] = [];
    for (const [rel, { words }] of Object.entries(ALLOWED)) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) {
        stale.push(`${rel}: file is gone`);
        continue;
      }
      const hits = new Set([...stripComments(fs.readFileSync(file, "utf8")).matchAll(WORD)].map((m) => m[1]));
      const unused = words === "*" ? (hits.size ? [] : ["*"]) : words.filter((w) => !hits.has(w));
      if (unused.length) stale.push(`${rel}: unused exemption ${unused.join(", ")}`);
    }
    expect(stale).toEqual([]);
  });
});

describe("no production code path relies on the implicit demo default", () => {
  const root = path.resolve(process.cwd(), "src");
  const files = walk(root).filter((f) => /\.(ts|tsx)$/.test(f));

  it("processQuestion resolves the dataset explicitly and hands it to every stage that takes one", () => {
    const orch = stripComments(fs.readFileSync(path.join(root, "lib/nl2sql/orchestrator.ts"), "utf8"));
    for (const call of ["retrieveMetadata(", "route(", "validateSql(", "buildSubSchema(", "stageBuildSubSchema("]) {
      const idx = [...orch.matchAll(new RegExp(call.replace("(", "\\("), "g"))].map((m) => m.index!);
      for (const i of idx) {
        const args = orch.slice(i, i + 260);
        if (/function\s/.test(orch.slice(Math.max(0, i - 16), i))) continue; // the definition itself
        expect(/dataset|dsOf\(deps\)/.test(args), `${call} in orchestrator.ts must receive the dataset: ${args.slice(0, 90)}`).toBe(true);
      }
    }
  });

  it("API routes never construct a demo context themselves", () => {
    for (const file of files.filter((f) => f.replace(/\\/g, "/").includes("/app/api/"))) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/getBuiltinContext\(/);
    }
  });
});
