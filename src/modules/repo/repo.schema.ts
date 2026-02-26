import { z } from 'zod';

export const listReposQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
  language: z.string().optional(),
  sort: z.enum(['updated', 'stars', 'forks', 'name']).default('updated'),
  order: z.enum(['asc', 'desc']).default('desc'),
  private: z.enum(['true', 'false', 'all']).default('all'),
  fork: z.enum(['true', 'false', 'all']).default('all'),
  search: z.string().optional(),
});

export type ListReposQuery = z.infer<typeof listReposQuerySchema>;
