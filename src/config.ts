import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MURAL_API_BASE_URL: z.string().url().default("https://api-staging.muralpay.com"),
  MURAL_API_KEY: z.string().min(1, "MURAL_API_KEY is required"),
  MURAL_TRANSFER_API_KEY: z.string().min(1, "MURAL_TRANSFER_API_KEY is required"),
  MURAL_ORG_ID: z.string().optional(),
  MURAL_ON_BEHALF_OF_ORG_ID: z.string().optional(),
  MURAL_SOURCE_ACCOUNT_ID: z.string().min(1, "MURAL_SOURCE_ACCOUNT_ID is required"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
