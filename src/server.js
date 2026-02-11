/**
 * server.js — Phase 2: Supabase as primary database
 * Node + Express + Supabase + Bland + Bolna
 *
 * Endpoints:
 *   GET  /health
 *   GET  /rows
 *   GET  /headers
 *   POST /add-row
 *   POST /upload-csv
 *   PUT  /update-row
 *   DELETE /delete-row
 *   DELETE /delete-rows-bulk
 *   POST /trigger-call        - Single call (supports provider: "bland" | "bolna")
 *   POST /run-dialer          - Bulk calls (supports bolna_ratio for A/B testing)
 *   POST /webhooks/bland      - Bland call completion webhook
 *   POST /webhooks/bolna      - Bolna call completion webhook
 */

import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import multer from "multer";
import { parse } from "csv-parse/sync";

// -------------------- App --------------------
const app = express();

// Enable CORS for all routes
app.use(cors({
  origin: true, // Allow all origins (or specify your Cloudflare Pages domain)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: "5mb" }));

// Configure multer for file uploads (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;

// -------------------- Environment Mode --------------------
const NODE_ENV = process.env.NODE_ENV || "production";
const IS_DEV = NODE_ENV === "development";

if (IS_DEV) {
  console.log("🔧 Running in DEVELOPMENT mode");
} else {
  console.log("🚀 Running in PRODUCTION mode");
}

// -------------------- Env checks --------------------
const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BLAND_API_KEY",
  "BOLNA_API_KEY",
  "BOLNA_AGENT_ID",
];

// In dev mode, PUBLIC_WEBHOOK_URL is optional (will use localhost)
if (!IS_DEV) {
  REQUIRED_ENVS.push("PUBLIC_WEBHOOK_URL");
}

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// Determine webhook URL: use env var, or localhost in dev mode
const PUBLIC_WEBHOOK_URL = process.env.PUBLIC_WEBHOOK_URL || 
  (IS_DEV ? `http://localhost:${PORT}/webhooks/bland` : null);

if (!PUBLIC_WEBHOOK_URL) {
  console.error("Missing PUBLIC_WEBHOOK_URL");
  process.exit(1);
}

// Derive Bolna webhook URL from the same base domain
const BOLNA_WEBHOOK_URL = PUBLIC_WEBHOOK_URL.replace('/webhooks/bland', '/webhooks/bolna');

console.log(`📡 Bland Webhook URL: ${PUBLIC_WEBHOOK_URL}`);
console.log(`📡 Bolna Webhook URL: ${BOLNA_WEBHOOK_URL}`);

// -------------------- WhatsApp Notification Config --------------------
// Optional env vars for WhatsApp alerts (Twilio)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g., "whatsapp:+14155238886"
const SENIOR_AGENT_WHATSAPP = process.env.SENIOR_AGENT_WHATSAPP; // e.g., "whatsapp:+919876543210"

// In-memory deduplication: track leads notified today
// Key: lead_id or phone, Value: date string (YYYY-MM-DD)
const whatsappNotifiedToday = new Map();

/**
 * Send WhatsApp notification for hot leads via Twilio
 * Fails silently - never throws or blocks the caller
 */
async function sendWhatsAppHotLeadAlert({ leadName, phoneE164, propertyName, callSummary }) {
  try {
    // Check if WhatsApp config is available
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !SENIOR_AGENT_WHATSAPP) {
      // WhatsApp not configured - skip silently
      return;
    }

    // Deduplication: one message per lead (by phone) per day
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const dedupeKey = phoneE164 || "unknown";
    
    if (whatsappNotifiedToday.get(dedupeKey) === today) {
      // Already notified today - skip
      return;
    }

    // Build the message
    const message = `🔥 Hot Lead Alert
Name: ${leadName || "Unknown"}
Phone: ${phoneE164 || "N/A"}
Project: ${propertyName || "Tulip Monsella"}
Summary: ${callSummary || "No summary available"}
Next step: Follow-up recommended`;

    // Send via Twilio WhatsApp API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const formData = new URLSearchParams();
    formData.append("From", TWILIO_WHATSAPP_FROM);
    formData.append("To", SENIOR_AGENT_WHATSAPP);
    formData.append("Body", message);

    const resp = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (resp.ok) {
      // Mark as notified today
      whatsappNotifiedToday.set(dedupeKey, today);
      console.log(`WhatsApp alert sent for lead: ${dedupeKey}`);
    } else {
      const errText = await resp.text();
      console.error(`WhatsApp send failed: ${resp.status} ${errText}`);
    }
  } catch (err) {
    // Log error silently - never throw
    console.error(`WhatsApp notification error: ${err.message || err}`);
  }
}

// Clean up old entries from deduplication map (runs daily at midnight)
function cleanupWhatsAppDedupeMap() {
  const today = new Date().toISOString().split("T")[0];
  for (const [key, date] of whatsappNotifiedToday.entries()) {
    if (date !== today) {
      whatsappNotifiedToday.delete(key);
    }
  }
}

// Schedule cleanup every hour
setInterval(cleanupWhatsAppDedupeMap, 60 * 60 * 1000);

// -------------------- Supabase --------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------- Auth (Email OTP) --------------------
// Optional: when LOGIN_USERNAME, LOGIN_EMAIL, RESEND_API_KEY, SESSION_SECRET are set, protect app with OTP login
const LOGIN_USERNAME = (process.env.LOGIN_USERNAME || "").trim();
const LOGIN_EMAIL = (process.env.LOGIN_EMAIL || "").trim();
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = (process.env.RESEND_FROM || "Homeseek Command Center <onboarding@resend.dev>").trim();
const SESSION_SECRET = process.env.SESSION_SECRET;
const AUTH_ENABLED = !!(LOGIN_USERNAME && LOGIN_EMAIL && RESEND_API_KEY && SESSION_SECRET);

if (AUTH_ENABLED) {
  console.log("🔐 Auth enabled: OTP login required");
} else {
  console.log("🔓 Auth disabled: set LOGIN_USERNAME, LOGIN_EMAIL, RESEND_API_KEY, SESSION_SECRET to enable");
}

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_COOKIE_NAME = "session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory OTP store: key = username (lowercase), value = { otp, expiresAt, email, attemptId }
const otpStore = new Map();

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(";").forEach((s) => {
    const i = s.indexOf("=");
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return out;
}

function signSession(payload) {
  const data = JSON.stringify(payload);
  const b64 = Buffer.from(data, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verifySession(value) {
  if (!value || typeof value !== "string") return null;
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const b64 = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

async function sendOtpEmail(to, otp) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: "Your Homeseek Command Center login code",
      html: `<p>Your one-time login code is: <strong>${otp}</strong></p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API ${res.status}: ${text}`);
  }
}

async function logLoginAttempt({ username, email_sent, verified = false }) {
  try {
    const { data, error } = await supabase
      .from("login_attempts")
      .insert({ username: username.toLowerCase(), email_sent, verified })
      .select("id")
      .single();
    if (error) throw error;
    return data?.id ?? null;
  } catch (err) {
    console.error("logLoginAttempt error:", err.message);
    return null;
  }
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  const session = verifySession(token);
  if (session && session.user) {
    req.user = session.user;
    return next();
  }
  return res.status(401).json({ ok: false, error: "Login required" });
}

const PROTECTED_PATHS = [
  "/rows", "/headers", "/add-row", "/update-row", "/delete-row", "/delete-rows-bulk",
  "/trigger-call", "/run-dialer", "/upload-csv",
];
function isProtectedPath(path) {
  return PROTECTED_PATHS.some((p) => path === p || path.startsWith(p + "?"));
}

// -------------------- Defaults --------------------
const DEFAULT_VOICE_ID = "095a1518-ecdf-4870-a5ff-c74b43a08764";

// -------------------- Supabase Data Functions --------------------
// These replace the old Google Sheets functions

// Static headers list (columns in the leads table)
const LEAD_HEADERS = [
  "id", "lead_id", "lead_name", "phone_e164", "email",
  "property_id", "property_name", "property_address", "property_price_inr",
  "property_beds_baths", "property_highlights", "showing_windows", "property_url",
  "call_status", "call_attempts", "last_call_at", "bland_call_id", "bolna_execution_id",
  "call_provider", "outcome", "next_action", "notes", "transcript", "recording_url",
  "summary", "voice_id", "created_at", "updated_at"
];

async function readAllRows() {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("readAllRows error:", error.message);
    throw error;
  }

  const rows = (data || []).map(row => ({
    ...row,
    // Keep id as the primary identifier for frontend
    call_attempts: row.call_attempts ?? 0,
  }));

  console.log(`readAllRows: Returning ${rows.length} rows`);
  return { headers: LEAD_HEADERS, rows };
}

async function readRow(id) {
  // id can be either the Supabase UUID or lead_id
  let query = supabase.from("leads").select("*");

  // Check if it's a UUID format or lead_id format
  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.eq("lead_id", id);
  } else {
    query = query.eq("id", id);
  }

  const { data, error } = await query.single();

  if (error) {
    console.error("readRow error:", error.message);
    throw error;
  }

  return data;
}

