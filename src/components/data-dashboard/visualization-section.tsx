import { DashboardChart } from "./dashboard-chart";
import type { DashboardVisualizationData } from "@/lib/dashboard/types";

/** One primary visualization (large) plus up to a few supporting ones (smaller, side by side) — never a wall of charts. */
export function VisualizationSection({ visualizations }: { visualizations: DashboardVisualizationData[] }) {
  if (visualizations.length === 0) return null;
  const [primary, ...supporting] = visualizations;
  return (
    <div className="space-y-3">
      <DashboardChart viz={primary} large />
      {supporting.length > 0 && (
        <div className={`grid gap-3 ${supporting.length > 1 ? "sm:grid-cols-2" : ""}`}>
          {supporting.map((v) => (
            <DashboardChart key={v.id} viz={v} />
          ))}
        </div>
      )}
    </div>
  );
}
