import type { Metadata } from "next";
import { DatasetDetails } from "@/components/datasets/dataset-details";

export const metadata: Metadata = { title: "Dataset — Agentic NL2SQL" };

export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DatasetDetails id={id} />;
}
