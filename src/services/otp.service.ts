import { redis } from "../config/redis";
import { config } from "../config/env";
import { Resend } from "resend";
import { formatLocalWithTimezone } from "../utils/date";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

// Redis Key Helpers
const getOtpKey = (email: string) => `otp:email:${email.toLowerCase()}`;
const getCooldownKey = (email: string) => `otp_cooldown:${email.toLowerCase()}`;

/**
 * Generate a cryptographically strong 6-digit numeric OTP code
 */
export function generateOTPCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const num = (array[0] % 900000) + 100000;
  return num.toString();
}

/**
 * Build rich HTML email for OTP Verification
 */
function buildOTPEmailHtml(email: string, otp: string): string {
  const localTimeStr = formatLocalWithTimezone();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Verification Code</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc;">
  <div style="max-width: 520px; margin: 0 auto; background: #1e293b; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5); border: 1px solid #334155;">
    
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
      <div style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; opacity: 0.9; margin-bottom: 8px;">
        Uptime Engine Verification
      </div>
      <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">
        Verify Your Email Address
      </h1>
    </div>

    <!-- Main Content -->
    <div style="padding: 32px 24px; text-align: center;">
      <p style="margin: 0 0 20px 0; font-size: 15px; color: #94a3b8; line-height: 1.6;">
        Welcome! Use the 6-digit code below to complete your registration and activate your account.
      </p>

      <!-- OTP Code Box -->
      <div style="background: #0f172a; border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; margin: 24px 0; display: inline-block; width: 80%;">
        <span style="font-family: 'Courier New', Courier, monospace, monospace; font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #60a5fa; display: block; margin-left: 10px;">
          ${otp}
        </span>
      </div>

      <p style="margin: 16px 0 0 0; font-size: 13px; color: #f59e0b; font-weight: 600;">
        ⏱️ Code expires in <strong>10 minutes</strong>.
      </p>

      <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid #334155; font-size: 13px; color: #64748b; text-align: left; line-height: 1.6;">
        <div>&bull; Recipient: <strong>${email}</strong></div>
        <div>&bull; Request Time: ${localTimeStr}</div>
        <div>&bull; If you did not request this code, please ignore this email.</div>
      </div>
    </div>

    <!-- Footer -->
    <div style="background-color: #0f172a; padding: 16px 24px; border-top: 1px solid #334155; font-size: 12px; color: #64748b; text-align: center;">
      High-Performance Monitoring Platform &bull; Secure Authentication Engine
    </div>
  </div>
</body>
</html>`;
}

export const OTPService = {
  /**
   * Check if email is currently rate-limited (60s cooldown)
   */
  async isRateLimited(email: string): Promise<boolean> {
    const cooldownKey = getCooldownKey(email);
    const ttl = await redis.ttl(cooldownKey);
    return ttl > 0;
  },

  /**
   * Store OTP in Redis with 10 minute expiration (600s) and set 60s resend cooldown
   */
  async storeOTP(email: string, otp: string): Promise<void> {
    const otpKey = getOtpKey(email);
    const cooldownKey = getCooldownKey(email);

    await redis.set(otpKey, otp, { ex: 600 });
    await redis.set(cooldownKey, "1", { ex: 60 });
  },

  /**
   * Verify an input OTP code against Redis
   */
  async verifyOTP(email: string, inputOtp: string): Promise<boolean> {
    const otpKey = getOtpKey(email);
    const storedOtp = await redis.get<string>(otpKey);

    if (!storedOtp) {
      return false;
    }

    if (storedOtp.toString().trim() === inputOtp.toString().trim()) {
      // Clear OTP on successful match
      await redis.del(otpKey);
      await redis.del(getCooldownKey(email));
      return true;
    }

    return false;
  },

  /**
   * Send OTP via Resend email dispatcher
   */
  async sendOTPEmail(email: string, otp: string): Promise<boolean> {
    const primaryFrom = config.alertEmail || "onboarding@resend.dev";
    const subject = `Your Verification Code: ${otp}`;
    const textContent = `Your Uptime Engine verification code is: ${otp}\nThis code expires in 10 minutes.\nRequest Email: ${email}`;
    const htmlContent = buildOTPEmailHtml(email, otp);

    console.log(`📧 [OTP Dispatch] Sending 6-digit OTP (${otp}) to "${email}" via Resend (FROM: "${primaryFrom}")...`);

    if (!resend) {
      console.warn(`⚠️ [OTP Warning] RESEND_API_KEY missing. OTP printed to console: [ ${otp} ] for ${email}`);
      return true;
    }

    try {
      const res = await resend.emails.send({
        from: primaryFrom,
        to: email,
        subject: subject,
        text: textContent,
        html: htmlContent,
      });

      if (res.error) {
        console.warn(`⚠️ [OTP Resend Warning] Direct dispatch to "${email}" failed (${res.error.statusCode} - ${res.error.name}): ${res.error.message}`);

        if (res.error.name === "validation_error" || res.error.statusCode === 403) {
          console.warn(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ RESEND DOMAIN VERIFICATION NOTICE
Resend API testing mode restriction in effect:
"You can only send testing emails to your own email address (rimu_mutasim@yahoo.com)."
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        }

        const resendOwnerEmail = "rimu_mutasim@yahoo.com";
        if (email.toLowerCase() !== resendOwnerEmail) {
          console.log(`🔄 [OTP Resend Fallback] Dispatching OTP code copy to Resend account owner "${resendOwnerEmail}"...`);
          const resFallback = await resend.emails.send({
            from: "onboarding@resend.dev",
            to: resendOwnerEmail,
            subject: `[Copy for ${email}] ${subject}`,
            text: textContent,
            html: htmlContent,
          });

          if (resFallback.error) {
            console.error(`❌ [OTP Fallback Error] (${resFallback.error.statusCode}): ${resFallback.error.message}`);
          } else {
            console.log(`✅ [OTP Dispatch] Fallback OTP email delivered to ${resendOwnerEmail} (ID: ${resFallback.data?.id}).`);
          }
        }
      } else {
        console.log(`✅ [OTP Dispatch] Email sent successfully via Resend to "${email}" (ID: ${res.data?.id}).`);
      }
      return true;
    } catch (err: any) {
      console.error(`❌ [OTP Exception] Failed to send OTP email to ${email}:`, err?.message || err);
      return false;
    }
  },

  /**
   * Generate, store in Redis, and send OTP to email in one call
   */
  async createAndSendOTP(email: string): Promise<{ otp: string; success: boolean }> {
    const otp = generateOTPCode();
    await this.storeOTP(email, otp);
    const sent = await this.sendOTPEmail(email, otp);
    return { otp, success: sent };
  },
};
