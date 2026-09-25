import type { Metadata } from "next";
import { AskPageClient } from "@/components/data-dashboard/ask-page-client";

export const metadata: Metadata = { title: "Ask this data — Agentic NL2SQL" };

export default async function AskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AskPageClient id={id} />;
}
