import { titleCase } from "@/lib/format";
import type { DashboardRelationships } from "@/lib/dashboard/types";

/** Layers tables by FK distance from the tables that are only ever referenced (never reference anything themselves). */
function computeLevels(rel: DashboardRelationships): { levels: string[][]; isolated: string[] } {
  const referencesOf = new Map<string, string[]>();
  for (const t of rel.tables) referencesOf.set(t, []);
  for (const e of rel.edges) {
    if (!referencesOf.has(e.fromTable)) referencesOf.set(e.fromTable, []);
    referencesOf.get(e.fromTable)!.push(e.toTable);
  }

  const levelCache = new Map<string, number>();
  const computing = new Set<string>();
  function level(t: string): number {
    if (levelCache.has(t)) return levelCache.get(t)!;
    if (computing.has(t)) return 0; // a reference cycle — treat as a root rather than recursing forever
    computing.add(t);
    const refs = referencesOf.get(t) ?? [];
    const l = refs.length === 0 ? 0 : 1 + Math.max(...refs.map(level));
    computing.delete(t);
    levelCache.set(t, l);
    return l;
  }

  const connected = new Set<string>();
  for (const e of rel.edges) {
    connected.add(e.fromTable);
    connected.add(e.toTable);
  }
  const isolated = rel.tables.filter((t) => !connected.has(t));

  const byLevel = new Map<number, string[]>();
  for (const t of rel.tables.filter((t) => connected.has(t))) {
    const l = level(t);
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(t);
  }
  const levels = [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([, ts]) => ts.sort());
  return { levels, isolated };
}

export function RelationshipGraph({ relationships }: { relationships: DashboardRelationships }) {
  if (relationships.edges.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-6 text-center">
        <h2 className="text-sm font-semibold text-foreground">Data Relationships</h2>
        <p className="mt-2 text-sm font-medium text-foreground">No relationships detected</p>
        <p className="mt-1 text-sm text-muted-foreground">These tables currently appear independent.</p>
      </div>
    );
  }

  const { levels, isolated } = computeLevels(relationships);
  const edgesFrom = (t: string) => relationships.edges.filter((e) => e.fromTable === t);

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-foreground">Data Relationships</h2>
      <div className="space-y-5">
        {levels.map((tables, i) => (
          <div key={i} className="space-y-2">
            {i > 0 && <div className="mx-auto h-4 w-px bg-border" aria-hidden />}
            <div className="flex flex-wrap justify-center gap-3">
              {tables.map((t) => (
                <div key={t} className="min-w-[9rem] rounded-xl border border-border bg-muted/40 px-3 py-2 text-center">
                  <p className="text-sm font-medium text-foreground">{titleCase(t)}</p>
                  {edgesFrom(t).map((e) => (
                    <p key={`${e.fromColumn}-${e.toTable}-${e.toColumn}`} className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {e.fromColumn} → {e.toTable}.{e.toColumn}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {isolated.length > 0 && <p className="border-t border-border pt-3 text-xs text-muted-foreground">Not connected to the tables above: {isolated.map((t) => titleCase(t)).join(", ")}.</p>}
    </div>
  );
}
