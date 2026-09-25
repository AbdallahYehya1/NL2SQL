"use client";

import { BarChart3, Layers, LayoutGrid, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";

export type DashboardTab = "overview" | "analytics" | "insights" | "quality" | "relationships";

const TABS: { id: DashboardTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "insights", label: "Insights", icon: Sparkles },
  { id: "quality", label: "Data Quality", icon: ShieldCheck },
  { id: "relationships", label: "Relationships", icon: Layers },
];

/**
 * Lightweight in-page section switcher for the dashboard (Overview/Analytics/Insights/Data Quality/Relationships —
 * see master prompt section 21). Deliberately NOT separate routes: all sections share the one already-fetched
 * DashboardData, so switching between them is instant and needs no browser-history semantics, unlike the dataset
 * workspace's Data/Dashboard/Ask tabs one level up (see dataset-workspace-header.tsx), which ARE real routes.
 */
export function useDashboardTabs() {
  return useState<DashboardTab>("overview");
}

export function DashboardTabBar({ active, onChange, badges }: { active: DashboardTab; onChange: (t: DashboardTab) => void; badges?: Partial<Record<DashboardTab, number>> }) {
  return (
    <nav aria-label="Dashboard sections" className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
      {TABS.map((t) => {
        const Icon = t.icon;
        const count = badges?.[t.id];
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => onChange(t.id)}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${active === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden /> {t.label}
            {count !== undefined && count > 0 && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{count}</span>}
          </button>
        );
      })}
    </nav>
  );
}