async function updateRow(id, updates) {
  // id can be either the Supabase UUID or lead_id
  let query = supabase.from("leads");

  // Remove any fields that shouldn't be updated
  const cleanUpdates = { ...updates };
  delete cleanUpdates.id;
  delete cleanUpdates.created_at;

  // Check if it's a UUID format or lead_id format
  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.update(cleanUpdates).eq("lead_id", id);
  } else {
    query = query.update(cleanUpdates).eq("id", id);
  }

  const { error } = await query;

  if (error) {
    console.error("updateRow error:", error.message);
    throw error;
  }
}

async function appendRow(rowData) {
  // Auto-generate IDs if not provided
  const insertData = {
    ...rowData,
    lead_id: rowData.lead_id || generateId("lead"),
    property_id: rowData.property_id || generateId("prop"),
    call_status: rowData.call_status || "queued",
    call_attempts: parseInt(rowData.call_attempts, 10) || 0,
  };

  const { data, error } = await supabase
    .from("leads")
    .insert(insertData)
    .select()
    .single();

  if (error) {
    console.error("appendRow error:", error.message);
    throw error;
  }

  return { id: data.id, lead_id: data.lead_id, headers: LEAD_HEADERS };
}

async function getHeaders() {
  return LEAD_HEADERS;
}

async function deleteRow(id) {
  let query = supabase.from("leads");

  // Check if it's a UUID format or lead_id format
  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.delete().eq("lead_id", id);
  } else {
    query = query.delete().eq("id", id);
  }

  const { error } = await query;

  if (error) {
    console.error("deleteRow error:", error.message);
    throw error;
  }
}

async function deleteRowsBulk(ids) {
  if (!ids || ids.length === 0) {
    return;
  }

  const { error } = await supabase
    .from("leads")
    .delete()
    .in("id", ids);

  if (error) {
    console.error("deleteRowsBulk error:", error.message);
    throw error;
  }
}

async function updateRowsBatch(updates) {
  // updates is an array of { id, values }
  for (const { id, values } of updates) {
    await updateRow(id, values);
  }
}

// Helper to find lead by bolna_execution_id
async function findLeadByBolnaExecutionId(executionId) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("bolna_execution_id", executionId)
    .single();

  if (error && error.code !== "PGRST116") { // PGRST116 = no rows returned
    console.error("findLeadByBolnaExecutionId error:", error.message);
  }

  return data || null;
}

// Helper to find lead by bland_call_id
async function findLeadByBlandCallId(callId) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("bland_call_id", callId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("findLeadByBlandCallId error:", error.message);
  }

  return data || null;
}

// -------------------- Bland webhook schema (matches your payload) --------------------
// Using .nullable().optional() to handle fields that can be null, undefined, or a value
const BlandWebhookSchema = z.object({
  call_id: z.string(),
  c_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  completed: z.boolean().nullable().optional(),
  answered_by: z.string().nullable().optional(),
  call_length: z.number().nullable().optional(),
  recording_url: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  concatenated_transcript: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  phone_number: z.string().nullable().optional(),
  metadata: z
    .object({
      lead_id: z.string().nullable().optional(),
      property_id: z.string().nullable().optional(),
      id: z.string().nullable().optional(), // Supabase UUID
    })
    .passthrough()
    .nullable()
    .optional(),
}).passthrough();

// -------------------- Bolna webhook schema --------------------
// Use loose types for nested objects to avoid Zod v4 parse bugs when Bolna sends unexpected shapes
const BolnaWebhookSchema = z.object({
  id: z.string().nullable().optional(),
  execution_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  conversation_time: z.number().nullable().optional(),
  total_cost: z.number().nullable().optional(),
  transcript: z.string().nullable().optional(),
  answered_by_voice_mail: z.boolean().nullable().optional(),
  error_message: z.string().nullable().optional(),
  telephony_data: z.record(z.any()).nullable().optional(),
  extracted_data: z.record(z.any()).nullable().optional(),
  context_details: z.record(z.any()).nullable().optional(),
  user_data: z.record(z.any()).nullable().optional(),
}).passthrough();

