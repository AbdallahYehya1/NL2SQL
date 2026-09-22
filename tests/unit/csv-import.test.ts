import { describe, expect, it } from "vitest";
import { inferColumnType, parseCsv, planCsvImport, sanitizeName } from "@/lib/datasets/csv-import";
import { ImportError, getUploadLimits } from "@/lib/datasets/limits";
import { CUSTOMERS_CSV, ORDERS_CSV } from "../helpers/datasets";

const limits = getUploadLimits({});
const fail = (files: { name: string; text: string }[], l = limits) => {
  try {
    planCsvImport(files, l);
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    return e as ImportError;
  }
  throw new Error("expected rejection");
};

describe("CSV parser", () => {
  it("handles quotes, doubled quotes, embedded delimiters and newlines", () => {
    const { records } = parseCsv('a,b,c\n1,"x, y","say ""hi"""\n2,"line1\nline2",z\n');
    expect(records).toEqual([["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["2", "line1\nline2", "z"]]);
  });
  it("handles CRLF, BOM, blank trailing lines and detects ; and tab delimiters", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n").records).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a;b\n1;2\n").records[1]).toEqual(["1", "2"]);
    expect(parseCsv("a\tb\n1\t2\n").delimiter).toBe("\t");
  });
  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a,b\n1,"oops\n')).toThrow(/unterminated/);
  });
});

describe("column type inference (conservative)", () => {
  it("infers specific types only when every value fits", () => {
    expect(inferColumnType(["1", "2", null])).toBe("integer");
    expect(inferColumnType(["1", "3000000000"])).toBe("bigint");
    expect(inferColumnType(["1.5", "2", "-3.25"])).toBe("numeric");
    expect(inferColumnType(["true", "No"])).toBe("boolean");
    expect(inferColumnType(["2024-01-31", "2023-12-01"])).toBe("date");
    expect(inferColumnType(["2024-01-31 10:00", "2024-02-01T11:30:15"])).toBe("timestamp");
    expect(inferColumnType(["2024-01-31T10:00:00Z"])).toBe("timestamptz");
  });
  it("falls back to text for mixed, ambiguous or code-like values", () => {
    expect(inferColumnType(["1", "two"])).toBe("text");
    expect(inferColumnType(["007", "010"])).toBe("text"); // leading zeros: ids / zip codes
    expect(inferColumnType(["2024-02-30"])).toBe("text"); // impossible date
    expect(inferColumnType(["1", "0"])).toBe("integer"); // 0/1 are numbers, not booleans
    expect(inferColumnType(["12345678901234567890"])).toBe("numeric"); // too big for bigint: exact numeric, never truncated
    expect(inferColumnType([null, null])).toBe("text");
  });
});

