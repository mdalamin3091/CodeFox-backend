import { z } from 'zod';

export const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(50, 'Name must be at most 50 characters').optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
