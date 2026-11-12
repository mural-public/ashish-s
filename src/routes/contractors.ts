import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { provisionMuralCounterparty } from "../services/counterparty-service";
import { getMuralClient } from "../lib/mural-client";
import { logger } from "../lib/logger";

const PhysicalAddressSchema = z.object({
  address1: z.string().min(1),
  address2: z.string().optional(),
  country: z.string().length(2),
  state: z.string().min(1),
  city: z.string().min(1),
  zip: z.string().min(1),
});

const MXNBankAccountSchema = z.object({
  type: z.literal("mxnDomestic"),
  symbol: z.literal("MXN"),
  bankAccountNumber: z.string().min(1),
  bankId: z.string().min(1),
});

const COPBankAccountSchema = z.object({
  type: z.literal("copDomestic"),
  symbol: z.literal("COP"),
  phoneNumber: z.string().min(1),
  accountType: z.enum(["CHECKING", "SAVINGS"]),
  bankAccountNumber: z.string().min(1),
  documentNumber: z.string().min(1),
  documentType: z.enum(["NATIONAL_ID", "RUC_NIT", "PASSPORT", "RESIDENT_ID"]),
  bankId: z.string().min(1),
});

const BankAccountSchema = z.discriminatedUnion("type", [
  MXNBankAccountSchema,
  COPBankAccountSchema,
]);

const CreateContractorSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  physicalAddress: PhysicalAddressSchema,
  bankAccount: BankAccountSchema,
});

const UpdateContractorSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  physicalAddress: PhysicalAddressSchema.optional(),
  isActive: z.boolean().optional(),
});

const ListQuerySchema = z.object({
  isActive: z.enum(["true", "false"]).optional(),
});

export const contractorsRouter = Router();

contractorsRouter.get("/", async (req, res, next) => {
  try {
    const query = ListQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new ValidationError("Invalid query parameters", query.error.flatten());
    }
    const isActive =
      query.data.isActive === "true" ? true : query.data.isActive === "false" ? false : undefined;

    const contractors = await prisma.contractor.findMany({
      where: isActive !== undefined ? { isActive } : undefined,
      orderBy: { createdAt: "desc" },
    });
    res.json({ contractors });
  } catch (e) {
    next(e);
  }
});

contractorsRouter.get("/:id", async (req, res, next) => {
  try {
    const contractor = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!contractor) throw new NotFoundError("Contractor", req.params.id);
    res.json({ contractor });
  } catch (e) {
    next(e);
  }
});

contractorsRouter.post("/", async (req, res, next) => {
  try {
    const parsed = CreateContractorSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid contractor input", parsed.error.flatten());
    }
    const data = parsed.data;
    const currency = data.bankAccount.symbol;

    const existing = await prisma.contractor.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new ConflictError(`Contractor with email "${data.email}" already exists`);
    }

    let contractor = await prisma.contractor.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        physicalAddress: data.physicalAddress,
        bankAccount: data.bankAccount,
        currency,
      },
    });

    const { muralCounterpartyId, muralPayoutMethodId } =
      await provisionMuralCounterparty(contractor);

    contractor = await prisma.contractor.update({
      where: { id: contractor.id },
      data: { muralCounterpartyId, muralPayoutMethodId },
    });

    logger.info("contractor.created", { contractorId: contractor.id, muralCounterpartyId });
    res.status(201).json({ contractor });
  } catch (e) {
    next(e);
  }
});

contractorsRouter.patch("/:id", async (req, res, next) => {
  try {
    const parsed = UpdateContractorSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid update", parsed.error.flatten());
    }
    const contractor = await prisma.contractor.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    res.json({ contractor });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return next(new NotFoundError("Contractor", req.params.id));
    }
    next(e);
  }
});

contractorsRouter.delete("/:id", async (req, res, next) => {
  try {
    const contractor = await prisma.contractor.findUnique({ where: { id: req.params.id } });
    if (!contractor) throw new NotFoundError("Contractor", req.params.id);

    if (contractor.muralCounterpartyId) {
      await getMuralClient().archiveCounterparty(contractor.muralCounterpartyId);
    }

    await prisma.contractor.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (e) {
    next(e);
  }
});