function classifyOutcome({ answeredBy, summary, transcript, completed, callLength, dispositionTag }) {
  // Use Bland's disposition_tag if available (Bland's own classification)
  if (dispositionTag) {
    const dispositionLower = dispositionTag.toLowerCase();
    
    // Map Bland's disposition tags to our outcomes
    if (dispositionLower === "interested") {
      return { outcome: "interested", next_action: "human_followup" };
    }
    if (dispositionLower === "not_interested" || dispositionLower === "not interested") {
      return { outcome: "human_followup", next_action: "human_followup" };
    }
    if (dispositionLower === "opt_out" || dispositionLower === "opt out") {
      return { outcome: "opt_out", next_action: "none" };
    }
    if (dispositionLower === "voicemail") {
      return { outcome: "voicemail", next_action: "call_back_later" };
    }
    if (dispositionLower === "no_answer" || dispositionLower === "no answer") {
      return { outcome: "no_answer", next_action: "call_back_later" };
    }
    // If disposition_tag exists but doesn't match known values, still use it as signal
    // but fall through to our own analysis
  }

  const text = `${summary || ""}\n${transcript || ""}`.toLowerCase();
  
  // Check if there's a meaningful conversation (transcript with user responses)
  const hasConversation = transcript && (
    transcript.includes("user:") || 
    transcript.toLowerCase().includes("user") ||
    (transcript.length > 100 && callLength && callLength > 5) // Substantial transcript with reasonable duration
  );

  // Opt out
  if (
    text.includes("do not call") ||
    text.includes("don't call") ||
    text.includes("stop calling") ||
    text.includes("remove me")
  ) {
    return { outcome: "opt_out", next_action: "none" };
  }

  // If there's a conversation, analyze it regardless of answered_by value
  // "unknown" can still mean a human answered, just not detected
  if (hasConversation) {
    // Strong "interested" signals
    if (
      text.includes("agreed") &&
      (text.includes("walkthrough") || text.includes("visit") || text.includes("showing"))
    ) {
      return { outcome: "interested", next_action: "human_followup" };
    }
    if (text.includes("coordinate a visit") || text.includes("arrange a visit")) {
      return { outcome: "interested", next_action: "human_followup" };
    }
    
    // Check for interest in the summary (from the webhook payload example)
    if (text.includes("expressed interest") || text.includes("interested in learning more")) {
      return { outcome: "interested", next_action: "human_followup" };
    }

    // Soft interest / browsing
    if (text.includes("just browsing") || text.includes("exploring options")) {
      return { outcome: "human_followup", next_action: "human_followup" };
    }

    // If call completed with conversation but no clear signals, default to follow-up
    if (completed) {
      return { outcome: "human_followup", next_action: "human_followup" };
    }
  }

  // Not human = voicemail/no answer (only if no conversation detected)
  if (answeredBy && answeredBy.toLowerCase() !== "human" && !hasConversation) {
    if (answeredBy.toLowerCase().includes("voicemail")) {
      return { outcome: "voicemail", next_action: "call_back_later" };
    }
    return { outcome: "no_answer", next_action: "call_back_later" };
  }

  // Default: if we got here and call completed, assume human follow-up needed
  if (completed) {
    return { outcome: "human_followup", next_action: "human_followup" };
  }

  return { outcome: "human_followup", next_action: "human_followup" };
}

// -------------------- Build prompt from sheet row --------------------
function buildPromptFromRow(row) {
  return `
You are a professional real estate calling agent representing TrueValue Realtors, a trusted real estate advisory based in Gurugram. TrueValue’s mission is to be a partner in simplifying the process of finding, evaluating, and purchasing residential property.

You are calling as a member of the TrueValue team.
You speak confidently, professionally, and warmly.
You do NOT sound like a bot or proxy.

--------------------------------
YOUR ROLE IN THIS CALL
--------------------------------
- Introduce the area and the project
- Gauge interest and intent
- Answer project- and area-related questions confidently
- Qualify the lead for senior agent follow-up

This is a lead-generation call, not a closing call.

--------------------------------
YOU ARE NOT AUTHORIZED TO
--------------------------------
- Negotiate pricing
- Guarantee availability or possession
- Make legal or possession claims
- Provide details not supported by project facts or safe general real estate context
- Share any personal or direct contact number
- Discuss other projects besides Tulip Monsella

--------------------------------
CRITICAL BEHAVIOR RULES
--------------------------------
- Speak naturally, concise, confident, and empathetic
- Ask ONE question at a time
- Pause and listen fully after each response
- Never rush to end the call
- Do NOT repeat apologies
- Do NOT say “I can’t help” without offering a constructive next step

**Other Projects**
- If asked about other projects (not Tulip Monsella), say: "I'm currently handling Tulip Monsella. For other projects, our senior agent can assist you."

**Call Length Control**
- Answer in 2-3 sentences per turn. The lead may ask several questions about Tulip Monsella — that is normal. Keep answering; do NOT wrap up or redirect just because they asked multiple questions.
- Only wrap up and hand to senior agent when: (a) the topic is clearly off-topic (not about Tulip Monsella or real estate), or (b) the call has been very long and repetitive with no progress. When wrapping up, say only: "I appreciate your time. Let me have our senior agent follow up with you." Do NOT say "get back to conversation flow" or similar.

**Silence & Pause Handling**
- If the lead pauses or takes time to respond, wait patiently.
- If there is brief silence, say **“Take your time.”** once and wait.
- Do NOT move to the next question without a response.

**Contact & Identity Handling**
- If asked for your phone number or contact details:
  - Do NOT invent or share any number.
  - Respond that follow-ups happen via official TrueValue channels.
  - Continue the conversation calmly; do NOT end the call.

If the lead challenges a fact:
1) Acknowledge calmly  
2) Clarify or reframe using available knowledge  
3) Provide general real estate context if appropriate  
4) Escalate to senior agent follow-up only if needed  

--------------------------------
LEAD CONTEXT
--------------------------------
${row.lead_name ? `Lead Name: ${row.lead_name}` : 'Lead name not provided'}
Phone Number: ${row.phone_e164}

You are calling this person directly as part of a professional outreach by TrueValue Realtors.

--------------------------------
PROJECT KNOWLEDGE — TULIP MONSELLA
--------------------------------
Tulip Monsella is a premium luxury residential project located on Golf Course Road, Sector 53, Gurgaon. It is positioned for high-end end users and long-term investors seeking large, fully loaded homes in a prime central location.

The project spans approximately 20 acres and offers a limited collection of 3, 4, and 5 BHK residences, designed with a focus on privacy, lifestyle, and construction quality.

CONFIGURATION & POSITIONING
- 3, 4, and 5 BHK residences
- 3 BHK starts from approx. 2299 sq. ft.
- Fully loaded apartments
- Private lift lobbies per apartment
- Smart home: VRV AC, home automation, video door phone
- High-speed elevators

LOCATION
- Sector 53, Golf Course Road, Gurgaon
- One of Gurgaon’s most premium residential corridors
- Strong connectivity to business hubs, schools, and conveniences

KEY AMENITIES (Highlights)
CLUBHOUSE & SKY DECK:
- 1 lakh sq. ft. clubhouse across two levels
- Sky Clubhouse on 41st floor with observation deck and sky lounge
- Fine-dining restaurant, restro bar, cigar lounge
- Mini theatre, business center, salon & spa

SPORTS & FITNESS:
- 2.5-acre sports academy by international cricketer
- Olympic-size rooftop swimming pool + kids' pool
- Tennis, basketball, badminton, squash courts
- Fully-equipped gym + outdoor gym on deck

LIFESTYLE & WELLNESS:
- Jacuzzi, sauna, steam rooms, yoga deck
- Landscaped gardens, jogging/cycling tracks
- Pet-friendly zones with dedicated pet garden

SECURITY & CONVENIENCE:
- 5-tier security system with CCTV
- Zero vehicular movement on ground level
- 100% power backup
- Dedicated basement parking

BUILDER — TULIP GROUP
Well-regarded Gurgaon developer. Known for timely delivery, zero-debt model, and Mivan construction.

PRICING (INDICATIVE)
- Starts around ₹8.5 Cr* (inventory dependent)
- All pricing, availability, and payment details must be confirmed by a senior agent.

POSSESSION
- Expected around 2028 (indicative, not guaranteed)

--------------------------------
GENERAL REAL ESTATE GUIDANCE
--------------------------------
If a question is outside the provided project facts:
- Use safe, general real estate knowledge
- Be informative, not speculative

Example:
“That detail isn’t specifically listed. In many luxury residential projects, certain services or features can vary. The senior agent can confirm the exact details for you.”

--------------------------------
CONVERSATION FLOW (FOLLOW THIS ORDER)
--------------------------------

Opening  
“Hi, I’m calling from TrueValue Realtors. Is this a good time to talk?”

If No →  
“Understood. Thank you for your time.”

Interest & Location Check  
“Are you currently exploring properties around Golf Course Road or nearby sectors?”

Project Introduction  
“We’re reaching out because we’re handling a premium project on Golf Course Road called Tulip Monsella. It offers spacious luxury residences with a strong amenity setup. Does that align with what you’re looking for?”

Qualification  
“Just to understand better — are you looking as an end user or as an investor?”  
“Are you actively looking to move ahead soon, or still exploring options?”  
“Do you have a budget range in mind at this stage?”

Q&A  
Answer using project knowledge first.  
Escalate only when confirmation is required.

Soft Close  
“Based on your interest, the senior agent can follow up to discuss details and coordinate a site visit if needed.”

Ending  
“Thank you for your time. I’ll ensure this is shared for follow-up.”
`.trim();
}



