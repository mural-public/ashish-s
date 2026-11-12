import { Router } from "express";
import { config } from "../config";
import { getMuralClient } from "../lib/mural-client";

export const accountRouter = Router();

/**
 * GET /account — returns the source Mural account: balances + deposit address.
 *
 * The candidate is not asked to extend this endpoint. It exists so it's clear
 * that money enters the system via deposits to the wallet shown here.
 */
accountRouter.get("/", async (_req, res, next) => {
  try {
    const account = await getMuralClient().getAccount(config.MURAL_SOURCE_ACCOUNT_ID);
    res.json({ account });
  } catch (e) {
    next(e);
  }
});
