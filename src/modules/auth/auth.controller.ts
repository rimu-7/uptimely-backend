import { Elysia, t } from "elysia";
import { AuthService } from "./auth.service";
import { getUserFromRequest, extractTokenFromRequest } from "../../middleware/auth.middleware";
import { authRateLimiter } from "../../middleware/rate-limit.middleware";

export const authController = new Elysia({ prefix: "/api/v1/auth" })
  .use(authRateLimiter)
  // User Registration
  .post(
    "/register",
    async ({ body, set }) => {
      const result = await AuthService.register(body);

      set.status = result.status || 201;
      return {
        status: "pending_verification",
        requires_verification: true,
        message: result.message,
        email: result.email,
        user: result.user,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 6, error: "Password must be at least 6 characters long" }),
        fullName: t.Optional(t.String()),
      }),
    }
  )

  // Verify OTP Email Code
  .post(
    "/verify-otp",
    async ({ body, set }) => {
      const result = await AuthService.verifyEmailOTP(body);

      if (!result.success) {
        set.status = result.status;
        return { error: result.error, message: result.message };
      }

      set.status = 200;
      return {
        status: "success",
        message: result.message,
        token_type: "Bearer",
        access_token: result.access_token,
        user: result.user,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        otp: t.String({ minLength: 6, maxLength: 6, error: "OTP code must be exactly 6 digits" }),
      }),
    }
  )

  // Resend OTP Code
  .post(
    "/resend-otp",
    async ({ body, set }) => {
      const result = await AuthService.resendOTP(body);

      if (!result.success) {
        set.status = result.status;
        return { error: result.error, message: result.message };
      }

      set.status = 200;
      return {
        status: "success",
        message: result.message,
        email: result.email,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
      }),
    }
  )

  // User Login
  .post(
    "/login",
    async ({ body, set }) => {
      const result = await AuthService.login(body);

      if (!result.success) {
        set.status = result.status;
        if (result.requiresVerification) {
          return {
            error: result.error,
            requires_verification: true,
            message: result.message,
            email: result.email,
          };
        }
        return { error: result.error, message: result.message };
      }

      return {
        status: "success",
        message: "Login successful",
        token_type: "Bearer",
        access_token: result.access_token,
        user: result.user,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 1 }),
      }),
    }
  )

  // User Logout
  .post("/logout", async ({ request, set }) => {
    const token = extractTokenFromRequest(request);
    const authUser = await getUserFromRequest(request);

    if (!token && !authUser) {
      set.status = 401;
      return { error: "Unauthorized", message: "No active session or Bearer token provided to log out." };
    }

    const result = await AuthService.logout(token || undefined, authUser?.id);
    return result;
  })

  // Dev Test Token Helper
  .post(
    "/token",
    async ({ body }) => {
      const result = await AuthService.generateDevToken(body?.userId, body?.email);
      return {
        status: "success",
        token_type: "Bearer",
        access_token: result.token,
        user: { id: result.userId, email: result.email },
        instructions: "Include header 'Authorization: Bearer <access_token>' in requests to protected routes.",
      };
    },
    {
      body: t.Optional(
        t.Object({
          userId: t.Optional(t.String()),
          email: t.Optional(t.String()),
        })
      ),
    }
  )

  // Authenticated Profile Endpoint
  .get("/me", async ({ request, set }) => {
    const authUser = await getUserFromRequest(request);
    if (!authUser) {
      set.status = 401;
      return { error: "Unauthorized", message: "Invalid or missing Bearer access token" };
    }

    const userProfile = await AuthService.getProfile(authUser.id);

    return {
      status: "authenticated",
      user: userProfile || {
        id: authUser.id,
        email: authUser.email,
        role: authUser.role,
      },
    };
  });
