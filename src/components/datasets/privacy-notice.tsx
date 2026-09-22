import { ShieldAlert } from "lucide-react";
import type { UploadLimitsDto } from "./types";

/** Shown wherever a user can add data. This is a demo platform — not a place for sensitive data. Keep in sync with docs/DATASET_UPLOAD.md → Privacy. */
export function PrivacyNotice({ limits }: { limits?: UploadLimitsDto }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-bg p-3 text-sm text-warning">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">Upload synthetic, mock or non-sensitive data only.</p>
        <p className="text-xs">
          This is a learning/portfolio project, not a platform for sensitive or production data. Your files are imported into an isolated schema that is visible only to this
          anonymous browser session{limits ? ` and deleted automatically after ${limits.ttlHours} hours` : " and deleted automatically after a few days"}; you can delete a dataset at any time. Uploaded content is not logged
          and result rows are not saved in the query history.
        </p>
        <p className="text-xs">
          When you ask a question, the question, the names of the relevant tables and columns and a few example values (never whole tables or result rows) are sent to the configured AI
          model. The optional AI-written descriptions use table and column structure only.
        </p>
      </div>
    </div>
  );
}
