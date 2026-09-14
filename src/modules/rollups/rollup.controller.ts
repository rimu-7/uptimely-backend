import { Elysia } from "elysia";
import { RollupService } from "./rollup.service";

export const rollupController = new Elysia({ prefix: "/api/v1/rollups" }).post(
  "/run",
  async () => {
    return RollupService.triggerRollups();
  }
);
