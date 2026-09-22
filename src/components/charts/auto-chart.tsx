"use client";

import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { humanizeColumn } from "@/lib/utils";

export type ChartSpec = { kind: "line" | "bar"; labelKey: string; valueKeys: string[] };

const isDateLike = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(v);

/**
 * Decide whether a result is clearly chartable: a label/date column plus one or two numeric columns and a
 * moderate number of rows. Returns undefined otherwise (the table always remains available).
 */
export function detectChart(columns: string[], rows: Record<string, unknown>[]): ChartSpec | undefined {
  if (rows.length < 3 || rows.length > 60 || columns.length < 2 || columns.length > 4) return undefined;
  const first = rows[0];
  const numeric = columns.filter((c) => typeof first[c] === "number" && !/(^|_)(id|year|month)$/.test(c));
  const labelKey = columns.find((c) => typeof first[c] === "string");
  if (!labelKey || numeric.length === 0 || numeric.length > 2) return undefined;
  const dateLike = rows.every((r) => isDateLike(r[labelKey]));
  return { kind: dateLike ? "line" : "bar", labelKey, valueKeys: numeric };
}

const COLORS = ["#6366f1", "#14b8a6"];

function shortLabel(v: unknown): string {
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2})-\d{2}/);
  if (m) return m[1];
  return s.length > 14 ? `${s.slice(0, 13)}…` : s;
}

export function AutoChart({ spec, rows }: { spec: ChartSpec; rows: Record<string, unknown>[] }) {
  const data = rows.map((r) => ({ ...r, [spec.labelKey]: shortLabel(r[spec.labelKey]) }));
  return (
    <div className="h-72 w-full" role="img" aria-label={`${spec.kind} chart of ${spec.valueKeys.map(humanizeColumn).join(", ")} by ${humanizeColumn(spec.labelKey)}`}>
      <ResponsiveContainer width="100%" height="100%">
        {spec.kind === "line" ? (
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey={spec.labelKey} tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} />
            <YAxis tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} width={64} tickFormatter={(v) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(v as number)} />
            <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
            {spec.valueKeys.map((k, i) => (
              <Line key={k} type="monotone" dataKey={k} stroke={COLORS[i]} strokeWidth={2} dot={{ r: 3 }} name={humanizeColumn(k)} />
            ))}
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey={spec.labelKey} tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} interval={0} angle={rows.length > 6 ? -25 : 0} textAnchor={rows.length > 6 ? "end" : "middle"} height={rows.length > 6 ? 60 : 30} />
            <YAxis tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} width={64} tickFormatter={(v) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(v as number)} />
            <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "var(--muted)" }} />
            {spec.valueKeys.map((k, i) => (
              <Bar key={k} dataKey={k} fill={COLORS[i]} radius={[4, 4, 0, 0]} name={humanizeColumn(k)} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
