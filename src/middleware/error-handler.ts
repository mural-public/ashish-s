import type { ErrorRequestHandler } from "express";
import { HttpError } from "../lib/errors";
import { MuralApiError } from "../lib/mural-client";
import { logger } from "../lib/logger";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof MuralApiError) {
    logger.error("mural.api.error", {
      status: err.status,
      body: err.body,
      path: err.path,
      requestId: err.requestId,
    });
    res.status(502).json({
      error: {
        code: "MURAL_API_ERROR",
        message: `Mural API returned ${err.status} on ${err.path}`,
        muralStatus: err.status,
        muralBody: err.body,
        requestId: err.requestId,
      },
    });
    return;
  }

  const e = err as Error;
  logger.error("unhandled.error", { message: e.message, stack: e.stack });
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};
