import { NextResponse } from "next/server";
import { getAdminPool, isDatabaseConfigured } from "@/lib/database/client";
import { storeChunk } from "@/lib/datasets/chunked-upload";
import { getUploadLimits, ImportError } from "@/lib/datasets/limits";
import { getSessionId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * One chunk of a large file, for a file above limits.maxRequestBytes (see chunked-upload.ts for why). Each request
 * is small (limits.maxChunkBytes, well under Vercel's 4.5 MB body limit); the file is reassembled and imported only
 * once every chunk has arrived — see /api/datasets/upload/finalize.
 */
export async function POST(request: Request) {
  if (!isDatabaseConfigured()) return json({ error: "The database is not configured." }, 503);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Send the chunk as multipart/form-data." }, 400);
  }

  const uploadId = String(form.get("uploadId") ?? "");
  const fileName = String(form.get("fileName") ?? "");
  const fileIndex = Number(form.get("fileIndex"));
  const chunkIndex = Number(form.get("chunkIndex"));
  const totalChunks = Number(form.get("totalChunks"));
  const chunk = form.get("chunk");

  if (!UUID_RE.test(uploadId)) return json({ error: "Missing or invalid uploadId." }, 400);
  if (!fileName || !Number.isInteger(fileIndex) || fileIndex < 0) return json({ error: "Missing or invalid file metadata." }, 400);
  if (!(chunk instanceof File)) return json({ error: "Missing chunk data." }, 400);

  const sessionId = (await getSessionId(true))!;
  const limits = getUploadLimits();
  try {
    const bytes = Buffer.from(await chunk.arrayBuffer());
    await storeChunk(getAdminPool(), { uploadId, sessionId, fileIndex, fileName: fileName.slice(0, 120), chunkIndex, totalChunks, bytes }, limits);
    return json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof ImportError) return json({ error: err.message }, err.httpStatus);
    return json({ error: "The chunk could not be stored." }, 500);
  }
}

const json = (body: unknown, status: number) => NextResponse.json(body, { status });
