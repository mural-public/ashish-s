import { describe, expect, it } from "vitest";
import { MuralApiError, type MuralClient } from "../src/lib/mural-client";
import { describeMuralError, findBlockingPayoutLegs } from "../src/lib/mural-diagnostics";

const ARCHIVE_PATH = "/api/counterparties/counterparty/cp-1/archive";

describe("describeMuralError", () => {
  it("keeps every field Mural returns in a 412 body", () => {
    const err = new MuralApiError(
      412,
      {
        errorInstanceId: "bd2d24d0-a649-473d-8487-788d34bdd839",
        name: "PreconditionFailedException",
        message: "Bank account cannot be deleted because there are active withdrawal or deposit requests",
        params: {},
      },
      ARCHIVE_PATH,
    );

    const info = describeMuralError("cp-1", err);

    expect(info.status).toBe(412);
    expect(info.trace).toBe("bd2d24d0-a649-473d-8487-788d34bdd839");
    expect(info.reason).toContain("PreconditionFailedException");
    expect(info.reason).toContain("active withdrawal or deposit requests");
  });

  it("surfaces details and params when present", () => {
    const err = new MuralApiError(
      400,
      {
        errorInstanceId: "trace-1",
        name: "BadRequestException",
        message: "A counterparty with this email already exists",
        details: "email must be unique",
        params: { organizationId: "org-9" },
      },
      "/api/counterparties",
    );

    const info = describeMuralError("cp-1", err);

    expect(info.reason).toContain("email must be unique");
    expect(info.reason).toContain('params={"organizationId":"org-9"}');
  });

  it("falls back to the raw body when the response is not JSON", () => {
    const err = new MuralApiError(502, "upstream timeout", ARCHIVE_PATH);

    expect(describeMuralError("cp-1", err).reason).toBe("upstream timeout");
  });

  it("falls back to x-request-id when the body has no errorInstanceId", () => {
    const err = new MuralApiError(500, { message: "boom" }, ARCHIVE_PATH, "req-77");

    expect(describeMuralError("cp-1", err).trace).toBe("req-77");
  });

  it("handles non-Mural errors without inventing a status", () => {
    const info = describeMuralError("cp-1", new TypeError("fetch failed"));

    expect(info.status).toBeUndefined();
    expect(info.reason).toBe("fetch failed");
  });
});

type PayoutPage = Awaited<ReturnType<MuralClient["searchPayoutRequests"]>>;

function clientReturning(pages: PayoutPage[]): MuralClient {
  let call = 0;
  return {
    searchPayoutRequests: async () => pages[call++],
  } as unknown as MuralClient;
}

function fiatLeg(
  id: string,
  counterpartyId: string,
  fiatStatus: string,
  rail = "mxn",
): PayoutPage["results"][number]["payouts"][number] {
  return {
    id,
    createdAt: "2026-08-10T22:00:00.000Z",
    updatedAt: "2026-08-10T22:00:00.000Z",
    amount: { tokenAmount: 10, tokenSymbol: "USDC" },
    details: {
      type: "fiat",
      fiatAndRailCode: rail,
      fiatPayoutStatus: { type: fiatStatus as "pending" },
    },
    recipientInfo: { type: "counterparty", counterpartyId },
  };
}

function payoutRequest(id: string, status: string, payouts: PayoutPage["results"][number]["payouts"]) {
  return {
    id,
    createdAt: "2026-08-10T22:00:00.000Z",
    updatedAt: "2026-08-10T22:00:00.000Z",
    sourceAccountId: "acct-1",
    status: status as "EXECUTED",
    payouts,
  };
}

describe("findBlockingPayoutLegs", () => {
  it("groups non-terminal legs by counterparty and ignores terminal ones", async () => {
    const mural = clientReturning([
      {
        total: 1,
        results: [
          payoutRequest("pr-1", "EXECUTED", [
            fiatLeg("p-1", "cp-a", "pending"),
            fiatLeg("p-2", "cp-b", "completed", "cop"),
            fiatLeg("p-3", "cp-c", "canceled"),
            fiatLeg("p-4", "cp-a", "on-hold"),
          ]),
        ],
      },
    ]);

    const legs = await findBlockingPayoutLegs(mural);

    expect([...legs.keys()]).toEqual(["cp-a"]);
    expect(legs.get("cp-a")!.map((l) => l.payoutId)).toEqual(["p-1", "p-4"]);
  });

  it("treats refundInProgress and created as still blocking", async () => {
    const mural = clientReturning([
      {
        total: 1,
        results: [
          payoutRequest("pr-1", "EXECUTED", [
            fiatLeg("p-1", "cp-a", "refundInProgress"),
            fiatLeg("p-2", "cp-b", "created"),
            fiatLeg("p-3", "cp-c", "refunded"),
          ]),
        ],
      },
    ]);

    const legs = await findBlockingPayoutLegs(mural);

    expect([...legs.keys()].sort()).toEqual(["cp-a", "cp-b"]);
  });

  it("marks EXECUTED legs as not cancelable and AWAITING_EXECUTION legs as cancelable", async () => {
    const mural = clientReturning([
      {
        total: 2,
        results: [
          payoutRequest("pr-executed", "EXECUTED", [fiatLeg("p-1", "cp-a", "pending")]),
          payoutRequest("pr-awaiting", "AWAITING_EXECUTION", [fiatLeg("p-2", "cp-b", "created")]),
        ],
      },
    ]);

    const legs = await findBlockingPayoutLegs(mural);

    expect(legs.get("cp-a")![0].cancelable).toBe(false);
    expect(legs.get("cp-b")![0].cancelable).toBe(true);
  });

  it("follows pagination", async () => {
    const mural = clientReturning([
      {
        total: 2,
        nextId: "page-2",
        results: [payoutRequest("pr-1", "EXECUTED", [fiatLeg("p-1", "cp-a", "pending")])],
      },
      {
        total: 2,
        results: [payoutRequest("pr-2", "EXECUTED", [fiatLeg("p-2", "cp-b", "pending")])],
      },
    ]);

    const legs = await findBlockingPayoutLegs(mural);

    expect([...legs.keys()].sort()).toEqual(["cp-a", "cp-b"]);
  });

  it("skips blockchain payouts and inline recipients, which have no counterparty to archive", async () => {
    const mural = clientReturning([
      {
        total: 1,
        results: [
          payoutRequest("pr-1", "EXECUTED", [
            {
              id: "p-1",
              createdAt: "2026-08-10T22:00:00.000Z",
              updatedAt: "2026-08-10T22:00:00.000Z",
              amount: { tokenAmount: 10, tokenSymbol: "USDC" },
              details: { type: "blockchain" },
              recipientInfo: { type: "inline" },
            },
          ]),
        ],
      },
    ]);

    expect((await findBlockingPayoutLegs(mural)).size).toBe(0);
  });
});
