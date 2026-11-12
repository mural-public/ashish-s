import type { Contractor } from "@prisma/client";
import {
  getMuralClient,
  type MuralIndividualCounterpartyInput,
  type MuralPayoutMethodInput,
  type MuralPhysicalAddressInput,
} from "../lib/mural-client";

/**
 * Provisions Mural-side records for a contractor: a Counterparty + a PayoutMethod.
 * Returns the IDs the caller should persist on the local Contractor row.
 *
 * Note: if the PayoutMethod creation fails after the Counterparty was created,
 * the orphan Counterparty is left in Mural. Callers may choose to clean up.
 */
export async function provisionMuralCounterparty(contractor: Contractor): Promise<{
  muralCounterpartyId: string;
  muralPayoutMethodId: string;
}> {
  const mural = getMuralClient();

  const counterpartyInput: MuralIndividualCounterpartyInput = {
    counterparty: {
      type: "individual",
      firstName: contractor.firstName,
      lastName: contractor.lastName,
      email: contractor.email,
      physicalAddress: toMuralAddress(contractor.physicalAddress as Record<string, unknown>),
    },
  };

  const counterparty = await mural.createCounterparty(counterpartyInput);

  const payoutMethodInput = mapBankAccountToPayoutMethod(contractor);
  const payoutMethod = await mural.createPayoutMethod(counterparty.id, payoutMethodInput);

  return {
    muralCounterpartyId: counterparty.id,
    muralPayoutMethodId: payoutMethod.id,
  };
}

function toMuralAddress(addr: Record<string, unknown>): MuralPhysicalAddressInput {
  return {
    address1: String(addr.address1),
    ...(addr.address2 ? { address2: String(addr.address2) } : {}),
    country: String(addr.country),
    subDivision: String(addr.state),
    city: String(addr.city),
    postalCode: String(addr.zip),
  };
}

function mapBankAccountToPayoutMethod(contractor: Contractor): MuralPayoutMethodInput {
  const bank = contractor.bankAccount as Record<string, unknown>;
  const alias = `${contractor.firstName} ${contractor.lastName} ${contractor.currency}`;

  switch (contractor.currency) {
    case "MXN":
      return {
        alias,
        payoutMethod: {
          type: "mxn",
          details: {
            type: "mxnDomestic",
            symbol: "MXN",
            bankAccountNumber: String(bank.bankAccountNumber),
            bankId: String(bank.bankId),
          },
        },
      };
    case "COP":
      return {
        alias,
        payoutMethod: {
          type: "cop",
          details: {
            type: "copDomestic",
            symbol: "COP",
            phoneNumber: String(bank.phoneNumber),
            accountType: bank.accountType as "CHECKING" | "SAVINGS",
            bankAccountNumber: String(bank.bankAccountNumber),
            documentNumber: String(bank.documentNumber),
            documentType: bank.documentType as
              | "NATIONAL_ID"
              | "RUC_NIT"
              | "PASSPORT"
              | "RESIDENT_ID",
            bankId: String(bank.bankId),
          },
        },
      };
    default:
      throw new Error(
        `Unsupported currency: ${contractor.currency}. Add a mapping in counterparty-service.ts.`,
      );
  }
}