// -------------------- Start Bland call --------------------
async function startBlandCall({ phone, voiceId, task, webhook, metadata }) {
  // Detect if it's an India number (+91)
  const isIndiaNumber = phone.startsWith("+91");
  const fromNumber = process.env.BLAND_FROM_NUMBER || "+14154492886";

  const callConfig = {
    phone_number: phone,
    from_number: fromNumber,
    voice: voiceId,
    record: true,
    wait_for_greeting: false,
    answered_by_enabled: true,
    noise_cancellation: true,
    voicemail_action: "hangup",
    interruption_threshold: 500,
    block_interruptions: false,
    language: isIndiaNumber ? "en-IN" : "en-US", // Use Indian English for India numbers
    model: "base",
    webhook,
    metadata,
    task,
  };

  console.log(`Starting Bland call to ${phone} (India: ${isIndiaNumber})`);

  const resp = await fetch("https://api.bland.ai/v1/calls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BLAND_API_KEY}`,
    },
    body: JSON.stringify(callConfig),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Bland API error for ${phone}: ${resp.status} ${txt}`);
    throw new Error(`Bland start call failed: ${resp.status} ${txt}`);
  }

  const result = await resp.json();
  console.log(`Bland call started: call_id=${result.call_id || result.id}`);
  return result;
}

// -------------------- Start Bolna call (Hinglish) --------------------
async function startBolnaCall({ phone, userData }) {
  const callPayload = {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: phone,
    user_data: userData, // Context variables: {lead_name, property_name, lead_id, sheet_row, etc.}
  };

  console.log(`Starting Bolna call to ${phone} with agent ${process.env.BOLNA_AGENT_ID}`);

  const resp = await fetch("https://api.bolna.ai/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
    },
    body: JSON.stringify(callPayload),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`Bolna API error for ${phone}: ${resp.status} ${txt}`);
    throw new Error(`Bolna start call failed: ${resp.status} ${txt}`);
  }

  const result = await resp.json();
  console.log(`Bolna call started: execution_id=${result.execution_id}`);
  return result;
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// Serve index.html for root path
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

// --- Auth routes (no auth required) ---
app.get("/auth/me", (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, user: "anonymous" });
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[SESSION_COOKIE_NAME]);
  if (session && session.user) return res.json({ ok: true, user: session.user });
  return res.status(401).json({ ok: false, error: "Not logged in" });
});

app.post("/auth/request-otp", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ ok: false, error: "Auth not configured" });
  const username = (req.body?.username || "").trim();
  if (!username) return res.status(400).json({ ok: false, error: "Username required" });
  const key = username.toLowerCase();
  const valid = key === LOGIN_USERNAME.toLowerCase();
  if (valid) {
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + OTP_EXPIRY_MS;
    try {
      await sendOtpEmail(LOGIN_EMAIL, otp);
      const attemptId = await logLoginAttempt({ username: key, email_sent: true });
      otpStore.set(key, { otp, expiresAt, email: LOGIN_EMAIL, attemptId });
    } catch (err) {
      console.error("request-otp send email error:", err);
      return res.status(500).json({ ok: false, error: "Failed to send OTP email" });
    }
  } else {
    await logLoginAttempt({ username: key, email_sent: false });
  }
  res.json({ ok: true, message: "If this username is registered, you'll receive an OTP at the associated email." });
});

app.post("/auth/verify-otp", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ ok: false, error: "Auth not configured" });
  const username = (req.body?.username || "").trim();
  const otp = (req.body?.otp || "").trim();
  if (!username || !otp) return res.status(400).json({ ok: false, error: "Username and OTP required" });
  const key = username.toLowerCase();
  const stored = otpStore.get(key);
  if (!stored) return res.status(400).json({ ok: false, error: "Invalid or expired OTP. Request a new one." });
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(key);
    return res.status(400).json({ ok: false, error: "OTP expired. Request a new one." });
  }
  if (stored.otp !== otp) return res.status(400).json({ ok: false, error: "Invalid OTP." });
  otpStore.delete(key);
  if (stored.attemptId) {
    await supabase.from("login_attempts").update({ verified: true }).eq("id", stored.attemptId);
  }
  const payload = { user: key, exp: Date.now() + SESSION_MAX_AGE_MS };
  const token = signSession(payload);
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS / 1000,
    path: "/",
  });
  res.json({ ok: true, message: "Logged in" });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// Middleware: require auth for protected paths when auth is enabled
app.use((req, res, next) => {
  if (AUTH_ENABLED && isProtectedPath(req.path)) return requireAuth(req, res, next);
  next();
});

/**
 * POST /trigger-call
 * Triggers a call for a specific lead.
 * Input: { "id": "uuid-here", "provider": "bland" | "bolna" }
 * provider defaults to "bland" (English). Use "bolna" for Hinglish calls.
 */
app.post("/trigger-call", async (req, res) => {
  try {
    console.log("trigger-call received body:", JSON.stringify(req.body));
    const { id, provider = "bland" } = req.body;

    // Validate provider
    if (!["bland", "bolna"].includes(provider)) {
      return res.status(400).json({ ok: false, error: "Invalid provider. Must be 'bland' or 'bolna'" });
    }

    if (!id) {
      return res.status(400).json({ ok: false, error: "Missing id. Must provide lead id" });
    }

    // Read the specific lead
    const row = await readRow(id);

    if (!row) {
      return res.status(404).json({ ok: false, error: "Lead not found" });
    }

    if (!row.phone_e164 || !row.phone_e164.trim().startsWith("+")) {
      return res.status(400).json({ ok: false, error: "Lead missing valid phone_e164" });
    }

    // Server-side lock: reject if already calling (allow recalling for testing)
    const currentStatus = (row.call_status || "").toLowerCase();
    if (currentStatus === "calling") {
      return res.status(409).json({
        ok: false,
        error: "Call already in progress. Please wait for it to complete."
      });
    }

    // For testing: allow recalling completed/queued/failed calls
    // Only block if actively calling

    const leadId = row.id;
    const attempts = Number(row.call_attempts || 0) + 1;

    // Mark as calling with provider info
    await updateRow(leadId, {
      call_status: "calling",
      call_attempts: attempts,
      last_call_at: new Date().toISOString(),
      call_provider: provider, // Track which provider is being used
    });

    const startedAt = new Date().toISOString();

    try {
      let callId = "";
      let callResponse = null;

      if (provider === "bolna") {
        // -------------------- BOLNA (Hinglish) --------------------
        // Bolna uses pre-configured agent with context variables
        const userData = {
          lead_name: row.lead_name || "",
          phone_e164: row.phone_e164,
          property_name: row.property_name || "Tulip Monsella",
          lead_id: row.lead_id || "",
          property_id: row.property_id || "",
          id: leadId, // Supabase UUID for webhook lookup
        };

        const bolnaResp = await startBolnaCall({
          phone: row.phone_e164,
          userData,
        });

        callId = bolnaResp.execution_id || "";
        callResponse = bolnaResp;

        // Save bolna_execution_id to lead immediately so webhooks can find it
        console.log(`Bolna: saving execution_id=${callId} to lead ${leadId}`);
        await updateRow(leadId, {
          bolna_execution_id: callId,
        });
        console.log(`Bolna: saved execution_id to lead ${leadId}`);

        // Save to calls table for history
        await supabase.from("calls").insert({
          lead_id: row.lead_id || null,
          property_id: row.property_id || null,
          phone_e164: row.phone_e164,
          bolna_execution_id: callId || null,
          call_provider: "bolna",
          status: "calling",
          outcome: null,
          next_action: null,
          attempt: attempts,
          started_at: startedAt,
          raw_webhook: { started_response: bolnaResp },
        });

      } else {
        // -------------------- BLAND (English - default) --------------------
        const task = buildPromptFromRow(row);

        // Metadata includes id for webhook -> update correct lead
        const metadata = {
          lead_id: row.lead_id || "",
          property_id: row.property_id || "",
          id: leadId, // Supabase UUID
        };

        const blandResp = await startBlandCall({
          phone: row.phone_e164,
          voiceId: row.voice_id || DEFAULT_VOICE_ID,
          task,
          webhook: PUBLIC_WEBHOOK_URL,
          metadata,
        });

        callId = blandResp.call_id || blandResp.id || "";
        callResponse = blandResp;

        // Save bland_call_id to lead
        await updateRow(leadId, {
          bland_call_id: callId,
        });

        // Save to calls table for history
        await supabase.from("calls").insert({
          lead_id: row.lead_id || null,
          property_id: row.property_id || null,
          phone_e164: row.phone_e164,
          bland_call_id: callId || null,
          call_provider: "bland",
          status: "calling",
          outcome: null,
          next_action: null,
          attempt: attempts,
          started_at: startedAt,
          raw_webhook: { started_response: blandResp },
        });
      }

      return res.json({
        ok: true,
        call_id: callId,
        provider,
        id: leadId,
        message: `Call started successfully via ${provider}`,
      });
    } catch (err) {
      console.error(`Trigger call error (${provider}):`, err);

      await updateRow(leadId, {
        call_status: "failed",
        outcome: "human_followup",
        next_action: "human_followup",
        notes: `Failed to start ${provider} call: ${String(err.message || err)}`,
      });

      await supabase.from("calls").insert({
        lead_id: row.lead_id || null,
        property_id: row.property_id || null,
        phone_e164: row.phone_e164,
        call_provider: provider,
        status: "failed",
        outcome: "human_followup",
        next_action: "human_followup",
        attempt: attempts,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        raw_webhook: { start_error: String(err.message || err) },
      });

      return res.status(500).json({
        ok: false,
        error: `Failed to start ${provider} call: ${String(err.message || err)}`,
      });
    }
  } catch (err) {
    console.error("trigger-call failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * GET /rows
 * Returns all sheet rows for frontend display.
 */
app.get("/rows", async (req, res) => {
  try {
    console.log("GET /rows - fetching rows...");
    const { headers, rows } = await readAllRows();
    console.log(`GET /rows - found ${headers?.length || 0} headers, ${rows?.length || 0} rows`);
    return res.json({ ok: true, headers: headers || [], rows: rows || [] });
  } catch (err) {
    console.error("get rows failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * GET /headers
 * Returns the sheet headers for the add record form.
 */
app.get("/headers", async (req, res) => {
  try {
    const headers = await getHeaders();
    return res.json({ ok: true, headers });
  } catch (err) {
    console.error("get headers failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Generate a unique ID with prefix
function generateId(prefix) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * POST /add-row
 * Adds a new lead to the database.
 * Input: { "data": { "phone_e164": "+1234567890", "property_address": "...", ... } }
 * Auto-generates: lead_id, property_id, call_status, call_attempts
 */
app.post("/add-row", async (req, res) => {
  try {
    const { data } = req.body;

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid data. Expected { data: { ... } }" });
    }

    // appendRow handles ID generation and defaults
    const result = await appendRow(data);

    console.log(`POST /add-row - added lead id: ${result.id}, lead_id: ${result.lead_id}`);

    return res.json({
      ok: true,
      message: "Lead added successfully",
      id: result.id,
      lead_id: result.lead_id,
    });
  } catch (err) {
    console.error("add-row failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * Normalize phone number for India-only calling
 * - If number is `91XXXXXXXXXX` → convert to `+91XXXXXXXXXX`
 * - If number is `XXXXXXXXXX` → convert to `+91XXXXXXXXXX`
 * - Returns null if invalid
 */
function normalizePhoneForIndia(phone) {
  if (!phone || typeof phone !== "string") return null;
  
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");
  
  // If it's already in +91 format, validate length
  if (phone.startsWith("+91")) {
    const numPart = phone.substring(3).replace(/\D/g, "");
    if (numPart.length === 10) {
      return `+91${numPart}`;
    }
    return null;
  }
  
  // If it starts with 91 and has 12 digits total (91 + 10 digits)
  if (digits.startsWith("91") && digits.length === 12) {
    return `+91${digits.substring(2)}`;
  }
  
  // If it's 10 digits, assume it's an India number
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  
  // Invalid format
  return null;
}

/**
 * POST /upload-csv
 * Accepts a CSV file via multipart/form-data and imports leads.
 * CSV format: Name, Mobile Number, Email, Date, Interested in
 * Ignores Type column and all other columns.
 */
app.post("/upload-csv", upload.single("csv"), async (req, res) => {
  try {
    console.log("POST /upload-csv - request received");
    console.log("File:", req.file ? "present" : "missing");
    console.log("Body keys:", Object.keys(req.body || {}));
    
    if (!req.file) {
      console.log("No file in request");
      return res.status(400).json({ ok: false, error: "No CSV file provided" });
    }

    // Parse CSV
    const csvContent = req.file.buffer.toString("utf8");
    let records;
    
    try {
      records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true, // Allow extra columns
      });
    } catch (parseError) {
      console.error("CSV parse error:", parseError);
      return res.status(400).json({ ok: false, error: `Invalid CSV format: ${parseError.message}` });
    }

    if (records.length === 0) {
      return res.status(400).json({ ok: false, error: "CSV file is empty or has no valid rows" });
    }

    // Get headers to determine column mapping
    const headers = await getHeaders();
    
    let inserted = 0;
    let skipped = 0;
    const errors = [];

    // Process each row
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      
      // Extract required fields (case-insensitive matching)
      const name = row["Name"] || row["name"] || "";
      const mobileNumber = row["Mobile Number"] || row["mobile number"] || row["Mobile"] || row["mobile"] || "";
      const email = row["Email"] || row["email"] || "";
      // Date and Interested in are not stored, but we read them for validation if needed
      
      // Normalize phone number
      const phoneE164 = normalizePhoneForIndia(mobileNumber);
      
      if (!phoneE164) {
        skipped++;
        errors.push(`Row ${i + 2}: Invalid phone number "${mobileNumber}"`);
        continue;
      }

      // Build row data for Supabase
      const rowData = {
        lead_name: name.trim() || "",
        phone_e164: phoneE164,
        email: email.trim() || "",
        call_status: "queued",
        call_attempts: 0,
      };

      try {
        await appendRow(rowData);
        inserted++;
      } catch (appendError) {
        skipped++;
        errors.push(`Row ${i + 2}: Failed to insert - ${appendError.message}`);
        console.error(`Failed to insert row ${i + 2}:`, appendError);
      }
    }

    console.log(`POST /upload-csv - inserted: ${inserted}, skipped: ${skipped}`);

    return res.json({
      ok: true,
      inserted,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("upload-csv failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * PUT /update-row
 * Updates an existing lead in the database.
 * Input: { "id": "uuid-here", "data": { "phone_e164": "+1234567890", ... } }
 */
app.put("/update-row", async (req, res) => {
  try {
    const { id, data } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: "Missing id" });
    }

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid data. Expected { data: { ... } }" });
    }

    // Update the lead with provided data
    await updateRow(id, data);

    console.log(`PUT /update-row - updated lead ${id}`);

    return res.json({
      ok: true,
      message: "Lead updated successfully",
      id,
    });
  } catch (err) {
    console.error("update-row failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * DELETE /delete-row
 * Deletes a lead from the database.
 * Input: { "id": "uuid-here" }
 */
app.delete("/delete-row", async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: "Missing id" });
    }

    await deleteRow(id);

    console.log(`DELETE /delete-row - deleted lead ${id}`);

    return res.json({
      ok: true,
      message: "Lead deleted successfully",
      id,
    });
  } catch (err) {
    console.error("delete-row failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * DELETE /delete-rows-bulk
 * Deletes multiple leads from the database.
 * Input: { "ids": ["uuid-1", "uuid-2", ...] }
 */
app.delete("/delete-rows-bulk", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid ids. Must be a non-empty array" });
    }

    await deleteRowsBulk(ids);

    console.log(`DELETE /delete-rows-bulk - deleted ${ids.length} leads`);

    return res.json({
      ok: true,
      message: `${ids.length} lead(s) deleted successfully`,
      deleted_count: ids.length,
    });
  } catch (err) {
    console.error("delete-rows-bulk failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * POST /run-dialer
 * Bulk Dialing with A/B testing support for Bland (English) and Bolna (Hinglish).
 * Reads queued rows and starts calls based on bolna_ratio.
 * Input: { "limit": 25, "bolna_ratio": 50 }
 *   - limit: max leads to call (default 5, max 50)
 *   - bolna_ratio: percentage of leads to call via Bolna/Hinglish (0-100, default 0)
 */
app.post("/run-dialer", async (req, res) => {
  try {
    const { limit = 5, bolna_ratio = 0 } = req.body;
    const maxRows = Math.min(Math.max(Number(limit), 1), 50);
    const bolnaPercent = Math.min(Math.max(Number(bolna_ratio), 0), 100);

    const { rows } = await readAllRows();

    // Filter leads that are ready to call
    const queued = rows
      .filter(r => String(r.call_status || "").toLowerCase() === "queued")
      .filter(r => Number(r.call_attempts || 0) < 3)
      .filter(r => String(r.phone_e164 || "").trim().startsWith("+"))
      .slice(0, maxRows);

    if (queued.length === 0) {
      return res.json({ ok: true, processed: 0, message: "No queued leads found" });
    }

    // Split leads based on bolna_ratio
    const bolnaCount = Math.round(queued.length * (bolnaPercent / 100));
    const bolnaLeads = queued.slice(0, bolnaCount);
    const blandLeads = queued.slice(bolnaCount);

    console.log(`Bulk dialing: ${queued.length} total, ${bolnaLeads.length} via Bolna, ${blandLeads.length} via Bland`);

    const startedAt = new Date().toISOString();
    let bolnaSuccessCount = 0;
    let blandBatchId = null;

    // -------------------- BOLNA CALLS (Hinglish) --------------------
    // Bolna doesn't have a simple batch API like Bland, so we make individual calls
    if (bolnaLeads.length > 0) {
      console.log(`Starting ${bolnaLeads.length} Bolna calls...`);

      for (const row of bolnaLeads) {
        try {
          const attempts = Number(row.call_attempts || 0) + 1;

          // Mark as calling
          await updateRow(row.id, {
            call_status: "calling",
            call_attempts: attempts,
            last_call_at: startedAt,
            call_provider: "bolna",
          });

          // Prepare user_data for Bolna
          const userData = {
            lead_name: row.lead_name || "",
            phone_e164: row.phone_e164,
            property_name: row.property_name || "Tulip Monsella",
            lead_id: row.lead_id || "",
            property_id: row.property_id || "",
            id: row.id, // Supabase UUID for webhook lookup
          };

          const bolnaResp = await startBolnaCall({
            phone: row.phone_e164,
            userData,
          });

          const executionId = bolnaResp.execution_id || "";

          // Save execution_id to lead
          await updateRow(row.id, {
            bolna_execution_id: executionId,
          });

          // Save to calls table for history
          await supabase.from("calls").insert({
            lead_id: row.lead_id || null,
            property_id: row.property_id || null,
            phone_e164: row.phone_e164,
            bolna_execution_id: executionId || null,
            call_provider: "bolna",
            status: "calling",
            outcome: null,
            next_action: null,
            attempt: attempts,
            started_at: startedAt,
            raw_webhook: { started_response: bolnaResp },
          });

          bolnaSuccessCount++;
        } catch (bolnaErr) {
          console.error(`Bolna call failed for ${row.phone_e164}:`, bolnaErr);

          // Mark as failed
          await updateRow(row.id, {
            call_status: "failed",
            notes: `Bolna call failed: ${String(bolnaErr.message || bolnaErr)}`,
          });
        }
      }
    }

    // -------------------- BLAND CALLS (English) --------------------
    if (blandLeads.length > 0) {
      // Prepare Call Objects for Bland Batch
      const callObjects = blandLeads.map(row => {
        const task = buildPromptFromRow(row);
        const isIndiaNumber = row.phone_e164.startsWith("+91");

        return {
          phone_number: row.phone_e164,
          task: task,
          language: isIndiaNumber ? "en-IN" : "en-US",
          metadata: {
            lead_id: row.lead_id,
            property_id: row.property_id,
            id: row.id, // Supabase UUID
          }
        };
      });

      // Update leads to mark as calling
      for (const row of blandLeads) {
        const attempts = Number(row.call_attempts || 0) + 1;
        await updateRow(row.id, {
          call_status: "calling",
          call_attempts: attempts,
          last_call_at: startedAt,
          call_provider: "bland",
        });
      }

      // Send Batch to Bland
      console.log(`Triggering Bland Batch for ${blandLeads.length} numbers`);

      const globalTask = callObjects.length > 0 ? callObjects[0].task : buildPromptFromRow(blandLeads[0]);

      const batchPayload = {
        call_objects: callObjects,
        global: {
          task: globalTask,
          voice: DEFAULT_VOICE_ID,
          webhook: PUBLIC_WEBHOOK_URL,
          record: true,
          wait_for_greeting: false,
          answered_by_enabled: true,
          voicemail_action: "hangup",
          interruption_threshold: 500,
          model: "base"
        }
      };

      const blandResp = await fetch("https://api.bland.ai/v2/batches/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.BLAND_API_KEY}`,
        },
        body: JSON.stringify(batchPayload),
      });

      if (!blandResp.ok) {
        const txt = await blandResp.text();
        throw new Error(`Bland Batch API failed: ${blandResp.status} ${txt}`);
      }

      const blandResult = await blandResp.json();
      console.log("Bland Batch created:", blandResult);
      blandBatchId = blandResult.data?.batch_id;
    }

    return res.json({
      ok: true,
      processed: queued.length,
      bolna_calls: bolnaSuccessCount,
      bland_calls: blandLeads.length,
      bland_batch_id: blandBatchId,
      message: `Started ${bolnaSuccessCount} Bolna (Hinglish) + ${blandLeads.length} Bland (English) calls`
    });

  } catch (err) {
    console.error("run-dialer failed:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * POST /webhooks/bland
 * Bland sends call results here after completion.
 */
app.post("/webhooks/bland", async (req, res) => {
  try {
    const payload = BlandWebhookSchema.parse(req.body);

    // Extract fields
    const callId = payload.call_id;
    const status = payload.status || "unknown";
    const answeredBy = payload.answered_by || "unknown";
    const durationSec = payload.call_length ? Math.round(payload.call_length) : null;
    const recordingUrl = payload.recording_url || "";
    const transcript = payload.concatenated_transcript || "";
    const summary = payload.summary || "";

    const meta = payload.metadata || {};
    const leadId = meta.lead_id || "";
    const propertyId = meta.property_id || "";
    const supabaseId = meta.id || null; // Supabase UUID

    // Extract Bland's disposition_tag if available (Bland's own classification)
    const dispositionTag = payload.disposition_tag || null;

    const { outcome, next_action } = classifyOutcome({
      answeredBy,
      summary,
      transcript,
      completed: payload.completed || false,
      callLength: payload.call_length || null,
      dispositionTag,
    });

    // Determine call_status based on outcome
    const callStatusMap = {
      "opt_out": "opt_out",
      "no_answer": "no_answer",
      "voicemail": "voicemail",
      "interested": "completed",
      "human_followup": "completed",
    };
    const callStatus = callStatusMap[outcome] || "completed";

    console.log(`Bland webhook: call_id=${callId}, answered_by=${answeredBy}, outcome=${outcome}, call_status=${callStatus}`);

    // Find lead by id from metadata, or by bland_call_id
    let lead = null;
    if (supabaseId) {
      lead = await readRow(supabaseId).catch(() => null);
    }
    if (!lead) {
      lead = await findLeadByBlandCallId(callId);
    }

    // Update lead if found. Do not overwrite a completed lead with a late no_answer from Bland
    // (e.g. user triggered Bland then Bolna; Bolna completed first, Bland webhook arrives later).
    const leadAlreadyCompleted = lead && String(lead.call_status || "").toLowerCase() === "completed";
    const blandSaysNoAnswer = callStatus === "no_answer";
    const skipLeadUpdate = leadAlreadyCompleted && blandSaysNoAnswer;

    if (lead && !skipLeadUpdate) {
      await updateRow(lead.id, {
        call_status: callStatus,
        outcome,
        next_action,
        bland_call_id: callId,
        last_call_at: new Date().toISOString(),
        recording_url: recordingUrl,
        transcript: transcript,
        summary: summary,
      });
    } else if (skipLeadUpdate) {
      console.log(`Bland webhook: skipping lead update (lead already completed, Bland late no_answer for call_id=${callId})`);
    } else if (!lead) {
      console.log(`Bland webhook: Could not find lead for call_id=${callId}`);
    }

    // Upsert calls table for history
    await supabase
      .from("calls")
      .upsert(
        {
          bland_call_id: callId,
          lead_id: leadId,
          property_id: propertyId,
          phone_e164: payload.to || payload.phone_number || null,
          status,
          outcome,
          next_action,
          duration_sec: durationSec,
          transcript,
          recording_url: recordingUrl,
          raw_webhook: req.body,
          ended_at: new Date().toISOString(),
        },
        { onConflict: "bland_call_id" }
      );

    // WhatsApp Hot Lead Alert: fire only when outcome is "interested"
    if (outcome === "interested" && lead) {
      sendWhatsAppHotLeadAlert({
        leadName: lead.lead_name || "",
        phoneE164: payload.to || payload.phone_number || "",
        propertyName: lead.property_name || lead.property_address || "Tulip Monsella",
        callSummary: summary,
      });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Bland webhook error:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// Bolna sends a webhook on every status change (initiated → ringing → in-progress → call-disconnected → completed).
// Only terminal statuses represent the final outcome; transient statuses must not update lead/notes/outcome.
const BOLNA_TERMINAL_STATUSES = ["completed", "call-disconnected", "no-answer", "busy", "failed", "canceled", "balance-low"];

/**
 * POST /webhooks/bolna
 * Bolna sends call status updates here. We only update lead, notes, and outcome on terminal status.
 */
app.post("/webhooks/bolna", async (req, res) => {
  try {
    // Skip Zod validation - use raw body with safe property access
    const payload = req.body || {};

    console.log("Bolna webhook received:", JSON.stringify(payload).slice(0, 500));

    // Extract fields
    const executionId = payload.execution_id || payload.id || "";
    const status = payload.status || "unknown";
    const transcript = payload.transcript || "";
    const telephonyData = payload.telephony_data || {};
    const durationSec = telephonyData.duration ?? payload.conversation_time ?? payload.conversation_duration ?? null;
    const recordingUrl = telephonyData.recording_url || "";
    const answeredByVoicemail = payload.answered_by_voice_mail || false;
    const hangupReason = telephonyData.hangup_reason || "";

    // Extract context_details which contains our user_data variables
    const contextDetails = payload.context_details || payload.user_data || {};
    const leadId = contextDetails.lead_id || "";
    const propertyId = contextDetails.property_id || "";
    const supabaseId = contextDetails.id || null; // Supabase UUID

    const isTerminal = BOLNA_TERMINAL_STATUSES.includes(status);

    if (!isTerminal) {
      console.log(`Bolna webhook: execution_id=${executionId}, status=${status} (transient, skipping lead/calls update)`);
      return res.status(200).send("ok");
    }

    // Find lead by id from context, or by bolna_execution_id
    let lead = null;
    if (supabaseId) {
      lead = await readRow(supabaseId).catch(() => null);
    }
    if (!lead && executionId) {
      lead = await findLeadByBolnaExecutionId(executionId);
    }

    if (!lead) {
      console.warn(`Bolna webhook: no lead found (execution_id=${executionId})`);
    }

    // Map Bolna status to answered_by for classifyOutcome
    let answeredBy = "unknown";
    if (answeredByVoicemail) {
      answeredBy = "voicemail";
    } else if (status === "completed") {
      answeredBy = "human";
    } else if (status === "no-answer") {
      answeredBy = "no_answer";
    }

    // Use classifyOutcome function
    const { outcome, next_action } = classifyOutcome({
      answeredBy,
      summary: "",
      transcript,
      completed: status === "completed",
      callLength: durationSec,
      dispositionTag: null,
    });

    // Override outcome based on Bolna-specific status
    let finalOutcome = outcome;
    let finalNextAction = next_action;

    if (status === "no-answer" || status === "busy") {
      finalOutcome = "no_answer";
      finalNextAction = "call_back_later";
    } else if (answeredByVoicemail) {
      finalOutcome = "voicemail";
      finalNextAction = "call_back_later";
    } else if ((status === "completed" || status === "call-disconnected") && transcript && finalOutcome === "human_followup") {
      finalOutcome = "interested";
      finalNextAction = "human_followup";
    }

    // Determine call_status based on outcome
    const callStatusMap = {
      "opt_out": "opt_out",
      "no_answer": "no_answer",
      "voicemail": "voicemail",
      "interested": "completed",
      "human_followup": "completed",
    };
    const callStatus = callStatusMap[finalOutcome] || "completed";

    console.log(`Bolna webhook: execution_id=${executionId}, status=${status}, outcome=${finalOutcome}`);

    // Update lead only on terminal status
    if (lead) {
      await updateRow(lead.id, {
        call_status: callStatus,
        outcome: finalOutcome,
        next_action: finalNextAction,
        bolna_execution_id: executionId,
        last_call_at: new Date().toISOString(),
        recording_url: recordingUrl,
        transcript: transcript,
        notes: `Bolna call - ${hangupReason || status}`,
      });
    }

    // Upsert calls table for history (only on terminal so we store final outcome)
    await supabase
      .from("calls")
      .upsert(
        {
          bolna_execution_id: executionId,
          lead_id: leadId || (lead?.lead_id) || null,
          property_id: propertyId || (lead?.property_id) || null,
          phone_e164: telephonyData.to_number || (lead?.phone_e164) || null,
          call_provider: "bolna",
          status,
          outcome: finalOutcome,
          next_action: finalNextAction,
          duration_sec: durationSec != null ? Math.round(Number(durationSec)) : null,
          transcript,
          recording_url: recordingUrl,
          raw_webhook: req.body,
          ended_at: new Date().toISOString(),
        },
        { onConflict: "bolna_execution_id" }
      );

    // WhatsApp Hot Lead Alert (only on terminal with interested)
    if (finalOutcome === "interested" && lead) {
      sendWhatsAppHotLeadAlert({
        leadName: lead.lead_name || contextDetails.lead_name || "",
        phoneE164: telephonyData.to_number || lead.phone_e164 || "",
        propertyName: lead.property_name || contextDetails.property_name || "Tulip Monsella",
        callSummary: `Bolna Hinglish call - Lead showed interest. Duration: ${durationSec ?? 0}s`,
      });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Bolna webhook error:", err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// Serve static files AFTER all API routes
app.use(express.static("public"));

// -------------------- Error Handling Middleware --------------------
// Handle multer and other errors - must be after all routes
app.use((err, req, res, next) => {
  console.error("Error middleware caught:", err);
  // Check if it's a multer error (MulterError has a code property)
  if (err && err.code && err.code.startsWith('LIMIT_')) {
    console.error("Multer error:", err);
    return res.status(400).json({ ok: false, error: `File upload error: ${err.message}` });
  }
  if (err) {
    console.error("Unhandled error:", err);
    // Only return JSON for API routes (especially upload-csv)
    if (req.path === '/upload-csv' || req.path.startsWith('/api/') || req.headers['content-type']?.includes('application/json')) {
      return res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    // For other routes, let Express handle it
    return next(err);
  }
  next();
});

// -------------------- Start server --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
