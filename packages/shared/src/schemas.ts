import { z } from "zod";

export const aiThresholdSchema = z.object({
  criticalThreshold: z.number().int().min(0).max(100),
  importantThreshold: z.number().int().min(0).max(100),
  normalThreshold: z.number().int().min(0).max(100),
  useEnsemble: z.boolean()
});
