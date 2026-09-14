import { Elysia, t } from "elysia";
import { StatusPageService } from "./status-page.service";

export const statusPageController = new Elysia({ prefix: "/api/v1/status-page" }).get(
  "/:userId",
  async ({ params: { userId } }) => {
    return StatusPageService.getStatusPageData(userId);
  },
  {
    params: t.Object({
      userId: t.String({ format: "uuid" }),
    }),
  }
);
