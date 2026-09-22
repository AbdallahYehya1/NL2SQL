import { describe, expect, it } from "vitest";
import { deterministicSummary, formatResult, isGrounded, NO_RESULTS_MESSAGE } from "@/lib/ai/result-formatter";
import { ScriptedProvider } from "../helpers/scripted-provider";

const rows = [
  { category: "Computers", revenue: 2017087.34 },
  { category: "Smartphones", revenue: 1792368.1 },
  { category: "Audio", revenue: 484905 },
];

describe("deterministic summary", () => {
  it("says exactly 'No matching records were found.' for empty results", () => {
    expect(deterministicSummary(["a"], [], false).summary).toBe(NO_RESULTS_MESSAGE);
    expect(NO_RESULTS_MESSAGE).toBe("No matching records were found.");
  });
  it("describes a single value", () => {
    expect(deterministicSummary(["average_order_value"], [{ average_order_value: 123.456 }], false).summary).toContain("123.46");
  });
  it("describes a ranking using only returned values", () => {
    const s = deterministicSummary(["category", "revenue"], rows, false);
    expect(s.summary).toContain("Computers");
    expect(s.summary).toContain("2,017,087.34");
    expect(s.summary).toContain("3 rows");
  });
  it("describes a time series with first, last, highest and lowest values (all present in the data)", () => {
    const series = [
      { month: "2026-03-01", revenue: 250150.17 },
      { month: "2026-04-01T00:00:00.000Z", revenue: 312390.86 },
      { month: "2026-05-01", revenue: 288168.18 },
    ];
    const s = deterministicSummary(["month", "revenue"], series, false);
    expect(s.summary).toContain("3 periods");
    expect(s.summary).toContain("250,150.17 (2026-03-01)");
    expect(s.summary).toContain("Highest: 312,390.86 (2026-04-01)");
    expect(s.summary).toContain("lowest: 250,150.17");
    expect(isGrounded(s.summary, series, 3)).toBe(true);
  });
  it("mentions truncation", () => {
    expect(deterministicSummary(["category", "revenue"], rows, true).summary).toContain("row limit");
  });
});

describe("grounding check", () => {
  it("accepts numbers that appear in the data (with formatting/rounding)", () => {
    expect(isGrounded("Computers led with $2,017,087.34 in revenue.", rows, 3)).toBe(true);
    expect(isGrounded("Revenue was about 2,017,087 for Computers", rows, 3)).toBe(true);
    expect(isGrounded("The top 3 categories are shown.", rows, 3)).toBe(true);
  });
  it("rejects invented numbers", () => {
    expect(isGrounded("Computers grew 34% year over year.", rows, 3)).toBe(false);
    expect(isGrounded("Total revenue was 9,999,999.", rows, 3)).toBe(false);
  });
  it("accepts numbers inside date strings", () => {
    expect(isGrounded("Peak month was 2026-08 ", [{ month: "2026-08-01", revenue: 1 }], 1)).toBe(true);
  });
});

describe("formatResult", () => {
  const base = { question: "q", explanation: "e", columns: ["category", "revenue"], rows, truncated: false };

  it("never calls the model for empty results", async () => {
    const provider = new ScriptedProvider({});
    const { formatted } = await formatResult({ ...base, rows: [], provider, mode: "llm" });
    expect(formatted.summary).toBe(NO_RESULTS_MESSAGE);
    expect(provider.calls).toHaveLength(0);
  });

  it("uses the model summary when it is grounded", async () => {
    const provider = new ScriptedProvider({ "result summary": [{ summary: "Computers generated the highest revenue at 2017087.34.", key_points: ["Smartphones followed with 1792368.1"] }] });
    const { formatted } = await formatResult({ ...base, provider, mode: "llm" });
    expect(formatted.summarySource).toBe("llm");
    expect(formatted.summary).toContain("Computers");
  });

  it("falls back to the deterministic summary when the model invents numbers", async () => {
    const provider = new ScriptedProvider({ "result summary": [{ summary: "Computers revenue rose 47% versus last year.", key_points: [] }] });
    const { formatted, llmCall } = await formatResult({ ...base, provider, mode: "llm" });
    expect(formatted.summarySource).toBe("deterministic");
    expect(formatted.summary).not.toContain("47%");
    expect(llmCall?.ok).toBe(false);
  });

  it("falls back (without failing) when the model errors", async () => {
    const provider = new ScriptedProvider({ "result summary": [new Error("boom")] });
    const { formatted } = await formatResult({ ...base, provider, mode: "llm" });
    expect(formatted.summarySource).toBe("deterministic");
    expect(formatted.rows).toEqual(rows);
  });

  it("returns the rows and columns unchanged", async () => {
    const { formatted } = await formatResult({ ...base, mode: "deterministic" });
    expect(formatted.rows).toBe(rows);
    expect(formatted.columns).toEqual(["category", "revenue"]);
  });
});
