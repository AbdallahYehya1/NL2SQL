import { describe, expect, it } from "vitest";
import {
  chartTitleFromColumns,
  chartTitleFromQuestion,
  formatDateLabel,
  formatNumberCompact,
  formatNumberFull,
  humanizeKeyPoint,
  isDateLike,
  looksLikeCurrency,
  titleCase,
  truncateLabel,
} from "@/lib/format";

describe("looksLikeCurrency — snake_case-safe word-boundary matching", () => {
  it("matches a currency word glued to other words by underscores (the regression case)", () => {
    // \b treats "_" as a word character, so a naive /\bvalue\b/ never matches inside "average_order_value" — this
    // is exactly the bug found live: the average-order-value KPI rendered "628.84" instead of "$628.84".
    expect(looksLikeCurrency("average_order_value")).toBe(true);
    expect(looksLikeCurrency("avg_order_value")).toBe(true);
    expect(looksLikeCurrency("total_revenue")).toBe(true);
    expect(looksLikeCurrency("customer_lifetime_value")).toBe(true);
  });

  it("still matches a plain (non-underscored) currency name", () => {
    expect(looksLikeCurrency("revenue")).toBe(true);
    expect(looksLikeCurrency("price")).toBe(true);
  });

  it("does not match non-currency numeric names, even ones containing a currency-ish substring", () => {
    expect(looksLikeCurrency("total_customers")).toBe(false); // "total" alone is currency-ish, but "customers" isn't a unit of money
    expect(looksLikeCurrency("order_count")).toBe(false);
    expect(looksLikeCurrency("unit_count")).toBe(false);
  });

  it("a count/rate/percent name is never treated as currency even if it also contains a currency word", () => {
    expect(looksLikeCurrency("revenue_growth_rate")).toBe(false);
    expect(looksLikeCurrency("refund_percentage")).toBe(false);
  });
});

describe("formatNumberFull / formatNumberCompact", () => {
  it("full precision keeps thousands separators, never compacts", () => {
    expect(formatNumberFull(1234567)).toBe("1,234,567");
    expect(formatNumberFull(1234.5)).toBe("1,234.5");
    expect(formatNumberFull(NaN)).toBe("—");
    expect(formatNumberFull(Infinity)).toBe("—");
  });

  it("compact form is used only above 1000, small numbers stay exact", () => {
    expect(formatNumberCompact(1234567)).toBe("1.23M");
    expect(formatNumberCompact(999)).toBe("999");
    expect(formatNumberCompact(NaN)).toBe("—");
  });
});

describe("date helpers", () => {
  it("isDateLike matches YYYY-MM-DD / YYYY-MM / ISO timestamps only", () => {
    expect(isDateLike("2025-03-14")).toBe(true);
    expect(isDateLike("2025-03")).toBe(true);
    expect(isDateLike("2025-03-14T00:00:00Z")).toBe(true);
    expect(isDateLike("hello")).toBe(false);
    expect(isDateLike(42)).toBe(false);
    expect(isDateLike(null)).toBe(false);
  });

  it("formatDateLabel produces short, readable axis labels", () => {
    expect(formatDateLabel("2025-03-01")).toBe("Mar 1");
    expect(formatDateLabel("2025-03")).toBe("Mar 2025");
    expect(formatDateLabel("2025-03-14")).toBe("Mar 14");
    expect(formatDateLabel("not-a-date")).toBe("not-a-date");
  });
});

describe("titleCase / truncateLabel", () => {
  it("humanizes snake_case", () => {
    expect(titleCase("total_customers")).toBe("Total Customers");
    expect(titleCase("revenue")).toBe("Revenue");
  });

  it("truncates long labels with an ellipsis, keeps short ones intact", () => {
    expect(truncateLabel("Berlin", 16)).toBe("Berlin");
    expect(truncateLabel("A Very Long Country Name Indeed", 16)).toBe("A Very Long Cou…");
    expect(truncateLabel(null)).toBe("");
  });
});

describe("chartTitleFromColumns — always safe, schema-derived", () => {
  it("never exposes a raw snake_case identifier", () => {
    const title = chartTitleFromColumns("month_start", ["total_revenue"]);
    expect(title).toBe("Total Revenue by Month Start");
    expect(title).not.toMatch(/_/);
  });

  it("joins multiple series with &", () => {
    expect(chartTitleFromColumns("category", ["revenue", "units_sold"])).toBe("Revenue & Units Sold by Category");
  });
});

describe("chartTitleFromQuestion — matches the spec's own examples, falls back safely otherwise", () => {
  it("What were our monthly sales? -> Monthly Sales-style short phrase", () => {
    expect(chartTitleFromQuestion("Monthly revenue for the last 6 months", "Revenue by Month")).toBe("Monthly Revenue");
  });

  it("Which products generated the most revenue? -> Revenue by Product (via the schema fallback, not a garbled phrase)", () => {
    expect(chartTitleFromQuestion("Which products generated the most revenue?", "Revenue by Product")).toBe("Revenue by Product");
  });

  it("How many customers joined each month? -> a clean fallback, not a leftover stopword phrase", () => {
    const title = chartTitleFromQuestion("How many customers joined each month?", "Customers by Month");
    expect(title).not.toMatch(/\beach\b/i);
  });

  it("never leaves a mid-phrase stopword like a stray 'The'", () => {
    const title = chartTitleFromQuestion("Which products generated the most revenue?", "Revenue by Product");
    expect(title.split(" ")).not.toContain("The");
  });

  it("a long or unparseable question falls back to the schema-derived title, never emits raw identifiers", () => {
    const title = chartTitleFromQuestion("Can you show me, in as much detail as reasonably possible, the breakdown", "revenue_total by category_name".length ? "Revenue Total by Category Name" : "");
    expect(title).not.toMatch(/_/);
  });

  it("an empty question falls back cleanly", () => {
    expect(chartTitleFromQuestion("", "Revenue by Month")).toBe("Revenue by Month");
  });
});

describe("humanizeKeyPoint — only touches a raw 'identifier: value' line, never rewrites prose", () => {
  it("humanizes a raw column:value echo", () => {
    expect(humanizeKeyPoint("total_customers: 1800")).toBe("Total Customers: 1800");
  });

  it("leaves ordinary prose completely untouched", () => {
    const prose = "March 2026 revenue was $250,150.17 (lowest)";
    expect(humanizeKeyPoint(prose)).toBe(prose);
  });

  it("leaves a sentence containing a colon but not matching the raw-identifier shape untouched", () => {
    const text = "Note: revenue grew steadily";
    expect(humanizeKeyPoint(text)).toBe(text);
  });
});
