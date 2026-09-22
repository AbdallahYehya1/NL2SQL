import type { Metadata } from "next";
import { DatasetList } from "@/components/datasets/dataset-list";

export const metadata: Metadata = { title: "Datasets — Agentic NL2SQL" };

export default function DatasetsPage() {
  return <DatasetList />;
}