describe("CSV upload — valid files", () => {
  it("creates one table per file with inferred column types", () => {
    const plan = planCsvImport(
      [
        { name: "customers.csv", text: CUSTOMERS_CSV },
        { name: "orders.csv", text: ORDERS_CSV },
      ],
      limits,
    );
    expect(plan.tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    const c = plan.tables[0];
    expect(Object.fromEntries(c.columns.map((x) => [x.name, x.type]))).toEqual({ id: "integer", name: "text", city: "text", signup_date: "date", vip: "boolean" });
    const o = plan.tables[1];
    expect(o.columns.find((x) => x.name === "amount")?.type).toBe("numeric");
    expect(plan.stats).toEqual({ tables: 2, columns: 9, rows: 9 });
  });

  it("normalises table and column names and de-duplicates them", () => {
    const plan = planCsvImport([{ name: "My Orders (2024).csv", text: "Order ID,Order ID,Total $\n1,2,3\n" }, { name: "my orders 2024.csv", text: "x\n1\n" }], limits);
    expect(plan.tables[0].name).toBe("my_orders_2024");
    expect(plan.tables[0].columns.map((c) => c.name)).toEqual(["order_id", "order_id_2", "total"]);
    expect(plan.tables[1].name).toBe("my_orders_2024_2");
    expect(plan.warnings.join(" ")).toMatch(/normalised/);
  });

  it("keeps empty cells as NULL and warns about header-only files", () => {
    const plan = planCsvImport([{ name: "a.csv", text: "id,name\n1,\n,x\n" }, { name: "b.csv", text: "id\n" }], limits);
    expect(plan.tables[0].rows).toEqual([["1", null], [null, "x"]]);
    expect(plan.warnings.join(" ")).toMatch(/no data rows/);
  });

  it("sanitises hostile names into safe identifiers", () => {
    expect(sanitizeName('x"; DROP TABLE users; --', "c")).toBe("x_drop_table_users");
    expect(sanitizeName("123abc", "c")).toBe("c_123abc");
    expect(sanitizeName("   ", "fallback")).toBe("fallback");
    expect(sanitizeName("Größe", "c")).toBe("gro_e");
  });
});

describe("CSV upload — invalid files", () => {
  it("rejects rows with a different number of fields and names the lines", () => {
    const e = fail([{ name: "bad.csv", text: "a,b,c\n1,2,3\n4,5\n6,7,8,9\n" }]);
    expect(e.message).toMatch(/does not match the header/);
    expect(e.details).toEqual(["line 3: 2 fields, expected 3", "line 4: 4 fields, expected 3"]);
  });
  it("rejects empty files and files without a header", () => {
    expect(fail([{ name: "e.csv", text: "" }]).message).toMatch(/empty/);
    expect(fail([{ name: "e.csv", text: "  \n\n" }]).message).toMatch(/empty/);
    expect(fail([{ name: "e.csv", text: ",,\n1,2,3\n" }]).message).toMatch(/no header/);
    expect(fail([]).message).toMatch(/No CSV/);
  });
  it("rejects binary content", () => {
    expect(fail([{ name: "x.csv", text: `a,b\n1,${String.fromCharCode(0)}\n` }]).message).toMatch(/binary/);
  });
  it("invalid values never fail the import: the column just becomes text", () => {
    const plan = planCsvImport([{ name: "m.csv", text: "id,score\n1,10\n2,n/a\n3,30\n" }], limits);
    expect(plan.tables[0].columns.find((c) => c.name === "score")?.type).toBe("text");
    expect(plan.tables[0].rows[1][1]).toBe("n/a");
  });
});

describe("CSV upload — limits", () => {
  it("rejects a file above the size limit", () => {
    const big = `id\n${"1\n".repeat(200)}`;
    expect(fail([{ name: "big.csv", text: big }], { ...limits, maxCsvBytes: 100 }).message).toMatch(/too large/);
  });
  it("rejects too many files, rows, columns and tables", () => {
    const one = { name: "a.csv", text: "id\n1\n" };
    expect(fail(Array.from({ length: 3 }, (_, i) => ({ ...one, name: `f${i}.csv` })), { ...limits, maxFiles: 2 }).message).toMatch(/Too many files/);
    expect(fail([{ name: "r.csv", text: `id\n${"1\n".repeat(50)}` }], { ...limits, maxRows: 10 }).message).toMatch(/Too many rows/);
    expect(fail([{ name: "c.csv", text: "a,b,c\n1,2,3\n" }], { ...limits, maxColumnsPerTable: 2 }).message).toMatch(/3 columns/);
    expect(fail([{ name: "a.csv", text: "x\n1\n" }, { name: "b.csv", text: "x\n1\n" }], { ...limits, maxTables: 1 }).message).toMatch(/Too many tables/);
    expect(fail([{ name: "a.csv", text: "x,y\n1,2\n" }, { name: "b.csv", text: "x,y\n1,2\n" }], { ...limits, maxTotalColumns: 3 }).message).toMatch(/Too many columns/);
  });
});

describe("CSV upload — reserved table names", () => {
  it("never creates a table whose name starts with pg_ (system-catalog names): the file name is prefixed", () => {
    const plan = planCsvImport([{ name: "pg_class.csv", text: "id,name\n1,a\n" }, { name: "pg_roles.csv", text: "id\n1\n" }], getUploadLimits({}));
    const names = plan.tables.map((t) => t.name);
    expect(names.every((n) => !n.startsWith("pg_"))).toBe(true);
    expect(names).toEqual(["t_pg_class", "t_pg_roles"]);
  });
});
