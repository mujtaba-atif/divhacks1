import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { EvidenceRecord } from "@/lib/types";
import { ApiError } from "./errors";
import { readLimitedBody } from "./http";
import { evidenceFieldsSchema } from "./validation";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function detectedMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

export async function parseEvidenceUpload(request: NextRequest): Promise<EvidenceRecord> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ApiError(415, "Upload evidence using multipart/form-data.");
  }
  const bytes = await readLimitedBody(request, MAX_FILE_BYTES + 64 * 1024);
  let form: FormData;
  try {
    form = await new Response(Buffer.from(bytes), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ApiError(400, "The evidence upload could not be read. Select the file again.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "Choose an evidence file to upload.");
  if (form.getAll("file").length !== 1) throw new ApiError(400, "Upload one evidence file at a time.");
  if (file.size === 0) throw new ApiError(400, "The evidence file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new ApiError(413, "Evidence files must be 5 MiB or smaller.");
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new ApiError(415, "Supported evidence formats are PNG, JPEG, WebP, and PDF. SVG and GIF files are not accepted.");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (detectedMime(buffer) !== file.type) throw new ApiError(415, "The file content does not match its declared format.");
  const temperature = form.get("temperatureF");
  const fields = evidenceFieldsSchema.parse({
    stage: form.get("stage"), note: form.get("note") ?? "",
    temperatureF: temperature === null || temperature === "" ? undefined : Number(temperature),
  });
  const name = file.name.replace(/[\x00-\x1f\x7f\\/]/g, "_").slice(0, 200) || "evidence";
  return {
    id: randomUUID(), name, mimeType: file.type, ...fields,
    createdAt: new Date().toISOString(), isDemo: false,
    dataUrl: `data:${file.type};base64,${buffer.toString("base64")}`,
  };
}
