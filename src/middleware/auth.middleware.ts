import { Elysia } from "elysia";
import * as jose from "jose";
import { config } from "../config/env";
import { redis } from "../config/redis";

export interface AuthUser {
  id: string;
  email?: string;
  role?: string;
}

const secretKey = new TextEncoder().encode(config.jwtSecret);

/**
 * Verify a Supabase access token (JWT) with Redis revocation check
 */
export async function verifySupabaseToken(token: string): Promise<AuthUser | null> {
  try {
    // Check if token has been revoked / logged out in Redis
    const isRevoked = await redis.get(`blacklist:token:${token}`).catch(() => null);
    if (isRevoked) {
      console.warn("⚠️ [Auth Warning] Attempted access with revoked/logged-out JWT token.");
      return null;
    }

    const { payload } = await jose.jwtVerify(token, secretKey);
    if (!payload.sub) return null;

    return {
      id: payload.sub as string,
      email: (payload.email as string) || undefined,
      role: (payload.role as string) || "authenticated",
    };
  } catch (err: any) {
    console.warn("⚠️ [Auth Warning] Token verification failed:", err.message || err);
    return null;
  }
}

/**
 * Extract raw Bearer token from request
 */
export function extractTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7).trim();
  }
  try {
    const url = new URL(request.url);
    return url.searchParams.get("access_token");
  } catch {
    return null;
  }
}

/**
 * Extract and verify user from incoming request Authorization header or access_token param
 */
export async function getUserFromRequest(request: Request): Promise<AuthUser | null> {
  const token = extractTokenFromRequest(request);
  if (!token) return null;
  return verifySupabaseToken(token);
}

/**
 * Generate a signed JWT token for registered/authenticated users
 */
export async function generateTokenForUser(user: { id: string; email?: string; fullName?: string | null }): Promise<string> {
  return new jose.SignJWT({
    sub: user.id,
    email: user.email || undefined,
    user_metadata: {
      full_name: user.fullName || undefined,
    },
    role: "authenticated",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey);
}

/**
 * Dev test token generator
 */
export async function generateTestToken(userId: string, email = "user@domain.com"): Promise<string> {
  return generateTokenForUser({ id: userId, email });
}

/**
 * Elysia Auth Middleware Plugin (adds { user } to handler context)
 */
export const authPlugin = new Elysia({ name: "auth-plugin" })
  .derive(async ({ request }) => {
    const user = await getUserFromRequest(request);
    return { user };
  });
