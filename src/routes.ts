import { Elysia } from "elysia";
import { authController } from "./modules/auth/auth.controller";
import { heartbeatController } from "./modules/heartbeats/heartbeat.controller";
import { monitorController } from "./modules/monitors/monitor.controller";
import { statusPageController } from "./modules/status-page/status-page.controller";
import { rollupController } from "./modules/rollups/rollup.controller";

export const appRouter = new Elysia()
  // Health check endpoint
  .get("/health", () => ({ status: "ok", runtime: "bun", uptime: process.uptime() }))

  // Domain Controllers
  .use(authController)
  .use(heartbeatController)
  .use(monitorController)
  .use(statusPageController)
  .use(rollupController);
