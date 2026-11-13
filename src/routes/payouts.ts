import { Router } from "express";
import { z } from "zod";
import { batchGetPayouts, createPayout, getPayout } from "../services/payout-service";
import { ValidationError } from "../lib/errors";

const CreatePayoutSchema = z.object({
  contractorId: z.string().uuid(),
  amountUSDC: z.string(),
  memo: z.string().max(500).optional(),
});

const BatchGetQuerySchema = z.object({
  contractorId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export const payoutsRouter = Router();

payoutsRouter.get("/", async (req, res, next) => {
  try {
    const query = BatchGetQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new ValidationError("Invalid query parameters", query.error.flatten());
    }
    const result = await batchGetPayouts(query.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

payoutsRouter.post("/", async (req, res, next) => {
  try {
    const parsed = CreatePayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid payout input", parsed.error.flatten());
    }
    const payout = await createPayout(parsed.data);
    res.status(201).json({ payout });
  } catch (e) {
    next(e);
  }
});

payoutsRouter.get("/:id", async (req, res, next) => {
  try {
    const payout = await getPayout(req.params.id);
    res.json({ payout });
  } catch (e) {
    next(e);
  }
});
