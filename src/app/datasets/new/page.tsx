import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { UploadForm } from "@/components/datasets/upload-form";

export const metadata: Metadata = { title: "Add a dataset — Agentic NL2SQL" };

export default function NewDatasetPage() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 space-y-5 px-4 py-6 sm:px-6 lg:py-10">
      <Link href="/datasets" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All datasets
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Add a Dataset</h1>
      <UploadForm />
    </div>
  );
}
