import { Decimal } from "decimal.js";
import { prisma } from "../lib/db";
import { config } from "../config";
import {
  getMuralClient,
  type MuralCreatePayoutRequestInput,
  type MuralPayoutRequest,
} from "../lib/mural-client";
import { provisionMuralCounterparty } from "./counterparty-service";
import { NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";

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

  const muralResult = await sendToMural({
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
  });

  const updated = await prisma.payout.update({
    where: { id: payout.id },
    data: {
      status: "COMPLETED",
      muralPayoutId: muralResult?.id ?? null,
    },
  });

  return updated;
}

async function sendToMural(
  input: MuralCreatePayoutRequestInput,
): Promise<MuralPayoutRequest | null> {
  try {
    const mural = getMuralClient();
    const created = await mural.createPayoutRequest(input);
    const executed = await mural.executePayoutRequest(created.id);
    return executed;
  } catch (e) {
    logger.error("payout.mural.failed", { error: (e as Error).message });
    return null;
  }
}

export async function getPayout(id: string) {
  const payout = await prisma.payout.findUnique({
    where: { id },
    include: { contractor: true },
  });
  if (!payout) throw new NotFoundError("Payout", id);
  return payout;
}
