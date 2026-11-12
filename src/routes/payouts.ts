import { Router } from "express";
import { z } from "zod";
import { createPayout, getPayout } from "../services/payout-service";
import { ValidationError } from "../lib/errors";

const CreatePayoutSchema = z.object({
  contractorId: z.string().uuid(),
  amountUSDC: z.string(),
  memo: z.string().max(500).optional(),
});

export const payoutsRouter = Router();

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
