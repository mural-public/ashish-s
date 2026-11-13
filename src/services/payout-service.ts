import { Decimal } from "decimal.js";
import { prisma } from "../lib/db";
import { config } from "../config";
import {
  getMuralClient,
  type MuralCreatePayoutRequestInput,
  type MuralPayoutRequest,
} from "../lib/mural-client";
import { provisionMuralCounterparty } from "./counterparty-service";
import { HttpError, NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { describeMuralError } from "../lib/mural-diagnostics";

export type CreatePayoutInput = {
  contractorId: string;
  amountUSDC: string;
  memo?: string;
};

export async function createPayout(input: CreatePayoutInput) {
  const contractor = await prisma.contractor.findUnique({
    where: { id: input.contractorId },
  });
  if (!contractor) throw new NotFoundError("Contractor", input.contractorId);
  if (!contractor.isActive) {
    throw new ValidationError(`Contractor ${contractor.id} is not active`);
  }

  let muralCounterpartyId = contractor.muralCounterpartyId;
  let muralPayoutMethodId = contractor.muralPayoutMethodId;

  if (!muralCounterpartyId || !muralPayoutMethodId) {
    const provisioned = await provisionMuralCounterparty(contractor);
    muralCounterpartyId = provisioned.muralCounterpartyId;
    muralPayoutMethodId = provisioned.muralPayoutMethodId;
    await prisma.contractor.update({
      where: { id: contractor.id },
      data: { muralCounterpartyId, muralPayoutMethodId },
    });
  }

  const payout = await prisma.payout.create({
    data: {
      contractorId: contractor.id,
      amountUSDC: new Decimal(input.amountUSDC),
      memo: input.memo,
      status: "PENDING",
    },
  });

  const mural = getMuralClient();
  const request: MuralCreatePayoutRequestInput = {
    sourceAccountId: config.MURAL_SOURCE_ACCOUNT_ID,
    memo: input.memo,
    payouts: [
      {
        amount: { tokenAmount: Number(input.amountUSDC), tokenSymbol: "USDC" },
        payoutDetails: {
          type: "counterpartyPayoutMethod",
          payoutMethodId: muralPayoutMethodId,
        },
        recipientInfo: {
          type: "counterpartyInfo",
          counterpartyId: muralCounterpartyId,
        },
      },
    ],
  };

  let created: MuralPayoutRequest;
  try {
    created = await mural.createPayoutRequest(request);
  } catch (e) {
    return failPayout(payout.id, e);
  }

  // Record the Mural request as soon as it exists, so a failed execute can
  // still be traced back to it.
  await prisma.payout.update({
    where: { id: payout.id },
    data: { muralPayoutId: created.id },
  });

  try {
    await mural.executePayoutRequest(created.id);
  } catch (e) {
    return failPayout(payout.id, e);
  }

  const updated = await prisma.payout.update({
    where: { id: payout.id },
    data: { status: "COMPLETED" },
  });

  return updated;
}

/**
 * Marks the payout FAILED with Mural's reason and throws PAYOUT_FAILED:
 * 422 when Mural rejected the request (4xx), 502 for Mural 5xx or network
 * errors. Every failure is marked FAILED, including ambiguous ones (timeouts,
 * 5xx on execute) where Mural may still have executed; reconciling those
 * needs status sync, which is a separate change.
 */
async function failPayout(payoutId: string, e: unknown): Promise<never> {
  const info = describeMuralError(payoutId, e);
  const errorMessage = info.trace ? `${info.reason} (trace ${info.trace})` : info.reason;

  const failed = await prisma.payout.update({
    where: { id: payoutId },
    data: { status: "FAILED", errorMessage },
  });
  logger.error("payout.mural.failed", {
    payoutId,
    muralPayoutId: failed.muralPayoutId,
    muralStatus: info.status,
    errorMessage,
  });

  const rejectedByMural = info.status !== undefined && info.status >= 400 && info.status < 500;
  throw new HttpError(rejectedByMural ? 422 : 502, "PAYOUT_FAILED", errorMessage, {
    payout: failed,
    muralStatus: info.status,
  });
}

export type BatchGetPayoutsInput = {
  contractorId: string;
  limit: number;
  cursor?: string;
};

/**
 * Lists one contractor's payouts, newest first. Keyset-paginated on
 * (createdAt, id): `nextCursor` is the id of the last payout on the page, and
 * is null when there are no more pages.
 */
export async function batchGetPayouts(input: BatchGetPayoutsInput) {
  const contractor = await prisma.contractor.findUnique({
    where: { id: input.contractorId },
  });
  if (!contractor) throw new NotFoundError("Contractor", input.contractorId);

  if (input.cursor) {
    // Prisma positions the page from the cursor row even if it doesn't match
    // `where`, so a cursor from another contractor must be rejected explicitly.
    const cursorRow = await prisma.payout.findUnique({
      where: { id: input.cursor },
      select: { contractorId: true },
    });
    if (!cursorRow || cursorRow.contractorId !== contractor.id) {
      throw new ValidationError(`Invalid cursor "${input.cursor}"`);
    }
  }

  const rows = await prisma.payout.findMany({
    where: { contractorId: contractor.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > input.limit;
  const payouts = hasMore ? rows.slice(0, input.limit) : rows;

  return {
    contractor,
    payouts,
    nextCursor: hasMore ? payouts[payouts.length - 1].id : null,
  };
}

export async function getPayout(id: string) {
  const payout = await prisma.payout.findUnique({
    where: { id },
    include: { contractor: true },
  });
  if (!payout) throw new NotFoundError("Payout", id);
  return payout;
}
