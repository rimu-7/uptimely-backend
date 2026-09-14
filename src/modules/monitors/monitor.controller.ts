import { Elysia, t } from "elysia";
import { MonitorService } from "./monitor.service";
import { getUserFromRequest } from "../../middleware/auth.middleware";

export const monitorController = new Elysia({ prefix: "/api/v1/monitors" })
  .get("/", async ({ request, set }) => {
    const user = await getUserFromRequest(request);
    if (!user) {
      set.status = 401;
      return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
    }
    return MonitorService.listUserMonitors(user.id);
  })
  .get(
    "/:id/checks",
    async ({ request, params: { id }, set }) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
      }

      const checks = await MonitorService.getMonitorChecks(user.id, id);
      if (!checks) {
        set.status = 404;
        return { error: "Monitor not found or unauthorized" };
      }

      return checks;
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
      }),
    }
  )
  .post(
    "/",
    async ({ request, body, set }) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
      }

      const result = await MonitorService.createMonitor(user.id, body);

      if (!result.success) {
        set.status = result.status;
        return {
          error: result.error,
          message: result.message,
          existingMonitor: result.existingMonitor,
          suggestion: result.suggestion,
        };
      }

      set.status = 201;
      return result.data;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        url: t.String({ format: "uri" }),
        method: t.Optional(t.String()),
        intervalSeconds: t.Optional(t.Number({ minimum: 10 })),
        expectedStatus: t.Optional(t.Number({ minimum: 100, maximum: 599 })),
      }),
    }
  )
  .patch(
    "/:id",
    async ({ request, params: { id }, body, set }) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
      }

      const updated = await MonitorService.updateMonitor(user.id, id, body);
      if (!updated) {
        set.status = 404;
        return { error: "Monitor not found or unauthorized" };
      }

      return updated;
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
      }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        url: t.Optional(t.String({ format: "uri" })),
        method: t.Optional(t.String()),
        intervalSeconds: t.Optional(t.Number({ minimum: 10 })),
        timeoutMs: t.Optional(t.Number({ minimum: 500 })),
        expectedStatus: t.Optional(t.Number({ minimum: 100, maximum: 599 })),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  .delete(
    "/:id",
    async ({ request, params: { id }, set }) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
      }

      const deleted = await MonitorService.deleteMonitor(user.id, id);
      if (!deleted) {
        set.status = 404;
        return { error: "Monitor not found or unauthorized" };
      }

      return { status: "deleted", id: deleted.id, name: deleted.name };
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
      }),
    }
  );
