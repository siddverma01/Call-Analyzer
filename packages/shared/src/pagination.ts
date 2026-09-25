import { z } from "zod";

/** Pagination contract used by every list endpoint. */

export const paginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export type PaginationParams = z.infer<typeof paginationParamsSchema>;

export const paginatedResponseSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  });

export type PaginatedResponse<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};