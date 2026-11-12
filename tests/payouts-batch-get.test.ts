// Route tests for GET /payouts?contractorId=… (BatchGetPayout).
// These hit the local Postgres (`docker compose up -d postgres`). Each run
// inserts its own contractors and payouts directly via Prisma (no Mural calls)
// and deletes only those rows afterwards.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Contractor } from "@prisma/client";
import { createApp } from "../src/server";
import { prisma } from "../src/lib/db";

const app = createApp();
const runId = randomUUID();
const createdContractorIds: string[] = [];

async function createContractor(label: string): Promise<Contractor> {
  const contractor = await prisma.contractor.create({
    data: {
      firstName: "Test",
      lastName: label,
      email: `batch-get-${label}-${runId}@example.com`,
      physicalAddress: {
        address1: "Av. Reforma 123",
        country: "MX",
        state: "CMX",
        city: "Mexico City",
        zip: "06600",
      },
      bankAccount: {
        type: "mxnDomestic",
        symbol: "MXN",
        bankAccountNumber: "012180001234567899",
        bankId: "bank_mxn_001",
      },
      currency: "MXN",
    },
  });
  createdContractorIds.push(contractor.id);
  return contractor;
}

async function createPayoutRow(contractorId: string, amountUSDC: string, createdAt: Date) {
  return prisma.payout.create({
    data: { contractorId, amountUSDC, status: "COMPLETED", createdAt },
  });
}

let contractor: Contractor;
let otherContractor: Contractor;
let emptyContractor: Contractor;
// Expected order: newest createdAt first, ties broken by id descending.
let expectedIds: string[];
let otherPayoutId: string;

beforeAll(async () => {
  contractor = await createContractor("main");
  otherContractor = await createContractor("other");
  emptyContractor = await createContractor("empty");

  const oldest = await createPayoutRow(contractor.id, "10.000000", new Date("2026-01-01T00:00:00Z"));
  // Two payouts with the same createdAt exercise the id tie-breaker.
  const tieA = await createPayoutRow(contractor.id, "20.500000", new Date("2026-02-01T00:00:00Z"));
  const tieB = await createPayoutRow(contractor.id, "30.250000", new Date("2026-02-01T00:00:00Z"));
  const ties = [tieA.id, tieB.id].sort().reverse();
  expectedIds = [...ties, oldest.id];

  const other = await createPayoutRow(otherContractor.id, "99.000000", new Date("2026-03-01T00:00:00Z"));
  otherPayoutId = other.id;
});

afterAll(async () => {
  await prisma.payout.deleteMany({ where: { contractorId: { in: createdContractorIds } } });
  await prisma.contractor.deleteMany({ where: { id: { in: createdContractorIds } } });
  await prisma.$disconnect();
});

describe("GET /payouts (BatchGetPayout)", () => {
  it("returns the contractor once and only that contractor's payouts, newest first", async () => {
    const res = await request(app).get("/payouts").query({ contractorId: contractor.id });

    expect(res.status).toBe(200);
    expect(res.body.contractor).toMatchObject({ id: contractor.id, email: contractor.email });
    expect(res.body.payouts.map((p: { id: string }) => p.id)).toEqual(expectedIds);
    expect(res.body.payouts.every((p: { contractorId: string }) => p.contractorId === contractor.id)).toBe(true);
    expect(res.body.payouts[0]).not.toHaveProperty("contractor");
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns amountUSDC as a decimal string, not a number", async () => {
    const res = await request(app).get("/payouts").query({ contractorId: contractor.id });

    const oldest = res.body.payouts[res.body.payouts.length - 1];
    expect(typeof oldest.amountUSDC).toBe("string");
    expect(oldest.amountUSDC).toBe("10");
  });

  it("returns an empty page for a contractor with no payouts", async () => {
    const res = await request(app).get("/payouts").query({ contractorId: emptyContractor.id });

    expect(res.status).toBe(200);
    expect(res.body.contractor.id).toBe(emptyContractor.id);
    expect(res.body.payouts).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("paginates with limit and cursor without gaps or overlap", async () => {
    const page1 = await request(app).get("/payouts").query({ contractorId: contractor.id, limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.payouts.map((p: { id: string }) => p.id)).toEqual(expectedIds.slice(0, 2));
    expect(page1.body.nextCursor).toBe(expectedIds[1]);

    const page2 = await request(app)
      .get("/payouts")
      .query({ contractorId: contractor.id, limit: 2, cursor: page1.body.nextCursor });
    expect(page2.status).toBe(200);
    expect(page2.body.payouts.map((p: { id: string }) => p.id)).toEqual(expectedIds.slice(2));
    expect(page2.body.nextCursor).toBeNull();
  });

  it("returns nextCursor null when the page exactly fills the limit", async () => {
    const res = await request(app).get("/payouts").query({ contractorId: contractor.id, limit: 3 });

    expect(res.body.payouts).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull();
  });

  it("404s for an unknown contractor", async () => {
    const res = await request(app).get("/payouts").query({ contractorId: randomUUID() });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("400s when contractorId is missing", async () => {
    const res = await request(app).get("/payouts");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400s when contractorId is not a UUID", async () => {
    const res = await request(app).get("/payouts").query({ contractorId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it.each(["0", "101", "abc", "1.5"])("400s for limit=%s", async (limit) => {
    const res = await request(app).get("/payouts").query({ contractorId: contractor.id, limit });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400s for a cursor that belongs to another contractor", async () => {
    const res = await request(app)
      .get("/payouts")
      .query({ contractorId: contractor.id, cursor: otherPayoutId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400s for a cursor that does not exist", async () => {
    const res = await request(app)
      .get("/payouts")
      .query({ contractorId: contractor.id, cursor: randomUUID() });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
