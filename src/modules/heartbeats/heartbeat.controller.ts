import { Elysia, t } from "elysia";
import { HeartbeatService } from "./heartbeat.service";
import { getUserFromRequest } from "../../middleware/auth.middleware";

export const heartbeatController = new Elysia()
  // Public Ping endpoints
  .get(
    "/api/v1/ping/:slug",
    async ({ params: { slug }, set }) => {
      const result = await HeartbeatService.handlePing(slug);
      if (!result) {
        set.status = 404;
        return {
          error: "Heartbeat monitor not found",
          slug,
          message: `No heartbeat monitor registered matching slug or ID '${slug}'.`,
          suggestion: `Create a heartbeat monitor first using POST /api/v1/heartbeats with slug '${slug}'.`,
        };
      }
      return result;
    },
    { params: t.Object({ slug: t.String() }) }
  )
  .post(
    "/api/v1/ping/:slug",
    async ({ params: { slug }, set }) => {
      const result = await HeartbeatService.handlePing(slug);
      if (!result) {
        set.status = 404;
        return {
          error: "Heartbeat monitor not found",
          slug,
          message: `No heartbeat monitor registered matching slug or ID '${slug}'.`,
          suggestion: `Create a heartbeat monitor first using POST /api/v1/heartbeats with slug '${slug}'.`,
        };
      }
      return result;
    },
    { params: t.Object({ slug: t.String() }) }
  )

  // Protected User Isolated Heartbeat Management Endpoints
  .group("/api/v1/heartbeats", (group) =>
    group
      .get("/", async ({ request, set }) => {
        const user = await getUserFromRequest(request);
        if (!user) {
          set.status = 401;
          return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
        }
        return HeartbeatService.listUserHeartbeats(user.id);
      })
      .post(
        "/",
        async ({ request, body, set }) => {
          const user = await getUserFromRequest(request);
          if (!user) {
            set.status = 401;
            return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
          }

          const result = await HeartbeatService.createHeartbeat(user.id, body);

          if (!result.success) {
            set.status = result.status;
            return {
              error: result.error,
              message: result.message,
              existingHeartbeat: result.existingHeartbeat,
              suggestion: result.suggestion,
            };
          }

          set.status = 201;
          return result.data;
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1 }),
            slug: t.String({ minLength: 1 }),
            expectedInterval: t.Number({ minimum: 10 }),
            gracePeriod: t.Optional(t.Number({ minimum: 10 })),
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

          const deleted = await HeartbeatService.deleteHeartbeat(user.id, id);
          if (!deleted) {
            set.status = 404;
            return { error: "Heartbeat not found or unauthorized" };
          }

          return { status: "deleted", id: deleted.id, slug: deleted.slug };
        },
        {
          params: t.Object({
            id: t.String({ format: "uuid" }),
          }),
        }
      )
  );
