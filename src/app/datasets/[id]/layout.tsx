import { DatasetWorkspaceHeader } from "@/components/data-dashboard/dataset-workspace-header";

/**
 * Shared chrome for one dataset's workspace (Data / Dashboard / Ask this data — see dataset-workspace-header.tsx).
 * Every page under /datasets/[id]/* is a real route, so browser back/forward, direct URLs and refresh all work
 * without any custom history handling — this layout just keeps the dataset visibly in context across all of them.
 */
export default async function DatasetLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-1 flex-col">
      <DatasetWorkspaceHeader id={id} />
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
