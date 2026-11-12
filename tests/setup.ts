// Stable dummy values so config.ts validation passes during tests.
// Override per-test by reassigning process.env before importing the module
// under test, or by using vi.mock for the modules that read these.

process.env.NODE_ENV = "test";
process.env.MURAL_API_KEY = process.env.MURAL_API_KEY ?? "test-api-key";
process.env.MURAL_TRANSFER_API_KEY = process.env.MURAL_TRANSFER_API_KEY ?? "test-transfer-key";
process.env.MURAL_ORG_ID = process.env.MURAL_ORG_ID ?? "test-org-id";
process.env.MURAL_SOURCE_ACCOUNT_ID =
  process.env.MURAL_SOURCE_ACCOUNT_ID ?? "test-source-account-id";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/contractor_pay?schema=public";
process.env.MURAL_API_BASE_URL = process.env.MURAL_API_BASE_URL ?? "https://api-staging.muralpay.com";
