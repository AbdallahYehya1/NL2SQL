import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getProvider } from "@/lib/ai/provider";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { deleteChunks, purgeStaleChunks, reassembleFiles } from "@/lib/datasets/chunked-upload";
import { importDataset } from "@/lib/datasets/import-service";
import { getUploadLimits, ImportError } from "@/lib/datasets/limits";
import { getClientHash, getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Completes a chunked upload: reassembles every file from nl2sql.upload_chunks (see chunked-upload.ts), then runs
 * the EXACT same importDataset() pipeline the single-shot /api/datasets/upload route uses, with the same streaming
 * NDJSON progress protocol. The chunk rows are deleted afterwards either way — nothing about a completed or failed
 * upload is left sitting in the staging table.
 */
export async function POST(request: Request) {
  if (!isDatabaseConfigured()) return json({ error: "The database is not configured." }, 503);

  let body: { uploadId?: unknown; name?: unknown; describe?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send a JSON body with uploadId." }, 400);
  }
  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  if (!UUID_RE.test(uploadId)) return json({ error: "Missing or invalid uploadId." }, 400);
  const name = typeof body.name === "string" ? body.name : "";
  const describe = body.describe === true;

  const sessionId = (await getSessionId(true))!;
  const clientHash = await getClientHash();
  const cfg = getConfig();
  const provider = getProvider();
  const canDescribe = describe && Boolean(cfg.ai.model);
  const pool = getAdminPool();
  const limits = getUploadLimits();

  void purgeStaleChunks(pool).catch(() => undefined);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const files = await reassembleFiles(pool, uploadId, sessionId, limits);
        const dataset = await importDataset({ name, files, generateDescriptions: canDescribe }, { pool, sessionId, clientHash, provider, limits, onProgress: (e) => send({ type: "progress", ...e }) });
        send({ type: "done", dataset });
      } catch (err) {
        if (err instanceof ImportError) send({ type: "error", message: err.message, details: err.details, status: err.httpStatus });
        else send({ type: "error", message: "The dataset could not be imported.", details: [], status: 500 });
      } finally {
        await deleteChunks(pool, uploadId).catch(() => undefined);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

const json = (body: unknown, status: number) => NextResponse.json(body, { status });
