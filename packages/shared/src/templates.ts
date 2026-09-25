import { z } from "zod";
import { TEMPLATE_TYPES } from "./enums.ts";

/** Meeting templates selectable when starting a new meeting. */

/** A single section in a template's meeting agenda. */
export const templateSectionSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  type: z.enum(["list", "text"]),
});

export type TemplateSection = z.infer<typeof templateSectionSchema>;

/** Structured body of a template (the part users can edit). */
export const templateSchemaInput = z.object({
  sections: z.array(templateSectionSchema).max(30),
});

export type TemplateSchemaInput = z.infer<typeof templateSchemaInput>;

export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(TEMPLATE_TYPES),
  description: z.string().nullable(),
  schema: z.unknown(),
  isDefault: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type TemplateDto = z.infer<typeof templateSchema>;

export const createTemplateRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  schema: templateSchemaInput,
}).strict();

export type CreateTemplateRequest = z.infer<typeof createTemplateRequestSchema>;

export const updateTemplateRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  schema: templateSchemaInput.optional(),
}).strict();

export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>;

/** List response: visible templates plus the user's active default (if any). */
export const templateListResponseSchema = z.object({
  items: z.array(templateSchema),
  defaultId: z.string().nullable(),
});

export type TemplateListResponse = z.infer<typeof templateListResponseSchema>;

/** `templateId: null` clears the user's default template. */
export const setDefaultTemplateRequestSchema = z.object({
  templateId: z.string().nullable(),
});

export type SetDefaultTemplateRequest = z.infer<typeof setDefaultTemplateRequestSchema>;