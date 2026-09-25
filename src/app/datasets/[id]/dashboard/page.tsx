import type { Metadata } from "next";
import { DataDashboard } from "@/components/data-dashboard/data-dashboard";

export const metadata: Metadata = { title: "Data Dashboard — Agentic NL2SQL" };

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DataDashboard id={id} />;
}
