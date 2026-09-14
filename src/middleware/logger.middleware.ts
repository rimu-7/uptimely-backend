import { Elysia } from "elysia";

const requestTimings = new WeakMap<Request, number>();

export const loggerPlugin = new Elysia({ name: "logger-plugin" })
  .onRequest(({ request }) => {
    requestTimings.set(request, performance.now());
  })
  .onAfterResponse(({ request, set }) => {
    const startTime = requestTimings.get(request);
    const duration = startTime ? (performance.now() - startTime).toFixed(1) : "?";
    const url = new URL(request.url);
    const status = set.status || 200;
    const statusEmoji = Number(status) >= 400 ? "⚠️" : "🌐";

    console.log(`${statusEmoji} [HTTP] ${request.method} ${url.pathname} => Status ${status} (${duration}ms)`);
  })
  .onError(({ code, error, request }) => {
    const url = request ? new URL(request.url).pathname : "unknown";
    console.error(`💥 [HTTP ERROR] ${request?.method || "REQ"} ${url} [Code: ${code}]:`, (error as any).message || error);
  });
