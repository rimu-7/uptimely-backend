import { Elysia } from "elysia";

const ALLOWED_ORIGIN = process.env.UPTIMELY_URL;
/**
 * Strict Security & Origin Guard Middleware
 * Explicitly rejects any request coming from localhost or unapproved origins/referers.
 */
export const originGuardPlugin = new Elysia({
  name: "origin-guard-plugin",
}).onRequest(({ request, set }) => {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // 1. Explicit Localhost Rejection
  const isLocalhost =
    (origin &&
      (origin.includes("localhost") || origin.includes("127.0.0.1"))) ||
    (referer &&
      (referer.includes("localhost") || referer.includes("127.0.0.1")));

  if (isLocalhost) {
    set.status = 403;
    return {
      error: "Forbidden",
      message:
        "Access Denied: Requests originating from localhost are strictly blocked by origin security policy.",
    };
  }

  // 2. Browser Origin Enforcer
  if (origin && origin !== ALLOWED_ORIGIN && !origin.endsWith(".vercel.app")) {
    set.status = 403;
    return {
      error: "Forbidden",
      message: `Access Denied: Origin '${origin}' is not authorized. Allowed origin: ${ALLOWED_ORIGIN}`,
    };
  }
});
