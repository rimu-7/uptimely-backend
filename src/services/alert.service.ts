import { redis } from "../config/redis";
import { config } from "../config/env";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { formatLocalWithTimezone } from "../utils/date";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

function buildAlertHtml(
  name: string,
  target: string,
  newStatus: "UP" | "DOWN",
  errorMessage?: string,
  timestampStr?: string,
  localTimeStr?: string
) {
  const isUp = newStatus === "UP";
  const headerBg = isUp
    ? "linear-gradient(135deg, #059669 0%, #10b981 100%)"
    : "linear-gradient(135deg, #dc2626 0%, #ef4444 100%)";
  const badgeBg = isUp ? "#d1fae5" : "#fee2e2";
  const badgeColor = isUp ? "#065f46" : "#991b1b";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alert: ${name} is ${newStatus}</title>
</head>
<body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1); border: 1px solid #e2e8f0;">
    
    <!-- Header Banner -->
    <div style="background: ${headerBg}; padding: 32px 24px; text-align: center; color: #ffffff;">
      <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; opacity: 0.9; margin-bottom: 8px;">
        ${isUp ? "✅ Incident Resolved" : "🚨 Service Outage Detected"}
      </div>
      <h1 style="margin: 0; font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">
        "${name}" is ${newStatus}
      </h1>
    </div>

    <!-- Main Content -->
    <div style="padding: 28px 24px;">
      <div style="margin-bottom: 24px; display: inline-block; background: ${badgeBg}; color: ${badgeColor}; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 13px; letter-spacing: 0.5px;">
        CURRENT STATUS: ${newStatus}
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px;">
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 12px 0; color: #64748b; font-weight: 500; width: 35%;">Resource Name:</td>
          <td style="padding: 12px 0; color: #0f172a; font-weight: 700;">${name}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 12px 0; color: #64748b; font-weight: 500;">Target Endpoint:</td>
          <td style="padding: 12px 0; color: #2563eb; font-weight: 600; word-break: break-all;">${target}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 12px 0; color: #64748b; font-weight: 500;">Local Event Time:</td>
          <td style="padding: 12px 0; color: #0f172a; font-weight: 600;">${localTimeStr || formatLocalWithTimezone()}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 12px 0; color: #64748b; font-weight: 500;">UTC Timestamp:</td>
          <td style="padding: 12px 0; color: #64748b; font-family: monospace; font-size: 13px;">${timestampStr || new Date().toISOString()}</td>
        </tr>
        ${
          errorMessage
            ? `
        <tr>
          <td style="padding: 12px 0; color: #64748b; font-weight: 500; vertical-align: top;">Failure Reason:</td>
          <td style="padding: 12px 0; color: #dc2626; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.5;">${errorMessage}</td>
        </tr>`
            : ""
        }
      </table>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; padding: 18px 24px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; font-weight: 500;">
      Uptime Monitoring System &bull; Resend Dispatcher &bull; High Availability Engine
    </div>
  </div>
</body>
</html>`;
}

export async function dispatchAlert(
  resourceId: string,
  name: string,
  url: string,
  newStatus: "UP" | "DOWN",
  errorMessage?: string,
  userId?: string
) {
  const localTimeStr = formatLocalWithTimezone();
  const isoTime = new Date().toISOString();
  console.log(`\n🔔 [ALERT DISPATCH] ${localTimeStr} - "${name}" (${url}) transitioned to ${newStatus}`);

  // Anti-flapping: Maximum 3 state changes per 10-minute window
  const flapKey = `flapping:${resourceId}`;
  const changeCount = await redis.incr(flapKey);
  if (changeCount === 1) await redis.expire(flapKey, 600);

  if (changeCount > 3) {
    console.warn(`⚠️ [FLAPPING SUPPRESSED] "${name}" changed state ${changeCount} times in 10m. Suppressing notifications.`);
    return;
  }

  // Resolve target user email from database if userId is provided
  let targetUserEmail = config.alertToEmail;
  if (userId) {
    try {
      const [user] = await db
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (user?.email) {
        targetUserEmail = user.email;
        console.log(`👤 [User Email Resolved] Found registered user email "${targetUserEmail}" for User ID "${userId}"`);
      }
    } catch (err) {
      console.warn(`⚠️ [DB User Lookup Warning] Failed to fetch user email for ID "${userId}":`, err);
    }
  }

  const payload = {
    title: `Alert: ${name} is ${newStatus}`,
    description: `Resource: ${name}\nURL/Slug: ${url}\nStatus: ${newStatus}\nLocal Time: ${localTimeStr}\nUTC Time: ${isoTime}${errorMessage ? `\nError: ${errorMessage}` : ""}`,
    color: newStatus === "UP" ? 3066993 : 15158332,
    html: buildAlertHtml(name, url, newStatus, errorMessage, isoTime, localTimeStr),
  };

  // 1. Discord Webhook Dispatcher
  if (config.discordWebhook) {
    console.log(`📡 [Discord Alert] Sending webhook notification...`);
    await fetch(config.discordWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{ title: payload.title, description: payload.description, color: payload.color }],
      }),
    })
      .then(() => console.log(`✅ [Discord Alert] Webhook sent successfully.`))
      .catch((err) => console.error("❌ [Discord Alert Error]", err.message || err));
  }

  // 2. Resend Email Dispatcher
  if (resend && targetUserEmail) {
    const primaryFrom = config.alertEmail || "onboarding@resend.dev";

    console.log(`📧 [Email Alert] Sending email via Resend FROM: "${primaryFrom}" TO: "${targetUserEmail}"...`);

    const res = await resend.emails.send({
      from: primaryFrom,
      to: targetUserEmail,
      subject: payload.title,
      text: payload.description,
      html: payload.html,
    });

    if (res.error) {
      console.warn(`⚠️ [Resend Warning] Direct dispatch to "${targetUserEmail}" failed (${res.error.statusCode} - ${res.error.name}): ${res.error.message}`);

      if (res.error.name === "validation_error" || res.error.statusCode === 403) {
        console.warn(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ RESEND DOMAIN VERIFICATION REQUIRED FOR RECIPIENT: "${targetUserEmail}"
Resend API restriction in effect:
"You can only send testing emails to your own email address (rimu_mutasim@yahoo.com).
To send emails to other recipients (e.g. ${targetUserEmail}), please verify a domain
at https://resend.com/domains, and change ALERT_FROM_EMAIL to use that domain."
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      }

      const resendOwnerEmail = "rimu_mutasim@yahoo.com";
      if (targetUserEmail !== resendOwnerEmail) {
        console.log(`🔄 [Resend Owner Fallback] Dispatching alert copy to Resend account owner "${resendOwnerEmail}"...`);

        const resFallback = await resend.emails.send({
          from: "onboarding@resend.dev",
          to: resendOwnerEmail,
          subject: payload.title,
          text: payload.description,
          html: payload.html,
        });

        if (resFallback.error) {
          console.error(`❌ [Resend Fallback Error] (${resFallback.error.statusCode}): ${resFallback.error.message}`);
        } else {
          console.log(`✅ [Email Alert] Fallback email delivered successfully to ${resendOwnerEmail} (ID: ${resFallback.data?.id}).`);
        }
      }
    } else {
      console.log(`✅ [Email Alert] Email sent successfully via Resend to user "${targetUserEmail}" (ID: ${res.data?.id}).`);
    }
  } else {
    console.warn(`⚠️ [Email Alert] Resend email dispatch skipped. (API Key: ${config.resendApiKey ? "Present" : "Missing"}, Recipient: ${targetUserEmail || "Missing"})`);
  }
}
