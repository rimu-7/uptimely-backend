import { db, schema } from "../../db";
import { eq } from "drizzle-orm";
import { generateTokenForUser, generateTestToken } from "../../middleware/auth.middleware";
import { redis } from "../../config/redis";
import { OTPService } from "../../services/otp.service";

export interface RegisterDTO {
  email: string;
  password: string;
  fullName?: string;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface VerifyOTPDTO {
  email: string;
  otp: string;
}

export interface ResendOTPDTO {
  email: string;
}

export class AuthService {
  /**
   * Register user with initial isVerified = false state and send OTP email
   */
  static async register(dto: RegisterDTO) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const [existing] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, normalizedEmail))
      .limit(1);

    if (existing) {
      // Update password hash and send a fresh OTP to verify ownership before activating
      const newPasswordHash = await Bun.password.hash(dto.password);
      await db
        .update(schema.users)
        .set({
          passwordHash: newPasswordHash,
          isVerified: false,
          fullName: dto.fullName?.trim() || existing.fullName,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, existing.id));

      await OTPService.createAndSendOTP(normalizedEmail);

      return {
        success: true as const,
        status: 200,
        requiresVerification: true,
        message: "A fresh 6-digit verification OTP code has been sent to your email address.",
        email: normalizedEmail,
      };
    }

    // Hardware-accelerated Argon2id hashing
    const passwordHash = await Bun.password.hash(dto.password);

    const [newUser] = await db
      .insert(schema.users)
      .values({
        email: normalizedEmail,
        passwordHash,
        fullName: dto.fullName?.trim() || null,
        isVerified: false,
      })
      .returning();

    console.log(`👤 [Auth Service] New unverified user created: "${newUser.email}" (ID: ${newUser.id})`);

    // Generate & Dispatch 6-digit OTP code
    await OTPService.createAndSendOTP(normalizedEmail);

    return {
      success: true as const,
      status: 201,
      requiresVerification: true,
      message: "Registration successful! A 6-digit verification code has been sent to your email. Please verify to activate your account.",
      email: normalizedEmail,
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.fullName,
        isVerified: false,
        createdAt: newUser.createdAt,
      },
    };
  }

  /**
   * Verify OTP code, set isVerified = true, and issue JWT access token
   */
  static async verifyEmailOTP(dto: VerifyOTPDTO) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, normalizedEmail))
      .limit(1);

    if (!user) {
      return {
        success: false as const,
        status: 404,
        error: "User not found",
        message: "No account found matching this email address. Please register first.",
      };
    }

    if (user.isVerified) {
      const token = await generateTokenForUser(user);
      return {
        success: true as const,
        status: 200,
        message: "Account is already verified.",
        access_token: token,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          isVerified: true,
          createdAt: user.createdAt,
        },
      };
    }

    const isValidOtp = await OTPService.verifyOTP(normalizedEmail, dto.otp);
    if (!isValidOtp) {
      return {
        success: false as const,
        status: 400,
        error: "Invalid or expired OTP",
        message: "The 6-digit verification code provided is invalid or has expired. Please check your email or click Resend OTP.",
      };
    }

    // Update isVerified = true in database
    const [updatedUser] = await db
      .update(schema.users)
      .set({
        isVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, user.id))
      .returning();

    const token = await generateTokenForUser(updatedUser);
    console.log(`✅ [Auth Service] Email verified successfully for: "${updatedUser.email}" (ID: ${updatedUser.id})`);

    return {
      success: true as const,
      status: 200,
      message: "Email verified successfully! Welcome to your dashboard.",
      access_token: token,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        fullName: updatedUser.fullName,
        isVerified: true,
        createdAt: updatedUser.createdAt,
      },
    };
  }

  /**
   * Resend a fresh 6-digit OTP code to an unverified user's email
   */
  static async resendOTP(dto: ResendOTPDTO) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, normalizedEmail))
      .limit(1);

    if (!user) {
      return {
        success: false as const,
        status: 404,
        error: "User not found",
        message: "No account found matching this email address.",
      };
    }

    if (user.isVerified) {
      return {
        success: false as const,
        status: 400,
        error: "Already verified",
        message: "This email address is already verified. You can log in directly.",
      };
    }

    const isLimited = await OTPService.isRateLimited(normalizedEmail);
    if (isLimited) {
      return {
        success: false as const,
        status: 429,
        error: "Rate limit exceeded",
        message: "Please wait 60 seconds before requesting another verification code.",
      };
    }

    await OTPService.createAndSendOTP(normalizedEmail);

    return {
      success: true as const,
      status: 200,
      message: "A fresh 6-digit verification code has been sent to your email.",
      email: normalizedEmail,
    };
  }

  /**
   * Login credentials validation with strict unverified user blocking
   */
  static async login(dto: LoginDTO) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, normalizedEmail))
      .limit(1);

    if (!user) {
      console.warn(`⚠️ [Auth Service] Login failed: User not found for email "${normalizedEmail}"`);
      return {
        success: false as const,
        status: 401,
        error: "User not found",
        message: "No account found matching this email address. Please register first.",
      };
    }

    const isMatch = await Bun.password.verify(dto.password, user.passwordHash);
    if (!isMatch) {
      console.warn(`⚠️ [Auth Service] Login failed: Password mismatch for email "${normalizedEmail}"`);
      return {
        success: false as const,
        status: 401,
        error: "Invalid password",
        message: "Incorrect password for this email address. You can re-register with your email to set a new password via OTP verification.",
      };
    }

    // STRICT UNVERIFIED USER GUARD
    if (!user.isVerified) {
      console.warn(`🔒 [Auth Service] Login blocked for unverified user: "${user.email}" (ID: ${user.id})`);

      const isLimited = await OTPService.isRateLimited(normalizedEmail);
      if (!isLimited) {
        await OTPService.createAndSendOTP(normalizedEmail);
      }

      return {
        success: false as const,
        status: 403,
        requiresVerification: true,
        error: "Email not verified",
        message: "Your email address is not verified yet. A 6-digit verification OTP code has been sent to your email. Please enter the OTP to verify.",
        email: normalizedEmail,
      };
    }

    const token = await generateTokenForUser(user);
    console.log(`🔑 [Auth Service] User logged in: "${user.email}" (ID: ${user.id})`);

    return {
      success: true as const,
      status: 200,
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        isVerified: true,
        createdAt: user.createdAt,
      },
    };
  }

  static async logout(token?: string, userId?: string) {
    if (token) {
      // Blacklist token in Redis for 30 days (2,592,000 seconds)
      await redis.set(`blacklist:token:${token}`, "revoked", { ex: 2592000 }).catch(() => {});
      console.log(`🚪 [Auth Service] User logged out (Token blacklisted in Redis) ${userId ? `- User ID: ${userId}` : ""}`);
    }

    return {
      status: "success",
      message: "Successfully logged out. Access token has been revoked.",
    };
  }

  static async getProfile(userId: string) {
    const [userRecord] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        fullName: schema.users.fullName,
        isVerified: schema.users.isVerified,
        createdAt: schema.users.createdAt,
        updatedAt: schema.users.updatedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    return userRecord || null;
  }

  static async generateDevToken(userId?: string, email?: string) {
    const targetId = userId || "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const targetEmail = email || "team@rimubhai.com";
    const token = await generateTestToken(targetId, targetEmail);

    return {
      token,
      userId: targetId,
      email: targetEmail,
    };
  }
}

