// Route tests for POST /payouts when Mural fails. The Mural client is mocked,
// so no sandbox money moves; payout rows are written to the local Postgres
// (`docker compose up -d postgres`) and deleted afterwards.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Contractor } from "@prisma/client";

const mural = vi.hoisted(() => ({
  createPayoutRequest: vi.fn(),
  executePayoutRequest: vi.fn(),
}));

vi.mock("../src/lib/mural-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/mural-client")>();
  return { ...actual, getMuralClient: () => mural };
});

import { MuralApiError } from "../src/lib/mural-client";
import { createApp } from "../src/server";
import { prisma } from "../src/lib/db";

const app = createApp();
const runId = randomUUID();
let contractor: Contractor;

const MIN_NOT_MET = new MuralApiError(
  400,
  {
    errorInstanceId: "trace-min-1",
    name: "PayoutMinimumNotMetError",
    message: "Payout amount less fees must be greater than 1.5 USD. Net payout amount provided was 0.49 USD",
    params: {},
  },
  "/api/payouts/payout",
);

function payoutRequest(id: string, status: string) {
  return {
    id,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    sourceAccountId: "acct-1",
    status,
    payouts: [],
  };
}

function postPayout(amountUSDC = "5.00") {
  return request(app)
    .post("/payouts")
    .send({ contractorId: contractor.id, amountUSDC, memo: `create-failure test ${runId}` });
}

async function dbPayout(id: string) {
  return prisma.payout.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  // Pre-provisioned Mural IDs, so createPayout skips counterparty provisioning.
  contractor = await prisma.contractor.create({
    data: {
      firstName: "Test",
      lastName: "CreateFailure",
      email: `create-failure-${runId}@example.com`,
      physicalAddress: { address1: "Av. Reforma 123", country: "MX", state: "CMX", city: "Mexico City", zip: "06600" },
      bankAccount: { type: "mxnDomestic", symbol: "MXN", bankAccountNumber: "012180001234567899", bankId: "bank_mxn_001" },
      currency: "MXN",
      muralCounterpartyId: `cp-${runId}`,
      muralPayoutMethodId: `pm-${runId}`,
    },
  });
});

beforeEach(() => {
  mural.createPayoutRequest.mockReset();
  mural.executePayoutRequest.mockReset();
});

afterAll(async () => {
  await prisma.payout.deleteMany({ where: { contractorId: contractor.id } });
  await prisma.contractor.delete({ where: { id: contractor.id } });
  await prisma.$disconnect();
});

describe("POST /payouts when Mural fails", () => {
  it("marks the payout FAILED and returns 422 when Mural rejects the create", async () => {
    mural.createPayoutRequest.mockRejectedValue(MIN_NOT_MET);

    const res = await postPayout("1.00");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PAYOUT_FAILED");
    expect(res.body.error.message).toContain("PayoutMinimumNotMetError");
    expect(res.body.error.message).toContain("greater than 1.5 USD");
    expect(res.body.error.message).toContain("trace-min-1");
    expect(res.body.error.details.muralStatus).toBe(400);
    expect(res.body.error.details.payout).toMatchObject({ status: "FAILED", muralPayoutId: null });
    expect(mural.executePayoutRequest).not.toHaveBeenCalled();

    const row = await dbPayout(res.body.error.details.payout.id);
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBe(res.body.error.message);
  });

  it("keeps the Mural request id when the execute is rejected", async () => {
    mural.createPayoutRequest.mockResolvedValue(payoutRequest("pr-412", "AWAITING_EXECUTION"));
    mural.executePayoutRequest.mockRejectedValue(
      new MuralApiError(412, { name: "PreconditionFailedException", message: "Insufficient balance" }, "/api/payouts/payout/pr-412/execute"),
    );

    const res = await postPayout("10000.00");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PAYOUT_FAILED");
    expect(res.body.error.message).toContain("Insufficient balance");
    expect(mural.executePayoutRequest).toHaveBeenCalledWith("pr-412");

    const row = await dbPayout(res.body.error.details.payout.id);
    expect(row).toMatchObject({ status: "FAILED", muralPayoutId: "pr-412" });
    expect(row.errorMessage).toContain("PreconditionFailedException");
  });

  it("marks the payout FAILED and returns 502 when Mural errors with a 5xx", async () => {
    mural.createPayoutRequest.mockResolvedValue(payoutRequest("pr-500", "AWAITING_EXECUTION"));
    mural.executePayoutRequest.mockRejectedValue(
      new MuralApiError(500, { message: "Internal server error" }, "/api/payouts/payout/pr-500/execute"),
    );

    const res = await postPayout();

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("PAYOUT_FAILED");
    const row = await dbPayout(res.body.error.details.payout.id);
    expect(row).toMatchObject({ status: "FAILED", muralPayoutId: "pr-500" });
  });

  it("marks the payout FAILED and returns 502 on a network error", async () => {
    mural.createPayoutRequest.mockRejectedValue(new TypeError("fetch failed"));

    const res = await postPayout();

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("PAYOUT_FAILED");
    expect(res.body.error.message).toBe("fetch failed");
    expect(res.body.error.details.muralStatus).toBeUndefined();
    const row = await dbPayout(res.body.error.details.payout.id);
    expect(row).toMatchObject({ status: "FAILED", errorMessage: "fetch failed", muralPayoutId: null });
  });

  it("still marks a successful payout COMPLETED with the Mural request id", async () => {
    mural.createPayoutRequest.mockResolvedValue(payoutRequest("pr-ok", "AWAITING_EXECUTION"));
    mural.executePayoutRequest.mockResolvedValue(payoutRequest("pr-ok", "EXECUTED"));

    const res = await postPayout();

    expect(res.status).toBe(201);
    expect(res.body.payout).toMatchObject({ status: "COMPLETED", muralPayoutId: "pr-ok", errorMessage: null });
  });
});
