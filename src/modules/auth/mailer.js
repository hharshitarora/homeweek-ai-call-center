import nodemailer from "nodemailer";
import "dotenv/config";

const GMAIL_USER = (process.env.GMAIL_USER || "").trim();
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

let gmailTransporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  gmailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
}

export { gmailTransporter };

export const OTP_HTML = (otp) =>
  \`<p>Your one-time login code is: <strong>\${otp}</strong></p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>\`;

export async function sendOtpEmail(to, otp) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM = (process.env.RESEND_FROM || "Homeseek Command Center <onboarding@resend.dev>").trim();
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const SENDGRID_FROM = (process.env.SENDGRID_FROM || "").trim();

  if (SENDGRID_API_KEY && SENDGRID_FROM) {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${SENDGRID_API_KEY}\`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: (() => {
          const m = SENDGRID_FROM.match(/^(.+?)\\s*<([^>]+)>$/);
          return m ? { name: m[1].trim(), email: m[2].trim() } : { name: "Homeseek", email: SENDGRID_FROM };
        })(),
        subject: "Your Homeseek Command Center login code",
        content: [{ type: "text/html", value: OTP_HTML(otp) }],
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      console.error("SendGrid API error:", res.status, bodyText);
      throw new Error(\`SendGrid \${res.status}: \${bodyText.slice(0, 200)}\`);
    }
    return;
  }

  if (gmailTransporter) {
    try {
      await gmailTransporter.sendMail({
        from: GMAIL_USER,
        to,
        subject: "Your Homeseek Command Center login code",
        html: OTP_HTML(otp),
      });
    } catch (err) {
      if (err.code === "ETIMEDOUT" || err.message?.includes("timeout") || err.message?.includes("Connection timeout")) {
        console.error("Gmail SMTP timeout – many clouds block outbound SMTP. Use SendGrid (HTTPS) or Resend with a verified domain instead.");
      }
      throw err;
    }
    return;
  }

  if (RESEND_API_KEY) {
    const from = RESEND_FROM || "Homeseek Command Center <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${RESEND_API_KEY}\`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Your Homeseek Command Center login code",
        html: OTP_HTML(otp),
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      console.error("Resend API error:", res.status, bodyText);
      throw new Error(\`Resend \${res.status}: \${bodyText.slice(0, 200)}\`);
    }
    return;
  }

  throw new Error("No email sender configured.");
}
