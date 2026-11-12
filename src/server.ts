import express from "express";
import { config } from "./config";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/error-handler";
import { accountRouter } from "./routes/account";
import { contractorsRouter } from "./routes/contractors";
import { payoutsRouter } from "./routes/payouts";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "contractor-pay" });
  });

  app.use("/account", accountRouter);
  app.use("/contractors", contractorsRouter);
  app.use("/payouts", payoutsRouter);

  app.use(errorHandler);
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.PORT, () => {
    logger.info("server.listening", { port: config.PORT, env: config.NODE_ENV });
  });
}
