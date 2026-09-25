import { z } from "zod";

/**
 * Meeting export contract. Only text representations leave the server - raw
 * audio never exists on the backend, so there is nothing to export beyond the
 * meeting's own transcript and notes.
 */
export const EXPORT_FORMATS = ["markdown", "txt", "json", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const exportRequestSchema = z.object({
  format: z.enum(EXPORT_FORMATS).default("markdown"),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

/**
 * Export payload returned by the server:
 * - `markdown`, `txt`, `json` -> `content` is the raw UTF-8 text.
 * - `pdf` -> `content` is a base64-encoded PDF byte stream.
 */
export interface ExportPayload {
  format: ExportFormat;
  filename: string;
  contentType: string;
  content: string;
}