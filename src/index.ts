import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { config } from "./config/env";
import { client } from "./db";
import { loggerPlugin } from "./middleware/logger.middleware";
import { appRouter } from "./routes";
import { WorkerScheduler } from "./workers/scheduler";

export const app = new Elysia()
  .use(
    cors({
      origin: (request) => {
        const origin = request.headers.get("origin");
        if (!origin) return true;
        const allowedOrigins = [
          "https://uptimely.netlify.app",
          "http://localhost:3000",
          "http://localhost:5173",
          "http://localhost:3001",
        ];
        if (allowedOrigins.includes(origin) || origin.endsWith(".netlify.app")) {
          return true;
        }
        return true;
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
      credentials: true,
    })
  )
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: { title: "Uptime Backend Engine", version: "2.0.0" },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    })
  )
  .use(loggerPlugin)
  .use(appRouter);

// Start standalone HTTP listener if running outside Vercel/Netlify serverless environment
if (!process.env.VERCEL && !process.env.NETLIFY && !process.env.LAMBDA_TASK_ROOT) {
  app.listen(config.port, () => {
    console.log(`\n🚀 [SERVER ONLINE] Elysia running on http://localhost:${config.port}`);
    console.log(`📚 [SWAGGER DOCS] Interactive documentation at http://localhost:${config.port}/docs\n`);

    // Start background schedulers
    WorkerScheduler.startAll();
  });
}

export default app;

// Graceful shutdown handling
async function handleShutdown(signal: string) {
  console.log(`\n🛑 [SHUTDOWN] Received ${signal}. Closing database connection pool...`);
  try {
    await client.end();
    console.log(`✅ [SHUTDOWN] Database connection pool closed.`);
  } catch (err: any) {
    console.error("❌ [Shutdown Error]", err.message || err);
  }
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
