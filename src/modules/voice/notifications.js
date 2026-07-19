import "dotenv/config";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const SENIOR_AGENT_WHATSAPP = process.env.SENIOR_AGENT_WHATSAPP;

const whatsappNotifiedToday = new Map();

export async function sendWhatsAppHotLeadAlert({ leadName, phoneE164, propertyName, callSummary }) {
  try {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !SENIOR_AGENT_WHATSAPP) return;

    const today = new Date().toISOString().split("T")[0];
    const dedupeKey = phoneE164 || "unknown";
    
    if (whatsappNotifiedToday.get(dedupeKey) === today) return;

    const message = \`🔥 Hot Lead Alert\nName: \${leadName || "Unknown"}\nPhone: \${phoneE164 || "N/A"}\nProject: \${propertyName || "Tulip Monsella"}\nSummary: \${callSummary || "No summary available"}\nNext step: Follow-up recommended\`;

    const twilioUrl = \`https://api.twilio.com/2010-4-01/Accounts/\${TWILIO_ACCOUNT_SID}/Messages.json\`;
    const auth = Buffer.from(\`\${TWILIO_ACCOUNT_SID}:\${TWILIO_AUTH_TOKEN}\`).toString("base64");

    const formData = new URLSearchParams();
    formData.append("From", TWILIO_WHATSAPP_FROM);
    formData.append("To", SENIOR_AGENT_WHATSAPP);
    formData.append("Body", message);

    const resp = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": \`Basic \${auth}\`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (resp.ok) {
      whatsappNotifiedToday.set(dedupeKey, today);
      console.log(\`WhatsApp alert sent for lead: \${dedupeKey}\`);
    }
  } catch (err) {
    console.error(\`WhatsApp notification error: \${err.message || err}\`);
  }
}

export function cleanupWhatsAppDedupeMap() {
  const today = new Date().toISOString().split("T")[0];
  for (const [key, date] of whatsappNotifiedToday.entries()) {
    if (date !== today) whatsappNotifiedToday.delete(key);
  }
}

setInterval(cleanupWhatsAppDedupeMap, 60 * 60 * 1000);
