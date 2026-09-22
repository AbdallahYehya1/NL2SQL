import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getProvider } from "@/lib/ai/provider";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { importDataset, type UploadedFile } from "@/lib/datasets/import-service";
import { getUploadLimits, ImportError } from "@/lib/datasets/limits";
import { getClientHash, getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST multipart/form-data: files (.sql XOR .csv), name?, describe? ("true" → ask the LLM for descriptions; structure only).
 * The response is a stream of newline-delimited JSON events so the UI can show real progress:
 *   {"type":"progress","step":"parse","status":"done","detail":"…"} … {"type":"done","dataset":{…}}  |  {"type":"error","message":"…","details":[…]}
 * The import runs inside the request (no background worker), which is what makes it Vercel-compatible — and why the limits are small.
 */
export async function POST(request: Request) {
  if (!isDatabaseConfigured()) return json({ error: "The database is not configured." }, 503);
  const limits = getUploadLimits();

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limits.maxRequestBytes) return json({ error: `The upload is too large (max ${limits.maxRequestBytes / 1024 / 1024} MB in total).` }, 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Send the files as multipart/form-data." }, 400);
  }

  const files: UploadedFile[] = [];
  // The Content-Length check above can be bypassed by a chunked request: enforce the total again on the parsed files.
  const totalBytes = form.getAll("files").reduce((n, f) => n + (typeof f === "string" ? f.length : f.size), 0);
  if (totalBytes > limits.maxRequestBytes) return json({ error: `The upload is too large (max ${limits.maxRequestBytes / 1024 / 1024} MB in total).` }, 413);
  const entries = form.getAll("files").filter((f): f is File => typeof f !== "string");
  if (entries.length === 0) return json({ error: "Choose at least one .sql or .csv file." }, 400);
  if (entries.length > limits.maxFiles) return json({ error: `Too many files (max ${limits.maxFiles}).` }, 422);
  for (const f of entries) {
    const isSql = f.name.toLowerCase().endsWith(".sql");
    const max = isSql ? limits.maxSqlBytes : limits.maxCsvBytes;
    if (f.size > max) return json({ error: `"${f.name}" is too large (max ${Math.round(max / 1024 / 1024)} MB for ${isSql ? ".sql" : ".csv"} files).` }, 413);
    files.push({ name: f.name.slice(0, 120), text: await f.text() });
  }
  const name = typeof form.get("name") === "string" ? (form.get("name") as string) : "";
  const describe = form.get("describe") === "true";

  const sessionId = (await getSessionId(true))!;
  const clientHash = await getClientHash();
  const cfg = getConfig();
  const provider = getProvider();
  const canDescribe = describe && Boolean(cfg.ai.model);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const dataset = await importDataset(
          { name, files, generateDescriptions: canDescribe },
          { pool: getAdminPool(), sessionId, clientHash, provider, limits, onProgress: (e) => send({ type: "progress", ...e }) },
        );
        send({ type: "done", dataset });
      } catch (err) {
        if (err instanceof ImportError) send({ type: "error", message: err.message, details: err.details, status: err.httpStatus });
        else send({ type: "error", message: "The dataset could not be imported.", details: [], status: 500 });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

const json = (body: unknown, status: number) => NextResponse.json(body, { status });
